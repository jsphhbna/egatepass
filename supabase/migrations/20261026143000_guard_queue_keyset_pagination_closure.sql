-- Migration: 20261026143000_guard_queue_keyset_pagination_closure.sql
-- Description: Creates api.guard_dashboard_page with keyset pagination (entry_scanned_at asc nulls last, id asc)
--              to eliminate offset pagination shift anomalies across live queue updates.

-- =============================================================================
-- 1. Index supporting keyset cursor order for pending passes
-- =============================================================================
create index if not exists passes_pending_queue_cursor_idx
on public.passes (
  entry_scanned_at asc,
  id asc
)
where status = 'pending'::public.pass_status;

-- =============================================================================
-- 2. Keyset pagination RPC: api.guard_dashboard_page
-- =============================================================================
create or replace function api.guard_dashboard_page(
  requested_limit integer default 50,
  after_scanned_at timestamptz default null,
  after_id uuid default null
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
  v_has_more boolean := false;
  next_cursor jsonb := null;
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

  -- Metrics semantics (Asia/Manila):
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
    'queue', coalesce(queue, '[]'::jsonb),
    'stats', stats,
    'rejectionReasons', coalesce(reasons, '[]'::jsonb),
    'pendingTotal', v_pending_total,
    'hasMore', coalesce(v_has_more, false),
    'nextCursor', next_cursor
  );
end;
$$;

revoke all on function api.guard_dashboard_page(integer, timestamptz, uuid) from public, anon;
grant execute on function api.guard_dashboard_page(integer, timestamptz, uuid) to authenticated;

comment on function api.guard_dashboard_page(integer, timestamptz, uuid) is
  'Keyset-paginated Guard dashboard queue reader. Uses (entry_scanned_at asc nulls last, id asc) cursor navigation to prevent skipped or duplicate passes during concurrent queue operations.';
