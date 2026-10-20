-- =============================================================================
-- Migration 001400: Closure, Hardening, and Authoritative Aggregates
--
-- 1. Conditional hardening of public.rls_auto_enable() privilege model (Group 2)
-- 2. Incident hold parent/child cross-target invariant enforcement (Group M)
-- 3. Authoritative server-side aggregate RPCs for dashboard completeness (Group N)
-- 4. Retention performance indexes and explicit Data API least-privilege grants (Group S)
-- =============================================================================

-- =============================================================================
-- 1. REPAIR GROUP 2: Conditional Hardening of public.rls_auto_enable()
-- =============================================================================
do $$
begin
  if exists (
    select 1
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname = 'rls_auto_enable'
  ) then
    execute 'revoke all on function public.rls_auto_enable() from public, anon, authenticated';
    execute 'grant execute on function public.rls_auto_enable() to postgres';
  end if;
end;
$$;

-- =============================================================================
-- 2. REPAIR GROUP M: Incident Hold Parent/Child Cross-Target Invariant
-- =============================================================================
create or replace function api.create_incident_hold(
  requested_actor_id uuid,
  requested_visitor_id uuid,
  requested_pass_id uuid,
  requested_reason text,
  requested_request_id uuid default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor public.staff_profiles%rowtype;
  new_hold_id uuid := gen_random_uuid();
  v_visitor_id uuid := requested_visitor_id;
  v_pass_id uuid := requested_pass_id;
  cleaned_reason text := btrim(coalesce(requested_reason, ''));
  v_existing_hold_id uuid;
  v_matching_pass_visitor_id uuid;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'service role required';
  end if;

  select * into actor
    from public.staff_profiles
   where user_id = requested_actor_id
     and active = true
     and not must_change_password
     and privacy_accepted_at is not null
   for share;

  if not found or actor.role is distinct from 'superadmin'::public.staff_role then
    raise exception using errcode = '42501', message = 'superadmin required';
  end if;

  if char_length(cleaned_reason) not between 5 and 500 then
    raise exception using errcode = '22023', message = 'reason must be between 5 and 500 characters';
  end if;

  if v_visitor_id is null and v_pass_id is null then
    raise exception using errcode = '22023', message = 'visitor_id or pass_id required';
  end if;

  -- Invariant: If both pass_id and visitor_id are supplied, pass MUST belong to visitor
  if v_pass_id is not null and v_visitor_id is not null then
    select p.visitor_id into v_matching_pass_visitor_id
      from public.passes p
     where p.id = v_pass_id;

    if not found then
      raise exception using errcode = 'P0002', message = 'pass not found';
    end if;

    if v_matching_pass_visitor_id <> v_visitor_id then
      raise exception using errcode = '22023', message = 'pass_visitor_mismatch';
    end if;
  end if;

  -- Resolve visitor_id from pass_id if not provided
  if v_pass_id is not null and v_visitor_id is null then
    select p.visitor_id into v_visitor_id
      from public.passes p
     where p.id = v_pass_id;
    if not found then
      raise exception using errcode = 'P0002', message = 'pass not found';
    end if;
  end if;

  -- Lock visitor row to serialize against concurrent purge claims
  if v_visitor_id is not null then
    perform 1 from public.visitors v where v.id = v_visitor_id for update;
    if not found then
      raise exception using errcode = 'P0002', message = 'visitor not found';
    end if;
  end if;

  -- Check if an active hold already exists for this pass or visitor
  if v_pass_id is not null then
    select id into v_existing_hold_id
      from public.incident_holds
     where pass_id = v_pass_id and active = true
     limit 1;
    if found then
      return jsonb_build_object(
        'success', true,
        'hold_id', v_existing_hold_id,
        'conflict', null,
        'already_active', true
      );
    end if;
  end if;

  if v_visitor_id is not null then
    select id into v_existing_hold_id
      from public.incident_holds
     where visitor_id = v_visitor_id and active = true
     limit 1;
    if found then
      return jsonb_build_object(
        'success', true,
        'hold_id', v_existing_hold_id,
        'conflict', null,
        'already_active', true
      );
    end if;
  end if;

  -- Check if active purge lease exists on any evidence belonging to this visitor
  if exists (
    select 1
      from public.visitor_evidence ve
     where ve.visitor_id = v_visitor_id
       and ve.purged_at is null
       and ve.purge_claim_id is not null
       and ve.purge_claimed_at >= statement_timestamp() - interval '5 minutes'
  ) then
    return jsonb_build_object(
      'success', false,
      'hold_id', null,
      'conflict', 'purge_in_progress'
    );
  end if;

  insert into public.incident_holds (
    id,
    visitor_id,
    pass_id,
    reason,
    active,
    created_by,
    created_at
  )
  values (
    new_hold_id,
    v_visitor_id,
    v_pass_id,
    cleaned_reason,
    true,
    actor.user_id,
    statement_timestamp()
  );

  insert into public.audit_events (
    actor_id,
    actor_kind,
    actor_role,
    action,
    target_type,
    target_id,
    request_id,
    before_state,
    after_state
  )
  values (
    actor.user_id,
    'staff',
    actor.role::text,
    'security_hold_created',
    'incident_holds',
    new_hold_id::text,
    requested_request_id,
    null,
    jsonb_build_object(
      'visitor_id', v_visitor_id,
      'pass_id', v_pass_id,
      'reason', cleaned_reason
    )
  );

  return jsonb_build_object(
    'success', true,
    'hold_id', new_hold_id,
    'conflict', null,
    'already_active', false
  );
end;
$$;

revoke all on function api.create_incident_hold(uuid, uuid, uuid, text, uuid) from public, anon, authenticated;
grant execute on function api.create_incident_hold(uuid, uuid, uuid, text, uuid) to service_role;

-- =============================================================================
-- 3. REPAIR GROUP N: Authoritative Server-Side Aggregate RPCs
-- =============================================================================

-- N1 & N2: Monthly calendar per-day counts across the complete dataset
create or replace function api.dashboard_calendar_counts(
  p_start timestamptz,
  p_end timestamptz
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'service role required';
  end if;

  select coalesce(jsonb_object_agg(t.day, t.count), '{}'::jsonb)
    into v_result
    from (
      select to_char(issued_at at time zone 'Asia/Manila', 'YYYY-MM-DD') as day,
             count(*)::int as count
        from public.passes
       where issued_at >= p_start and issued_at <= p_end
       group by 1
    ) t;

  return v_result;
end;
$$;

revoke all on function api.dashboard_calendar_counts(timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function api.dashboard_calendar_counts(timestamptz, timestamptz) to service_role;

-- N1: Today's authoritative insights computed directly in the database
create or replace function api.dashboard_today_insights(
  p_start timestamptz,
  p_end timestamptz
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_top_purpose jsonb;
  v_busiest_gate jsonb;
  v_top_rejection jsonb;
  v_avg_sec numeric;
  v_avg_time text;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'service role required';
  end if;

  -- 1. Top Purpose
  select jsonb_build_object('label', coalesce(split_part(v.purpose, ' — ', 1), 'No data yet'), 'count', count(*)::int)
    into v_top_purpose
    from public.passes p
    join public.visitors v on v.id = p.visitor_id
   where p.issued_at >= p_start and p.issued_at <= p_end
     and btrim(v.purpose) <> ''
   group by split_part(v.purpose, ' — ', 1)
   order by count(*) desc
   limit 1;

  if v_top_purpose is null then
    v_top_purpose := jsonb_build_object('label', 'No data yet', 'count', 0);
  end if;

  -- 2. Busiest Gate
  select jsonb_build_object('label', coalesce(p.gate, 'No data yet'), 'count', count(*)::int)
    into v_busiest_gate
    from public.passes p
   where p.issued_at >= p_start and p.issued_at <= p_end
     and p.gate is not null and btrim(p.gate) <> ''
   group by p.gate
   order by count(*) desc
   limit 1;

  if v_busiest_gate is null then
    v_busiest_gate := jsonb_build_object('label', 'No data yet', 'count', 0);
  end if;

  -- 3. Top Rejection Reason
  select jsonb_build_object('label', coalesce(p.rejection_reason, 'No data yet'), 'count', count(*)::int)
    into v_top_rejection
    from public.passes p
   where p.status = 'rejected'
     and p.decided_at >= p_start and p.decided_at <= p_end
     and p.rejection_reason is not null and btrim(p.rejection_reason) <> ''
   group by p.rejection_reason
   order by count(*) desc
   limit 1;

  if v_top_rejection is null then
    v_top_rejection := jsonb_build_object('label', 'No data yet', 'count', 0);
  end if;

  -- 4. Average Approval Time (seconds between entry_scanned_at and time_in)
  select avg(extract(epoch from (p.time_in - p.entry_scanned_at)))
    into v_avg_sec
    from public.passes p
   where p.issued_at >= p_start and p.issued_at <= p_end
     and p.entry_scanned_at is not null
     and p.time_in is not null
     and p.time_in >= p.entry_scanned_at;

  if v_avg_sec is null then
    v_avg_time := '—';
  elsif round(v_avg_sec) < 60 then
    v_avg_time := round(v_avg_sec)::text || 's';
  else
    v_avg_time := round(v_avg_sec / 60)::text || 'm';
  end if;

  return jsonb_build_object(
    'topPurpose', v_top_purpose,
    'busiestGate', v_busiest_gate,
    'topRejection', v_top_rejection,
    'avgApprovalTime', v_avg_time
  );
end;
$$;

revoke all on function api.dashboard_today_insights(timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function api.dashboard_today_insights(timestamptz, timestamptz) to service_role;

-- =============================================================================
-- 4. Performance Indexes for Range Aggregations & Retention Scanning
-- =============================================================================
create index if not exists passes_issued_at_idx on public.passes (issued_at desc);
create index if not exists visitors_anonymized_created_idx on public.visitors (anonymized_at, created_at) where anonymized_at is null;

-- =============================================================================
-- 5. REPAIR GROUP A: Protect Managed Device & Anonymous Credentials
-- =============================================================================
create or replace function public.protect_managed_credentials()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (new.encrypted_password is distinct from old.encrypted_password) then
    -- 1. Anonymous accounts cannot set passwords
    if (coalesce(old.is_anonymous, false) is true) then
      if auth.role() <> 'service_role' then
        raise exception using errcode = '42501', message = 'anonymous accounts cannot set passwords';
      end if;
    end if;

    -- 2. Device credentials are Super Admin managed and cannot be changed by device sessions
    if (old.email like '%@devices.egatepass.invalid') or exists (
      select 1 from public.devices d where d.user_id = old.id
    ) then
      if auth.role() <> 'service_role' then
        raise exception using errcode = '42501', message = 'device credentials are super admin managed and cannot be changed by device sessions';
      end if;
    end if;
  end if;

  return new;
end;
$$;

do $$
begin
  if exists (
    select 1
      from information_schema.columns
     where table_schema = 'auth'
       and table_name = 'users'
       and column_name = 'encrypted_password'
  ) then
    drop trigger if exists trg_protect_managed_credentials on auth.users;
    create trigger trg_protect_managed_credentials
      before update on auth.users
      for each row
      execute function public.protect_managed_credentials();
  end if;
end;
$$;
