-- =============================================================================
-- Migration: 20261116000100_aal2_rpc_bypass_and_outbox_reconciliation_hotfix.sql
-- Description: 
--   1. Harden private.current_staff_role() and private.has_staff_role() to fail-closed
--      (else false) when JWT AAL claim is missing, NULL, or malformed.
--   2. Enforce mandatory fail-closed AAL2 checks in direct SECURITY DEFINER RPCs:
--      - api.guard_recover_pass_action
--      - api.guard_search_pending_queue (allowing service_role; requiring aal2 for human staff)
--      - api.guard_sync_offline_event
--   3. Correct api.claim_office_visit_acknowledgement_for_delivery so expired 24h
--      idempotency window updates row to reconciliation_required and commits without rollback.
-- =============================================================================

-- 1. Update private.current_staff_role() to fail-closed when AAL claim is missing or not aal2
create or replace function private.current_staff_role()
returns public.staff_role
language sql
stable
security definer
set search_path = ''
as $$
  select sp.role
  from public.staff_profiles sp
  join auth.users u on u.id = sp.user_id
  where sp.user_id = (select auth.uid())
    and sp.active = true
    and u.email_confirmed_at is not null
    and sp.must_change_password = false
    and sp.privacy_accepted_at is not null
    and not (select private.is_recovery_session())
    and (
      case
        when (select auth.jwt()) ? 'aal'
          then (select auth.jwt() ->> 'aal') = 'aal2'
        when (select private.jwt_claims()) ? 'aal'
          then (select private.jwt_claims() ->> 'aal') = 'aal2'
        else false
      end
    )
  limit 1
$$;

revoke all on function private.current_staff_role() from public, anon;
grant execute on function private.current_staff_role() to authenticated;

comment on function private.current_staff_role() is
  'Resolves active human staff role only when email is verified, password change completed, privacy accepted, and session assurance level is strictly aal2 (fail-closed).';

-- 2. Update private.has_staff_role() to fail-closed when AAL claim is missing or not aal2
create or replace function private.has_staff_role(allowed public.staff_role[])
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select private.current_staff_role()) = any(allowed)
    and (
      case
        when (select auth.jwt()) ? 'aal'
          then (select auth.jwt() ->> 'aal') = 'aal2'
        when (select private.jwt_claims()) ? 'aal'
          then (select private.jwt_claims() ->> 'aal') = 'aal2'
        else false
      end
    ),
    false
  )
$$;

revoke all on function private.has_staff_role(public.staff_role[]) from public, anon;
grant execute on function private.has_staff_role(public.staff_role[]) to authenticated;

comment on function private.has_staff_role(public.staff_role[]) is
  'Guards operational RLS policies and RPCs: returns true only if authenticated actor has an allowed staff role with strictly verified aal2 claim (fail-closed).';

-- 3. Update api.guard_recover_pass_action with mandatory fail-closed AAL2 enforcement
create or replace function api.guard_recover_pass_action(
  requested_pass_id uuid,
  requested_action text,
  requested_reason text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor public.staff_profiles%rowtype;
  target public.passes%rowtype;
  next_status public.pass_status;
  clean_reason text := btrim(coalesce(requested_reason, ''));
begin
  if (select private.is_recovery_session()) then
    raise exception using errcode = '42501', message = 'recovery_session_forbidden';
  end if;

  select * into actor from public.staff_profiles
  where user_id = (select auth.uid()) and active and not must_change_password
    and privacy_accepted_at is not null for share;
  if not found or actor.role not in ('admin'::public.staff_role, 'superadmin'::public.staff_role) then
    raise exception using errcode = '42501', message = 'administrator required';
  end if;

  if not (
    case
      when (select auth.jwt()) ? 'aal'
        then (select auth.jwt() ->> 'aal') = 'aal2'
      when (select private.jwt_claims()) ? 'aal'
        then (select private.jwt_claims() ->> 'aal') = 'aal2'
      else false
    end
  ) then
    raise exception using errcode = '42501', message = 'mfa_required';
  end if;

  if requested_action not in ('approve_entry', 'reject_entry', 'record_exit') then
    raise exception using errcode = '22023', message = 'invalid recovery action';
  end if;

  select * into target from public.passes where id = requested_pass_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'pass not found';
  end if;

  if requested_action = 'approve_entry' then
    if target.status not in ('issued'::public.pass_status, 'pending'::public.pass_status) then
      raise exception using errcode = '40001', message = 'pass is not eligible for entry approval';
    end if;
    next_status := 'inside'::public.pass_status;

    update public.passes set
      status = next_status,
      time_in = coalesce(time_in, statement_timestamp()),
      entry_scanned_at = coalesce(entry_scanned_at, statement_timestamp()),
      decided_at = statement_timestamp(),
      decided_by = actor.user_id,
      gate = coalesce(gate, 'Recovery Gate'),
      updated_at = statement_timestamp(),
      version = version + 1
    where id = target.id;

    insert into public.visit_events (
      pass_id, visitor_id, event, reason, gate, guard_id, request_id
    ) values (
      target.id, target.visitor_id, 'approved'::public.visit_event_type,
      case when clean_reason <> '' then clean_reason else 'visitor_recovery' end,
      coalesce(target.gate, 'Recovery Gate'), actor.user_id, gen_random_uuid()
    );

    insert into public.audit_events (
      actor_id, actor_kind, actor_role, action, target_type, target_id, outcome, after_state
    ) values (
      actor.user_id, 'staff', actor.role, 'gate.visitor_recovery_approve', 'passes', target.id, 'success',
      jsonb_build_object('source', 'visitor_recovery', 'status', 'inside')
    );

  elsif requested_action = 'reject_entry' then
    if target.status not in ('issued'::public.pass_status, 'pending'::public.pass_status) then
      raise exception using errcode = '40001', message = 'pass is not eligible for rejection';
    end if;
    if clean_reason = '' then
      clean_reason := 'Rejected by Guard during visitor recovery';
    end if;
    next_status := 'rejected'::public.pass_status;

    update public.passes set
      status = next_status,
      decided_at = statement_timestamp(),
      decided_by = actor.user_id,
      rejection_reason = clean_reason,
      updated_at = statement_timestamp(),
      version = version + 1
    where id = target.id;

    insert into public.visit_events (
      pass_id, visitor_id, event, reason, gate, guard_id, request_id
    ) values (
      target.id, target.visitor_id, 'rejected'::public.visit_event_type,
      clean_reason, coalesce(target.gate, 'Recovery Gate'), actor.user_id, gen_random_uuid()
    );

    insert into public.audit_events (
      actor_id, actor_kind, actor_role, action, target_type, target_id, outcome, after_state
    ) values (
      actor.user_id, 'staff', actor.role, 'gate.visitor_recovery_reject', 'passes', target.id, 'success',
      jsonb_build_object('source', 'visitor_recovery', 'status', 'rejected', 'reason', clean_reason)
    );

  elsif requested_action = 'record_exit' then
    if target.status <> 'inside'::public.pass_status then
      raise exception using errcode = '40001', message = 'pass is not recorded as inside';
    end if;
    next_status := 'exited'::public.pass_status;

    update public.passes set
      status = next_status,
      time_out = statement_timestamp(),
      updated_at = statement_timestamp(),
      version = version + 1
    where id = target.id;

    insert into public.visit_events (
      pass_id, visitor_id, event, reason, gate, guard_id, request_id
    ) values (
      target.id, target.visitor_id, 'scan_exit'::public.visit_event_type,
      case when clean_reason <> '' then clean_reason else 'visitor_recovery_exit' end,
      coalesce(target.gate, 'Recovery Gate'), actor.user_id, gen_random_uuid()
    );

    insert into public.audit_events (
      actor_id, actor_kind, actor_role, action, target_type, target_id, outcome, after_state
    ) values (
      actor.user_id, 'staff', actor.role, 'gate.visitor_recovery_exit', 'passes', target.id, 'success',
      jsonb_build_object('source', 'visitor_recovery', 'status', 'exited')
    );
  end if;

  return jsonb_build_object('success', true, 'passId', target.id, 'status', next_status);
end;
$$;

revoke all on function api.guard_recover_pass_action(uuid, text, text) from public, anon;
grant execute on function api.guard_recover_pass_action(uuid, text, text) to authenticated;

comment on function api.guard_recover_pass_action(uuid, text, text) is
  'Enables gate personnel to recover, reprint, or re-verify passes for visitors under administrator authority with mandatory fail-closed AAL2 enforcement.';

-- 4. Update api.guard_search_pending_queue with mandatory fail-closed AAL2 enforcement for staff
create or replace function api.guard_search_pending_queue(
  requested_query text,
  requested_limit integer default 50
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := auth.uid();
  caller_role public.staff_role;
  v_clean_query text := btrim(coalesce(requested_query, ''));
  v_limit integer := coalesce(requested_limit, 50);
  results jsonb;
begin
  -- Service role bypasses human staff MFA checks; all other callers must be verified AAL2 human staff
  if coalesce((select auth.role()), '') <> 'service_role' then
    if (select private.is_recovery_session()) then
      raise exception using errcode = '42501', message = 'recovery_session_forbidden';
    end if;

    select role into caller_role
    from public.staff_profiles
    where user_id = v_actor_id
      and active = true
      and must_change_password = false
      and privacy_accepted_at is not null;

    if caller_role is null or caller_role not in (
      'admin'::public.staff_role,
      'superadmin'::public.staff_role
    ) then
      raise exception using errcode = '42501', message = 'administrator required';
    end if;

    if not (
      case
        when (select auth.jwt()) ? 'aal'
          then (select auth.jwt() ->> 'aal') = 'aal2'
        when (select private.jwt_claims()) ? 'aal'
          then (select private.jwt_claims() ->> 'aal') = 'aal2'
        else false
      end
    ) then
      raise exception using errcode = '42501', message = 'mfa_required';
    end if;
  end if;

  if length(v_clean_query) < 2 or length(v_clean_query) > 100 then
    raise exception using errcode = '22023', message = 'search query must be between 2 and 100 characters';
  end if;

  if v_limit < 1 or v_limit > 100 then
    raise exception using errcode = '22023', message = 'limit must be between 1 and 100';
  end if;

  update public.passes
  set
    status = 'expired'::public.pass_status,
    updated_at = statement_timestamp(),
    version = version + 1
  where status in ('issued'::public.pass_status, 'pending'::public.pass_status)
    and valid_until <= statement_timestamp();

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', q.id,
        'visitorName', q.full_name,
        'purpose', q.purpose,
        'source', q.source,
        'status', q.status,
        'validFrom', q.valid_from,
        'validUntil', q.valid_until,
        'scannedAt', q.entry_scanned_at,
        'gate', q.gate,
        'publicReference', q.public_reference,
        'contactNumber', q.contact_number,
        'photoEvidenceId', (
          select ve.id
          from public.visitor_evidence ve
          where ve.visitor_id = q.visitor_id
            and ve.kind = 'photo'::public.evidence_kind
            and ve.purged_at is null
        ),
        'idEvidenceId', (
          select ve.id
          from public.visitor_evidence ve
          where ve.visitor_id = q.visitor_id
            and ve.kind = 'id'::public.evidence_kind
            and ve.purged_at is null
        )
      )
      order by q.entry_scanned_at asc nulls last, q.id asc
    ),
    '[]'::jsonb
  ) into results
  from (
    select
      p.id,
      p.visitor_id,
      p.source,
      p.status,
      p.valid_from,
      p.valid_until,
      p.entry_scanned_at,
      p.gate,
      p.public_reference,
      v.full_name,
      v.purpose,
      v.contact_number
    from public.passes p
    join public.visitors v on v.id = p.visitor_id
    where p.status = 'pending'::public.pass_status
      and (
        v.full_name ilike '%' || v_clean_query || '%'
        or v.contact_number ilike '%' || v_clean_query || '%'
        or v.purpose ilike '%' || v_clean_query || '%'
        or p.public_reference::text ilike '%' || v_clean_query || '%'
      )
    order by p.entry_scanned_at asc nulls last, p.id asc
    limit v_limit
  ) q;

  return results;
end;
$$;

revoke all on function api.guard_search_pending_queue(text, integer) from public, anon;
grant execute on function api.guard_search_pending_queue(text, integer) to authenticated, service_role;

comment on function api.guard_search_pending_queue(text, integer) is
  'Enables real-time search across pending visitor registrations for gate guards under administrator authority with mandatory fail-closed AAL2 enforcement, and automated backend search workers.';

-- 5. Update api.guard_sync_offline_event with mandatory fail-closed AAL2 enforcement
create or replace function api.guard_sync_offline_event(
  requested_event_id uuid,
  requested_pass_id uuid,
  requested_action text,
  requested_expected_status text,
  requested_expected_version integer,
  requested_occurred_at timestamptz,
  requested_reason text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor public.staff_profiles%rowtype;
  existing_receipt public.offline_sync_receipts%rowtype;
  target public.passes%rowtype;
  actual_pass_id uuid := requested_pass_id;
  new_event_id uuid := gen_random_uuid();
  pass_status_val public.pass_status;
begin
  if (select private.is_recovery_session()) then
    raise exception using errcode = '42501', message = 'recovery_session_forbidden';
  end if;

  select * into actor from public.staff_profiles
  where user_id = (select auth.uid()) and active and not must_change_password
    and privacy_accepted_at is not null for share;
  if not found or actor.role not in ('admin'::public.staff_role, 'superadmin'::public.staff_role) then
    raise exception using errcode = '42501', message = 'administrator required';
  end if;

  if not (
    case
      when (select auth.jwt()) ? 'aal'
        then (select auth.jwt() ->> 'aal') = 'aal2'
      when (select private.jwt_claims()) ? 'aal'
        then (select private.jwt_claims() ->> 'aal') = 'aal2'
      else false
    end
  ) then
    raise exception using errcode = '42501', message = 'mfa_required';
  end if;

  -- 1. Idempotency Check: if eventId was already submitted, return the original receipt
  select * into existing_receipt from public.offline_sync_receipts
  where event_id = requested_event_id;
  if found then
    return jsonb_build_object(
      'status', existing_receipt.status,
      'duplicate', true,
      'eventId', existing_receipt.event_id,
      'result', existing_receipt.result
    );
  end if;

  -- 2. Timestamp sanity check
  if requested_occurred_at > statement_timestamp() + interval '5 minutes'
     or requested_occurred_at < statement_timestamp() - interval '7 days' then
    insert into public.offline_sync_receipts (
      event_id, pass_id, action, status, client_occurred_at, actor_id, conflict_reason, payload
    ) values (
      requested_event_id, requested_pass_id, requested_action, 'conflict', requested_occurred_at, actor.user_id,
      'suspicious_client_timestamp: occurred_at out of credible range',
      jsonb_build_object('expectedStatus', requested_expected_status, 'reason', requested_reason)
    );

    insert into public.reconciliation_tasks (
      operation, reference_type, reference_id, safe_context, last_error_code
    ) values (
      'offline_sync_timestamp_skew', 'pass', requested_pass_id::text,
      jsonb_build_object('eventId', requested_event_id, 'passId', requested_pass_id, 'occurredAt', requested_occurred_at),
      'suspicious_client_timestamp'
    );

    return jsonb_build_object(
      'status', 'conflict',
      'reason', 'suspicious_client_timestamp',
      'eventId', requested_event_id
    );
  end if;

  -- 3. Row-lock target pass; also resolve via offline_registration_id if offline created
  select * into target from public.passes where id = actual_pass_id for update;
  if not found then
    select * into target from public.passes where offline_registration_id = actual_pass_id for update;
    if found then
      actual_pass_id := target.id;
    else
      insert into public.offline_sync_receipts (
        event_id, pass_id, action, status, client_occurred_at, actor_id, conflict_reason, payload
      ) values (
        requested_event_id, requested_pass_id, requested_action, 'conflict', requested_occurred_at, actor.user_id,
        'pass_not_found', jsonb_build_object('expectedStatus', requested_expected_status)
      );

      insert into public.reconciliation_tasks (
        operation, reference_type, reference_id, safe_context, last_error_code
      ) values (
        'offline_sync_pass_not_found', 'pass', requested_pass_id::text,
        jsonb_build_object('eventId', requested_event_id, 'passId', requested_pass_id),
        'pass_not_found'
      );

      return jsonb_build_object('status', 'conflict', 'reason', 'pass_not_found', 'eventId', requested_event_id);
    end if;
  end if;

  -- 4. Mandatory Expected Version Fencing
  if requested_expected_version is null then
    insert into public.offline_sync_receipts (
      event_id, pass_id, action, status, client_occurred_at, actor_id, conflict_reason, payload
    ) values (
      requested_event_id, target.id, requested_action, 'conflict', requested_occurred_at, actor.user_id,
      'expected_version_required',
      jsonb_build_object('serverVersion', target.version, 'expectedStatus', requested_expected_status)
    );

    insert into public.reconciliation_tasks (
      operation, reference_type, reference_id, safe_context, last_error_code
    ) values (
      'offline_sync_version_missing', 'pass', target.id::text,
      jsonb_build_object('eventId', requested_event_id, 'passId', target.id, 'serverVersion', target.version),
      'expected_version_required'
    );

    return jsonb_build_object(
      'status', 'conflict',
      'reason', 'expected_version_required',
      'eventId', requested_event_id
    );
  end if;

  if target.version <> requested_expected_version then
    insert into public.offline_sync_receipts (
      event_id, pass_id, action, status, client_occurred_at, actor_id, conflict_reason, payload
    ) values (
      requested_event_id, target.id, requested_action, 'conflict', requested_occurred_at, actor.user_id,
      'version_conflict: expected v' || requested_expected_version || ' but server is v' || target.version,
      jsonb_build_object(
        'expectedVersion', requested_expected_version,
        'serverVersion', target.version,
        'expectedStatus', requested_expected_status
      )
    );

    insert into public.reconciliation_tasks (
      operation, reference_type, reference_id, safe_context, last_error_code
    ) values (
      'offline_sync_version_conflict', 'pass', target.id::text,
      jsonb_build_object(
        'eventId', requested_event_id, 'passId', target.id,
        'expectedVersion', requested_expected_version, 'serverVersion', target.version
      ),
      'version_conflict'
    );

    return jsonb_build_object(
      'status', 'conflict',
      'reason', 'version_conflict',
      'eventId', requested_event_id
    );
  end if;

  -- 5. Status Transition Legitimacy Check
  if requested_action in ('approve_entry', 'reject_entry') then
    if target.status not in ('issued'::public.pass_status, 'pending'::public.pass_status) then
      insert into public.offline_sync_receipts (
        event_id, pass_id, action, status, client_occurred_at, actor_id, conflict_reason, payload
      ) values (
        requested_event_id, target.id, requested_action, 'conflict', requested_occurred_at, actor.user_id,
        'illegal_transition: ' || requested_action || ' only permitted from issued/pending, current is ' || target.status::text,
        jsonb_build_object('expectedStatus', requested_expected_status, 'serverStatus', target.status::text)
      );

      insert into public.reconciliation_tasks (
        operation, reference_type, reference_id, safe_context, last_error_code
      ) values (
        'offline_sync_status_conflict', 'pass', target.id::text,
        jsonb_build_object(
          'eventId', requested_event_id,
          'action', requested_action,
          'serverStatus', target.status::text
        ),
        'illegal_status_transition'
      );

      return jsonb_build_object(
        'status', 'conflict',
        'reason', 'illegal_status_transition',
        'serverStatus', target.status::text,
        'eventId', requested_event_id
      );
    end if;

  elsif requested_action = 'record_exit' then
    if target.status <> 'inside'::public.pass_status then
      insert into public.offline_sync_receipts (
        event_id, pass_id, action, status, client_occurred_at, actor_id, conflict_reason, payload
      ) values (
        requested_event_id, target.id, requested_action, 'conflict', requested_occurred_at, actor.user_id,
        'illegal_transition: record_exit only permitted from inside, current is ' || target.status::text,
        jsonb_build_object('expectedStatus', requested_expected_status, 'serverStatus', target.status::text)
      );

      insert into public.reconciliation_tasks (
        operation, reference_type, reference_id, safe_context, last_error_code
      ) values (
        'offline_sync_status_conflict', 'pass', target.id::text,
        jsonb_build_object(
          'eventId', requested_event_id,
          'action', requested_action,
          'serverStatus', target.status::text
        ),
        'illegal_status_transition'
      );

      return jsonb_build_object(
        'status', 'conflict',
        'reason', 'illegal_status_transition',
        'serverStatus', target.status::text,
        'eventId', requested_event_id
      );
    end if;

    if target.time_in is not null and requested_occurred_at < target.time_in then
      insert into public.offline_sync_receipts (
        event_id, pass_id, action, status, client_occurred_at, actor_id, conflict_reason, payload
      ) values (
        requested_event_id, target.id, requested_action, 'conflict', requested_occurred_at, actor.user_id,
        'impossible_sequencing: time_out earlier than time_in',
        jsonb_build_object('timeIn', target.time_in, 'timeOut', requested_occurred_at)
      );

      insert into public.reconciliation_tasks (
        operation, reference_type, reference_id, safe_context, last_error_code
      ) values (
        'offline_sync_timestamp_skew', 'pass', target.id::text,
        jsonb_build_object('eventId', requested_event_id, 'timeIn', target.time_in, 'timeOut', requested_occurred_at),
        'time_out_before_time_in'
      );

      return jsonb_build_object(
        'status', 'conflict',
        'reason', 'time_out_before_time_in',
        'eventId', requested_event_id
      );
    end if;

  else
    raise exception using errcode = '22023', message = 'invalid action';
  end if;

  if target.status::text <> requested_expected_status then
    insert into public.offline_sync_receipts (
      event_id, pass_id, action, status, client_occurred_at, actor_id, conflict_reason, payload
    ) values (
      requested_event_id, target.id, requested_action, 'conflict', requested_occurred_at, actor.user_id,
      'status_mismatch: expected ' || requested_expected_status || ' but found ' || target.status::text,
      jsonb_build_object('expectedStatus', requested_expected_status, 'serverStatus', target.status::text)
    );

    insert into public.reconciliation_tasks (
      operation, reference_type, reference_id, safe_context, last_error_code
    ) values (
      'offline_sync_status_conflict', 'pass', target.id::text,
      jsonb_build_object(
        'eventId', requested_event_id,
        'passId', target.id,
        'expectedStatus', requested_expected_status,
        'serverStatus', target.status::text
      ),
      'status_mismatch'
    );

    return jsonb_build_object(
      'status', 'conflict',
      'reason', 'status_mismatch',
      'serverStatus', target.status::text,
      'eventId', requested_event_id
    );
  end if;

  -- 7. Apply state transition with truthful occurrence timestamp
  if requested_action = 'approve_entry' then
    pass_status_val := 'inside'::public.pass_status;
    update public.passes set
      status = pass_status_val,
      version = target.version + 1,
      time_in = coalesce(target.time_in, requested_occurred_at),
      gate = coalesce(target.gate, 'Offline Gate'),
      updated_at = statement_timestamp(),
      offline_synced_at = statement_timestamp()
    where id = target.id;

    insert into public.visit_events (
      pass_id, visitor_id, event, reason, gate, guard_id, occurred_at, request_id, details
    ) values (
      target.id, target.visitor_id, 'approved'::public.visit_event_type,
      'guard_offline_sync', coalesce(target.gate, 'Offline Gate'), actor.user_id, requested_occurred_at, requested_event_id,
      jsonb_build_object('offline_synced_at', statement_timestamp())
    );

  elsif requested_action = 'reject_entry' then
    pass_status_val := 'rejected'::public.pass_status;
    update public.passes set
      status = pass_status_val,
      version = target.version + 1,
      decided_at = requested_occurred_at,
      decided_by = actor.user_id,
      rejection_reason = coalesce(requested_reason, 'Rejected offline by guard'),
      updated_at = statement_timestamp(),
      offline_synced_at = statement_timestamp()
    where id = target.id;

    insert into public.visit_events (
      pass_id, visitor_id, event, reason, gate, guard_id, occurred_at, request_id, details
    ) values (
      target.id, target.visitor_id, 'rejected'::public.visit_event_type,
      coalesce(requested_reason, 'guard_offline_sync'), coalesce(target.gate, 'Offline Gate'), actor.user_id,
      requested_occurred_at, requested_event_id,
      jsonb_build_object('offline_synced_at', statement_timestamp())
    );

  elsif requested_action = 'record_exit' then
    pass_status_val := 'exited'::public.pass_status;
    update public.passes set
      status = pass_status_val,
      version = target.version + 1,
      time_out = requested_occurred_at,
      updated_at = statement_timestamp(),
      offline_synced_at = statement_timestamp()
    where id = target.id;

    insert into public.visit_events (
      pass_id, visitor_id, event, reason, gate, guard_id, occurred_at, request_id, details
    ) values (
      target.id, target.visitor_id, 'scan_exit'::public.visit_event_type,
      'guard_offline_sync', coalesce(target.gate, 'Offline Gate'), actor.user_id, requested_occurred_at, requested_event_id,
      jsonb_build_object('offline_synced_at', statement_timestamp())
    );
  end if;

  insert into public.offline_sync_receipts (
    event_id, pass_id, action, status, client_occurred_at, actor_id, payload, result
  ) values (
    requested_event_id, target.id, requested_action, 'applied', requested_occurred_at, actor.user_id,
    jsonb_build_object('expectedStatus', requested_expected_status, 'expectedVersion', requested_expected_version, 'reason', requested_reason),
    jsonb_build_object('nextStatus', pass_status_val::text, 'passId', target.id, 'version', target.version + 1)
  );

  return jsonb_build_object(
    'status', 'applied',
    'eventId', requested_event_id,
    'newStatus', pass_status_val::text,
    'version', target.version + 1
  );
end;
$$;

revoke all on function api.guard_sync_offline_event(uuid, uuid, text, text, integer, timestamptz, text) from public, anon;
grant execute on function api.guard_sync_offline_event(uuid, uuid, text, text, integer, timestamptz, text) to authenticated;

comment on function api.guard_sync_offline_event(uuid, uuid, text, text, integer, timestamptz, text) is
  'Synchronizes offline gate lifecycle events recorded during network outages back to central database under administrator authority with mandatory fail-closed AAL2 enforcement.';

-- 6. Update api.claim_office_visit_acknowledgement_for_delivery to commit reconciliation_required without rollback
create or replace function api.claim_office_visit_acknowledgement_for_delivery(
  requested_visit_id uuid
)
returns table (
  outbox_id uuid,
  claim_id uuid,
  recipient_email text,
  encrypted_tracking_token text,
  idempotency_key text,
  attempt_count integer
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  target_ack public.office_visit_acknowledgement_outbox%rowtype;
  v_claim_id uuid;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'service role required';
  end if;

  -- 1. Canonical lock order: lock office_visits first, then ack outbox
  perform 1 from public.office_visits where id = requested_visit_id for update;

  select * into target_ack
  from public.office_visit_acknowledgement_outbox
  where office_visit_id = requested_visit_id
  for update;

  if not found then
    return;
  end if;

  -- Terminal state: never re-claim sent or delivered
  if target_ack.delivery_status in ('sent', 'delivered') then
    return;
  end if;

  -- Non-reclaimable states: if reconciliation is required or outcome was unknown, return without error
  -- allowing caller to inspect persisted status without rolling back
  if target_ack.delivery_status in ('unknown', 'reconciliation_required') then
    return;
  end if;

  -- Resend 24-hour idempotency window check: if previously attempted > 24h ago, must transition to reconciliation_required and commit (no rollback)
  if target_ack.attempt_count > 0 and (target_ack.last_attempt_at < now() - interval '24 hours' or target_ack.created_at < now() - interval '24 hours') then
    update public.office_visit_acknowledgement_outbox set
      delivery_status = 'reconciliation_required',
      claim_id = null,
      lease_expires_at = null,
      last_error = 'Resend idempotency window (24h) expired; reconciliation required before retry.',
      updated_at = now()
    where id = target_ack.id;

    return;
  end if;

  -- Active lease check / expired lease handling
  if target_ack.delivery_status = 'processing' then
    if target_ack.lease_expires_at is not null and target_ack.lease_expires_at > now() then
      raise exception using errcode = '40900', message = 'email_lease_active_in_progress';
    else
      -- Lease expired: transition row transactionally to reconciliation_required and commit (no rollback)
      update public.office_visit_acknowledgement_outbox set
        delivery_status = 'reconciliation_required',
        claim_id = null,
        lease_expires_at = null,
        last_error = coalesce(target_ack.last_error, 'Processing lease expired; reconciliation required before retry.'),
        updated_at = now()
      where id = target_ack.id;

      return;
    end if;
  end if;

  v_claim_id := gen_random_uuid();

  update public.office_visit_acknowledgement_outbox set
    claim_id = v_claim_id,
    delivery_status = 'processing',
    lease_expires_at = now() + interval '5 minutes',
    attempt_count = target_ack.attempt_count + 1,
    last_attempt_at = now(),
    updated_at = now()
  where id = target_ack.id;

  return query select
    target_ack.id,
    v_claim_id,
    target_ack.recipient_email,
    target_ack.encrypted_tracking_token,
    target_ack.idempotency_key,
    target_ack.attempt_count + 1;
end;
$$;

revoke all on function api.claim_office_visit_acknowledgement_for_delivery(uuid) from public, anon, authenticated;
grant execute on function api.claim_office_visit_acknowledgement_for_delivery(uuid) to service_role;

comment on function api.claim_office_visit_acknowledgement_for_delivery(uuid) is
  'Claims an office visit acknowledgement for delivery with lease management and transactional reconciliation_required transitions.';
