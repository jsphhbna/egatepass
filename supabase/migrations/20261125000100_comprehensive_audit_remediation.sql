-- ============================================================================
-- Migration: 20261125000100_comprehensive_audit_remediation.sql
-- Description: Comprehensive System Audit, Security Hardening, and Advisor Remediation
-- 1. Fixes api.scan_pass dual-write bug: removes spurious 'invalid_scan' event
--    during legitimate unconfirmed office exit ('gate_exit_unconfirmed').
-- 2. Synchronizes linked office_visits & visit_vehicle_declarations state inside
--    api.guard_recover_pass_action and api.guard_sync_offline_event.
-- 3. Fixes timezone handling in api.get_accountability_summary using v_timezone
--    instead of hardcoded +08 string concatenation.
-- 4. Restores defense-in-depth service_role and privacy_accepted_at checks on
--    api.delete_staff_account while preserving explicit service_role grant.
-- 5. Eliminates auth_rls_initplan warnings on sms_logs, emergency_inbound_reports,
--    and visitor_accountability_resolutions by wrapping auth.uid() in (select auth.uid()).
-- 6. Consolidates duplicate permissive authenticated SELECT policies on public.passes
--    and public.visit_events (eliminating multiple_permissive_policies warnings).
-- 7. Adds covering B-tree indexes for all 19 unindexed foreign key columns.
-- ============================================================================

-- 1. Fix api.scan_pass: do NOT insert false 'invalid_scan' on legitimate unconfirmed office exit
create or replace function api.scan_pass(
  requested_actor_id uuid,
  requested_token_digest text,
  requested_mode public.device_type,
  requested_request_id uuid
)
returns table(ok boolean, result_status text, code text, message text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  scanner public.devices%rowtype;
  target public.passes%rowtype;
  target_decl public.visit_vehicle_declarations%rowtype;
  target_office_visit public.office_visits%rowtype;
  failure_code text;
  failure_message text;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'service role required';
  end if;
  if requested_mode not in ('entry'::public.device_type, 'exit'::public.device_type)
    or requested_token_digest !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'invalid scan request';
  end if;

  select * into scanner from public.devices d
  where d.user_id = requested_actor_id and d.status = 'active'::public.device_status
  for share;
  if not found or scanner.type <> requested_mode then
    raise exception using errcode = '42501', message = 'active matching scanner required';
  end if;

  -- Device Heartbeat: update last_seen_at for active scanner
  update public.devices set last_seen_at = now() where user_id = scanner.user_id;

  select * into target from public.passes p
  where p.token_digest = decode(requested_token_digest, 'hex')
  for update;
  if not found then
    insert into public.visit_events(event, reason, device_id, gate, request_id)
    values ('invalid_scan'::public.visit_event_type, 'QR code not recognized', scanner.user_id, scanner.gate, requested_request_id)
    on conflict (request_id, event) do nothing;
    return query select false, null::text, 'not_found'::text, 'QR code not recognized'::text;
    return;
  end if;

  if requested_mode = 'entry'::public.device_type and target.status = 'issued'::public.pass_status then
    if target.valid_until < now() then
      update public.passes set status = 'expired', updated_at = now(), version = version + 1 where id = target.id;
      failure_code := 'expired'; failure_message := 'This pass has expired';
    elsif target.valid_from > now() then
      failure_code := 'early'; failure_message := 'Pass is not yet valid';
    else
      -- Check vehicle inside collision
      select * into target_decl from public.visit_vehicle_declarations
      where visit_vehicle_declarations.pass_id = target.id;

      if found and target_decl.plate_key is not null then
        if exists (
          select 1 from public.visit_vehicle_declarations d
          where d.plate_key = target_decl.plate_key
            and coalesce(d.entry_scanned_at, d.entry_recorded_at) is not null
            and coalesce(d.exit_scanned_at, d.exit_recorded_at) is null
            and d.pass_id <> target.id
        ) then
          failure_code := 'vehicle_already_inside';
          failure_message := 'Vehicle entry could not be recorded because this plate is already marked inside campus. Please verify the vehicle and follow campus security procedure.';
          insert into public.visit_events(pass_id, visitor_id, event, reason, device_id, gate, request_id)
          values (target.id, target.visitor_id, 'invalid_scan'::public.visit_event_type, failure_message, scanner.user_id, scanner.gate, requested_request_id)
          on conflict (request_id, event) do nothing;
          return query select false, target.status::text, failure_code, failure_message;
          return;
        end if;
      end if;

      if target.source = 'portal'::public.pass_source then
        if found and target_decl.plate_key is not null then
          begin
            update public.visit_vehicle_declarations set
              entry_recorded_at = coalesce(entry_recorded_at, now()),
              entry_scanned_at = coalesce(entry_scanned_at, now())
            where visit_vehicle_declarations.pass_id = target.id;
          exception when unique_violation then
            failure_code := 'vehicle_already_inside';
            failure_message := 'Vehicle entry could not be recorded because this plate is already marked inside campus. Please verify the vehicle and follow campus security procedure.';
            insert into public.visit_events(pass_id, visitor_id, event, reason, device_id, gate, request_id)
            values (target.id, target.visitor_id, 'invalid_scan'::public.visit_event_type, failure_message, scanner.user_id, scanner.gate, requested_request_id)
            on conflict (request_id, event) do nothing;
            return query select false, target.status::text, failure_code, failure_message;
            return;
          end;
        end if;

        update public.passes set
          status = 'inside'::public.pass_status,
          entry_scanned_at = now(),
          time_in = now(),
          entry_device_id = scanner.user_id,
          gate = scanner.gate,
          updated_at = now(),
          version = version + 1
        where id = target.id;

        insert into public.visit_events(pass_id, visitor_id, event, device_id, gate, request_id)
        values (target.id, target.visitor_id, 'scan_entry'::public.visit_event_type, scanner.user_id, scanner.gate, requested_request_id)
        on conflict (request_id, event) do nothing;

        -- Update linked office visits to awaiting_office_confirmation
        update public.office_visits set
          attendance_status = 'awaiting_office_confirmation'::public.office_attendance_status,
          updated_at = now()
        where pass_id = target.id and attendance_status = 'awaiting_entry'::public.office_attendance_status;

        insert into public.office_visit_events (office_visit_id, event_type, actor_id, actor_role, metadata)
        select ov.id, 'gate_entry', scanner.user_id, 'device', jsonb_build_object('gate', scanner.gate)
        from public.office_visits ov
        where ov.pass_id = target.id;

        return query select true, 'inside'::text, null::text, 'Entry recorded. Please proceed through the normal security inspection.'::text;
        return;
      else
        -- Kiosk passes retain pending review
        if found and target_decl.plate_key is not null then
          begin
            update public.visit_vehicle_declarations set
              entry_recorded_at = coalesce(entry_recorded_at, now()),
              entry_scanned_at = coalesce(entry_scanned_at, now())
            where visit_vehicle_declarations.pass_id = target.id;
          exception when unique_violation then
            failure_code := 'vehicle_already_inside';
            failure_message := 'Vehicle entry could not be recorded because this plate is already marked inside campus. Please verify the vehicle and follow campus security procedure.';
            insert into public.visit_events(pass_id, visitor_id, event, reason, device_id, gate, request_id)
            values (target.id, target.visitor_id, 'invalid_scan'::public.visit_event_type, failure_message, scanner.user_id, scanner.gate, requested_request_id)
            on conflict (request_id, event) do nothing;
            return query select false, target.status::text, failure_code, failure_message;
            return;
          end;
        end if;

        update public.passes set
          status = 'pending'::public.pass_status,
          entry_scanned_at = now(),
          entry_device_id = scanner.user_id,
          gate = scanner.gate,
          updated_at = now(),
          version = version + 1
        where id = target.id;

        insert into public.visit_events(pass_id, visitor_id, event, device_id, gate, request_id)
        values (target.id, target.visitor_id, 'scan_entry'::public.visit_event_type, scanner.user_id, scanner.gate, requested_request_id)
        on conflict (request_id, event) do nothing;

        return query select true, 'pending'::text, null::text, 'Scanned! Waiting for guard approval.'::text;
        return;
      end if;
    end if;

    insert into public.visit_events(pass_id, visitor_id, event, reason, device_id, gate, request_id)
    values (target.id, target.visitor_id, 'invalid_scan'::public.visit_event_type, failure_message, scanner.user_id, scanner.gate, requested_request_id)
    on conflict (request_id, event) do nothing;
    return query select false, target.status::text, failure_code, failure_message;
    return;
  elsif requested_mode = 'exit'::public.device_type and target.status = 'inside'::public.pass_status then
    if lower(trim(target.gate)) is distinct from lower(trim(scanner.gate)) then
      failure_code := 'wrong_gate';
      failure_message := 'Use the exit scanner assigned to the entry gate';
      insert into public.visit_events(pass_id, visitor_id, event, reason, device_id, gate, request_id)
      values (target.id, target.visitor_id, 'invalid_scan'::public.visit_event_type, failure_message, scanner.user_id, scanner.gate, requested_request_id)
      on conflict (request_id, event) do nothing;
      return query select false, target.status::text, failure_code, failure_message;
      return;
    else
      -- Transition pass to exited
      update public.passes set
        status = 'exited'::public.pass_status,
        time_out = now(),
        exit_device_id = scanner.user_id,
        updated_at = now(),
        version = version + 1
      where id = target.id;

      update public.visit_vehicle_declarations set
        exit_recorded_at = coalesce(exit_recorded_at, now()),
        exit_scanned_at = coalesce(exit_scanned_at, now())
      where visit_vehicle_declarations.pass_id = target.id;

      insert into public.visit_events(pass_id, visitor_id, event, device_id, gate, request_id)
      values (target.id, target.visitor_id, 'scan_exit'::public.visit_event_type, scanner.user_id, scanner.gate, requested_request_id)
      on conflict (request_id, event) do nothing;

      -- Check office visit attendance status
      select * into target_office_visit from public.office_visits
      where pass_id = target.id
      order by created_at asc
      limit 1;

      if found then
        if target_office_visit.attendance_status = 'confirmed'::public.office_attendance_status then
          update public.office_visits set
            attendance_status = 'completed'::public.office_attendance_status,
            updated_at = now()
          where id = target_office_visit.id;

          insert into public.office_visit_events (office_visit_id, event_type, actor_id, actor_role, metadata)
          values (target_office_visit.id, 'gate_exit_confirmed', scanner.user_id, 'device', jsonb_build_object('gate', scanner.gate));

          return query select true, 'exited'::text, null::text, 'Pass successfully exited.'::text;
          return;
        else
          -- CRITICAL SAFETY INVARIANT: Never block campus egress; classify office attendance truthfully
          -- without writing a false 'invalid_scan' failure event to visit_events.
          update public.office_visits set
            attendance_status = 'exited_unconfirmed'::public.office_attendance_status,
            updated_at = now()
          where id = target_office_visit.id;

          insert into public.office_visit_events (office_visit_id, event_type, actor_id, actor_role, metadata)
          values (target_office_visit.id, 'gate_exit_unconfirmed', scanner.user_id, 'device', jsonb_build_object('gate', scanner.gate));

          return query select true, 'exited'::text, 'office_unconfirmed'::text, 'Pass exited without office confirmation.'::text;
          return;
        end if;
      else
        return query select true, 'exited'::text, null::text, 'Pass successfully exited.'::text;
        return;
      end if;
    end if;
  else
    if target.status in ('expired'::public.pass_status, 'rejected'::public.pass_status) then
      failure_code := target.status::text; failure_message := 'Pass is no longer valid (' || target.status::text || ')';
    elsif target.status = 'exited'::public.pass_status then
      failure_code := 'already_exited'; failure_message := 'Pass has already been used to exit';
    elsif target.status = 'inside'::public.pass_status and requested_mode = 'entry'::public.device_type then
      failure_code := 'already_inside'; failure_message := 'Pass is already marked inside';
    elsif target.status = 'issued'::public.pass_status and requested_mode = 'exit'::public.device_type then
      failure_code := 'not_entered'; failure_message := 'Pass has not been scanned at entry';
    elsif target.status = 'pending'::public.pass_status then
      failure_code := 'pending'; failure_message := 'Pass is pending approval';
    else
      failure_code := 'invalid_state'; failure_message := 'Scan not valid in current pass state';
    end if;

    insert into public.visit_events(pass_id, visitor_id, event, reason, device_id, gate, request_id)
    values (target.id, target.visitor_id, 'invalid_scan'::public.visit_event_type, failure_message, scanner.user_id, scanner.gate, requested_request_id)
    on conflict (request_id, event) do nothing;
    return query select false, target.status::text, failure_code, failure_message;
    return;
  end if;
end;
$$;

revoke all on function api.scan_pass(uuid, text, public.device_type, uuid) from public, anon, authenticated;
grant execute on function api.scan_pass(uuid, text, public.device_type, uuid) to service_role;

-- 2. Synchronize office_visits & vehicle declarations in api.guard_recover_pass_action
create or replace function api.guard_recover_pass_action(
  requested_pass_id uuid,
  requested_action text,
  requested_reason text default null::text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor public.staff_profiles%rowtype;
  target public.passes%rowtype;
  target_office_visit public.office_visits%rowtype;
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

  if not coalesce((select private.staff_mfa_is_satisfied()), false) then
    raise exception using errcode = '42501', message = 'mfa_required';
  end if;

  if requested_action not in ('approve_entry', 'reject_entry', 'record_exit') then
    raise exception using errcode = '22023', message = 'invalid recovery action';
  end if;

  select * into target from public.passes where id = requested_pass_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'pass not found';
  end if;

  select * into target_office_visit from public.office_visits
  where pass_id = target.id
  order by created_at asc
  limit 1
  for update;

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

    update public.visit_vehicle_declarations set
      entry_recorded_at = coalesce(entry_recorded_at, statement_timestamp())
    where pass_id = target.id;

    if target_office_visit.id is not null then
      if target_office_visit.attendance_status = 'awaiting_entry'::public.office_attendance_status then
        update public.office_visits set
          attendance_status = 'awaiting_office_confirmation'::public.office_attendance_status,
          updated_at = statement_timestamp()
        where id = target_office_visit.id;
      end if;

      insert into public.office_visit_events (
        office_visit_id, event_type, actor_id, actor_role, metadata
      ) values (
        target_office_visit.id, 'gate_entry', actor.user_id, actor.role::text,
        jsonb_build_object('gate', coalesce(target.gate, 'Recovery Gate'), 'source', 'visitor_recovery')
      );
    end if;

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

    update public.visit_vehicle_declarations set
      exit_recorded_at = coalesce(exit_recorded_at, statement_timestamp())
    where pass_id = target.id;

    if target_office_visit.id is not null then
      if target_office_visit.attendance_status = 'confirmed'::public.office_attendance_status then
        update public.office_visits set
          attendance_status = 'completed'::public.office_attendance_status,
          updated_at = statement_timestamp()
        where id = target_office_visit.id;

        insert into public.office_visit_events (
          office_visit_id, event_type, actor_id, actor_role, metadata
        ) values (
          target_office_visit.id, 'gate_exit_confirmed', actor.user_id, actor.role::text,
          jsonb_build_object('gate', coalesce(target.gate, 'Recovery Gate'), 'source', 'visitor_recovery')
        );
      elsif target_office_visit.attendance_status in ('awaiting_entry'::public.office_attendance_status, 'awaiting_office_confirmation'::public.office_attendance_status) then
        update public.office_visits set
          attendance_status = 'exited_unconfirmed'::public.office_attendance_status,
          updated_at = statement_timestamp()
        where id = target_office_visit.id;

        insert into public.office_visit_events (
          office_visit_id, event_type, actor_id, actor_role, metadata
        ) values (
          target_office_visit.id, 'gate_exit_unconfirmed', actor.user_id, actor.role::text,
          jsonb_build_object('gate', coalesce(target.gate, 'Recovery Gate'), 'source', 'visitor_recovery')
        );
      end if;
    end if;

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

-- 3. Synchronize office_visits & vehicle declarations in api.guard_sync_offline_event
create or replace function api.guard_sync_offline_event(
  requested_event_id uuid,
  requested_pass_id uuid,
  requested_action text,
  requested_expected_status text,
  requested_expected_version integer,
  requested_occurred_at timestamp with time zone,
  requested_reason text default null::text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor public.staff_profiles%rowtype;
  existing_receipt public.offline_sync_receipts%rowtype;
  target public.passes%rowtype;
  target_office_visit public.office_visits%rowtype;
  actual_pass_id uuid := requested_pass_id;
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

  if not coalesce((select private.staff_mfa_is_satisfied()), false) then
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

  select * into target_office_visit from public.office_visits
  where pass_id = target.id
  order by created_at asc
  limit 1
  for update;

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

    update public.visit_vehicle_declarations set
      entry_recorded_at = coalesce(entry_recorded_at, requested_occurred_at)
    where pass_id = target.id;

    if target_office_visit.id is not null then
      if target_office_visit.attendance_status = 'awaiting_entry'::public.office_attendance_status then
        update public.office_visits set
          attendance_status = 'awaiting_office_confirmation'::public.office_attendance_status,
          updated_at = statement_timestamp()
        where id = target_office_visit.id;
      end if;

      insert into public.office_visit_events (
        office_visit_id, event_type, actor_id, actor_role, metadata
      ) values (
        target_office_visit.id, 'gate_entry', actor.user_id, actor.role::text,
        jsonb_build_object('gate', coalesce(target.gate, 'Offline Gate'), 'source', 'guard_offline_sync', 'occurred_at', requested_occurred_at)
      );
    end if;

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

    update public.visit_vehicle_declarations set
      exit_recorded_at = coalesce(exit_recorded_at, requested_occurred_at)
    where pass_id = target.id;

    if target_office_visit.id is not null then
      if target_office_visit.attendance_status = 'confirmed'::public.office_attendance_status then
        update public.office_visits set
          attendance_status = 'completed'::public.office_attendance_status,
          updated_at = statement_timestamp()
        where id = target_office_visit.id;

        insert into public.office_visit_events (
          office_visit_id, event_type, actor_id, actor_role, metadata
        ) values (
          target_office_visit.id, 'gate_exit_confirmed', actor.user_id, actor.role::text,
          jsonb_build_object('gate', coalesce(target.gate, 'Offline Gate'), 'source', 'guard_offline_sync', 'occurred_at', requested_occurred_at)
        );
      elsif target_office_visit.attendance_status in ('awaiting_entry'::public.office_attendance_status, 'awaiting_office_confirmation'::public.office_attendance_status) then
        update public.office_visits set
          attendance_status = 'exited_unconfirmed'::public.office_attendance_status,
          updated_at = statement_timestamp()
        where id = target_office_visit.id;

        insert into public.office_visit_events (
          office_visit_id, event_type, actor_id, actor_role, metadata
        ) values (
          target_office_visit.id, 'gate_exit_unconfirmed', actor.user_id, actor.role::text,
          jsonb_build_object('gate', coalesce(target.gate, 'Offline Gate'), 'source', 'guard_offline_sync', 'occurred_at', requested_occurred_at)
        );
      end if;
    end if;

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

-- 4. Fix timezone calculation in api.get_accountability_summary
create or replace function api.get_accountability_summary(
  requested_actor_id uuid,
  requested_date_from date,
  requested_date_to date,
  requested_closing_hours text default '17:00'::text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor_profile public.staff_profiles%rowtype;
  v_app_settings record;
  v_closing_time text;
  v_opening_time text;
  v_timezone text;
  summary_record record;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'service_role required';
  end if;

  select * into actor_profile
  from public.staff_profiles
  where user_id = requested_actor_id
    and active = true;

  if not found or actor_profile.role not in ('admin'::public.staff_role, 'superadmin'::public.staff_role) then
    raise exception using errcode = '42501', message = 'admin_authorization_required';
  end if;

  select
    to_char(working_hours_end, 'HH24:MI') as working_hours_end,
    to_char(working_hours_start, 'HH24:MI') as working_hours_start,
    timezone
  into v_app_settings
  from public.app_settings
  where singleton = true;

  v_closing_time := coalesce(nullif(btrim(v_app_settings.working_hours_end), ''), nullif(btrim(requested_closing_hours), ''), '17:00');
  v_opening_time := coalesce(nullif(btrim(v_app_settings.working_hours_start), ''), '08:00');
  v_timezone := coalesce(nullif(btrim(v_app_settings.timezone), ''), 'Asia/Manila');

  with pass_eval as (
    select
      p.id as pass_id,
      p.visitor_id,
      p.status,
      p.accountability_status,
      (p.time_in is not null or p.entry_scanned_at is not null or p.status in ('inside', 'exited')) as has_entered,
      (p.time_out is not null or p.status = 'exited') as has_exited,
      (now() >= coalesce(p.valid_until, (v.visit_date + v_closing_time::time) at time zone v_timezone)) as is_past_closing,
      (ov.id is not null and ov.office_id is not null and o.name is not null and lower(btrim(o.name)) not in ('', 'general campus')) as has_office,
      (ov.attendance_status in ('confirmed', 'completed') or ov.confirmed_at is not null) as is_office_confirmed
    from public.passes p
    inner join public.visitors v on v.id = p.visitor_id
    left join lateral (
      select id, office_id, attendance_status, confirmed_at
      from public.office_visits
      where pass_id = p.id
      order by created_at asc
      limit 1
    ) ov on true
    left join public.offices o on o.id = ov.office_id
    where (requested_date_from is null or v.visit_date >= requested_date_from)
      and (requested_date_to is null or v.visit_date <= requested_date_to)
  ),
  classified as (
    select
      visitor_id,
      has_entered,
      has_exited,
      (has_entered and not has_exited and is_past_closing) as is_missing_exit,
      (has_entered and has_office and not is_office_confirmed and (is_past_closing or has_exited)) as is_missing_office,
      (has_entered and has_exited and (not has_office or is_office_confirmed)) as is_completed,
      accountability_status
    from pass_eval
  )
  select
    count(distinct visitor_id) as total_visitors,
    count(distinct visitor_id) filter (where is_completed) as completed_visits,
    count(distinct visitor_id) filter (where is_missing_exit and accountability_status = 'pending') as missing_exit_count,
    count(distinct visitor_id) filter (where is_missing_office and accountability_status = 'pending') as missing_office_count,
    count(distinct visitor_id) filter (where (is_missing_exit or is_missing_office) and accountability_status = 'pending') as requiring_review_count,
    count(distinct visitor_id) filter (where accountability_status in ('resolved', 'reviewed', 'exception')) as reviewed_count
  into summary_record
  from classified;

  return jsonb_build_object(
    'totalVisitors', coalesce(summary_record.total_visitors, 0),
    'completedVisits', coalesce(summary_record.completed_visits, 0),
    'missingExitCount', coalesce(summary_record.missing_exit_count, 0),
    'missingOfficeCount', coalesce(summary_record.missing_office_count, 0),
    'requiringReviewCount', coalesce(summary_record.requiring_review_count, 0),
    'reviewedCount', coalesce(summary_record.reviewed_count, 0),
    'schoolClosingTime', v_closing_time,
    'schoolOpeningTime', v_opening_time,
    'timezone', v_timezone
  );
end;
$$;

revoke all on function api.get_accountability_summary(uuid, date, date, text) from public, anon, authenticated;
grant execute on function api.get_accountability_summary(uuid, date, date, text) to service_role;

-- 5. Defense-in-depth service_role and onboarding guard on api.delete_staff_account
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
  v_actor_privacy_accepted_at timestamptz;
  v_target record;
  v_remaining_superadmins int;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'service role required';
  end if;

  select role, active, must_change_password, privacy_accepted_at
  into v_actor_role, v_actor_active, v_actor_must_change_pw, v_actor_privacy_accepted_at
  from public.staff_profiles
  where user_id = requested_actor_id;

  if not found
     or v_actor_role <> 'superadmin'::public.staff_role
     or not v_actor_active
     or v_actor_must_change_pw
     or v_actor_privacy_accepted_at is null then
    raise exception using errcode = '42501', message = 'active_superadmin_required';
  end if;

  if requested_target_uid = requested_actor_id then
    raise exception using errcode = '42501', message = 'cannot_delete_self';
  end if;

  if exists (select 1 from public.devices where user_id = requested_target_uid) then
    raise exception using errcode = '42501', message = 'cannot_delete_device_via_staff_api';
  end if;

  select * into v_target
  from public.staff_profiles
  where user_id = requested_target_uid
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'target_user_not_found';
  end if;

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

  if exists (
    select 1 from public.incident_holds
    where created_by = requested_target_uid
      and active = true
  ) then
    raise exception using errcode = '40900', message = 'target_has_active_incident_holds';
  end if;

  if exists (
    select 1 from public.visitor_accountability_resolutions
    where actor_id = requested_target_uid
  ) then
    raise exception using errcode = '40900', message = 'target_has_accountability_resolutions';
  end if;

  delete from public.office_staff_assignments where user_id = requested_target_uid;

  if to_regclass('public.staff_mfa_factors') is not null then
    execute 'delete from public.staff_mfa_factors where user_id = $1' using requested_target_uid;
  end if;

  if to_regclass('public.user_sessions') is not null then
    execute 'delete from public.user_sessions where user_id = $1' using requested_target_uid;
  end if;

  update public.passes set decided_by = null where decided_by = requested_target_uid;
  update public.visit_events set guard_id = null where guard_id = requested_target_uid;
  update public.incident_holds set created_by = null where created_by = requested_target_uid;
  update public.incident_holds set released_by = null where released_by = requested_target_uid;
  update public.office_provisioning_operations set actor_id = null where actor_id = requested_target_uid;

  delete from public.staff_profiles where user_id = requested_target_uid;

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

-- 6. RLS Advisor Remediation: fix auth_rls_initplan on 3 tables
drop policy if exists emergency_reports_staff_select on public.emergency_inbound_reports;
create policy emergency_reports_staff_select
  on public.emergency_inbound_reports
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.staff_profiles p
      where p.user_id = (select auth.uid())
        and p.role = any (array['admin'::public.staff_role, 'superadmin'::public.staff_role])
        and p.active = true
    )
  );

drop policy if exists sms_logs_staff_select_policy on public.sms_logs;
create policy sms_logs_staff_select_policy
  on public.sms_logs
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.staff_profiles p
      where p.user_id = (select auth.uid())
        and p.role = any (array['admin'::public.staff_role, 'superadmin'::public.staff_role])
        and p.active = true
    )
  );

drop policy if exists var_admin_read on public.visitor_accountability_resolutions;
create policy var_admin_read
  on public.visitor_accountability_resolutions
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.staff_profiles s
      where s.user_id = (select auth.uid())
        and s.active = true
        and s.role = any (array['admin'::public.staff_role, 'superadmin'::public.staff_role])
    )
  );

-- Consolidate multiple permissive SELECT policies for authenticated on passes & visit_events
drop policy if exists "passes_select_guard_station" on public.passes;
drop policy if exists "passes_select" on public.passes;
create policy "passes_select"
  on public.passes
  for select
  to authenticated
  using (
    (
      exists (
        select 1
        from public.visitors v
        where v.id = passes.visitor_id
          and v.owner_id = (select auth.uid())
          and v.source = 'portal'::public.pass_source
          and (select private.is_portal_actor())
      )
    )
    or (select private.has_staff_role(array['admin'::public.staff_role, 'superadmin'::public.staff_role]))
    or (
      exists (
        select 1
        from public.devices d
        where d.user_id = (select auth.uid())
          and d.status = 'active'::public.device_status
          and d.type = 'guard_station'::public.device_type
          and lower(btrim(d.gate)) = lower(btrim(passes.gate))
      )
    )
  );

drop policy if exists "visit_events_select_guard_station" on public.visit_events;
drop policy if exists "visit_events_select" on public.visit_events;
create policy "visit_events_select"
  on public.visit_events
  for select
  to authenticated
  using (
    (select private.has_staff_role(array['admin'::public.staff_role, 'superadmin'::public.staff_role]))
    or (
      exists (
        select 1
        from public.devices d
        where d.user_id = (select auth.uid())
          and d.status = 'active'::public.device_status
          and d.type = 'guard_station'::public.device_type
          and lower(btrim(d.gate)) = lower(btrim(visit_events.gate))
      )
    )
  );

-- 7. Foreign Key Advisor Remediation: add covering B-tree indexes for all 19 unindexed FKs
create index if not exists idx_office_calendar_schedules_created_by
  on public.office_calendar_schedules (created_by);

create index if not exists idx_office_personnel_created_by
  on public.office_personnel (created_by);

create index if not exists idx_office_personnel_updated_by
  on public.office_personnel (updated_by);

create index if not exists idx_office_visit_email_outbox_reconciled_by
  on public.office_visit_email_outbox (reconciled_by);

create index if not exists idx_office_visit_events_actor_id
  on public.office_visit_events (actor_id);

create index if not exists idx_office_visits_confirmed_by
  on public.office_visits (confirmed_by);

create index if not exists idx_office_visits_decided_by
  on public.office_visits (decided_by);

create index if not exists idx_office_visits_personnel_id
  on public.office_visits (personnel_id);

create index if not exists idx_office_visits_returning_profile_id
  on public.office_visits (returning_profile_id);

create index if not exists idx_office_visits_visitor_id
  on public.office_visits (visitor_id);

create index if not exists idx_offices_closed_by
  on public.offices (closed_by);

create index if not exists idx_offices_created_by
  on public.offices (created_by);

create index if not exists idx_offices_updated_by
  on public.offices (updated_by);

create index if not exists idx_passes_accountability_resolved_by
  on public.passes (accountability_resolved_by);

create index if not exists idx_sms_logs_actor_id
  on public.sms_logs (actor_id);

create index if not exists idx_sms_quota_reservations_actor_id
  on public.sms_quota_reservations (actor_id);

create index if not exists idx_system_reset_operations_actor_id
  on public.system_reset_operations (actor_id);

create index if not exists idx_var_actor_id
  on public.visitor_accountability_resolutions (actor_id);

create index if not exists idx_var_office_visit_id
  on public.visitor_accountability_resolutions (office_visit_id);
