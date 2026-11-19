-- Migration: 20261119000400_reset_phase_gates_and_fail_closed_leases.sql
-- Description:
-- 1. Prevent database cleanup completion from being forged via api.record_system_reset_step:
--    reject database_cleanup_completed and completed in status or step.
-- 2. Restrict progress recording to legitimate intermediate states and enforce valid transition sequence:
--    lock_acquired/resumed -> storage_deletion_in_progress -> storage_deletion_verified -> database_cleanup_in_progress.
-- 3. In api.release_system_reset_lock, require BOTH v_op.status and v_op.step to equal database_cleanup_completed.
-- 4. In api.return_to_zero_reset, require operation to be in database_cleanup_in_progress phase AND
--    require persisted evidence that post-deletion re-enumeration of both allowlisted buckets verified both are empty.
-- 5. Add storage_verification column to public.system_reset_operations.
-- 6. Reject NULL and expired leases everywhere (fail closed on NULL) across cleanup, step recording, and lock release.

-- =============================================================================
-- 0. SCHEMA ENHANCEMENT: PERSISTED STORAGE VERIFICATION RECORD
-- =============================================================================

alter table public.system_reset_operations
  add column if not exists storage_verification jsonb;

-- =============================================================================
-- 1. HARDENED STEP RECORDING RPC: PHASE GATES, FORGERY DEFENSE & FAIL-CLOSED LEASE
-- =============================================================================

drop function if exists api.record_system_reset_step(uuid, text, text, jsonb, jsonb, text, integer, uuid);
drop function if exists api.record_system_reset_step(uuid, text, text, jsonb, jsonb, text, integer, uuid, jsonb);

create or replace function api.record_system_reset_step(
  requested_op_id uuid,
  requested_status text,
  requested_step text,
  requested_manifest jsonb default null,
  requested_counts jsonb default null,
  requested_error text default null,
  requested_worker_generation integer default null,
  requested_worker_id uuid default null,
  requested_verification jsonb default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_maint record;
  v_op record;
  v_updated_rows integer;
  v_verification jsonb;
  v_op_verification jsonb;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'service role required';
  end if;

  if requested_op_id is null then
    raise exception using errcode = '55000', message = 'fencing_token_revoked: operation ID required';
  end if;

  if requested_worker_generation is null then
    raise exception using errcode = '55000', message = 'fencing_token_revoked: worker generation required';
  end if;

  if requested_worker_id is null then
    raise exception using errcode = '55000', message = 'fencing_token_revoked: worker ID required';
  end if;

  -- 1. Lock and validate authoritative maintenance_state row
  select cursor_value, active_operation_id, worker_generation, active_worker_id, lease_expires_at
  into v_maint
  from public.maintenance_state
  where job_name = 'system_reset'
  for update;

  if not found or v_maint.cursor_value not in ('locked', 'in_progress') then
    raise exception using errcode = '55000', message = 'fencing_token_revoked: reset lock not active';
  end if;

  if v_maint.active_operation_id is distinct from requested_op_id then
    raise exception using errcode = '55000', message = 'fencing_token_revoked: worker operation mismatch';
  end if;

  if v_maint.worker_generation is distinct from requested_worker_generation then
    raise exception using errcode = '55000', message = 'fencing_token_revoked: worker generation expired or revoked';
  end if;

  if v_maint.active_worker_id is distinct from requested_worker_id then
    raise exception using errcode = '55000', message = 'fencing_token_revoked: worker ID revoked';
  end if;

  -- FAIL-CLOSED LEASE: Reject NULL and expired worker leases
  if v_maint.lease_expires_at is null or v_maint.lease_expires_at < clock_timestamp() then
    raise exception using errcode = '55000', message = 'fencing_token_revoked: worker lease expired';
  end if;

  -- 2. Lock and validate operation record before changing state
  select * into v_op
  from public.system_reset_operations
  where id = requested_op_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'operation_not_found';
  end if;

  if v_op.worker_generation is distinct from requested_worker_generation
     or v_op.worker_id is distinct from requested_worker_id then
    raise exception using errcode = '55000', message = 'fencing_token_revoked: operation record worker token mismatch';
  end if;

  -- Reject transitions from terminal or un-resumed recovery states
  if v_op.status in ('completed', 'failed', 'recovery_required') then
    raise exception using errcode = '55000', message = 'fencing_token_revoked: operation not in eligible state';
  end if;

  -- 3. Prevent forgery of terminal completion: only release_system_reset_lock may mark completed.
  if requested_status = 'completed' or requested_step = 'completed' then
    raise exception using errcode = '55000', message = 'invalid_state_transition: operation completion must be performed via release_system_reset_lock';
  end if;

  -- 4. Prevent forgery of database cleanup completion: only return_to_zero_reset may mark database_cleanup_completed.
  if requested_status = 'database_cleanup_completed' or requested_step = 'database_cleanup_completed' then
    raise exception using errcode = '55000', message = 'invalid_state_transition: database cleanup completion must be performed via return_to_zero_reset';
  end if;

  -- 5. Restrict progress recording to legitimate intermediate states used by the reset route
  if requested_status not in (
    'storage_deletion_in_progress',
    'storage_deletion_verified',
    'database_cleanup_in_progress',
    'recovery_required',
    'failed'
  ) then
    raise exception using errcode = '55000', message = 'invalid_state_transition: illegitimate status requested';
  end if;

  -- Extract storage verification record from parameter or manifest
  v_verification := coalesce(
    requested_verification,
    case
      when requested_manifest is not null and requested_manifest ? 'verification' then requested_manifest->'verification'
      else null
    end
  );

  -- 6. Enforce strictly valid transition sequence:
  -- storage_deletion_in_progress: must originate from lock_acquired (or idempotent re-recording)
  if requested_status = 'storage_deletion_in_progress' then
    if v_op.status not in ('lock_acquired', 'storage_deletion_in_progress') then
      raise exception using errcode = '55000', message = 'invalid_state_transition: storage_deletion_in_progress requires lock_acquired state';
    end if;

  -- storage_deletion_verified: must originate from storage_deletion_in_progress (or idempotent re-recording)
  elsif requested_status = 'storage_deletion_verified' then
    if v_op.status not in ('storage_deletion_in_progress', 'storage_deletion_verified') then
      raise exception using errcode = '55000', message = 'invalid_state_transition: storage_deletion_verified requires storage_deletion_in_progress state';
    end if;

  -- database_cleanup_in_progress: reachable only after verified Storage phase
  elsif requested_status = 'database_cleanup_in_progress' then
    if v_op.status not in ('storage_deletion_verified', 'database_cleanup_in_progress') then
      raise exception using errcode = '55000', message = 'invalid_state_transition: database_cleanup_in_progress requires storage_deletion_verified state';
    end if;

    -- Extract effective verification from parameter, manifest, or previously verified op record
    v_op_verification := coalesce(
      v_verification,
      v_op.storage_verification,
      case
        when requested_manifest is not null and requested_manifest ? 'verification' then requested_manifest->'verification'
        else null
      end,
      case
        when v_op.storage_manifest is not null and v_op.storage_manifest ? 'verification' then v_op.storage_manifest->'verification'
        else null
      end
    );

    if v_op_verification is null or v_op_verification = 'null'::jsonb or v_op_verification = '{}'::jsonb then
      raise exception using errcode = '55000', message = 'storage_verification_required: storage purge verification record missing or empty';
    end if;

    if not (v_op_verification ? 'buckets') or
       not (v_op_verification->'buckets' ? 'visitor-photos') or
       not (v_op_verification->'buckets' ? 'visitor-ids') then
      raise exception using errcode = '55000', message = 'storage_verification_malformed: verification must include visitor-photos and visitor-ids buckets';
    end if;

    if nullif(v_op_verification->>'verifiedAt', '') is null then
      raise exception using errcode = '55000', message = 'storage_verification_malformed: missing verifiedAt timestamp';
    end if;

    if (v_op_verification->'buckets'->'visitor-photos'->>'remainingCount') is null or
       (v_op_verification->'buckets'->'visitor-ids'->>'remainingCount') is null or
       (v_op_verification->'buckets'->'visitor-photos'->>'remainingCount') <> '0' or
       (v_op_verification->'buckets'->'visitor-ids'->>'remainingCount') <> '0' or
       (v_op_verification->'buckets'->'visitor-photos'->>'verifiedEmpty') <> 'true' or
       (v_op_verification->'buckets'->'visitor-ids'->>'verifiedEmpty') <> 'true' or
       (v_op_verification->>'verifiedEmpty') <> 'true' then
      raise exception using errcode = '55000', message = 'storage_verification_failed: storage buckets not verified empty';
    end if;
  end if;

  -- 7. Update system_reset_operations matching operation ID and worker tokens
  update public.system_reset_operations
  set status = requested_status,
      step = requested_step,
      storage_manifest = case
        when requested_manifest is not null and requested_manifest <> '{}'::jsonb and requested_manifest <> 'null'::jsonb then requested_manifest
        else storage_manifest
      end,
      purged_counts = case
        when requested_counts is not null and requested_counts <> '{}'::jsonb and requested_counts <> 'null'::jsonb then requested_counts
        else purged_counts
      end,
      storage_verification = case
        when requested_status = 'storage_deletion_in_progress' then null
        when v_verification is not null and v_verification <> '{}'::jsonb and v_verification <> 'null'::jsonb then v_verification
        else storage_verification
      end,
      error_details = coalesce(requested_error, error_details),
      updated_at = clock_timestamp()
  where id = requested_op_id
    and worker_generation = requested_worker_generation
    and worker_id = requested_worker_id;

  get diagnostics v_updated_rows = row_count;
  if v_updated_rows = 0 then
    raise exception using errcode = '55000', message = 'fencing_token_revoked: operation record worker token mismatch';
  end if;

  -- 8. Transition maintenance state
  if requested_status in ('failed', 'recovery_required') then
    update public.maintenance_state
    set cursor_value = 'recovery_required',
        last_outcome = 'failure',
        heartbeat_at = clock_timestamp()
    where job_name = 'system_reset';
  elsif requested_status = 'database_cleanup_in_progress' then
    update public.maintenance_state
    set cursor_value = 'in_progress',
        heartbeat_at = clock_timestamp(),
        lease_expires_at = clock_timestamp() + interval '60 seconds'
    where job_name = 'system_reset';
  else
    update public.maintenance_state
    set heartbeat_at = clock_timestamp(),
        lease_expires_at = clock_timestamp() + interval '60 seconds'
    where job_name = 'system_reset';
  end if;
end;
$$;

revoke all on function api.record_system_reset_step(uuid, text, text, jsonb, jsonb, text, integer, uuid, jsonb) from public, anon, authenticated;
grant execute on function api.record_system_reset_step(uuid, text, text, jsonb, jsonb, text, integer, uuid, jsonb) to service_role;

-- =============================================================================
-- 2. HARDENED DATABASE CLEANUP RPC: STORAGE PHASE GATE & FAIL-CLOSED LEASE
-- =============================================================================

drop function if exists api.return_to_zero_reset(uuid);
drop function if exists api.return_to_zero_reset(uuid, uuid);
drop function if exists api.return_to_zero_reset(uuid, uuid, integer);
drop function if exists api.return_to_zero_reset(uuid, uuid, integer, uuid);

create or replace function api.return_to_zero_reset(
  requested_actor_id uuid
)
returns jsonb
language plpgsql
volatile
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

  raise exception using errcode = '55000', message = 'fencing_token_revoked: operation ID required';
end;
$$;

create or replace function api.return_to_zero_reset(
  requested_actor_id uuid,
  requested_op_id uuid
)
returns jsonb
language plpgsql
volatile
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

  raise exception using errcode = '55000', message = 'fencing_token_revoked: worker generation required';
end;
$$;

create or replace function api.return_to_zero_reset(
  requested_actor_id uuid,
  requested_op_id uuid,
  requested_worker_generation integer
)
returns jsonb
language plpgsql
volatile
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

  raise exception using errcode = '55000', message = 'fencing_token_revoked: worker ID required';
end;
$$;

create or replace function api.return_to_zero_reset(
  requested_actor_id uuid,
  requested_op_id uuid,
  requested_worker_generation integer,
  requested_worker_id uuid
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
  v_maint record;
  v_op record;
  v_verification jsonb;
begin
  -- 1. Security Check: caller must be service_role
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

  -- 3. Require non-null operation ID, worker generation, and worker ID
  if requested_op_id is null then
    raise exception using errcode = '55000', message = 'fencing_token_revoked: operation ID required';
  end if;

  if requested_worker_generation is null then
    raise exception using errcode = '55000', message = 'fencing_token_revoked: worker generation required';
  end if;

  if requested_worker_id is null then
    raise exception using errcode = '55000', message = 'fencing_token_revoked: worker ID required';
  end if;

  -- 4. Acquire exclusive advisory transaction lock to serialize return-to-zero operations
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('egatepass:return-to-zero-reset'));

  -- 5. Fencing validation: check maintenance_state
  select cursor_value, active_operation_id, worker_generation, active_worker_id, lease_expires_at
  into v_maint
  from public.maintenance_state
  where job_name = 'system_reset'
  for update;

  if not found or v_maint.cursor_value not in ('locked', 'in_progress') then
    raise exception using errcode = '55000', message = 'fencing_token_revoked: reset lock not active';
  end if;

  if v_maint.active_operation_id is distinct from requested_op_id then
    raise exception using errcode = '55000', message = 'fencing_token_revoked: operation mismatch';
  end if;

  if v_maint.worker_generation is distinct from requested_worker_generation then
    raise exception using errcode = '55000', message = 'fencing_token_revoked: worker generation expired or revoked';
  end if;

  if v_maint.active_worker_id is distinct from requested_worker_id then
    raise exception using errcode = '55000', message = 'fencing_token_revoked: worker ID revoked';
  end if;

  -- FAIL-CLOSED LEASE: Reject NULL and expired worker leases
  if v_maint.lease_expires_at is null or v_maint.lease_expires_at < clock_timestamp() then
    raise exception using errcode = '55000', message = 'fencing_token_revoked: worker lease expired';
  end if;

  -- 6. Validate operation record exists and matches worker tokens
  select * into v_op
  from public.system_reset_operations
  where id = requested_op_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'operation_not_found';
  end if;

  if v_op.worker_generation is distinct from requested_worker_generation
     or v_op.worker_id is distinct from requested_worker_id then
    raise exception using errcode = '55000', message = 'fencing_token_revoked: operation worker token mismatch';
  end if;

  if v_op.status in ('failed', 'recovery_required', 'completed') then
    raise exception using errcode = '55000', message = 'fencing_token_revoked: operation not in eligible state';
  end if;

  -- REQUIREMENT 2: Require active operation to be in exact expected phase and step
  if v_op.status <> 'database_cleanup_in_progress' or v_op.step <> 'database_cleanup_in_progress' then
    raise exception using errcode = '55000', message = 'invalid_state_transition: operation must be in database_cleanup_in_progress phase';
  end if;

  -- REQUIREMENT 2: Require persisted evidence of completed and verified Storage purge
  v_verification := coalesce(v_op.storage_verification, v_op.storage_manifest->'verification');

  if v_verification is null or v_verification = 'null'::jsonb or v_verification = '{}'::jsonb then
    raise exception using errcode = '55000', message = 'storage_verification_required: storage purge verification record missing or empty';
  end if;

  if not (v_verification ? 'buckets') or
     not (v_verification->'buckets' ? 'visitor-photos') or
     not (v_verification->'buckets' ? 'visitor-ids') then
    raise exception using errcode = '55000', message = 'storage_verification_malformed: verification must include visitor-photos and visitor-ids buckets';
  end if;

  if nullif(v_verification->>'verifiedAt', '') is null then
    raise exception using errcode = '55000', message = 'storage_verification_malformed: missing verifiedAt timestamp';
  end if;

  if (v_verification->'buckets'->'visitor-photos'->>'remainingCount') is null or
     (v_verification->'buckets'->'visitor-ids'->>'remainingCount') is null or
     (v_verification->'buckets'->'visitor-photos'->>'remainingCount') <> '0' or
     (v_verification->'buckets'->'visitor-ids'->>'remainingCount') <> '0' or
     (v_verification->'buckets'->'visitor-photos'->>'verifiedEmpty') <> 'true' or
     (v_verification->'buckets'->'visitor-ids'->>'verifiedEmpty') <> 'true' or
     (v_verification->>'verifiedEmpty') <> 'true' then
    raise exception using errcode = '55000', message = 'storage_verification_failed: storage buckets not verified empty';
  end if;

  -- 7. Update maintenance_state to in_progress and refresh lease
  update public.maintenance_state
  set cursor_value = 'in_progress',
      heartbeat_at = clock_timestamp(),
      lease_expires_at = clock_timestamp() + interval '60 seconds'
  where job_name = 'system_reset';

  -- 8. Set session variables for transaction-local reset bypass in triggers
  perform pg_catalog.set_config('egatepass.active_reset_op_id', requested_op_id::text, true);
  perform pg_catalog.set_config('egatepass.active_reset_worker_gen', requested_worker_generation::text, true);
  perform pg_catalog.set_config('egatepass.active_reset_worker_id', requested_worker_id::text, true);
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

  -- Step 2: Office visits
  delete from public.office_visits;

  -- Step 3: Pass and Visit dependents
  delete from public.incident_holds;
  delete from public.visit_events;
  delete from public.pass_email_verifications;
  delete from public.offline_sync_receipts;
  delete from public.visit_vehicle_declarations;

  -- Step 4: Passes
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

  -- Step 8: Visitors
  delete from public.visitors;

  -- Step 9: Returning visitor profiles and biometric / vehicle attachments
  delete from public.returning_identity_attempts;
  delete from public.returning_face_templates;
  delete from public.returning_visitor_vehicles;
  delete from public.returning_visitor_profiles;

  -- Step 10: Emergency records, manifests, receipts
  delete from public.emergency_sync_receipts;
  delete from public.emergency_gate_records;
  delete from public.emergency_device_manifests;

  -- Step 11: Devices
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
      updated_at = clock_timestamp(),
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

  -- Step 16: Non-superadmin auth.mfa_factors
  delete from auth.mfa_factors
  where user_id not in (
    select sp.user_id from public.staff_profiles sp where sp.role = 'superadmin' and sp.active = true
  );

  -- Step 17: Non-superadmin auth.users
  delete from auth.users
  where id not in (
    select sp.user_id from public.staff_profiles sp where sp.role = 'superadmin' and sp.active = true
  );

  -- Step 18: Append authoritative return_to_zero audit event WITHOUT wiping historical audit history
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
      'purged_at', clock_timestamp(),
      'operation_id', requested_op_id,
      'preserved_superadmins', v_preserved_superadmins
    )
  );

  -- Step 19: Record database_cleanup_completed status in operation
  update public.system_reset_operations
  set status = 'database_cleanup_completed',
      step = 'database_cleanup_completed',
      updated_at = clock_timestamp()
  where id = requested_op_id;

  -- Step 20: Return structured response
  return jsonb_build_object(
    'success', true,
    'purged_at', clock_timestamp(),
    'actor_id', requested_actor_id,
    'operation_id', requested_op_id,
    'preserved_superadmins', v_preserved_superadmins
  );
end;
$$;

revoke all on function api.return_to_zero_reset(uuid) from public, anon, authenticated;
grant execute on function api.return_to_zero_reset(uuid) to service_role;

revoke all on function api.return_to_zero_reset(uuid, uuid) from public, anon, authenticated;
grant execute on function api.return_to_zero_reset(uuid, uuid) to service_role;

revoke all on function api.return_to_zero_reset(uuid, uuid, integer) from public, anon, authenticated;
grant execute on function api.return_to_zero_reset(uuid, uuid, integer) to service_role;

revoke all on function api.return_to_zero_reset(uuid, uuid, integer, uuid) from public, anon, authenticated;
grant execute on function api.return_to_zero_reset(uuid, uuid, integer, uuid) to service_role;

-- =============================================================================
-- 3. HARDENED LOCK RELEASE RPC: EXACT DUAL-FIELD MATCH & FAIL-CLOSED LEASE
-- =============================================================================

drop function if exists api.release_system_reset_lock(uuid, uuid);
drop function if exists api.release_system_reset_lock(uuid, uuid, integer);
drop function if exists api.release_system_reset_lock(uuid, uuid, integer, uuid);

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

  raise exception using errcode = '55000', message = 'fencing_token_revoked: worker generation required';
end;
$$;

create or replace function api.release_system_reset_lock(
  requested_actor_id uuid,
  requested_op_id uuid,
  requested_worker_generation integer
)
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

  raise exception using errcode = '55000', message = 'fencing_token_revoked: worker ID required';
end;
$$;

create or replace function api.release_system_reset_lock(
  requested_actor_id uuid,
  requested_op_id uuid,
  requested_worker_generation integer,
  requested_worker_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_role public.staff_role;
  v_maint record;
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

  -- Reject missing parameters
  if requested_op_id is null then
    raise exception using errcode = '55000', message = 'fencing_token_revoked: operation ID required';
  end if;

  if requested_worker_generation is null then
    raise exception using errcode = '55000', message = 'fencing_token_revoked: worker generation required';
  end if;

  if requested_worker_id is null then
    raise exception using errcode = '55000', message = 'fencing_token_revoked: worker ID required';
  end if;

  -- Row lock on maintenance_state
  select cursor_value, active_operation_id, worker_generation, active_worker_id, lease_expires_at
  into v_maint
  from public.maintenance_state
  where job_name = 'system_reset'
  for update;

  if not found or v_maint.cursor_value not in ('locked', 'in_progress') then
    raise exception using errcode = '55000', message = 'fencing_token_revoked: reset lock not active';
  end if;

  if v_maint.active_operation_id is distinct from requested_op_id then
    raise exception using errcode = '55000', message = 'fencing_token_revoked: cannot release another operation lock';
  end if;

  if v_maint.worker_generation is distinct from requested_worker_generation then
    raise exception using errcode = '55000', message = 'fencing_token_revoked: worker generation expired or revoked';
  end if;

  if v_maint.active_worker_id is distinct from requested_worker_id then
    raise exception using errcode = '55000', message = 'fencing_token_revoked: worker ID revoked';
  end if;

  -- FAIL-CLOSED LEASE: Reject NULL and expired worker leases
  if v_maint.lease_expires_at is null or v_maint.lease_expires_at < clock_timestamp() then
    raise exception using errcode = '55000', message = 'fencing_token_revoked: worker lease expired';
  end if;

  -- Row lock on system_reset_operations
  select * into v_op
  from public.system_reset_operations
  where id = requested_op_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'operation_not_found';
  end if;

  if v_op.worker_generation is distinct from requested_worker_generation
     or v_op.worker_id is distinct from requested_worker_id then
    raise exception using errcode = '55000', message = 'fencing_token_revoked: operation worker token mismatch';
  end if;

  if v_op.status in ('failed', 'recovery_required') then
    raise exception using errcode = '55000', message = 'cannot_release_failed_or_recovery_operation';
  end if;

  -- REQUIREMENT 1: Require BOTH v_op.status and v_op.step to equal database_cleanup_completed
  if v_op.status <> 'database_cleanup_completed' or v_op.step <> 'database_cleanup_completed' then
    raise exception using errcode = '55000', message = 'database_cleanup_incomplete: database cleanup has not completed successfully';
  end if;

  -- Mark operation completed and clear active ownership in one atomic transaction
  update public.system_reset_operations
  set status = 'completed',
      step = 'completed',
      completed_at = clock_timestamp(),
      updated_at = clock_timestamp()
  where id = requested_op_id;

  update public.maintenance_state
  set cursor_value = 'idle',
      active_operation_id = null,
      active_worker_id = null,
      lease_expires_at = null,
      last_outcome = 'success',
      last_completed_at = clock_timestamp()
  where job_name = 'system_reset';
end;
$$;

revoke all on function api.release_system_reset_lock(uuid, uuid) from public, anon, authenticated;
grant execute on function api.release_system_reset_lock(uuid, uuid) to service_role;

revoke all on function api.release_system_reset_lock(uuid, uuid, integer) from public, anon, authenticated;
grant execute on function api.release_system_reset_lock(uuid, uuid, integer) to service_role;

revoke all on function api.release_system_reset_lock(uuid, uuid, integer, uuid) from public, anon, authenticated;
grant execute on function api.release_system_reset_lock(uuid, uuid, integer, uuid) to service_role;
