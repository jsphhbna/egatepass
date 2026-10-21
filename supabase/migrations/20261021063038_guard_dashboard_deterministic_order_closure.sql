-- =============================================================================
-- Migration: 20261021063038_guard_dashboard_deterministic_order_closure.sql
-- Description:
--   1. Enforces formal deterministic ordering across BOTH the inner pagination query
--      AND the outer jsonb_agg() aggregation contract in api.guard_dashboard():
--      - Primary sort: entry_scanned_at ASC NULLS LAST
--      - Deterministic tie-breaker: id ASC
--   2. Preserves the canonical wire contract expected by src/services/guard.ts:
--      - queue items return photoEvidenceId and idEvidenceId
--      - root returns queue, stats, rejectionReasons, pendingTotal, hasMore
--      - stats returns inside, exited, rejected, total
--   3. Preserves authoritative Asia/Manila day bounds (v_day_start to v_day_end).
--   4. Preserves recovery session confinement (private.is_recovery_session())
--      and operational staff role check (private.current_staff_role()).
-- =============================================================================

create or replace function api.guard_dashboard(
  requested_limit integer default 50,
  requested_offset integer default 0
)
returns jsonb
language plpgsql
stable
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
    'inside', count(*) filter (where status = 'inside'::public.pass_status),
    'exited', count(*) filter (where status = 'exited'::public.pass_status),
    'rejected', count(*) filter (where status = 'rejected'::public.pass_status),
    'total', count(*)
  ) into stats
  from public.passes
  where issued_at >= v_day_start and issued_at < v_day_end;

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
  'Guarantees deterministic Guard queue ordering across both pagination and jsonb_agg (entry_scanned_at ASC NULLS LAST, id ASC) while preserving canonical wire contract, Asia/Manila daily stats, and recovery session confinement.';
