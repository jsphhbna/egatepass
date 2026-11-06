-- ============================================================================
-- Migration: 20261107000200_office_workflow_trust_boundary_and_outbox_closure.sql
-- Description: Closes office visit identity trust boundaries, supports returning
--              visitor profile linkage, adds scheduling horizon & visit-date checks,
--              revalidates upload holds & evidence at approval, makes email outbox
--              genuinely durable with bounded processing leases & idempotency keys,
--              reconciles Resend webhooks with outbox, and establishes an atomic
--              5-attempt ceiling for email verification challenges.
-- ============================================================================

-- 1. Office Visits Schema Expansion
alter table public.office_visits
  add column if not exists registration_mode text not null default 'new',
  add column if not exists returning_profile_id uuid references public.returning_visitor_profiles(id) on delete set null,
  add column if not exists identity_verification_id uuid references public.portal_identity_verification_attempts(id) on delete set null,
  add column if not exists returning_attempt_id uuid references public.returning_identity_attempts(id) on delete set null;

alter table public.office_visits
  drop constraint if exists office_visits_registration_mode_check;

alter table public.office_visits
  add constraint office_visits_registration_mode_check
  check (registration_mode in ('new', 'returning'));

create unique index if not exists office_visits_identity_verification_id_idx
  on public.office_visits (identity_verification_id)
  where identity_verification_id is not null;

create unique index if not exists office_visits_returning_attempt_id_idx
  on public.office_visits (returning_attempt_id)
  where returning_attempt_id is not null;

create index if not exists office_visits_actor_retention_idx
  on public.office_visits (visitor_actor_id, approval_status, attendance_status);

-- 2. Office Visit Email Outbox Durability & Leases
alter table public.office_visit_email_outbox
  add column if not exists claim_id uuid,
  add column if not exists claimed_at timestamptz,
  add column if not exists lease_expires_at timestamptz,
  add column if not exists retry_count integer not null default 0,
  add column if not exists idempotency_key text,
  add column if not exists delivered_at timestamptz;

create unique index if not exists office_visit_email_outbox_idempotency_key_idx
  on public.office_visit_email_outbox (idempotency_key)
  where idempotency_key is not null;

alter table public.office_visit_email_outbox
  drop constraint if exists office_visit_email_outbox_delivery_status_check;

alter table public.office_visit_email_outbox
  add constraint office_visit_email_outbox_delivery_status_check
  check (delivery_status in ('pending', 'processing', 'sent', 'delivered', 'failed', 'unknown', 'reconciliation_required'));

alter table public.office_visits
  drop constraint if exists office_visits_email_delivery_status_check;

alter table public.office_visits
  add constraint office_visits_email_delivery_status_check
  check (email_delivery_status is null or email_delivery_status in ('none', 'pending', 'processing', 'sent', 'delivered', 'failed', 'unknown', 'reconciliation_required'));

create index if not exists office_visit_email_outbox_provider_msg_idx
  on public.office_visit_email_outbox (provider_message_id)
  where provider_message_id is not null;

-- 3. Office Visit Email Verifications: Atomic Consumption
alter table public.office_visit_email_verifications
  add column if not exists consumed_at timestamptz;

-- 4. Atomic Email Verification Challenge RPC
drop function if exists api.verify_office_email_challenge(uuid, text, text);

create or replace function api.verify_office_email_challenge(
  requested_actor_id uuid,
  requested_email text,
  requested_code_hash text
)
returns table (
  status text,
  attempts_remaining integer,
  challenge_id uuid
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  target_challenge public.office_visit_email_verifications%rowtype;
  v_new_attempts integer;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'service role required';
  end if;

  select * into target_challenge
  from public.office_visit_email_verifications
  where actor_id = requested_actor_id
    and email = lower(btrim(requested_email))
    and verified = false
    and consumed_at is null
    and expires_at > now()
  order by created_at desc
  limit 1
  for update;

  if not found then
    return query select 'expired_or_not_found'::text, 0, null::uuid;
    return;
  end if;

  if target_challenge.attempts >= 5 then
    return query select 'too_many_attempts'::text, 0, target_challenge.id;
    return;
  end if;

  v_new_attempts := target_challenge.attempts + 1;

  if target_challenge.code_hash = requested_code_hash then
    update public.office_visit_email_verifications set
      attempts = v_new_attempts,
      verified = true,
      consumed_at = now()
    where id = target_challenge.id;

    return query select 'ok'::text, (5 - v_new_attempts), target_challenge.id;
    return;
  else
    update public.office_visit_email_verifications set
      attempts = v_new_attempts
    where id = target_challenge.id;

    if v_new_attempts >= 5 then
      return query select 'too_many_attempts'::text, 0, target_challenge.id;
    else
      return query select 'invalid_code'::text, (5 - v_new_attempts), target_challenge.id;
    end if;
    return;
  end if;
end;
$$;

revoke all on function api.verify_office_email_challenge from public, anon, authenticated;
grant execute on function api.verify_office_email_challenge to service_role;

-- 5. Reconcile api.create_specific_person_visit_request
drop function if exists api.create_specific_person_visit_request(
  uuid, uuid, uuid, uuid, text, text, text, text, text, text, date, text, jsonb, jsonb, uuid, integer, text, uuid, integer, text, uuid, integer, text
);
drop function if exists api.create_specific_person_visit_request(
  uuid, uuid, uuid, uuid, text, text, text, text, text, text, date, text, jsonb, jsonb, uuid, integer, text, uuid, integer, text, uuid, integer, text, text, uuid, text, uuid, uuid
);

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
  resolved_photo_path text := null;
  resolved_id_path text := null;
  photo_intent public.upload_intents%rowtype;
  id_intent public.upload_intents%rowtype;
  vehicle_photo_intent public.upload_intents%rowtype;
  verification_record public.portal_identity_verification_attempts%rowtype;
  returning_profile_record public.returning_visitor_profiles%rowtype;
  returning_attempt_record public.returning_identity_attempts%rowtype;
  v_bound_identity_id uuid := null;
  v_bound_returning_id uuid := null;
  v_bound_profile_id uuid := null;
  v_full_name text;
  v_hold_until timestamptz;
  v_existing_approval public.office_approval_status;
  v_existing_attendance public.office_attendance_status;
  v_existing_actor uuid;
  v_manila_today date;
  v_max_date date;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'service role required';
  end if;

  -- 1. Actor verification: must be legitimate anonymous portal visitor
  if not exists (
    select 1 from auth.users u
    where u.id = requested_actor_id and coalesce(u.is_anonymous, false) = true
  ) or exists (select 1 from public.staff_profiles where user_id = requested_actor_id)
    or exists (select 1 from public.devices where user_id = requested_actor_id) then
    raise exception using errcode = '42501', message = 'anonymous visitor identity required';
  end if;

  -- 2. Validate office existence and active status
  select * into target_office from public.offices
  where id = requested_office_id and active;
  if not found then
    raise exception using errcode = '22023', message = 'office_not_found_or_inactive';
  end if;

  -- 3. Validate personnel existence, office binding, and active status
  select * into target_personnel from public.office_personnel
  where id = requested_personnel_id and office_id = requested_office_id and active;
  if not found then
    raise exception using errcode = '22023', message = 'personnel_not_found_or_inactive';
  end if;

  -- 4. Validate verified email
  if requested_email is null or char_length(btrim(requested_email)) < 5 then
    raise exception using errcode = '22023', message = 'verified_email_required';
  end if;

  -- 5. Check for duplicate submission by request_id (idempotency & actor binding)
  select ov.id, ov.approval_status, ov.attendance_status, ov.visitor_actor_id
  into new_visit_id, v_existing_approval, v_existing_attendance, v_existing_actor
  from public.office_visits ov
  where ov.request_id = create_specific_person_visit_request.requested_request_id;
  if found then
    if v_existing_actor <> requested_actor_id then
      raise exception using errcode = '42501', message = 'request_id_actor_mismatch';
    end if;
    return query select new_visit_id, create_specific_person_visit_request.requested_request_id, v_existing_approval, v_existing_attendance;
    return;
  end if;

  -- 6. Enforce visit-date policy & scheduling horizon at server/database boundary
  select * into settings from public.app_settings where singleton for share;
  v_manila_today := (now() at time zone 'Asia/Manila')::date;
  v_max_date := v_manila_today + coalesce(settings.scheduling_days_ahead, 14);

  if requested_visit_date < v_manila_today then
    raise exception using errcode = '22023', message = 'visit_date_in_past';
  end if;

  if requested_visit_date > v_max_date then
    raise exception using errcode = '22023', message = 'visit_date_beyond_horizon';
  end if;

  -- Calculate bounded hold: at least 7 days from now or visit date + 2 days
  v_hold_until := greatest(now() + interval '7 days', (requested_visit_date + 2)::timestamp at time zone 'Asia/Manila');

  -- 7. Identity proof and registration mode validation
  if requested_registration_mode = 'new' then
    if requested_photo_intent_id is null then
      raise exception using errcode = '22023', message = 'photo_upload_intent_required_for_new_visitor';
    end if;
    if requested_id_intent_id is null then
      raise exception using errcode = '22023', message = 'id_upload_intent_required_for_new_visitor';
    end if;

    -- Validate authoritative matched identity attempt
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

    v_bound_identity_id := verification_record.id;

    if exists (
      select 1 from public.office_visits ov_check
      where ov_check.identity_verification_id = v_bound_identity_id
        and ov_check.request_id <> requested_request_id
    ) then
      raise exception using errcode = '40900', message = 'identity_verification_already_consumed';
    end if;

    -- Validate and hold photo upload intent
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
    resolved_photo_path := photo_intent.object_path;
    update public.upload_intents set held_until = v_hold_until where id = photo_intent.id;

    -- Validate and hold ID upload intent
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
    resolved_id_path := id_intent.object_path;
    update public.upload_intents set held_until = v_hold_until where id = id_intent.id;

  elsif requested_registration_mode = 'returning' then
    if requested_returning_profile_id is null or requested_returning_match_token_digest is null then
      raise exception using errcode = '22023', message = 'returning_match_credentials_required';
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
      and ria.outcome = 'matched'
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
    update public.upload_intents set held_until = v_hold_until where id = vehicle_photo_intent.id;
  end if;

  v_full_name := btrim(requested_first_name ||
    case when requested_middle_name is not null and char_length(btrim(requested_middle_name)) > 0
      then ' ' || btrim(requested_middle_name) else '' end ||
    ' ' || requested_last_name);

  -- 9. Insert specific-person visit request
  insert into public.office_visits (
    visit_type,
    office_id,
    personnel_id,
    approval_status,
    attendance_status,
    visitor_actor_id,
    registration_mode,
    returning_profile_id,
    identity_verification_id,
    returning_attempt_id,
    visitor_display_name,
    visitor_first_name,
    visitor_middle_name,
    visitor_last_name,
    visitor_contact_number,
    visitor_email,
    visitor_email_verified,
    visitor_photo_path,
    visitor_id_path,
    photo_bytes,
    photo_sha256,
    id_bytes,
    id_sha256,
    vehicle_photo_bytes,
    vehicle_photo_sha256,
    purpose,
    visit_date,
    arrival_mode,
    vehicle_details,
    address_details,
    photo_intent_id,
    id_intent_id,
    vehicle_photo_intent_id,
    request_id
  ) values (
    'specific_person',
    requested_office_id,
    requested_personnel_id,
    'pending'::public.office_approval_status,
    'awaiting_entry'::public.office_attendance_status,
    requested_actor_id,
    requested_registration_mode,
    v_bound_profile_id,
    v_bound_identity_id,
    v_bound_returning_id,
    v_full_name,
    btrim(requested_first_name),
    nullif(btrim(requested_middle_name), ''),
    btrim(requested_last_name),
    btrim(requested_contact_number),
    lower(btrim(requested_email)),
    true,
    resolved_photo_path,
    resolved_id_path,
    requested_photo_bytes,
    requested_photo_sha256,
    requested_id_bytes,
    requested_id_sha256,
    requested_vehicle_photo_bytes,
    requested_vehicle_photo_sha256,
    btrim(requested_purpose),
    requested_visit_date,
    requested_arrival_mode,
    requested_vehicle_details,
    requested_address_details,
    requested_photo_intent_id,
    requested_id_intent_id,
    requested_vehicle_photo_intent_id,
    requested_request_id
  ) returning id into new_visit_id;

  -- 10. Audit event
  insert into public.office_visit_events (
    office_visit_id,
    event_type,
    actor_id,
    actor_role,
    metadata
  ) values (
    new_visit_id,
    'submitted',
    requested_actor_id,
    'visitor',
    jsonb_build_object(
      'office_id', requested_office_id,
      'personnel_id', requested_personnel_id,
      'visit_date', requested_visit_date,
      'registration_mode', requested_registration_mode,
      'identity_verification_id', v_bound_identity_id,
      'returning_profile_id', v_bound_profile_id
    )
  );

  return query select
    new_visit_id,
    create_specific_person_visit_request.requested_request_id,
    'pending'::public.office_approval_status,
    'awaiting_entry'::public.office_attendance_status;
end;
$$;

revoke all on function api.create_specific_person_visit_request from public, anon, authenticated;
grant execute on function api.create_specific_person_visit_request to service_role;

-- 6. Reconcile api.decide_office_visit
drop function if exists api.decide_office_visit(uuid, uuid, text, text, text, text, uuid);
drop function if exists api.decide_office_visit(uuid, uuid, text, text, text, text, text, uuid);

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
  v_manila_today := (now() at time zone 'Asia/Manila')::date;
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

    raise exception using errcode = '22023', message = 'visit_date_expired';
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

    raise exception using errcode = '22023', message = 'pass_validity_window_ended';
  end if;

  -- Revalidate upload holds and evidence
  if target_visit.registration_mode = 'new' then
    if target_visit.photo_intent_id is null or target_visit.id_intent_id is null then
      raise exception using errcode = '22023', message = 'missing_required_evidence_intents';
    end if;

    select * into photo_intent from public.upload_intents where id = target_visit.photo_intent_id for update;
    if not found
      or photo_intent.owner_id <> target_visit.visitor_actor_id
      or photo_intent.source <> 'portal'::public.pass_source
      or photo_intent.kind <> 'photo'::public.evidence_kind
      or photo_intent.status not in ('pending'::public.upload_intent_status, 'uploaded'::public.upload_intent_status)
      or photo_intent.expires_at <= now()
      or photo_intent.storage_cleaned_at is not null
      or photo_intent.held_until is null
      or photo_intent.held_until < now()
      or target_visit.photo_bytes is null
      or target_visit.photo_sha256 is null
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

      raise exception using errcode = '22023', message = 'invalid_or_expired_photo_evidence';
    end if;

    select * into id_intent from public.upload_intents where id = target_visit.id_intent_id for update;
    if not found
      or id_intent.owner_id <> target_visit.visitor_actor_id
      or id_intent.source <> 'portal'::public.pass_source
      or id_intent.kind <> 'id'::public.evidence_kind
      or id_intent.status not in ('pending'::public.upload_intent_status, 'uploaded'::public.upload_intent_status)
      or id_intent.expires_at <= now()
      or id_intent.storage_cleaned_at is not null
      or id_intent.held_until is null
      or id_intent.held_until < now()
      or target_visit.id_bytes is null
      or target_visit.id_sha256 is null
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

      raise exception using errcode = '22023', message = 'invalid_or_expired_id_evidence';
    end if;

  elsif target_visit.registration_mode = 'returning' then
    if target_visit.returning_profile_id is null then
      raise exception using errcode = '22023', message = 'missing_returning_profile_id';
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

      raise exception using errcode = '22023', message = 'invalid_returning_profile';
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
    select * into vehicle_photo_intent from public.upload_intents where id = target_visit.vehicle_photo_intent_id for update;
    if found and vehicle_photo_intent.held_until >= now() and vehicle_photo_intent.storage_cleaned_at is null then
      insert into public.visitor_evidence (
        visitor_id, upload_intent_id, kind, bucket_id, object_path, content_type,
        byte_size, sha256_hex, verified_at, expires_at
      ) values (
        new_visitor_id, vehicle_photo_intent.id, vehicle_photo_intent.kind, vehicle_photo_intent.bucket_id,
        vehicle_photo_intent.object_path, vehicle_photo_intent.content_type,
        coalesce(target_visit.vehicle_photo_bytes, vehicle_photo_intent.byte_size, 1024),
        coalesce(target_visit.vehicle_photo_sha256, vehicle_photo_intent.sha256_hex, repeat('0', 64)),
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
      coalesce(v_veh->>'vehicleType', 'Motorcycle'),
      coalesce(v_veh->>'plateNumber', 'N/A'),
      nullif(upper(regexp_replace(coalesce(v_veh->>'plateNumber', ''), '[^A-Za-z0-9]', '', 'g')), ''),
      coalesce(v_veh->>'color', 'Unknown'),
      coalesce(v_veh->>'makeModel', 'Standard'),
      new_veh_ev_id
    );
  end if;

  -- Update office visit record
  update public.office_visits set
    approval_status = 'approved'::public.office_approval_status,
    decided_at = now(),
    decided_by = requested_actor_id,
    visitor_id = new_visitor_id,
    pass_id = new_pass_id,
    attendance_status = 'awaiting_entry'::public.office_attendance_status,
    updated_at = now()
  where id = target_visit.id;

  -- Create approval outbox record with encrypted QR payload and unique idempotency key
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
      'registration_mode', target_visit.registration_mode,
      'returning_profile_id', target_visit.returning_profile_id
    )
  );

  return query select true, 'approved'::text, new_pass_id, new_public_ref, v_from, v_until, 'Visit approved.'::text;
end;
$$;

revoke all on function api.decide_office_visit from public, anon, authenticated;
grant execute on function api.decide_office_visit to service_role;

-- 7. Reconcile api.claim_office_visit_email_for_delivery
drop function if exists api.claim_office_visit_email_for_delivery(uuid, text);

create or replace function api.claim_office_visit_email_for_delivery(
  requested_visit_id uuid,
  requested_email_type text
)
returns table (
  outbox_id uuid,
  office_visit_id uuid,
  email_type text,
  recipient_email text,
  encrypted_token_payload text,
  rejection_reason text,
  attempt_count integer,
  claim_id uuid,
  idempotency_key text
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  target_outbox public.office_visit_email_outbox%rowtype;
  new_claim_id uuid;
  v_lease_expiry timestamptz;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'service role required';
  end if;

  select * into target_outbox
  from public.office_visit_email_outbox oveo
  where oveo.office_visit_id = requested_visit_id and oveo.email_type = requested_email_type
  for update;

  if not found then
    return;
  end if;

  if target_outbox.delivery_status in ('sent', 'delivered') then
    raise exception using errcode = '40900', message = 'email_already_sent_or_delivered';
  end if;

  if target_outbox.delivery_status = 'unknown' then
    raise exception using errcode = '40900', message = 'email_delivery_outcome_unknown_reconciliation_required';
  end if;

  if target_outbox.delivery_status = 'processing' then
    if target_outbox.lease_expires_at is not null and target_outbox.lease_expires_at > now() then
      raise exception using errcode = '40900', message = 'email_lease_active_in_progress';
    end if;
  end if;

  new_claim_id := gen_random_uuid();
  v_lease_expiry := now() + interval '5 minutes';

  if target_outbox.idempotency_key is null then
    target_outbox.idempotency_key := 'office-email-' || target_outbox.id::text;
  end if;

  update public.office_visit_email_outbox set
    delivery_status = 'processing',
    claim_id = new_claim_id,
    claimed_at = now(),
    lease_expires_at = v_lease_expiry,
    retry_count = target_outbox.retry_count + 1,
    idempotency_key = target_outbox.idempotency_key,
    last_attempt_at = now(),
    updated_at = now()
  where id = target_outbox.id;

  update public.office_visits set
    email_delivery_status = 'processing',
    updated_at = now()
  where id = target_outbox.office_visit_id;

  return query select
    target_outbox.id,
    target_outbox.office_visit_id,
    target_outbox.email_type,
    target_outbox.recipient_email,
    target_outbox.encrypted_token_payload,
    target_outbox.rejection_reason,
    target_outbox.retry_count + 1,
    new_claim_id,
    target_outbox.idempotency_key;
end;
$$;

revoke all on function api.claim_office_visit_email_for_delivery from public, anon, authenticated;
grant execute on function api.claim_office_visit_email_for_delivery to service_role;

-- 8. Reconcile api.record_office_visit_email_result
drop function if exists api.record_office_visit_email_result(uuid, text, text, text);
drop function if exists api.record_office_visit_email_result(uuid, uuid, text, text, text);

create or replace function api.record_office_visit_email_result(
  requested_outbox_id uuid,
  requested_claim_id uuid,
  requested_status text,
  requested_provider_message_id text default null,
  requested_error text default null
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  target_outbox public.office_visit_email_outbox%rowtype;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'service role required';
  end if;

  select * into target_outbox from public.office_visit_email_outbox
  where id = requested_outbox_id for update;

  if not found then
    return;
  end if;

  if requested_claim_id is not null and target_outbox.claim_id is not null and target_outbox.claim_id <> requested_claim_id then
    raise exception using errcode = '40900', message = 'stale_claim_cannot_overwrite';
  end if;

  if target_outbox.delivery_status = 'delivered' and requested_status <> 'delivered' then
    return;
  end if;

  update public.office_visit_email_outbox set
    delivery_status = requested_status,
    provider_message_id = coalesce(requested_provider_message_id, provider_message_id),
    last_error = requested_error,
    claim_id = null,
    lease_expires_at = null,
    delivered_at = case when requested_status = 'delivered' then now() else delivered_at end,
    updated_at = now()
  where id = requested_outbox_id;

  update public.office_visits set
    email_delivery_status = requested_status,
    email_dispatched_at = case when requested_status in ('sent', 'delivered') then coalesce(email_dispatched_at, now()) else email_dispatched_at end,
    email_error = requested_error,
    updated_at = now()
  where id = target_outbox.office_visit_id;
end;
$$;

revoke all on function api.record_office_visit_email_result from public, anon, authenticated;
grant execute on function api.record_office_visit_email_result to service_role;

-- 9. Reconcile api.record_resend_delivery_event
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
  v_office_outbox public.office_visit_email_outbox%rowtype;
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

  -- 2. Correlate with office visit email outbox if matching provider message ID exists
  if trim(requested_email_id) <> '' then
    select * into v_office_outbox
    from public.office_visit_email_outbox
    where provider_message_id = trim(requested_email_id)
    for update;

    if found then
      -- Do not regress terminal delivered status
      if v_office_outbox.delivery_status <> 'delivered' then
        if trim(requested_event_type) = 'email.delivered' then
          update public.office_visit_email_outbox set
            delivery_status = 'delivered',
            delivered_at = v_occurred,
            claim_id = null,
            lease_expires_at = null,
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
  end if;

  -- 3. Insert delivery outcome into audit_events
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
