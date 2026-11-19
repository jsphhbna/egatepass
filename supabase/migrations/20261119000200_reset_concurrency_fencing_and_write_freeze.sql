-- Migration: 20261119000200_reset_concurrency_fencing_and_write_freeze.sql
-- Description:
-- 1. Extend public.maintenance_state with authoritative active_operation_id, worker_generation, active_worker_id, heartbeat_at.
-- 2. Extend public.system_reset_operations with worker_generation and worker_id.
-- 3. Redesign private.check_system_reset_lock() with PostgreSQL FOR SHARE tuple-level locking to drain in-flight writes.
-- 4. Attach write-freeze triggers to resend_webhook_events, rate_limit_buckets, nominatim_rate_limiter, location_search_cache.
-- 5. Harden api.acquire_system_reset_lock with durable operation binding, recovery eligibility checks, and worker generation fencing.
-- 6. Add api.assert_system_reset_worker_active() for worker heartbeat and lease fencing.
-- 7. Harden api.record_system_reset_step, api.return_to_zero_reset, and api.release_system_reset_lock with fencing checks.
-- 8. Harden api.reconcile_system_reset_operation to revoke stale workers immediately via worker_generation increments.
-- 9. Update api.get_system_reset_status to read authoritative active_operation_id.

-- =============================================================================
-- 1. EXTEND MAINTENANCE_STATE AND SYSTEM_RESET_OPERATIONS TABLES
-- =============================================================================

alter table public.maintenance_state
  add column if not exists active_operation_id uuid,
  add column if not exists worker_generation integer not null default 0,
  add column if not exists active_worker_id uuid,
  add column if not exists heartbeat_at timestamptz default now(),
  add column if not exists lease_expires_at timestamptz;

alter table public.system_reset_operations
  add column if not exists worker_generation integer not null default 1,
  add column if not exists worker_id uuid;

-- Ensure baseline row exists for system_reset job in maintenance_state
insert into public.maintenance_state (job_name, cursor_value, last_started_at, last_outcome, worker_generation)
values ('system_reset', 'idle', null, null, 0)
on conflict (job_name) do nothing;

-- =============================================================================
-- 2. WRITE-FREEZE GUARD WITH FOR SHARE CONCURRENCY DRAIN SEMANTICS
-- =============================================================================

create or replace function private.check_system_reset_lock()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_state text;
  v_active_op uuid;
  v_worker_gen integer;
  v_sess_op text;
  v_sess_gen text;
begin
  v_sess_op := pg_catalog.current_setting('egatepass.active_reset_op_id', true);
  v_sess_gen := pg_catalog.current_setting('egatepass.active_reset_worker_gen', true);

  -- 1. Check if the current session is an authorized active return_to_zero worker
  if v_sess_op is not null and v_sess_op <> '' then
    select cursor_value, active_operation_id, worker_generation
    into v_state, v_active_op, v_worker_gen
    from public.maintenance_state
    where job_name = 'system_reset';

    if v_state in ('locked', 'in_progress')
       and v_active_op is not null
       and v_active_op::text = v_sess_op
       and (v_sess_gen is null or v_sess_gen = '' or v_worker_gen::text = v_sess_gen)
    then
      return new;
    end if;
  end if;

  -- Transaction-local bypass for internal return_to_zero cleanup execution
  if pg_catalog.current_setting('egatepass.in_system_reset', true) = 'true' then
    select cursor_value into v_state
    from public.maintenance_state
    where job_name = 'system_reset';
    if v_state in ('locked', 'in_progress') then
      return new;
    end if;
  end if;


  -- 2. Concurrency-safe write guard with transactional lock semantics:
  -- Acquire tuple-level SHARE lock on the system_reset maintenance row.
  -- Multiple concurrent operational transactions take FOR SHARE without blocking each other.
  -- When acquire_system_reset_lock is executed, it takes FOR UPDATE on this row.
  -- PostgreSQL forces acquire_system_reset_lock to wait until all existing transactions
  -- holding FOR SHARE have completed (committed or aborted).
  -- Any write transaction arriving after acquire_system_reset_lock updates cursor_value to 'locked'
  -- reads cursor_value = 'locked' and is immediately rejected.
  select cursor_value into v_state
  from public.maintenance_state
  where job_name = 'system_reset'
  for share;

  if not found then
    v_state := 'idle';
  end if;

  if v_state in ('locked', 'in_progress', 'recovery_required') then
    raise exception using
      errcode = '55P03',
      message = 'system_reset_in_progress: system is undergoing operational reset or recovery';
  end if;

  return new;
end;
$$;

revoke all on function private.check_system_reset_lock() from public, anon, authenticated;
grant execute on function private.check_system_reset_lock() to service_role;

-- Attach write-freeze triggers to the 4 previously uncovered operational tables
drop trigger if exists a_00_resend_webhook_events_reset_lock on public.resend_webhook_events;
create trigger a_00_resend_webhook_events_reset_lock
  before insert or update on public.resend_webhook_events
  for each row execute function private.check_system_reset_lock();

drop trigger if exists a_00_rate_limit_buckets_reset_lock on public.rate_limit_buckets;
create trigger a_00_rate_limit_buckets_reset_lock
  before insert or update on public.rate_limit_buckets
  for each row execute function private.check_system_reset_lock();

drop trigger if exists a_00_nominatim_rate_limiter_reset_lock on public.nominatim_rate_limiter;
create trigger a_00_nominatim_rate_limiter_reset_lock
  before insert or update on public.nominatim_rate_limiter
  for each row execute function private.check_system_reset_lock();

drop trigger if exists a_00_location_search_cache_reset_lock on public.location_search_cache;
create trigger a_00_location_search_cache_reset_lock
  before insert or update on public.location_search_cache
  for each row execute function private.check_system_reset_lock();

-- =============================================================================
-- 3. HARDENED LOCK ACQUISITION & RESUME RPC
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
  v_maint record;
  v_new_gen integer;
  v_new_worker_id uuid;
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
  insert into public.maintenance_state (job_name, cursor_value, last_started_at, last_outcome, worker_generation)
  values ('system_reset', 'idle', null, null, 0)
  on conflict (job_name) do nothing;

  -- Row-level exclusive lock on maintenance_state.
  -- Drains all in-flight operational transactions currently holding FOR SHARE.
  select *
  into v_maint
  from public.maintenance_state
  where job_name = 'system_reset'
  for update;

  -- RESUME CASE: Explicit operation recovery requested
  if requested_resume_op_id is not null then
    -- 1. Reject if operation is not found
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

    -- 2. Reject attempts to resume completed operations
    if v_op.status = 'completed' then
      return jsonb_build_object(
        'acquired', false,
        'reason', 'cannot_resume_completed_operation',
        'operation_id', requested_resume_op_id
      );
    end if;

    -- 3. Reject attempts to resume failed operations without reconciliation
    if v_op.status = 'failed' then
      return jsonb_build_object(
        'acquired', false,
        'reason', 'cannot_resume_failed_operation',
        'operation_id', requested_resume_op_id
      );
    end if;

    -- 4. Prevent two simultaneous resume requests from both obtaining execution authority:
    -- If lock is active ('locked' or 'in_progress') and has a fresh heartbeat (< 30 seconds),
    -- another worker is currently actively executing.
    if v_maint.cursor_value in ('locked', 'in_progress')
       and v_maint.heartbeat_at is not null
       and v_maint.heartbeat_at >= (now() - interval '30 seconds')
    then
      return jsonb_build_object(
        'acquired', false,
        'reason', 'reset_already_in_progress',
        'operation_id', v_maint.active_operation_id,
        'status', v_maint.cursor_value
      );
    end if;

    -- 5. Reject if active_operation_id is set to a different operation or is null (cannot replace newer/different active operation or resume unrelated historical operations)
    if v_maint.active_operation_id is distinct from requested_resume_op_id then
      return jsonb_build_object(
        'acquired', false,
        'reason', 'operation_not_active_or_eligible',
        'operation_id', v_maint.active_operation_id
      );
    end if;

    -- 6. Operation must be eligible for recovery (locked/in_progress with expired heartbeat, or recovery_required)
    if v_maint.cursor_value not in ('locked', 'in_progress', 'recovery_required') then
      return jsonb_build_object(
        'acquired', false,
        'reason', 'operation_not_eligible_for_recovery',
        'operation_id', requested_resume_op_id,
        'status', v_op.status
      );
    end if;

    -- Advance worker generation and allocate new worker ID
    v_new_gen := coalesce(v_maint.worker_generation, 0) + 1;
    v_new_worker_id := gen_random_uuid();

    update public.maintenance_state
    set cursor_value = 'locked',
        active_operation_id = requested_resume_op_id,
        worker_generation = v_new_gen,
        active_worker_id = v_new_worker_id,
        last_started_at = now(),
        heartbeat_at = now(),
        last_outcome = null
    where job_name = 'system_reset';

    update public.system_reset_operations
    set status = 'lock_acquired',
        step = 'resumed',
        worker_generation = v_new_gen,
        worker_id = v_new_worker_id,
        updated_at = now()
    where id = requested_resume_op_id;

    return jsonb_build_object(
      'acquired', true,
      'operation_id', requested_resume_op_id,
      'resumed', true,
      'worker_generation', v_new_gen,
      'worker_id', v_new_worker_id,
      'previous_status', v_op.status,
      'storage_manifest', v_op.storage_manifest,
      'purged_counts', v_op.purged_counts
    );
  end if;

  -- FRESH ACQUISITION CASE:
  -- Reject if system is already locked, in progress, or requires recovery
  if v_maint.cursor_value in ('locked', 'in_progress', 'recovery_required') then
    return jsonb_build_object(
      'acquired', false,
      'reason', case when v_maint.cursor_value = 'recovery_required' then 'recovery_required' else 'reset_already_in_progress' end,
      'operation_id', v_maint.active_operation_id,
      'status', v_maint.cursor_value
    );
  end if;

  -- Generate fresh authoritative operation ID and worker fencing generation
  v_op_id := gen_random_uuid();
  v_new_gen := coalesce(v_maint.worker_generation, 0) + 1;
  v_new_worker_id := gen_random_uuid();

  -- Authoritatively set active_operation_id on maintenance_state
  update public.maintenance_state
  set cursor_value = 'locked',
      active_operation_id = v_op_id,
      worker_generation = v_new_gen,
      active_worker_id = v_new_worker_id,
      last_started_at = now(),
      heartbeat_at = now(),
      last_outcome = null
  where job_name = 'system_reset';

  insert into public.system_reset_operations (
    id, actor_id, status, step, worker_generation, worker_id, created_at, updated_at
  ) values (
    v_op_id, requested_actor_id, 'lock_acquired', 'lock_acquired', v_new_gen, v_new_worker_id, now(), now()
  );

  return jsonb_build_object(
    'acquired', true,
    'operation_id', v_op_id,
    'resumed', false,
    'worker_generation', v_new_gen,
    'worker_id', v_new_worker_id
  );
end;
$$;

revoke all on function api.acquire_system_reset_lock(uuid, uuid) from public, anon, authenticated;
grant execute on function api.acquire_system_reset_lock(uuid, uuid) to service_role;

-- =============================================================================
-- 4. WORKER ACTIVE HEARTBEAT & FENCING ASSERTION RPC
-- =============================================================================

create or replace function api.assert_system_reset_worker_active(
  requested_op_id uuid,
  requested_worker_generation integer default null,
  requested_worker_id uuid default null
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_maint record;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'service role required';
  end if;

  select cursor_value, active_operation_id, worker_generation, active_worker_id
  into v_maint
  from public.maintenance_state
  where job_name = 'system_reset';

  if v_maint.cursor_value not in ('locked', 'in_progress')
     or v_maint.active_operation_id is distinct from requested_op_id
     or (requested_worker_generation is not null and v_maint.worker_generation is distinct from requested_worker_generation)
     or (requested_worker_id is not null and v_maint.active_worker_id is distinct from requested_worker_id)
  then
    raise exception using errcode = '55000', message = 'fencing_token_revoked: worker lease expired or revoked';
  end if;

  update public.maintenance_state
  set heartbeat_at = now()
  where job_name = 'system_reset';

  return true;
end;
$$;

revoke all on function api.assert_system_reset_worker_active(uuid, integer, uuid) from public, anon, authenticated;
grant execute on function api.assert_system_reset_worker_active(uuid, integer, uuid) to service_role;

-- =============================================================================
-- 5. HARDENED STEP RECORDING RPC WITH FENCING
-- =============================================================================

drop function if exists api.record_system_reset_step(uuid, text, text, jsonb, jsonb, text);
drop function if exists api.record_system_reset_step(uuid, text, text, jsonb, jsonb, text, integer, uuid);

create or replace function api.record_system_reset_step(
  requested_op_id uuid,
  requested_status text,
  requested_step text,
  requested_manifest jsonb default null,
  requested_counts jsonb default null,
  requested_error text default null,
  requested_worker_generation integer default null,
  requested_worker_id uuid default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_maint record;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'service role required';
  end if;

  select cursor_value, active_operation_id, worker_generation, active_worker_id
  into v_maint
  from public.maintenance_state
  where job_name = 'system_reset';

  -- Fencing validation: check that caller still owns the active reset
  if v_maint.active_operation_id is not null and v_maint.active_operation_id <> requested_op_id then
    raise exception using errcode = '55000', message = 'fencing_token_revoked: worker operation mismatch';
  end if;

  if requested_worker_generation is not null and v_maint.worker_generation is distinct from requested_worker_generation then
    raise exception using errcode = '55000', message = 'fencing_token_revoked: worker generation expired or revoked';
  end if;

  if requested_worker_id is not null and v_maint.active_worker_id is distinct from requested_worker_id then
    raise exception using errcode = '55000', message = 'fencing_token_revoked: worker ID revoked';
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
        last_outcome = 'failure',
        heartbeat_at = now()
    where job_name = 'system_reset';
  elsif requested_status = 'completed' then
    update public.maintenance_state
    set cursor_value = 'idle',
        last_outcome = 'success',
        last_completed_at = now(),
        active_operation_id = null,
        active_worker_id = null
    where job_name = 'system_reset';
  elsif requested_status = 'database_cleanup_in_progress' then
    update public.maintenance_state
    set cursor_value = 'in_progress',
        heartbeat_at = now()
    where job_name = 'system_reset';
  else
    update public.maintenance_state
    set heartbeat_at = now()
    where job_name = 'system_reset';
  end if;
end;
$$;

revoke all on function api.record_system_reset_step(uuid, text, text, jsonb, jsonb, text, integer, uuid) from public, anon, authenticated;
grant execute on function api.record_system_reset_step(uuid, text, text, jsonb, jsonb, text, integer, uuid) to service_role;

-- =============================================================================
-- 6. HARDENED DATABASE CLEANUP RPC WITH FENCING
-- =============================================================================

drop function if exists api.return_to_zero_reset(uuid, uuid);
drop function if exists api.return_to_zero_reset(uuid, uuid, integer, uuid);

create or replace function api.return_to_zero_reset(
  requested_actor_id uuid,
  requested_op_id uuid default null,
  requested_worker_generation integer default null,
  requested_worker_id uuid default null
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
  v_standalone boolean := false;
  v_effective_op_id uuid;
  v_effective_gen integer;
  v_effective_worker_id uuid;
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

  -- 3. Fencing validation: check maintenance_state
  select cursor_value, active_operation_id, worker_generation, active_worker_id
  into v_maint
  from public.maintenance_state
  where job_name = 'system_reset'
  for update;

  if v_maint.cursor_value in ('locked', 'in_progress') then
    if requested_op_id is null or v_maint.active_operation_id is distinct from requested_op_id then
      raise exception using errcode = '55000', message = 'fencing_token_revoked: operation mismatch';
    end if;

    if requested_worker_generation is null or v_maint.worker_generation is distinct from requested_worker_generation then
      raise exception using errcode = '55000', message = 'fencing_token_revoked: worker generation expired or revoked';
    end if;

    if requested_worker_id is not null and v_maint.active_worker_id is distinct from requested_worker_id then
      raise exception using errcode = '55000', message = 'fencing_token_revoked: worker ID revoked';
    end if;
  elsif requested_op_id is not null then
    raise exception using errcode = '55000', message = 'fencing_token_revoked: reset lock not active';
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

  -- Acquire exclusive advisory transaction lock to serialize return-to-zero operations
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('egatepass:return-to-zero-reset'));

  if requested_op_id is null then
    v_standalone := true;
    v_effective_op_id := gen_random_uuid();
    v_effective_gen := coalesce(v_maint.worker_generation, 0) + 1;
    v_effective_worker_id := gen_random_uuid();

    update public.maintenance_state
    set cursor_value = 'in_progress',
        active_operation_id = v_effective_op_id,
        worker_generation = v_effective_gen,
        active_worker_id = v_effective_worker_id,
        last_started_at = now(),
        heartbeat_at = now()
    where job_name = 'system_reset';

    insert into public.system_reset_operations (
      id, actor_id, status, step, worker_generation, worker_id, created_at, updated_at
    ) values (
      v_effective_op_id, requested_actor_id, 'database_cleanup_in_progress', 'database_cleanup_in_progress',
      v_effective_gen, v_effective_worker_id, now(), now()
    );
  else
    v_standalone := false;
    v_effective_op_id := requested_op_id;
    v_effective_gen := requested_worker_generation;
    v_effective_worker_id := requested_worker_id;

    update public.maintenance_state
    set cursor_value = 'in_progress',
        heartbeat_at = now()
    where job_name = 'system_reset';
  end if;

  -- Set session variables for reset bypass in triggers
  perform pg_catalog.set_config('egatepass.active_reset_op_id', v_effective_op_id::text, true);
  if v_effective_gen is not null then
    perform pg_catalog.set_config('egatepass.active_reset_worker_gen', v_effective_gen::text, true);
  end if;
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

  -- Step 18: Storage objects: DIRECT SQL DELETION REMOVED.
  -- Handled exclusively through Supabase Storage API.

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
      'operation_id', v_effective_op_id,
      'preserved_superadmins', v_preserved_superadmins
    )
  );

  -- Step 20: If standalone invocation, complete the operation and return maintenance_state to idle
  if v_standalone then
    update public.system_reset_operations
    set status = 'completed',
        step = 'completed',
        completed_at = now(),
        updated_at = now()
    where id = v_effective_op_id;

    update public.maintenance_state
    set cursor_value = 'idle',
        active_operation_id = null,
        active_worker_id = null,
        last_outcome = 'success',
        last_completed_at = now()
    where job_name = 'system_reset';
  end if;

  -- Step 21: Return structured response
  return jsonb_build_object(
    'success', true,
    'purged_at', now(),
    'actor_id', requested_actor_id,
    'operation_id', v_effective_op_id,
    'preserved_superadmins', v_preserved_superadmins
  );
end;
$$;

revoke all on function api.return_to_zero_reset(uuid, uuid, integer, uuid) from public, anon, authenticated;
grant execute on function api.return_to_zero_reset(uuid, uuid, integer, uuid) to service_role;

-- =============================================================================
-- 7. HARDENED LOCK RELEASE RPC WITH FENCING
-- =============================================================================

drop function if exists api.release_system_reset_lock(uuid, uuid);
drop function if exists api.release_system_reset_lock(uuid, uuid, integer, uuid);

create or replace function api.release_system_reset_lock(
  requested_actor_id uuid,
  requested_op_id uuid,
  requested_worker_generation integer default null,
  requested_worker_id uuid default null
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

  -- Fencing validation: lock on maintenance_state
  select cursor_value, active_operation_id, worker_generation, active_worker_id
  into v_maint
  from public.maintenance_state
  where job_name = 'system_reset'
  for update;

  if v_maint.cursor_value not in ('locked', 'in_progress') then
    raise exception using errcode = '55000', message = 'fencing_token_revoked: reset lock not active';
  end if;

  if v_maint.active_operation_id is distinct from requested_op_id then
    raise exception using errcode = '55000', message = 'fencing_token_revoked: cannot release another operation lock';
  end if;

  if requested_worker_generation is not null and v_maint.worker_generation is distinct from requested_worker_generation then
    raise exception using errcode = '55000', message = 'fencing_token_revoked: worker generation expired or revoked';
  end if;

  if requested_worker_id is not null and v_maint.active_worker_id is distinct from requested_worker_id then
    raise exception using errcode = '55000', message = 'fencing_token_revoked: worker ID revoked';
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
      active_operation_id = null,
      active_worker_id = null,
      last_outcome = 'success',
      last_completed_at = now()
  where job_name = 'system_reset';
end;
$$;

revoke all on function api.release_system_reset_lock(uuid, uuid, integer, uuid) from public, anon, authenticated;
grant execute on function api.release_system_reset_lock(uuid, uuid, integer, uuid) to service_role;

-- =============================================================================
-- 8. HARDENED RESET RECONCILIATION RPC WITH WORKER REVOCATION
-- =============================================================================

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
  v_maint record;
  v_op record;
  v_new_gen integer;
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

  select * into v_maint
  from public.maintenance_state
  where job_name = 'system_reset'
  for update;

  select * into v_op
  from public.system_reset_operations
  where id = requested_op_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'operation_not_found';
  end if;

  -- Always increment worker_generation to immediately fence out any in-flight worker
  v_new_gen := coalesce(v_maint.worker_generation, 0) + 1;

  if requested_action = 'resume' then
    update public.system_reset_operations
    set status = 'recovery_required',
        step = 'prepared_for_resume',
        error_details = coalesce(requested_note, error_details),
        updated_at = now()
    where id = requested_op_id;

    update public.maintenance_state
    set cursor_value = 'recovery_required',
        active_operation_id = requested_op_id,
        worker_generation = v_new_gen,
        active_worker_id = null,
        last_started_at = now()
    where job_name = 'system_reset';

    return jsonb_build_object('success', true, 'action', 'prepared_for_resume', 'operation_id', requested_op_id, 'worker_generation', v_new_gen);

  elsif requested_action in ('mark_failed', 'abort') then
    update public.system_reset_operations
    set status = 'failed',
        step = 'aborted_by_admin',
        error_details = coalesce(requested_note, 'Aborted by superadmin reconciliation'),
        updated_at = now()
    where id = requested_op_id;

    update public.maintenance_state
    set cursor_value = 'recovery_required',
        active_operation_id = requested_op_id,
        worker_generation = v_new_gen,
        active_worker_id = null,
        last_outcome = 'failure'
    where job_name = 'system_reset';

    return jsonb_build_object('success', true, 'action', 'marked_failed', 'operation_id', requested_op_id, 'worker_generation', v_new_gen);

  elsif requested_action = 'force_unlock' then
    update public.system_reset_operations
    set status = 'failed',
        step = 'force_unlocked_by_admin',
        error_details = coalesce(requested_note, 'Force unlocked by superadmin reconciliation'),
        updated_at = now()
    where id = requested_op_id;

    -- Force-unlock clears active_operation_id and active_worker_id, sets cursor to idle,
    -- and increments worker_generation so that previously active workers are fenced out.
    update public.maintenance_state
    set cursor_value = 'idle',
        active_operation_id = null,
        active_worker_id = null,
        worker_generation = v_new_gen,
        last_outcome = 'failure',
        last_completed_at = now()
    where job_name = 'system_reset';

    return jsonb_build_object('success', true, 'action', 'force_unlocked', 'operation_id', requested_op_id, 'worker_generation', v_new_gen);
  else
    raise exception using errcode = '22000', message = 'unsupported_reconciliation_action';
  end if;
end;
$$;

revoke all on function api.reconcile_system_reset_operation(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function api.reconcile_system_reset_operation(uuid, uuid, text, text) to service_role;

-- =============================================================================
-- 9. AUTHORITATIVE GET_SYSTEM_RESET_STATUS RPC
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

  select cursor_value, active_operation_id, worker_generation, active_worker_id,
         last_started_at, last_completed_at, last_outcome
  into v_maint
  from public.maintenance_state
  where job_name = 'system_reset';

  if v_maint.cursor_value in ('locked', 'in_progress', 'recovery_required') then
    if v_maint.active_operation_id is not null then
      select id, status, step, error_details, created_at, updated_at, worker_generation
      into v_op
      from public.system_reset_operations
      where id = v_maint.active_operation_id;
    end if;

    return jsonb_build_object(
      'isLocked', true,
      'status', coalesce(v_maint.cursor_value, 'idle'),
      'lastStartedAt', v_maint.last_started_at,
      'workerGeneration', v_maint.worker_generation,
      'activeOperation', case when v_op.id is not null then
        jsonb_build_object(
          'id', v_op.id,
          'status', v_op.status,
          'step', v_op.step,
          'error_details', v_op.error_details,
          'created_at', v_op.created_at,
          'updated_at', v_op.updated_at,
          'worker_generation', v_op.worker_generation
        ) else null end
    );
  else
    return jsonb_build_object(
      'isLocked', false,
      'status', coalesce(v_maint.cursor_value, 'idle'),
      'workerGeneration', v_maint.worker_generation,
      'activeOperation', null
    );
  end if;
end;
$$;

revoke all on function api.get_system_reset_status() from public, anon, authenticated;
grant execute on function api.get_system_reset_status() to service_role;
