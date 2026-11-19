-- Migration: 20261119000300_reset_fencing_atomic_renewal_closure.sql
-- Description:
-- 1. Eliminate standalone database-only reset execution path completely from api.return_to_zero_reset.
-- 2. Require non-null, valid operation UUID, worker generation, and worker UUID for all reset RPCs.
-- 3. Make lease renewal atomic in api.assert_system_reset_worker_active via single conditional UPDATE RETURNING against lease_expires_at.
-- 4. Disallow expired workers from resurrecting leases and ensure recovery acquisition advances generation atomically.
-- 5. Enforce strict fencing in api.record_system_reset_step, rejecting completion attempts and preserving existing manifests/counts/errors.
-- 6. Enforce strict fencing in api.release_system_reset_lock, requiring exact worker tokens and verified database cleanup completion.
-- 7. Preserve write-freeze trigger transaction-local bypass only for authorized, fenced workers on active operations.
-- 8. Document unavoidable external storage timeout limitations and bound safety windows.

-- =============================================================================
-- 0. ENSURE SCHEMA ATTRIBUTES EXIST
-- =============================================================================

alter table public.maintenance_state
  add column if not exists lease_expires_at timestamptz;

alter table public.system_reset_operations
  drop constraint if exists system_reset_operations_status_check;

alter table public.system_reset_operations
  add constraint system_reset_operations_status_check check (status in (
    'requested',
    'lock_acquired',
    'storage_inventory_recorded',
    'storage_deletion_in_progress',
    'storage_deletion_verified',
    'database_cleanup_in_progress',
    'database_cleanup_completed',
    'completed',
    'failed',
    'recovery_required'
  ));

-- =============================================================================
-- 1. WRITE-FREEZE GUARD: STRICT FENCING CHECK ON TRANSACTION-LOCAL BYPASS
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
  v_active_worker uuid;
  v_sess_op text;
  v_sess_gen text;
  v_sess_worker text;
  v_in_reset text;
begin
  v_sess_op := pg_catalog.current_setting('egatepass.active_reset_op_id', true);
  v_sess_gen := pg_catalog.current_setting('egatepass.active_reset_worker_gen', true);
  v_sess_worker := pg_catalog.current_setting('egatepass.active_reset_worker_id', true);
  v_in_reset := pg_catalog.current_setting('egatepass.in_system_reset', true);

  -- 1. Check if the current session is an authorized active return_to_zero worker.
  -- Only permits bypass when transaction-local session settings match authoritative maintenance_state.
  if v_sess_op is not null and v_sess_op <> '' then
    select cursor_value, active_operation_id, worker_generation, active_worker_id
    into v_state, v_active_op, v_worker_gen, v_active_worker
    from public.maintenance_state
    where job_name = 'system_reset';

    if v_state in ('locked', 'in_progress')
       and v_active_op is not null
       and v_active_op::text = v_sess_op
       and (v_sess_gen is not null and v_sess_gen <> '' and v_worker_gen::text = v_sess_gen)
       and (v_sess_worker is not null and v_sess_worker <> '' and v_active_worker::text = v_sess_worker)
       and (v_in_reset = 'true')
    then
      return new;
    end if;
  end if;

  -- 2. Concurrency-safe write guard with transactional lock semantics:
  -- Acquire tuple-level SHARE lock on the system_reset maintenance row.
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

-- =============================================================================
-- 2. HARDENED LOCK ACQUISITION & RESUME RPC WITH AUTHORITATIVE LEASE EXPIRY
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

    -- 4. Prevent competing workers:
    -- If lock is active ('locked', 'in_progress', 'recovery_required') and lease has NOT expired yet according to DB clock,
    -- another worker is currently actively executing within its valid lease window.
    if v_maint.cursor_value in ('locked', 'in_progress', 'recovery_required')
       and v_maint.lease_expires_at is not null
       and v_maint.lease_expires_at >= clock_timestamp()
    then
      return jsonb_build_object(
        'acquired', false,
        'reason', 'reset_already_in_progress',
        'operation_id', v_maint.active_operation_id,
        'status', v_maint.cursor_value
      );
    end if;

    -- 5. Reject if active_operation_id is set to a different operation or is null
    if v_maint.active_operation_id is distinct from requested_resume_op_id then
      return jsonb_build_object(
        'acquired', false,
        'reason', 'operation_not_active_or_eligible',
        'operation_id', v_maint.active_operation_id
      );
    end if;

    -- 6. Operation must be eligible for recovery (locked/in_progress with expired lease, or recovery_required)
    if v_maint.cursor_value not in ('locked', 'in_progress', 'recovery_required') then
      return jsonb_build_object(
        'acquired', false,
        'reason', 'operation_not_eligible_for_recovery',
        'operation_id', requested_resume_op_id,
        'status', v_op.status
      );
    end if;

    -- Advance worker generation and allocate new worker ID atomically
    v_new_gen := coalesce(v_maint.worker_generation, 0) + 1;
    v_new_worker_id := gen_random_uuid();

    update public.maintenance_state
    set cursor_value = 'locked',
        active_operation_id = requested_resume_op_id,
        worker_generation = v_new_gen,
        active_worker_id = v_new_worker_id,
        last_started_at = clock_timestamp(),
        heartbeat_at = clock_timestamp(),
        lease_expires_at = clock_timestamp() + interval '60 seconds',
        last_outcome = null
    where job_name = 'system_reset';

    update public.system_reset_operations
    set status = 'lock_acquired',
        step = 'resumed',
        worker_generation = v_new_gen,
        worker_id = v_new_worker_id,
        updated_at = clock_timestamp()
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

  -- Authoritatively set active_operation_id and lease_expires_at on maintenance_state
  update public.maintenance_state
  set cursor_value = 'locked',
      active_operation_id = v_op_id,
      worker_generation = v_new_gen,
      active_worker_id = v_new_worker_id,
      last_started_at = clock_timestamp(),
      heartbeat_at = clock_timestamp(),
      lease_expires_at = clock_timestamp() + interval '60 seconds',
      last_outcome = null
  where job_name = 'system_reset';

  insert into public.system_reset_operations (
    id, actor_id, status, step, worker_generation, worker_id, created_at, updated_at
  ) values (
    v_op_id, requested_actor_id, 'lock_acquired', 'lock_acquired', v_new_gen, v_new_worker_id, clock_timestamp(), clock_timestamp()
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
-- 3. WORKER ACTIVE HEARTBEAT & LEASE RENEWAL (ATOMIC CONDITIONAL UPDATE)
-- =============================================================================

drop function if exists api.assert_system_reset_worker_active(uuid);
drop function if exists api.assert_system_reset_worker_active(uuid, integer);
drop function if exists api.assert_system_reset_worker_active(uuid, integer, uuid);

create or replace function api.assert_system_reset_worker_active(
  requested_op_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'service role required';
  end if;
  raise exception using errcode = '55000', message = 'fencing_token_revoked: worker generation required';
end;
$$;

create or replace function api.assert_system_reset_worker_active(
  requested_op_id uuid,
  requested_worker_generation integer
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'service role required';
  end if;
  raise exception using errcode = '55000', message = 'fencing_token_revoked: worker ID required';
end;
$$;

create or replace function api.assert_system_reset_worker_active(
  requested_op_id uuid,
  requested_worker_generation integer,
  requested_worker_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_active_op uuid;
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

  -- Single atomic conditional update:
  -- Enforces operation ID, worker generation, worker ID, active cursor status,
  -- and that current lease has NOT expired yet according to DB clock (clock_timestamp()).
  -- If any condition does not match or lease has already expired, no row is updated.
  update public.maintenance_state
  set heartbeat_at = clock_timestamp(),
      lease_expires_at = clock_timestamp() + interval '60 seconds'
  where job_name = 'system_reset'
    and cursor_value in ('locked', 'in_progress')
    and active_operation_id = requested_op_id
    and worker_generation = requested_worker_generation
    and active_worker_id = requested_worker_id
    and lease_expires_at is not null
    and lease_expires_at >= clock_timestamp()
  returning active_operation_id into v_active_op;

  if v_active_op is null then
    raise exception using errcode = '55000', message = 'fencing_token_revoked: worker lease expired or revoked';
  end if;

  return true;
end;
$$;

revoke all on function api.assert_system_reset_worker_active(uuid) from public, anon, authenticated;
grant execute on function api.assert_system_reset_worker_active(uuid) to service_role;

revoke all on function api.assert_system_reset_worker_active(uuid, integer) from public, anon, authenticated;
grant execute on function api.assert_system_reset_worker_active(uuid, integer) to service_role;

revoke all on function api.assert_system_reset_worker_active(uuid, integer, uuid) from public, anon, authenticated;
grant execute on function api.assert_system_reset_worker_active(uuid, integer, uuid) to service_role;

-- =============================================================================
-- 4. HARDENED STEP RECORDING RPC WITH STRICT FENCING
-- =============================================================================

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
  v_op record;
  v_updated_rows integer;
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

  -- Disallow marking completed via record_system_reset_step.
  -- Only release_system_reset_lock may mark completed and clear the lock.
  if requested_status = 'completed' or requested_step = 'completed' then
    raise exception using errcode = '55000', message = 'invalid_state_transition: operation completion must be performed via release_system_reset_lock';
  end if;

  -- Lock and validate authoritative maintenance_state row
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

  if v_maint.lease_expires_at is not null and v_maint.lease_expires_at < clock_timestamp() then
    raise exception using errcode = '55000', message = 'fencing_token_revoked: worker lease expired';
  end if;

  -- Lock and validate operation record before changing state
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

  if v_op.status in ('completed', 'failed', 'recovery_required') then
    raise exception using errcode = '55000', message = 'fencing_token_revoked: operation not in eligible state';
  end if;

  -- Update system_reset_operations matching operation ID and worker tokens
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
      error_details = coalesce(requested_error, error_details),
      updated_at = clock_timestamp()
  where id = requested_op_id
    and worker_generation = requested_worker_generation
    and worker_id = requested_worker_id;

  get diagnostics v_updated_rows = row_count;
  if v_updated_rows = 0 then
    raise exception using errcode = '55000', message = 'fencing_token_revoked: operation record worker token mismatch';
  end if;

  -- Transition maintenance state
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

revoke all on function api.record_system_reset_step(uuid, text, text, jsonb, jsonb, text, integer, uuid) from public, anon, authenticated;
grant execute on function api.record_system_reset_step(uuid, text, text, jsonb, jsonb, text, integer, uuid) to service_role;

-- =============================================================================
-- 5. HARDENED DATABASE CLEANUP RPC: ZERO STANDALONE EXECUTION PATH
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

  if v_maint.lease_expires_at is not null and v_maint.lease_expires_at < clock_timestamp() then
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
-- 6. HARDENED LOCK RELEASE RPC WITH MANDATORY FENCING PARAMETERS
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

  if v_maint.lease_expires_at is not null and v_maint.lease_expires_at < clock_timestamp() then
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

  -- Require that database cleanup has actually completed successfully
  if v_op.step <> 'database_cleanup_completed' and v_op.status <> 'database_cleanup_completed' then
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

-- =============================================================================
-- 7. RESET RECONCILIATION RPC: CLEARS LEASE AND FENCES WORKERS
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
        updated_at = clock_timestamp()
    where id = requested_op_id;

    update public.maintenance_state
    set cursor_value = 'recovery_required',
        active_operation_id = requested_op_id,
        worker_generation = v_new_gen,
        active_worker_id = null,
        lease_expires_at = null,
        last_started_at = clock_timestamp()
    where job_name = 'system_reset';

    return jsonb_build_object('success', true, 'action', 'prepared_for_resume', 'operation_id', requested_op_id, 'worker_generation', v_new_gen);

  elsif requested_action in ('mark_failed', 'abort') then
    update public.system_reset_operations
    set status = 'failed',
        step = 'aborted_by_admin',
        error_details = coalesce(requested_note, 'Aborted by superadmin reconciliation'),
        updated_at = clock_timestamp()
    where id = requested_op_id;

    update public.maintenance_state
    set cursor_value = 'recovery_required',
        active_operation_id = requested_op_id,
        worker_generation = v_new_gen,
        active_worker_id = null,
        lease_expires_at = null,
        last_outcome = 'failure'
    where job_name = 'system_reset';

    return jsonb_build_object('success', true, 'action', 'marked_failed', 'operation_id', requested_op_id, 'worker_generation', v_new_gen);

  elsif requested_action = 'force_unlock' then
    update public.system_reset_operations
    set status = 'failed',
        step = 'force_unlocked_by_admin',
        error_details = coalesce(requested_note, 'Force unlocked by superadmin reconciliation'),
        updated_at = clock_timestamp()
    where id = requested_op_id;

    -- Force-unlock clears active_operation_id, active_worker_id, and lease_expires_at, sets cursor to idle,
    -- and increments worker_generation so that previously active workers are fenced out.
    update public.maintenance_state
    set cursor_value = 'idle',
        active_operation_id = null,
        active_worker_id = null,
        worker_generation = v_new_gen,
        lease_expires_at = null,
        last_outcome = 'failure',
        last_completed_at = clock_timestamp()
    where job_name = 'system_reset';

    return jsonb_build_object('success', true, 'action', 'force_unlocked', 'operation_id', requested_op_id, 'worker_generation', v_new_gen);
  else
    raise exception using errcode = '22000', message = 'unsupported_reconciliation_action';
  end if;
end;
$$;

revoke all on function api.reconcile_system_reset_operation(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function api.reconcile_system_reset_operation(uuid, uuid, text, text) to service_role;
