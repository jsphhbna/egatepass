-- Migration 40: Post-Redesign Root-Cause Closure & Production Contract Repair
-- Restores canonical event types in api.scan_pass, restores wrong-gate exit protection,
-- closes legacy guard role authority in database RPCs (api.decide_visit, api.create_staff_profile, api.update_staff_profile).

-- 1. Correct api.scan_pass: Restore wrong-gate exit protection and use only canonical visit_event_type values
create or replace function api.scan_pass(
  requested_actor_id uuid,
  requested_token_digest text,
  requested_mode public.device_type,
  requested_request_id uuid
)
returns table (ok boolean, result_status text, code text, message text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  scanner public.devices%rowtype;
  target public.passes%rowtype;
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
      -- Portal visitors transition directly to 'inside'
      if target.source = 'portal'::public.pass_source then
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

        return query select true, 'inside'::text, null::text, 'Entry recorded. Please proceed through the normal security inspection.'::text;
        return;
      else
        -- Kiosk passes retain pending guard review until walk-in redesign
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
    -- Restore wrong-gate exit protection
    if target.gate is distinct from scanner.gate then
      failure_code := 'wrong_gate';
      failure_message := 'Use the exit scanner assigned to the entry gate';
      insert into public.visit_events(pass_id, visitor_id, event, reason, device_id, gate, request_id)
      values (target.id, target.visitor_id, 'invalid_scan'::public.visit_event_type, failure_message, scanner.user_id, scanner.gate, requested_request_id)
      on conflict (request_id, event) do nothing;
      return query select false, target.status::text, failure_code, failure_message;
      return;
    else
      update public.passes set
        status = 'exited'::public.pass_status,
        time_out = now(),
        exit_device_id = scanner.user_id,
        updated_at = now(),
        version = version + 1
      where id = target.id;

      insert into public.visit_events(pass_id, visitor_id, event, device_id, gate, request_id)
      values (target.id, target.visitor_id, 'scan_exit'::public.visit_event_type, scanner.user_id, scanner.gate, requested_request_id)
      on conflict (request_id, event) do nothing;

      return query select true, 'exited'::text, null::text, 'Pass successfully exited.'::text;
      return;
    end if;
  else
    if target.status in ('expired'::public.pass_status, 'rejected'::public.pass_status) then
      failure_code := target.status::text; failure_message := 'Pass is no longer valid (' || target.status::text || ')';
    elsif target.status = 'exited'::public.pass_status then
      failure_code := 'already_exited'; failure_message := 'Pass has already exited';
    elsif target.status = 'pending'::public.pass_status then
      failure_code := 'pending'; failure_message := 'Pass is already awaiting guard decision';
    elsif target.status = 'inside'::public.pass_status and requested_mode = 'entry'::public.device_type then
      failure_code := 'already_inside'; failure_message := 'Pass has already been admitted';
    elsif target.status = 'issued'::public.pass_status and requested_mode = 'exit'::public.device_type then
      failure_code := 'not_entered'; failure_message := 'Pass has not recorded an entry yet';
    else
      failure_code := 'invalid_state'; failure_message := 'Pass state cannot transition under current scan';
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

-- 2. Correct api.decide_visit: Allow only admin and superadmin (deprecate human guard approval authority)
create or replace function api.decide_visit(
  requested_actor_id uuid,
  requested_pass_id uuid,
  requested_decision text,
  requested_reason text,
  requested_request_id uuid
)
returns public.pass_status
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor public.staff_profiles%rowtype;
  target public.passes%rowtype;
  next_status public.pass_status;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'service role required';
  end if;

  select * into actor from public.staff_profiles
  where user_id = requested_actor_id and active and not must_change_password
    and privacy_accepted_at is not null for share;

  if not found or actor.role not in ('admin'::public.staff_role, 'superadmin'::public.staff_role) then
    raise exception using errcode = '42501', message = 'active administrator required';
  end if;

  if requested_decision not in ('approved', 'rejected')
    or (requested_decision = 'approved' and requested_reason is not null)
    or (requested_decision = 'rejected' and char_length(btrim(coalesce(requested_reason, ''))) not between 1 and 500) then
    raise exception using errcode = '22023', message = 'invalid decision';
  end if;

  select * into target from public.passes where id = requested_pass_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'pass not found'; end if;
  if target.status <> 'pending'::public.pass_status then
    raise exception using errcode = '40001', message = 'pass is no longer pending';
  end if;

  next_status := case requested_decision when 'approved' then 'inside'::public.pass_status else 'rejected'::public.pass_status end;

  update public.passes set
    status = next_status, decided_at = now(),
    time_in = case when next_status = 'inside' then now() else time_in end,
    decided_by = actor.user_id,
    rejection_reason = case when next_status = 'rejected' then btrim(requested_reason) else null end,
    updated_at = now(), version = version + 1
  where id = target.id;

  insert into public.visit_events(pass_id, visitor_id, event, reason, gate, guard_id, request_id)
  values (
    target.id, target.visitor_id,
    case when next_status = 'inside' then 'approved'::public.visit_event_type else 'rejected'::public.visit_event_type end,
    case when next_status = 'rejected' then btrim(requested_reason) else null end,
    target.gate, actor.user_id, requested_request_id
  );

  return next_status;
end;
$$;

revoke all on function api.decide_visit(uuid, uuid, text, text, uuid) from public, anon, authenticated;
grant execute on function api.decide_visit(uuid, uuid, text, text, uuid) to service_role;

-- 3. Correct api.create_staff_profile: Disallow new guard staff profiles
create or replace function api.create_staff_profile(
  requested_actor_id uuid,
  requested_user_id uuid,
  requested_name text,
  requested_role public.staff_role,
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

  if requested_role = 'guard'::public.staff_role then
    raise exception using errcode = '42501', message = 'legacy_guard_role_disabled';
  end if;

  select role into actor_role from public.staff_profiles
  where user_id = requested_actor_id and active and not must_change_password and privacy_accepted_at is not null;

  if actor_role not in ('admin'::public.staff_role, 'superadmin'::public.staff_role) then
    raise exception using errcode = '42501', message = 'administrator required';
  end if;

  if requested_role = 'superadmin'::public.staff_role then
    raise exception using errcode = '42501', message = 'super admin creation requires a role-change review';
  end if;

  insert into public.staff_profiles(user_id, display_name, role, active, must_change_password, created_by)
  values (requested_user_id, btrim(requested_name), requested_role, true, true, requested_actor_id);

  insert into public.audit_events(actor_id, actor_kind, actor_role, action, target_type, target_id, request_id, after_state)
  values (
    requested_actor_id, 'staff', actor_role::text, 'staff.create', 'staff_profile', requested_user_id::text, requested_request_id,
    jsonb_build_object('role', requested_role, 'active', true, 'mustChangePassword', true)
  );
end;
$$;

revoke all on function api.create_staff_profile(uuid, uuid, text, public.staff_role, uuid) from public, anon, authenticated;
grant execute on function api.create_staff_profile(uuid, uuid, text, public.staff_role, uuid) to service_role;

-- 4. Correct api.update_staff_profile: Prevent role conversion to guard
create or replace function api.update_staff_profile(
  requested_actor_id uuid,
  requested_user_id uuid,
  requested_role public.staff_role,
  requested_active boolean,
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
  target public.staff_profiles%rowtype;
  next_role public.staff_role;
  next_active boolean;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'service role required';
  end if;

  select role into actor_role
  from public.staff_profiles
  where user_id = requested_actor_id
    and active
    and not must_change_password
    and privacy_accepted_at is not null;

  select * into target
  from public.staff_profiles
  where user_id = requested_user_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'staff profile not found';
  end if;

  if target.decommissioned_at is not null then
    raise exception using errcode = 'P0004', message = 'target_decommissioned';
  end if;

  if requested_user_id = requested_actor_id then
    raise exception using errcode = '42501', message = 'self-management denied';
  end if;

  if actor_role not in ('admin'::public.staff_role, 'superadmin'::public.staff_role) then
    raise exception using errcode = '42501', message = 'administrator required';
  end if;

  -- Block converting any account into the deprecated guard role
  if requested_role = 'guard'::public.staff_role and target.role <> 'guard'::public.staff_role then
    raise exception using errcode = '42501', message = 'legacy_guard_role_disabled';
  end if;

  next_role := coalesce(requested_role, target.role);
  next_active := coalesce(requested_active, target.active);

  if actor_role = 'admin'::public.staff_role and (target.role = 'superadmin'::public.staff_role or next_role = 'superadmin'::public.staff_role) then
    raise exception using errcode = '42501', message = 'admins may not manage superadmins';
  end if;

  update public.staff_profiles
  set role = next_role, active = next_active
  where user_id = target.user_id;

  insert into public.audit_events(
    actor_id, actor_kind, actor_role, action, target_type, target_id, request_id, before_state, after_state
  )
  values (
    requested_actor_id,
    'staff',
    actor_role::text,
    'staff.update',
    'staff_profile',
    target.user_id::text,
    requested_request_id,
    jsonb_build_object('role', target.role, 'active', target.active),
    jsonb_build_object('role', next_role, 'active', next_active)
  );
end;
$$;

revoke all on function api.update_staff_profile(uuid, uuid, public.staff_role, boolean, uuid) from public, anon, authenticated;
grant execute on function api.update_staff_profile(uuid, uuid, public.staff_role, boolean, uuid) to service_role;
