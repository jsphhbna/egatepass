-- Migration 84: Specific-Person Request Acknowledgement & Secure Status Tracking
-- Establishes:
-- 1. Tracking capability columns and unique index on public.office_visits
-- 2. Durable acknowledgement email outbox table public.office_visit_acknowledgement_outbox
-- 3. Atomic outbox claim and result RPCs for acknowledgement delivery
-- 4. Secure sanitized tracking status lookup RPC
-- 5. Updated api.create_specific_person_visit_request supporting tracking token and idempotent token recovery
-- 6. Updated api.record_resend_delivery_event reconciling acknowledgement outbox deliveries

-- =============================================================================
-- 1. Office Visits Tracking Columns & Index
-- =============================================================================
alter table public.office_visits
  add column if not exists tracking_token_digest text,
  add column if not exists tracking_token_expires_at timestamptz,
  add column if not exists tracking_token_revoked_at timestamptz;

create unique index if not exists idx_office_visits_tracking_digest
  on public.office_visits (tracking_token_digest)
  where tracking_token_digest is not null;

-- =============================================================================
-- 2. Dedicated Acknowledgement Email Outbox
-- =============================================================================
create table if not exists public.office_visit_acknowledgement_outbox (
  id uuid primary key default gen_random_uuid(),
  office_visit_id uuid not null references public.office_visits(id) on delete cascade,
  recipient_email text not null,
  encrypted_tracking_token text not null,
  idempotency_key text not null unique,
  delivery_status text not null default 'pending' check (delivery_status in ('pending', 'processing', 'sent', 'failed', 'unknown', 'reconciliation_required')),
  provider_message_id text,
  attempt_count integer not null default 0,
  last_attempt_at timestamptz,
  last_error text,
  claim_id uuid,
  lease_expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (office_visit_id)
);

create index if not exists idx_office_visit_ack_outbox_visit_id
  on public.office_visit_acknowledgement_outbox (office_visit_id);

create index if not exists idx_office_visit_ack_outbox_status
  on public.office_visit_acknowledgement_outbox (delivery_status);

create index if not exists idx_office_visit_ack_outbox_provider_msg
  on public.office_visit_acknowledgement_outbox (provider_message_id)
  where provider_message_id is not null;

alter table public.office_visit_acknowledgement_outbox enable row level security;
revoke all on public.office_visit_acknowledgement_outbox from public, anon, authenticated;
grant select, insert, update, delete on public.office_visit_acknowledgement_outbox to service_role;

-- =============================================================================
-- 3. RPC: api.claim_office_visit_acknowledgement_for_delivery
-- =============================================================================
create or replace function api.claim_office_visit_acknowledgement_for_delivery(
  requested_visit_id uuid
)
returns table (
  outbox_id uuid,
  claim_id uuid,
  recipient_email text,
  encrypted_tracking_token text,
  idempotency_key text,
  attempt_count integer
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  target_ack public.office_visit_acknowledgement_outbox%rowtype;
  v_claim_id uuid;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'service role required';
  end if;

  -- Canonical lock order: lock office_visits first, then ack outbox
  perform 1 from public.office_visits where id = requested_visit_id for update;

  select * into target_ack
  from public.office_visit_acknowledgement_outbox
  where office_visit_id = requested_visit_id
  for update;

  if not found then
    return;
  end if;

  -- Terminal state: never re-claim sent or delivered
  if target_ack.delivery_status in ('sent', 'delivered') then
    return;
  end if;

  -- Active lease check
  if target_ack.delivery_status = 'processing' and target_ack.lease_expires_at is not null and target_ack.lease_expires_at > now() then
    return;
  end if;

  v_claim_id := gen_random_uuid();

  update public.office_visit_acknowledgement_outbox set
    claim_id = v_claim_id,
    delivery_status = 'processing',
    lease_expires_at = now() + interval '5 minutes',
    attempt_count = target_ack.attempt_count + 1,
    last_attempt_at = now(),
    updated_at = now()
  where id = target_ack.id;

  return query select
    target_ack.id,
    v_claim_id,
    target_ack.recipient_email,
    target_ack.encrypted_tracking_token,
    target_ack.idempotency_key,
    target_ack.attempt_count + 1;
end;
$$;

revoke all on function api.claim_office_visit_acknowledgement_for_delivery(uuid) from public, anon, authenticated;
grant execute on function api.claim_office_visit_acknowledgement_for_delivery(uuid) to service_role;

-- =============================================================================
-- 4. RPC: api.record_office_visit_acknowledgement_result
-- =============================================================================
create or replace function api.record_office_visit_acknowledgement_result(
  requested_outbox_id uuid,
  requested_claim_id uuid,
  requested_status text,
  requested_provider_message_id text default null,
  requested_error text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  target_ack public.office_visit_acknowledgement_outbox%rowtype;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'service role required';
  end if;

  if requested_status not in ('sent', 'delivered', 'failed', 'unknown', 'reconciliation_required') then
    raise exception using errcode = '22023', message = 'invalid_delivery_status';
  end if;

  select * into target_ack
  from public.office_visit_acknowledgement_outbox
  where id = requested_outbox_id
  for update;

  if not found then
    return jsonb_build_object('ok', false, 'error', 'outbox_record_not_found');
  end if;

  if target_ack.claim_id is null or requested_claim_id is null or target_ack.claim_id <> requested_claim_id then
    raise exception using errcode = '40900', message = 'stale_or_invalid_claim_cannot_overwrite';
  end if;

  if requested_status <> 'reconciliation_required' and target_ack.lease_expires_at is not null and target_ack.lease_expires_at < now() then
    raise exception using errcode = '40900', message = 'expired_claim_cannot_overwrite';
  end if;

  -- Terminal state protection: never regress sent or delivered with failure or unknown
  if target_ack.delivery_status in ('sent', 'delivered') and requested_status in ('failed', 'unknown') then
    return jsonb_build_object('ok', true, 'status', target_ack.delivery_status, 'noop', true);
  end if;

  update public.office_visit_acknowledgement_outbox set
    delivery_status = requested_status,
    provider_message_id = coalesce(requested_provider_message_id, provider_message_id),
    last_error = requested_error,
    claim_id = null,
    lease_expires_at = null,
    updated_at = now()
  where id = requested_outbox_id;

  return jsonb_build_object(
    'ok', true,
    'outbox_id', requested_outbox_id,
    'status', requested_status
  );
end;
$$;

revoke all on function api.record_office_visit_acknowledgement_result(uuid, uuid, text, text, text) from public, anon, authenticated;
grant execute on function api.record_office_visit_acknowledgement_result(uuid, uuid, text, text, text) to service_role;

-- =============================================================================
-- 5. RPC: api.lookup_office_visit_tracking_status
-- =============================================================================
create or replace function api.lookup_office_visit_tracking_status(
  requested_token_digest text
)
returns table (
  visitor_first_name text,
  visitor_last_name text,
  office_name text,
  personnel_name text,
  visit_date date,
  purpose text,
  approval_status text,
  submitted_at timestamptz,
  decided_at timestamptz,
  updated_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'service role required';
  end if;

  if requested_token_digest is null or char_length(requested_token_digest) <> 64 then
    return;
  end if;

  return query
  select
    v.visitor_first_name,
    v.visitor_last_name,
    coalesce(o.name, 'EARIST Office') as office_name,
    coalesce(v.requested_person_name, p.name, 'Office Staff') as personnel_name,
    v.visit_date,
    v.purpose,
    v.approval_status::text,
    v.created_at as submitted_at,
    v.decision_recorded_at as decided_at,
    v.updated_at
  from public.office_visits v
  left join public.offices o on o.id = v.office_id
  left join public.office_personnel p on p.id = v.personnel_id
  where v.tracking_token_digest = requested_token_digest
    and v.tracking_token_revoked_at is null
    and v.tracking_token_expires_at > now();
end;
$$;

revoke all on function api.lookup_office_visit_tracking_status(text) from public, anon, authenticated;
grant execute on function api.lookup_office_visit_tracking_status(text) to service_role;

-- =============================================================================
-- 6. RPC: Update api.create_specific_person_visit_request
-- =============================================================================
drop function if exists api.create_specific_person_visit_request(
  uuid, uuid, uuid, uuid, text, text, text, text, text, text, date, text, jsonb, jsonb, uuid, integer, text, uuid, integer, text, uuid, integer, text, text, uuid, text, uuid, uuid, text
);

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
  requested_encrypted_tracking_token text default null
)
returns table (
  visit_id uuid,
  request_id uuid,
  approval_status public.office_approval_status,
  attendance_status public.office_attendance_status,
  encrypted_tracking_token text
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  target_office public.offices%rowtype;
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
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'service role required';
  end if;

  select * into settings from public.app_settings limit 1;

  -- 1. Idempotency Check
  select * into existing_visit from public.office_visits
  where office_visits.request_id = requested_request_id;

  if found then
    if existing_visit.visitor_actor_id <> requested_actor_id then
      raise exception using errcode = '42501', message = 'request_id_actor_mismatch';
    end if;

    if existing_visit.office_id <> requested_office_id
      or (requested_personnel_id is not null and existing_visit.personnel_id <> requested_personnel_id)
      or existing_visit.visitor_email <> requested_email
      or existing_visit.visit_date <> requested_visit_date then
      raise exception using errcode = '40900', message = 'idempotency_conflict';
    end if;

    select ovo.encrypted_tracking_token into v_existing_encrypted_token
    from public.office_visit_acknowledgement_outbox ovo
    where ovo.office_visit_id = existing_visit.id;

    return query select
      existing_visit.id,
      existing_visit.request_id,
      existing_visit.approval_status,
      existing_visit.attendance_status,
      v_existing_encrypted_token;
    return;
  end if;

  -- 2. Validate Scheduling Window
  v_manila_today := (now() at time zone 'Asia/Manila')::date;
  v_max_date := v_manila_today + coalesce(settings.scheduling_days_ahead, 14);

  if requested_visit_date < v_manila_today then
    raise exception using errcode = '22023', message = 'visit_date_in_past';
  end if;

  if requested_visit_date > v_max_date then
    raise exception using errcode = '22023', message = 'visit_date_beyond_horizon';
  end if;

  -- Closed Date Enforcement: Check Institutional Campus Closures
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

  -- 3. Validate Office: Must be active
  select * into target_office from public.offices
  where id = requested_office_id and active;
  if not found then
    raise exception using errcode = '22023', message = 'office_not_found_or_inactive';
  end if;

  -- 4. Validate Personnel or Free-Text Requested Person Name
  v_effective_person_name := nullif(btrim(requested_person_name), '');
  if v_effective_person_name is not null then
    if char_length(v_effective_person_name) not between 2 and 150 then
      raise exception using errcode = '22023', message = 'requested_person_name_invalid_length';
    end if;
  elsif requested_personnel_id is not null then
    select * into target_personnel from public.office_personnel
    where id = requested_personnel_id and office_id = requested_office_id and active;
    if not found then
      raise exception using errcode = '22023', message = 'personnel_not_found_or_inactive';
    end if;
    v_effective_person_name := target_personnel.name;
  else
    raise exception using errcode = '22023', message = 'requested_person_name_required';
  end if;

  -- 5. Basic Constraints
  if requested_first_name is null or char_length(btrim(requested_first_name)) = 0 then
    raise exception using errcode = '22023', message = 'first_name_required';
  end if;
  if requested_last_name is null or char_length(btrim(requested_last_name)) = 0 then
    raise exception using errcode = '22023', message = 'last_name_required';
  end if;
  if requested_contact_number is null or char_length(btrim(requested_contact_number)) = 0 then
    raise exception using errcode = '22023', message = 'contact_number_required';
  end if;
  if requested_email is null or char_length(btrim(requested_email)) = 0 then
    raise exception using errcode = '22023', message = 'email_required';
  end if;
  if requested_purpose is null or char_length(btrim(requested_purpose)) < 3 then
    raise exception using errcode = '22023', message = 'purpose_too_short';
  end if;

  -- 6. Validate Arrival Mode and Vehicle Details
  if requested_arrival_mode = 'vehicle' then
    if requested_vehicle_details is null
      or requested_vehicle_details->>'vehicleType' is null
      or requested_vehicle_details->>'vehicleType' not in ('car', 'motorcycle', 'van', 'suv', 'truck', 'bicycle', 'other')
      or requested_vehicle_details->>'plateNumber' is null
      or char_length(btrim(requested_vehicle_details->>'plateNumber')) not between 3 and 16
      or requested_vehicle_details->>'color' is null
      or char_length(btrim(requested_vehicle_details->>'color')) not between 2 and 40 then
      raise exception using errcode = '22023', message = 'invalid_vehicle_declaration';
    end if;

    if requested_vehicle_photo_intent_id is null then
      raise exception using errcode = '22023', message = 'vehicle_photo_required';
    end if;

    v_plate_key := upper(regexp_replace(requested_vehicle_details->>'plateNumber', '[^a-zA-Z0-9]', '', 'g'));
    if char_length(v_plate_key) not between 3 and 16 then
      raise exception using errcode = '22023', message = 'invalid_vehicle_plate';
    end if;

    -- Active plate collision check on campus
    if exists (
      select 1 from public.visit_vehicle_declarations vvd
      join public.passes p on p.id = vvd.pass_id
      where vvd.plate_key = v_plate_key
        and vvd.entry_recorded_at is not null
        and vvd.exit_recorded_at is null
        and p.status in ('issued', 'pending', 'inside')
    ) then
      raise exception using errcode = '40900', message = 'plate_already_active_on_campus';
    end if;
  elsif requested_arrival_mode = 'no_vehicle' then
    if requested_vehicle_details is not null or requested_vehicle_photo_intent_id is not null then
      raise exception using errcode = '22023', message = 'unexpected_vehicle_details';
    end if;
  else
    raise exception using errcode = '22023', message = 'invalid_arrival_mode';
  end if;

  -- 7. Identity Verification & Registration Mode Validation
  if requested_registration_mode = 'new' then
    if requested_photo_intent_id is null or requested_id_intent_id is null then
      raise exception using errcode = '42501', message = 'identity_proof_required';
    end if;

    if requested_returning_profile_id is not null or requested_returning_match_token_digest is not null then
      raise exception using errcode = '42501', message = 'returning_metadata_forbidden';
    end if;

    select * into verification_record
    from public.portal_identity_verification_attempts piva
    where piva.owner_id = requested_actor_id
      and piva.request_id = requested_request_id::text
      and piva.photo_intent_id = requested_photo_intent_id
      and piva.id_intent_id = requested_id_intent_id
      and piva.outcome = 'matched'
      and piva.expires_at > now()
    order by piva.verified_at desc
    limit 1;

    if not found then
      raise exception using errcode = '42501', message = 'valid_matched_identity_verification_required';
    end if;

    v_bound_verification_id := verification_record.id;

    if exists (
      select 1 from public.office_visits ov_check
      where ov_check.identity_verification_id = v_bound_verification_id
        and ov_check.request_id <> requested_request_id
    ) then
      raise exception using errcode = '40900', message = 'identity_verification_already_consumed';
    end if;

    -- Inspect and hold photo upload intent
    select * into photo_intent from public.upload_intents
    where id = requested_photo_intent_id
    for update;
    if not found or photo_intent.owner_id <> requested_actor_id
      or photo_intent.source <> 'portal'::public.pass_source
      or photo_intent.kind <> 'photo'::public.evidence_kind
      or photo_intent.status not in ('pending'::public.upload_intent_status, 'uploaded'::public.upload_intent_status)
      or photo_intent.expires_at <= now()
      or (requested_photo_bytes is not null and requested_photo_bytes not between 1 and photo_intent.max_bytes) then
      raise exception using errcode = '22023', message = 'invalid_photo_upload_intent';
    end if;

    -- Inspect and hold id upload intent
    select * into id_intent from public.upload_intents
    where id = requested_id_intent_id
    for update;
    if not found or id_intent.owner_id <> requested_actor_id
      or id_intent.source <> 'portal'::public.pass_source
      or id_intent.kind <> 'id'::public.evidence_kind
      or id_intent.status not in ('pending'::public.upload_intent_status, 'uploaded'::public.upload_intent_status)
      or id_intent.expires_at <= now()
      or (requested_id_bytes is not null and requested_id_bytes not between 1 and id_intent.max_bytes) then
      raise exception using errcode = '22023', message = 'invalid_id_upload_intent';
    end if;

    update public.upload_intents set
      held_until = greatest(expires_at, now() + interval '14 days')
    where id in (photo_intent.id, id_intent.id);

  elsif requested_registration_mode = 'returning' then
    if requested_returning_profile_id is null or requested_returning_match_token_digest is null then
      raise exception using errcode = '42501', message = 'returning_match_credentials_required';
    end if;

    select * into returning_profile_record
    from public.returning_visitor_profiles
    where id = requested_returning_profile_id and revoked_at is null and expires_at > now();

    if not found then
      raise exception using errcode = '42501', message = 'returning_profile_not_found_or_expired';
    end if;

    select * into returning_attempt_record
    from public.returning_identity_attempts ria
    where ria.owner_id = requested_actor_id
      and ria.request_id = requested_request_id::text
      and ria.matched_profile_id = requested_returning_profile_id
      and ria.match_token_digest = requested_returning_match_token_digest
      and ria.outcome in ('matched', 'provisional_matched')
      and ria.expires_at > now()
    order by ria.created_at desc
    limit 1;

    if not found then
      raise exception using errcode = '42501', message = 'valid_returning_identity_match_required';
    end if;

    v_bound_profile_id := returning_profile_record.id;
    v_bound_returning_id := returning_attempt_record.id;

    if exists (
      select 1 from public.office_visits ov_ret_check
      where ov_ret_check.returning_attempt_id = v_bound_returning_id
        and ov_ret_check.request_id <> requested_request_id
    ) then
      raise exception using errcode = '40900', message = 'returning_attempt_already_consumed';
    end if;
  else
    raise exception using errcode = '22023', message = 'invalid_registration_mode';
  end if;

  -- 8. Validate and hold vehicle photo upload intent (if vehicle declared)
  if requested_arrival_mode = 'vehicle' and requested_vehicle_photo_intent_id is not null then
    select * into vehicle_photo_intent from public.upload_intents
    where id = requested_vehicle_photo_intent_id
    for update;
    if not found or vehicle_photo_intent.owner_id <> requested_actor_id
      or vehicle_photo_intent.source <> 'portal'::public.pass_source
      or vehicle_photo_intent.kind <> 'vehicle_photo'::public.evidence_kind
      or vehicle_photo_intent.status not in ('pending'::public.upload_intent_status, 'uploaded'::public.upload_intent_status)
      or vehicle_photo_intent.expires_at <= now()
      or (requested_vehicle_photo_bytes is not null and requested_vehicle_photo_bytes not between 1 and vehicle_photo_intent.max_bytes) then
      raise exception using errcode = '22023', message = 'invalid_vehicle_photo_upload_intent';
    end if;

    update public.upload_intents set
      held_until = greatest(expires_at, now() + interval '14 days')
    where id = vehicle_photo_intent.id;
  end if;

  -- 9. Create office_visit Record
  insert into public.office_visits (
    visit_type,
    office_id,
    personnel_id,
    requested_person_name,
    approval_status,
    attendance_status,
    visitor_first_name,
    visitor_middle_name,
    visitor_last_name,
    visitor_contact_number,
    visitor_email,
    visitor_email_verified,
    visitor_actor_id,
    purpose,
    visit_date,
    arrival_mode,
    vehicle_details,
    address_details,
    photo_intent_id,
    photo_bytes,
    photo_sha256,
    id_intent_id,
    id_bytes,
    id_sha256,
    vehicle_photo_intent_id,
    vehicle_photo_bytes,
    vehicle_photo_sha256,
    registration_mode,
    returning_profile_id,
    identity_verification_id,
    returning_attempt_id,
    request_id,
    email_delivery_status,
    tracking_token_digest,
    tracking_token_expires_at
  ) values (
    'specific_person',
    requested_office_id,
    requested_personnel_id,
    v_effective_person_name,
    'pending',
    'awaiting_entry',
    btrim(requested_first_name),
    nullif(btrim(requested_middle_name), ''),
    btrim(requested_last_name),
    btrim(requested_contact_number),
    lower(btrim(requested_email)),
    true,
    requested_actor_id,
    btrim(requested_purpose),
    requested_visit_date,
    requested_arrival_mode,
    requested_vehicle_details,
    requested_address_details,
    requested_photo_intent_id,
    requested_photo_bytes,
    requested_photo_sha256,
    requested_id_intent_id,
    requested_id_bytes,
    requested_id_sha256,
    requested_vehicle_photo_intent_id,
    requested_vehicle_photo_bytes,
    requested_vehicle_photo_sha256,
    requested_registration_mode,
    v_bound_profile_id,
    v_bound_verification_id,
    v_bound_returning_id,
    requested_request_id,
    'pending',
    requested_tracking_token_digest,
    coalesce(requested_tracking_token_expires_at, now() + interval '30 days')
  )
  returning id into new_visit_id;

  -- 10. Enqueue Acknowledgement Email Outbox Entry (if tracking token provided)
  if requested_encrypted_tracking_token is not null then
    insert into public.office_visit_acknowledgement_outbox (
      office_visit_id,
      recipient_email,
      encrypted_tracking_token,
      idempotency_key,
      delivery_status
    ) values (
      new_visit_id,
      lower(btrim(requested_email)),
      requested_encrypted_tracking_token,
      'office-ack-' || new_visit_id::text,
      'pending'
    ) on conflict (office_visit_id) do nothing;
  end if;

  -- 11. Insert Audit Event
  insert into public.office_visit_events (
    office_visit_id,
    event_type,
    actor_id,
    actor_role,
    metadata
  ) values (
    new_visit_id,
    'request_submitted',
    requested_actor_id,
    'visitor',
    jsonb_build_object(
      'office_id', requested_office_id,
      'personnel_id', requested_personnel_id,
      'requested_person_name', v_effective_person_name,
      'visit_date', requested_visit_date,
      'registration_mode', requested_registration_mode,
      'arrival_mode', requested_arrival_mode,
      'has_tracking_capability', (requested_tracking_token_digest is not null)
    )
  );

  return query select
    new_visit_id,
    requested_request_id,
    'pending'::public.office_approval_status,
    'awaiting_entry'::public.office_attendance_status,
    requested_encrypted_tracking_token;
end;
$$;

revoke all on function api.create_specific_person_visit_request(
  uuid, uuid, uuid, uuid, text, text, text, text, text, text, date, text, jsonb, jsonb, uuid, integer, text, uuid, integer, text, uuid, integer, text, text, uuid, text, uuid, uuid, text, text, timestamptz, text
) from public, anon, authenticated;

grant execute on function api.create_specific_person_visit_request(
  uuid, uuid, uuid, uuid, text, text, text, text, text, text, date, text, jsonb, jsonb, uuid, integer, text, uuid, integer, text, uuid, integer, text, text, uuid, text, uuid, uuid, text, text, timestamptz, text
) to service_role;

-- =============================================================================
-- 7. RECONCILE api.record_resend_delivery_event with Acknowledgement Outbox
-- =============================================================================
create or replace function api.record_resend_delivery_event(
  requested_provider_event_id text,
  requested_event_type text,
  requested_email_id text,
  requested_outcome text,
  requested_recipient_masked text,
  requested_subject_sanitized text,
  requested_occurred_at timestamptz,
  requested_outbox_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_inserted_id uuid;
  v_audit_id bigint;
  v_outcome text;
  v_occurred timestamptz;
  v_target_outbox_id uuid;
  v_target_visit_id uuid;
  v_office_outbox public.office_visit_email_outbox%rowtype;
  v_ack_outbox_id uuid;
  v_ack_outbox public.office_visit_acknowledgement_outbox%rowtype;
begin
  if auth.role() <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;

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

  -- 1. Claim provider event ID idempotently
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
    return jsonb_build_object(
      'ok', true,
      'status', 'already_processed',
      'duplicate', true,
      'provider_event_id', trim(requested_provider_event_id),
      'event_type', trim(requested_event_type),
      'email_id', trim(requested_email_id)
    );
  end;

  -- 2. Unlocked lookup in office_visit_email_outbox
  select id, office_visit_id into v_target_outbox_id, v_target_visit_id
  from public.office_visit_email_outbox
  where (
    (trim(requested_email_id) <> '' and provider_message_id = trim(requested_email_id))
    or (requested_outbox_id is not null and id = requested_outbox_id)
  )
  limit 1;

  if v_target_outbox_id is not null then
    -- Lock office_visits first
    if v_target_visit_id is not null then
      perform 1 from public.office_visits where id = v_target_visit_id for update;
    end if;

    select * into v_office_outbox
    from public.office_visit_email_outbox
    where id = v_target_outbox_id
    for update;

    if v_office_outbox.provider_message_id is null and trim(requested_email_id) <> '' then
      update public.office_visit_email_outbox
      set provider_message_id = trim(requested_email_id)
      where id = v_office_outbox.id;
    end if;

    if trim(requested_event_type) = 'email.delivered' then
      if v_office_outbox.delivery_status <> 'delivered' or v_office_outbox.confirmation_source = 'manual_staff' then
        update public.office_visit_email_outbox set
          delivery_status = 'delivered',
          delivered_at = v_occurred,
          claim_id = null,
          lease_expires_at = null,
          reconciliation_source = 'resend_webhook',
          confirmation_source = 'provider_webhook',
          updated_at = now()
        where id = v_office_outbox.id;

        update public.office_visits set
          email_delivery_status = 'delivered',
          confirmation_source = 'provider_webhook',
          updated_at = now()
        where id = v_office_outbox.office_visit_id;
      end if;
    elsif trim(requested_event_type) in ('email.bounced', 'email.complained', 'email.failed') then
      if v_office_outbox.delivery_status <> 'delivered' then
        update public.office_visit_email_outbox set
          delivery_status = 'failed',
          last_error = trim(requested_event_type),
          claim_id = null,
          lease_expires_at = null,
          reconciliation_source = 'resend_webhook',
          confirmation_source = null,
          reconciled_by = null,
          updated_at = now()
        where id = v_office_outbox.id;

        update public.office_visits set
          email_delivery_status = 'failed',
          email_error = trim(requested_event_type),
          confirmation_source = null,
          updated_at = now()
        where id = v_office_outbox.office_visit_id;
      end if;
    elsif trim(requested_event_type) = 'email.sent' then
      if v_office_outbox.delivery_status in ('pending', 'processing', 'unknown', 'reconciliation_required') then
        update public.office_visit_email_outbox set
          delivery_status = 'sent',
          claim_id = null,
          lease_expires_at = null,
          reconciliation_source = 'resend_webhook',
          updated_at = now()
        where id = v_office_outbox.id;

        update public.office_visits set
          email_delivery_status = 'sent',
          email_dispatched_at = coalesce(email_dispatched_at, v_occurred),
          updated_at = now()
        where id = v_office_outbox.office_visit_id;
      end if;
    end if;

    insert into public.office_visit_events (
      office_visit_id, event_type, actor_id, actor_role, metadata
    ) values (
      v_office_outbox.office_visit_id,
      'resend_delivery_event',
      null,
      'system',
      jsonb_build_object(
        'provider_event_id', trim(requested_provider_event_id),
        'event_type', trim(requested_event_type),
        'email_id', trim(requested_email_id),
        'occurred_at', v_occurred,
        'confirmation_source', 'provider_webhook'
      )
    );
  else
    -- Check if matched in office_visit_acknowledgement_outbox
    select id into v_ack_outbox_id
    from public.office_visit_acknowledgement_outbox
    where (
      (trim(requested_email_id) <> '' and provider_message_id = trim(requested_email_id))
      or (requested_outbox_id is not null and id = requested_outbox_id)
    )
    limit 1;

    if v_ack_outbox_id is not null then
      select * into v_ack_outbox
      from public.office_visit_acknowledgement_outbox
      where id = v_ack_outbox_id
      for update;

      if v_ack_outbox.provider_message_id is null and trim(requested_email_id) <> '' then
        update public.office_visit_acknowledgement_outbox
        set provider_message_id = trim(requested_email_id)
        where id = v_ack_outbox.id;
      end if;

      if trim(requested_event_type) = 'email.delivered' then
        update public.office_visit_acknowledgement_outbox set
          delivery_status = 'delivered',
          claim_id = null,
          lease_expires_at = null,
          updated_at = now()
        where id = v_ack_outbox.id;
      elsif trim(requested_event_type) in ('email.bounced', 'email.complained', 'email.failed') then
        if v_ack_outbox.delivery_status <> 'delivered' then
          update public.office_visit_acknowledgement_outbox set
            delivery_status = 'failed',
            last_error = trim(requested_event_type),
            claim_id = null,
            lease_expires_at = null,
            updated_at = now()
          where id = v_ack_outbox.id;
        end if;
      elsif trim(requested_event_type) = 'email.sent' then
        if v_ack_outbox.delivery_status in ('pending', 'processing', 'unknown', 'reconciliation_required') then
          update public.office_visit_acknowledgement_outbox set
            delivery_status = 'sent',
            claim_id = null,
            lease_expires_at = null,
            updated_at = now()
          where id = v_ack_outbox.id;
        end if;
      end if;
    end if;
  end if;

  -- 3. Insert append-only audit event
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
      'outboxId', requested_outbox_id,
      'providerEventId', trim(requested_provider_event_id),
      'recipientMasked', requested_recipient_masked,
      'subjectSanitized', requested_subject_sanitized,
      'correlatedOfficeOutboxId', v_office_outbox.id,
      'correlatedAckOutboxId', v_ack_outbox_id,
      'delivery_status', case
        when trim(requested_event_type) = 'email.delivered' then 'delivered'
        when trim(requested_event_type) in ('email.bounced', 'email.complained', 'email.failed') then 'failed'
        when trim(requested_event_type) = 'email.sent' then 'sent'
        else 'other'
      end
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
    'audit_event_id', v_audit_id,
    'outbox_correlated', (v_office_outbox.id is not null or v_ack_outbox_id is not null),
    'outbox_id', coalesce(v_office_outbox.id, v_ack_outbox_id),
    'delivery_status', case
      when trim(requested_event_type) = 'email.delivered' then 'delivered'
      when trim(requested_event_type) in ('email.bounced', 'email.complained', 'email.failed') then 'failed'
      when trim(requested_event_type) = 'email.sent' then 'sent'
      else 'other'
    end
  );
end;
$$;

revoke all on function api.record_resend_delivery_event(text, text, text, text, text, text, timestamptz, uuid) from public, anon, authenticated;
grant execute on function api.record_resend_delivery_event(text, text, text, text, text, text, timestamptz, uuid) to service_role;
