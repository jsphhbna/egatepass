-- ==============================================================================
-- Migration 45: Cross-Layer Vehicle Contracts, Make/Model Validation & Scan Concurrency Closure
--
-- Features:
-- 1. Deterministic unique violation handling in api.scan_pass for concurrent duplicate entry of the same plate
-- 2. Authoritative make/model validation (2 to 100 characters) in api.issue_online_pass_v3
-- 3. Check constraint on public.visit_vehicle_declarations(make_model)
-- ==============================================================================

-- 1. Check constraint on visit_vehicle_declarations
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'visit_vehicle_declarations_make_model_len_check'
  ) then
    alter table public.visit_vehicle_declarations
      add constraint visit_vehicle_declarations_make_model_len_check
      check (make_model is null or char_length(btrim(make_model)) between 2 and 100);
  end if;
end $$;

-- 2. Update api.scan_pass to gracefully capture unique violation on active-inside plate index
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
  target_decl public.visit_vehicle_declarations%rowtype;
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
      -- Check if this pass has a declared vehicle that is already marked inside campus
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

      -- Portal visitors transition directly to 'inside'
      if target.source = 'portal'::public.pass_source then
        -- Atomically record vehicle entry timestamp if declared, catching concurrent race on partial unique index
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

      -- Atomically record vehicle exit timestamp if declared
      update public.visit_vehicle_declarations set
        exit_recorded_at = coalesce(exit_recorded_at, now()),
        exit_scanned_at = coalesce(exit_scanned_at, now())
      where visit_vehicle_declarations.pass_id = target.id;

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

-- 3. Update api.issue_online_pass_v3 with authoritative vehicle make/model requirement
create or replace function api.issue_online_pass_v3(
  requested_actor_id uuid,
  requested_registration_mode text,
  requested_request_id uuid,
  requested_first_name text,
  requested_middle_name text,
  requested_last_name text,
  requested_contact_number text,
  requested_home_address text,
  requested_purpose text,
  requested_visit_date date,
  requested_photo_intent_id uuid,
  requested_photo_bytes integer,
  requested_photo_sha256 text,
  requested_id_intent_id uuid,
  requested_id_bytes integer,
  requested_id_sha256 text,
  requested_token_digest text,
  requested_arrival_mode text,
  -- Address provenance parameters:
  requested_address_provider text,
  requested_address_place_id text,
  requested_address_result_type text,
  requested_address_confidence numeric,
  requested_address_lat double precision,
  requested_address_lon double precision,
  requested_address_city text,
  requested_address_state text,
  requested_address_postcode text,
  requested_address_country_code text,
  requested_address_detail text default null,
  -- Vehicle declaration parameters:
  requested_vehicle_type text default null,
  requested_plate_number text default null,
  requested_plate_key text default null,
  requested_color text default null,
  requested_make_model text default null,
  requested_vehicle_catalog_status text default 'catalog',
  requested_vehicle_photo_intent_id uuid default null,
  requested_vehicle_photo_bytes integer default null,
  requested_vehicle_photo_sha256 text default null,
  -- Returning parameters:
  requested_saved_vehicle_id uuid default null,
  requested_returning_profile_id uuid default null,
  requested_returning_match_token_digest text default null
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
  vehicle_photo_intent public.upload_intents%rowtype;
  verification_record public.portal_identity_verification_attempts%rowtype;
  returning_attempt_record public.returning_identity_attempts%rowtype;
  returning_profile_record public.returning_visitor_profiles%rowtype;
  existing_pass public.passes%rowtype;
  existing_visitor public.visitors%rowtype;
  existing_decl public.visit_vehicle_declarations%rowtype;
  new_visitor_id uuid;
  new_pass_id uuid;
  new_public_reference uuid;
  new_vehicle_evidence_id uuid := null;
  starts_at timestamptz;
  ends_at timestamptz;
  full_name_calc text;
  v_plate_conflict boolean := false;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'service role required';
  end if;

  -- 1. Actor verification: must be anonymous portal visitor
  if not exists (
    select 1 from auth.users u
    where u.id = requested_actor_id and coalesce(u.is_anonymous, false) = true
  ) or exists (select 1 from public.staff_profiles where user_id = requested_actor_id)
    or exists (select 1 from public.devices where user_id = requested_actor_id) then
    raise exception using errcode = '42501', message = 'anonymous visitor identity required';
  end if;

  -- Validate registration mode and explicit arrival mode parameters
  if requested_registration_mode not in ('new', 'returning') then
    raise exception using errcode = '22023', message = 'invalid registration mode';
  end if;
  if requested_arrival_mode not in ('no_vehicle', 'vehicle') then
    raise exception using errcode = '22023', message = 'invalid arrival mode: explicit selection required';
  end if;

  full_name_calc := btrim(concat_ws(' ', nullif(btrim(requested_first_name), ''), nullif(btrim(requested_middle_name), ''), nullif(btrim(requested_last_name), '')));

  -- 2. Advisory lock for idempotency serialization
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(requested_request_id::text, 0));

  select * into existing_pass from public.passes
  where issue_request_id = requested_request_id;

  if found then
    select * into existing_visitor from public.visitors
    where id = existing_pass.visitor_id;

    if not found or existing_visitor.owner_id <> requested_actor_id or existing_visitor.source <> 'portal'::public.pass_source then
      raise exception using errcode = '42501', message = 'idempotency actor mismatch';
    end if;

    select * into existing_decl from public.visit_vehicle_declarations
    where visit_vehicle_declarations.pass_id = existing_pass.id;

    -- Strict idempotency check
    if existing_visitor.registration_mode <> requested_registration_mode
      or existing_visitor.full_name <> full_name_calc
      or existing_visitor.contact_number <> btrim(requested_contact_number)
      or coalesce(existing_visitor.home_address, '') <> btrim(requested_home_address)
      or existing_visitor.purpose <> btrim(requested_purpose)
      or existing_visitor.visit_date <> requested_visit_date
      or existing_visitor.arrival_mode <> requested_arrival_mode
      or (requested_arrival_mode = 'vehicle' and (
          existing_decl.plate_key is null
          or existing_decl.plate_key <> requested_plate_key
          or existing_decl.vehicle_type <> requested_vehicle_type
      ))
      or (requested_registration_mode = 'returning' and (
          existing_visitor.returning_profile_id is null
          or existing_visitor.returning_profile_id <> requested_returning_profile_id
      ))
    then
      raise exception using errcode = '42501', message = 'idempotency conflict with existing pass';
    end if;

    pass_id := existing_pass.id;
    public_reference := existing_pass.public_reference;
    valid_from := existing_pass.valid_from;
    valid_until := existing_pass.valid_until;
    return next;
    return;
  end if;

  -- 3. Settings & Window checks
  select * into settings from public.app_settings where singleton for share;
  if requested_visit_date < (now() at time zone settings.timezone)::date
    or requested_visit_date > (now() at time zone settings.timezone)::date + settings.scheduling_days_ahead then
    raise exception using errcode = '22023', message = 'visit date outside scheduling window';
  end if;

  -- 4. Field validation
  if char_length(btrim(requested_first_name)) < 1
    or char_length(btrim(requested_last_name)) < 1
    or char_length(full_name_calc) not between 2 and 160
    or char_length(btrim(requested_contact_number)) not between 7 and 32
    or char_length(btrim(requested_home_address)) not between 5 and 300
    or char_length(btrim(requested_purpose)) not between 3 and 300 then
    raise exception using errcode = '22023', message = 'invalid visitor details';
  end if;

  -- Canonical Philippine Phone Check: +639XXXXXXXXX (13 chars)
  if requested_contact_number !~ '^\+639[0-9]{9}$' then
    raise exception using errcode = '22023', message = 'invalid philippine mobile number';
  end if;

  -- Address provenance validation
  if requested_address_provider is null or requested_address_provider <> 'geoapify'
    or requested_address_place_id is null or char_length(btrim(requested_address_place_id)) < 3
    or requested_address_country_code is null or lower(requested_address_country_code) <> 'ph'
    or requested_address_lat is null or requested_address_lon is null then
    raise exception using errcode = '22023', message = 'valid verified address provenance required';
  end if;

  -- Arrival mode invariants
  if requested_arrival_mode = 'no_vehicle' then
    if requested_vehicle_type is not null
      or requested_plate_number is not null
      or requested_plate_key is not null
      or requested_color is not null
      or requested_make_model is not null
      or requested_vehicle_photo_intent_id is not null then
      raise exception using errcode = '22023', message = 'vehicle details not permitted for pedestrian arrival';
    end if;
  elsif requested_arrival_mode = 'vehicle' then
    if requested_vehicle_type is null or requested_vehicle_type not in ('car', 'motorcycle', 'van', 'pickup', 'suv', 'truck', 'other')
      or requested_plate_number is null or char_length(btrim(requested_plate_number)) not between 3 and 16
      or requested_plate_key is null or char_length(btrim(requested_plate_key)) not between 3 and 16
      or requested_color is null or char_length(btrim(requested_color)) not between 2 and 40
      or requested_make_model is null or char_length(btrim(requested_make_model)) not between 2 and 100
      or requested_vehicle_catalog_status not in ('catalog', 'manual') then
      raise exception using errcode = '22023', message = 'invalid vehicle declaration details';
    end if;

    if requested_vehicle_photo_intent_id is null then
      raise exception using errcode = '22023', message = 'vehicle photo required for vehicle arrival';
    end if;

    select * into vehicle_photo_intent from public.upload_intents
    where id = requested_vehicle_photo_intent_id for update;
    if not found or vehicle_photo_intent.owner_id <> requested_actor_id
      or vehicle_photo_intent.source <> 'portal'::public.pass_source
      or vehicle_photo_intent.kind <> 'vehicle_photo'::public.evidence_kind
      or vehicle_photo_intent.status <> 'pending'::public.upload_intent_status
      or vehicle_photo_intent.expires_at <= now()
      or requested_vehicle_photo_bytes not between 1 and vehicle_photo_intent.max_bytes
      or requested_vehicle_photo_sha256 !~ '^[0-9a-f]{64}$' then
      raise exception using errcode = '22023', message = 'invalid vehicle photo upload intent';
    end if;

    -- Check if another active pass has declared the same plate_key
    select exists (
      select 1 from public.visit_vehicle_declarations vd
      join public.passes p on p.id = vd.pass_id
      where vd.plate_key = requested_plate_key
        and p.valid_until > now()
        and p.status in ('issued', 'pending', 'inside')
    ) into v_plate_conflict;
  end if;

  -- 5. Mode-specific Verification Checks
  if requested_registration_mode = 'new' then
    if requested_id_intent_id is null then
      raise exception using errcode = '22023', message = 'identification image required';
    end if;

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
  elsif requested_registration_mode = 'returning' then
    if requested_returning_profile_id is null or requested_returning_match_token_digest is null then
      raise exception using errcode = '22023', message = 'returning match credentials required';
    end if;

    select * into returning_profile_record
    from public.returning_visitor_profiles
    where id = requested_returning_profile_id and revoked_at is null and expires_at > now();

    if not found then
      raise exception using errcode = '42501', message = 'returning profile not found or expired';
    end if;

    select * into returning_attempt_record
    from public.returning_identity_attempts
    where owner_id = requested_actor_id
      and request_id = requested_request_id::text
      and matched_profile_id = requested_returning_profile_id
      and match_token_digest = requested_returning_match_token_digest
      and outcome = 'matched'
      and expires_at > now()
    order by created_at desc
    limit 1;

    if not found then
      raise exception using errcode = '42501', message = 'valid returning identity match required';
    end if;
  end if;

  -- 6. Photo upload intent inspection
  select * into photo_intent from public.upload_intents
  where id = requested_photo_intent_id for update;
  if not found or photo_intent.owner_id <> requested_actor_id
    or photo_intent.source <> 'portal'::public.pass_source or photo_intent.kind <> 'photo'::public.evidence_kind
    or photo_intent.status <> 'pending'::public.upload_intent_status or photo_intent.expires_at <= now()
    or requested_photo_bytes not between 1 and photo_intent.max_bytes
    or requested_photo_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'invalid photo upload intent';
  end if;

  -- 7. ID upload intent inspection (if new)
  if requested_registration_mode = 'new' then
    select * into id_intent from public.upload_intents
    where id = requested_id_intent_id for update;
    if not found or id_intent.owner_id <> requested_actor_id
      or id_intent.source <> 'portal'::public.pass_source or id_intent.kind <> 'id'::public.evidence_kind
      or id_intent.status <> 'pending'::public.upload_intent_status or id_intent.expires_at <= now()
      or requested_id_bytes not between 1 and id_intent.max_bytes
      or requested_id_sha256 !~ '^[0-9a-f]{64}$' then
      raise exception using errcode = '22023', message = 'invalid identification upload intent';
    end if;
  end if;

  starts_at := (requested_visit_date + settings.working_hours_start) at time zone settings.timezone;
  ends_at := (requested_visit_date + settings.working_hours_end) at time zone settings.timezone;

  -- 8. Insert visitor record with verified address provenance
  insert into public.visitors (
    owner_id, source, created_by_device_id, full_name, contact_number,
    home_address, registration_mode, arrival_mode, returning_profile_id,
    purpose, visit_date, consent_accepted_at,
    identity_verification_id, identity_verified_at, returning_identity_attempt_id,
    address_provider, address_place_id, address_result_type, address_confidence,
    address_lat, address_lon, address_city, address_state, address_postcode,
    address_country_code, address_verified_at, address_detail
  ) values (
    requested_actor_id, 'portal'::public.pass_source, null,
    full_name_calc, btrim(requested_contact_number),
    btrim(requested_home_address), requested_registration_mode, requested_arrival_mode,
    case when requested_registration_mode = 'returning' then requested_returning_profile_id else null end,
    btrim(requested_purpose), requested_visit_date, now(),
    case when requested_registration_mode = 'new' then verification_record.id else null end,
    case when requested_registration_mode = 'new' then verification_record.verified_at else null end,
    case when requested_registration_mode = 'returning' then returning_attempt_record.id else null end,
    requested_address_provider, requested_address_place_id, requested_address_result_type, requested_address_confidence,
    requested_address_lat, requested_address_lon, requested_address_city, requested_address_state, requested_address_postcode,
    requested_address_country_code, now(), requested_address_detail
  ) returning id into new_visitor_id;

  -- 9. Insert visitor photo evidence and claim upload intent
  insert into public.visitor_evidence (
    visitor_id, upload_intent_id, kind, bucket_id, object_path, content_type,
    byte_size, sha256_hex, verified_at, expires_at
  ) values (
    new_visitor_id, photo_intent.id, photo_intent.kind, photo_intent.bucket_id,
    photo_intent.object_path, photo_intent.content_type, requested_photo_bytes,
    requested_photo_sha256, now(), greatest(
      now() + make_interval(days => settings.image_retention_days),
      ends_at + interval '1 day'
    )
  );
  update public.upload_intents set status = 'claimed', claimed_at = now(), visitor_id = new_visitor_id
  where id = photo_intent.id;

  -- 10. Insert visitor id evidence if new
  if requested_registration_mode = 'new' and requested_id_intent_id is not null then
    insert into public.visitor_evidence (
      visitor_id, upload_intent_id, kind, bucket_id, object_path, content_type,
      byte_size, sha256_hex, verified_at, expires_at
    ) values (
      new_visitor_id, id_intent.id, id_intent.kind, id_intent.bucket_id,
      id_intent.object_path, id_intent.content_type, requested_id_bytes,
      requested_id_sha256, now(), greatest(
        now() + make_interval(days => settings.image_retention_days),
        ends_at + interval '1 day'
      )
    );
    update public.upload_intents set status = 'claimed', claimed_at = now(), visitor_id = new_visitor_id
    where id = id_intent.id;
  end if;

  -- 11. Insert vehicle photo evidence if vehicle
  if requested_arrival_mode = 'vehicle' and requested_vehicle_photo_intent_id is not null then
    insert into public.visitor_evidence (
      visitor_id, upload_intent_id, kind, bucket_id, object_path, content_type,
      byte_size, sha256_hex, verified_at, expires_at
    ) values (
      new_visitor_id, vehicle_photo_intent.id, vehicle_photo_intent.kind, vehicle_photo_intent.bucket_id,
      vehicle_photo_intent.object_path, vehicle_photo_intent.content_type, requested_vehicle_photo_bytes,
      requested_vehicle_photo_sha256, now(), greatest(
        now() + make_interval(days => settings.image_retention_days),
        ends_at + interval '1 day'
      )
    ) returning id into new_vehicle_evidence_id;

    update public.upload_intents set status = 'claimed', claimed_at = now(), visitor_id = new_visitor_id
    where id = vehicle_photo_intent.id;
  end if;

  -- 12. Insert pass record
  insert into public.passes (
    visitor_id, token_digest, source, status, valid_from, valid_until, issue_request_id
  ) values (
    new_visitor_id, decode(requested_token_digest, 'hex'), 'portal'::public.pass_source, 'issued',
    starts_at, ends_at, requested_request_id
  ) returning id, passes.public_reference into new_pass_id, new_public_reference;

  -- 13. Insert visit vehicle declaration if arrival_mode = vehicle
  if requested_arrival_mode = 'vehicle' then
    insert into public.visit_vehicle_declarations (
      visitor_id, pass_id, saved_vehicle_id, vehicle_type,
      plate_number, plate_key, color, make_model,
      vehicle_photo_evidence_id, vehicle_catalog_status, plate_conflict_flag
    ) values (
      new_visitor_id, new_pass_id, requested_saved_vehicle_id, requested_vehicle_type,
      btrim(requested_plate_number), btrim(requested_plate_key), btrim(requested_color),
      btrim(requested_make_model),
      new_vehicle_evidence_id, requested_vehicle_catalog_status, v_plate_conflict
    );
  end if;

  pass_id := new_pass_id;
  public_reference := new_public_reference;
  valid_from := starts_at;
  valid_until := ends_at;
  return next;
end;
$$;

revoke all on function api.issue_online_pass_v3(
  uuid, text, uuid, text, text, text, text, text, text, date,
  uuid, integer, text, uuid, integer, text, text, text,
  text, text, text, numeric, double precision, double precision,
  text, text, text, text, text,
  text, text, text, text, text, text, uuid, integer, text,
  uuid, uuid, text
) from public, anon, authenticated;
grant execute on function api.issue_online_pass_v3(
  uuid, text, uuid, text, text, text, text, text, text, date,
  uuid, integer, text, uuid, integer, text, text, text,
  text, text, text, numeric, double precision, double precision,
  text, text, text, text, text,
  text, text, text, text, text, text, uuid, integer, text,
  uuid, uuid, text
) to service_role;
