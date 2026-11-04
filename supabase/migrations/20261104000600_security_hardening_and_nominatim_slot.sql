-- Migration: 20261104000600_security_hardening_and_nominatim_slot.sql
-- Description:
-- 1. Fix ambiguous column reference in api.enroll_returning_visitor_v1 identified by Supabase db lint.
-- 2. Harden api.acquire_nominatim_slot: enforce search_path = '', server-bounded rate intervals, revoke execute from public/anon/authenticated, restrict to service_role.
-- 3. Harden api.record_resend_delivery_event: set search_path = '' and fully qualify public schema tables.

-- ============================================================================
-- Section 1: Fix ambiguous column reference in api.enroll_returning_visitor_v1
-- ============================================================================

create or replace function api.enroll_returning_visitor_v1(
  requested_actor_id uuid,
  requested_pass_id uuid,
  requested_request_id uuid,
  requested_first_name text,
  requested_middle_name text,
  requested_last_name text,
  requested_contact_number_e164 text,
  requested_home_address text default null,
  requested_home_location_lat numeric default null,
  requested_home_location_lon numeric default null,
  requested_psgc_version text default null,
  requested_psgc_region_code text default null,
  requested_psgc_province_code text default null,
  requested_psgc_city_code text default null,
  requested_psgc_barangay_code text default null,
  requested_psgc_region_name text default null,
  requested_psgc_province_name text default null,
  requested_psgc_city_municipality_name text default null,
  requested_psgc_barangay_name text default null,
  requested_home_building text default null,
  requested_home_street text default null,
  requested_postal_code text default null,
  requested_postal_code_source text default null,
  requested_encrypted_embedding text default null,
  requested_iv text default null,
  requested_auth_tag text default null,
  requested_key_version text default null,
  requested_model_name text default null,
  requested_model_version text default null,
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
  -- Note: Qualified column names prevent PL/pgSQL variable ambiguity.
  update public.visitors
  set returning_profile_id = v_new_profile_id
  where visitors.id = v_visitor.id
    and visitors.owner_id = requested_actor_id
    and visitors.returning_profile_id is null;

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

revoke all on function api.enroll_returning_visitor_v1 from public, anon, authenticated;
grant execute on function api.enroll_returning_visitor_v1 to service_role;

-- ============================================================================
-- Section 2: Harden api.acquire_nominatim_slot
-- ============================================================================

create or replace function api.acquire_nominatim_slot(
  p_min_interval_ms integer default 1100
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_last_request timestamptz;
  v_now timestamptz := clock_timestamp();
  v_elapsed_ms bigint;
  v_wait_ms integer;
  v_acquired boolean := false;
  v_effective_interval integer;
begin
  -- Enforce server-controlled bounded intervals (1,000ms minimum, 5,000ms maximum)
  v_effective_interval := greatest(1000, least(coalesce(p_min_interval_ms, 1100), 5000));

  -- Atomically lock the singleton rate limiter row
  select last_request_at into v_last_request
  from public.nominatim_rate_limiter
  where id = 1
  for update;

  if not found then
    insert into public.nominatim_rate_limiter (id, last_request_at, updated_at)
    values (1, to_timestamp(0), v_now)
    returning last_request_at into v_last_request;
  end if;

  v_elapsed_ms := floor(extract(epoch from (v_now - v_last_request)) * 1000)::bigint;

  if v_elapsed_ms >= v_effective_interval then
    update public.nominatim_rate_limiter
    set last_request_at = v_now,
        updated_at = v_now
    where id = 1;
    v_acquired := true;
    v_wait_ms := 0;
  else
    v_acquired := false;
    v_wait_ms := (v_effective_interval - v_elapsed_ms)::integer;
  end if;

  return jsonb_build_object(
    'acquired', v_acquired,
    'wait_ms', v_wait_ms,
    'elapsed_ms', v_elapsed_ms
  );
end;
$$;

-- Explicitly revoke from PUBLIC pseudo-role, anon, and authenticated
revoke all on function api.acquire_nominatim_slot(integer) from public, anon, authenticated;
grant execute on function api.acquire_nominatim_slot(integer) to service_role;

-- ============================================================================
-- Section 3: Harden api.record_resend_delivery_event
-- ============================================================================

create or replace function api.record_resend_delivery_event(
  requested_provider_event_id text,
  requested_event_type text,
  requested_email_id text,
  requested_outcome text,
  requested_recipient_masked text,
  requested_subject_sanitized text,
  requested_occurred_at timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_inserted_id uuid;
  v_audit_id bigint;
  v_occurred timestamptz;
  v_outcome text;
begin
  if requested_provider_event_id is null or trim(requested_provider_event_id) = '' then
    raise exception 'missing_provider_event_id' using errcode = '22023';
  end if;

  if requested_event_type is null or trim(requested_event_type) = '' then
    raise exception 'missing_event_type' using errcode = '22023';
  end if;

  v_occurred := coalesce(requested_occurred_at, now());
  v_outcome := case
    when requested_outcome in ('success', 'denied', 'partial', 'failure') then requested_outcome
    else 'failure'
  end;

  -- 1. Atomically attempt to claim the provider event ID
  begin
    insert into public.resend_webhook_events (
      provider_event_id,
      event_type,
      email_id,
      created_at
    )
    values (
      trim(requested_provider_event_id),
      trim(requested_event_type),
      trim(requested_email_id),
      v_occurred
    )
    returning id into v_inserted_id;
  exception when unique_violation then
    -- Replayed or duplicate webhook event: already processed
    return jsonb_build_object(
      'ok', true,
      'status', 'already_processed',
      'duplicate', true,
      'provider_event_id', trim(requested_provider_event_id),
      'event_type', trim(requested_event_type),
      'email_id', trim(requested_email_id)
    );
  end;

  -- 2. Within the same transaction, insert delivery outcome into audit_events.
  -- If this insert fails, the transaction aborts and the insert into resend_webhook_events rolls back.
  insert into public.audit_events (
    action,
    actor_kind,
    actor_role,
    target_type,
    target_id,
    outcome,
    after_state,
    occurred_at
  )
  values (
    'resend.delivery_event',
    'system',
    'webhook',
    'email',
    trim(requested_email_id),
    v_outcome,
    jsonb_build_object(
      'eventType', trim(requested_event_type),
      'emailId', trim(requested_email_id),
      'providerEventId', trim(requested_provider_event_id),
      'recipientMasked', requested_recipient_masked,
      'subjectSanitized', requested_subject_sanitized,
      'timestamp', to_char(v_occurred at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    ),
    v_occurred
  )
  returning id into v_audit_id;

  return jsonb_build_object(
    'ok', true,
    'status', 'processed',
    'duplicate', false,
    'provider_event_id', trim(requested_provider_event_id),
    'event_id', v_inserted_id,
    'audit_id', v_audit_id,
    'email_id', trim(requested_email_id),
    'event_type', trim(requested_event_type),
    'outcome', v_outcome
  );
end;
$$;

revoke all on function api.record_resend_delivery_event(text, text, text, text, text, text, timestamptz) from public, anon, authenticated;
grant execute on function api.record_resend_delivery_event(text, text, text, text, text, text, timestamptz) to service_role;
