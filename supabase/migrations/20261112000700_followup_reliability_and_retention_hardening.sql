-- Migration 92: Follow-up Reliability, Security & Retention Hardening (Post-M91 Root-Cause Remediation)
-- 1. Retire obsolete 3-arg overload of api.reset_staff_temporary_password(uuid, uuid, uuid)
-- 2. Enforce strict administrator authorization and target restrictions in api.reset_staff_temporary_password
-- 3. Truncate returning_face_templates table to clear all previously persisted embeddings
-- 4. Dynamic returning profile retention & portrait evidence preservation in api.issue_online_pass_v6
-- 5. Protect active returning profile portraits in api.claim_evidence_for_purge
-- 6. Add recovery_sync support for retired emergency devices in api.record_emergency_sync_item
-- 7. Add idempotency and finalized decision conflict protection in api.reconcile_emergency_gate_record

-- ============================================================================
-- 1 & 2. CREDENTIAL RESET AUTHORIZATION HARDENING & OVERLOAD RETIREMENT
-- ============================================================================
drop function if exists api.reset_staff_temporary_password(uuid, uuid, uuid);

create or replace function api.reset_staff_temporary_password(
  requested_actor_id uuid,
  requested_user_id uuid,
  requested_request_id uuid,
  requested_office_id uuid default null
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor_role public.staff_role;
  target_role public.staff_role;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'service role required';
  end if;

  if requested_actor_id = requested_user_id then
    raise exception using errcode = '42501', message = 'cannot reset self';
  end if;

  select role into actor_role from public.staff_profiles
  where user_id = requested_actor_id
    and active
    and not must_change_password
    and privacy_accepted_at is not null;

  if actor_role is null or actor_role not in ('admin'::public.staff_role, 'superadmin'::public.staff_role) then
    raise exception using errcode = '42501', message = 'administrator required';
  end if;

  select role into target_role from public.staff_profiles
  where user_id = requested_user_id and decommissioned_at is null;

  if target_role is null then
    raise exception using errcode = 'P0002', message = 'staff profile not found or decommissioned';
  end if;

  if target_role = 'superadmin'::public.staff_role then
    raise exception using errcode = '42501', message = 'cannot reset superadmin';
  end if;

  if actor_role = 'admin'::public.staff_role then
    if target_role <> 'office_staff'::public.staff_role then
      raise exception using errcode = '42501', message = 'admin may only reset office staff';
    end if;
    if requested_office_id is null then
      raise exception using errcode = '42501', message = 'office_id required for admin reset';
    end if;
  end if;

  -- If an office is specified, verify that the target staff is actually assigned to it
  if requested_office_id is not null then
    if not exists (
      select 1 from public.office_staff_assignments
      where user_id = requested_user_id and office_id = requested_office_id
    ) then
      raise exception using errcode = '42501', message = 'staff not assigned to specified office';
    end if;
  end if;

  update public.staff_profiles
  set must_change_password = true, updated_at = now()
  where user_id = requested_user_id and decommissioned_at is null;

  insert into public.audit_events(actor_id, actor_kind, actor_role, action, target_type, target_id, request_id, after_state)
  values (
    requested_actor_id,
    'staff',
    actor_role::text,
    'office.credentials_reset',
    'staff_profile',
    requested_user_id::text,
    requested_request_id,
    jsonb_build_object(
      'mustChangePassword', true,
      'officeId', requested_office_id
    )
  );
end;
$$;

revoke all on function api.reset_staff_temporary_password(uuid, uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function api.reset_staff_temporary_password(uuid, uuid, uuid, uuid) to service_role;

-- ============================================================================
-- 3. TRUNCATE RETURNING FACE TEMPLATES
-- ============================================================================
truncate table public.returning_face_templates;

-- ============================================================================
-- 4. UPGRADE api.issue_online_pass_v6 WITH DYNAMIC RETENTION & PORTRAIT PRESERVATION
-- ============================================================================
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
  requested_psgc_version text default '2026-q3',
  requested_psgc_region_code text default null,
  requested_psgc_province_code text default null,
  requested_psgc_city_code text default null,
  requested_psgc_barangay_code text default null,
  requested_home_building text default null,
  requested_home_street text default null,
  requested_postal_code text default null,
  requested_postal_code_source text default null,
  requested_home_location_lat numeric(6,3) default null,
  requested_home_location_lon numeric(6,3) default null,
  requested_vehicle_type text default null,
  requested_plate_number text default null,
  requested_plate_key text default null,
  requested_color text default null,
  requested_make_model text default null,
  requested_vehicle_catalog_status text default 'catalog',
  requested_vehicle_photo_intent_id uuid default null,
  requested_vehicle_photo_bytes integer default null,
  requested_vehicle_photo_sha256 text default null,
  requested_saved_vehicle_id uuid default null,
  requested_returning_profile_id uuid default null,
  requested_returning_match_token_digest text default null,
  requested_save_vehicle boolean default false,
  requested_save_profile_updates boolean default false,
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
  target_office public.offices%rowtype;
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
  new_visit_id uuid;
  starts_at timestamptz;
  ends_at timestamptz;
  full_name_calc text;
  v_plate_conflict boolean := false;
  target_closure_title text;
  effective_expected_gate text;
  profile_retention_interval interval;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'service role required';
  end if;

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

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(requested_request_id::text, 0));

  select * into existing_pass from public.passes
  where issue_request_id = requested_request_id;

  if found then
    select * into existing_visitor from public.visitors where id = existing_pass.visitor_id;
    if not found or existing_visitor.owner_id <> requested_actor_id or existing_visitor.source <> 'portal'::public.pass_source then
      raise exception using errcode = '42501', message = 'idempotency actor mismatch';
    end if;

    select * into existing_decl from public.visit_vehicle_declarations where visit_vehicle_declarations.pass_id = existing_pass.id;
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
        existing_decl.vehicle_type is distinct from requested_vehicle_type
        or existing_decl.plate_key is distinct from requested_plate_key
        or existing_decl.color is distinct from requested_color
      )) then
      raise exception using errcode = '22023', message = 'idempotency parameter mismatch';
    end if;

    pass_id := existing_pass.id;
    public_reference := existing_pass.public_reference;
    valid_from := existing_pass.valid_from;
    valid_until := existing_pass.valid_until;
    return next;
    return;
  end if;

  select * into settings from public.app_settings where singleton for share;
  profile_retention_interval := make_interval(days => coalesce(settings.returning_profile_retention_days, 30));

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

  -- Enforce office governance atomically when destination office is selected
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

  if char_length(btrim(requested_first_name)) not between 1 and 50
    or char_length(btrim(requested_last_name)) not between 1 and 50
    or char_length(btrim(requested_contact_number)) not between 7 and 32
    or char_length(btrim(requested_purpose)) not between 3 and 300
    or requested_token_digest !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'invalid pass parameters';
  end if;

  if requested_contact_number !~ '^\+639[0-9]{9}$' then
    raise exception using errcode = '22023', message = 'invalid philippine mobile number';
  end if;

  if requested_psgc_region_code is null or requested_psgc_city_code is null or requested_psgc_barangay_code is null then
    raise exception using errcode = '22023', message = 'structured psgc residential address required';
  end if;

  select * into version_rec from public.psgc_reference_versions
  where id = coalesce(requested_psgc_version, '2026-q3') and is_active = true;
  if not found then
    raise exception using errcode = '22023', message = 'invalid or inactive psgc dataset version';
  end if;

  select * into region_rec from public.psgc_locations
  where psgc_code = requested_psgc_region_code and level = 'region' and is_active = true;
  if not found then raise exception using errcode = '22023', message = 'invalid psgc region'; end if;
  v_region_name := region_rec.name;

  select exists (
    select 1 from public.psgc_locations
    where parent_psgc_code = requested_psgc_region_code and level = 'province' and is_active = true
  ) into region_has_provinces;

  if region_has_provinces then
    if requested_psgc_province_code is null then
      raise exception using errcode = '22023', message = 'psgc province code required for region';
    end if;
    select * into province_rec from public.psgc_locations
    where psgc_code = requested_psgc_province_code
      and parent_psgc_code = requested_psgc_region_code and level = 'province' and is_active = true;
    if not found then raise exception using errcode = '22023', message = 'psgc province does not belong to selected region'; end if;
    v_province_name := province_rec.name;
  else
    if requested_psgc_province_code is not null then
      raise exception using errcode = '22023', message = 'psgc province not permitted for region with no provinces';
    end if;
  end if;

  select * into city_rec from public.psgc_locations
  where psgc_code = requested_psgc_city_code
    and level in ('city', 'municipality') and is_active = true;
  if not found then raise exception using errcode = '22023', message = 'invalid psgc city or municipality'; end if;

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

  select * into barangay_rec from public.psgc_locations
  where psgc_code = requested_psgc_barangay_code
    and parent_psgc_code = requested_psgc_city_code and level = 'barangay' and is_active = true;
  if not found then raise exception using errcode = '22023', message = 'psgc barangay does not belong to selected city/municipality'; end if;
  v_barangay_name := barangay_rec.name;

  if requested_postal_code is not null and btrim(requested_postal_code) !~ '^[0-9]{4}$' then
    raise exception using errcode = '22023', message = 'invalid philippine 4-digit postal code';
  end if;

  effective_home_address := concat_ws(', ',
    nullif(btrim(requested_home_building), ''),
    nullif(btrim(requested_home_street), ''),
    v_barangay_name,
    v_city_name,
    v_province_name,
    v_region_name,
    case when nullif(btrim(requested_postal_code), '') is not null then concat('Postal Code ', btrim(requested_postal_code)) else null end
  );

  if requested_arrival_mode = 'vehicle' then
    if requested_vehicle_type is null or requested_vehicle_type not in ('car', 'motorcycle', 'van', 'pickup', 'suv', 'truck', 'other')
      or requested_plate_number is null or char_length(btrim(requested_plate_number)) not between 3 and 16
      or requested_plate_key is null or char_length(btrim(requested_plate_key)) not between 3 and 16
      or requested_color is null or char_length(btrim(requested_color)) not between 2 and 40
      or requested_vehicle_catalog_status not in ('catalog', 'manual') then
      raise exception using errcode = '22023', message = 'invalid vehicle declaration details';
    end if;

    if requested_vehicle_photo_intent_id is null or requested_vehicle_photo_bytes is null or requested_vehicle_photo_sha256 is null then
      raise exception using errcode = '22023', message = 'vehicle photo required for vehicle arrival mode';
    end if;

    select * into vehicle_photo_intent from public.upload_intents where id = requested_vehicle_photo_intent_id for update;
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

    select * into photo_intent from public.upload_intents where id = requested_photo_intent_id for update;
    if not found or photo_intent.owner_id <> requested_actor_id
      or photo_intent.source <> 'portal'::public.pass_source or photo_intent.kind <> 'photo'::public.evidence_kind
      or photo_intent.status <> 'pending'::public.upload_intent_status or photo_intent.expires_at <= now()
      or requested_photo_bytes not between 1 and photo_intent.max_bytes
      or requested_photo_sha256 !~ '^[0-9a-f]{64}$' then
      raise exception using errcode = '22023', message = 'invalid photo upload intent';
    end if;

    select * into id_intent from public.upload_intents where id = requested_id_intent_id for update;
    if not found or id_intent.owner_id <> requested_actor_id
      or id_intent.source <> 'portal'::public.pass_source or id_intent.kind <> 'id'::public.evidence_kind
      or id_intent.status <> 'pending'::public.upload_intent_status or id_intent.expires_at <= now()
      or requested_id_bytes not between 1 and id_intent.max_bytes
      or requested_id_sha256 !~ '^[0-9a-f]{64}$' then
      raise exception using errcode = '22023', message = 'invalid identification upload intent';
    end if;

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
      now(), 'v1', now() + profile_retention_interval
    ) returning id into returning_profile_id_resolved;

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
      and outcome in ('matched', 'provisional_matched')
      and expires_at > now()
    order by created_at desc
    limit 1;
    if not found then
      raise exception using errcode = '42501', message = 'valid returning identity match required';
    end if;

    if coalesce(returning_attempt_record.threshold_mode, 'provisional') = 'calibrated'
       and returning_attempt_record.outcome = 'matched' then
      returning_profile_id_resolved := requested_returning_profile_id;

      if requested_save_profile_updates then
        update public.returning_visitor_profiles
        set last_used_at = now(),
            updated_at = now(),
            expires_at = greatest(expires_at, now() + profile_retention_interval),
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
      else
        update public.returning_visitor_profiles
        set last_used_at = now(),
            expires_at = greatest(expires_at, now() + profile_retention_interval)
        where id = returning_profile_id_resolved;
      end if;

      -- Extend portrait evidence retention on profile renewal
      update public.visitor_evidence ve
      set expires_at = greatest(ve.expires_at, now() + profile_retention_interval)
      from public.visitors v
      where ve.visitor_id = v.id
        and v.returning_profile_id = returning_profile_id_resolved
        and ve.kind = 'photo'
        and ve.purged_at is null;
    else
      returning_profile_id_resolved := null;
    end if;
  end if;

  starts_at := (requested_visit_date + settings.working_hours_start) at time zone settings.timezone;
  ends_at := (requested_visit_date + settings.working_hours_end) at time zone settings.timezone;

  effective_expected_gate := coalesce(
    nullif(btrim(coalesce(requested_expected_gate, '')), ''),
    nullif(btrim(coalesce(settings.default_expected_gate, '')), '')
  );

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

  if requested_registration_mode = 'new' and requested_photo_intent_id is not null then
    insert into public.visitor_evidence (
      visitor_id, upload_intent_id, kind, bucket_id, object_path, content_type,
      byte_size, sha256_hex, verified_at, expires_at
    ) values (
      new_visitor_id, photo_intent.id, photo_intent.kind, photo_intent.bucket_id,
      photo_intent.object_path, photo_intent.content_type, requested_photo_bytes,
      requested_photo_sha256, now(), greatest(
        now() + profile_retention_interval,
        ends_at + interval '1 day'
      )
    );
    update public.upload_intents set status = 'claimed', claimed_at = now(), visitor_id = new_visitor_id
    where id = photo_intent.id;
  end if;

  if requested_registration_mode = 'new' and requested_id_intent_id is not null then
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

  if requested_arrival_mode = 'vehicle' then
    insert into public.visitor_evidence (
      visitor_id, upload_intent_id, kind, bucket_id, object_path, content_type,
      byte_size, sha256_hex, verified_at, expires_at
    ) values (
      new_visitor_id, vehicle_photo_intent.id, vehicle_photo_intent.kind, vehicle_photo_intent.bucket_id,
      vehicle_photo_intent.object_path, vehicle_photo_intent.content_type, requested_vehicle_photo_bytes,
      requested_vehicle_photo_sha256, now(), greatest(
        now() + make_interval(days => coalesce(settings.vehicle_photo_retention_days, settings.image_retention_days, 7)),
        ends_at + interval '1 day'
      )
    ) returning id into new_vehicle_evidence_id;

    update public.upload_intents set status = 'claimed', claimed_at = now(), visitor_id = new_visitor_id
    where id = vehicle_photo_intent.id;
  end if;

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

  insert into public.passes (
    visitor_id, token_digest, source, status, valid_from, valid_until, issue_request_id, expected_gate
  ) values (
    new_visitor_id, decode(requested_token_digest, 'hex'), 'portal'::public.pass_source, 'issued'::public.pass_status,
    starts_at, ends_at, requested_request_id, effective_expected_gate
  ) returning id, passes.public_reference into new_pass_id, new_public_reference;

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

  -- Atomic general office visit linkage when officeId was supplied
  if requested_office_id is not null then
    insert into public.office_visits (
      visit_type, office_id, approval_status, attendance_status,
      visitor_actor_id, visitor_id, pass_id,
      visitor_first_name, visitor_middle_name, visitor_last_name, visitor_display_name,
      visitor_contact_number, visitor_email, visitor_email_verified,
      purpose, visit_date, arrival_mode, address_details, request_id, email_delivery_status,
      office_requires_approval_snapshot, decided_at, decided_by, decision_source,
      source, expected_gate
    ) values (
      'general', requested_office_id, 'approved'::public.office_approval_status, 'awaiting_entry'::public.office_attendance_status,
      requested_actor_id, new_visitor_id, new_pass_id,
      btrim(requested_first_name), nullif(btrim(requested_middle_name), ''), btrim(requested_last_name), full_name_calc,
      btrim(requested_contact_number), null, false,
      btrim(requested_purpose), requested_visit_date, requested_arrival_mode,
      jsonb_build_object(
        'region', v_region_name,
        'province', v_province_name,
        'city', v_city_name,
        'barangay', v_barangay_name
      ),
      requested_request_id, 'none',
      false, now(), null, 'auto_office_policy',
      'portal'::public.pass_source, effective_expected_gate
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

  pass_id := new_pass_id;
  public_reference := new_public_reference;
  valid_from := starts_at;
  valid_until := ends_at;
  return next;
end;
$$;

revoke all on function api.issue_online_pass_v6(
  uuid, text, uuid, text, text, text, text, text, date,
  uuid, integer, text, uuid, integer, text, text, text,
  text, text, text, text, text, text, text, text, text,
  numeric, numeric,
  text, text, text, text, text, text, uuid, integer, text,
  uuid, uuid, text, boolean, boolean, uuid, text
) from public, anon, authenticated;

grant execute on function api.issue_online_pass_v6(
  uuid, text, uuid, text, text, text, text, text, date,
  uuid, integer, text, uuid, integer, text, text, text,
  text, text, text, text, text, text, text, text, text,
  numeric, numeric,
  text, text, text, text, text, text, uuid, integer, text,
  uuid, uuid, text, boolean, boolean, uuid, text
) to service_role;

-- ============================================================================
-- 5. UPGRADE api.claim_evidence_for_purge WITH ACTIVE PORTRAIT PROTECTION
-- ============================================================================
create or replace function api.claim_evidence_for_purge(
  requested_evidence_id uuid,
  requested_claim_id uuid,
  requested_override boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_evidence record;
  settings record;
  category_days integer;
  category_enabled boolean;
  category_cutoff timestamptz;
begin
  if requested_evidence_id is null or requested_claim_id is null then
    return jsonb_build_object('claimed', false, 'reason', 'invalid_argument');
  end if;

  select ve.id, ve.visitor_id, ve.bucket_id, ve.object_path, ve.purged_at, ve.expires_at,
         ve.created_at, ve.verified_at, ve.kind, ve.purge_claim_id, ve.purge_claimed_at
    into v_evidence
    from public.visitor_evidence ve
   where ve.id = requested_evidence_id
   for update;

  if not found then
    return jsonb_build_object('claimed', false, 'reason', 'evidence_not_found');
  end if;

  if v_evidence.purged_at is not null then
    return jsonb_build_object('claimed', false, 'reason', 'already_purged');
  end if;

  -- Load app settings
  select photo_retention_enabled, id_retention_enabled, vehicle_photo_retention_enabled,
         photo_retention_days, id_retention_days, vehicle_photo_retention_days,
         returning_profile_retention_days, image_retention_days
    into settings
    from public.app_settings
   where singleton = true;

  -- Check category enabled and retention duration (unless explicit override requested)
  if not requested_override then
    if v_evidence.kind = 'photo' then
      category_enabled := coalesce(settings.photo_retention_enabled, true);
      category_days := coalesce(settings.returning_profile_retention_days, settings.photo_retention_days, 30);
    elsif v_evidence.kind = 'id' then
      category_enabled := coalesce(settings.id_retention_enabled, true);
      category_days := coalesce(settings.id_retention_days, 30);
    elsif v_evidence.kind = 'vehicle_photo' then
      category_enabled := coalesce(settings.vehicle_photo_retention_enabled, true);
      category_days := coalesce(settings.vehicle_photo_retention_days, settings.image_retention_days, 7);
    else
      category_enabled := true;
      category_days := coalesce(settings.image_retention_days, 7);
    end if;

    if not category_enabled then
      return jsonb_build_object('claimed', false, 'reason', 'category_retention_disabled');
    end if;

    category_cutoff := statement_timestamp() - make_interval(days => category_days);
    if coalesce(v_evidence.created_at, v_evidence.verified_at) > category_cutoff then
      return jsonb_build_object('claimed', false, 'reason', 'category_retention_not_expired');
    end if;

    if v_evidence.expires_at > statement_timestamp() then
      return jsonb_build_object('claimed', false, 'reason', 'not_expired');
    end if;
  end if;

  -- Freshness check: if claimed recently (< 5 min), deny concurrent purge
  if v_evidence.purge_claim_id is not null
     and v_evidence.purge_claim_id <> requested_claim_id
     and v_evidence.purge_claimed_at >= statement_timestamp() - interval '5 minutes' then
    return jsonb_build_object('claimed', false, 'reason', 'concurrent_purge_in_progress');
  end if;

  -- SAFEGUARD 1: Active incident hold by visitor_id
  if exists (
    select 1 from public.incident_holds ih
     where ih.visitor_id = v_evidence.visitor_id
       and ih.active = true
  ) then
    return jsonb_build_object('claimed', false, 'reason', 'active_visitor_hold');
  end if;

  -- SAFEGUARD 2: Active returning profile portrait hold
  if v_evidence.kind = 'photo' then
    if exists (
      select 1 from public.visitors v
      join public.returning_visitor_profiles rvp on rvp.id = v.returning_profile_id
      where v.id = v_evidence.visitor_id
        and rvp.revoked_at is null
        and rvp.expires_at > statement_timestamp()
    ) then
      return jsonb_build_object('claimed', false, 'reason', 'active_returning_portrait_hold');
    end if;
  end if;

  -- Atomically claim evidence record
  update public.visitor_evidence
     set purge_claim_id = requested_claim_id,
         purge_claimed_at = statement_timestamp()
   where id = v_evidence.id;

  return jsonb_build_object(
    'claimed', true,
    'evidenceId', v_evidence.id,
    'bucketId', v_evidence.bucket_id,
    'objectPath', v_evidence.object_path
  );
end;
$$;

revoke all on function api.claim_evidence_for_purge(uuid, uuid, boolean) from public, anon, authenticated;
grant execute on function api.claim_evidence_for_purge(uuid, uuid, boolean) to service_role;

-- ============================================================================
-- 6. UPGRADE api.record_emergency_sync_item WITH RECOVERY SYNC SUPPORT
-- ============================================================================
drop function if exists api.record_emergency_sync_item(
  uuid, uuid, uuid, text, text, text, text, uuid, text, text, boolean, boolean, text, timestamptz, integer, text, uuid, text, boolean, text
);

create or replace function api.record_emergency_sync_item(
  requested_request_id uuid,
  requested_device_user_id uuid,
  requested_record_id uuid,
  requested_claimed_gate text,
  requested_visitor_full_name text,
  requested_declared_address text,
  requested_purpose text,
  requested_destination_office_id uuid,
  requested_destination_office_name_snapshot text,
  requested_office_resolution_status text,
  requested_office_requires_approval_snapshot boolean,
  requested_id_physically_inspected boolean,
  requested_id_inspection_attestation_text text,
  requested_local_recorded_at timestamptz,
  requested_local_sequence integer,
  requested_snapshot_version text,
  requested_manifest_id uuid,
  requested_lease_status_at_record text,
  requested_emergency_exception_applied boolean default false,
  requested_emergency_exception_reason text default null,
  requested_is_recovery boolean default false
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_device public.devices%rowtype;
  v_settings public.app_settings%rowtype;
  v_existing public.emergency_gate_records%rowtype;
  v_seq_owner public.emergency_gate_records%rowtype;
  v_manifest public.emergency_device_manifests%rowtype;
  v_office public.offices%rowtype;
  v_fingerprint text;
  v_clean_name text := btrim(coalesce(requested_visitor_full_name, ''));
  v_clean_addr text := btrim(coalesce(requested_declared_address, ''));
  v_clean_purpose text := btrim(coalesce(requested_purpose, ''));
  v_clean_office_name text := btrim(coalesce(requested_destination_office_name_snapshot, ''));
  v_clean_claimed_gate text := regexp_replace(btrim(coalesce(requested_claimed_gate, '')), '\s+', ' ', 'g');
  v_norm_claimed_gate text := pg_catalog.btrim(pg_catalog.lower(coalesce(requested_claimed_gate, '')));
  v_norm_device_gate text;
  v_flags text[] := array[]::text[];
  v_status public.emergency_reconciliation_status := 'received'::public.emergency_reconciliation_status;
  v_max_seq integer := 0;
  v_outcome text := 'created';
  v_receipt_id uuid := gen_random_uuid();
  v_has_duplicate_walkin boolean := false;
  v_valid_manifest_id uuid := null;
  v_office_approval boolean := coalesce(requested_office_requires_approval_snapshot, true);
  v_is_recovery_quarantine boolean := false;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'service role required';
  end if;

  if requested_id_physically_inspected is distinct from true
     or requested_id_inspection_attestation_text is distinct from 'I confirm that the visitor physically presented an identification document and that I visually inspected it.' then
    raise exception using errcode = '22023', message = 'physical_id_inspection_attestation_required';
  end if;

  if char_length(v_clean_name) < 2 or char_length(v_clean_addr) < 5 or char_length(v_clean_purpose) < 2 or char_length(v_clean_office_name) < 2 then
    raise exception using errcode = '22023', message = 'invalid_offline_record_fields';
  end if;

  if requested_local_sequence is null or requested_local_sequence < 1 then
    raise exception using errcode = '22023', message = 'invalid_local_sequence';
  end if;

  perform pg_advisory_xact_lock(hashtext('emergency_sync:' || requested_device_user_id::text));

  select * into v_device
  from public.devices d
  where d.user_id = requested_device_user_id
    and d.type = 'emergency_device'::public.device_type
  for update;

  if not found then
    raise exception using errcode = '42501', message = 'emergency_device_not_found';
  end if;

  v_norm_device_gate := pg_catalog.btrim(pg_catalog.lower(v_device.gate));

  v_fingerprint := pg_catalog.encode(
    pg_catalog.sha256(
      pg_catalog.convert_to(
        pg_catalog.concat_ws(
          '|',
          requested_device_user_id::text,
          requested_local_sequence::text,
          v_norm_claimed_gate,
          lower(v_clean_name),
          lower(v_clean_addr),
          lower(v_clean_purpose),
          coalesce(requested_destination_office_id::text, 'unresolved'),
          lower(v_clean_office_name),
          requested_office_resolution_status,
          coalesce(to_char(requested_local_recorded_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), ''),
          coalesce(requested_emergency_exception_applied::text, 'false')
        ),
        'UTF8'
      )
    ),
    'hex'
  );

  -- 1. Check device active status or evaluate safe recovery-sync for retired device
  if v_device.status <> 'active'::public.device_status or v_device.deleted_at is not null then
    if requested_is_recovery is true
       and requested_local_recorded_at < coalesce(v_device.deleted_at, v_device.updated_at) then
      -- Verify manifest exists and was issued before device retirement
      select * into v_manifest
      from public.emergency_device_manifests m
      where m.id = requested_manifest_id
        and m.device_user_id = requested_device_user_id;

      if not found or v_manifest.issued_at >= coalesce(v_device.deleted_at, v_device.updated_at) then
        insert into public.emergency_sync_receipts(
          id, request_id, emergency_record_id, device_user_id, local_sequence,
          payload_fingerprint, outcome, flags, reason_code, actor_id
        ) values (
          v_receipt_id, requested_request_id, requested_record_id, requested_device_user_id,
          requested_local_sequence, v_fingerprint, 'rejected_invalid_recovery_manifest',
          jsonb_build_array('invalid_recovery_manifest'), 'invalid_recovery_manifest', requested_device_user_id
        );

        return jsonb_build_object(
          'accepted', false,
          'httpStatus', 403,
          'outcome', 'rejected_invalid_recovery_manifest',
          'error', 'invalid_recovery_manifest',
          'receiptId', v_receipt_id
        );
      end if;

      v_is_recovery_quarantine := true;
      v_flags := array_append(v_flags, 'recovery_sync_retired_device');
      v_status := 'needs_review'::public.emergency_reconciliation_status;
    else
      insert into public.emergency_sync_receipts(
        id, request_id, emergency_record_id, device_user_id, local_sequence,
        payload_fingerprint, outcome, flags, reason_code, actor_id
      ) values (
        v_receipt_id, requested_request_id, requested_record_id, requested_device_user_id,
        requested_local_sequence, v_fingerprint, 'rejected_device_revoked',
        jsonb_build_array('device_revoked'), 'device_revoked', requested_device_user_id
      );

      insert into public.audit_events(
        actor_id, actor_kind, actor_role, action, target_type, target_id, request_id, outcome, after_state
      ) values (
        requested_device_user_id, 'device', 'emergency_device', 'emergency_record.sync_rejected_revoked',
        'emergency_gate_record', requested_record_id::text, requested_request_id, 'denied',
        jsonb_build_object('receiptId', v_receipt_id, 'deviceStatus', v_device.status, 'localSequence', requested_local_sequence)
      );

      return jsonb_build_object(
        'accepted', false,
        'httpStatus', 403,
        'outcome', 'rejected_device_revoked',
        'error', 'device_revoked',
        'receiptId', v_receipt_id
      );
    end if;
  end if;

  -- 2. Idempotency / UUID conflict check
  select * into v_existing
  from public.emergency_gate_records r
  where r.id = requested_record_id
  for update;

  if found then
    if v_existing.device_user_id = requested_device_user_id
       and v_existing.payload_fingerprint = v_fingerprint then
      insert into public.emergency_sync_receipts(
        id, request_id, emergency_record_id, device_user_id, local_sequence,
        payload_fingerprint, outcome, resulting_status, flags, actor_id
      ) values (
        v_receipt_id, requested_request_id, requested_record_id, requested_device_user_id,
        requested_local_sequence, v_fingerprint, 'idempotent_replay',
        v_existing.reconciliation_status, v_existing.reconciliation_flags, requested_device_user_id
      );

      return jsonb_build_object(
        'accepted', true,
        'outcome', 'idempotent_replay',
        'recordId', v_existing.id,
        'localSequence', v_existing.local_sequence,
        'reconciliationStatus', v_existing.reconciliation_status,
        'classification', v_existing.record_classification,
        'flags', v_existing.reconciliation_flags,
        'receiptId', v_receipt_id
      );
    else
      insert into public.emergency_sync_receipts(
        id, request_id, emergency_record_id, device_user_id, local_sequence,
        payload_fingerprint, outcome, flags, reason_code, actor_id
      ) values (
        v_receipt_id, requested_request_id, requested_record_id, requested_device_user_id,
        requested_local_sequence, v_fingerprint, 'rejected_record_id_conflict',
        jsonb_build_array('record_id_conflict'), 'uuid_conflict', requested_device_user_id
      );

      return jsonb_build_object(
        'accepted', false,
        'httpStatus', 409,
        'outcome', 'rejected_record_id_conflict',
        'error', 'record_id_conflict',
        'receiptId', v_receipt_id
      );
    end if;
  end if;

  -- 3. Verify manifest if provided
  if requested_manifest_id is not null then
    select * into v_manifest
    from public.emergency_device_manifests m
    where m.id = requested_manifest_id
      and m.device_user_id = requested_device_user_id;

    if found then
      v_valid_manifest_id := v_manifest.id;
    else
      v_flags := array_append(v_flags, 'unknown_manifest_reference');
    end if;
  else
    v_flags := array_append(v_flags, 'no_manifest');
  end if;

  -- 4. Verify gate binding (cross-gate replay vs post-manifest gate reassignment)
  if v_norm_claimed_gate is distinct from v_norm_device_gate then
    if v_manifest.id is not null and pg_catalog.btrim(pg_catalog.lower(v_manifest.assigned_gate)) = v_norm_claimed_gate then
      v_flags := array_append(v_flags, 'gate_reassigned_since_manifest');
    else
      insert into public.emergency_sync_receipts(
        id, request_id, emergency_record_id, device_user_id, local_sequence,
        payload_fingerprint, outcome, flags, reason_code, actor_id
      ) values (
        v_receipt_id, requested_request_id, requested_record_id, requested_device_user_id,
        requested_local_sequence, v_fingerprint, 'rejected_gate_mismatch',
        jsonb_build_array('gate_mismatch'), 'gate_mismatch', requested_device_user_id
      );

      insert into public.audit_events(
        actor_id, actor_kind, actor_role, action, target_type, target_id, request_id, outcome, after_state
      ) values (
        requested_device_user_id, 'device', 'emergency_device', 'emergency_record.gate_mismatch_rejected',
        'emergency_gate_record', requested_record_id::text, requested_request_id, 'denied',
        jsonb_build_object('receiptId', v_receipt_id, 'claimedGate', v_clean_claimed_gate, 'deviceGate', v_device.gate)
      );

      return jsonb_build_object(
        'accepted', false,
        'httpStatus', 403,
        'outcome', 'rejected_gate_mismatch',
        'error', 'gate_mismatch',
        'receiptId', v_receipt_id
      );
    end if;
  end if;

  -- 5. Sequence collision check
  select * into v_seq_owner
  from public.emergency_gate_records r
  where r.device_user_id = requested_device_user_id
    and r.local_sequence = requested_local_sequence;

  if found then
    insert into public.emergency_sync_receipts(
      id, request_id, emergency_record_id, device_user_id, local_sequence,
      payload_fingerprint, outcome, flags, reason_code, actor_id
    ) values (
      v_receipt_id, requested_request_id, requested_record_id, requested_device_user_id,
      requested_local_sequence, v_fingerprint, 'conflict_sequence_collision',
      jsonb_build_array('sequence_collision'), 'sequence_collision', requested_device_user_id
    );

    insert into public.audit_events(
      actor_id, actor_kind, actor_role, action, target_type, target_id, request_id, outcome, after_state
    ) values (
      requested_device_user_id, 'device', 'emergency_device', 'emergency_record.sequence_collision',
      'emergency_gate_record', requested_record_id::text, requested_request_id, 'denied',
      jsonb_build_object('receiptId', v_receipt_id, 'collidingRecordId', v_seq_owner.id, 'localSequence', requested_local_sequence)
    );

    return jsonb_build_object(
      'accepted', false,
      'httpStatus', 409,
      'outcome', 'conflict_sequence_collision',
      'error', 'sequence_collision',
      'receiptId', v_receipt_id
    );
  end if;

  select coalesce(max(r.local_sequence), 0) into v_max_seq
  from public.emergency_gate_records r
  where r.device_user_id = requested_device_user_id;

  if requested_local_sequence > v_max_seq + 1 then
    v_flags := array_append(v_flags, 'sequence_gap_detected');
  elsif requested_local_sequence < v_max_seq then
    v_flags := array_append(v_flags, 'out_of_order_sequence');
  end if;

  -- 6. Lease & manifest revocation flags
  if v_manifest.id is not null and v_manifest.revoked_at is not null then
    v_flags := array_append(v_flags, 'revoked_manifest_lease');
  end if;

  if requested_lease_status_at_record <> 'valid' then
    v_flags := array_append(v_flags, requested_lease_status_at_record);
  end if;

  -- 7. Office resolution and live approval policy check
  if requested_office_resolution_status = 'unresolved_stale_snapshot' or requested_destination_office_id is null then
    v_flags := array_append(v_flags, 'unresolved_office');
    v_office_approval := true;
  else
    select * into v_office from public.offices o where o.id = requested_destination_office_id;
    if not found then
      v_flags := array_append(v_flags, 'office_not_found');
      v_office_approval := true;
    else
      if not v_office.active or v_office.publication_status <> 'published' then
        v_flags := array_append(v_flags, 'office_unpublished_or_inactive');
      end if;
      v_office_approval := v_office.requires_approval_before_pass or coalesce(requested_office_requires_approval_snapshot, true);
    end if;
  end if;

  if v_office_approval then
    v_flags := array_append(v_flags, 'office_approval_required');
  end if;

  -- 8. Emergency exception policy validation
  select * into v_settings from public.app_settings where singleton = true;
  if requested_emergency_exception_applied then
    if coalesce(v_settings.allow_emergency_exception, false) = false then
      v_flags := array_append(v_flags, 'emergency_exception_policy_disabled');
    else
      v_flags := array_append(v_flags, 'emergency_exception_applied');
    end if;
  end if;

  -- 9. Potential walk-in duplicate detection (same normalized name + purpose + gate within 15 minutes)
  select exists (
    select 1 from public.emergency_gate_records existing_r
    where existing_r.normalized_gate = v_norm_claimed_gate
      and lower(existing_r.visitor_full_name) = lower(v_clean_name)
      and lower(existing_r.purpose) = lower(v_clean_purpose)
      and abs(extract(epoch from (existing_r.local_recorded_at - requested_local_recorded_at))) <= 900
  ) into v_has_duplicate_walkin;

  if v_has_duplicate_walkin then
    v_flags := array_append(v_flags, 'potential_duplicate_walkin');
  end if;

  if v_is_recovery_quarantine or coalesce(array_length(v_flags, 1), 0) > 0 then
    v_status := 'needs_review'::public.emergency_reconciliation_status;
    v_outcome := 'flagged_needs_review';
  else
    v_status := 'received'::public.emergency_reconciliation_status;
    v_outcome := 'created';
  end if;

  insert into public.emergency_gate_records(
    id,
    device_user_id,
    gate,
    normalized_gate,
    visitor_full_name,
    declared_address,
    address_status,
    purpose,
    destination_office_id,
    destination_office_name_snapshot,
    office_resolution_status,
    office_requires_approval_snapshot,
    id_physically_inspected,
    id_inspection_attestation_text,
    record_classification,
    local_recorded_at,
    local_sequence,
    snapshot_version,
    manifest_id,
    lease_status_at_record,
    emergency_exception_applied,
    emergency_exception_reason,
    payload_fingerprint,
    reconciliation_status,
    reconciliation_flags
  ) values (
    requested_record_id,
    requested_device_user_id,
    v_clean_claimed_gate,
    v_norm_claimed_gate,
    v_clean_name,
    v_clean_addr,
    'visitor_declared_unverified',
    v_clean_purpose,
    requested_destination_office_id,
    v_clean_office_name,
    requested_office_resolution_status,
    v_office_approval,
    true,
    requested_id_inspection_attestation_text,
    'OFFLINE MODE RECORDED',
    requested_local_recorded_at,
    requested_local_sequence,
    requested_snapshot_version,
    v_valid_manifest_id,
    requested_lease_status_at_record,
    coalesce(requested_emergency_exception_applied, false),
    nullif(btrim(requested_emergency_exception_reason), ''),
    v_fingerprint,
    v_status,
    to_jsonb(v_flags)
  );

  insert into public.emergency_sync_receipts(
    id, request_id, emergency_record_id, device_user_id, local_sequence,
    payload_fingerprint, outcome, resulting_status, flags, actor_id
  ) values (
    v_receipt_id, requested_request_id, requested_record_id, requested_device_user_id,
    requested_local_sequence, v_fingerprint, v_outcome, v_status, to_jsonb(v_flags),
    requested_device_user_id
  );

  insert into public.audit_events(
    actor_id, actor_kind, actor_role, action, target_type, target_id, request_id, after_state
  ) values (
    requested_device_user_id,
    'device',
    'emergency_device',
    'emergency_record.synced',
    'emergency_gate_record',
    requested_record_id::text,
    requested_request_id,
    jsonb_build_object(
      'receiptId', v_receipt_id,
      'localSequence', requested_local_sequence,
      'status', v_status,
      'flags', v_flags,
      'isRecovery', requested_is_recovery
    )
  );

  return jsonb_build_object(
    'accepted', true,
    'outcome', v_outcome,
    'recordId', requested_record_id,
    'localSequence', requested_local_sequence,
    'reconciliationStatus', v_status,
    'classification', 'OFFLINE MODE RECORDED',
    'flags', to_jsonb(v_flags),
    'receiptId', v_receipt_id
  );
end $$;

revoke all on function api.record_emergency_sync_item(
  uuid, uuid, uuid, text, text, text, text, uuid, text, text, boolean, boolean, text, timestamptz, integer, text, uuid, text, boolean, text, boolean
) from public, anon, authenticated;

grant execute on function api.record_emergency_sync_item(
  uuid, uuid, uuid, text, text, text, text, uuid, text, text, boolean, boolean, text, timestamptz, integer, text, uuid, text, boolean, text, boolean
) to service_role;

-- ============================================================================
-- 7. UPGRADE api.reconcile_emergency_gate_record WITH IDEMPOTENCY & CONFLICT PROTECTION
-- ============================================================================
create or replace function api.reconcile_emergency_gate_record(
  requested_actor_id uuid,
  requested_record_id uuid,
  requested_decision public.emergency_reconciliation_status,
  requested_notes text,
  requested_request_id uuid default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor_role public.staff_role;
  target public.emergency_gate_records%rowtype;
  clean_notes text := btrim(coalesce(requested_notes, ''));
  v_req_id uuid := coalesce(requested_request_id, gen_random_uuid());
  v_receipt_id uuid := gen_random_uuid();
  v_existing_receipt public.emergency_sync_receipts%rowtype;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'service role required';
  end if;

  select sp.role into actor_role
  from public.staff_profiles sp
  where sp.user_id = requested_actor_id
    and sp.active
    and not sp.must_change_password
    and sp.privacy_accepted_at is not null;

  if actor_role not in ('admin'::public.staff_role, 'superadmin'::public.staff_role) then
    raise exception using errcode = '42501', message = 'administrator required';
  end if;

  if requested_decision not in (
    'accepted'::public.emergency_reconciliation_status,
    'needs_review'::public.emergency_reconciliation_status,
    'duplicate'::public.emergency_reconciliation_status,
    'rejected'::public.emergency_reconciliation_status
  ) then
    raise exception using errcode = '22023', message = 'invalid_reconciliation_decision';
  end if;

  if char_length(clean_notes) < 5 then
    raise exception using errcode = '22023', message = 'reconciliation_notes_required';
  end if;

  select * into target
  from public.emergency_gate_records r
  where r.id = requested_record_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'emergency_record_not_found';
  end if;

  -- 1. Client requestId Idempotency & Conflict Check
  if requested_request_id is not null then
    select * into v_existing_receipt
    from public.emergency_sync_receipts
    where request_id = requested_request_id and emergency_record_id = requested_record_id
    order by created_at desc
    limit 1;

    if found then
      if v_existing_receipt.resulting_status = requested_decision then
        return jsonb_build_object(
          'recordId', target.id,
          'classification', target.record_classification,
          'reconciliationStatus', target.reconciliation_status,
          'reconciledAt', target.reconciled_at,
          'reconciledBy', target.reconciled_by,
          'receiptId', v_existing_receipt.id,
          'idempotent', true
        );
      else
        raise exception using errcode = '40900', message = 'reconciliation_request_conflict';
      end if;
    end if;
  end if;

  -- 2. Prevent overwriting finalized decisions unless reopened to needs_review by superadmin
  if target.reconciliation_status in ('accepted'::public.emergency_reconciliation_status, 'rejected'::public.emergency_reconciliation_status, 'duplicate'::public.emergency_reconciliation_status) then
    if target.reconciliation_status = requested_decision then
      -- Idempotent duplicate call with same decision
      return jsonb_build_object(
        'recordId', target.id,
        'classification', target.record_classification,
        'reconciliationStatus', target.reconciliation_status,
        'reconciledAt', target.reconciled_at,
        'reconciledBy', target.reconciled_by,
        'receiptId', gen_random_uuid(),
        'idempotent', true
      );
    elsif not (actor_role = 'superadmin'::public.staff_role and requested_decision = 'needs_review'::public.emergency_reconciliation_status) then
      raise exception using errcode = '40900', message = 'record_already_finalized';
    end if;
  end if;

  update public.emergency_gate_records
  set
    reconciliation_status = requested_decision,
    reconciliation_notes = clean_notes,
    reconciled_by = requested_actor_id,
    reconciled_at = now(),
    updated_at = now()
  where id = requested_record_id;

  insert into public.emergency_sync_receipts(
    id, request_id, emergency_record_id, device_user_id, local_sequence,
    payload_fingerprint, outcome, resulting_status, flags, reason_code, actor_id
  ) values (
    v_receipt_id, v_req_id, target.id, target.device_user_id, target.local_sequence,
    target.payload_fingerprint, 'reconciled', requested_decision, target.reconciliation_flags,
    clean_notes, requested_actor_id
  );

  insert into public.audit_events(
    actor_id, actor_kind, actor_role, action, target_type, target_id, request_id, before_state, after_state
  ) values (
    requested_actor_id,
    'staff',
    actor_role::text,
    'emergency_record.reconciled',
    'emergency_gate_record',
    target.id::text,
    v_req_id,
    jsonb_build_object(
      'reconciliationStatus', target.reconciliation_status,
      'reconciledAt', target.reconciled_at
    ),
    jsonb_build_object(
      'reconciliationStatus', requested_decision,
      'classification', target.record_classification,
      'notes', clean_notes,
      'receiptId', v_receipt_id
    )
  );

  return jsonb_build_object(
    'recordId', target.id,
    'classification', target.record_classification,
    'reconciliationStatus', requested_decision,
    'reconciledAt', now(),
    'reconciledBy', requested_actor_id,
    'receiptId', v_receipt_id
  );
end $$;

revoke all on function api.reconcile_emergency_gate_record(uuid, uuid, public.emergency_reconciliation_status, text, uuid) from public, anon, authenticated;
grant execute on function api.reconcile_emergency_gate_record(uuid, uuid, public.emergency_reconciliation_status, text, uuid) to service_role;
