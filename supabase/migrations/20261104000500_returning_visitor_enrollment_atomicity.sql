-- Migration 55: Returning Visitor Enrollment Atomicity & Fail-Closed Transactional RPC
-- Ensures that post-issuance returning visitor profile creation, face template encryption,
-- visitor linking, and optional vehicle persistence execute inside a single atomic transaction.
-- If any step fails (including 0-row visitor updates or invalid vehicle data), all state rolls back
-- without leaving orphaned profiles or templates.

create or replace function api.enroll_returning_visitor_v1(
  requested_actor_id uuid,
  requested_pass_id uuid,
  requested_request_id uuid,
  -- Profile fields
  requested_first_name text,
  requested_middle_name text,
  requested_last_name text,
  requested_contact_number_e164 text,
  requested_home_address text,
  requested_home_location_lat numeric(6,3),
  requested_home_location_lon numeric(6,3),
  requested_psgc_version text,
  requested_psgc_region_code text,
  requested_psgc_province_code text,
  requested_psgc_city_code text,
  requested_psgc_barangay_code text,
  requested_psgc_region_name text,
  requested_psgc_province_name text,
  requested_psgc_city_municipality_name text,
  requested_psgc_barangay_name text,
  requested_home_building text,
  requested_home_street text,
  requested_postal_code text,
  requested_postal_code_source text,
  -- Encrypted template fields
  requested_encrypted_embedding text,
  requested_iv text,
  requested_auth_tag text,
  requested_key_version text,
  requested_model_name text,
  requested_model_version text,
  -- Optional vehicle saving
  requested_save_vehicle boolean default false,
  requested_vehicle_type text default null,
  requested_plate_number text default null,
  requested_plate_key text default null,
  requested_vehicle_color text default null,
  requested_make_model text default null
)
returns table (
  returning_profile_id uuid
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_pass public.passes%rowtype;
  v_visitor public.visitors%rowtype;
  v_new_profile_id uuid;
  v_rows_updated integer;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'service role required';
  end if;

  -- 1. Strict Pass Validation: must exist for this exact pass_id and issue_request_id
  if requested_pass_id is null or requested_request_id is null then
    raise exception using errcode = '22023', message = 'pass_id and request_id required';
  end if;

  select * into v_pass
  from public.passes
  where id = requested_pass_id
    and issue_request_id = requested_request_id;

  if not found then
    raise exception using errcode = 'P0002', message = 'pass not found for enrollment request';
  end if;

  if v_pass.visitor_id is null then
    raise exception using errcode = '22023', message = 'pass has no associated visitor';
  end if;

  -- 2. Strict Visitor Validation: must exist and be owned by actor
  select * into v_visitor
  from public.visitors
  where id = v_pass.visitor_id;

  if not found then
    raise exception using errcode = 'P0002', message = 'visitor record not found';
  end if;

  if v_visitor.owner_id <> requested_actor_id then
    raise exception using errcode = '42501', message = 'visitor owner mismatch';
  end if;

  if v_visitor.returning_profile_id is not null then
    raise exception using errcode = '23505', message = 'visitor already linked to returning profile';
  end if;

  -- Validate face template inputs
  if requested_encrypted_embedding is null or char_length(requested_encrypted_embedding) < 16
    or requested_iv is null or requested_auth_tag is null or requested_key_version is null then
    raise exception using errcode = '22023', message = 'invalid face template parameters';
  end if;

  -- 3. Insert returning visitor profile
  insert into public.returning_visitor_profiles (
    first_name, middle_name, last_name, contact_number_e164,
    home_address, home_location_lat, home_location_lon,
    psgc_version, psgc_region_code, psgc_province_code, psgc_city_code, psgc_barangay_code,
    psgc_region_name, psgc_province_name, psgc_city_municipality_name, psgc_barangay_name,
    home_building, home_street, postal_code, postal_code_source,
    consent_version
  ) values (
    btrim(requested_first_name),
    nullif(btrim(requested_middle_name), ''),
    btrim(requested_last_name),
    btrim(requested_contact_number_e164),
    nullif(btrim(requested_home_address), ''),
    requested_home_location_lat,
    requested_home_location_lon,
    coalesce(nullif(btrim(requested_psgc_version), ''), '2026-q3'),
    nullif(btrim(requested_psgc_region_code), ''),
    nullif(btrim(requested_psgc_province_code), ''),
    nullif(btrim(requested_psgc_city_code), ''),
    nullif(btrim(requested_psgc_barangay_code), ''),
    nullif(btrim(requested_psgc_region_name), ''),
    nullif(btrim(requested_psgc_province_name), ''),
    nullif(btrim(requested_psgc_city_municipality_name), ''),
    nullif(btrim(requested_psgc_barangay_name), ''),
    nullif(btrim(requested_home_building), ''),
    nullif(btrim(requested_home_street), ''),
    nullif(btrim(requested_postal_code), ''),
    nullif(btrim(requested_postal_code_source), ''),
    'v1'
  ) returning id into v_new_profile_id;

  -- 4. Insert encrypted face template
  insert into public.returning_face_templates (
    profile_id, encrypted_embedding, iv, auth_tag, key_version, model_name, model_version
  ) values (
    v_new_profile_id,
    requested_encrypted_embedding,
    requested_iv,
    requested_auth_tag,
    requested_key_version,
    coalesce(requested_model_name, 'face-api-default'),
    coalesce(requested_model_version, 'v1')
  );

  -- 5. Atomically link visitor to the new profile, verifying exactly 1 row updated
  update public.visitors
  set returning_profile_id = v_new_profile_id
  where id = v_visitor.id
    and owner_id = requested_actor_id
    and returning_profile_id is null;

  get diagnostics v_rows_updated = row_count;
  if v_rows_updated <> 1 then
    raise exception using errcode = '23505', message = format('visitor linking failed: expected 1 row, got %s', v_rows_updated);
  end if;

  -- 6. Optional vehicle saving
  if coalesce(requested_save_vehicle, false) = true then
    if requested_plate_key is null or char_length(btrim(requested_plate_key)) < 3
      or requested_plate_number is null or char_length(btrim(requested_plate_number)) < 3
      or requested_vehicle_type is null then
      raise exception using errcode = '22023', message = 'invalid vehicle details for saving';
    end if;

    insert into public.returning_visitor_vehicles (
      profile_id, vehicle_type, plate_number, plate_key, color, make_model
    ) values (
      v_new_profile_id,
      btrim(requested_vehicle_type),
      btrim(requested_plate_number),
      btrim(requested_plate_key),
      btrim(coalesce(requested_vehicle_color, '')),
      nullif(btrim(coalesce(requested_make_model, '')), '')
    );
  end if;

  returning_profile_id := v_new_profile_id;
  return next;
end;
$$;

revoke all on function api.enroll_returning_visitor_v1 from public;
revoke all on function api.enroll_returning_visitor_v1 from anon;
revoke all on function api.enroll_returning_visitor_v1 from authenticated;
grant execute on function api.enroll_returning_visitor_v1 to service_role;
