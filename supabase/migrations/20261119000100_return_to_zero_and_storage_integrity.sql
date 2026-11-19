-- Migration: 20261119000100_return_to_zero_and_storage_integrity.sql
-- Description: Harden Return-to-Zero purge integrity:
-- 1. Create public.system_reset_operations audit & state tracking table.
-- 2. Implement private.check_system_reset_lock() concurrency protection triggers across operational write paths.
-- 3. Replace api.return_to_zero_reset RPC to:
--    - Restrict execution strictly to service_role (remove authenticated-role bypass).
--    - Remove direct SQL storage.objects deletion (all Storage deletion handled via server Storage API).
--    - Preserve historical audit logs (append mandatory reset audit record without erasing history).
--    - Reassign institutional configuration references to active superadmin.
--    - Preserve all active superadmins and their MFA factors.

-- =============================================================================
-- 1. SYSTEM RESET OPERATIONS TABLE
-- =============================================================================

create table if not exists public.system_reset_operations (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid not null references auth.users(id) on delete restrict,
  status text not null check (status in (
    'requested',
    'lock_acquired',
    'storage_inventory_recorded',
    'storage_deletion_in_progress',
    'storage_deletion_verified',
    'database_cleanup_in_progress',
    'completed',
    'failed',
    'recovery_required'
  )),
  step text not null default 'requested',
  storage_manifest jsonb default '{}'::jsonb,
  purged_counts jsonb default '{}'::jsonb,
  error_details text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz
);

alter table public.system_reset_operations enable row level security;

revoke all on public.system_reset_operations from public, anon, authenticated;
grant select, insert, update on public.system_reset_operations to service_role;

-- =============================================================================
-- 2. CONCURRENCY PROTECTION TRIGGER FOR ACTIVE OPERATIONAL WRITE PATHS
-- =============================================================================

create or replace function private.check_system_reset_lock()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (
    select 1
    from public.maintenance_state
    where job_name = 'system_reset'
      and cursor_value in ('locked', 'in_progress', 'recovery_required')
  ) then
    raise exception using
      errcode = '55P03',
      message = 'system_reset_in_progress: system is undergoing operational reset or recovery';
  end if;
  return new;
end;
$$;

revoke all on function private.check_system_reset_lock() from public, anon, authenticated;
grant execute on function private.check_system_reset_lock() to service_role;

-- Attach lock-check triggers to operational write paths
drop trigger if exists trg_visitors_reset_lock on public.visitors;
create trigger trg_visitors_reset_lock
  before insert on public.visitors
  for each row
  execute function private.check_system_reset_lock();

drop trigger if exists trg_passes_reset_lock on public.passes;
create trigger trg_passes_reset_lock
  before insert on public.passes
  for each row
  execute function private.check_system_reset_lock();

drop trigger if exists trg_upload_intents_reset_lock on public.upload_intents;
create trigger trg_upload_intents_reset_lock
  before insert on public.upload_intents
  for each row
  execute function private.check_system_reset_lock();

drop trigger if exists trg_devices_reset_lock on public.devices;
create trigger trg_devices_reset_lock
  before insert on public.devices
  for each row
  execute function private.check_system_reset_lock();

drop trigger if exists trg_office_visits_reset_lock on public.office_visits;
create trigger trg_office_visits_reset_lock
  before insert on public.office_visits
  for each row
  execute function private.check_system_reset_lock();

-- =============================================================================
-- 3. RETURN-TO-ZERO RESET RPC (HARDENED)
-- =============================================================================

create or replace function api.return_to_zero_reset(requested_actor_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor_role public.staff_role;
  v_preserved_superadmins jsonb;
begin
  -- 1. Security Check: caller must be service_role
  -- Strictly eliminates the authenticated-role bypass.
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'service role required';
  end if;

  -- 2. Verify requested_actor_id belongs to an active superadmin
  select sp.role into v_actor_role
  from public.staff_profiles sp
  where sp.user_id = requested_actor_id
    and sp.active = true;

  if v_actor_role is null or v_actor_role <> 'superadmin'::public.staff_role then
    raise exception using errcode = '42501', message = 'superadmin_required';
  end if;

  -- 3. Acquire exclusive advisory transaction lock to serialize return-to-zero operations
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('egatepass:return-to-zero-reset'));

  -- Snapshot preserved active superadmin user IDs
  select coalesce(jsonb_agg(sp.user_id), '[]'::jsonb)
  into v_preserved_superadmins
  from public.staff_profiles sp
  where sp.role = 'superadmin' and sp.active = true;

  -- =========================================================================
  -- STRICT TOPOLOGICAL DELETIONS (Child -> Parent, respecting all FK constraints)
  -- =========================================================================

  -- Step 1: Office visit child events and outbox queues
  delete from public.office_visit_events;
  delete from public.office_visit_email_outbox;
  delete from public.office_visit_acknowledgement_outbox;
  delete from public.office_visit_email_verifications;
  delete from public.office_visit_verification_proofs;

  -- Step 2: Office visits (references offices & personnel with restrict; passes & visitors with cascade/set null)
  delete from public.office_visits;

  -- Step 3: Pass and Visit dependents (must delete before passes, visitors, devices, staff_profiles)
  delete from public.incident_holds;
  delete from public.visit_events;
  delete from public.pass_email_verifications;
  delete from public.offline_sync_receipts;
  delete from public.visit_vehicle_declarations;

  -- Step 4: Passes (now free of incoming foreign keys from events, holds, declarations, offline receipts)
  delete from public.passes;

  -- Step 5: Visitor evidence
  delete from public.visitor_evidence;

  -- Step 6: Sever circular references between visitors, portal verification attempts, and upload intents
  update public.visitors
  set identity_verification_id = null,
      returning_profile_id = null,
      returning_identity_attempt_id = null;

  update public.upload_intents
  set visitor_id = null;

  -- Step 7: Identity verification attempts and upload intents
  delete from public.portal_identity_verification_attempts;
  delete from public.upload_intents;

  -- Step 8: Visitors (now free of incoming references from passes, evidence, events, holds, vehicles, office visits)
  delete from public.visitors;

  -- Step 9: Returning visitor profiles and biometric / vehicle attachments
  delete from public.returning_identity_attempts;
  delete from public.returning_face_templates;
  delete from public.returning_visitor_vehicles;
  delete from public.returning_visitor_profiles;

  -- Step 10: Emergency records, manifests, receipts (must delete before devices)
  delete from public.emergency_sync_receipts;
  delete from public.emergency_gate_records;
  delete from public.emergency_device_manifests;

  -- Step 11: Devices (now free of incoming references from visitors, passes, events, emergency records)
  delete from public.devices;

  -- Step 12: Operational journals, tasks, and ephemeral telemetry
  delete from public.office_provisioning_operations;
  delete from public.reconciliation_tasks;
  delete from public.resend_webhook_events;
  delete from public.rate_limit_buckets;
  delete from public.nominatim_rate_limiter;
  delete from public.location_search_cache;

  -- Step 13: Non-superadmin staff assignments and sessions
  delete from public.office_staff_assignments
  where user_id not in (
    select sp.user_id from public.staff_profiles sp where sp.role = 'superadmin' and sp.active = true
  );

  delete from public.staff_sessions
  where user_id not in (
    select sp.user_id from public.staff_profiles sp where sp.role = 'superadmin' and sp.active = true
  );

  -- Step 14: Non-superadmin staff profiles
  delete from public.staff_profiles
  where not (role = 'superadmin' and active = true);

  -- Step 15: Reassign configuration metadata references to active superadmin (requested_actor_id)
  -- to avoid FK violations when non-superadmin auth.users are deleted
  update public.thermal_templates
  set created_by = requested_actor_id
  where created_by not in (
    select sp.user_id from public.staff_profiles sp where sp.role = 'superadmin' and sp.active = true
  );

  update public.thermal_templates
  set published_by = requested_actor_id
  where published_by is not null and published_by not in (
    select sp.user_id from public.staff_profiles sp where sp.role = 'superadmin' and sp.active = true
  );

  update public.app_settings
  set updated_by = requested_actor_id,
      updated_at = now(),
      global_retention_freeze_updated_by = case
        when global_retention_freeze_updated_by is not null
             and global_retention_freeze_updated_by not in (
               select sp.user_id from public.staff_profiles sp where sp.role = 'superadmin' and sp.active = true
             ) then requested_actor_id
        else global_retention_freeze_updated_by
      end
  where singleton = true;

  update public.offices
  set created_by = requested_actor_id
  where created_by is not null and created_by not in (
    select sp.user_id from public.staff_profiles sp where sp.role = 'superadmin' and sp.active = true
  );

  update public.offices
  set updated_by = requested_actor_id
  where updated_by is not null and updated_by not in (
    select sp.user_id from public.staff_profiles sp where sp.role = 'superadmin' and sp.active = true
  );

  update public.offices
  set published_by = case
    when published_by is not null and published_by not in (
      select sp.user_id from public.staff_profiles sp where sp.role = 'superadmin' and sp.active = true
    ) then requested_actor_id
    else published_by
  end,
  archived_by = case
    when archived_by is not null and archived_by not in (
      select sp.user_id from public.staff_profiles sp where sp.role = 'superadmin' and sp.active = true
    ) then requested_actor_id
    else archived_by
  end;

  update public.office_personnel
  set created_by = requested_actor_id
  where created_by is not null and created_by not in (
    select sp.user_id from public.staff_profiles sp where sp.role = 'superadmin' and sp.active = true
  );

  update public.office_personnel
  set updated_by = requested_actor_id
  where updated_by is not null and updated_by not in (
    select sp.user_id from public.staff_profiles sp where sp.role = 'superadmin' and sp.active = true
  );

  update public.campus_calendar_closures
  set archived_by = case
    when archived_by is not null and archived_by not in (
      select sp.user_id from public.staff_profiles sp where sp.role = 'superadmin' and sp.active = true
    ) then requested_actor_id
    else archived_by
  end;

  update public.campus_calendar_closures
  set created_by = requested_actor_id
  where created_by is not null and created_by not in (
    select sp.user_id from public.staff_profiles sp where sp.role = 'superadmin' and sp.active = true
  );

  update public.campus_calendar_closures
  set updated_by = requested_actor_id
  where updated_by is not null and updated_by not in (
    select sp.user_id from public.staff_profiles sp where sp.role = 'superadmin' and sp.active = true
  );

  update public.office_calendar_schedules
  set created_by = case
    when created_by is not null and created_by not in (
      select sp.user_id from public.staff_profiles sp where sp.role = 'superadmin' and sp.active = true
    ) then requested_actor_id
    else created_by
  end;

  update public.staff_profiles
  set created_by = requested_actor_id
  where created_by is not null and created_by not in (
    select sp.user_id from public.staff_profiles sp where sp.role = 'superadmin' and sp.active = true
  );

  -- Step 16: Non-superadmin auth.mfa_factors (preserves all active superadmin TOTP factors)
  delete from auth.mfa_factors
  where user_id not in (
    select sp.user_id from public.staff_profiles sp where sp.role = 'superadmin' and sp.active = true
  );

  -- Step 17: Non-superadmin auth.users (preserves all active superadmin Auth accounts)
  delete from auth.users
  where id not in (
    select sp.user_id from public.staff_profiles sp where sp.role = 'superadmin' and sp.active = true
  );

  -- Step 18: Storage objects: DIRECT SQL DELETION REMOVED.
  -- All actual object deletion is handled exclusively through Supabase Storage API.

  -- Step 19: Append authoritative return_to_zero audit event WITHOUT wiping historical audit history
  insert into public.audit_events (
    actor_id,
    actor_kind,
    actor_role,
    action,
    target_type,
    target_id,
    outcome,
    after_state
  ) values (
    requested_actor_id,
    'staff',
    'superadmin',
    'superadmin.return_to_zero',
    'system',
    'all_operational_data',
    'success',
    jsonb_build_object(
      'action', 'return_to_zero',
      'purged_at', now(),
      'preserved_superadmins', v_preserved_superadmins
    )
  );

  -- Step 20: Return structured response
  return jsonb_build_object(
    'success', true,
    'purged_at', now(),
    'actor_id', requested_actor_id,
    'preserved_superadmins', v_preserved_superadmins
  );
end;
$$;

revoke all on function api.return_to_zero_reset(uuid) from public;
revoke all on function api.return_to_zero_reset(uuid) from anon;
revoke all on function api.return_to_zero_reset(uuid) from authenticated;
grant execute on function api.return_to_zero_reset(uuid) to service_role;

-- =============================================================================
-- 4. RESET LOCK ACQUISITION AND RELEASE RPCS
-- =============================================================================

create or replace function api.acquire_system_reset_lock(requested_actor_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_role public.staff_role;
  v_op_id uuid := gen_random_uuid();
  v_current_lock text;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'service role required';
  end if;

  select sp.role into v_actor_role
  from public.staff_profiles sp
  where sp.user_id = requested_actor_id and sp.active = true;

  if v_actor_role is null or v_actor_role <> 'superadmin'::public.staff_role then
    raise exception using errcode = '42501', message = 'superadmin_required';
  end if;

  -- Check existing maintenance lock
  select cursor_value into v_current_lock
  from public.maintenance_state
  where job_name = 'system_reset';

  if v_current_lock in ('locked', 'in_progress') then
    return jsonb_build_object('acquired', false, 'reason', 'reset_already_in_progress');
  end if;

  -- Acquire maintenance lock
  insert into public.maintenance_state (
    job_name, cursor_value, last_started_at, last_outcome
  ) values (
    'system_reset', 'locked', now(), null
  )
  on conflict (job_name) do update set
    cursor_value = 'locked',
    last_started_at = now(),
    last_outcome = null;

  -- Create tracking record in system_reset_operations
  insert into public.system_reset_operations (
    id, actor_id, status, step, created_at, updated_at
  ) values (
    v_op_id, requested_actor_id, 'lock_acquired', 'lock_acquired', now(), now()
  );

  return jsonb_build_object('acquired', true, 'operation_id', v_op_id);
end;
$$;

revoke all on function api.acquire_system_reset_lock(uuid) from public, anon, authenticated;
grant execute on function api.acquire_system_reset_lock(uuid) to service_role;

create or replace function api.record_system_reset_step(
  requested_op_id uuid,
  requested_status text,
  requested_step text,
  requested_manifest jsonb default '{}'::jsonb,
  requested_counts jsonb default '{}'::jsonb,
  requested_error text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'service role required';
  end if;

  update public.system_reset_operations
  set status = requested_status,
      step = requested_step,
      storage_manifest = coalesce(requested_manifest, storage_manifest),
      purged_counts = coalesce(requested_counts, purged_counts),
      error_details = requested_error,
      updated_at = now(),
      completed_at = case when requested_status = 'completed' then now() else completed_at end
  where id = requested_op_id;

  if requested_status in ('failed', 'recovery_required') then
    update public.maintenance_state
    set cursor_value = 'recovery_required',
        last_outcome = 'failure'
    where job_name = 'system_reset';
  elsif requested_status = 'completed' then
    update public.maintenance_state
    set cursor_value = 'idle',
        last_outcome = 'success',
        last_completed_at = now()
    where job_name = 'system_reset';
  end if;
end;
$$;

revoke all on function api.record_system_reset_step(uuid, text, text, jsonb, jsonb, text) from public, anon, authenticated;
grant execute on function api.record_system_reset_step(uuid, text, text, jsonb, jsonb, text) to service_role;

create or replace function api.release_system_reset_lock(requested_actor_id uuid, requested_op_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_role public.staff_role;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'service role required';
  end if;

  select sp.role into v_actor_role
  from public.staff_profiles sp
  where sp.user_id = requested_actor_id and sp.active = true;

  if v_actor_role is null or v_actor_role <> 'superadmin'::public.staff_role then
    raise exception using errcode = '42501', message = 'superadmin_required';
  end if;

  update public.system_reset_operations
  set status = 'completed',
      step = 'completed',
      completed_at = now(),
      updated_at = now()
  where id = requested_op_id;

  update public.maintenance_state
  set cursor_value = 'idle',
      last_outcome = 'success',
      last_completed_at = now()
  where job_name = 'system_reset';
end;
$$;

revoke all on function api.release_system_reset_lock(uuid, uuid) from public, anon, authenticated;
grant execute on function api.release_system_reset_lock(uuid, uuid) to service_role;
