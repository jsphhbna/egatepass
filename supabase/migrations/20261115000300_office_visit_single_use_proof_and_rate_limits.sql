-- Migration: 20261115000300_office_visit_single_use_proof_and_rate_limits.sql
-- Workstream 4 / R5: Single-use office visit verification proof, atomic proof consumption,
-- rate limits, client IP trust, and Resend outbox deduplication beyond 24 hours.

-- =============================================================================
-- 1. Table: public.office_visit_verification_proofs
-- =============================================================================
create table if not exists public.office_visit_verification_proofs (
  id uuid default gen_random_uuid() primary key,
  proof_digest text unique not null,
  actor_id uuid not null,
  email text not null,
  consumed_at timestamptz,
  consumed_by_request_id uuid,
  expires_at timestamptz not null,
  created_at timestamptz default now()
);

create index if not exists idx_office_visit_verification_proofs_lookup
  on public.office_visit_verification_proofs (actor_id, email, expires_at);

create index if not exists idx_office_visit_verification_proofs_consumed_req
  on public.office_visit_verification_proofs (consumed_by_request_id);

alter table public.office_visit_verification_proofs enable row level security;
revoke all on table public.office_visit_verification_proofs from public, anon, authenticated;
grant select, insert, update, delete on table public.office_visit_verification_proofs to service_role;

-- =============================================================================
-- 2. RPC: api.claim_office_visit_acknowledgement_for_delivery
-- Enforce lease lifecycle and reconciliation_required state matching email outbox
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

  -- 1. Canonical lock order: lock office_visits first, then ack outbox
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

  -- Block claiming when reconciliation is required or outcome was unknown
  if target_ack.delivery_status in ('unknown', 'reconciliation_required') then
    raise exception using errcode = '40900', message = 'email_delivery_outcome_unknown_reconciliation_required';
  end if;

  -- Resend 24-hour idempotency window check: if previously attempted > 24h ago, must not blindly retry
  if target_ack.attempt_count > 0 and (target_ack.last_attempt_at < now() - interval '24 hours' or target_ack.created_at < now() - interval '24 hours') then
    update public.office_visit_acknowledgement_outbox set
      delivery_status = 'reconciliation_required',
      claim_id = null,
      lease_expires_at = null,
      last_error = 'Resend idempotency window (24h) expired; reconciliation required before retry.',
      updated_at = now()
    where id = target_ack.id;

    raise exception using errcode = '40900', message = 'email_delivery_outcome_unknown_reconciliation_required';
  end if;

  -- Active lease check / expired lease handling
  if target_ack.delivery_status = 'processing' then
    if target_ack.lease_expires_at is not null and target_ack.lease_expires_at > now() then
      raise exception using errcode = '40900', message = 'email_lease_active_in_progress';
    else
      -- Lease expired: transition row transactionally to reconciliation_required
      update public.office_visit_acknowledgement_outbox set
        delivery_status = 'reconciliation_required',
        claim_id = null,
        lease_expires_at = null,
        last_error = coalesce(target_ack.last_error, 'Processing lease expired; reconciliation required before retry.'),
        updated_at = now()
      where id = target_ack.id;

      return;
    end if;
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
-- 3. RPC: api.create_specific_person_visit_request
-- Atomically validate and consume single-use verification proof digest
-- =============================================================================
drop function if exists api.create_specific_person_visit_request(
  uuid, uuid, uuid, uuid, text, text, text, text, text, text, date, text, jsonb, jsonb, uuid, integer, text, uuid, integer, text, uuid, integer, text, text, uuid, text, uuid, uuid, text, text, timestamptz, text, text, public.pass_source, text, text
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
  requested_encrypted_tracking_token text default null,
  requested_visit_type text default 'specific_person',
  requested_source public.pass_source default 'portal',
  requested_pass_token_digest text default null,
  requested_expected_gate text default null,
  requested_proof_token_digest text default null
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
  office_requires_approval_snapshot boolean,
  inserted boolean
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
  v_home_addr text;
  v_expected_gate text;
  v_normalized_email text;
  new_public_ref uuid := null;
  v_from timestamptz := null;
  v_until timestamptz := null;
  v_proof_record public.office_visit_verification_proofs%rowtype;
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

  -- 0. Advisory lock on request_id for atomic idempotent isolation
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(requested_request_id::text, 0));

  -- 0b. Single-use proof validation (if proof digest provided)
  if requested_proof_token_digest is not null then
    select * into v_proof_record
    from public.office_visit_verification_proofs
    where proof_digest = requested_proof_token_digest
    for update;

    if not found then
      raise exception using errcode = '42501', message = 'proof_not_found';
    end if;

    if v_proof_record.actor_id <> requested_actor_id then
      raise exception using errcode = '42501', message = 'proof_actor_mismatch';
    end if;

    if lower(btrim(v_proof_record.email)) <> lower(btrim(requested_email)) then
      raise exception using errcode = '42501', message = 'proof_email_mismatch';
    end if;

    if v_proof_record.expires_at <= now() then
      raise exception using errcode = '42501', message = 'proof_expired';
    end if;

    if v_proof_record.consumed_at is not null and v_proof_record.consumed_by_request_id <> requested_request_id then
      raise exception using errcode = '42501', message = 'proof_already_consumed';
    end if;
  end if;

  -- 0c. Idempotent request_id check
  select * into existing_visit from public.office_visits ov
  where ov.request_id = requested_request_id;
  if found then
    if existing_visit.visitor_actor_id <> requested_actor_id then
      raise exception using errcode = '42501', message = 'request_id_actor_mismatch';
    end if;

    if requested_proof_token_digest is not null then
      if v_proof_record.consumed_at is not null and v_proof_record.consumed_by_request_id <> requested_request_id then
        raise exception using errcode = '42501', message = 'proof_already_consumed';
      end if;
    end if;

    select ovo.encrypted_tracking_token into v_existing_encrypted_token
    from public.office_visit_acknowledgement_outbox ovo
    where ovo.office_visit_id = existing_visit.id
    order by ovo.created_at desc limit 1;

    if existing_visit.pass_id is not null then
      select p.public_reference, p.valid_from, p.valid_until
      into new_public_ref, v_from, v_until
      from public.passes p where p.id = existing_visit.pass_id;
    end if;

    return query select
      existing_visit.id,
      existing_visit.request_id,
      existing_visit.approval_status,
      existing_visit.attendance_status,
      coalesce(v_existing_encrypted_token, requested_encrypted_tracking_token),
      existing_visit.pass_id,
      new_public_ref,
      v_from,
      v_until,
      existing_visit.decision_source,
      existing_visit.office_requires_approval_snapshot,
      false;
    return;
  end if;

  -- 1. Check office existence and active status
  select * into target_office from public.offices
  where id = requested_office_id and archived_at is null;
  if not found or not target_office.active then
    raise exception using errcode = '22023', message = 'office_not_found_or_inactive';
  end if;

  -- 2. Check date horizon
  select * into settings from public.app_settings where singleton for share;
  v_manila_today := (now() at time zone coalesce(settings.timezone, 'Asia/Manila'))::date;
  v_max_date := v_manila_today + coalesce(settings.scheduling_days_ahead, 14);

  if requested_visit_date is null then
    raise exception using errcode = '22023', message = 'invalid_visit_date';
  end if;
  if requested_visit_date < v_manila_today then
    raise exception using errcode = '22023', message = 'visit_date_in_past';
  end if;
  if requested_visit_date > v_max_date then
    raise exception using errcode = '22023', message = 'visit_date_beyond_horizon';
  end if;

  -- 3. Check campus closures
  select title into target_closure_title from public.campus_calendar_closures
  where active = true and published = true
    and requested_visit_date between start_date and end_date
  limit 1;
  if target_closure_title is not null then
    raise exception 'visit_date_closed: %', target_closure_title using errcode = '22023';
  end if;

  -- 4. Check office publication status
  if target_office.publication_status <> 'published' then
    raise exception using errcode = '22023', message = 'office_not_found_or_unpublished';
  end if;

  -- 5. Check personnel if specified
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

  -- 6. Check office calendar schedules on date
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

  -- Vehicle validation
  if requested_arrival_mode = 'vehicle' then
    if requested_vehicle_details is null or (requested_vehicle_details->>'plateNumber') is null then
      raise exception using errcode = '22023', message = 'vehicle_details_required';
    end if;
    v_plate_key := upper(regexp_replace(requested_vehicle_details->>'plateNumber', '[^a-zA-Z0-9]', '', 'g'));
    if char_length(v_plate_key) < 3 then
      raise exception using errcode = '22023', message = 'invalid_plate_number';
    end if;

    if exists (
      select 1 from public.visit_vehicle_declarations vvd
      join public.passes p on p.id = vvd.pass_id
      where vvd.plate_key = v_plate_key
        and (vvd.entry_recorded_at is not null and vvd.exit_recorded_at is null or p.status in ('inside'))
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

  if requested_registration_mode = 'new' then
    if requested_photo_intent_id is null or requested_id_intent_id is null then
      raise exception using errcode = '22023', message = 'intents_required_for_new_registration';
    end if;

    select * into photo_intent from public.upload_intents
    where id = requested_photo_intent_id and owner_id = requested_actor_id and kind = 'photo' and status in ('pending', 'uploaded');
    if not found then
      raise exception using errcode = '22023', message = 'invalid_photo_upload_intent';
    end if;

    select * into id_intent from public.upload_intents
    where id = requested_id_intent_id and owner_id = requested_actor_id and kind = 'id' and status in ('pending', 'uploaded');
    if not found then
      raise exception using errcode = '22023', message = 'invalid_id_upload_intent';
    end if;

    if requested_identity_verification_id is not null then
      select * into verification_record from public.portal_identity_verification_attempts
      where id = requested_identity_verification_id
        and owner_id = requested_actor_id
        and photo_intent_id = requested_photo_intent_id
        and id_intent_id = requested_id_intent_id
        and outcome = 'matched'
        and expires_at > now();
      if found then
        v_bound_verification_id := verification_record.id;
      end if;
    end if;
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
  else
    raise exception using errcode = '22023', message = 'invalid_registration_mode';
  end if;

  if requested_arrival_mode = 'vehicle' and requested_vehicle_photo_intent_id is not null then
    select * into vehicle_photo_intent from public.upload_intents
    where id = requested_vehicle_photo_intent_id and owner_id = requested_actor_id and kind = 'vehicle_photo' and status in ('pending', 'uploaded');
    if not found then
      raise exception using errcode = '22023', message = 'invalid_vehicle_photo_upload_intent';
    end if;
  end if;

  v_full_name := btrim(concat_ws(' ', nullif(btrim(requested_first_name), ''), nullif(btrim(requested_middle_name), ''), nullif(btrim(requested_last_name), '')));
  v_expected_gate := coalesce(
    nullif(btrim(coalesce(requested_expected_gate, '')), ''),
    nullif(btrim(coalesce(settings.default_expected_gate, '')), ''),
    'Main Gate'
  );

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
    office_requires_approval_snapshot, decision_source, source, expected_gate
  ) values (
    requested_visit_type, requested_office_id, requested_personnel_id, v_effective_person_name,
    'pending'::public.office_approval_status, 'awaiting_entry'::public.office_attendance_status,
    btrim(requested_first_name), nullif(btrim(requested_middle_name), ''), btrim(requested_last_name), v_full_name,
    btrim(requested_contact_number), v_normalized_email, (v_normalized_email is not null),
    requested_actor_id, btrim(requested_purpose), requested_visit_date, requested_arrival_mode,
    requested_vehicle_details, requested_address_details,
    requested_photo_intent_id, requested_photo_bytes, requested_photo_sha256,
    requested_id_intent_id, requested_id_bytes, requested_id_sha256,
    requested_vehicle_photo_intent_id, requested_vehicle_photo_bytes, requested_vehicle_photo_sha256,
    requested_registration_mode, v_bound_profile_id, v_bound_verification_id, v_bound_returning_id,
    requested_request_id, 'pending',
    requested_tracking_token_digest, coalesce(requested_tracking_token_expires_at, now() + interval '30 days'),
    true, null, requested_source, v_expected_gate
  ) returning id into new_visit_id;

  if photo_intent.id is not null or id_intent.id is not null then
    update public.upload_intents
    set held_until = greatest(expires_at, now() + interval '14 days')
    where id in (photo_intent.id, id_intent.id);
  end if;

  if requested_encrypted_tracking_token is not null and v_normalized_email is not null then
    insert into public.office_visit_acknowledgement_outbox (
      office_visit_id, recipient_email, encrypted_tracking_token, idempotency_key, delivery_status
    ) values (
      new_visit_id, v_normalized_email, requested_encrypted_tracking_token, 'office-ack-' || new_visit_id::text, 'pending'
    ) on conflict (office_visit_id) do nothing;
  end if;

  insert into public.office_visit_events (
    office_visit_id, event_type, actor_id, actor_role, metadata
  ) values (
    new_visit_id, 'request_submitted', requested_actor_id,
    case when requested_source = 'kiosk'::public.pass_source then 'device' else 'visitor' end,
    jsonb_build_object(
      'visit_type', requested_visit_type,
      'office_id', requested_office_id,
      'personnel_id', requested_personnel_id,
      'requested_person_name', v_effective_person_name,
      'visit_date', requested_visit_date,
      'office_requires_approval_snapshot', true,
      'source', requested_source
    )
  );

  -- Atomically consume proof inside the same transaction
  if v_proof_record.id is not null then
    update public.office_visit_verification_proofs
    set consumed_at = now(),
        consumed_by_request_id = requested_request_id
    where id = v_proof_record.id;
  end if;

  return query select
    new_visit_id,
    requested_request_id,
    'pending'::public.office_approval_status,
    'awaiting_entry'::public.office_attendance_status,
    requested_encrypted_tracking_token,
    null::uuid,
    null::uuid,
    null::timestamptz,
    null::timestamptz,
    null::text,
    true,
    true;
end;
$$;

revoke all on function api.create_specific_person_visit_request(uuid, uuid, uuid, uuid, text, text, text, text, text, text, date, text, jsonb, jsonb, uuid, integer, text, uuid, integer, text, uuid, integer, text, text, uuid, text, uuid, uuid, text, text, timestamptz, text, text, public.pass_source, text, text, text) from public, anon, authenticated;
grant execute on function api.create_specific_person_visit_request(uuid, uuid, uuid, uuid, text, text, text, text, text, text, date, text, jsonb, jsonb, uuid, integer, text, uuid, integer, text, uuid, integer, text, text, uuid, text, uuid, uuid, text, text, timestamptz, text, text, public.pass_source, text, text, text) to service_role;
