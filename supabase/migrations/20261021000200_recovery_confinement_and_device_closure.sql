-- =============================================================================
-- Migration: 20261021000200_recovery_confinement_and_device_closure.sql
-- Description: Hardens database RLS and RPC boundaries to fully confine password
-- recovery sessions. Specifically:
--   1. Recreates staff_profiles_select to exclude recovery sessions from self-read.
--   2. Recreates devices_select to exclude recovery sessions from self-read.
--   3. Hardens api.acknowledge_privacy() to explicitly reject recovery sessions.
--   4. Hardens api.guard_dashboard() to explicitly reject recovery sessions and
--      rely on private.current_staff_role() instead of raw staff table queries.
-- =============================================================================

-- 1. HARDEN staff_profiles_select: Exclude recovery sessions from self-read branch
drop policy if exists staff_profiles_select on public.staff_profiles;
create policy staff_profiles_select on public.staff_profiles for select to authenticated
using (
  (user_id = (select auth.uid()) and not (select private.is_recovery_session()))
  or (select private.has_staff_role(array['admin','superadmin']::public.staff_role[]))
);

comment on policy staff_profiles_select on public.staff_profiles is
  'Permits self-read for normal staff onboarding/login sessions only (recovery sessions denied); Admins and Super Admins retain full staff visibility.';

-- 2. HARDEN devices_select: Exclude recovery sessions from device self-read
drop policy if exists devices_select on public.devices;
create policy devices_select on public.devices for select to authenticated
using (
  (user_id = (select auth.uid()) and not (select private.is_recovery_session()))
  or (select private.has_staff_role(array['admin','superadmin']::public.staff_role[]))
);

comment on policy devices_select on public.devices is
  'Permits self-read for active authenticated devices only (recovery sessions denied); Admins and Super Admins retain management visibility.';

-- 3. HARDEN api.acknowledge_privacy(): Reject recovery sessions at the start
create or replace function api.acknowledge_privacy()
returns timestamptz
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  caller_id uuid := (select auth.uid());
  accepted_at timestamptz;
  caller_role public.staff_role;
begin
  if caller_id is null then
    raise exception using errcode = '42501', message = 'authentication required';
  end if;

  -- Recovery Session Confinement: A password-recovery session is restricted to
  -- password reset only and must not acknowledge privacy or mutate staff state.
  if (select private.is_recovery_session()) then
    raise exception using errcode = '42501', message = 'recovery_session_forbidden';
  end if;

  update public.staff_profiles
     set privacy_accepted_at = coalesce(privacy_accepted_at, now()),
         updated_at = now()
   where user_id = caller_id
     and active = true
  returning privacy_accepted_at, role into accepted_at, caller_role;

  if accepted_at is null then
    raise exception using errcode = 'P0002', message = 'staff profile not found or inactive';
  end if;

  insert into public.audit_events (
    actor_id, actor_kind, actor_role, action, target_type, target_id, after_state
  ) values (
    caller_id, 'staff', caller_role::text, 'privacy.acknowledged', 'staff_profile', caller_id::text,
    jsonb_build_object('accepted', true, 'timestamp', accepted_at)
  );

  return accepted_at;
end;
$$;

revoke all on function api.acknowledge_privacy() from public, anon;
grant execute on function api.acknowledge_privacy() to authenticated, service_role;

comment on function api.acknowledge_privacy() is
  'Allows authenticated normal staff to record privacy policy acceptance during onboarding; recovery sessions strictly forbidden.';

-- 4. HARDEN api.guard_dashboard(): Enforce recovery session rejection and private.current_staff_role()
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

  select coalesce(jsonb_agg(item order by item->>'scannedAt'), '[]'::jsonb) into queue
  from (
    select jsonb_build_object(
      'id', p.id,
      'visitorName', v.full_name,
      'purpose', v.purpose,
      'source', p.source,
      'status', p.status,
      'validFrom', p.valid_from,
      'validUntil', p.valid_until,
      'scannedAt', p.entry_scanned_at,
      'gate', p.gate,
      'evidence', (
        select coalesce(jsonb_agg(jsonb_build_object('id', ve.id, 'kind', ve.kind)), '[]'::jsonb)
        from public.visitor_evidence ve
        where ve.visitor_id = v.id and ve.purged_at is null
      )
    ) as item
    from public.passes p
    join public.visitors v on v.id = p.visitor_id
    where p.status = 'pending'::public.pass_status
    order by p.entry_scanned_at asc
    limit v_limit
    offset v_offset
  ) q;

  v_has_more := (v_offset + v_limit) < v_pending_total;

  select jsonb_build_object(
    'pending', coalesce((select count(*) from public.passes where status = 'pending'::public.pass_status), 0),
    'inside', coalesce((select count(*) from public.passes where status = 'inside'::public.pass_status), 0),
    'exited', coalesce((select count(*) from public.passes where status = 'exited'::public.pass_status and time_out >= current_date), 0),
    'rejected', coalesce((select count(*) from public.passes where status = 'rejected'::public.pass_status and decided_at >= current_date), 0)
  ) into stats;

  select coalesce(rejection_reasons, '[]'::jsonb) into reasons
  from public.app_settings
  where singleton = true;

  return jsonb_build_object(
    'queue', queue,
    'stats', stats,
    'rejectionReasons', reasons,
    'totalPending', v_pending_total,
    'hasMore', v_has_more
  );
end;
$$;

revoke all on function api.guard_dashboard(integer, integer) from public, anon;
grant execute on function api.guard_dashboard(integer, integer) to authenticated;

comment on function api.guard_dashboard(integer, integer) is
  'Retrieves guard operational queue and statistics for verified operational staff; recovery sessions strictly forbidden.';
