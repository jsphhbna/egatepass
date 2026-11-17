-- Migration: 20261118000100_device_ecosystem_and_realtime_reconciliation.sql
-- Description: Enable Supabase Realtime for office_visits, reconcile kiosk peak mode,
-- and record hardware device last_seen_at heartbeats across scanners and kiosks.

-- =============================================================================
-- 1. EXPAND SUPABASE REALTIME PUBLICATION
-- =============================================================================

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'office_visits'
    ) then
      alter publication supabase_realtime add table public.office_visits;
    end if;

    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'office_visit_events'
    ) then
      alter publication supabase_realtime add table public.office_visit_events;
    end if;

    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'emergency_gate_records'
    ) then
      alter publication supabase_realtime add table public.emergency_gate_records;
    end if;
  end if;
end $$;

-- =============================================================================
-- 2. RECONCILE api.scan_pass FOR HEARTBEATS & OFFICE VISIT LINKAGES
-- =============================================================================

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

-- =============================================================================
-- 3. RECONCILE api.issue_pass FOR KIOSK PEAK MODE & DEVICE HEARTBEATS
-- =============================================================================

create or replace function api.issue_pass(
  requested_actor_id uuid,
  requested_source public.pass_source,
  requested_request_id uuid,
  requested_full_name text,
  requested_contact_number text,
  requested_purpose text,
  requested_visit_date date,
  requested_photo_intent_id uuid,
  requested_photo_bytes integer,
  requested_photo_sha256 text,
  requested_id_intent_id uuid,
  requested_id_bytes integer,
  requested_id_sha256 text,
  requested_token_digest text,
  requested_office_id uuid default null,
  requested_expected_gate text default null
)
returns table (
  pass_id uuid,
  public_reference uuid,
  valid_from timestamptz,
  valid_until timestamptz
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  settings public.app_settings%rowtype;
  photo_intent public.upload_intents%rowtype;
  id_intent public.upload_intents%rowtype;
  verification_record public.portal_identity_verification_attempts%rowtype;
  target_office public.offices%rowtype;
  new_visitor_id uuid;
  new_pass_id uuid;
  new_public_reference uuid;
  new_visit_id uuid;
  starts_at timestamptz;
  ends_at timestamptz;
  id_is_required boolean;
  target_closure_title text;
  effective_expected_gate text;
  v_first_name text;
  v_last_name text;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'service role required';
  end if;

  if requested_source = 'portal'::public.pass_source then
    if not exists (
      select 1 from auth.users u
      where u.id = requested_actor_id and coalesce(u.is_anonymous, false)
    ) or exists (select 1 from public.staff_profiles where user_id = requested_actor_id)
      or exists (select 1 from public.devices where user_id = requested_actor_id) then
      raise exception using errcode = '42501', message = 'anonymous visitor identity required';
    end if;
  elsif requested_source = 'kiosk'::public.pass_source then
    if not exists (
      select 1 from public.devices d
      where d.user_id = requested_actor_id
        and d.type = 'kiosk'::public.device_type
        and d.status = 'active'::public.device_status
    ) then
      raise exception using errcode = '42501', message = 'active kiosk identity required';
    end if;
    -- Kiosk Heartbeat: update last_seen_at for active kiosk device
    update public.devices set last_seen_at = now() where user_id = requested_actor_id;
  else
    raise exception using errcode = '22023', message = 'unsupported source';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(requested_request_id::text, 0));
  select p.id, p.public_reference, p.valid_from, p.valid_until
  into pass_id, public_reference, valid_from, valid_until
  from public.passes p
  join public.visitors v on v.id = p.visitor_id
  where p.issue_request_id = requested_request_id
    and v.owner_id = requested_actor_id
    and v.source = requested_source;
  if found then return next; return; end if;

  select * into settings from public.app_settings where singleton for share;
  if requested_visit_date < (now() at time zone settings.timezone)::date
    or requested_visit_date > (now() at time zone settings.timezone)::date + settings.scheduling_days_ahead then
    raise exception using errcode = '22023', message = 'visit date outside scheduling window';
  end if;

  if exists (
    select 1 from public.campus_calendar_closures
    where active and published and requested_visit_date between start_date and end_date
  ) then
    select title into target_closure_title
    from public.campus_calendar_closures
    where active and published and requested_visit_date between start_date and end_date
    limit 1;
    raise exception 'visit_date_closed: %', target_closure_title using errcode = 'P0001';
  end if;

  -- Enforce office governance inside the same transaction if destination office provided
  if requested_office_id is not null then
    select * into target_office
    from public.offices
    where id = requested_office_id
      and active = true
      and publication_status = 'published';
    if not found then
      raise exception using errcode = '22023', message = 'office_not_found_or_unpublished';
    end if;
    if target_office.requires_approval_before_pass then
      raise exception using errcode = '40900', message = 'office_approval_required';
    end if;
  end if;

  if char_length(btrim(requested_full_name)) not between 2 and 160
    or char_length(btrim(requested_contact_number)) not between 7 and 32
    or char_length(btrim(requested_purpose)) not between 3 and 160
    or requested_token_digest !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'invalid pass parameters';
  end if;

  -- Peak Mode Reconciled Logic:
  -- Portal always requires an ID image.
  -- Kiosk requires an ID image unless Peak Mode is active for kiosk/both (allowing rapid throughput).
  if requested_source = 'portal'::public.pass_source then
    id_is_required := true;
  else
    id_is_required := settings.peak_mode not in ('kiosk'::public.peak_mode_scope, 'both'::public.peak_mode_scope);
  end if;

  if id_is_required and requested_id_intent_id is null then
    raise exception using errcode = '22023', message = 'identification image required';
  end if;

  if requested_source = 'portal'::public.pass_source then
    select * into verification_record
    from public.portal_identity_verification_attempts
    where owner_id = requested_actor_id
      and request_id = requested_request_id::text
      and photo_intent_id = requested_photo_intent_id
      and id_intent_id = requested_id_intent_id
      and outcome = 'matched'
      and expires_at > now()
    order by verified_at desc
    limit 1;
    if not found then
      raise exception using errcode = '42501', message = 'valid matched identity verification required';
    end if;
  end if;

  select * into photo_intent from public.upload_intents where id = requested_photo_intent_id for update;
  if not found or photo_intent.owner_id <> requested_actor_id or photo_intent.source <> requested_source
    or photo_intent.kind <> 'photo'::public.evidence_kind or photo_intent.status <> 'pending'::public.upload_intent_status
    or photo_intent.expires_at <= now()
    or requested_photo_bytes not between 1 and photo_intent.max_bytes
    or requested_photo_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'invalid photo upload intent';
  end if;

  if requested_id_intent_id is not null then
    select * into id_intent from public.upload_intents where id = requested_id_intent_id for update;
    if not found or id_intent.owner_id <> requested_actor_id or id_intent.source <> requested_source
      or id_intent.kind <> 'id'::public.evidence_kind or id_intent.status <> 'pending'::public.upload_intent_status
      or id_intent.expires_at <= now()
      or requested_id_bytes not between 1 and id_intent.max_bytes
      or requested_id_sha256 !~ '^[0-9a-f]{64}$' then
      raise exception using errcode = '22023', message = 'invalid identification upload intent';
    end if;
  end if;

  starts_at := (requested_visit_date + settings.working_hours_start) at time zone settings.timezone;
  ends_at := (requested_visit_date + settings.working_hours_end) at time zone settings.timezone;
  if ends_at <= now() then raise exception using errcode = '22023', message = 'visit window already closed'; end if;

  effective_expected_gate := coalesce(
    nullif(btrim(coalesce(requested_expected_gate, '')), ''),
    nullif(btrim(coalesce(settings.default_expected_gate, '')), '')
  );

  insert into public.visitors (
    owner_id, source, created_by_device_id, full_name, contact_number,
    purpose, visit_date, consent_accepted_at,
    identity_verification_id, identity_verified_at
  ) values (
    requested_actor_id, requested_source,
    case when requested_source = 'kiosk'::public.pass_source then requested_actor_id else null end,
    btrim(requested_full_name), btrim(requested_contact_number),
    btrim(requested_purpose), requested_visit_date, now(),
    case when requested_source = 'portal'::public.pass_source then verification_record.id else null end,
    case when requested_source = 'portal'::public.pass_source then verification_record.verified_at else null end
  ) returning id into new_visitor_id;

  insert into public.visitor_evidence (
    visitor_id, upload_intent_id, kind, bucket_id, object_path, content_type,
    byte_size, sha256_hex, verified_at, expires_at
  ) values (
    new_visitor_id, photo_intent.id, photo_intent.kind, photo_intent.bucket_id,
    photo_intent.object_path, photo_intent.content_type, requested_photo_bytes,
    requested_photo_sha256, now(), greatest(
      now() + make_interval(days => coalesce(settings.photo_retention_days, settings.image_retention_days, 7)),
      ends_at + interval '1 day'
    )
  );

  update public.upload_intents set status = 'claimed', claimed_at = now(), visitor_id = new_visitor_id
  where id = photo_intent.id;

  if requested_id_intent_id is not null then
    insert into public.visitor_evidence (
      visitor_id, upload_intent_id, kind, bucket_id, object_path, content_type,
      byte_size, sha256_hex, verified_at, expires_at
    ) values (
      new_visitor_id, id_intent.id, id_intent.kind, id_intent.bucket_id,
      id_intent.object_path, id_intent.content_type, requested_id_bytes,
      requested_id_sha256, now(), greatest(
        now() + make_interval(days => coalesce(settings.id_retention_days, settings.image_retention_days, 30)),
        ends_at + interval '1 day'
      )
    );

    update public.upload_intents set status = 'claimed', claimed_at = now(), visitor_id = new_visitor_id
    where id = id_intent.id;
  end if;

  insert into public.passes (
    visitor_id, source, issue_request_id, status, valid_from, valid_until,
    token_digest, expected_gate
  ) values (
    new_visitor_id, requested_source, requested_request_id, 'issued'::public.pass_status,
    starts_at, ends_at, decode(requested_token_digest, 'hex'), effective_expected_gate
  ) returning id, passes.public_reference into new_pass_id, new_public_reference;

  -- Atomic general office visit linkage when officeId was supplied
  if requested_office_id is not null then
    v_first_name := split_part(btrim(requested_full_name), ' ', 1);
    v_last_name := coalesce(nullif(btrim(substring(btrim(requested_full_name) from length(v_first_name) + 2)), ''), '-');

    insert into public.office_visits (
      visit_type, office_id, approval_status, attendance_status,
      visitor_actor_id, visitor_id, pass_id,
      visitor_first_name, visitor_last_name, visitor_display_name,
      visitor_contact_number, visitor_email, visitor_email_verified,
      purpose, visit_date, arrival_mode, request_id, email_delivery_status,
      office_requires_approval_snapshot, decided_at, decided_by, decision_source,
      source, expected_gate
    ) values (
      'general', requested_office_id, 'approved'::public.office_approval_status, 'awaiting_entry'::public.office_attendance_status,
      requested_actor_id, new_visitor_id, new_pass_id,
      v_first_name, v_last_name, btrim(requested_full_name),
      btrim(requested_contact_number), null, false,
      btrim(requested_purpose), requested_visit_date, 'no_vehicle', requested_request_id, 'none',
      false, now(), null, 'auto_office_policy',
      requested_source, effective_expected_gate
    ) returning id into new_visit_id;

    insert into public.office_visit_events (
      office_visit_id, actor_id, actor_role, event_type, metadata
    ) values (
      new_visit_id, null, 'system', 'auto_approved_by_policy',
      jsonb_build_object(
        'pass_id', new_pass_id,
        'office_id', requested_office_id,
        'visit_date', requested_visit_date,
        'decision_source', 'auto_office_policy',
        'office_requires_approval_snapshot', false
      )
    );
  end if;

  insert into public.audit_events (
    actor_id, actor_kind, action, target_type, target_id, request_id, after_state
  ) values (
    requested_actor_id,
    case when requested_source = 'kiosk'::public.pass_source then 'device' else 'system' end,
    'pass.issue', 'pass', new_pass_id::text, requested_request_id,
    jsonb_build_object(
      'source', requested_source,
      'visitDate', requested_visit_date,
      'publicReference', new_public_reference,
      'officeId', requested_office_id,
      'expectedGate', effective_expected_gate
    )
  );

  pass_id := new_pass_id;
  public_reference := new_public_reference;
  valid_from := starts_at;
  valid_until := ends_at;
  return next;
end;
$$;

revoke all on function api.issue_pass(
  uuid, public.pass_source, uuid, text, text, text, date, uuid, integer, text, uuid, integer, text, text, uuid, text
) from public, anon, authenticated;
grant execute on function api.issue_pass(
  uuid, public.pass_source, uuid, text, text, text, date, uuid, integer, text, uuid, integer, text, text, uuid, text
) to service_role;
