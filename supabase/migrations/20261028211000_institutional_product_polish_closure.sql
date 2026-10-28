-- =============================================================================
-- Migration 35: Institutional Product Polish Production Closure Hotfix
-- Description:
--   1. Grant public-safe column SELECTs (visitor_instructions, image_retention_days,
--      visitor_retention_days) on public.app_settings to anon and authenticated.
--   2. Add covering index on staff_profiles(decommissioned_by).
--   3. Replace api.decommission_staff_profile to remove invalid 'device' staff_role enum cast,
--      use stable machine error messages, and restrict execution strictly to service_role
--      (closing direct authenticated RPC bypass of password reauthentication).
-- =============================================================================

-- 1. Safe column grants on public.app_settings
grant select (
  visitor_instructions,
  image_retention_days,
  visitor_retention_days
) on public.app_settings to anon, authenticated;

-- 2. Covering index on staff_profiles(decommissioned_by)
create index if not exists staff_profiles_decommissioned_by_idx
on public.staff_profiles (decommissioned_by)
where decommissioned_by is not null;

-- 3. Replacement api.decommission_staff_profile RPC
create or replace function api.decommission_staff_profile(
  requested_target_uid uuid,
  requested_reason text,
  requested_actor_id uuid default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := coalesce(auth.uid(), requested_actor_id);
  v_actor_role public.staff_role;
  target_profile public.staff_profiles%rowtype;
  v_clean_reason text := btrim(coalesce(requested_reason, ''));
  v_now timestamptz := statement_timestamp();
begin
  if v_actor_id is null then
    raise exception using errcode = '42501', message = 'authentication_required';
  end if;

  -- 1. Caller must be an active Super Admin
  select role into v_actor_role
  from public.staff_profiles
  where user_id = v_actor_id
    and active = true
    and must_change_password = false
    and privacy_accepted_at is not null;

  if v_actor_role is null or v_actor_role <> 'superadmin'::public.staff_role then
    raise exception using errcode = '42501', message = 'active_superadmin_required';
  end if;

  -- 2. Caller cannot decommission self
  if requested_target_uid = v_actor_id then
    raise exception using errcode = '42501', message = 'cannot_decommission_self';
  end if;

  -- 3. Target profile must exist
  select * into target_profile
  from public.staff_profiles
  where user_id = requested_target_uid
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'target_user_not_found';
  end if;

  -- 4. Target cannot be a managed device identity (checked via public.devices only)
  if exists (
    select 1 from public.devices where user_id = requested_target_uid
  ) then
    raise exception using errcode = '42501', message = 'cannot_decommission_device';
  end if;

  -- 5. Target must not already be decommissioned
  if target_profile.decommissioned_at is not null then
    raise exception using errcode = 'P0004', message = 'target_already_decommissioned';
  end if;

  -- 6. Target must already have active = false
  if target_profile.active = true then
    raise exception using errcode = '42501', message = 'target_user_must_be_inactive';
  end if;

  -- 7. Reason required: 5-240 characters
  if length(v_clean_reason) < 5 or length(v_clean_reason) > 240 then
    raise exception using errcode = '22023', message = 'invalid_decommission_reason';
  end if;

  -- 8. Apply decommission mutation while retaining historical row and attribution
  update public.staff_profiles
  set
    decommissioned_at = v_now,
    decommissioned_by = v_actor_id,
    decommission_reason = v_clean_reason,
    active = false,
    must_change_password = false,
    updated_at = v_now
  where user_id = requested_target_uid;

  -- 9. Record administrative audit event
  insert into public.audit_events (
    actor_id,
    actor_kind,
    actor_role,
    action,
    target_type,
    target_id,
    request_id,
    before_state,
    after_state,
    outcome
  )
  values (
    v_actor_id,
    'staff',
    'superadmin',
    'staff.decommissioned',
    'staff_profile',
    requested_target_uid::text,
    gen_random_uuid(),
    jsonb_build_object(
      'active', target_profile.active,
      'role', target_profile.role,
      'decommissioned_at', target_profile.decommissioned_at
    ),
    jsonb_build_object(
      'active', false,
      'role', target_profile.role,
      'decommissioned_at', v_now,
      'decommission_reason', v_clean_reason
    ),
    'success'
  );

  return jsonb_build_object(
    'ok', true,
    'targetUid', requested_target_uid,
    'decommissionedAt', v_now
  );
end;
$$;

-- 4. Revoke direct RPC execution from browser roles, grant only to service_role
revoke all on function api.decommission_staff_profile(uuid, text, uuid) from public, anon, authenticated;
grant execute on function api.decommission_staff_profile(uuid, text, uuid) to service_role;

comment on function api.decommission_staff_profile(uuid, text, uuid) is
  'Permanently decommissions an inactive staff account while preserving historical audit attribution. Super Admin reauth server route only.';
