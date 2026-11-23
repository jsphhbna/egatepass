-- Migration: 20261123000800_admin_and_office_lifecycle_deletion.sql
-- Enables permanent deletion and lifecycle management for decommissioned admin accounts and offices.
-- Preserves transactional integrity, historical visits, and immutable audit logs.

-- 1. Foreign key adjustments for safe staff profile deletion:
-- When a staff member is permanently deleted, historical transactional references (e.g. decided passes, visit event logs)
-- must have their foreign keys set to NULL rather than failing closed on RESTRICT.

do $$
begin
  -- public.passes (decided_by)
  if exists (
    select 1 from information_schema.table_constraints
    where constraint_name = 'passes_decided_by_fkey' and table_name = 'passes'
  ) then
    alter table public.passes drop constraint passes_decided_by_fkey;
  end if;
  alter table public.passes
    add constraint passes_decided_by_fkey
    foreign key (decided_by) references public.staff_profiles(user_id) on delete set null;

  -- public.visit_events (guard_id)
  if exists (
    select 1 from information_schema.table_constraints
    where constraint_name = 'visit_events_guard_id_fkey' and table_name = 'visit_events'
  ) then
    alter table public.visit_events drop constraint visit_events_guard_id_fkey;
  end if;
  alter table public.visit_events
    add constraint visit_events_guard_id_fkey
    foreign key (guard_id) references public.staff_profiles(user_id) on delete set null;

  -- public.incident_holds (created_by, released_by)
  if exists (
    select 1 from information_schema.table_constraints
    where constraint_name = 'incident_holds_created_by_fkey' and table_name = 'incident_holds'
  ) then
    alter table public.incident_holds drop constraint incident_holds_created_by_fkey;
  end if;
  alter table public.incident_holds alter column created_by drop not null;
  alter table public.incident_holds
    add constraint incident_holds_created_by_fkey
    foreign key (created_by) references public.staff_profiles(user_id) on delete set null;

  if exists (
    select 1 from information_schema.table_constraints
    where constraint_name = 'incident_holds_released_by_fkey' and table_name = 'incident_holds'
  ) then
    alter table public.incident_holds drop constraint incident_holds_released_by_fkey;
  end if;
  alter table public.incident_holds
    add constraint incident_holds_released_by_fkey
    foreign key (released_by) references public.staff_profiles(user_id) on delete set null;

  -- public.office_provisioning_operations (actor_id)
  if exists (
    select 1 from information_schema.table_constraints
    where constraint_name = 'office_provisioning_operations_actor_id_fkey' and table_name = 'office_provisioning_operations'
  ) then
    alter table public.office_provisioning_operations drop constraint office_provisioning_operations_actor_id_fkey;
  end if;
  if exists (
    select 1 from information_schema.columns
    where table_name = 'office_provisioning_operations' and column_name = 'actor_id' and is_nullable = 'NO'
  ) then
    alter table public.office_provisioning_operations alter column actor_id drop not null;
  end if;
  alter table public.office_provisioning_operations
    add constraint office_provisioning_operations_actor_id_fkey
    foreign key (actor_id) references public.staff_profiles(user_id) on delete set null;

  -- public.staff_profiles (user_id -> auth.users)
  if exists (
    select 1 from information_schema.table_constraints
    where constraint_name = 'staff_profiles_user_id_fkey' and table_name = 'staff_profiles'
  ) then
    alter table public.staff_profiles drop constraint staff_profiles_user_id_fkey;
  end if;
  alter table public.staff_profiles
    add constraint staff_profiles_user_id_fkey
    foreign key (user_id) references auth.users(id) on delete cascade;
end;
$$;

-- 2. RPC: api.delete_staff_account
-- Atomically removes an eligible staff profile and its direct associations while preserving audit history.
create or replace function api.delete_staff_account(
  requested_actor_id uuid,
  requested_target_uid uuid,
  requested_request_id uuid default gen_random_uuid()
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor_role public.staff_role;
  v_target public.staff_profiles%rowtype;
  v_remaining_superadmins int;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'service role required';
  end if;

  -- 1. Validate caller is an active Super Admin
  select role into v_actor_role
  from public.staff_profiles
  where user_id = requested_actor_id
    and active = true
    and not must_change_password
    and privacy_accepted_at is not null;

  if v_actor_role is null or v_actor_role <> 'superadmin'::public.staff_role then
    raise exception using errcode = '42501', message = 'active_superadmin_required';
  end if;

  -- 2. Caller cannot delete their own account
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

  -- 7. Clean up assignments and operational associations
  delete from public.office_staff_assignments where user_id = requested_target_uid;

  if to_regclass('public.staff_mfa_factors') is not null then
    execute 'delete from public.staff_mfa_factors where user_id = $1' using requested_target_uid;
  end if;

  if to_regclass('public.user_sessions') is not null then
    execute 'delete from public.user_sessions where user_id = $1' using requested_target_uid;
  end if;

  -- 8. Set null on transactional tables to preserve historical record integrity
  update public.passes set decided_by = null where decided_by = requested_target_uid;
  update public.visit_events set guard_id = null where guard_id = requested_target_uid;
  update public.incident_holds set created_by = null where created_by = requested_target_uid;
  update public.incident_holds set released_by = null where released_by = requested_target_uid;
  update public.office_provisioning_operations set actor_id = null where actor_id = requested_target_uid;

  -- 9. Delete staff profile record
  delete from public.staff_profiles where user_id = requested_target_uid;

  -- 10. Record administrative audit event
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
comment on function api.delete_staff_account(uuid, uuid, uuid) is
  'Permanently deletes an eligible staff account from the database while maintaining audit trails and unlinking dependent records.';

-- 3. RPC: api.delete_office
-- Atomically deletes an office if no historical visitor transactions exist, or fails closed prompting archival.
create or replace function api.delete_office(
  requested_actor_id uuid,
  requested_office_id uuid,
  requested_request_id uuid default gen_random_uuid()
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor_role public.staff_role;
  v_office public.offices%rowtype;
  v_has_historical boolean := false;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'service role required';
  end if;

  -- 1. Validate caller is an active administrator (admin or superadmin)
  select role into v_actor_role
  from public.staff_profiles
  where user_id = requested_actor_id
    and active = true
    and not must_change_password
    and privacy_accepted_at is not null;

  if v_actor_role is null or v_actor_role not in ('admin'::public.staff_role, 'superadmin'::public.staff_role) then
    raise exception using errcode = '42501', message = 'administrator_required';
  end if;

  -- 2. Target office must exist
  select * into v_office
  from public.offices
  where id = requested_office_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'office_not_found';
  end if;

  -- 3. Check for historical visitor transactions:
  -- If the office has recorded visits or emergency gate records, permanent deletion is strictly blocked
  -- to prevent silent corruption or deletion of visitor history.
  select (
    exists (select 1 from public.office_visits where office_id = v_office.id)
    or exists (
      select 1 from public.audit_events
      where target_type = 'office_visit'
        and before_state->>'office_id' = v_office.id::text
    )
  ) into v_has_historical;

  if not v_has_historical and to_regclass('public.emergency_gate_records') is not null then
    execute 'select exists (select 1 from public.emergency_gate_records where destination_office_id = $1)'
      into v_has_historical
      using v_office.id;
  end if;

  if v_has_historical then
    raise exception using errcode = '40900', message = 'office_has_historical_records_archival_required';
  end if;

  -- 4. Clean up non-historical associations safely
  delete from public.office_staff_assignments where office_id = v_office.id;
  delete from public.office_personnel where office_id = v_office.id;
  delete from public.office_provisioning_operations where office_id = v_office.id;

  if to_regclass('public.office_calendar_exceptions') is not null then
    execute 'delete from public.office_calendar_exceptions where office_id = $1' using v_office.id;
  end if;

  if to_regclass('public.reconciliation_tasks') is not null then
    execute 'delete from public.reconciliation_tasks where reference_type = ''office'' and reference_id = $1'
      using v_office.id::text;
  end if;

  -- 5. Delete office record
  delete from public.offices where id = v_office.id;

  -- 6. Audit event
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
    v_actor_role::text,
    'office.deleted',
    'office',
    v_office.id::text,
    requested_request_id,
    jsonb_build_object(
      'name', v_office.name,
      'publication_status', v_office.publication_status,
      'active', v_office.active,
      'verified', v_office.verified
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
    'id', v_office.id,
    'name', v_office.name
  );
end;
$$;

revoke all on function api.delete_office(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function api.delete_office(uuid, uuid, uuid) to service_role;
comment on function api.delete_office(uuid, uuid, uuid) is
  'Permanently deletes an office without historical visitor records, unassigning personnel and cleaning operations.';

-- 4. Update legacy api.delete_draft_office to preserve draft check and delegate to api.delete_office
create or replace function api.delete_draft_office(
  requested_actor_id uuid,
  requested_office_id uuid,
  requested_request_id uuid default gen_random_uuid()
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  target_office record;
begin
  select publication_status, published_at, archived_at into target_office
  from public.offices
  where id = requested_office_id;

  if not found then
    raise exception using errcode = 'P0002', message = 'office_not_found';
  end if;

  if target_office.publication_status <> 'draft' or target_office.published_at is not null or target_office.archived_at is not null then
    raise exception using errcode = '40900', message = 'only_unused_draft_office_may_be_deleted';
  end if;

  return api.delete_office(requested_actor_id, requested_office_id, requested_request_id);
end;
$$;

revoke all on function api.delete_draft_office(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function api.delete_draft_office(uuid, uuid, uuid) to service_role;
