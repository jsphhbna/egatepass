-- ==============================================================================
-- Migration 98: EARIST Campus PSGC Mapping & Request ID Disambiguation
-- ==============================================================================
-- 1. Ensure EARIST Campus canonical Barangay 408 code (1380600408) is preserved
--    in public.psgc_locations under City of Manila (1380600000).
-- 2. Disambiguate office_visits.request_id in api.create_specific_person_visit_request
--    and align error message to office_not_found_or_inactive.
-- ==============================================================================

begin;

-- 1. Insert EARIST Campus canonical Barangay 408 record
insert into public.psgc_locations (psgc_code, parent_psgc_code, name, level, location_type, reference_version_id, is_active)
values ('1380600408', '1380600000', 'Barangay 408 (Zone 42 / EARIST Campus)', 'barangay', 'barangay', '2026-q3', true)
on conflict (psgc_code) do update set
  name = excluded.name,
  parent_psgc_code = excluded.parent_psgc_code,
  level = excluded.level,
  location_type = excluded.location_type,
  reference_version_id = excluded.reference_version_id,
  is_active = excluded.is_active;

-- 2. Re-declare api.create_specific_person_visit_request with disambiguated query
create or replace function api.create_specific_person_visit_request(
  requested_actor_id uuid,
  requested_request_id uuid,
  requested_office_id uuid,
  requested_personnel_id uuid default null,
  requested_first_name text default null,
  requested_middle_name text default null,
  requested_last_name text default null,
  requested_contact_number text default null,
  requested_email text default null,
  requested_purpose text default null,
  requested_visit_date date default null,
  requested_arrival_mode text default 'no_vehicle',
  requested_vehicle_details jsonb default null,
  requested_address_details jsonb default null,
  requested_photo_intent_id uuid default null,
  requested_photo_bytes integer default null,
  requested_photo_sha256 text default null,
  requested_id_intent_id uuid default null,
  requested_id_bytes integer default null,
  requested_id_sha256 text default null,
  requested_vehicle_photo_intent_id uuid default null,
  requested_vehicle_photo_bytes integer default null,
  requested_vehicle_photo_sha256 text default null,
  requested_registration_mode text default 'new',
  requested_returning_profile_id uuid default null,
  requested_returning_match_token_digest text default null,
  requested_identity_verification_id uuid default null,
  requested_returning_attempt_id uuid default null,
  requested_person_name text default null,
  requested_tracking_token_digest text default null,
  requested_tracking_token_expires_at timestamptz default null,
  requested_encrypted_tracking_token text default null,
  requested_visit_type text default 'specific_person',
  requested_source public.pass_source default 'portal',
  requested_pass_token_digest text default null,
  requested_expected_gate text default null
)
returns table (
  visit_id uuid,
  request_id uuid,
  approval_status public.office_approval_status,
  attendance_status public.office_attendance_status,
  encrypted_tracking_token text,
  pass_id uuid,
  public_reference uuid,
  valid_from timestamptz,
  valid_until timestamptz,
  decision_source text,
  office_requires_approval_snapshot boolean
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  target_office public.offices%rowtype;
  office_sched_status text;
  office_sched_reason text;
  target_personnel public.office_personnel%rowtype;
  settings public.app_settings%rowtype;
  new_visit_id uuid;
  existing_visit public.office_visits%rowtype;
  photo_intent public.upload_intents%rowtype;
  id_intent public.upload_intents%rowtype;
  vehicle_photo_intent public.upload_intents%rowtype;
  verification_record public.portal_identity_verification_attempts%rowtype;
  returning_attempt_record public.returning_identity_attempts%rowtype;
  returning_profile_record public.returning_visitor_profiles%rowtype;
  v_bound_profile_id uuid := null;
  v_bound_verification_id uuid := null;
  v_bound_returning_id uuid := null;
  v_plate_key text;
  v_manila_today date;
  v_max_date date;
  target_closure_title text;
  v_effective_person_name text;
  v_existing_encrypted_token text := null;
  v_full_name text;
  v_expected_gate text;
  v_normalized_email text;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'service role required';
  end if;

  if requested_visit_type not in ('general', 'specific_person') then
    raise exception using errcode = '22023', message = 'invalid_visit_type';
  end if;

  if requested_source not in ('portal'::public.pass_source, 'kiosk'::public.pass_source) then
    raise exception using errcode = '22023', message = 'unsupported_source';
  end if;

  if requested_source = 'portal'::public.pass_source then
    if not exists (
      select 1 from auth.users u
      where u.id = requested_actor_id and coalesce(u.is_anonymous, false) = true
    ) or exists (select 1 from public.staff_profiles where user_id = requested_actor_id)
      or exists (select 1 from public.devices where user_id = requested_actor_id) then
      raise exception using errcode = '42501', message = 'anonymous visitor identity required';
    end if;
  else
    if not exists (
      select 1 from public.devices d
      where d.user_id = requested_actor_id
        and d.type = 'kiosk'::public.device_type
        and d.status = 'active'::public.device_status
    ) then
      raise exception using errcode = '42501', message = 'active_kiosk_identity_required';
    end if;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(requested_request_id::text, 0));

  select * into existing_visit from public.office_visits ov
  where ov.request_id = requested_request_id;
  if found then
    select outbox.encrypted_token_payload into v_existing_encrypted_token
    from public.office_visit_email_outbox outbox
    where outbox.office_visit_id = existing_visit.id and outbox.email_type = 'tracking_ack'
    order by outbox.created_at desc limit 1;

    return query select
      existing_visit.id,
      existing_visit.request_id,
      existing_visit.approval_status,
      existing_visit.attendance_status,
      coalesce(v_existing_encrypted_token, requested_encrypted_tracking_token),
      existing_visit.pass_id,
      null::uuid,
      null::timestamptz,
      null::timestamptz,
      existing_visit.decision_source,
      true;
    return;
  end if;

  select * into target_office from public.offices
  where id = requested_office_id and active and publication_status = 'published' and archived_at is null;
  if not found then
    raise exception using errcode = '22023', message = 'office_not_found_or_inactive';
  end if;

  if requested_personnel_id is not null then
    select * into target_personnel from public.office_personnel
    where id = requested_personnel_id and office_id = requested_office_id and active;
    if not found then
      raise exception using errcode = '22023', message = 'personnel_not_found';
    end if;
    v_effective_person_name := coalesce(nullif(btrim(requested_person_name), ''), target_personnel.name);
  else
    v_effective_person_name := nullif(btrim(requested_person_name), '');
  end if;

  select * into settings from public.app_settings order by updated_at desc limit 1;
  v_manila_today := (timezone('Asia/Manila', now()))::date;
  v_max_date := v_manila_today + make_interval(days => coalesce(settings.max_advance_booking_days, 14));

  if requested_visit_date is null or requested_visit_date < v_manila_today or requested_visit_date > v_max_date then
    raise exception using errcode = '22023', message = 'invalid_visit_date';
  end if;

  select title into target_closure_title from public.campus_closures
  where requested_visit_date between start_date and end_date limit 1;
  if target_closure_title is not null then
    raise exception using errcode = '22023', message = 'campus_closed_on_date';
  end if;

  select status, reason into office_sched_status, office_sched_reason
  from public.office_calendar_schedules
  where office_id = requested_office_id and schedule_date = requested_visit_date;
  if office_sched_status is not null and office_sched_status in ('closed', 'maintenance', 'holiday') then
    raise exception using errcode = '22023', message = 'office_closed_on_date';
  end if;

  if requested_first_name is null or char_length(btrim(requested_first_name)) = 0 then
    raise exception using errcode = '22023', message = 'first_name_required';
  end if;
  if requested_last_name is null or char_length(btrim(requested_last_name)) = 0 then
    raise exception using errcode = '22023', message = 'last_name_required';
  end if;
  if requested_contact_number is null or char_length(btrim(requested_contact_number)) < 7 then
    raise exception using errcode = '22023', message = 'contact_number_required';
  end if;

  -- For specific_person, email is mandatory
  if requested_visit_type = 'specific_person' and (requested_email is null or char_length(btrim(requested_email)) = 0) then
    raise exception using errcode = '22023', message = 'email_required_for_specific_person';
  end if;
  v_normalized_email := nullif(lower(btrim(requested_email)), '');

  if requested_purpose is null or char_length(btrim(requested_purpose)) < 3 then
    raise exception using errcode = '22023', message = 'purpose_too_short';
  end if;

  if requested_arrival_mode = 'vehicle' then
    if requested_vehicle_details is null or (requested_vehicle_details->>'plateNumber') is null then
      raise exception using errcode = '22023', message = 'vehicle_details_required';
    end if;
    v_plate_key := upper(regexp_replace(requested_vehicle_details->>'plateNumber', '[^a-zA-Z0-9]', '', 'g'));
    if char_length(v_plate_key) < 4 then
      raise exception using errcode = '22023', message = 'invalid_plate_number';
    end if;
  end if;

  if requested_registration_mode = 'new' then
    if requested_photo_intent_id is null or requested_id_intent_id is null then
      raise exception using errcode = '22023', message = 'intents_required_for_new_registration';
    end if;

    select * into photo_intent from public.upload_intents
    where id = requested_photo_intent_id and actor_id = requested_actor_id
      and kind = 'photo'::public.upload_intent_kind and status = 'pending'::public.upload_intent_status;
    if not found or photo_intent.expires_at < now() or photo_intent.sha256_hex <> requested_photo_sha256
       or (requested_photo_bytes is not null and requested_photo_bytes not between 1 and photo_intent.max_bytes) then
      raise exception using errcode = '22023', message = 'invalid_photo_upload_intent';
    end if;

    select * into id_intent from public.upload_intents
    where id = requested_id_intent_id and actor_id = requested_actor_id
      and kind = 'id'::public.upload_intent_kind and status = 'pending'::public.upload_intent_status;
    if not found or id_intent.expires_at < now() or id_intent.sha256_hex <> requested_id_sha256
       or (requested_id_bytes is not null and requested_id_bytes not between 1 and id_intent.max_bytes) then
      raise exception using errcode = '22023', message = 'invalid_id_upload_intent';
    end if;

    update public.upload_intents set held_until = greatest(expires_at, now() + interval '14 days')
    where id in (photo_intent.id, id_intent.id);

  elsif requested_registration_mode = 'returning' then
    if requested_returning_profile_id is null or requested_identity_verification_id is null then
      raise exception using errcode = '22023', message = 'returning_verification_linkage_required';
    end if;

    select * into returning_profile_record from public.returning_visitor_profiles
    where id = requested_returning_profile_id and status = 'active';
    if not found then
      raise exception using errcode = '22023', message = 'invalid_returning_profile';
    end if;

    select * into verification_record from public.portal_identity_verification_attempts
    where id = requested_identity_verification_id and visitor_actor_id = requested_actor_id
      and returning_profile_id = requested_returning_profile_id and decision = 'matched';
    if not found or verification_record.expires_at < now() then
      raise exception using errcode = '22023', message = 'unmatched_or_expired_portal_verification';
    end if;

    if requested_returning_attempt_id is not null then
      select * into returning_attempt_record from public.returning_identity_attempts
      where id = requested_returning_attempt_id and returning_profile_id = requested_returning_profile_id
        and verified_at is not null;
      if not found then
        raise exception using errcode = '22023', message = 'unverified_returning_attempt';
      end if;
      v_bound_returning_id := returning_attempt_record.id;
    end if;

    v_bound_profile_id := returning_profile_record.id;
    v_bound_verification_id := verification_record.id;
  else
    raise exception using errcode = '22023', message = 'invalid_registration_mode';
  end if;

  if requested_arrival_mode = 'vehicle' and requested_vehicle_photo_intent_id is not null then
    select * into vehicle_photo_intent from public.upload_intents
    where id = requested_vehicle_photo_intent_id and actor_id = requested_actor_id
      and kind = 'vehicle_photo'::public.upload_intent_kind and status = 'pending'::public.upload_intent_status;
    if not found or vehicle_photo_intent.expires_at < now() or vehicle_photo_intent.sha256_hex <> requested_vehicle_photo_sha256
       or (requested_vehicle_photo_bytes is not null and requested_vehicle_photo_bytes not between 1 and vehicle_photo_intent.max_bytes) then
      raise exception using errcode = '22023', message = 'invalid_vehicle_photo_upload_intent';
    end if;

    update public.upload_intents set held_until = greatest(expires_at, now() + interval '14 days')
    where id = vehicle_photo_intent.id;
  end if;

  v_expected_gate := coalesce(nullif(btrim(requested_expected_gate), ''), target_office.expected_gate, 'Gate 1');
  v_full_name := btrim(concat_ws(' ', nullif(btrim(requested_first_name), ''), nullif(btrim(requested_middle_name), ''), nullif(btrim(requested_last_name), '')));

  -- Unconditionally create pending office visit request with ZERO ordinary pass
  insert into public.office_visits (
    visit_type, office_id, personnel_id, requested_person_name,
    approval_status, attendance_status,
    visitor_first_name, visitor_middle_name, visitor_last_name, visitor_display_name,
    visitor_contact_number, visitor_email, visitor_email_verified,
    visitor_actor_id, purpose, visit_date, arrival_mode,
    vehicle_details, address_details,
    photo_intent_id, photo_bytes, photo_sha256,
    id_intent_id, id_bytes, id_sha256,
    vehicle_photo_intent_id, vehicle_photo_bytes, vehicle_photo_sha256,
    registration_mode, returning_profile_id, identity_verification_id, returning_attempt_id,
    request_id, email_delivery_status,
    tracking_token_digest, tracking_token_expires_at,
    source, office_requires_approval_snapshot, expected_gate
  ) values (
    requested_visit_type, requested_office_id, requested_personnel_id, v_effective_person_name,
    'pending'::public.office_approval_status, 'pending'::public.office_attendance_status,
    btrim(requested_first_name), nullif(btrim(requested_middle_name), ''), btrim(requested_last_name), v_full_name,
    btrim(requested_contact_number), v_normalized_email, (v_normalized_email is not null),
    requested_actor_id, btrim(requested_purpose), requested_visit_date, requested_arrival_mode,
    requested_vehicle_details, requested_address_details,
    requested_photo_intent_id, requested_photo_bytes, requested_photo_sha256,
    requested_id_intent_id, requested_id_bytes, requested_id_sha256,
    requested_vehicle_photo_intent_id, requested_vehicle_photo_bytes, requested_vehicle_photo_sha256,
    requested_registration_mode, v_bound_profile_id, v_bound_verification_id, v_bound_returning_id,
    requested_request_id, case when v_normalized_email is not null then 'pending' else 'none' end,
    requested_tracking_token_digest, coalesce(requested_tracking_token_expires_at, now() + interval '30 days'),
    requested_source, true, v_expected_gate
  ) returning id into new_visit_id;

  if v_normalized_email is not null and requested_encrypted_tracking_token is not null then
    insert into public.office_visit_email_outbox (
      office_visit_id, email_type, recipient_email, encrypted_token_payload, delivery_status, idempotency_key
    ) values (
      new_visit_id, 'tracking_ack', v_normalized_email, requested_encrypted_tracking_token, 'pending',
      'tracking-ack-' || new_visit_id::text
    ) on conflict (office_visit_id, email_type) do nothing;
  end if;

  insert into public.office_visit_events (
    office_visit_id, event_type, actor_id, actor_role, metadata
  ) values (
    new_visit_id, 'requested', requested_actor_id, 'visitor',
    jsonb_build_object(
      'visit_type', requested_visit_type,
      'office_id', requested_office_id,
      'personnel_id', requested_personnel_id,
      'purpose', requested_purpose,
      'visit_date', requested_visit_date,
      'arrival_mode', requested_arrival_mode,
      'registration_mode', requested_registration_mode,
      'returning_profile_id', v_bound_profile_id,
      'source', requested_source,
      'office_requires_approval_snapshot', true
    )
  );

  return query select
    new_visit_id,
    requested_request_id,
    'pending'::public.office_approval_status,
    'pending'::public.office_attendance_status,
    requested_encrypted_tracking_token,
    null::uuid,
    null::uuid,
    null::timestamptz,
    null::timestamptz,
    null::text,
    true;
end;
$$;

revoke all on function api.create_specific_person_visit_request(
  uuid, uuid, uuid, uuid, text, text, text, text, text, text, date, text, jsonb, jsonb,
  uuid, integer, text, uuid, integer, text, uuid, integer, text, text, uuid, text, uuid, uuid,
  text, text, timestamptz, text, text, public.pass_source, text, text
) from public, anon, authenticated;

grant execute on function api.create_specific_person_visit_request(
  uuid, uuid, uuid, uuid, text, text, text, text, text, text, date, text, jsonb, jsonb,
  uuid, integer, text, uuid, integer, text, uuid, integer, text, text, uuid, text, uuid, uuid,
  text, text, timestamptz, text, text, public.pass_source, text, text
) to service_role;

commit;
