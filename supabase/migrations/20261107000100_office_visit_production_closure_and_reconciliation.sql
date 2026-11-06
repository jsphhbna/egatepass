-- Migration: 20261107000100_office_visit_production_closure_and_reconciliation.sql
-- Description: Corrective schema reconciliation for office visits, upload hold lifecycle,
-- anonymous visitor ownership preservation, canonical pass issuance & evidence creation,
-- durable encrypted email delivery outbox, and general office name deduplication.

-- 1. Bounded Hold Support on Upload Intents
alter table public.upload_intents
  add column if not exists held_until timestamptz default null;

comment on column public.upload_intents.held_until is
  'Bounded timestamp until which an upload intent linked to a pending office visit request is protected from retention cleanup.';

create index if not exists idx_upload_intents_held_until
  on public.upload_intents (held_until)
  where held_until is not null;

-- 2. Schema Hardening on public.office_visits
alter table public.office_visits
  add column if not exists visitor_actor_id uuid references auth.users(id) on delete set null;

alter table public.office_visits
  add column if not exists visitor_display_name text;

alter table public.office_visits
  add column if not exists photo_bytes integer;

alter table public.office_visits
  add column if not exists photo_sha256 text;

alter table public.office_visits
  add column if not exists id_bytes integer;

alter table public.office_visits
  add column if not exists id_sha256 text;

alter table public.office_visits
  add column if not exists vehicle_photo_bytes integer;

alter table public.office_visits
  add column if not exists vehicle_photo_sha256 text;

-- Allow visitor_first_name and visitor_last_name to be nullable when visitor_display_name is provided
alter table public.office_visits alter column visitor_first_name drop not null;
alter table public.office_visits alter column visitor_last_name drop not null;

create index if not exists idx_office_visits_visitor_actor_id
  on public.office_visits (visitor_actor_id);

-- 3. Office Visit Email Outbox (Durable delivery, safe retry & encrypted token storage)
create table if not exists public.office_visit_email_outbox (
  id uuid primary key default gen_random_uuid(),
  office_visit_id uuid not null references public.office_visits(id) on delete cascade,
  email_type text not null check (email_type in ('approval', 'rejection')),
  recipient_email text not null,
  encrypted_token_payload text,
  rejection_reason text,
  delivery_status text not null default 'pending' check (delivery_status in ('pending', 'processing', 'sent', 'failed', 'unknown')),
  provider_message_id text,
  attempt_count integer not null default 0,
  last_attempt_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (office_visit_id, email_type)
);

create index if not exists idx_office_email_outbox_visit_id on public.office_visit_email_outbox (office_visit_id);
create index if not exists idx_office_email_outbox_status on public.office_visit_email_outbox (delivery_status);

alter table public.office_visit_email_outbox enable row level security;

drop policy if exists outbox_staff_read on public.office_visit_email_outbox;
create policy outbox_staff_read on public.office_visit_email_outbox
  for select using (auth.role() = 'service_role' or exists (
    select 1 from public.office_visits v
    join public.office_staff_assignments a on a.office_id = v.office_id
    join public.staff_profiles s on s.user_id = a.user_id
    where v.id = office_visit_email_outbox.office_visit_id and a.user_id = auth.uid() and s.active
  ) or exists (
    select 1 from public.staff_profiles s
    where s.user_id = auth.uid() and s.active and s.role in ('admin', 'superadmin')
  ));

grant select on public.office_visit_email_outbox to authenticated, service_role;
grant insert, update, delete on public.office_visit_email_outbox to service_role;

-- 4. Reconcile api.create_specific_person_visit_request
drop function if exists api.create_specific_person_visit_request(
  uuid, uuid, uuid, uuid, text, text, text, text, text, text, date, text, jsonb, jsonb, uuid, uuid, uuid
);

drop function if exists api.create_specific_person_visit_request(
  uuid, uuid, uuid, uuid, text, text, text, text, text, text, date, text, jsonb, jsonb, uuid, integer, text, uuid, integer, text, uuid, integer, text
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
  requested_vehicle_photo_sha256 text default null
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
  new_visit_id uuid;
  resolved_photo_path text := null;
  resolved_id_path text := null;
  photo_intent public.upload_intents%rowtype;
  id_intent public.upload_intents%rowtype;
  vehicle_photo_intent public.upload_intents%rowtype;
  v_full_name text;
  v_hold_until timestamptz;
  v_existing_approval public.office_approval_status;
  v_existing_attendance public.office_attendance_status;
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

  -- 5. Check for duplicate submission by request_id (idempotency)
  select ov.id, ov.approval_status, ov.attendance_status
  into new_visit_id, v_existing_approval, v_existing_attendance
  from public.office_visits ov
  where ov.request_id = create_specific_person_visit_request.requested_request_id;
  if found then
    return query select new_visit_id, create_specific_person_visit_request.requested_request_id, v_existing_approval, v_existing_attendance;
    return;
  end if;

  -- Calculate bounded hold: at least 7 days from now or visit date + 2 days
  v_hold_until := greatest(now() + interval '7 days', (requested_visit_date + 2)::timestamp at time zone 'Asia/Manila');

  -- 6. Validate and hold photo upload intent
  if requested_photo_intent_id is not null then
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
  end if;

  -- 7. Validate and hold ID upload intent
  if requested_id_intent_id is not null then
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
  end if;

  -- 8. Validate and hold vehicle photo upload intent
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

  -- 9. Insert specific-person visit request with preserved visitor_actor_id
  insert into public.office_visits (
    visit_type,
    office_id,
    personnel_id,
    approval_status,
    attendance_status,
    visitor_actor_id,
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
      'visit_date', requested_visit_date
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

-- 5. Reconcile api.decide_office_visit
drop function if exists api.decide_office_visit(uuid, uuid, text, text, text, uuid);
drop function if exists api.decide_office_visit(uuid, uuid, text, text, text, text, uuid);

create or replace function api.decide_office_visit(
  requested_actor_id uuid,
  requested_visit_id uuid,
  requested_decision text,
  requested_rejection_reason text default null,
  requested_token_digest text default null,
  requested_encrypted_payload text default null,
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
    -- Safe idempotency return: do not re-decide or mint a second token
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
      insert into public.office_visit_email_outbox (
        office_visit_id,
        email_type,
        recipient_email,
        rejection_reason,
        delivery_status
      ) values (
        target_visit.id,
        'rejection',
        target_visit.visitor_email,
        btrim(requested_rejection_reason),
        'pending'
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

  -- 6. APPROVAL FLOW: Canonical pass issuance & evidence creation
  if requested_token_digest is null or requested_token_digest !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'valid_token_digest_required_for_approval';
  end if;

  -- Verify visitor actor ID is preserved and valid
  if target_visit.visitor_actor_id is null then
    raise exception using errcode = '22023', message = 'missing_visitor_actor_identity';
  end if;

  select * into settings from public.app_settings where singleton for share;

  v_from := (target_visit.visit_date + settings.working_hours_start) at time zone settings.timezone;
  v_until := (target_visit.visit_date + settings.working_hours_end) at time zone settings.timezone;

  v_full_name := coalesce(target_visit.visitor_display_name, btrim(target_visit.visitor_first_name ||
    case when target_visit.visitor_middle_name is not null and char_length(btrim(target_visit.visitor_middle_name)) > 0
      then ' ' || btrim(target_visit.visitor_middle_name) else '' end ||
    ' ' || target_visit.visitor_last_name));

  v_addr := target_visit.address_details;
  v_veh := target_visit.vehicle_details;

  -- Insert canonical visitor owned strictly by the original anonymous visitor
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
    'new',
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

  -- Create canonical visitor evidence and claim photo upload intent
  if target_visit.photo_intent_id is not null then
    select * into photo_intent from public.upload_intents where id = target_visit.photo_intent_id for update;
    if found then
      insert into public.visitor_evidence (
        visitor_id, upload_intent_id, kind, bucket_id, object_path, content_type,
        byte_size, sha256_hex, verified_at, expires_at
      ) values (
        new_visitor_id, photo_intent.id, photo_intent.kind, photo_intent.bucket_id,
        photo_intent.object_path, photo_intent.content_type,
        coalesce(target_visit.photo_bytes, 1024),
        coalesce(target_visit.photo_sha256, repeat('0', 64)),
        now(),
        greatest(now() + make_interval(days => settings.image_retention_days), v_until + interval '1 day')
      );

      update public.upload_intents set
        status = 'claimed'::public.upload_intent_status,
        claimed_at = now(),
        visitor_id = new_visitor_id,
        held_until = null
      where id = photo_intent.id;
    end if;
  end if;

  -- Create canonical visitor evidence and claim ID upload intent
  if target_visit.id_intent_id is not null then
    select * into id_intent from public.upload_intents where id = target_visit.id_intent_id for update;
    if found then
      insert into public.visitor_evidence (
        visitor_id, upload_intent_id, kind, bucket_id, object_path, content_type,
        byte_size, sha256_hex, verified_at, expires_at
      ) values (
        new_visitor_id, id_intent.id, id_intent.kind, id_intent.bucket_id,
        id_intent.object_path, id_intent.content_type,
        coalesce(target_visit.id_bytes, 1024),
        coalesce(target_visit.id_sha256, repeat('0', 64)),
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
  end if;

  -- Create canonical visitor evidence and claim vehicle photo upload intent
  if target_visit.arrival_mode = 'vehicle' and target_visit.vehicle_photo_intent_id is not null then
    select * into vehicle_photo_intent from public.upload_intents where id = target_visit.vehicle_photo_intent_id for update;
    if found then
      insert into public.visitor_evidence (
        visitor_id, upload_intent_id, kind, bucket_id, object_path, content_type,
        byte_size, sha256_hex, verified_at, expires_at
      ) values (
        new_visitor_id, vehicle_photo_intent.id, vehicle_photo_intent.kind, vehicle_photo_intent.bucket_id,
        vehicle_photo_intent.object_path, vehicle_photo_intent.content_type,
        coalesce(target_visit.vehicle_photo_bytes, 1024),
        coalesce(target_visit.vehicle_photo_sha256, repeat('0', 64)),
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

  -- Create approval outbox record with encrypted QR payload
  if target_visit.visitor_email is not null then
    insert into public.office_visit_email_outbox (
      office_visit_id,
      email_type,
      recipient_email,
      encrypted_token_payload,
      delivery_status
    ) values (
      target_visit.id,
      'approval',
      target_visit.visitor_email,
      requested_encrypted_payload,
      'pending'
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
    jsonb_build_object('pass_id', new_pass_id, 'public_reference', new_public_ref)
  );

  return query select true, 'approved'::text, new_pass_id, new_public_ref, v_from, v_until, 'Visit approved.'::text;
end;
$$;

revoke all on function api.decide_office_visit from public, anon, authenticated;
grant execute on function api.decide_office_visit to service_role;

-- 6. Reconcile api.record_general_office_visit (Prevent full name duplication)
drop function if exists api.record_general_office_visit(uuid, uuid, uuid, uuid);

create or replace function api.record_general_office_visit(
  requested_actor_id uuid,
  requested_pass_id uuid,
  requested_office_id uuid,
  requested_request_id uuid
)
returns table (
  visit_id uuid,
  attendance_status public.office_attendance_status
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  target_office public.offices%rowtype;
  target_pass public.passes%rowtype;
  target_visitor public.visitors%rowtype;
  new_visit_id uuid;
  v_first_name text;
  v_last_name text;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'service role required';
  end if;

  select * into target_office from public.offices
  where id = requested_office_id and active;
  if not found then
    raise exception using errcode = '22023', message = 'office_not_found_or_inactive';
  end if;

  select * into target_pass from public.passes
  where id = requested_pass_id;
  if not found then
    raise exception using errcode = '22023', message = 'pass_not_found';
  end if;

  select * into target_visitor from public.visitors
  where id = target_pass.visitor_id;
  if not found then
    raise exception using errcode = '22023', message = 'visitor_not_found';
  end if;

  -- Idempotency check
  select id, public.office_visits.attendance_status into new_visit_id, attendance_status
  from public.office_visits
  where request_id = requested_request_id or pass_id = requested_pass_id;
  if found then
    return query select new_visit_id, attendance_status;
    return;
  end if;

  -- Safe name splitting: never duplicate full name into both fields
  v_first_name := split_part(target_visitor.full_name, ' ', 1);
  v_last_name := nullif(btrim(substring(target_visitor.full_name from length(v_first_name) + 2)), '');
  if v_last_name is null then
    v_last_name := '-';
  end if;

  insert into public.office_visits (
    visit_type,
    office_id,
    approval_status,
    attendance_status,
    visitor_actor_id,
    visitor_id,
    pass_id,
    visitor_display_name,
    visitor_first_name,
    visitor_middle_name,
    visitor_last_name,
    visitor_contact_number,
    purpose,
    visit_date,
    arrival_mode,
    request_id
  ) values (
    'general',
    requested_office_id,
    'not_required'::public.office_approval_status,
    'awaiting_entry'::public.office_attendance_status,
    target_visitor.owner_id,
    target_visitor.id,
    target_pass.id,
    target_visitor.full_name,
    v_first_name,
    null,
    v_last_name,
    target_visitor.contact_number,
    target_visitor.purpose,
    target_visitor.visit_date,
    target_visitor.arrival_mode,
    requested_request_id
  ) returning id into new_visit_id;

  return query select new_visit_id, 'awaiting_entry'::public.office_attendance_status;
end;
$$;

revoke all on function api.record_general_office_visit from public, anon, authenticated;
grant execute on function api.record_general_office_visit to service_role;

-- 7. Helper RPC: api.claim_office_visit_email_for_delivery
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
  attempt_count integer
)
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

  select * into target_outbox
  from public.office_visit_email_outbox
  where office_visit_id = requested_visit_id and email_type = requested_email_type
  for update;

  if not found then
    return;
  end if;

  if target_outbox.delivery_status in ('sent', 'processing') then
    raise exception using errcode = '40900', message = 'email_already_in_progress_or_sent';
  end if;

  update public.office_visit_email_outbox set
    delivery_status = 'processing',
    attempt_count = target_outbox.attempt_count + 1,
    last_attempt_at = now(),
    updated_at = now()
  where id = target_outbox.id;

  return query select
    target_outbox.id,
    target_outbox.office_visit_id,
    target_outbox.email_type,
    target_outbox.recipient_email,
    target_outbox.encrypted_token_payload,
    target_outbox.rejection_reason,
    target_outbox.attempt_count + 1;
end;
$$;

revoke all on function api.claim_office_visit_email_for_delivery from public, anon, authenticated;
grant execute on function api.claim_office_visit_email_for_delivery to service_role;

-- 8. Helper RPC: api.record_office_visit_email_result
create or replace function api.record_office_visit_email_result(
  requested_outbox_id uuid,
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

  update public.office_visit_email_outbox set
    delivery_status = requested_status,
    provider_message_id = coalesce(requested_provider_message_id, provider_message_id),
    last_error = requested_error,
    updated_at = now()
  where id = requested_outbox_id
  returning * into target_outbox;

  if found then
    update public.office_visits set
      email_delivery_status = case when requested_status = 'sent' then 'sent' else 'failed' end,
      email_dispatched_at = case when requested_status = 'sent' then now() else email_dispatched_at end,
      email_error = requested_error,
      updated_at = now()
    where id = target_outbox.office_visit_id;
  end if;
end;
$$;

revoke all on function api.record_office_visit_email_result from public, anon, authenticated;
grant execute on function api.record_office_visit_email_result to service_role;
