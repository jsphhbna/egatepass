-- Migration 41: Online Runtime, OCR, Guard Station Privacy & Legacy Guard Authority Closure
-- Date: 2026-10-30
-- Description: Deprecates human guard authority from legacy operational RPCs and RLS policies,
-- restricting legacy queue, recovery, and offline sync operations to Admin and Superadmin actors only.

-- =============================================================================
-- 1. DEPRECATE GUARD AUTHORITY FROM api.guard_dashboard
-- =============================================================================
create or replace function api.guard_dashboard(
  requested_limit integer default 50,
  requested_offset integer default 0
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  caller_role public.staff_role := (select private.current_staff_role());
  queue jsonb;
  stats jsonb;
  reasons jsonb;
  v_limit integer := least(greatest(coalesce(requested_limit, 50), 1), 200);
  v_offset integer := greatest(coalesce(requested_offset, 0), 0);
  v_pending_total bigint;
  v_has_more boolean;
  v_day_start timestamptz := date_trunc('day', statement_timestamp() at time zone 'Asia/Manila') at time zone 'Asia/Manila';
  v_day_end timestamptz := (date_trunc('day', statement_timestamp() at time zone 'Asia/Manila') + interval '1 day') at time zone 'Asia/Manila';
begin
  if (select private.is_recovery_session()) then
    raise exception using errcode = '42501', message = 'recovery_session_forbidden';
  end if;

  if caller_role is null or caller_role not in ('admin'::public.staff_role, 'superadmin'::public.staff_role) then
    raise exception using errcode = '42501', message = 'administrator required';
  end if;

  -- Expire stale passes before calculating queue or metrics
  update public.passes
  set
    status = 'expired'::public.pass_status,
    updated_at = statement_timestamp(),
    version = version + 1
  where status in (
    'issued'::public.pass_status,
    'pending'::public.pass_status
  )
  and valid_until <= statement_timestamp();

  select count(*) into v_pending_total
  from public.passes
  where status = 'pending'::public.pass_status;

  select coalesce(
    jsonb_agg(
      pending.item
      order by pending.sort_scanned_at asc nulls last,
               pending.sort_id asc
    ),
    '[]'::jsonb
  ) into queue
  from (
    select
      p.entry_scanned_at as sort_scanned_at,
      p.id as sort_id,
      jsonb_build_object(
        'id', p.id,
        'visitorName', v.full_name,
        'purpose', v.purpose,
        'source', p.source,
        'status', p.status,
        'validFrom', p.valid_from,
        'validUntil', p.valid_until,
        'scannedAt', p.entry_scanned_at,
        'gate', p.gate,
        'photoEvidenceId', (
          select ve.id
          from public.visitor_evidence ve
          where ve.visitor_id = v.id and ve.kind = 'photo'::public.evidence_kind and ve.purged_at is null
        ),
        'idEvidenceId', (
          select ve.id
          from public.visitor_evidence ve
          where ve.visitor_id = v.id and ve.kind = 'id'::public.evidence_kind and ve.purged_at is null
        )
      ) as item
    from public.passes p
    join public.visitors v on v.id = p.visitor_id
    where p.status = 'pending'::public.pass_status
    order by
      p.entry_scanned_at asc nulls last,
      p.id asc
    limit v_limit
    offset v_offset
  ) pending;

  v_has_more := v_pending_total > (v_offset + v_limit);

  select jsonb_build_object(
    'inside', (select count(*) from public.passes where status = 'inside'::public.pass_status),
    'exited', (select count(*) from public.passes where status = 'exited'::public.pass_status and time_out >= v_day_start and time_out < v_day_end),
    'rejected', (select count(*) from public.passes where status = 'rejected'::public.pass_status and decided_at >= v_day_start and decided_at < v_day_end),
    'total', (select count(*) from public.passes where entry_scanned_at >= v_day_start and entry_scanned_at < v_day_end)
  ) into stats;

  select coalesce(rejection_reasons, '[]'::jsonb) into reasons
  from public.app_settings
  where singleton = true;

  return jsonb_build_object(
    'queue', queue,
    'stats', stats,
    'rejectionReasons', coalesce(reasons, '[]'::jsonb),
    'pendingTotal', v_pending_total,
    'hasMore', v_has_more
  );
end;
$$;

revoke all on function api.guard_dashboard(integer, integer) from public, anon;
grant execute on function api.guard_dashboard(integer, integer) to authenticated;

-- =============================================================================
-- 2. DEPRECATE GUARD AUTHORITY FROM api.guard_dashboard_page
-- =============================================================================
create or replace function api.guard_dashboard_page(
  requested_limit integer default 50,
  after_scanned_at timestamptz default null,
  after_id uuid default null,
  queue_snapshot_at timestamptz default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  caller_role public.staff_role := (select private.current_staff_role());
  queue jsonb;
  stats jsonb;
  reasons jsonb;
  v_limit integer := least(greatest(coalesce(requested_limit, 50), 1), 200);
  v_pending_total bigint;
  v_snapshot_pending_total bigint;
  v_snapshot_at timestamptz := least(coalesce(queue_snapshot_at, statement_timestamp()), statement_timestamp());
  v_has_more boolean := false;
  next_cursor jsonb := null;
  v_day_start timestamptz := date_trunc('day', statement_timestamp() at time zone 'Asia/Manila') at time zone 'Asia/Manila';
  v_day_end timestamptz := (date_trunc('day', statement_timestamp() at time zone 'Asia/Manila') + interval '1 day') at time zone 'Asia/Manila';
begin
  if (select private.is_recovery_session()) then
    raise exception using errcode = '42501', message = 'recovery_session_forbidden';
  end if;

  if caller_role is null or caller_role not in ('admin'::public.staff_role, 'superadmin'::public.staff_role) then
    raise exception using errcode = '42501', message = 'administrator required';
  end if;

  -- Expire stale passes before calculating queue or metrics
  update public.passes
  set
    status = 'expired'::public.pass_status,
    updated_at = statement_timestamp(),
    version = version + 1
  where status in (
    'issued'::public.pass_status,
    'pending'::public.pass_status
  )
  and valid_until <= statement_timestamp();

  select count(*) into v_pending_total
  from public.passes
  where status = 'pending'::public.pass_status;

  select count(*) into v_snapshot_pending_total
  from public.passes p
  where p.status = 'pending'::public.pass_status
    and (
      (p.entry_scanned_at is not null and p.entry_scanned_at <= v_snapshot_at)
      or
      (p.entry_scanned_at is null and p.created_at <= v_snapshot_at)
    );

  with fetched as (
    select
      p.entry_scanned_at,
      p.id,
      jsonb_build_object(
        'id', p.id,
        'visitorName', v.full_name,
        'purpose', v.purpose,
        'source', p.source,
        'status', p.status,
        'validFrom', p.valid_from,
        'validUntil', p.valid_until,
        'scannedAt', p.entry_scanned_at,
        'gate', p.gate,
        'photoEvidenceId', (
          select ve.id
          from public.visitor_evidence ve
          where ve.visitor_id = v.id and ve.kind = 'photo'::public.evidence_kind and ve.purged_at is null
        ),
        'idEvidenceId', (
          select ve.id
          from public.visitor_evidence ve
          where ve.visitor_id = v.id and ve.kind = 'id'::public.evidence_kind and ve.purged_at is null
        )
      ) as item,
      row_number() over (
        order by p.entry_scanned_at asc nulls last, p.id asc
      ) as rn
    from public.passes p
    join public.visitors v on v.id = p.visitor_id
    where p.status = 'pending'::public.pass_status
      and (
        (p.entry_scanned_at is not null and p.entry_scanned_at <= v_snapshot_at)
        or
        (p.entry_scanned_at is null and p.created_at <= v_snapshot_at)
      )
      and (
        after_id is null
        or (
          after_scanned_at is not null and (
            p.entry_scanned_at > after_scanned_at
            or (p.entry_scanned_at = after_scanned_at and p.id > after_id)
            or p.entry_scanned_at is null
          )
        )
        or (
          after_scanned_at is null and (
            p.entry_scanned_at is null and p.id > after_id
          )
        )
      )
    order by
      p.entry_scanned_at asc nulls last,
      p.id asc
    limit (v_limit + 1)
  )
  select
    coalesce(jsonb_agg(f.item order by f.rn asc) filter (where f.rn <= v_limit), '[]'::jsonb),
    coalesce(count(*) > v_limit, false),
    case
      when count(*) > v_limit then (
        select jsonb_build_object('scannedAt', f2.entry_scanned_at, 'id', f2.id)
        from fetched f2
        where f2.rn = v_limit
      )
      else null
    end
  into queue, v_has_more, next_cursor
  from fetched f;

  select jsonb_build_object(
    'inside', (select count(*) from public.passes where status = 'inside'::public.pass_status),
    'exited', (select count(*) from public.passes where status = 'exited'::public.pass_status and time_out >= v_day_start and time_out < v_day_end),
    'rejected', (select count(*) from public.passes where status = 'rejected'::public.pass_status and decided_at >= v_day_start and decided_at < v_day_end),
    'total', (select count(*) from public.passes where entry_scanned_at >= v_day_start and entry_scanned_at < v_day_end)
  ) into stats;

  select coalesce(rejection_reasons, '[]'::jsonb) into reasons
  from public.app_settings
  where singleton = true;

  return jsonb_build_object(
    'queue', coalesce(queue, '[]'::jsonb),
    'stats', stats,
    'rejectionReasons', coalesce(reasons, '[]'::jsonb),
    'pendingTotal', v_pending_total,
    'snapshotPendingTotal', v_snapshot_pending_total,
    'snapshotAt', to_char(v_snapshot_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'hasMore', coalesce(v_has_more, false),
    'nextCursor', next_cursor
  );
end;
$$;

revoke all on function api.guard_dashboard_page(integer, timestamptz, uuid, timestamptz) from public, anon;
grant execute on function api.guard_dashboard_page(integer, timestamptz, uuid, timestamptz) to authenticated;

-- =============================================================================
-- 3. DEPRECATE GUARD AUTHORITY FROM api.guard_offline_snapshot_page
-- =============================================================================
create or replace function api.guard_offline_snapshot_page(
  requested_cursor text default null,
  requested_limit integer default 50
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  caller_role public.staff_role := (select private.current_staff_role());
  v_limit integer := least(greatest(coalesce(requested_limit, 50), 1), 100);
  v_day_start timestamptz := date_trunc('day', statement_timestamp() at time zone 'Asia/Manila') at time zone 'Asia/Manila';
  v_day_end timestamptz := (date_trunc('day', statement_timestamp() at time zone 'Asia/Manila') + interval '1 day') at time zone 'Asia/Manila';
  cursor_id uuid := null;
  items_json jsonb := '[]'::jsonb;
  next_cursor text := null;
  has_more boolean := false;
  row_count integer := 0;
begin
  if (select private.is_recovery_session()) then
    raise exception using errcode = '42501', message = 'recovery_session_forbidden';
  end if;

  if caller_role is null or caller_role not in ('admin'::public.staff_role, 'superadmin'::public.staff_role) then
    raise exception using errcode = '42501', message = 'administrator required';
  end if;

  if requested_cursor is not null and btrim(requested_cursor) <> '' then
    begin
      cursor_id := btrim(requested_cursor)::uuid;
    exception when others then
      raise exception using errcode = '22023', message = 'invalid_cursor';
    end;
  end if;

  select
    coalesce(
      jsonb_agg(
        jsonb_build_object(
          'passId', sub.pass_id,
          'publicReference', sub.public_reference,
          'visitorId', sub.visitor_id,
          'visitorName', sub.visitor_name,
          'contactNumber', sub.contact_number,
          'purpose', sub.purpose,
          'visitDate', sub.visit_date,
          'status', sub.status,
          'version', sub.version,
          'validFrom', sub.valid_from,
          'validUntil', sub.valid_until,
          'timeIn', sub.time_in,
          'gate', sub.gate,
          'photoEvidenceId', sub.photo_evidence_id,
          'idEvidenceId', sub.id_evidence_id
        )
      ),
      '[]'::jsonb
    ),
    count(*)
  into items_json, row_count
  from (
    select
      p.id as pass_id,
      p.public_reference,
      v.id as visitor_id,
      v.full_name as visitor_name,
      v.contact_number,
      v.purpose,
      v.visit_date::text as visit_date,
      p.status::text as status,
      p.version,
      p.valid_from,
      p.valid_until,
      p.time_in,
      p.gate,
      (
        select ve.id from public.visitor_evidence ve
        where ve.visitor_id = v.id and ve.kind = 'photo'::public.evidence_kind and ve.purged_at is null
        limit 1
      ) as photo_evidence_id,
      (
        select ve.id from public.visitor_evidence ve
        where ve.visitor_id = v.id and ve.kind = 'id'::public.evidence_kind and ve.purged_at is null
        limit 1
      ) as id_evidence_id
    from public.passes p
    join public.visitors v on v.id = p.visitor_id
    where p.status in ('issued'::public.pass_status, 'pending'::public.pass_status, 'inside'::public.pass_status)
      and p.valid_from >= v_day_start
      and p.valid_from < v_day_end
      and (cursor_id is null or p.id > cursor_id)
    order by p.id asc
    limit (v_limit + 1)
  ) sub;

  if row_count > v_limit then
    has_more := true;
    next_cursor := items_json->(v_limit - 1)->>'passId';
    items_json := (
      select jsonb_agg(elem)
      from jsonb_array_elements(items_json) with ordinality as arr(elem, idx)
      where idx <= v_limit
    );
  else
    has_more := false;
    next_cursor := null;
  end if;

  return jsonb_build_object(
    'items', coalesce(items_json, '[]'::jsonb),
    'nextCursor', next_cursor,
    'hasMore', has_more
  );
end;
$$;

revoke all on function api.guard_offline_snapshot_page(text, integer) from public, anon;
grant execute on function api.guard_offline_snapshot_page(text, integer) to authenticated;

-- =============================================================================
-- 4. DEPRECATE GUARD AUTHORITY FROM api.guard_search_pending_queue
-- =============================================================================
create or replace function api.guard_search_pending_queue(
  requested_query text,
  requested_limit integer default 50
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := auth.uid();
  caller_role public.staff_role;
  v_clean_query text := btrim(coalesce(requested_query, ''));
  v_limit integer := coalesce(requested_limit, 50);
  results jsonb;
begin
  if (select private.is_recovery_session()) then
    raise exception using errcode = '42501', message = 'recovery_session_forbidden';
  end if;

  select role into caller_role
  from public.staff_profiles
  where user_id = v_actor_id
    and active = true
    and must_change_password = false
    and privacy_accepted_at is not null;

  if caller_role is null or caller_role not in (
    'admin'::public.staff_role,
    'superadmin'::public.staff_role
  ) then
    raise exception using errcode = '42501', message = 'administrator required';
  end if;

  if length(v_clean_query) < 2 or length(v_clean_query) > 100 then
    raise exception using errcode = '22023', message = 'search query must be between 2 and 100 characters';
  end if;

  if v_limit < 1 or v_limit > 100 then
    raise exception using errcode = '22023', message = 'limit must be between 1 and 100';
  end if;

  update public.passes
  set
    status = 'expired'::public.pass_status,
    updated_at = statement_timestamp(),
    version = version + 1
  where status in ('issued'::public.pass_status, 'pending'::public.pass_status)
    and valid_until <= statement_timestamp();

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', q.id,
        'visitorName', q.full_name,
        'purpose', q.purpose,
        'source', q.source,
        'status', q.status,
        'validFrom', q.valid_from,
        'validUntil', q.valid_until,
        'scannedAt', q.entry_scanned_at,
        'gate', q.gate,
        'publicReference', q.public_reference,
        'contactNumber', q.contact_number,
        'photoEvidenceId', (
          select ve.id
          from public.visitor_evidence ve
          where ve.visitor_id = q.visitor_id
            and ve.kind = 'photo'::public.evidence_kind
            and ve.purged_at is null
        ),
        'idEvidenceId', (
          select ve.id
          from public.visitor_evidence ve
          where ve.visitor_id = q.visitor_id
            and ve.kind = 'id'::public.evidence_kind
            and ve.purged_at is null
        )
      )
      order by q.entry_scanned_at asc nulls last, q.id asc
    ),
    '[]'::jsonb
  ) into results
  from (
    select
      p.id,
      p.visitor_id,
      p.source,
      p.status,
      p.valid_from,
      p.valid_until,
      p.entry_scanned_at,
      p.gate,
      p.public_reference,
      v.full_name,
      v.purpose,
      v.contact_number
    from public.passes p
    join public.visitors v on v.id = p.visitor_id
    where p.status = 'pending'::public.pass_status
      and (
        v.full_name ilike '%' || v_clean_query || '%'
        or v.contact_number ilike '%' || v_clean_query || '%'
        or v.purpose ilike '%' || v_clean_query || '%'
        or p.public_reference::text ilike '%' || v_clean_query || '%'
      )
    order by p.entry_scanned_at asc nulls last, p.id asc
    limit v_limit
  ) q;

  return results;
end;
$$;

revoke all on function api.guard_search_pending_queue(text, integer) from public, anon;
grant execute on function api.guard_search_pending_queue(text, integer) to authenticated, service_role;

-- =============================================================================
-- 5. DEPRECATE GUARD AUTHORITY FROM api.guard_search_recovery_visitors
-- =============================================================================
create or replace function api.guard_search_recovery_visitors(
  query text,
  requested_limit integer default 20
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  caller_role public.staff_role := (select private.current_staff_role());
  v_limit integer := least(greatest(coalesce(requested_limit, 20), 1), 50);
  clean_query text := btrim(coalesce(query, ''));
  norm_ref_query text := regexp_replace(upper(regexp_replace(clean_query, '^EG-?', '', 'i')), '[^A-F0-9]', '', 'g');
  results jsonb;
  v_day_start timestamptz := date_trunc('day', statement_timestamp() at time zone 'Asia/Manila') at time zone 'Asia/Manila';
  v_day_end timestamptz := (date_trunc('day', statement_timestamp() at time zone 'Asia/Manila') + interval '1 day') at time zone 'Asia/Manila';
begin
  if (select private.is_recovery_session()) then
    raise exception using errcode = '42501', message = 'recovery_session_forbidden';
  end if;

  if caller_role is null or caller_role not in ('admin'::public.staff_role, 'superadmin'::public.staff_role) then
    raise exception using errcode = '42501', message = 'administrator required';
  end if;

  if clean_query = '' or char_length(clean_query) < 2 then
    return '[]'::jsonb;
  end if;

  select coalesce(jsonb_agg(item), '[]'::jsonb) into results
  from (
    select jsonb_build_object(
      'id', p.id,
      'publicReference', p.public_reference,
      'passReference', ('EG-' || upper(substr(replace(p.public_reference::text, '-', ''), 1, 8))),
      'visitorId', v.id,
      'visitorName', v.full_name,
      'contactNumber', v.contact_number,
      'purpose', v.purpose,
      'status', p.status,
      'version', p.version,
      'source', p.source,
      'validFrom', p.valid_from,
      'validUntil', p.valid_until,
      'timeIn', p.time_in,
      'timeOut', p.time_out,
      'scannedAt', p.entry_scanned_at,
      'gate', p.gate,
      'photoEvidenceId', (
        select ve.id from public.visitor_evidence ve
        where ve.visitor_id = v.id and ve.kind = 'photo'::public.evidence_kind and ve.purged_at is null
        limit 1
      ),
      'idEvidenceId', (
        select ve.id from public.visitor_evidence ve
        where ve.visitor_id = v.id and ve.kind = 'id'::public.evidence_kind and ve.purged_at is null
        limit 1
      )
    ) as item
    from public.passes p
    join public.visitors v on v.id = p.visitor_id
    where p.status in ('issued'::public.pass_status, 'pending'::public.pass_status, 'inside'::public.pass_status)
      and p.valid_from >= v_day_start
      and p.valid_from < v_day_end
      and (
        v.full_name ilike ('%' || clean_query || '%')
        or v.contact_number ilike ('%' || clean_query || '%')
        or (char_length(norm_ref_query) >= 2 and replace(upper(p.public_reference::text), '-', '') like (norm_ref_query || '%'))
      )
    order by p.created_at desc
    limit v_limit
  ) sub;

  return results;
end;
$$;

revoke all on function api.guard_search_recovery_visitors(text, integer) from public, anon;
grant execute on function api.guard_search_recovery_visitors(text, integer) to authenticated;

-- =============================================================================
-- 6. DEPRECATE GUARD AUTHORITY FROM api.guard_recover_pass_action
-- =============================================================================
create or replace function api.guard_recover_pass_action(
  requested_pass_id uuid,
  requested_action text,
  requested_reason text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor public.staff_profiles%rowtype;
  target public.passes%rowtype;
  next_status public.pass_status;
  clean_reason text := btrim(coalesce(requested_reason, ''));
begin
  if (select private.is_recovery_session()) then
    raise exception using errcode = '42501', message = 'recovery_session_forbidden';
  end if;

  select * into actor from public.staff_profiles
  where user_id = (select auth.uid()) and active and not must_change_password
    and privacy_accepted_at is not null for share;
  if not found or actor.role not in ('admin'::public.staff_role, 'superadmin'::public.staff_role) then
    raise exception using errcode = '42501', message = 'administrator required';
  end if;

  if requested_action not in ('approve_entry', 'reject_entry', 'record_exit') then
    raise exception using errcode = '22023', message = 'invalid recovery action';
  end if;

  select * into target from public.passes where id = requested_pass_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'pass not found';
  end if;

  if requested_action = 'approve_entry' then
    if target.status not in ('issued'::public.pass_status, 'pending'::public.pass_status) then
      raise exception using errcode = '40001', message = 'pass is not eligible for entry approval';
    end if;
    next_status := 'inside'::public.pass_status;

    update public.passes set
      status = next_status,
      time_in = coalesce(time_in, statement_timestamp()),
      entry_scanned_at = coalesce(entry_scanned_at, statement_timestamp()),
      decided_at = statement_timestamp(),
      decided_by = actor.user_id,
      gate = coalesce(gate, 'Recovery Gate'),
      updated_at = statement_timestamp(),
      version = version + 1
    where id = target.id;

    insert into public.visit_events (
      pass_id, visitor_id, event, reason, gate, guard_id, request_id
    ) values (
      target.id, target.visitor_id, 'approved'::public.visit_event_type,
      case when clean_reason <> '' then clean_reason else 'visitor_recovery' end,
      coalesce(target.gate, 'Recovery Gate'), actor.user_id, gen_random_uuid()
    );

    insert into public.audit_events (
      actor_id, actor_kind, actor_role, action, target_type, target_id, outcome, after_state
    ) values (
      actor.user_id, 'staff', actor.role, 'gate.visitor_recovery_approve', 'passes', target.id, 'success',
      jsonb_build_object('source', 'visitor_recovery', 'status', 'inside')
    );

  elsif requested_action = 'reject_entry' then
    if target.status not in ('issued'::public.pass_status, 'pending'::public.pass_status) then
      raise exception using errcode = '40001', message = 'pass is not eligible for rejection';
    end if;
    if clean_reason = '' then
      clean_reason := 'Rejected by Guard during visitor recovery';
    end if;
    next_status := 'rejected'::public.pass_status;

    update public.passes set
      status = next_status,
      decided_at = statement_timestamp(),
      decided_by = actor.user_id,
      rejection_reason = clean_reason,
      updated_at = statement_timestamp(),
      version = version + 1
    where id = target.id;

    insert into public.visit_events (
      pass_id, visitor_id, event, reason, gate, guard_id, request_id
    ) values (
      target.id, target.visitor_id, 'rejected'::public.visit_event_type,
      clean_reason, coalesce(target.gate, 'Recovery Gate'), actor.user_id, gen_random_uuid()
    );

    insert into public.audit_events (
      actor_id, actor_kind, actor_role, action, target_type, target_id, outcome, after_state
    ) values (
      actor.user_id, 'staff', actor.role, 'gate.visitor_recovery_reject', 'passes', target.id, 'success',
      jsonb_build_object('source', 'visitor_recovery', 'status', 'rejected', 'reason', clean_reason)
    );

  elsif requested_action = 'record_exit' then
    if target.status <> 'inside'::public.pass_status then
      raise exception using errcode = '40001', message = 'pass is not recorded as inside';
    end if;
    next_status := 'exited'::public.pass_status;

    update public.passes set
      status = next_status,
      time_out = statement_timestamp(),
      updated_at = statement_timestamp(),
      version = version + 1
    where id = target.id;

    insert into public.visit_events (
      pass_id, visitor_id, event, reason, gate, guard_id, request_id
    ) values (
      target.id, target.visitor_id, 'scan_exit'::public.visit_event_type,
      case when clean_reason <> '' then clean_reason else 'visitor_recovery_exit' end,
      coalesce(target.gate, 'Recovery Gate'), actor.user_id, gen_random_uuid()
    );

    insert into public.audit_events (
      actor_id, actor_kind, actor_role, action, target_type, target_id, outcome, after_state
    ) values (
      actor.user_id, 'staff', actor.role, 'gate.visitor_recovery_exit', 'passes', target.id, 'success',
      jsonb_build_object('source', 'visitor_recovery', 'status', 'exited')
    );
  end if;

  return jsonb_build_object('success', true, 'passId', target.id, 'status', next_status);
end;
$$;

revoke all on function api.guard_recover_pass_action(uuid, text, text) from public, anon;
grant execute on function api.guard_recover_pass_action(uuid, text, text) to authenticated;

-- =============================================================================
-- 7. DEPRECATE GUARD AUTHORITY FROM api.guard_sync_offline_event
-- =============================================================================
create or replace function api.guard_sync_offline_event(
  requested_event_id uuid,
  requested_pass_id uuid,
  requested_action text,
  requested_expected_status text,
  requested_expected_version integer,
  requested_occurred_at timestamptz,
  requested_reason text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor public.staff_profiles%rowtype;
  existing_receipt public.offline_sync_receipts%rowtype;
  target public.passes%rowtype;
  actual_pass_id uuid := requested_pass_id;
  new_event_id uuid := gen_random_uuid();
  pass_status_val public.pass_status;
begin
  if (select private.is_recovery_session()) then
    raise exception using errcode = '42501', message = 'recovery_session_forbidden';
  end if;

  select * into actor from public.staff_profiles
  where user_id = (select auth.uid()) and active and not must_change_password
    and privacy_accepted_at is not null for share;
  if not found or actor.role not in ('admin'::public.staff_role, 'superadmin'::public.staff_role) then
    raise exception using errcode = '42501', message = 'administrator required';
  end if;

  -- 1. Idempotency Check: if eventId was already submitted, return the original receipt
  select * into existing_receipt from public.offline_sync_receipts
  where event_id = requested_event_id;
  if found then
    return jsonb_build_object(
      'status', existing_receipt.status,
      'duplicate', true,
      'eventId', existing_receipt.event_id,
      'result', existing_receipt.result
    );
  end if;

  -- 2. Timestamp sanity check
  if requested_occurred_at > statement_timestamp() + interval '5 minutes'
     or requested_occurred_at < statement_timestamp() - interval '7 days' then
    insert into public.offline_sync_receipts (
      event_id, pass_id, action, status, client_occurred_at, actor_id, conflict_reason, payload
    ) values (
      requested_event_id, requested_pass_id, requested_action, 'conflict', requested_occurred_at, actor.user_id,
      'suspicious_client_timestamp: occurred_at out of credible range',
      jsonb_build_object('expectedStatus', requested_expected_status, 'reason', requested_reason)
    );

    insert into public.reconciliation_tasks (
      operation, reference_type, reference_id, safe_context, last_error_code
    ) values (
      'offline_sync_timestamp_skew', 'pass', requested_pass_id::text,
      jsonb_build_object('eventId', requested_event_id, 'passId', requested_pass_id, 'occurredAt', requested_occurred_at),
      'suspicious_client_timestamp'
    );

    return jsonb_build_object(
      'status', 'conflict',
      'reason', 'suspicious_client_timestamp',
      'eventId', requested_event_id
    );
  end if;

  -- 3. Row-lock target pass; also resolve via offline_registration_id if offline created
  select * into target from public.passes where id = actual_pass_id for update;
  if not found then
    select * into target from public.passes where offline_registration_id = actual_pass_id for update;
    if found then
      actual_pass_id := target.id;
    else
      insert into public.offline_sync_receipts (
        event_id, pass_id, action, status, client_occurred_at, actor_id, conflict_reason, payload
      ) values (
        requested_event_id, requested_pass_id, requested_action, 'conflict', requested_occurred_at, actor.user_id,
        'pass_not_found', jsonb_build_object('expectedStatus', requested_expected_status)
      );

      insert into public.reconciliation_tasks (
        operation, reference_type, reference_id, safe_context, last_error_code
      ) values (
        'offline_sync_pass_not_found', 'pass', requested_pass_id::text,
        jsonb_build_object('eventId', requested_event_id, 'passId', requested_pass_id),
        'pass_not_found'
      );

      return jsonb_build_object('status', 'conflict', 'reason', 'pass_not_found', 'eventId', requested_event_id);
    end if;
  end if;

  -- 4. Mandatory Expected Version Fencing
  if requested_expected_version is null then
    insert into public.offline_sync_receipts (
      event_id, pass_id, action, status, client_occurred_at, actor_id, conflict_reason, payload
    ) values (
      requested_event_id, target.id, requested_action, 'conflict', requested_occurred_at, actor.user_id,
      'expected_version_required',
      jsonb_build_object('serverVersion', target.version, 'expectedStatus', requested_expected_status)
    );

    insert into public.reconciliation_tasks (
      operation, reference_type, reference_id, safe_context, last_error_code
    ) values (
      'offline_sync_version_missing', 'pass', target.id::text,
      jsonb_build_object('eventId', requested_event_id, 'passId', target.id, 'serverVersion', target.version),
      'expected_version_required'
    );

    return jsonb_build_object(
      'status', 'conflict',
      'reason', 'expected_version_required',
      'eventId', requested_event_id
    );
  end if;

  if target.version <> requested_expected_version then
    insert into public.offline_sync_receipts (
      event_id, pass_id, action, status, client_occurred_at, actor_id, conflict_reason, payload
    ) values (
      requested_event_id, target.id, requested_action, 'conflict', requested_occurred_at, actor.user_id,
      'version_conflict: expected v' || requested_expected_version || ' but server is v' || target.version,
      jsonb_build_object(
        'expectedVersion', requested_expected_version,
        'serverVersion', target.version,
        'expectedStatus', requested_expected_status
      )
    );

    insert into public.reconciliation_tasks (
      operation, reference_type, reference_id, safe_context, last_error_code
    ) values (
      'offline_sync_version_conflict', 'pass', target.id::text,
      jsonb_build_object(
        'eventId', requested_event_id, 'passId', target.id,
        'expectedVersion', requested_expected_version, 'serverVersion', target.version
      ),
      'version_conflict'
    );

    return jsonb_build_object(
      'status', 'conflict',
      'reason', 'version_conflict',
      'eventId', requested_event_id
    );
  end if;

  -- 5. Status Transition Legitimacy Check
  if requested_action in ('approve_entry', 'reject_entry') then
    if target.status not in ('issued'::public.pass_status, 'pending'::public.pass_status) then
      insert into public.offline_sync_receipts (
        event_id, pass_id, action, status, client_occurred_at, actor_id, conflict_reason, payload
      ) values (
        requested_event_id, target.id, requested_action, 'conflict', requested_occurred_at, actor.user_id,
        'illegal_transition: ' || requested_action || ' only permitted from issued/pending, current is ' || target.status::text,
        jsonb_build_object('expectedStatus', requested_expected_status, 'serverStatus', target.status::text)
      );

      insert into public.reconciliation_tasks (
        operation, reference_type, reference_id, safe_context, last_error_code
      ) values (
        'offline_sync_status_conflict', 'pass', target.id::text,
        jsonb_build_object(
          'eventId', requested_event_id,
          'action', requested_action,
          'serverStatus', target.status::text
        ),
        'illegal_status_transition'
      );

      return jsonb_build_object(
        'status', 'conflict',
        'reason', 'illegal_status_transition',
        'serverStatus', target.status::text,
        'eventId', requested_event_id
      );
    end if;

  elsif requested_action = 'record_exit' then
    if target.status <> 'inside'::public.pass_status then
      insert into public.offline_sync_receipts (
        event_id, pass_id, action, status, client_occurred_at, actor_id, conflict_reason, payload
      ) values (
        requested_event_id, target.id, requested_action, 'conflict', requested_occurred_at, actor.user_id,
        'illegal_transition: record_exit only permitted from inside, current is ' || target.status::text,
        jsonb_build_object('expectedStatus', requested_expected_status, 'serverStatus', target.status::text)
      );

      insert into public.reconciliation_tasks (
        operation, reference_type, reference_id, safe_context, last_error_code
      ) values (
        'offline_sync_status_conflict', 'pass', target.id::text,
        jsonb_build_object(
          'eventId', requested_event_id,
          'action', requested_action,
          'serverStatus', target.status::text
        ),
        'illegal_status_transition'
      );

      return jsonb_build_object(
        'status', 'conflict',
        'reason', 'illegal_status_transition',
        'serverStatus', target.status::text,
        'eventId', requested_event_id
      );
    end if;

    if target.time_in is not null and requested_occurred_at < target.time_in then
      insert into public.offline_sync_receipts (
        event_id, pass_id, action, status, client_occurred_at, actor_id, conflict_reason, payload
      ) values (
        requested_event_id, target.id, requested_action, 'conflict', requested_occurred_at, actor.user_id,
        'impossible_sequencing: time_out earlier than time_in',
        jsonb_build_object('timeIn', target.time_in, 'timeOut', requested_occurred_at)
      );

      insert into public.reconciliation_tasks (
        operation, reference_type, reference_id, safe_context, last_error_code
      ) values (
        'offline_sync_timestamp_skew', 'pass', target.id::text,
        jsonb_build_object('eventId', requested_event_id, 'timeIn', target.time_in, 'timeOut', requested_occurred_at),
        'time_out_before_time_in'
      );

      return jsonb_build_object(
        'status', 'conflict',
        'reason', 'time_out_before_time_in',
        'eventId', requested_event_id
      );
    end if;

  else
    raise exception using errcode = '22023', message = 'invalid action';
  end if;

  if target.status::text <> requested_expected_status then
    insert into public.offline_sync_receipts (
      event_id, pass_id, action, status, client_occurred_at, actor_id, conflict_reason, payload
    ) values (
      requested_event_id, target.id, requested_action, 'conflict', requested_occurred_at, actor.user_id,
      'status_mismatch: expected ' || requested_expected_status || ' but found ' || target.status::text,
      jsonb_build_object('expectedStatus', requested_expected_status, 'serverStatus', target.status::text)
    );

    insert into public.reconciliation_tasks (
      operation, reference_type, reference_id, safe_context, last_error_code
    ) values (
      'offline_sync_status_conflict', 'pass', target.id::text,
      jsonb_build_object(
        'eventId', requested_event_id,
        'passId', target.id,
        'expectedStatus', requested_expected_status,
        'serverStatus', target.status::text
      ),
      'status_mismatch'
    );

    return jsonb_build_object(
      'status', 'conflict',
      'reason', 'status_mismatch',
      'serverStatus', target.status::text,
      'eventId', requested_event_id
    );
  end if;

  -- 7. Apply state transition with truthful occurrence timestamp
  if requested_action = 'approve_entry' then
    pass_status_val := 'inside'::public.pass_status;
    update public.passes set
      status = pass_status_val,
      version = target.version + 1,
      time_in = coalesce(target.time_in, requested_occurred_at),
      gate = coalesce(target.gate, 'Offline Gate'),
      updated_at = statement_timestamp(),
      offline_synced_at = statement_timestamp()
    where id = target.id;

    insert into public.visit_events (
      pass_id, visitor_id, event, reason, gate, guard_id, occurred_at, request_id, details
    ) values (
      target.id, target.visitor_id, 'approved'::public.visit_event_type,
      'guard_offline_sync', coalesce(target.gate, 'Offline Gate'), actor.user_id, requested_occurred_at, requested_event_id,
      jsonb_build_object('offline_synced_at', statement_timestamp())
    );

  elsif requested_action = 'reject_entry' then
    pass_status_val := 'rejected'::public.pass_status;
    update public.passes set
      status = pass_status_val,
      version = target.version + 1,
      decided_at = requested_occurred_at,
      decided_by = actor.user_id,
      rejection_reason = coalesce(requested_reason, 'Rejected offline by guard'),
      updated_at = statement_timestamp(),
      offline_synced_at = statement_timestamp()
    where id = target.id;

    insert into public.visit_events (
      pass_id, visitor_id, event, reason, gate, guard_id, occurred_at, request_id, details
    ) values (
      target.id, target.visitor_id, 'rejected'::public.visit_event_type,
      coalesce(requested_reason, 'guard_offline_sync'), coalesce(target.gate, 'Offline Gate'), actor.user_id,
      requested_occurred_at, requested_event_id,
      jsonb_build_object('offline_synced_at', statement_timestamp())
    );

  elsif requested_action = 'record_exit' then
    pass_status_val := 'exited'::public.pass_status;
    update public.passes set
      status = pass_status_val,
      version = target.version + 1,
      time_out = requested_occurred_at,
      updated_at = statement_timestamp(),
      offline_synced_at = statement_timestamp()
    where id = target.id;

    insert into public.visit_events (
      pass_id, visitor_id, event, reason, gate, guard_id, occurred_at, request_id, details
    ) values (
      target.id, target.visitor_id, 'scan_exit'::public.visit_event_type,
      'guard_offline_sync', coalesce(target.gate, 'Offline Gate'), actor.user_id, requested_occurred_at, requested_event_id,
      jsonb_build_object('offline_synced_at', statement_timestamp())
    );
  end if;

  insert into public.offline_sync_receipts (
    event_id, pass_id, action, status, client_occurred_at, actor_id, payload, result
  ) values (
    requested_event_id, target.id, requested_action, 'applied', requested_occurred_at, actor.user_id,
    jsonb_build_object('expectedStatus', requested_expected_status, 'expectedVersion', requested_expected_version, 'reason', requested_reason),
    jsonb_build_object('nextStatus', pass_status_val::text, 'passId', target.id, 'version', target.version + 1)
  );

  return jsonb_build_object(
    'status', 'applied',
    'eventId', requested_event_id,
    'newStatus', pass_status_val::text,
    'version', target.version + 1
  );
end;
$$;

revoke all on function api.guard_sync_offline_event(uuid, uuid, text, text, integer, timestamptz, text) from public, anon;
grant execute on function api.guard_sync_offline_event(uuid, uuid, text, text, integer, timestamptz, text) to authenticated;

-- =============================================================================
-- 8. DEPRECATE GUARD AUTHORITY FROM api.guard_sync_offline_registration
-- =============================================================================
create or replace function api.guard_sync_offline_registration(
  requested_actor_id uuid,
  requested_registration_id uuid,
  requested_visitor jsonb,
  requested_action text,
  requested_occurred_at timestamptz,
  requested_photo_intent_id uuid,
  requested_photo_byte_size integer,
  requested_photo_sha256 text,
  requested_id_intent_id uuid default null,
  requested_id_byte_size integer default null,
  requested_id_sha256 text default null,
  requested_rejection_reason text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor public.staff_profiles%rowtype;
  settings public.app_settings%rowtype;
  existing_receipt public.offline_sync_receipts%rowtype;
  new_visitor_id uuid := gen_random_uuid();
  new_pass_id uuid := gen_random_uuid();
  new_public_ref uuid := gen_random_uuid();
  pass_status_val public.pass_status;
  first_name_val text := btrim(coalesce(requested_visitor->>'firstName', ''));
  middle_name_val text := nullif(btrim(coalesce(requested_visitor->>'middleName', '')), '');
  last_name_val text := btrim(coalesce(requested_visitor->>'lastName', ''));
  full_name_val text;
  contact_number_val text := btrim(coalesce(requested_visitor->>'contactNumber', ''));
  email_val text := nullif(btrim(coalesce(requested_visitor->>'email', '')), '');
  purpose_val text := btrim(coalesce(requested_visitor->>'purpose', ''));
  visit_date_str text := btrim(coalesce(requested_visitor->>'visitDate', ''));
  visit_date_val date;
  raw_token text;
  token_digest_val bytea;
  photo_intent public.upload_intents%rowtype;
  id_intent public.upload_intents%rowtype;
  photo_retention_val integer;
  id_retention_val integer;
  v_day_start timestamptz;
  v_day_end timestamptz;
  v_fingerprint text;
  v_norm_visitor text;
  res jsonb;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'service_role_required';
  end if;

  if (select private.is_recovery_session()) then
    raise exception using errcode = '42501', message = 'recovery_session_forbidden';
  end if;

  select * into actor from public.staff_profiles
  where user_id = requested_actor_id
    and active
    and not must_change_password
    and privacy_accepted_at is not null
  for share;

  if not found or actor.role not in ('admin'::public.staff_role, 'superadmin'::public.staff_role) then
    raise exception using errcode = '42501', message = 'administrator required';
  end if;

  if requested_action not in ('approved', 'rejected') then
    raise exception using errcode = '22023', message = 'invalid registration action';
  end if;

  if requested_occurred_at > statement_timestamp() + interval '5 minutes'
     or requested_occurred_at < statement_timestamp() - interval '7 days' then
    insert into public.reconciliation_tasks (
      operation, reference_type, reference_id, safe_context, last_error_code
    ) values (
      'offline_sync_timestamp_skew', 'offline_registration', requested_registration_id::text,
      jsonb_build_object('registrationId', requested_registration_id, 'occurredAt', requested_occurred_at),
      'suspicious_client_timestamp'
    );

    return jsonb_build_object(
      'status', 'conflict',
      'reason', 'suspicious_client_timestamp',
      'registrationId', requested_registration_id
    );
  end if;

  begin
    visit_date_val := visit_date_str::date;
  exception when others then
    raise exception using errcode = '22023', message = 'invalid visit_date format';
  end;

  if visit_date_val is distinct from ((requested_occurred_at at time zone 'Asia/Manila')::date) then
    raise exception using errcode = '22023', message = 'visit_date_must_match_occurrence_date';
  end if;

  if requested_action = 'approved' then
    if requested_id_intent_id is null or requested_id_byte_size is null or requested_id_sha256 is null then
      raise exception using errcode = '22023', message = 'valid_id_evidence_required_for_approval';
    end if;
  end if;

  if first_name_val = '' or last_name_val = '' or contact_number_val = '' or purpose_val = '' then
    raise exception using errcode = '22023', message = 'missing required visitor registration fields';
  end if;

  full_name_val := first_name_val || coalesce(' ' || middle_name_val, '') || ' ' || last_name_val;

  v_norm_visitor := lower(btrim(full_name_val)) || '|' || btrim(contact_number_val) || '|' ||
                    lower(coalesce(email_val, '')) || '|' || lower(btrim(purpose_val)) || '|' || visit_date_str;
  v_fingerprint := encode(sha256((
    v_norm_visitor || '|' || requested_action || '|' || requested_occurred_at::text || '|' ||
    requested_photo_sha256 || '|' || coalesce(requested_id_sha256, '')
  )::bytea), 'hex');

  select * into existing_receipt from public.offline_sync_receipts
  where offline_registration_id = requested_registration_id and action = 'register_visitor';
  if found then
    if existing_receipt.fingerprint = v_fingerprint or existing_receipt.fingerprint is null then
      return jsonb_build_object(
        'status', 'applied',
        'duplicate', true,
        'passId', existing_receipt.pass_id,
        'visitorId', existing_receipt.result->>'visitorId',
        'passStatus', existing_receipt.result->>'passStatus',
        'publicReference', existing_receipt.result->>'publicReference'
      );
    else
      insert into public.reconciliation_tasks (
        operation, reference_type, reference_id, safe_context, last_error_code
      ) values (
        'offline_registration_payload_conflict', 'offline_registration', requested_registration_id::text,
        jsonb_build_object(
          'registrationId', requested_registration_id,
          'existingFingerprint', existing_receipt.fingerprint,
          'newFingerprint', v_fingerprint
        ),
        'modified_payload_conflict'
      );

      return jsonb_build_object(
        'status', 'conflict',
        'reason', 'modified_payload_conflict',
        'registrationId', requested_registration_id
      );
    end if;
  end if;

  select * into photo_intent from public.upload_intents
  where id = requested_photo_intent_id for update;
  if not found
     or photo_intent.owner_id <> requested_actor_id
     or photo_intent.source <> 'guard_offline'::public.pass_source
     or photo_intent.kind <> 'photo'::public.evidence_kind
     or photo_intent.bucket_id <> 'visitor-photos'
     or photo_intent.status <> 'pending'::public.upload_intent_status
     or photo_intent.expires_at <= statement_timestamp() then
    raise exception using errcode = '22023', message = 'invalid_photo_upload_intent';
  end if;

  if requested_photo_byte_size < 12 or requested_photo_byte_size > photo_intent.max_bytes then
    raise exception using errcode = '22023', message = 'invalid_photo_byte_size';
  end if;
  if requested_photo_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'invalid_photo_sha256';
  end if;

  if requested_id_intent_id is not null then
    select * into id_intent from public.upload_intents
    where id = requested_id_intent_id for update;
    if not found
       or id_intent.owner_id <> requested_actor_id
       or id_intent.source <> 'guard_offline'::public.pass_source
       or id_intent.kind <> 'id'::public.evidence_kind
       or id_intent.bucket_id <> 'visitor-ids'
       or id_intent.status <> 'pending'::public.upload_intent_status
       or id_intent.expires_at <= statement_timestamp() then
      raise exception using errcode = '22023', message = 'invalid_id_upload_intent';
    end if;

    if requested_id_byte_size < 12 or requested_id_byte_size > id_intent.max_bytes then
      raise exception using errcode = '22023', message = 'invalid_id_byte_size';
    end if;
    if requested_id_sha256 !~ '^[0-9a-f]{64}$' then
      raise exception using errcode = '22023', message = 'invalid_id_sha256';
    end if;
  end if;

  select * into settings from public.app_settings where singleton for share;
  photo_retention_val := coalesce(settings.photo_retention_days, settings.image_retention_days, 7)::integer;
  id_retention_val := coalesce(settings.id_retention_days, 30)::integer;

  v_day_start := date_trunc('day', requested_occurred_at at time zone coalesce(settings.timezone, 'Asia/Manila')) at time zone coalesce(settings.timezone, 'Asia/Manila');
  v_day_end := (date_trunc('day', requested_occurred_at at time zone coalesce(settings.timezone, 'Asia/Manila')) + interval '1 day') at time zone coalesce(settings.timezone, 'Asia/Manila');

  insert into public.visitors (
    id, owner_id, source, created_by_device_id, full_name, contact_number,
    email, purpose, visit_date, consent_accepted_at
  ) values (
    new_visitor_id, actor.user_id, 'guard_offline'::public.pass_source, null,
    full_name_val, contact_number_val, email_val, purpose_val,
    visit_date_val, requested_occurred_at
  );

  update public.upload_intents
  set visitor_id = new_visitor_id, status = 'claimed'::public.upload_intent_status, claimed_at = statement_timestamp()
  where id = photo_intent.id;

  insert into public.visitor_evidence (
    visitor_id, upload_intent_id, kind, bucket_id, object_path,
    content_type, byte_size, sha256_hex, verified_at, expires_at
  ) values (
    new_visitor_id, photo_intent.id, 'photo'::public.evidence_kind, photo_intent.bucket_id,
    photo_intent.object_path, photo_intent.content_type, requested_photo_byte_size,
    requested_photo_sha256, statement_timestamp(), greatest(
      statement_timestamp() + make_interval(days => photo_retention_val),
      v_day_end + interval '1 day'
    )
  );

  if id_intent.id is not null then
    update public.upload_intents
    set visitor_id = new_visitor_id, status = 'claimed'::public.upload_intent_status, claimed_at = statement_timestamp()
    where id = id_intent.id;

    insert into public.visitor_evidence (
      visitor_id, upload_intent_id, kind, bucket_id, object_path,
      content_type, byte_size, sha256_hex, verified_at, expires_at
    ) values (
      new_visitor_id, id_intent.id, 'id'::public.evidence_kind, id_intent.bucket_id,
      id_intent.object_path, id_intent.content_type, requested_id_byte_size,
      requested_id_sha256, statement_timestamp(), greatest(
        statement_timestamp() + make_interval(days => id_retention_val),
        v_day_end + interval '1 day'
      )
    );
  end if;

  raw_token := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
  token_digest_val := sha256(raw_token::bytea);

  pass_status_val := case when requested_action = 'approved' then 'inside'::public.pass_status else 'rejected'::public.pass_status end;

  insert into public.passes (
    id, visitor_id, public_reference, token_digest, status, source, offline_registration_id,
    time_in, decided_at, decided_by, rejection_reason,
    valid_from, valid_until, gate, offline_synced_at, version
  ) values (
    new_pass_id, new_visitor_id, new_public_ref, token_digest_val, pass_status_val, 'guard_offline'::public.pass_source,
    requested_registration_id,
    case when requested_action = 'approved' then requested_occurred_at else null end,
    requested_occurred_at, actor.user_id,
    case when requested_action = 'rejected' then coalesce(requested_rejection_reason, 'Rejected offline by guard') else null end,
    v_day_start, v_day_end, 'Offline Gate', statement_timestamp(), 1
  );

  insert into public.visit_events (
    pass_id, visitor_id, event, reason, gate, guard_id, occurred_at, request_id, details
  ) values (
    new_pass_id, new_visitor_id,
    case when requested_action = 'approved' then 'approved'::public.visit_event_type else 'rejected'::public.visit_event_type end,
    'guard_offline_registration', 'Offline Gate', actor.user_id, requested_occurred_at, requested_registration_id,
    jsonb_build_object('offline_synced_at', statement_timestamp())
  );

  res := jsonb_build_object(
    'passId', new_pass_id,
    'visitorId', new_visitor_id,
    'passStatus', pass_status_val,
    'publicReference', new_public_ref
  );

  insert into public.offline_sync_receipts (
    event_id, offline_registration_id, pass_id, action, status, client_occurred_at, actor_id,
    conflict_reason, payload, result, fingerprint
  ) values (
    requested_registration_id, requested_registration_id, new_pass_id, 'register_visitor', 'applied',
    requested_occurred_at, actor.user_id, null, requested_visitor, res, v_fingerprint
  );

  insert into public.audit_events (
    actor_id, actor_kind, actor_role, action, target_type, target_id, outcome, after_state
  ) values (
    actor.user_id, 'staff', actor.role, 'gate.sync_offline_registration', 'passes', new_pass_id, 'success',
    jsonb_build_object('source', 'guard_offline', 'status', pass_status_val, 'offlineRegistrationId', requested_registration_id)
  );

  return jsonb_build_object(
    'status', 'applied',
    'passId', new_pass_id,
    'visitorId', new_visitor_id,
    'passStatus', pass_status_val,
    'publicReference', new_public_ref
  );
end;
$$;

revoke all on function api.guard_sync_offline_registration(
  uuid, uuid, jsonb, text, timestamptz, uuid, integer, text, uuid, integer, text, text
) from public, anon, authenticated;

grant execute on function api.guard_sync_offline_registration(
  uuid, uuid, jsonb, text, timestamptz, uuid, integer, text, uuid, integer, text, text
) to service_role;

-- =============================================================================
-- 9. REDEFINE RLS POLICIES REMOVING GUARD AUTHORITY
-- =============================================================================

-- Passes: Remove guard access to pending passes
drop policy if exists passes_select on public.passes;
create policy passes_select on public.passes for select to authenticated
using (
  exists (
    select 1 from public.visitors v
    where v.id = passes.visitor_id
      and v.owner_id = (select auth.uid())
      and v.source = 'portal'::public.pass_source
      and (select private.is_portal_actor())
  )
  or (select private.has_staff_role(array['admin','superadmin']::public.staff_role[]))
);

-- Offline Sync Receipts: Restrict to Admin and Superadmin
drop policy if exists offline_sync_receipts_staff_select on public.offline_sync_receipts;
create policy offline_sync_receipts_staff_select on public.offline_sync_receipts
  for select to authenticated
  using ((select private.has_staff_role(array['admin', 'superadmin']::public.staff_role[])));

-- Thermal Templates: Restrict to Kiosk device or Admin/Superadmin
drop policy if exists thermal_templates_read_published on public.thermal_templates;
create policy thermal_templates_read_published on public.thermal_templates
  for select to authenticated
  using (
    status = 'published'
    and (
      (select private.current_device_type()) = 'kiosk'::public.device_type
      or (select private.has_staff_role(array['admin', 'superadmin']::public.staff_role[]))
    )
  );

-- Visitors: Remove guard branch from can_read_visitor
create or replace function private.can_read_visitor(target_visitor_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.visitors v
    where v.id = target_visitor_id
      and (
        (
          v.owner_id = (select auth.uid())
          and v.source = 'portal'::public.pass_source
          and (select private.is_portal_actor())
        )
        or (select private.has_staff_role(array['admin','superadmin']::public.staff_role[]))
      )
  )
$$;
