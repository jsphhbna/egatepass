-- Migration: 20261119000100_return_to_zero_and_storage_integrity.sql
-- Description: Harden Return-to-Zero purge integrity:
-- 1. Create public.system_reset_operations audit & state tracking table.
-- 2. Implement private.check_system_reset_lock() concurrency protection triggers across all operational write paths.
-- 3. Replace api.return_to_zero_reset RPC to:
--    - Restrict execution strictly to service_role (eliminate authenticated-role bypass).
--    - Accept requested_op_id and bind it to the authoritative audit event.
--    - Remove direct SQL storage.objects deletion (handled exclusively via server Storage API).
--    - Preserve historical audit logs (append mandatory reset audit record without erasing history).
--    - Reassign institutional configuration references to active superadmin.
--    - Preserve all active superadmins and their MFA factors.
-- 4. Atomic single-winner reset lock acquisition with resume/reconcile support and reliable step recording.

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

create or replace function private.is_system_reset_locked()
returns boolean
language sql
security definer
stable
set search_path = ''
as $$
  select exists (
    select 1
    from public.maintenance_state
    where job_name = 'system_reset'
      and cursor_value in ('locked', 'in_progress', 'recovery_required')
  );
$$;

revoke all on function private.is_system_reset_locked() from public, anon, authenticated;
grant execute on function private.is_system_reset_locked() to service_role;

create or replace function api.is_system_reset_locked()
returns boolean
language sql
security definer
stable
set search_path = ''
as $$
  select private.is_system_reset_locked();
$$;

revoke all on function api.is_system_reset_locked() from public, anon, authenticated;
grant execute on function api.is_system_reset_locked() to service_role;

create or replace function private.check_system_reset_lock()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- If this session is the active return_to_zero_reset worker, bypass the write freeze
  if pg_catalog.current_setting('egatepass.in_system_reset', true) = 'true' then
    return new;
  end if;

  if private.is_system_reset_locked() then
    raise exception using
      errcode = '55P03',
      message = 'system_reset_in_progress: system is undergoing operational reset or recovery';
  end if;
  return new;
end;
$$;

revoke all on function private.check_system_reset_lock() from public, anon, authenticated;
grant execute on function private.check_system_reset_lock() to service_role;

-- Attach lock-check triggers to all operational write paths (insert and update)
-- Use 'a_00_' prefix to ensure the system reset lock check fires first alphabetically before any other before-triggers (such as passes_enforce_source)
drop trigger if exists a_00_visitors_reset_lock on public.visitors;
drop trigger if exists trg_00_visitors_reset_lock on public.visitors;
drop trigger if exists trg_visitors_reset_lock on public.visitors;
create trigger a_00_visitors_reset_lock
  before insert or update on public.visitors
  for each row execute function private.check_system_reset_lock();

drop trigger if exists a_00_passes_reset_lock on public.passes;
drop trigger if exists trg_00_passes_reset_lock on public.passes;
drop trigger if exists trg_passes_reset_lock on public.passes;
create trigger a_00_passes_reset_lock
  before insert or update on public.passes
  for each row execute function private.check_system_reset_lock();

drop trigger if exists a_00_upload_intents_reset_lock on public.upload_intents;
drop trigger if exists trg_00_upload_intents_reset_lock on public.upload_intents;
drop trigger if exists trg_upload_intents_reset_lock on public.upload_intents;
create trigger a_00_upload_intents_reset_lock
  before insert or update on public.upload_intents
  for each row execute function private.check_system_reset_lock();

drop trigger if exists a_00_devices_reset_lock on public.devices;
drop trigger if exists trg_00_devices_reset_lock on public.devices;
drop trigger if exists trg_devices_reset_lock on public.devices;
create trigger a_00_devices_reset_lock
  before insert or update on public.devices
  for each row execute function private.check_system_reset_lock();

drop trigger if exists a_00_office_visits_reset_lock on public.office_visits;
drop trigger if exists trg_00_office_visits_reset_lock on public.office_visits;
drop trigger if exists trg_office_visits_reset_lock on public.office_visits;
create trigger a_00_office_visits_reset_lock
  before insert or update on public.office_visits
  for each row execute function private.check_system_reset_lock();

drop trigger if exists a_00_visitor_evidence_reset_lock on public.visitor_evidence;
drop trigger if exists trg_00_visitor_evidence_reset_lock on public.visitor_evidence;
drop trigger if exists trg_visitor_evidence_reset_lock on public.visitor_evidence;
create trigger a_00_visitor_evidence_reset_lock
  before insert or update on public.visitor_evidence
  for each row execute function private.check_system_reset_lock();

drop trigger if exists a_00_visit_events_reset_lock on public.visit_events;
drop trigger if exists trg_00_visit_events_reset_lock on public.visit_events;
drop trigger if exists trg_visit_events_reset_lock on public.visit_events;
create trigger a_00_visit_events_reset_lock
  before insert or update on public.visit_events
  for each row execute function private.check_system_reset_lock();

drop trigger if exists a_00_visit_vehicle_declarations_reset_lock on public.visit_vehicle_declarations;
drop trigger if exists trg_00_visit_vehicle_declarations_reset_lock on public.visit_vehicle_declarations;
drop trigger if exists trg_visit_vehicle_declarations_reset_lock on public.visit_vehicle_declarations;
create trigger a_00_visit_vehicle_declarations_reset_lock
  before insert or update on public.visit_vehicle_declarations
  for each row execute function private.check_system_reset_lock();

drop trigger if exists a_00_incident_holds_reset_lock on public.incident_holds;
drop trigger if exists trg_00_incident_holds_reset_lock on public.incident_holds;
drop trigger if exists trg_incident_holds_reset_lock on public.incident_holds;
create trigger a_00_incident_holds_reset_lock
  before insert or update on public.incident_holds
  for each row execute function private.check_system_reset_lock();

drop trigger if exists a_00_office_visit_events_reset_lock on public.office_visit_events;
drop trigger if exists trg_00_office_visit_events_reset_lock on public.office_visit_events;
drop trigger if exists trg_office_visit_events_reset_lock on public.office_visit_events;
create trigger a_00_office_visit_events_reset_lock
  before insert or update on public.office_visit_events
  for each row execute function private.check_system_reset_lock();

drop trigger if exists a_00_office_visit_email_verifications_reset_lock on public.office_visit_email_verifications;
drop trigger if exists trg_00_office_visit_email_verifications_reset_lock on public.office_visit_email_verifications;
drop trigger if exists trg_office_visit_email_verifications_reset_lock on public.office_visit_email_verifications;
create trigger a_00_office_visit_email_verifications_reset_lock
  before insert or update on public.office_visit_email_verifications
  for each row execute function private.check_system_reset_lock();

drop trigger if exists a_00_office_visit_verification_proofs_reset_lock on public.office_visit_verification_proofs;
drop trigger if exists trg_00_office_visit_verification_proofs_reset_lock on public.office_visit_verification_proofs;
drop trigger if exists trg_office_visit_verification_proofs_reset_lock on public.office_visit_verification_proofs;
create trigger a_00_office_visit_verification_proofs_reset_lock
  before insert or update on public.office_visit_verification_proofs
  for each row execute function private.check_system_reset_lock();

drop trigger if exists a_00_returning_visitor_profiles_reset_lock on public.returning_visitor_profiles;
drop trigger if exists trg_00_returning_visitor_profiles_reset_lock on public.returning_visitor_profiles;
drop trigger if exists trg_returning_visitor_profiles_reset_lock on public.returning_visitor_profiles;
create trigger a_00_returning_visitor_profiles_reset_lock
  before insert or update on public.returning_visitor_profiles
  for each row execute function private.check_system_reset_lock();

drop trigger if exists a_00_returning_face_templates_reset_lock on public.returning_face_templates;
drop trigger if exists trg_00_returning_face_templates_reset_lock on public.returning_face_templates;
drop trigger if exists trg_returning_face_templates_reset_lock on public.returning_face_templates;
create trigger a_00_returning_face_templates_reset_lock
  before insert or update on public.returning_face_templates
  for each row execute function private.check_system_reset_lock();

drop trigger if exists a_00_returning_identity_attempts_reset_lock on public.returning_identity_attempts;
drop trigger if exists trg_00_returning_identity_attempts_reset_lock on public.returning_identity_attempts;
drop trigger if exists trg_returning_identity_attempts_reset_lock on public.returning_identity_attempts;
create trigger a_00_returning_identity_attempts_reset_lock
  before insert or update on public.returning_identity_attempts
  for each row execute function private.check_system_reset_lock();

drop trigger if exists a_00_returning_visitor_vehicles_reset_lock on public.returning_visitor_vehicles;
drop trigger if exists trg_00_returning_visitor_vehicles_reset_lock on public.returning_visitor_vehicles;
drop trigger if exists trg_returning_visitor_vehicles_reset_lock on public.returning_visitor_vehicles;
create trigger a_00_returning_visitor_vehicles_reset_lock
  before insert or update on public.returning_visitor_vehicles
  for each row execute function private.check_system_reset_lock();

drop trigger if exists a_00_portal_identity_verification_attempts_reset_lock on public.portal_identity_verification_attempts;
drop trigger if exists trg_00_portal_identity_verification_attempts_reset_lock on public.portal_identity_verification_attempts;
drop trigger if exists trg_portal_identity_verification_attempts_reset_lock on public.portal_identity_verification_attempts;
create trigger a_00_portal_identity_verification_attempts_reset_lock
  before insert or update on public.portal_identity_verification_attempts
  for each row execute function private.check_system_reset_lock();

drop trigger if exists a_00_offline_sync_receipts_reset_lock on public.offline_sync_receipts;
drop trigger if exists trg_00_offline_sync_receipts_reset_lock on public.offline_sync_receipts;
drop trigger if exists trg_offline_sync_receipts_reset_lock on public.offline_sync_receipts;
create trigger a_00_offline_sync_receipts_reset_lock
  before insert or update on public.offline_sync_receipts
  for each row execute function private.check_system_reset_lock();

drop trigger if exists a_00_emergency_gate_records_reset_lock on public.emergency_gate_records;
drop trigger if exists trg_00_emergency_gate_records_reset_lock on public.emergency_gate_records;
drop trigger if exists trg_emergency_gate_records_reset_lock on public.emergency_gate_records;
create trigger a_00_emergency_gate_records_reset_lock
  before insert or update on public.emergency_gate_records
  for each row execute function private.check_system_reset_lock();

drop trigger if exists a_00_emergency_device_manifests_reset_lock on public.emergency_device_manifests;
drop trigger if exists trg_00_emergency_device_manifests_reset_lock on public.emergency_device_manifests;
drop trigger if exists trg_emergency_device_manifests_reset_lock on public.emergency_device_manifests;
create trigger a_00_emergency_device_manifests_reset_lock
  before insert or update on public.emergency_device_manifests
  for each row execute function private.check_system_reset_lock();

drop trigger if exists a_00_emergency_sync_receipts_reset_lock on public.emergency_sync_receipts;
drop trigger if exists trg_00_emergency_sync_receipts_reset_lock on public.emergency_sync_receipts;
drop trigger if exists trg_emergency_sync_receipts_reset_lock on public.emergency_sync_receipts;
create trigger a_00_emergency_sync_receipts_reset_lock
  before insert or update on public.emergency_sync_receipts
  for each row execute function private.check_system_reset_lock();

drop trigger if exists a_00_pass_email_verifications_reset_lock on public.pass_email_verifications;
drop trigger if exists trg_00_pass_email_verifications_reset_lock on public.pass_email_verifications;
drop trigger if exists trg_pass_email_verifications_reset_lock on public.pass_email_verifications;
create trigger a_00_pass_email_verifications_reset_lock
  before insert or update on public.pass_email_verifications
  for each row execute function private.check_system_reset_lock();

drop trigger if exists a_00_office_visit_email_outbox_reset_lock on public.office_visit_email_outbox;
create trigger a_00_office_visit_email_outbox_reset_lock
  before insert or update on public.office_visit_email_outbox
  for each row execute function private.check_system_reset_lock();

drop trigger if exists a_00_office_visit_ack_outbox_reset_lock on public.office_visit_acknowledgement_outbox;
create trigger a_00_office_visit_ack_outbox_reset_lock
  before insert or update on public.office_visit_acknowledgement_outbox
  for each row execute function private.check_system_reset_lock();

drop trigger if exists a_00_office_provisioning_ops_reset_lock on public.office_provisioning_operations;
create trigger a_00_office_provisioning_ops_reset_lock
  before insert or update on public.office_provisioning_operations
  for each row execute function private.check_system_reset_lock();

drop trigger if exists a_00_reconciliation_tasks_reset_lock on public.reconciliation_tasks;
create trigger a_00_reconciliation_tasks_reset_lock
  before insert or update on public.reconciliation_tasks
  for each row execute function private.check_system_reset_lock();

drop trigger if exists a_00_staff_sessions_reset_lock on public.staff_sessions;
create trigger a_00_staff_sessions_reset_lock
  before insert or update on public.staff_sessions
  for each row execute function private.check_system_reset_lock();

drop trigger if exists a_00_office_staff_assignments_reset_lock on public.office_staff_assignments;
create trigger a_00_office_staff_assignments_reset_lock
  before insert or update on public.office_staff_assignments
  for each row execute function private.check_system_reset_lock();

drop trigger if exists a_00_staff_profiles_reset_lock on public.staff_profiles;
create trigger a_00_staff_profiles_reset_lock
  before insert or update on public.staff_profiles
  for each row execute function private.check_system_reset_lock();

-- Storage protection: update RLS policy and trigger on storage.objects if present
do $$
begin
  if exists (
    select 1 from information_schema.tables
    where table_schema = 'storage' and table_name = 'objects'
  ) then
    drop policy if exists evidence_insert_from_live_intent on storage.objects;
    create policy evidence_insert_from_live_intent on storage.objects for insert to authenticated
    with check (
      bucket_id in ('visitor-photos', 'visitor-ids')
      and owner_id = (select auth.uid())::text
      and not private.is_system_reset_locked()
      and exists (
        select 1 from public.upload_intents ui
        where ui.owner_id = (select auth.uid())
          and ui.bucket_id = storage.objects.bucket_id
          and ui.object_path = storage.objects.name
          and ui.status = 'pending'::public.upload_intent_status
          and ui.expires_at > now()
      )
    );

    drop trigger if exists a_00_storage_objects_reset_lock on storage.objects;
    drop trigger if exists trg_00_storage_objects_reset_lock on storage.objects;
    drop trigger if exists trg_storage_objects_reset_lock on storage.objects;
    create trigger a_00_storage_objects_reset_lock
      before insert or update on storage.objects
      for each row execute function private.check_system_reset_lock();
  end if;
end $$;

-- =============================================================================
-- 3. RETURN-TO-ZERO RESET RPC (HARDENED)
-- =============================================================================

-- Drop old 1-argument function to eliminate overload ambiguity
drop function if exists api.return_to_zero_reset(uuid);

create or replace function api.return_to_zero_reset(
  requested_actor_id uuid,
  requested_op_id uuid default null
)
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

  -- Validate requested_op_id if provided
  if requested_op_id is not null then
    if not exists (
      select 1 from public.system_reset_operations
      where id = requested_op_id
    ) then
      raise exception using errcode = 'P0002', message = 'operation_not_found';
    end if;
  end if;

  -- 3. Acquire exclusive advisory transaction lock to serialize return-to-zero operations
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('egatepass:return-to-zero-reset'));

  -- Set transaction-local bypass flag for system reset triggers so internal cleanup succeeds
  perform pg_catalog.set_config('egatepass.in_system_reset', 'true', true);

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
      'operation_id', requested_op_id,
      'preserved_superadmins', v_preserved_superadmins
    )
  );

  -- Step 20: Return structured response
  return jsonb_build_object(
    'success', true,
    'purged_at', now(),
    'actor_id', requested_actor_id,
    'operation_id', requested_op_id,
    'preserved_superadmins', v_preserved_superadmins
  );
end;
$$;

revoke all on function api.return_to_zero_reset(uuid, uuid) from public, anon, authenticated;
grant execute on function api.return_to_zero_reset(uuid, uuid) to service_role;

-- =============================================================================
-- 4. RESET LOCK ACQUISITION, RESUME, STEP-RECORDING AND RELEASE RPCS
-- =============================================================================

create or replace function api.acquire_system_reset_lock(
  requested_actor_id uuid,
  requested_resume_op_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_role public.staff_role;
  v_op_id uuid;
  v_current_lock text;
  v_existing_op_id uuid;
  v_existing_op_status text;
  v_op record;
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

  -- Atomic serialization: acquire transaction advisory lock
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('egatepass:system_reset_lock'));

  -- Ensure row exists in maintenance_state
  insert into public.maintenance_state (job_name, cursor_value, last_started_at, last_outcome)
  values ('system_reset', 'idle', null, null)
  on conflict (job_name) do nothing;

  -- Row-level lock on maintenance_state
  select cursor_value into v_current_lock
  from public.maintenance_state
  where job_name = 'system_reset'
  for update;

  -- If a specific interrupted operation is being explicitly resumed
  if requested_resume_op_id is not null then
    select * into v_op
    from public.system_reset_operations
    where id = requested_resume_op_id
    for update;

    if not found then
      return jsonb_build_object(
        'acquired', false,
        'reason', 'operation_not_found',
        'operation_id', requested_resume_op_id
      );
    end if;

    if v_op.status = 'completed' then
      return jsonb_build_object(
        'acquired', false,
        'reason', 'cannot_resume_completed_operation',
        'operation_id', requested_resume_op_id
      );
    end if;

    update public.system_reset_operations
    set step = 'resumed',
        updated_at = now()
    where id = requested_resume_op_id;

    update public.maintenance_state
    set cursor_value = 'locked',
        last_started_at = now()
    where job_name = 'system_reset';

    return jsonb_build_object(
      'acquired', true,
      'operation_id', requested_resume_op_id,
      'resumed', true,
      'previous_status', v_op.status,
      'storage_manifest', v_op.storage_manifest,
      'purged_counts', v_op.purged_counts
    );
  end if;

  -- Fresh acquisition request: reject if already locked or recovery required
  if v_current_lock in ('locked', 'in_progress', 'recovery_required') then
    -- Look up active/uncompleted operation to prevent silent overwrite
    select id, status into v_existing_op_id, v_existing_op_status
    from public.system_reset_operations
    where status <> 'completed'
    order by created_at desc
    limit 1;

    return jsonb_build_object(
      'acquired', false,
      'reason', case when v_current_lock = 'recovery_required' then 'recovery_required' else 'reset_already_in_progress' end,
      'operation_id', v_existing_op_id,
      'status', v_existing_op_status
    );
  end if;

  -- Idle state: generate fresh operation ID
  v_op_id := gen_random_uuid();

  -- Acquire maintenance lock
  update public.maintenance_state
  set cursor_value = 'locked',
      last_started_at = now(),
      last_outcome = null
  where job_name = 'system_reset';

  -- Create tracking record in system_reset_operations
  insert into public.system_reset_operations (
    id, actor_id, status, step, created_at, updated_at
  ) values (
    v_op_id, requested_actor_id, 'lock_acquired', 'lock_acquired', now(), now()
  );

  return jsonb_build_object('acquired', true, 'operation_id', v_op_id, 'resumed', false);
end;
$$;

revoke all on function api.acquire_system_reset_lock(uuid, uuid) from public, anon, authenticated;
grant execute on function api.acquire_system_reset_lock(uuid, uuid) to service_role;

create or replace function api.record_system_reset_step(
  requested_op_id uuid,
  requested_status text,
  requested_step text,
  requested_manifest jsonb default null,
  requested_counts jsonb default null,
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
      storage_manifest = case
        when requested_manifest is not null and requested_manifest <> '{}'::jsonb then requested_manifest
        else storage_manifest
      end,
      purged_counts = case
        when requested_counts is not null and requested_counts <> '{}'::jsonb then requested_counts
        else purged_counts
      end,
      error_details = coalesce(requested_error, error_details),
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

create or replace function api.release_system_reset_lock(
  requested_actor_id uuid,
  requested_op_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_role public.staff_role;
  v_op record;
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

  -- Verify operation exists and is not failed/recovery_required
  select * into v_op
  from public.system_reset_operations
  where id = requested_op_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'operation_not_found';
  end if;

  if v_op.status in ('failed', 'recovery_required') then
    raise exception using errcode = '55000', message = 'cannot_release_failed_or_recovery_operation';
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

create or replace function api.reconcile_system_reset_operation(
  requested_actor_id uuid,
  requested_op_id uuid,
  requested_action text default 'mark_failed',
  requested_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_role public.staff_role;
  v_op record;
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

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('egatepass:system_reset_lock'));

  select * into v_op
  from public.system_reset_operations
  where id = requested_op_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'operation_not_found';
  end if;

  if requested_action = 'resume' then
    update public.system_reset_operations
    set status = 'storage_deletion_in_progress',
        step = 'resumed_by_admin',
        error_details = coalesce(requested_note, error_details),
        updated_at = now()
    where id = requested_op_id;

    update public.maintenance_state
    set cursor_value = 'locked',
        last_started_at = now()
    where job_name = 'system_reset';

    return jsonb_build_object('success', true, 'action', 'resumed', 'operation_id', requested_op_id);
  elsif requested_action in ('mark_failed', 'abort') then
    update public.system_reset_operations
    set status = 'failed',
        step = 'aborted_by_admin',
        error_details = coalesce(requested_note, 'Aborted by superadmin reconciliation'),
        updated_at = now()
    where id = requested_op_id;

    update public.maintenance_state
    set cursor_value = 'recovery_required',
        last_outcome = 'failure'
    where job_name = 'system_reset';

    return jsonb_build_object('success', true, 'action', 'marked_failed', 'operation_id', requested_op_id);
  elsif requested_action = 'force_unlock' then
    update public.system_reset_operations
    set status = 'failed',
        step = 'force_unlocked_by_admin',
        error_details = coalesce(requested_note, 'Force unlocked by superadmin reconciliation'),
        updated_at = now()
    where id = requested_op_id;

    update public.maintenance_state
    set cursor_value = 'idle',
        last_outcome = 'aborted',
        last_completed_at = now()
    where job_name = 'system_reset';

    return jsonb_build_object('success', true, 'action', 'force_unlocked', 'operation_id', requested_op_id);
  else
    raise exception using errcode = '22000', message = 'unsupported_reconciliation_action';
  end if;
end;
$$;

revoke all on function api.reconcile_system_reset_operation(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function api.reconcile_system_reset_operation(uuid, uuid, text, text) to service_role;

-- =============================================================================
-- 6. SYSTEM RESET STATUS RPC
-- =============================================================================

create or replace function api.get_system_reset_status()
returns jsonb
language plpgsql
security definer
stable
set search_path = ''
as $$
declare
  v_maint record;
  v_op record;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'service role required';
  end if;

  select cursor_value, last_started_at, last_completed_at, last_outcome
  into v_maint
  from public.maintenance_state
  where job_name = 'system_reset';

  if v_maint.cursor_value in ('locked', 'in_progress', 'recovery_required') then
    select id, status, step, error_details, created_at, updated_at
    into v_op
    from public.system_reset_operations
    order by created_at desc
    limit 1;

    return jsonb_build_object(
      'isLocked', true,
      'status', coalesce(v_maint.cursor_value, 'idle'),
      'lastStartedAt', v_maint.last_started_at,
      'activeOperation', case when v_op.id is not null then
        jsonb_build_object(
          'id', v_op.id,
          'status', v_op.status,
          'step', v_op.step,
          'error_details', v_op.error_details,
          'created_at', v_op.created_at,
          'updated_at', v_op.updated_at
        ) else null end
    );
  else
    return jsonb_build_object(
      'isLocked', false,
      'status', coalesce(v_maint.cursor_value, 'idle'),
      'activeOperation', null
    );
  end if;
end;
$$;

revoke all on function api.get_system_reset_status() from public, anon, authenticated;
grant execute on function api.get_system_reset_status() to service_role;

