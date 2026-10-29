-- =============================================================================
-- Migration 36: Retention Truthfulness and Decommission Immutability Closure
-- Description:
--   1. Grant column-level SELECT on photo_retention_days and id_retention_days
--      on public.app_settings to anon and authenticated roles.
--   2. Replace api.update_staff_profile to freeze decommissioned staff profiles
--      against mutation (raising P0004 target_decommissioned).
-- =============================================================================

-- 1. Safe column grants on public.app_settings
grant select (
  photo_retention_days,
  id_retention_days
) on public.app_settings to anon, authenticated;

-- 2. Replacement api.update_staff_profile RPC freezing decommissioned profiles
create or replace function api.update_staff_profile(
  requested_actor_id uuid,
  requested_user_id uuid,
  requested_role public.staff_role,
  requested_active boolean,
  requested_request_id uuid
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor_role public.staff_role;
  target public.staff_profiles%rowtype;
  next_role public.staff_role;
  next_active boolean;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'service role required';
  end if;

  select role into actor_role
  from public.staff_profiles
  where user_id = requested_actor_id
    and active
    and not must_change_password
    and privacy_accepted_at is not null;

  select * into target
  from public.staff_profiles
  where user_id = requested_user_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'staff profile not found';
  end if;

  -- Freeze decommissioned staff against mutation
  if target.decommissioned_at is not null then
    raise exception
      using errcode = 'P0004',
            message = 'target_decommissioned';
  end if;

  if requested_user_id = requested_actor_id then
    raise exception using errcode = '42501', message = 'self-management denied';
  end if;

  next_role := coalesce(requested_role, target.role);
  next_active := coalesce(requested_active, target.active);

  if actor_role = 'admin'::public.staff_role and (target.role <> 'guard'::public.staff_role or next_role <> 'guard'::public.staff_role) then
    raise exception using errcode = '42501', message = 'admins may manage guards only';
  end if;

  if actor_role not in ('admin'::public.staff_role, 'superadmin'::public.staff_role) then
    raise exception using errcode = '42501', message = 'administrator required';
  end if;

  update public.staff_profiles
  set role = next_role, active = next_active
  where user_id = target.user_id;

  insert into public.audit_events(
    actor_id, actor_kind, actor_role, action, target_type, target_id, request_id, before_state, after_state
  )
  values (
    requested_actor_id,
    'staff',
    actor_role::text,
    'staff.update',
    'staff_profile',
    target.user_id::text,
    requested_request_id,
    jsonb_build_object('role', target.role, 'active', target.active),
    jsonb_build_object('role', next_role, 'active', next_active)
  );
end $$;

revoke all on function api.update_staff_profile(uuid,uuid,public.staff_role,boolean,uuid) from public, anon, authenticated;
grant execute on function api.update_staff_profile(uuid,uuid,public.staff_role,boolean,uuid) to service_role;
