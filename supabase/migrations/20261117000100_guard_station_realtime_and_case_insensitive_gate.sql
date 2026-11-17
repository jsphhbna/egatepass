-- Migration: 20261117000100_guard_station_realtime_and_case_insensitive_gate.sql
-- Enables Guard Station Realtime access, case-insensitive gate matching, and canonical gate naming.

-- 1. Standardize gate naming in devices and passes to canonical 'Back Gate'
update public.devices
set gate = 'Back Gate', updated_at = now()
where lower(trim(gate)) = 'back gate';

update public.passes
set gate = 'Back Gate', updated_at = now()
where lower(trim(gate)) = 'back gate';

-- 2. Add RLS policy on public.passes for active guard_station devices at their assigned gate
drop policy if exists "passes_select_guard_station" on public.passes;
create policy "passes_select_guard_station"
  on public.passes
  for select
  to authenticated
  using (
    exists (
      select 1 from public.devices d
      where d.user_id = auth.uid()
        and d.status = 'active'::public.device_status
        and d.type = 'guard_station'::public.device_type
        and lower(trim(d.gate)) = lower(trim(passes.gate))
    )
  );

-- 3. Add RLS policy on public.visit_events for active guard_station devices at their assigned gate
drop policy if exists "visit_events_select_guard_station" on public.visit_events;
create policy "visit_events_select_guard_station"
  on public.visit_events
  for select
  to authenticated
  using (
    exists (
      select 1 from public.devices d
      where d.user_id = auth.uid()
        and d.status = 'active'::public.device_status
        and d.type = 'guard_station'::public.device_type
        and lower(trim(d.gate)) = lower(trim(visit_events.gate))
    )
  );

-- 4. Enable realtime on visit_events if publication exists
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (
      select 1 from pg_publication_tables 
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'visit_events'
    ) then
      alter publication supabase_realtime add table public.visit_events;
    end if;
  end if;
end;
$$;

-- 5. Update api.scan_pass to use case-insensitive gate matching on exit verification
create or replace function api.scan_pass(
  requested_actor_id uuid,
  requested_token_digest text,
  requested_mode public.device_type,
  requested_request_id uuid
)
returns table (
  ok boolean,
  result_status text,
  code text,
  message text
)
language plpgsql
volatile
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
        -- Kiosk passes retain pending guard review
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
      where pass_id = target.id;

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
          -- Office confirmation is missing.
          -- CRITICAL SAFETY INVARIANT: Never physically block or prevent a person from leaving campus!
          -- Pass transitions to exited, and office attendance status becomes exited_unconfirmed.
          update public.office_visits set
            attendance_status = 'exited_unconfirmed'::public.office_attendance_status,
            updated_at = now()
          where id = target_office_visit.id;

          insert into public.office_visit_events (office_visit_id, event_type, actor_id, actor_role, metadata)
          values (target_office_visit.id, 'gate_exit_unconfirmed', scanner.user_id, 'device', jsonb_build_object('gate', scanner.gate));

          insert into public.visit_events(pass_id, visitor_id, event, reason, device_id, gate, request_id)
          values (target.id, target.visitor_id, 'invalid_scan'::public.visit_event_type, 'Pass exited without office attendance confirmation', scanner.user_id, scanner.gate, requested_request_id)
          on conflict (request_id, event) do nothing;

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
