-- =============================================================================
-- Migration: 20261026040000_pass_expiration_and_operational_truth_closure.sql
-- Description:
--   1. Authoritative pass expiration RPC: api.expire_stale_passes()
--   2. One-time correction of existing stale production passes (issued/pending)
--   3. Modify api.guard_dashboard to VOLATILE, run expiration before queue/stats,
--      and fix daily statistics to reflect true event timestamps.
--   4. Fix api.dashboard_today_insights to use entry_scanned_at for busiestGate
--      and avgApprovalTime.
-- =============================================================================

-- =============================================================================
-- 1. api.expire_stale_passes(): Service-role authoritative pass expiration RPC
-- =============================================================================
create or replace function api.expire_stale_passes()
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'service role required';
  end if;

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

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function api.expire_stale_passes() from public, anon, authenticated;
grant execute on function api.expire_stale_passes() to service_role;

comment on function api.expire_stale_passes() is
  'Expires stale issued and pending passes whose valid_until has passed; returns count of modified rows; restricted to service_role.';

-- =============================================================================
-- 2. One-Time Historical Stale Pass Correction
-- =============================================================================
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

-- =============================================================================
-- 3. Replace api.guard_dashboard: VOLATILE, expire-before-read, and metric fix
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
  -- Recovery Session Confinement: Recovery sessions must never access operational dashboards
  if (select private.is_recovery_session()) then
    raise exception using errcode = '42501', message = 'recovery_session_forbidden';
  end if;

  if caller_role is null or caller_role not in ('guard'::public.staff_role, 'admin'::public.staff_role, 'superadmin'::public.staff_role) then
    raise exception using errcode = '42501', message = 'active guard or administrator required';
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

  -- Metrics semantics:
  -- inside: currently on campus (status = 'inside', no issue-date restriction)
  -- exited: exited today (time_out within Manila day)
  -- rejected: rejected today (decided_at within Manila day)
  -- total: entry scans today (entry_scanned_at within Manila day)
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

comment on function api.guard_dashboard(integer, integer) is
  'Guarantees deterministic Guard queue ordering across both pagination and jsonb_agg while expiring stale passes, computing truthful event-based daily stats, and enforcing recovery session confinement.';

-- =============================================================================
-- 4. Replace api.dashboard_today_insights: Event-clock timestamp alignment
-- =============================================================================
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

  -- 1. Top Purpose: Passes created today
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

  -- 2. Busiest Gate: Visitor entry scans today
  select jsonb_build_object('label', coalesce(p.gate, 'No data yet'), 'count', count(*)::int)
    into v_busiest_gate
    from public.passes p
   where p.entry_scanned_at >= p_start and p.entry_scanned_at <= p_end
     and p.gate is not null and btrim(p.gate) <> ''
   group by p.gate
   order by count(*) desc
   limit 1;

  if v_busiest_gate is null then
    v_busiest_gate := jsonb_build_object('label', 'No data yet', 'count', 0);
  end if;

  -- 3. Top Rejection Reason: Passes decided/rejected today
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

  -- 4. Average Approval Time: Wait from entry_scanned_at to time_in for scans today
  select avg(extract(epoch from (p.time_in - p.entry_scanned_at)))
    into v_avg_sec
    from public.passes p
   where p.entry_scanned_at >= p_start and p.entry_scanned_at <= p_end
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

-- Supporting performance indexes
create index if not exists passes_entry_scanned_at_idx on public.passes (entry_scanned_at) where entry_scanned_at is not null;
create index if not exists passes_time_out_idx on public.passes (time_out) where time_out is not null;
