-- Migration 59: Ephemeral Returning Verification & Automatic Returning Profile Linkage
-- 1. Updates api.issue_online_pass_v6 so returning visitor selfies are purely ephemeral:
--    - When requested_registration_mode = 'returning', photo_intent_id and id_intent_id are optional/null.
--    - No upload intent check or claim, and no visitor_evidence insert occurs for the ephemeral selfie.
-- 2. When requested_registration_mode = 'new', automatically ensures a returning_visitor_profiles record
--    is created or updated and linked to visitors.returning_profile_id (without requiring persistent biometric templates).
-- 3. Adds requested_save_vehicle parameter to allow vehicle saving to operate independently when arrivalMode = 'vehicle'.
-- 4. Ensures historical portrait and ID evidence remain intact under the institutional data retention policy.

drop function if exists api.issue_online_pass_v6;

create or replace function api.issue_online_pass_v6(
  requested_actor_id uuid,
  requested_registration_mode text,
  requested_request_id uuid,
  requested_first_name text,
  requested_middle_name text,
  requested_last_name text,
  requested_contact_number text,
  requested_purpose text,
  requested_visit_date date,
  requested_photo_intent_id uuid default null,
  requested_photo_bytes integer default null,
  requested_photo_sha256 text default null,
  requested_id_intent_id uuid default null,
  requested_id_bytes integer default null,
  requested_id_sha256 text default null,
  requested_token_digest text default null,
  requested_arrival_mode text default 'no_vehicle',
  -- Structured PSGC Residential Address
  requested_psgc_version text default '2026-q3',
  requested_psgc_region_code text default null,
  requested_psgc_province_code text default null,
  requested_psgc_city_code text default null,
  requested_psgc_barangay_code text default null,
  requested_home_building text default null,
  requested_home_street text default null,
  requested_postal_code text default null,
  requested_postal_code_source text default null,
  -- Legacy / optional coordinates
  requested_home_location_lat numeric(6,3) default null,
  requested_home_location_lon numeric(6,3) default null,
  -- Vehicle declaration parameters
  requested_vehicle_type text default null,
  requested_plate_number text default null,
  requested_plate_key text default null,
  requested_color text default null,
  requested_make_model text default null,
  requested_vehicle_catalog_status text default 'catalog',
  requested_vehicle_photo_intent_id uuid default null,
  requested_vehicle_photo_bytes integer default null,
  requested_vehicle_photo_sha256 text default null,
  -- Returning parameters
  requested_saved_vehicle_id uuid default null,
  requested_returning_profile_id uuid default null,
  requested_returning_match_token_digest text default null,
  requested_save_vehicle boolean default false
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
  version_rec public.psgc_reference_versions%rowtype;
  region_rec public.psgc_locations%rowtype;
  province_rec public.psgc_locations%rowtype;
  city_rec public.psgc_locations%rowtype;
  barangay_rec public.psgc_locations%rowtype;
  region_has_provinces boolean;
  v_region_name text;
  v_province_name text := null;
  v_city_name text;
  v_barangay_name text;
  effective_home_address text;
  returning_profile_id_resolved uuid := null;
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

  if requested_registration_mode not in ('new', 'returning') then
    raise exception using errcode = '22023', message = 'invalid registration mode';
  end if;
  if requested_arrival_mode not in ('no_vehicle', 'vehicle') then
    raise exception using errcode = '22023', message = 'invalid arrival mode: explicit selection required';
  end if;

  full_name_calc := btrim(concat_ws(' ', nullif(btrim(requested_first_name), ''), nullif(btrim(requested_middle_name), ''), nullif(btrim(requested_last_name), '')));

  -- Map legacy synthetic Manila barangays to official active PSA counterparts early
  if requested_psgc_barangay_code = '1380600408' then requested_psgc_barangay_code := '1380606014';
  elsif requested_psgc_barangay_code = '1380600409' then requested_psgc_barangay_code := '1380606015';
  elsif requested_psgc_barangay_code = '1380600410' then requested_psgc_barangay_code := '1380606016';
  elsif requested_psgc_barangay_code = '1380600411' then requested_psgc_barangay_code := '1380606017';
  elsif requested_psgc_barangay_code = '1380600412' then requested_psgc_barangay_code := '1380606018';
  elsif requested_psgc_barangay_code = '1380600413' then requested_psgc_barangay_code := '1380606019';
  elsif requested_psgc_barangay_code = '1380600414' then requested_psgc_barangay_code := '1380606020';
  elsif requested_psgc_barangay_code = '1380600415' then requested_psgc_barangay_code := '1380606021';
  elsif requested_psgc_barangay_code = '1380600587' then requested_psgc_barangay_code := '1380606193';
  elsif requested_psgc_barangay_code = '1380600588' then requested_psgc_barangay_code := '1380606195';
  elsif requested_psgc_barangay_code = '1380600629' then requested_psgc_barangay_code := '1380606236';
  elsif requested_psgc_barangay_code = '1380600830' then requested_psgc_barangay_code := '1380611045';
  elsif requested_psgc_barangay_code = '1380600831' then requested_psgc_barangay_code := '1380611046';
  elsif requested_psgc_barangay_code = '1380600659' then requested_psgc_barangay_code := '1380608001';
  elsif requested_psgc_barangay_code = '1380600660' then requested_psgc_barangay_code := '1380608003';
  elsif requested_psgc_barangay_code = '1380600661' then requested_psgc_barangay_code := '1380608005';
  elsif requested_psgc_barangay_code = '1380600667' then requested_psgc_barangay_code := '1380608009';
  elsif requested_psgc_barangay_code = '1380600696' then requested_psgc_barangay_code := '1380610011';
  elsif requested_psgc_barangay_code = '1380600697' then requested_psgc_barangay_code := '1380610012';
  elsif requested_psgc_barangay_code = '1380600700' then requested_psgc_barangay_code := '1380610015';
  elsif requested_psgc_barangay_code = '1380600821' then requested_psgc_barangay_code := '1380611036';
  elsif requested_psgc_barangay_code = '1380600822' then requested_psgc_barangay_code := '1380611037';
  elsif requested_psgc_barangay_code = '1380600823' then requested_psgc_barangay_code := '1380611038';
  elsif requested_psgc_barangay_code = '1380600287' then requested_psgc_barangay_code := '1380602001';
  elsif requested_psgc_barangay_code = '1380600306' then requested_psgc_barangay_code := '1380603015';
  end if;

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

    -- Strict idempotency check (including PSGC symmetry)
    if existing_visitor.registration_mode <> requested_registration_mode
      or existing_visitor.full_name <> full_name_calc
      or existing_visitor.contact_number <> btrim(requested_contact_number)
      or existing_visitor.purpose <> btrim(requested_purpose)
      or existing_visitor.visit_date <> requested_visit_date
      or existing_visitor.arrival_mode <> requested_arrival_mode
      or (existing_visitor.psgc_region_code is distinct from requested_psgc_region_code)
      or (existing_visitor.psgc_province_code is distinct from requested_psgc_province_code)
      or (existing_visitor.psgc_city_code is distinct from requested_psgc_city_code)
      or (existing_visitor.psgc_barangay_code is distinct from requested_psgc_barangay_code)
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
    or char_length(btrim(requested_purpose)) not between 3 and 300 then
    raise exception using errcode = '22023', message = 'invalid visitor details';
  end if;

  if requested_contact_number !~ '^\+639[0-9]{9}$' then
    raise exception using errcode = '22023', message = 'invalid philippine mobile number';
  end if;

  -- 5. Server-side Geographic & PSGC Validation
  if requested_psgc_region_code is null or requested_psgc_city_code is null or requested_psgc_barangay_code is null then
    raise exception using errcode = '22023', message = 'structured psgc residential address required';
  end if;

  -- 5.1 Dataset Version Check
  select * into version_rec from public.psgc_reference_versions
  where id = coalesce(requested_psgc_version, '2026-q3') and is_active = true;
  if not found then
    raise exception using errcode = '22023', message = 'invalid or inactive psgc dataset version';
  end if;

  -- 5.2 Region Check
  select * into region_rec from public.psgc_locations
  where psgc_code = requested_psgc_region_code and level = 'region' and is_active = true;
  if not found then
    raise exception using errcode = '22023', message = 'invalid psgc region';
  end if;
  v_region_name := region_rec.name;

  -- Check if region has provinces
  select exists (
    select 1 from public.psgc_locations
    where parent_psgc_code = requested_psgc_region_code and level = 'province' and is_active = true
  ) into region_has_provinces;

  -- 5.3 Province Check
  if region_has_provinces then
    if requested_psgc_province_code is null then
      raise exception using errcode = '22023', message = 'psgc province code required for region';
    end if;
    select * into province_rec from public.psgc_locations
    where psgc_code = requested_psgc_province_code
      and level = 'province'
      and parent_psgc_code = requested_psgc_region_code
      and is_active = true;
    if not found then
      raise exception using errcode = '22023', message = 'psgc province does not belong to selected region';
    end if;
    v_province_name := province_rec.name;
  else
    if requested_psgc_province_code is not null then
      raise exception using errcode = '22023', message = 'psgc province not permitted for region with no provinces';
    end if;
  end if;

  -- 5.4 City / Municipality Check
  select * into city_rec from public.psgc_locations
  where psgc_code = requested_psgc_city_code
    and level in ('city', 'municipality')
    and is_active = true;
  if not found then
    raise exception using errcode = '22023', message = 'invalid psgc city or municipality';
  end if;

  if region_has_provinces then
    if city_rec.parent_psgc_code <> requested_psgc_province_code then
      raise exception using errcode = '22023', message = 'psgc city/municipality does not belong to selected province';
    end if;
  else
    if city_rec.parent_psgc_code <> requested_psgc_region_code then
      raise exception using errcode = '22023', message = 'psgc city/municipality does not belong to selected region';
    end if;
  end if;
  v_city_name := city_rec.name;

  -- 5.5 Barangay Check
  select * into barangay_rec from public.psgc_locations
  where psgc_code = requested_psgc_barangay_code
    and level = 'barangay'
    and parent_psgc_code = requested_psgc_city_code
    and is_active = true;
  if not found then
    raise exception using errcode = '22023', message = 'psgc barangay does not belong to selected city/municipality';
  end if;
  v_barangay_name := barangay_rec.name;

  -- 5.6 Postal Code Format Check (optional)
  if requested_postal_code is not null and btrim(requested_postal_code) !~ '^[0-9]{4}$' then
    raise exception using errcode = '22023', message = 'invalid philippine 4-digit postal code';
  end if;

  -- 5.7 Compose Snapshot Address
  effective_home_address := concat_ws(', ',
    nullif(btrim(requested_home_building), ''),
    nullif(btrim(requested_home_street), ''),
    v_barangay_name,
    v_city_name,
    v_province_name,
    v_region_name,
    case when nullif(btrim(requested_postal_code), '') is not null then concat('Postal Code ', btrim(requested_postal_code)) else null end
  );

  -- 6. Arrival mode invariants
  if requested_arrival_mode = 'no_vehicle' then
    if requested_vehicle_type is not null
      or requested_plate_number is not null
      or requested_plate_key is not null
      or requested_color is not null
      or requested_vehicle_photo_intent_id is not null then
      raise exception using errcode = '22023', message = 'vehicle details not permitted for pedestrian arrival';
    end if;
  elsif requested_arrival_mode = 'vehicle' then
    if requested_vehicle_type is null or requested_vehicle_type not in ('car', 'motorcycle', 'van', 'pickup', 'suv', 'truck', 'other')
      or requested_plate_number is null or char_length(btrim(requested_plate_number)) not between 3 and 16
      or requested_plate_key is null or char_length(btrim(requested_plate_key)) not between 3 and 16
      or requested_color is null or char_length(btrim(requested_color)) not between 2 and 40
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

    select exists (
      select 1 from public.visit_vehicle_declarations vd
      join public.passes p on p.id = vd.pass_id
      where vd.plate_key = requested_plate_key
        and p.valid_until > now()
        and p.status in ('issued', 'pending', 'inside')
    ) into v_plate_conflict;
  end if;

  -- 7. Verification checks
  if requested_registration_mode = 'new' then
    if requested_photo_intent_id is null then
      raise exception using errcode = '22023', message = 'photo upload intent required for new visitor';
    end if;
    if requested_id_intent_id is null then
      raise exception using errcode = '22023', message = 'identification image required for new visitor';
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

    -- Inspect photo upload intent for new visitor
    select * into photo_intent from public.upload_intents
    where id = requested_photo_intent_id for update;
    if not found or photo_intent.owner_id <> requested_actor_id
      or photo_intent.source <> 'portal'::public.pass_source or photo_intent.kind <> 'photo'::public.evidence_kind
      or photo_intent.status <> 'pending'::public.upload_intent_status or photo_intent.expires_at <= now()
      or requested_photo_bytes not between 1 and photo_intent.max_bytes
      or requested_photo_sha256 !~ '^[0-9a-f]{64}$' then
      raise exception using errcode = '22023', message = 'invalid photo upload intent';
    end if;

    -- Inspect ID upload intent for new visitor
    select * into id_intent from public.upload_intents
    where id = requested_id_intent_id for update;
    if not found or id_intent.owner_id <> requested_actor_id
      or id_intent.source <> 'portal'::public.pass_source or id_intent.kind <> 'id'::public.evidence_kind
      or id_intent.status <> 'pending'::public.upload_intent_status or id_intent.expires_at <= now()
      or requested_id_bytes not between 1 and id_intent.max_bytes
      or requested_id_sha256 !~ '^[0-9a-f]{64}$' then
      raise exception using errcode = '22023', message = 'invalid identification upload intent';
    end if;

    -- Automatic Returning Visitor Profile Linkage for New Visitor
    select id into returning_profile_id_resolved
    from public.returning_visitor_profiles
    where lower(first_name) = lower(btrim(requested_first_name))
      and lower(last_name) = lower(btrim(requested_last_name))
      and contact_number_e164 = btrim(requested_contact_number)
      and revoked_at is null
    order by created_at desc
    limit 1;

    if returning_profile_id_resolved is null then
      insert into public.returning_visitor_profiles (
        first_name, middle_name, last_name, contact_number_e164,
        home_address, home_location_lat, home_location_lon,
        psgc_version, psgc_region_code, psgc_province_code, psgc_city_code, psgc_barangay_code,
        psgc_region_name, psgc_province_name, psgc_city_municipality_name, psgc_barangay_name,
        home_building, home_street, postal_code, postal_code_source,
        consent_accepted_at, consent_version, expires_at
      ) values (
        btrim(requested_first_name), nullif(btrim(requested_middle_name), ''), btrim(requested_last_name), btrim(requested_contact_number),
        effective_home_address, requested_home_location_lat, requested_home_location_lon,
        version_rec.id, requested_psgc_region_code, requested_psgc_province_code, requested_psgc_city_code, requested_psgc_barangay_code,
        v_region_name, v_province_name, v_city_name, v_barangay_name,
        nullif(btrim(requested_home_building), ''), nullif(btrim(requested_home_street), ''),
        nullif(btrim(requested_postal_code), ''), nullif(btrim(requested_postal_code_source), ''),
        now(), 'v1', now() + interval '365 days'
      ) returning id into returning_profile_id_resolved;
    else
      update public.returning_visitor_profiles
      set last_used_at = now(),
          updated_at = now(),
          expires_at = greatest(expires_at, now() + interval '365 days'),
          psgc_version = coalesce(version_rec.id, psgc_version),
          psgc_region_code = coalesce(requested_psgc_region_code, psgc_region_code),
          psgc_province_code = coalesce(requested_psgc_province_code, psgc_province_code),
          psgc_city_code = coalesce(requested_psgc_city_code, psgc_city_code),
          psgc_barangay_code = coalesce(requested_psgc_barangay_code, psgc_barangay_code),
          psgc_region_name = coalesce(v_region_name, psgc_region_name),
          psgc_province_name = coalesce(v_province_name, psgc_province_name),
          psgc_city_municipality_name = coalesce(v_city_name, psgc_city_municipality_name),
          psgc_barangay_name = coalesce(v_barangay_name, psgc_barangay_name),
          home_building = coalesce(nullif(btrim(requested_home_building), ''), home_building),
          home_street = coalesce(nullif(btrim(requested_home_street), ''), home_street),
          postal_code = coalesce(nullif(btrim(requested_postal_code), ''), postal_code),
          postal_code_source = coalesce(nullif(btrim(requested_postal_code_source), ''), postal_code_source),
          home_address = coalesce(effective_home_address, home_address)
      where id = returning_profile_id_resolved;
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

    returning_profile_id_resolved := requested_returning_profile_id;

    -- Update returning profile with latest verified contact & address details
    update public.returning_visitor_profiles
    set last_used_at = now(),
        updated_at = now(),
        expires_at = greatest(expires_at, now() + interval '365 days'),
        contact_number_e164 = btrim(requested_contact_number),
        psgc_version = coalesce(version_rec.id, psgc_version),
        psgc_region_code = coalesce(requested_psgc_region_code, psgc_region_code),
        psgc_province_code = coalesce(requested_psgc_province_code, psgc_province_code),
        psgc_city_code = coalesce(requested_psgc_city_code, psgc_city_code),
        psgc_barangay_code = coalesce(requested_psgc_barangay_code, psgc_barangay_code),
        psgc_region_name = coalesce(v_region_name, psgc_region_name),
        psgc_province_name = coalesce(v_province_name, psgc_province_name),
        psgc_city_municipality_name = coalesce(v_city_name, psgc_city_municipality_name),
        psgc_barangay_name = coalesce(v_barangay_name, psgc_barangay_name),
        home_building = coalesce(nullif(btrim(requested_home_building), ''), home_building),
        home_street = coalesce(nullif(btrim(requested_home_street), ''), home_street),
        postal_code = coalesce(nullif(btrim(requested_postal_code), ''), postal_code),
        postal_code_source = coalesce(nullif(btrim(requested_postal_code_source), ''), postal_code_source),
        home_address = coalesce(effective_home_address, home_address)
    where id = returning_profile_id_resolved;
  end if;

  starts_at := (requested_visit_date + settings.working_hours_start) at time zone settings.timezone;
  ends_at := (requested_visit_date + settings.working_hours_end) at time zone settings.timezone;

  -- 8. Insert visitor record with structured PSGC address and snapshots
  insert into public.visitors (
    owner_id, source, created_by_device_id, full_name, contact_number,
    home_address, home_location_lat, home_location_lon,
    psgc_version, psgc_region_code, psgc_province_code, psgc_city_code, psgc_barangay_code,
    psgc_region_name, psgc_province_name, psgc_city_municipality_name, psgc_barangay_name,
    home_building, home_street, postal_code, postal_code_source,
    registration_mode, arrival_mode, returning_profile_id,
    purpose, visit_date, consent_accepted_at,
    identity_verification_id, identity_verified_at, returning_identity_attempt_id
  ) values (
    requested_actor_id, 'portal'::public.pass_source, null,
    full_name_calc, btrim(requested_contact_number),
    effective_home_address, requested_home_location_lat, requested_home_location_lon,
    version_rec.id, requested_psgc_region_code, requested_psgc_province_code, requested_psgc_city_code, requested_psgc_barangay_code,
    v_region_name, v_province_name, v_city_name, v_barangay_name,
    nullif(btrim(requested_home_building), ''), nullif(btrim(requested_home_street), ''),
    nullif(btrim(requested_postal_code), ''), nullif(btrim(requested_postal_code_source), ''),
    requested_registration_mode, requested_arrival_mode,
    returning_profile_id_resolved,
    btrim(requested_purpose), requested_visit_date, now(),
    case when requested_registration_mode = 'new' then verification_record.id else null end,
    case when requested_registration_mode = 'new' then verification_record.verified_at else null end,
    case when requested_registration_mode = 'returning' then returning_attempt_record.id else null end
  ) returning id into new_visitor_id;

  -- 9. Insert visitor photo evidence if new
  if requested_registration_mode = 'new' and requested_photo_intent_id is not null then
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
  end if;

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

  -- 11. Vehicle photo evidence and declaration
  if requested_arrival_mode = 'vehicle' then
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

  -- 12. Optional vehicle saving to profile
  if coalesce(requested_save_vehicle, false) = true and requested_arrival_mode = 'vehicle' and returning_profile_id_resolved is not null then
    if not exists (
      select 1 from public.returning_visitor_vehicles
      where profile_id = returning_profile_id_resolved
        and plate_key = requested_plate_key
        and archived_at is null
    ) then
      insert into public.returning_visitor_vehicles (
        profile_id, vehicle_type, plate_number, plate_key, color, make_model
      ) values (
        returning_profile_id_resolved,
        btrim(requested_vehicle_type),
        btrim(requested_plate_number),
        btrim(requested_plate_key),
        btrim(coalesce(requested_color, '')),
        nullif(btrim(coalesce(requested_make_model, '')), '')
      );
    else
      update public.returning_visitor_vehicles
      set vehicle_type = btrim(requested_vehicle_type),
          plate_number = btrim(requested_plate_number),
          color = btrim(coalesce(requested_color, '')),
          make_model = coalesce(nullif(btrim(coalesce(requested_make_model, '')), ''), make_model),
          last_used_at = now(),
          updated_at = now()
      where profile_id = returning_profile_id_resolved
        and plate_key = requested_plate_key
        and archived_at is null;
    end if;
  end if;

  -- 13. Create Pass Record
  insert into public.passes (
    visitor_id, token_digest, source, status, valid_from, valid_until, issue_request_id
  ) values (
    new_visitor_id, decode(requested_token_digest, 'hex'), 'portal'::public.pass_source, 'issued'::public.pass_status,
    starts_at, ends_at, requested_request_id
  ) returning id, passes.public_reference into new_pass_id, new_public_reference;

  -- 14. Create Vehicle Declaration linked to pass
  if requested_arrival_mode = 'vehicle' then
    insert into public.visit_vehicle_declarations (
      visitor_id, pass_id, saved_vehicle_id, vehicle_type,
      plate_number, plate_key, color, make_model,
      vehicle_photo_evidence_id, vehicle_catalog_status, plate_conflict_flag
    ) values (
      new_visitor_id, new_pass_id, requested_saved_vehicle_id, requested_vehicle_type,
      btrim(requested_plate_number), btrim(requested_plate_key), btrim(requested_color),
      nullif(btrim(requested_make_model), ''),
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

-- Revoke execute from public/anon/authenticated and grant to service_role
revoke all on function api.issue_online_pass_v6 from public;
revoke all on function api.issue_online_pass_v6 from anon;
revoke all on function api.issue_online_pass_v6 from authenticated;
grant execute on function api.issue_online_pass_v6 to service_role;
