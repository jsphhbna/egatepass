-- ==============================================================================
-- Migration 65: Deep-Dive Root-Cause Remediation & Office Workflow Closure
--
-- 1. Office personnel title relaxation (optional/nullable title)
-- 2. Office email verification atomic rate-limiting RPC (with advisory locking)
-- 3. Office email outbox audit reconciliation attribution (staff vs webhook)
-- 4. Returning visitor provisional mode alignment in create_specific_person_visit_request
-- 5. Vehicle declaration strict boundary and active campus plate collision check
-- 6. Pass vehicle declaration linkage column repair in decide_office_visit
-- 7. Audit-enforced manual email reconciliation (required non-empty note)
-- 8. Least-privilege RLS for visit_vehicle_declarations
-- 9. Nonredundant query performance indexes
-- ==============================================================================

-- 1. Relax office_personnel title constraint
alter table public.office_personnel
  drop constraint if exists office_personnel_title_check;

alter table public.office_personnel
  alter column title drop not null;

alter table public.office_personnel
  add constraint office_personnel_title_check
  check (title is null or char_length(btrim(title)) between 2 and 120);

-- 1b. Support provisional_matched outcome in returning_identity_attempts check constraint
alter table public.returning_identity_attempts
  drop constraint if exists returning_identity_attempts_outcome_check;

alter table public.returning_identity_attempts
  add constraint returning_identity_attempts_outcome_check
  check (outcome in ('matched', 'provisional_matched', 'low_similarity', 'ambiguous_margin', 'uncalibrated_unavailable', 'error'));

-- 2. Add client_ip to office_visit_email_verifications
alter table public.office_visit_email_verifications
  add column if not exists client_ip text default null;

create index if not exists idx_office_email_verif_ip_created
  on public.office_visit_email_verifications(client_ip, created_at);

create index if not exists idx_office_email_verif_actor_created
  on public.office_visit_email_verifications(actor_id, created_at);

create index if not exists idx_office_email_verif_email_created
  on public.office_visit_email_verifications(email, created_at);

-- 3. Add attribution columns to office_visit_email_outbox
alter table public.office_visit_email_outbox
  add column if not exists reconciled_by uuid references public.staff_profiles(user_id) on delete set null,
  add column if not exists reconciliation_source text default null,
  add column if not exists reconciliation_note text default null;

-- 4. Atomic email verification slot allocation RPC
create or replace function api.request_office_email_verification_slot(
  requested_actor_id uuid,
  requested_email text,
  requested_client_ip text,
  requested_code_hash text,
  requested_expires_at timestamptz
)
returns table (
  allowed boolean,
  error_code text,
  verification_id uuid
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  lock_key bigint;
  window_start timestamptz := now() - interval '15 minutes';
  actor_cnt integer;
  email_cnt integer;
  ip_cnt integer;
  inserted_id uuid;
  norm_email text;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'service role required';
  end if;

  norm_email := lower(btrim(requested_email));
  if norm_email is null or char_length(norm_email) = 0 then
    return query select false, 'invalid_email'::text, null::uuid;
    return;
  end if;

  -- Acquire transaction-scoped advisory lock on hash of (actor_id + email)
  lock_key := ('x' || substr(md5(requested_actor_id::text || ':' || norm_email), 1, 16))::bit(64)::bigint;
  perform pg_advisory_xact_lock(lock_key);

  -- 1. Check rate limit for actor (max 5 per 15m)
  select count(*) into actor_cnt
  from public.office_visit_email_verifications
  where actor_id = requested_actor_id
    and created_at > window_start;

  if actor_cnt >= 5 then
    return query select false, 'too_many_actor_requests'::text, null::uuid;
    return;
  end if;

  -- 2. Check rate limit for email (max 5 per 15m)
  select count(*) into email_cnt
  from public.office_visit_email_verifications
  where email = norm_email
    and created_at > window_start;

  if email_cnt >= 5 then
    return query select false, 'too_many_email_requests'::text, null::uuid;
    return;
  end if;

  -- 3. Check rate limit for client IP (max 15 per 15m) if provided
  if requested_client_ip is not null and btrim(requested_client_ip) <> '' then
    select count(*) into ip_cnt
    from public.office_visit_email_verifications
    where client_ip = btrim(requested_client_ip)
      and created_at > window_start;

    if ip_cnt >= 15 then
      return query select false, 'too_many_ip_requests'::text, null::uuid;
      return;
    end if;
  end if;

  -- Insert challenge row atomically
  insert into public.office_visit_email_verifications (
    email,
    code_hash,
    actor_id,
    client_ip,
    expires_at,
    verified,
    attempts
  ) values (
    norm_email,
    requested_code_hash,
    requested_actor_id,
    nullif(btrim(requested_client_ip), ''),
    requested_expires_at,
    false,
    0
  )
  returning id into inserted_id;

  return query select true, null::text, inserted_id;
end;
$$;

revoke all on function api.request_office_email_verification_slot(uuid, text, text, text, timestamptz) from public, anon, authenticated;
grant execute on function api.request_office_email_verification_slot(uuid, text, text, text, timestamptz) to service_role;

-- 5. Reconcile api.create_specific_person_visit_request
create or replace function api.create_specific_person_visit_request(
  requested_actor_id uuid,
  requested_request_id uuid,
  requested_office_id uuid,
  requested_personnel_id uuid,
  requested_first_name text,
  requested_middle_name text,
  requested_last_name text,
  requested_contact_number text,
  requested_email text,
  requested_purpose text,
  requested_visit_date date,
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
  requested_returning_attempt_id uuid default null
)
returns table (
  visit_id uuid,
  request_id uuid,
  approval_status public.office_approval_status,
  attendance_status public.office_attendance_status
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
      or existing_visit.personnel_id <> requested_personnel_id
      or existing_visit.visitor_email <> requested_email
      or existing_visit.visit_date <> requested_visit_date then
      raise exception using errcode = '40900', message = 'idempotency_conflict';
    end if;

    return query select
      existing_visit.id,
      existing_visit.request_id,
      existing_visit.approval_status,
      existing_visit.attendance_status;
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

  -- 3. Validate Office
  select * into target_office from public.offices
  where id = requested_office_id and active;
  if not found then
    raise exception using errcode = '22023', message = 'office_not_found_or_inactive';
  end if;

  -- 3. Validate Personnel
  select * into target_personnel from public.office_personnel
  where id = requested_personnel_id and office_id = requested_office_id and active;
  if not found then
    raise exception using errcode = '22023', message = 'personnel_not_found_or_inactive';
  end if;

  -- 4. Basic Constraints
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

  -- 5. Validate Arrival Mode and Vehicle Details
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

  -- 6. Identity Verification & Registration Mode Validation
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

  -- 7. Validate and hold vehicle photo upload intent (if vehicle declared)
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

  -- 8. Create office_visit Record
  insert into public.office_visits (
    visit_type,
    office_id,
    personnel_id,
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
    email_delivery_status
  ) values (
    'specific_person',
    requested_office_id,
    requested_personnel_id,
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
    'pending'
  )
  returning id into new_visit_id;

  -- 9. Insert Audit Event
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
      'visit_date', requested_visit_date,
      'registration_mode', requested_registration_mode,
      'arrival_mode', requested_arrival_mode
    )
  );

  return query select
    new_visit_id,
    requested_request_id,
    'pending'::public.office_approval_status,
    'awaiting_entry'::public.office_attendance_status;
end;
$$;

revoke all on function api.create_specific_person_visit_request(uuid, uuid, uuid, uuid, text, text, text, text, text, text, date, text, jsonb, jsonb, uuid, integer, text, uuid, integer, text, uuid, integer, text, text, uuid, text, uuid, uuid) from public, anon, authenticated;
grant execute on function api.create_specific_person_visit_request(uuid, uuid, uuid, uuid, text, text, text, text, text, text, date, text, jsonb, jsonb, uuid, integer, text, uuid, integer, text, uuid, integer, text, text, uuid, text, uuid, uuid) to service_role;

-- 6. Reconcile api.decide_office_visit to fix pass vehicle declaration column mapping
create or replace function api.decide_office_visit(
  requested_actor_id uuid,
  requested_visit_id uuid,
  requested_decision text,
  requested_rejection_reason text default null,
  requested_token_digest text default null,
  requested_encrypted_payload text default null,
  requested_idempotency_key text default null,
  requested_request_id uuid default gen_random_uuid()
)
returns table (
  ok boolean,
  decision text,
  pass_id uuid,
  public_reference uuid,
  valid_from timestamptz,
  valid_until timestamptz,
  message text
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  target_visit public.office_visits%rowtype;
  actor_profile public.staff_profiles%rowtype;
  settings public.app_settings%rowtype;
  new_visitor_id uuid;
  new_pass_id uuid;
  new_public_ref uuid;
  new_veh_ev_id uuid := null;
  v_from timestamptz;
  v_until timestamptz;
  v_full_name text;
  v_addr jsonb;
  v_veh jsonb;
  photo_intent public.upload_intents%rowtype;
  id_intent public.upload_intents%rowtype;
  vehicle_photo_intent public.upload_intents%rowtype;
  returning_profile_rec public.returning_visitor_profiles%rowtype;
  v_idempotency_key text;
  v_manila_today date;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'service role required';
  end if;

  if requested_decision not in ('approved', 'rejected') then
    raise exception using errcode = '22023', message = 'invalid_decision';
  end if;

  -- 1. Validate actor role and active status
  select * into actor_profile from public.staff_profiles
  where user_id = requested_actor_id and active;
  if not found then
    raise exception using errcode = '42501', message = 'active_staff_required';
  end if;

  -- 2. Lock visit record
  select * into target_visit from public.office_visits
  where id = requested_visit_id
  for update;
  if not found then
    raise exception using errcode = '22023', message = 'visit_not_found';
  end if;

  -- 3. Validate office assignment (unless admin/superadmin)
  if actor_profile.role not in ('admin', 'superadmin') then
    if not exists (
      select 1 from public.office_staff_assignments a
      where a.office_id = target_visit.office_id and a.user_id = requested_actor_id
    ) then
      raise exception using errcode = '42501', message = 'unauthorized_for_this_office';
    end if;
  end if;

  -- 4. Concurrency check: already decided?
  if target_visit.approval_status <> 'pending'::public.office_approval_status then
    if target_visit.approval_status::text = requested_decision then
      if target_visit.approval_status = 'approved'::public.office_approval_status and target_visit.pass_id is not null then
        select p.public_reference, p.valid_from, p.valid_until
        into new_public_ref, v_from, v_until
        from public.passes p where p.id = target_visit.pass_id;

        return query select true, 'approved'::text, target_visit.pass_id, new_public_ref, v_from, v_until, 'Visit already approved.'::text;
        return;
      else
        return query select true, 'rejected'::text, null::uuid, null::uuid, null::timestamptz, null::timestamptz, 'Visit already rejected.'::text;
        return;
      end if;
    else
      raise exception using errcode = '40900', message = 'visit_already_decided';
    end if;
  end if;

  -- 5. REJECTION FLOW
  if requested_decision = 'rejected' then
    if requested_rejection_reason is null or char_length(btrim(requested_rejection_reason)) = 0 then
      raise exception using errcode = '22023', message = 'rejection_reason_required';
    end if;

    update public.office_visits set
      approval_status = 'rejected'::public.office_approval_status,
      rejection_reason = btrim(requested_rejection_reason),
      decided_at = now(),
      decided_by = requested_actor_id,
      attendance_status = 'cancelled'::public.office_attendance_status,
      updated_at = now()
    where id = target_visit.id;

    -- Release upload intent holds
    update public.upload_intents
    set held_until = null
    where id in (target_visit.photo_intent_id, target_visit.id_intent_id, target_visit.vehicle_photo_intent_id);

    -- Create rejection outbox record
    if target_visit.visitor_email is not null then
      v_idempotency_key := coalesce(requested_idempotency_key, 'office-rejection-' || target_visit.id::text);
      insert into public.office_visit_email_outbox (
        office_visit_id,
        email_type,
        recipient_email,
        rejection_reason,
        delivery_status,
        idempotency_key
      ) values (
        target_visit.id,
        'rejection',
        target_visit.visitor_email,
        btrim(requested_rejection_reason),
        'pending',
        v_idempotency_key
      ) on conflict (office_visit_id, email_type) do nothing;
    end if;

    insert into public.office_visit_events (
      office_visit_id,
      event_type,
      actor_id,
      actor_role,
      metadata
    ) values (
      target_visit.id,
      'rejected',
      requested_actor_id,
      actor_profile.role::text,
      jsonb_build_object('reason', btrim(requested_rejection_reason))
    );

    return query select true, 'rejected'::text, null::uuid, null::uuid, null::timestamptz, null::timestamptz, 'Visit rejected.'::text;
    return;
  end if;

  -- 6. APPROVAL FLOW
  if requested_token_digest is null or requested_token_digest !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'valid_token_digest_required_for_approval';
  end if;

  if target_visit.visitor_actor_id is null then
    raise exception using errcode = '22023', message = 'missing_visitor_actor_identity';
  end if;

  select * into settings from public.app_settings where singleton for share;

  -- Enforce visit-date and validity window at approval time
  v_manila_today := (now() at time zone coalesce(settings.timezone, 'Asia/Manila'))::date;
  if target_visit.visit_date < v_manila_today then
    update public.office_visits set
      approval_status = 'rejected'::public.office_approval_status,
      attendance_status = 'expired'::public.office_attendance_status,
      rejection_reason = 'Visit date has passed prior to approval.',
      decided_at = now(),
      decided_by = requested_actor_id,
      updated_at = now()
    where id = target_visit.id;

    update public.upload_intents set held_until = null
    where id in (target_visit.photo_intent_id, target_visit.id_intent_id, target_visit.vehicle_photo_intent_id);

    insert into public.office_visit_events (
      office_visit_id, event_type, actor_id, actor_role, metadata
    ) values (
      target_visit.id, 'rejected', requested_actor_id, actor_profile.role::text,
      jsonb_build_object('reason', 'Visit date has passed prior to approval.', 'code', 'visit_date_expired')
    );

    return query select false, 'rejected'::text, null::uuid, null::uuid, null::timestamptz, null::timestamptz, 'visit_date_expired'::text;
    return;
  end if;

  v_from := (target_visit.visit_date + settings.working_hours_start) at time zone settings.timezone;
  v_until := (target_visit.visit_date + settings.working_hours_end) at time zone settings.timezone;

  if v_until <= now() then
    update public.office_visits set
      approval_status = 'rejected'::public.office_approval_status,
      attendance_status = 'expired'::public.office_attendance_status,
      rejection_reason = 'Pass validity window has ended for this date.',
      decided_at = now(),
      decided_by = requested_actor_id,
      updated_at = now()
    where id = target_visit.id;

    update public.upload_intents set held_until = null
    where id in (target_visit.photo_intent_id, target_visit.id_intent_id, target_visit.vehicle_photo_intent_id);

    insert into public.office_visit_events (
      office_visit_id, event_type, actor_id, actor_role, metadata
    ) values (
      target_visit.id, 'rejected', requested_actor_id, actor_profile.role::text,
      jsonb_build_object('reason', 'Pass validity window has ended for this date.', 'code', 'pass_validity_window_ended')
    );

    return query select false, 'rejected'::text, null::uuid, null::uuid, null::timestamptz, null::timestamptz, 'pass_validity_window_ended'::text;
    return;
  end if;

  -- Revalidate upload holds and evidence (Fail-Closed)
  if target_visit.registration_mode = 'new' then
    if target_visit.photo_intent_id is null or target_visit.id_intent_id is null then
      update public.office_visits set
        approval_status = 'rejected'::public.office_approval_status,
        attendance_status = 'expired'::public.office_attendance_status,
        rejection_reason = 'Required photo or ID upload intent is missing.',
        decided_at = now(),
        decided_by = requested_actor_id,
        updated_at = now()
      where id = target_visit.id;

      update public.upload_intents set held_until = null
      where id in (target_visit.photo_intent_id, target_visit.id_intent_id, target_visit.vehicle_photo_intent_id);

      insert into public.office_visit_events (
        office_visit_id, event_type, actor_id, actor_role, metadata
      ) values (
        target_visit.id, 'rejected', requested_actor_id, actor_profile.role::text,
        jsonb_build_object('reason', 'Required photo or ID upload intent is missing.', 'code', 'missing_required_evidence_intents')
      );

      return query select false, 'rejected'::text, null::uuid, null::uuid, null::timestamptz, null::timestamptz, 'missing_required_evidence_intents'::text;
      return;
    end if;

    select * into photo_intent from public.upload_intents where id = target_visit.photo_intent_id for update;
    if not found
      or photo_intent.owner_id <> target_visit.visitor_actor_id
      or photo_intent.source <> 'portal'::public.pass_source
      or photo_intent.kind <> 'photo'::public.evidence_kind
      or photo_intent.status <> 'uploaded'::public.upload_intent_status
      or photo_intent.expires_at <= now()
      or photo_intent.storage_cleaned_at is not null
      or photo_intent.held_until is null
      or photo_intent.held_until < now()
      or not exists (
        select 1 from storage.objects so
        where so.bucket_id = photo_intent.bucket_id
          and so.name = photo_intent.object_path
      )
      or target_visit.photo_bytes is null
      or target_visit.photo_bytes <= 0
      or target_visit.photo_sha256 is null
      or target_visit.photo_sha256 !~ '^[0-9a-f]{64}$'
      or target_visit.photo_sha256 = repeat('0', 64)
    then
      update public.office_visits set
        approval_status = 'rejected'::public.office_approval_status,
        attendance_status = 'expired'::public.office_attendance_status,
        rejection_reason = 'Visitor portrait evidence is invalid, expired, or removed.',
        decided_at = now(),
        decided_by = requested_actor_id,
        updated_at = now()
      where id = target_visit.id;

      update public.upload_intents set held_until = null
      where id in (target_visit.photo_intent_id, target_visit.id_intent_id, target_visit.vehicle_photo_intent_id);

      insert into public.office_visit_events (
        office_visit_id, event_type, actor_id, actor_role, metadata
      ) values (
        target_visit.id, 'rejected', requested_actor_id, actor_profile.role::text,
        jsonb_build_object('reason', 'Visitor portrait evidence is invalid, expired, or removed.', 'code', 'invalid_or_expired_photo_evidence')
      );

      return query select false, 'rejected'::text, null::uuid, null::uuid, null::timestamptz, null::timestamptz, 'invalid_or_expired_photo_evidence'::text;
      return;
    end if;

    select * into id_intent from public.upload_intents where id = target_visit.id_intent_id for update;
    if not found
      or id_intent.owner_id <> target_visit.visitor_actor_id
      or id_intent.source <> 'portal'::public.pass_source
      or id_intent.kind <> 'id'::public.evidence_kind
      or id_intent.status <> 'uploaded'::public.upload_intent_status
      or id_intent.expires_at <= now()
      or id_intent.storage_cleaned_at is not null
      or id_intent.held_until is null
      or id_intent.held_until < now()
      or not exists (
        select 1 from storage.objects so
        where so.bucket_id = id_intent.bucket_id
          and so.name = id_intent.object_path
      )
      or target_visit.id_bytes is null
      or target_visit.id_bytes <= 0
      or target_visit.id_sha256 is null
      or target_visit.id_sha256 !~ '^[0-9a-f]{64}$'
      or target_visit.id_sha256 = repeat('0', 64)
    then
      update public.office_visits set
        approval_status = 'rejected'::public.office_approval_status,
        attendance_status = 'expired'::public.office_attendance_status,
        rejection_reason = 'Visitor identification evidence is invalid, expired, or removed.',
        decided_at = now(),
        decided_by = requested_actor_id,
        updated_at = now()
      where id = target_visit.id;

      update public.upload_intents set held_until = null
      where id in (target_visit.photo_intent_id, target_visit.id_intent_id, target_visit.vehicle_photo_intent_id);

      insert into public.office_visit_events (
        office_visit_id, event_type, actor_id, actor_role, metadata
      ) values (
        target_visit.id, 'rejected', requested_actor_id, actor_profile.role::text,
        jsonb_build_object('reason', 'Visitor identification evidence is invalid, expired, or removed.', 'code', 'invalid_or_expired_id_evidence')
      );

      return query select false, 'rejected'::text, null::uuid, null::uuid, null::timestamptz, null::timestamptz, 'invalid_or_expired_id_evidence'::text;
      return;
    end if;

  elsif target_visit.registration_mode = 'returning' then
    if target_visit.returning_profile_id is null then
      update public.office_visits set
        approval_status = 'rejected'::public.office_approval_status,
        attendance_status = 'expired'::public.office_attendance_status,
        rejection_reason = 'Returning visitor profile linkage is missing.',
        decided_at = now(),
        decided_by = requested_actor_id,
        updated_at = now()
      where id = target_visit.id;

      return query select false, 'rejected'::text, null::uuid, null::uuid, null::timestamptz, null::timestamptz, 'missing_returning_profile_id'::text;
      return;
    end if;

    select * into returning_profile_rec
    from public.returning_visitor_profiles
    where id = target_visit.returning_profile_id and revoked_at is null and expires_at > now();

    if not found then
      update public.office_visits set
        approval_status = 'rejected'::public.office_approval_status,
        attendance_status = 'expired'::public.office_attendance_status,
        rejection_reason = 'Returning visitor profile is revoked or expired.',
        decided_at = now(),
        decided_by = requested_actor_id,
        updated_at = now()
      where id = target_visit.id;

      return query select false, 'rejected'::text, null::uuid, null::uuid, null::timestamptz, null::timestamptz, 'invalid_returning_profile'::text;
      return;
    end if;
  end if;

  -- Optional vehicle photo evidence validation (if provided)
  if target_visit.arrival_mode = 'vehicle' and target_visit.vehicle_photo_intent_id is not null then
    select * into vehicle_photo_intent from public.upload_intents
    where id = target_visit.vehicle_photo_intent_id for update;

    if not found
      or vehicle_photo_intent.owner_id <> target_visit.visitor_actor_id
      or vehicle_photo_intent.source <> 'portal'::public.pass_source
      or vehicle_photo_intent.kind <> 'vehicle_photo'::public.evidence_kind
      or vehicle_photo_intent.status <> 'uploaded'::public.upload_intent_status
      or vehicle_photo_intent.expires_at <= now()
      or vehicle_photo_intent.storage_cleaned_at is not null
      or vehicle_photo_intent.held_until is null
      or vehicle_photo_intent.held_until < now()
      or not exists (
        select 1 from storage.objects so
        where so.bucket_id = vehicle_photo_intent.bucket_id
          and so.name = vehicle_photo_intent.object_path
      )
      or coalesce(target_visit.vehicle_photo_bytes, vehicle_photo_intent.byte_size, 0) <= 0
      or coalesce(target_visit.vehicle_photo_sha256, vehicle_photo_intent.sha256_hex) is null
      or coalesce(target_visit.vehicle_photo_sha256, vehicle_photo_intent.sha256_hex) !~ '^[0-9a-f]{64}$'
      or coalesce(target_visit.vehicle_photo_sha256, vehicle_photo_intent.sha256_hex) = repeat('0', 64)
    then
      update public.office_visits set
        approval_status = 'rejected'::public.office_approval_status,
        attendance_status = 'expired'::public.office_attendance_status,
        rejection_reason = 'Vehicle photo evidence is invalid, expired, or missing.',
        decided_at = now(),
        decided_by = requested_actor_id,
        updated_at = now()
      where id = target_visit.id;

      update public.upload_intents set held_until = null
      where id in (target_visit.photo_intent_id, target_visit.id_intent_id, target_visit.vehicle_photo_intent_id);

      insert into public.office_visit_events (
        office_visit_id, event_type, actor_id, actor_role, metadata
      ) values (
        target_visit.id, 'rejected', requested_actor_id, actor_profile.role::text,
        jsonb_build_object('reason', 'Vehicle photo evidence is invalid, expired, or missing.', 'code', 'invalid_vehicle_photo_evidence')
      );

      return query select false, 'rejected'::text, null::uuid, null::uuid, null::timestamptz, null::timestamptz, 'invalid_vehicle_photo_evidence'::text;
      return;
    end if;
  end if;

  v_full_name := coalesce(target_visit.visitor_display_name, btrim(target_visit.visitor_first_name ||
    case when target_visit.visitor_middle_name is not null and char_length(btrim(target_visit.visitor_middle_name)) > 0
      then ' ' || btrim(target_visit.visitor_middle_name) else '' end ||
    ' ' || target_visit.visitor_last_name));

  v_addr := target_visit.address_details;
  v_veh := target_visit.vehicle_details;

  -- Insert canonical visitor owned strictly by the original anonymous visitor UUID
  insert into public.visitors (
    owner_id,
    source,
    full_name,
    contact_number,
    email,
    purpose,
    visit_date,
    consent_accepted_at,
    registration_mode,
    returning_profile_id,
    arrival_mode,
    psgc_version,
    psgc_region_code,
    psgc_province_code,
    psgc_city_code,
    psgc_barangay_code,
    home_building,
    home_street,
    home_address
  ) values (
    target_visit.visitor_actor_id,
    'portal'::public.pass_source,
    v_full_name,
    target_visit.visitor_contact_number,
    target_visit.visitor_email,
    target_visit.purpose,
    target_visit.visit_date,
    now(),
    target_visit.registration_mode,
    target_visit.returning_profile_id,
    target_visit.arrival_mode,
    coalesce(v_addr->>'version', '2026-q3'),
    v_addr->>'regionCode',
    v_addr->>'provinceCode',
    v_addr->>'cityCode',
    v_addr->>'barangayCode',
    v_addr->>'houseBuilding',
    v_addr->>'street',
    concat_ws(', ', v_addr->>'houseBuilding', v_addr->>'street', v_addr->>'barangayName', v_addr->>'cityName')
  )
  returning id into new_visitor_id;

  -- For new visitor: insert genuine visitor evidence and claim upload intents
  if target_visit.registration_mode = 'new' then
    insert into public.visitor_evidence (
      visitor_id, upload_intent_id, kind, bucket_id, object_path, content_type,
      byte_size, sha256_hex, verified_at, expires_at
    ) values (
      new_visitor_id, photo_intent.id, photo_intent.kind, photo_intent.bucket_id,
      photo_intent.object_path, photo_intent.content_type,
      target_visit.photo_bytes,
      target_visit.photo_sha256,
      now(),
      greatest(now() + make_interval(days => settings.image_retention_days), v_until + interval '1 day')
    );

    update public.upload_intents set
      status = 'claimed'::public.upload_intent_status,
      claimed_at = now(),
      visitor_id = new_visitor_id,
      held_until = null
    where id = photo_intent.id;

    insert into public.visitor_evidence (
      visitor_id, upload_intent_id, kind, bucket_id, object_path, content_type,
      byte_size, sha256_hex, verified_at, expires_at
    ) values (
      new_visitor_id, id_intent.id, id_intent.kind, id_intent.bucket_id,
      id_intent.object_path, id_intent.content_type,
      target_visit.id_bytes,
      target_visit.id_sha256,
      now(),
      greatest(now() + make_interval(days => settings.image_retention_days), v_until + interval '1 day')
    );

    update public.upload_intents set
      status = 'claimed'::public.upload_intent_status,
      claimed_at = now(),
      visitor_id = new_visitor_id,
      held_until = null
    where id = id_intent.id;
  end if;

  -- Create canonical visitor evidence and claim vehicle photo upload intent if applicable
  if target_visit.arrival_mode = 'vehicle' and target_visit.vehicle_photo_intent_id is not null then
    insert into public.visitor_evidence (
      visitor_id, upload_intent_id, kind, bucket_id, object_path, content_type,
      byte_size, sha256_hex, verified_at, expires_at
    ) values (
      new_visitor_id, vehicle_photo_intent.id, vehicle_photo_intent.kind, vehicle_photo_intent.bucket_id,
      vehicle_photo_intent.object_path, vehicle_photo_intent.content_type,
      coalesce(target_visit.vehicle_photo_bytes, vehicle_photo_intent.byte_size),
      coalesce(target_visit.vehicle_photo_sha256, vehicle_photo_intent.sha256_hex),
      now(),
      greatest(now() + make_interval(days => settings.image_retention_days), v_until + interval '1 day')
    ) returning id into new_veh_ev_id;

    update public.upload_intents set
      status = 'claimed'::public.upload_intent_status,
      claimed_at = now(),
      visitor_id = new_visitor_id,
      held_until = null
    where id = vehicle_photo_intent.id;
  end if;

  new_public_ref := gen_random_uuid();

  -- Create Pass Record
  insert into public.passes (
    visitor_id,
    source,
    status,
    token_digest,
    public_reference,
    valid_from,
    valid_until,
    issue_request_id
  ) values (
    new_visitor_id,
    'portal'::public.pass_source,
    'issued'::public.pass_status,
    decode(requested_token_digest, 'hex'),
    new_public_ref,
    v_from,
    v_until,
    target_visit.request_id
  )
  returning id into new_pass_id;

  -- Link vehicle declaration if applicable
  if target_visit.arrival_mode = 'vehicle' and v_veh is not null then
    insert into public.visit_vehicle_declarations (
      pass_id,
      visitor_id,
      vehicle_type,
      plate_number,
      plate_key,
      color,
      make_model,
      vehicle_photo_evidence_id
    ) values (
      new_pass_id,
      new_visitor_id,
      v_veh->>'vehicleType',
      v_veh->>'plateNumber',
      upper(regexp_replace(v_veh->>'plateNumber', '[^a-zA-Z0-9]', '', 'g')),
      v_veh->>'color',
      coalesce(v_veh->>'makeModel', ''),
      new_veh_ev_id
    );
  end if;

  -- Update visit record to APPROVED
  update public.office_visits set
    approval_status = 'approved'::public.office_approval_status,
    attendance_status = 'awaiting_entry'::public.office_attendance_status,
    visitor_id = new_visitor_id,
    pass_id = new_pass_id,
    decided_at = now(),
    decided_by = requested_actor_id,
    updated_at = now()
  where id = target_visit.id;

  -- Enqueue approval email outbox record
  if target_visit.visitor_email is not null then
    v_idempotency_key := coalesce(requested_idempotency_key, 'office-approval-' || target_visit.id::text);
    insert into public.office_visit_email_outbox (
      office_visit_id,
      email_type,
      recipient_email,
      encrypted_token_payload,
      delivery_status,
      idempotency_key
    ) values (
      target_visit.id,
      'approval',
      target_visit.visitor_email,
      requested_encrypted_payload,
      'pending',
      v_idempotency_key
    ) on conflict (office_visit_id, email_type) do nothing;
  end if;

  -- Audit event
  insert into public.office_visit_events (
    office_visit_id,
    event_type,
    actor_id,
    actor_role,
    metadata
  ) values (
    target_visit.id,
    'approved',
    requested_actor_id,
    actor_profile.role::text,
    jsonb_build_object(
      'pass_id', new_pass_id,
      'public_reference', new_public_ref,
      'valid_from', v_from,
      'valid_until', v_until,
      'registration_mode', target_visit.registration_mode,
      'returning_profile_id', target_visit.returning_profile_id
    )
  );

  return query select true, 'approved'::text, new_pass_id, new_public_ref, v_from, v_until, 'Visit approved successfully.'::text;
end;
$$;

revoke all on function api.decide_office_visit from public, anon, authenticated;
grant execute on function api.decide_office_visit to service_role;

-- 7. Reconcile api.reconcile_office_visit_email (with audit attribution and note requirement)
create or replace function api.reconcile_office_visit_email(
  requested_actor_id uuid,
  requested_visit_id uuid,
  requested_action text,
  requested_note text default null
)
returns table (
  ok boolean,
  action text,
  new_status text,
  message text
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  target_visit public.office_visits%rowtype;
  target_outbox public.office_visit_email_outbox%rowtype;
  actor_profile public.staff_profiles%rowtype;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'service role required';
  end if;

  if requested_action not in ('mark_delivered', 'permit_retry') then
    raise exception using errcode = '22023', message = 'invalid_reconciliation_action';
  end if;

  -- 1. Validate staff actor
  select * into actor_profile from public.staff_profiles
  where user_id = requested_actor_id and active;
  if not found then
    raise exception using errcode = '42501', message = 'active_staff_required';
  end if;

  -- 2. Lock visit record
  select * into target_visit from public.office_visits
  where id = requested_visit_id for update;
  if not found then
    raise exception using errcode = '22023', message = 'visit_not_found';
  end if;

  -- 3. Validate office assignment (unless admin/superadmin)
  if actor_profile.role not in ('admin', 'superadmin') then
    if not exists (
      select 1 from public.office_staff_assignments a
      where a.office_id = target_visit.office_id and a.user_id = requested_actor_id
    ) then
      raise exception using errcode = '42501', message = 'unauthorized_for_this_office';
    end if;
  end if;

  -- 4. Lock outbox record
  select * into target_outbox from public.office_visit_email_outbox
  where office_visit_id = requested_visit_id
  for update;
  if not found then
    raise exception using errcode = '22023', message = 'outbox_record_not_found';
  end if;

  if target_outbox.delivery_status = 'delivered' then
    raise exception using errcode = '40900', message = 'email_already_delivered';
  end if;

  if requested_action = 'mark_delivered' then
    if requested_note is null or char_length(btrim(requested_note)) < 3 then
      raise exception using errcode = '22023', message = 'reconciliation_note_required_for_manual_delivery';
    end if;

    update public.office_visit_email_outbox set
      delivery_status = 'delivered',
      delivered_at = now(),
      claim_id = null,
      lease_expires_at = null,
      last_error = btrim(requested_note),
      reconciled_by = requested_actor_id,
      reconciliation_source = 'manual_staff',
      reconciliation_note = btrim(requested_note),
      updated_at = now()
    where id = target_outbox.id;

    update public.office_visits set
      email_delivery_status = 'delivered',
      email_dispatched_at = coalesce(email_dispatched_at, now()),
      updated_at = now()
    where id = target_visit.id;

    insert into public.office_visit_events (
      office_visit_id, event_type, actor_id, actor_role, metadata
    ) values (
      target_visit.id, 'email_reconciled', requested_actor_id, actor_profile.role::text,
      jsonb_build_object(
        'action', 'mark_delivered',
        'note', btrim(requested_note),
        'reconciled_by', requested_actor_id,
        'source', 'manual_staff'
      )
    );

    return query select true, 'mark_delivered'::text, 'delivered'::text, 'Email marked as delivered.'::text;
    return;
  elsif requested_action = 'permit_retry' then
    update public.office_visit_email_outbox set
      delivery_status = 'failed',
      claim_id = null,
      lease_expires_at = null,
      last_error = coalesce(nullif(btrim(requested_note), ''), 'reconciled_undelivered_by_staff'),
      reconciled_by = requested_actor_id,
      reconciliation_source = 'manual_staff',
      reconciliation_note = nullif(btrim(requested_note), ''),
      updated_at = now()
    where id = target_outbox.id;

    update public.office_visits set
      email_delivery_status = 'failed',
      email_error = coalesce(nullif(btrim(requested_note), ''), 'reconciled_undelivered_by_staff'),
      updated_at = now()
    where id = target_visit.id;

    insert into public.office_visit_events (
      office_visit_id, event_type, actor_id, actor_role, metadata
    ) values (
      target_visit.id, 'email_reconciled', requested_actor_id, actor_profile.role::text,
      jsonb_build_object(
        'action', 'permit_retry',
        'note', nullif(btrim(requested_note), ''),
        'reconciled_by', requested_actor_id,
        'source', 'manual_staff'
      )
    );

    return query select true, 'permit_retry'::text, 'failed'::text, 'Email status set to failed; retry is now permitted.'::text;
    return;
  end if;
end;
$$;

revoke all on function api.reconcile_office_visit_email(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function api.reconcile_office_visit_email(uuid, uuid, text, text) to service_role;

-- 8. Reconcile api.record_resend_delivery_event attribution
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
  v_office_outbox public.office_visit_email_outbox%rowtype;
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

  -- 2. Correlate with office visit email outbox: match by provider message ID OR stable outbox correlation ID
  select * into v_office_outbox
  from public.office_visit_email_outbox
  where (
    (trim(requested_email_id) <> '' and provider_message_id = trim(requested_email_id))
    or (requested_outbox_id is not null and id = requested_outbox_id)
  )
  for update;

  if found then
    -- Record provider message ID if missing on outbox (e.g. transport timeout on initial send)
    if v_office_outbox.provider_message_id is null and trim(requested_email_id) <> '' then
      update public.office_visit_email_outbox
      set provider_message_id = trim(requested_email_id)
      where id = v_office_outbox.id;
    end if;

    -- Do not regress terminal delivered status
    if v_office_outbox.delivery_status <> 'delivered' then
      if trim(requested_event_type) = 'email.delivered' then
        update public.office_visit_email_outbox set
          delivery_status = 'delivered',
          delivered_at = v_occurred,
          claim_id = null,
          lease_expires_at = null,
          reconciliation_source = 'resend_webhook',
          reconciled_by = null,
          updated_at = now()
        where id = v_office_outbox.id;

        update public.office_visits set
          email_delivery_status = 'delivered',
          updated_at = now()
        where id = v_office_outbox.office_visit_id;
      elsif trim(requested_event_type) in ('email.bounced', 'email.complained', 'email.failed') then
        update public.office_visit_email_outbox set
          delivery_status = 'failed',
          last_error = trim(requested_event_type),
          claim_id = null,
          lease_expires_at = null,
          reconciliation_source = 'resend_webhook',
          reconciled_by = null,
          updated_at = now()
        where id = v_office_outbox.id;

        update public.office_visits set
          email_delivery_status = 'failed',
          email_error = trim(requested_event_type),
          updated_at = now()
        where id = v_office_outbox.office_visit_id;
      elsif trim(requested_event_type) = 'email.sent' then
        if v_office_outbox.delivery_status in ('pending', 'processing', 'unknown') then
          update public.office_visit_email_outbox set
            delivery_status = 'sent',
            claim_id = null,
            lease_expires_at = null,
            reconciliation_source = 'resend_webhook',
            reconciled_by = null,
            updated_at = now()
          where id = v_office_outbox.id;

          update public.office_visits set
            email_delivery_status = 'sent',
            email_dispatched_at = coalesce(email_dispatched_at, v_occurred),
            updated_at = now()
          where id = v_office_outbox.office_visit_id;
        end if;
      end if;
    end if;
  end if;

  -- 3. Insert canonical audit event
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
      'delivery_status', case
        when trim(requested_event_type) = 'email.delivered' then 'delivered'
        when trim(requested_event_type) in ('email.bounced', 'email.complained', 'email.failed') then 'failed'
        when trim(requested_event_type) = 'email.sent' then 'sent'
        else 'other'
      end,
      'timestamp', to_char(v_occurred at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    ),
    v_occurred
  )
  returning id into v_audit_id;

  return jsonb_build_object(
    'ok', true,
    'status', 'processed',
    'duplicate', false,
    'event_id', v_inserted_id,
    'audit_id', v_audit_id,
    'provider_event_id', trim(requested_provider_event_id),
    'event_type', trim(requested_event_type),
    'email_id', trim(requested_email_id),
    'outcome', v_outcome
  );
end;
$$;

revoke all on function api.record_resend_delivery_event(text, text, text, text, text, text, timestamptz, uuid) from public, anon, authenticated;
grant execute on function api.record_resend_delivery_event(text, text, text, text, text, text, timestamptz, uuid) to service_role;

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
language sql
security definer
set search_path = ''
as $$
  select api.record_resend_delivery_event(
    requested_provider_event_id,
    requested_event_type,
    requested_email_id,
    requested_outcome,
    requested_recipient_masked,
    requested_subject_sanitized,
    requested_occurred_at,
    null::uuid
  );
$$;

revoke all on function api.record_resend_delivery_event(text, text, text, text, text, text, timestamptz) from public, anon, authenticated;
grant execute on function api.record_resend_delivery_event(text, text, text, text, text, text, timestamptz) to service_role;

-- 9. Replace RLS policy on visit_vehicle_declarations
drop policy if exists visit_vehicle_declarations_staff_select on public.visit_vehicle_declarations;
drop policy if exists visit_vehicle_declarations_select_policy on public.visit_vehicle_declarations;

create policy visit_vehicle_declarations_select_policy on public.visit_vehicle_declarations
  for select
  using (
    auth.role() = 'service_role'
    or exists (
      select 1 from public.staff_profiles sp
      where sp.user_id = auth.uid()
        and sp.active
        and sp.role in ('admin', 'superadmin', 'guard')
    )
    or exists (
      select 1 from public.office_visits ov
      join public.office_staff_assignments osa on osa.office_id = ov.office_id
      join public.staff_profiles sp on sp.user_id = osa.user_id
      where (ov.pass_id = visit_vehicle_declarations.pass_id or ov.visitor_id = visit_vehicle_declarations.visitor_id)
        and osa.user_id = auth.uid()
        and sp.active
    )
  );

-- 10. Nonredundant performance indexes
create index if not exists idx_office_visits_office_approval
  on public.office_visits(office_id, approval_status, created_at desc);

create index if not exists idx_office_visits_office_attendance
  on public.office_visits(office_id, attendance_status, created_at desc);

create index if not exists idx_visit_vehicle_decl_active_plate
  on public.visit_vehicle_declarations(plate_key)
  where exit_recorded_at is null;
