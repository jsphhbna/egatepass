-- Migration: 20261119000500_reset_state_machine_strict_pair_closure.sql
-- Description: Enforce strict status/step pair allowlist, previous status-and-step transition order,
-- and Storage-verification phase gating in api.record_system_reset_step.
--
-- Invariants enforced:
-- 1. Strict pair allowlist: ordinary progress phases require exact matching status/step pairs:
--    ('storage_deletion_in_progress', 'storage_deletion_in_progress'),
--    ('storage_deletion_verified', 'storage_deletion_verified'),
--    ('database_cleanup_in_progress', 'database_cleanup_in_progress').
-- 2. Audited recovery and failure pairs:
--    ('recovery_required', 'storage_purge_failed'),
--    ('recovery_required', 'storage_purge_timeout'),
--    ('recovery_required', 'database_cleanup_failed'),
--    ('recovery_required', 'lock_release_failed'),
--    ('failed', 'storage_purge_failed'),
--    ('failed', 'database_cleanup_failed'),
--    ('failed', 'lock_release_failed'),
--    ('failed', 'failed').
-- 3. Transition order requires BOTH previous status and previous step to match expected phase prerequisites.
-- 4. Rejection of unknown, null, or mismatched status and step values.
-- 5. Anti-forgery protections preserved: database_cleanup_completed and completed cannot be written via record_system_reset_step.
-- 6. Executable strictly by service_role; revoked from public, anon, and authenticated.

-- =============================================================================
-- 1. HARDENED STEP RECORDING RPC: STRICT PAIR ALLOWLIST & PAIR TRANSITION GATES
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

  if requested_status is null or requested_step is null then
    raise exception using errcode = '55000', message = 'invalid_state_transition: status and step are required';
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

  -- 5. Strict allowlist of valid (status, step) pairs:
  -- Ordinary progress pairs require exact matching status and step.
  -- Recovery and failure pairs require audited failure step identifiers.
  if not (
    (requested_status = 'storage_deletion_in_progress' and requested_step = 'storage_deletion_in_progress') or
    (requested_status = 'storage_deletion_verified' and requested_step = 'storage_deletion_verified') or
    (requested_status = 'database_cleanup_in_progress' and requested_step = 'database_cleanup_in_progress') or
    (requested_status = 'recovery_required' and requested_step in ('storage_purge_failed', 'storage_purge_timeout', 'database_cleanup_failed', 'lock_release_failed')) or
    (requested_status = 'failed' and requested_step in ('storage_purge_failed', 'database_cleanup_failed', 'lock_release_failed', 'failed'))
  ) then
    raise exception using errcode = '55000', message = 'invalid_state_transition: invalid or mismatched status and step pair requested';
  end if;

  -- Extract storage verification record from parameter or manifest
  v_verification := coalesce(
    requested_verification,
    case
      when requested_manifest is not null and requested_manifest ? 'verification' then requested_manifest->'verification'
      else null
    end
  );

  -- 6. Enforce strictly valid transition sequence based on BOTH previous status AND previous step:

  -- storage_deletion_in_progress: must originate from (lock_acquired, lock_acquired/resumed) or idempotent re-recording
  if requested_status = 'storage_deletion_in_progress' then
    if not (
      (v_op.status = 'lock_acquired' and v_op.step in ('lock_acquired', 'resumed')) or
      (v_op.status = 'storage_deletion_in_progress' and v_op.step = 'storage_deletion_in_progress')
    ) then
      raise exception using errcode = '55000', message = 'invalid_state_transition: storage_deletion_in_progress requires lock_acquired state (status and step must be lock_acquired or resumed)';
    end if;

  -- storage_deletion_verified: must originate from (storage_deletion_in_progress, storage_deletion_in_progress) or idempotent re-recording
  elsif requested_status = 'storage_deletion_verified' then
    if not (
      (v_op.status = 'storage_deletion_in_progress' and v_op.step = 'storage_deletion_in_progress') or
      (v_op.status = 'storage_deletion_verified' and v_op.step = 'storage_deletion_verified')
    ) then
      raise exception using errcode = '55000', message = 'invalid_state_transition: storage_deletion_verified requires storage_deletion_in_progress state (status and step must both be storage_deletion_in_progress)';
    end if;

  -- database_cleanup_in_progress: strictly requires previous (storage_deletion_verified, storage_deletion_verified) or idempotent re-recording
  elsif requested_status = 'database_cleanup_in_progress' then
    if not (
      (v_op.status = 'storage_deletion_verified' and v_op.step = 'storage_deletion_verified') or
      (v_op.status = 'database_cleanup_in_progress' and v_op.step = 'database_cleanup_in_progress')
    ) then
      raise exception using errcode = '55000', message = 'invalid_state_transition: database_cleanup_in_progress requires storage_deletion_verified state (status and step must both be storage_deletion_verified)';
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

  -- recovery_required / failed transitions:
  elsif requested_status in ('recovery_required', 'failed') then
    if requested_step in ('storage_purge_failed', 'storage_purge_timeout') then
      if not (
        (v_op.status = 'lock_acquired' and v_op.step in ('lock_acquired', 'resumed')) or
        (v_op.status = 'storage_deletion_in_progress' and v_op.step = 'storage_deletion_in_progress')
      ) then
        raise exception using errcode = '55000', message = 'invalid_state_transition: storage failure step invalid from current state';
      end if;
    elsif requested_step = 'database_cleanup_failed' then
      if not (
        (v_op.status = 'storage_deletion_verified' and v_op.step = 'storage_deletion_verified') or
        (v_op.status = 'database_cleanup_in_progress' and v_op.step = 'database_cleanup_in_progress')
      ) then
        raise exception using errcode = '55000', message = 'invalid_state_transition: database cleanup failure step invalid from current state';
      end if;
    elsif requested_step = 'lock_release_failed' then
      if not (
        (v_op.status = 'database_cleanup_completed' and v_op.step = 'database_cleanup_completed')
      ) then
        raise exception using errcode = '55000', message = 'invalid_state_transition: lock release failure step invalid from current state';
      end if;
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
