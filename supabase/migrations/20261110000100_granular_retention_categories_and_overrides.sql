-- Migration 78: Granular Data Retention Categories & Audited Superadmin Overrides
-- Enforces per-category retention controls (photo, ID, vehicle photo, visitor personal records, returning profiles)
-- with explicit enabled/disabled toggles, retention days, and mandatory audit logging for Superadmin overrides.

-- 1. Extend app_settings with per-category retention controls
alter table public.app_settings
  add column if not exists photo_retention_enabled boolean not null default true,
  add column if not exists id_retention_enabled boolean not null default true,
  add column if not exists vehicle_photo_retention_enabled boolean not null default true,
  add column if not exists vehicle_photo_retention_days integer not null default 30,
  add column if not exists visitor_retention_enabled boolean not null default true,
  add column if not exists returning_profile_retention_enabled boolean not null default true,
  add column if not exists retention_overrides jsonb not null default '[]'::jsonb;

-- 2. Add validation constraint for vehicle_photo_retention_days
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'app_settings_vehicle_photo_retention_check'
  ) then
    alter table public.app_settings
      add constraint app_settings_vehicle_photo_retention_check
      check (vehicle_photo_retention_days between 1 and 365);
  end if;
end $$;

-- 3. Create authoritative RPC: api.update_retention_policies
create or replace function api.update_retention_policies(
  requested_actor_id uuid,
  requested_photo_enabled boolean,
  requested_photo_days integer,
  requested_id_enabled boolean,
  requested_id_days integer,
  requested_vehicle_enabled boolean,
  requested_vehicle_days integer,
  requested_visitor_enabled boolean,
  requested_visitor_days integer,
  requested_returning_enabled boolean,
  requested_returning_days integer,
  requested_override_reason text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor_role public.staff_role;
  effective_reason text;
  old_settings record;
  audit_entry jsonb;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'service role required';
  end if;

  select role into actor_role from public.staff_profiles
  where user_id = requested_actor_id
    and active
    and not must_change_password
    and privacy_accepted_at is not null;

  if actor_role is null or actor_role <> 'superadmin'::public.staff_role then
    raise exception using errcode = '42501', message = 'Only Superadmin can modify data retention policies';
  end if;

  -- Bounded validation checks
  if requested_photo_days < 1 or requested_photo_days > 365 then
    raise exception using errcode = '23514', message = 'photo_retention_days must be between 1 and 365';
  end if;
  if requested_id_days < 1 or requested_id_days > 365 then
    raise exception using errcode = '23514', message = 'id_retention_days must be between 1 and 365';
  end if;
  if requested_vehicle_days < 1 or requested_vehicle_days > 365 then
    raise exception using errcode = '23514', message = 'vehicle_photo_retention_days must be between 1 and 365';
  end if;
  if requested_visitor_days < 7 or requested_visitor_days > 730 then
    raise exception using errcode = '23514', message = 'visitor_retention_days must be between 7 and 730';
  end if;
  if requested_returning_days < 1 or requested_returning_days > 365 then
    raise exception using errcode = '23514', message = 'returning_profile_retention_days must be between 1 and 365';
  end if;

  effective_reason := nullif(btrim(coalesce(requested_override_reason, '')), '');
  if effective_reason is null then
    effective_reason := 'Superadmin policy update';
  end if;

  -- Load current settings for audit history
  select
    photo_retention_enabled,
    photo_retention_days,
    id_retention_enabled,
    id_retention_days,
    vehicle_photo_retention_enabled,
    vehicle_photo_retention_days,
    visitor_retention_enabled,
    visitor_retention_days,
    returning_profile_retention_enabled,
    returning_profile_retention_days
  into old_settings
  from public.app_settings
  where singleton = true;

  audit_entry := jsonb_build_object(
    'timestamp', now(),
    'superadmin_id', requested_actor_id,
    'reason', effective_reason,
    'previous', jsonb_build_object(
      'photo_retention_enabled', old_settings.photo_retention_enabled,
      'photo_retention_days', old_settings.photo_retention_days,
      'id_retention_enabled', old_settings.id_retention_enabled,
      'id_retention_days', old_settings.id_retention_days,
      'vehicle_photo_retention_enabled', old_settings.vehicle_photo_retention_enabled,
      'vehicle_photo_retention_days', old_settings.vehicle_photo_retention_days,
      'visitor_retention_enabled', old_settings.visitor_retention_enabled,
      'visitor_retention_days', old_settings.visitor_retention_days,
      'returning_profile_retention_enabled', old_settings.returning_profile_retention_enabled,
      'returning_profile_retention_days', old_settings.returning_profile_retention_days
    ),
    'new', jsonb_build_object(
      'photo_retention_enabled', requested_photo_enabled,
      'photo_retention_days', requested_photo_days,
      'id_retention_enabled', requested_id_enabled,
      'id_retention_days', requested_id_days,
      'vehicle_photo_retention_enabled', requested_vehicle_enabled,
      'vehicle_photo_retention_days', requested_vehicle_days,
      'visitor_retention_enabled', requested_visitor_enabled,
      'visitor_retention_days', requested_visitor_days,
      'returning_profile_retention_enabled', requested_returning_enabled,
      'returning_profile_retention_days', requested_returning_days
    )
  );

  update public.app_settings
  set
    photo_retention_enabled = requested_photo_enabled,
    photo_retention_days = requested_photo_days,
    id_retention_enabled = requested_id_enabled,
    id_retention_days = requested_id_days,
    vehicle_photo_retention_enabled = requested_vehicle_enabled,
    vehicle_photo_retention_days = requested_vehicle_days,
    visitor_retention_enabled = requested_visitor_enabled,
    visitor_retention_days = requested_visitor_days,
    returning_profile_retention_enabled = requested_returning_enabled,
    returning_profile_retention_days = requested_returning_days,
    retention_overrides = case
      when jsonb_array_length(retention_overrides) >= 50
      then (retention_overrides - 0) || jsonb_build_array(audit_entry)
      else retention_overrides || jsonb_build_array(audit_entry)
    end,
    updated_at = now()
  where singleton = true;

  -- Record structured audit event
  insert into public.audit_events (
    actor_id,
    actor_kind,
    actor_role,
    action,
    target_type,
    target_id,
    after_state
  ) values (
    requested_actor_id,
    'staff',
    'superadmin',
    'maintenance.retention_override',
    'app_settings',
    'retention_policies',
    audit_entry
  );

  return audit_entry;
end;
$$;

revoke all on function api.update_retention_policies(
  uuid, boolean, integer, boolean, integer, boolean, integer, boolean, integer, boolean, integer, text
) from public, anon, authenticated;

grant execute on function api.update_retention_policies(
  uuid, boolean, integer, boolean, integer, boolean, integer, boolean, integer, boolean, integer, text
) to service_role;


-- 4. Create authoritative RPC: api.reset_staff_temporary_password
create or replace function api.reset_staff_temporary_password(
  requested_actor_id uuid,
  requested_user_id uuid,
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
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'service role required';
  end if;

  select role into actor_role from public.staff_profiles
  where user_id = requested_actor_id
    and active
    and not must_change_password
    and privacy_accepted_at is not null;

  if actor_role is null or actor_role not in ('admin'::public.staff_role, 'superadmin'::public.staff_role) then
    raise exception using errcode = '42501', message = 'administrator required';
  end if;

  update public.staff_profiles
  set must_change_password = true, updated_at = now()
  where user_id = requested_user_id and decommissioned_at is null;

  insert into public.audit_events(actor_id, actor_kind, actor_role, action, target_type, target_id, request_id, after_state)
  values (
    requested_actor_id, 'staff', actor_role::text, 'office.credentials_reset', 'staff_profile', requested_user_id::text, requested_request_id,
    jsonb_build_object('mustChangePassword', true)
  );
end;
$$;

revoke all on function api.reset_staff_temporary_password(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function api.reset_staff_temporary_password(uuid, uuid, uuid) to service_role;
