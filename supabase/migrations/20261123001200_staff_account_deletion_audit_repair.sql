-- Migration: 20261123001200_staff_account_deletion_audit_repair.sql
-- Description: Reconcile api.delete_staff_account with production audit log schema and accountability protection

create or replace function api.delete_staff_account(
  requested_actor_id uuid,
  requested_target_uid uuid,
  requested_request_id uuid default gen_random_uuid()
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_role public.staff_role;
  v_actor_active boolean;
  v_actor_must_change_pw boolean;
  v_target record;
  v_remaining_superadmins int;
begin
  -- 1. Caller must be an active, password-cleared Super Admin
  select role, active, must_change_password
  into v_actor_role, v_actor_active, v_actor_must_change_pw
  from public.staff_profiles
  where user_id = requested_actor_id;

  if not found or v_actor_role <> 'superadmin'::public.staff_role or not v_actor_active or v_actor_must_change_pw then
    raise exception using errcode = '42501', message = 'active_superadmin_required';
  end if;

  -- 2. Prevent self-deletion
  if requested_target_uid = requested_actor_id then
    raise exception using errcode = '42501', message = 'cannot_delete_self';
  end if;

  -- 3. Target cannot be a registered hardware device identity
  if exists (select 1 from public.devices where user_id = requested_target_uid) then
    raise exception using errcode = '42501', message = 'cannot_delete_device_via_staff_api';
  end if;

  -- 4. Target profile must exist
  select * into v_target
  from public.staff_profiles
  where user_id = requested_target_uid
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'target_user_not_found';
  end if;

  -- 5. If target is active superadmin, protect last active superadmin
  if v_target.role = 'superadmin'::public.staff_role and v_target.active then
    select count(*) into v_remaining_superadmins
    from public.staff_profiles
    where role = 'superadmin'::public.staff_role
      and active = true
      and user_id <> requested_target_uid;

    if v_remaining_superadmins < 1 then
      raise exception using errcode = '23514', message = 'cannot_delete_last_superadmin';
    end if;
  end if;

  -- 6. Check active incident holds: accounts with active locks on visitor evidence cannot be removed
  if exists (
    select 1 from public.incident_holds
    where created_by = requested_target_uid
      and active = true
  ) then
    raise exception using errcode = '40900', message = 'target_has_active_incident_holds';
  end if;

  -- 7. Audit preservation: accounts that authored visitor accountability resolutions cannot be deleted
  if exists (
    select 1 from public.visitor_accountability_resolutions
    where actor_id = requested_target_uid
  ) then
    raise exception using errcode = '40900', message = 'target_has_accountability_resolutions';
  end if;

  -- 8. Clean up assignments and operational associations
  delete from public.office_staff_assignments where user_id = requested_target_uid;

  if to_regclass('public.staff_mfa_factors') is not null then
    execute 'delete from public.staff_mfa_factors where user_id = $1' using requested_target_uid;
  end if;

  if to_regclass('public.user_sessions') is not null then
    execute 'delete from public.user_sessions where user_id = $1' using requested_target_uid;
  end if;

  -- 9. Set null on transactional tables to preserve historical record integrity
  update public.passes set decided_by = null where decided_by = requested_target_uid;
  update public.visit_events set guard_id = null where guard_id = requested_target_uid;
  update public.incident_holds set created_by = null where created_by = requested_target_uid;
  update public.incident_holds set released_by = null where released_by = requested_target_uid;
  update public.office_provisioning_operations set actor_id = null where actor_id = requested_target_uid;

  -- 10. Delete staff profile record
  delete from public.staff_profiles where user_id = requested_target_uid;

  -- 11. Record administrative audit event
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
  ) values (
    requested_actor_id,
    'staff',
    'superadmin',
    'staff.account_deleted',
    'staff_profile',
    requested_target_uid::text,
    requested_request_id,
    jsonb_build_object(
      'name', v_target.display_name,
      'role', v_target.role,
      'active', v_target.active,
      'decommissioned_at', v_target.decommissioned_at,
      'decommission_reason', v_target.decommission_reason
    ),
    jsonb_build_object(
      'deleted', true,
      'deleted_at', now()
    ),
    'success'
  );

  return jsonb_build_object(
    'ok', true,
    'deleted', true,
    'userId', requested_target_uid,
    'displayName', v_target.display_name
  );
end;
$$;

revoke all on function api.delete_staff_account(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function api.delete_staff_account(uuid, uuid, uuid) to service_role;
