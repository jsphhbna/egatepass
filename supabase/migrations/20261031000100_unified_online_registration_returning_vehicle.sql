-- ==============================================================================
-- Migration 43: Unified Online Registration, Returning Visitor & Vehicle Declaration
--
-- Features:
-- 1. Visitors schema extension (home_address, registration_mode, arrival_mode, returning_profile_id, returning_identity_attempt_id)
-- 2. Persistent returning visitor profiles (returning_visitor_profiles)
-- 3. AES-256-GCM encrypted biometric templates (returning_face_templates)
-- 4. Persistent saved convenience vehicles (returning_visitor_vehicles)
-- 5. Visit-scoped declared vehicles (visit_vehicle_declarations)
-- 6. Server-authoritative 1:N returning identity attempts (returning_identity_attempts)
-- 7. App settings retention extension (returning_profile_retention_days = 30)
-- 8. Atomic vehicle entry/exit lifecycle tracking in api.scan_pass
-- 9. Online pass issuance contract v2 (api.issue_online_pass_v2)
-- ==============================================================================

-- 1. Extend public.visitors
alter table public.visitors
  add column if not exists home_address text,
  add column if not exists registration_mode text not null default 'new',
  add column if not exists arrival_mode text not null default 'no_vehicle',
  add column if not exists returning_profile_id uuid,
  add column if not exists returning_identity_attempt_id uuid;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'visitors_registration_mode_check'
  ) then
    alter table public.visitors
      add constraint visitors_registration_mode_check
      check (registration_mode in ('new', 'returning'));
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'visitors_arrival_mode_check'
  ) then
    alter table public.visitors
      add constraint visitors_arrival_mode_check
      check (arrival_mode in ('no_vehicle', 'vehicle'));
  end if;
end $$;

-- 2. Create public.returning_visitor_profiles table
create table if not exists public.returning_visitor_profiles (
  id uuid primary key default gen_random_uuid(),
  first_name text not null,
  middle_name text,
  last_name text not null,
  contact_number_e164 text not null,
  home_address text not null,
  consent_accepted_at timestamptz not null default now(),
  consent_version text not null default 'v1',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_used_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '30 days'),
  revoked_at timestamptz
);

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'visitors_returning_profile_id_fkey'
  ) then
    alter table public.visitors
      add constraint visitors_returning_profile_id_fkey
      foreign key (returning_profile_id) references public.returning_visitor_profiles(id) on delete set null;
  end if;
end $$;

-- 3. Create public.returning_face_templates table
create table if not exists public.returning_face_templates (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null unique references public.returning_visitor_profiles(id) on delete cascade,
  encrypted_embedding text not null,
  iv text not null,
  auth_tag text not null,
  key_version text not null default 'v1',
  model_name text not null,
  model_version text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 4. Create public.returning_visitor_vehicles table
create table if not exists public.returning_visitor_vehicles (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.returning_visitor_profiles(id) on delete cascade,
  vehicle_type text not null check (vehicle_type in ('car', 'motorcycle', 'van', 'suv', 'truck', 'bicycle', 'other')),
  plate_number text not null,
  plate_key text not null,
  color text not null,
  make_model text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_used_at timestamptz not null default now(),
  archived_at timestamptz
);

create index if not exists returning_visitor_vehicles_profile_idx
  on public.returning_visitor_vehicles (profile_id, plate_key)
  where archived_at is null;

-- 5. Create public.visit_vehicle_declarations table
create table if not exists public.visit_vehicle_declarations (
  id uuid primary key default gen_random_uuid(),
  visitor_id uuid not null references public.visitors(id) on delete cascade,
  pass_id uuid not null unique references public.passes(id) on delete cascade,
  saved_vehicle_id uuid references public.returning_visitor_vehicles(id) on delete set null,
  vehicle_type text not null check (vehicle_type in ('car', 'motorcycle', 'van', 'suv', 'truck', 'bicycle', 'other')),
  plate_number text not null,
  plate_key text not null,
  color text not null,
  make_model text,
  entry_recorded_at timestamptz,
  exit_recorded_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists visit_vehicle_declarations_plate_key_idx
  on public.visit_vehicle_declarations (plate_key);

-- 6. Create public.returning_identity_attempts table
create table if not exists public.returning_identity_attempts (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  request_id text not null,
  photo_intent_id uuid references public.upload_intents(id) on delete set null,
  matched_profile_id uuid references public.returning_visitor_profiles(id) on delete set null,
  outcome text not null check (outcome in ('matched', 'low_similarity', 'ambiguous_margin', 'uncalibrated_unavailable', 'error')),
  best_score numeric(6, 4),
  second_score numeric(6, 4),
  model_name text,
  model_version text,
  match_token_digest text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '15 minutes')
);

create index if not exists returning_identity_attempts_lookup_idx
  on public.returning_identity_attempts (owner_id, match_token_digest)
  where outcome = 'matched';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'visitors_returning_identity_attempt_id_fkey'
  ) then
    alter table public.visitors
      add constraint visitors_returning_identity_attempt_id_fkey
      foreign key (returning_identity_attempt_id) references public.returning_identity_attempts(id) on delete set null;
  end if;
end $$;

-- 7. App settings retention extension
alter table public.app_settings
  add column if not exists returning_profile_retention_days integer not null default 30;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'app_settings_returning_retention_check'
  ) then
    alter table public.app_settings
      add constraint app_settings_returning_retention_check
      check (returning_profile_retention_days between 1 and 365);
  end if;
end $$;

-- 8. Row Level Security and Table Grants
alter table public.returning_visitor_profiles enable row level security;
alter table public.returning_face_templates enable row level security;
alter table public.returning_visitor_vehicles enable row level security;
alter table public.visit_vehicle_declarations enable row level security;
alter table public.returning_identity_attempts enable row level security;

-- Default deny for non-service roles on returning biometrics and profiles
revoke all on public.returning_visitor_profiles from public, anon, authenticated;
grant all on public.returning_visitor_profiles to service_role;

revoke all on public.returning_face_templates from public, anon, authenticated;
grant all on public.returning_face_templates to service_role;

revoke all on public.returning_visitor_vehicles from public, anon, authenticated;
grant all on public.returning_visitor_vehicles to service_role;

revoke all on public.returning_identity_attempts from public, anon, authenticated;
grant all on public.returning_identity_attempts to service_role;

-- visit_vehicle_declarations: authenticated staff/devices can select for verification
revoke all on public.visit_vehicle_declarations from public, anon;
grant select on public.visit_vehicle_declarations to authenticated;
grant all on public.visit_vehicle_declarations to service_role;

create policy visit_vehicle_declarations_staff_select on public.visit_vehicle_declarations
  for select to authenticated
  using (
    exists (
      select 1 from public.staff_profiles sp
      where sp.user_id = auth.uid() and sp.role in ('admin'::public.staff_role, 'superadmin'::public.staff_role)
    )
    or exists (
      select 1 from public.devices d
      where d.user_id = auth.uid() and d.status = 'active'::public.device_status
    )
  );

-- 9. Update api.scan_pass for atomic vehicle entry/exit tracking
create or replace function api.scan_pass(
  requested_actor_id uuid,
  requested_token_digest text,
  requested_mode public.device_type,
  requested_request_id uuid
)
returns table (ok boolean, result_status text, code text, message text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  scanner public.devices%rowtype;
  target public.passes%rowtype;
  failure_code text;
  failure_message text;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'service role required';
  end if;
  if requested_mode not in ('entry'::public.device_type, 'exit'::public.device_type)
    or requested_token_digest !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'invalid scan request';
  end if;

  select * into scanner from public.devices d
  where d.user_id = requested_actor_id and d.status = 'active'::public.device_status
  for share;
  if not found or scanner.type <> requested_mode then
    raise exception using errcode = '42501', message = 'active matching scanner required';
  end if;

  select * into target from public.passes p
  where p.token_digest = decode(requested_token_digest, 'hex')
  for update;
  if not found then
    insert into public.visit_events(event, reason, device_id, gate, request_id)
    values ('invalid_scan'::public.visit_event_type, 'QR code not recognized', scanner.user_id, scanner.gate, requested_request_id)
    on conflict (request_id, event) do nothing;
    return query select false, null::text, 'not_found'::text, 'QR code not recognized'::text;
    return;
  end if;

  if requested_mode = 'entry'::public.device_type and target.status = 'issued'::public.pass_status then
    if target.valid_until < now() then
      update public.passes set status = 'expired', updated_at = now(), version = version + 1 where id = target.id;
      failure_code := 'expired'; failure_message := 'This pass has expired';
    elsif target.valid_from > now() then
      failure_code := 'early'; failure_message := 'Pass is not yet valid';
    else
      -- Portal visitors transition directly to 'inside'
      if target.source = 'portal'::public.pass_source then
        update public.passes set
          status = 'inside'::public.pass_status,
          entry_scanned_at = now(),
          time_in = now(),
          entry_device_id = scanner.user_id,
          gate = scanner.gate,
          updated_at = now(),
          version = version + 1
        where id = target.id;

        -- Atomically record vehicle entry timestamp if declared
        update public.visit_vehicle_declarations set
          entry_recorded_at = coalesce(entry_recorded_at, now())
        where visit_vehicle_declarations.pass_id = target.id;

        insert into public.visit_events(pass_id, visitor_id, event, device_id, gate, request_id)
        values (target.id, target.visitor_id, 'scan_entry'::public.visit_event_type, scanner.user_id, scanner.gate, requested_request_id)
        on conflict (request_id, event) do nothing;

        return query select true, 'inside'::text, null::text, 'Entry recorded. Please proceed through the normal security inspection.'::text;
        return;
      else
        -- Kiosk passes retain pending guard review until walk-in redesign
        update public.passes set
          status = 'pending'::public.pass_status,
          entry_scanned_at = now(),
          entry_device_id = scanner.user_id,
          gate = scanner.gate,
          updated_at = now(),
          version = version + 1
        where id = target.id;

        -- Atomically record vehicle entry timestamp if declared
        update public.visit_vehicle_declarations set
          entry_recorded_at = coalesce(entry_recorded_at, now())
        where visit_vehicle_declarations.pass_id = target.id;

        insert into public.visit_events(pass_id, visitor_id, event, device_id, gate, request_id)
        values (target.id, target.visitor_id, 'scan_entry'::public.visit_event_type, scanner.user_id, scanner.gate, requested_request_id)
        on conflict (request_id, event) do nothing;

        return query select true, 'pending'::text, null::text, 'Scanned! Waiting for guard approval.'::text;
        return;
      end if;
    end if;

    insert into public.visit_events(pass_id, visitor_id, event, reason, device_id, gate, request_id)
    values (target.id, target.visitor_id, 'invalid_scan'::public.visit_event_type, failure_message, scanner.user_id, scanner.gate, requested_request_id)
    on conflict (request_id, event) do nothing;
    return query select false, target.status::text, failure_code, failure_message;
    return;
  elsif requested_mode = 'exit'::public.device_type and target.status = 'inside'::public.pass_status then
    -- Restore wrong-gate exit protection
    if target.gate is distinct from scanner.gate then
      failure_code := 'wrong_gate';
      failure_message := 'Use the exit scanner assigned to the entry gate';
      insert into public.visit_events(pass_id, visitor_id, event, reason, device_id, gate, request_id)
      values (target.id, target.visitor_id, 'invalid_scan'::public.visit_event_type, failure_message, scanner.user_id, scanner.gate, requested_request_id)
      on conflict (request_id, event) do nothing;
      return query select false, target.status::text, failure_code, failure_message;
      return;
    else
      update public.passes set
        status = 'exited'::public.pass_status,
        time_out = now(),
        exit_device_id = scanner.user_id,
        updated_at = now(),
        version = version + 1
      where id = target.id;

      -- Atomically record vehicle exit timestamp if declared
      update public.visit_vehicle_declarations set
        exit_recorded_at = coalesce(exit_recorded_at, now())
      where visit_vehicle_declarations.pass_id = target.id;

      insert into public.visit_events(pass_id, visitor_id, event, device_id, gate, request_id)
      values (target.id, target.visitor_id, 'scan_exit'::public.visit_event_type, scanner.user_id, scanner.gate, requested_request_id)
      on conflict (request_id, event) do nothing;

      return query select true, 'exited'::text, null::text, 'Pass successfully exited.'::text;
      return;
    end if;
  else
    if target.status in ('expired'::public.pass_status, 'rejected'::public.pass_status) then
      failure_code := target.status::text; failure_message := 'Pass is no longer valid (' || target.status::text || ')';
    elsif target.status = 'exited'::public.pass_status then
      failure_code := 'already_exited'; failure_message := 'Pass has already exited';
    elsif target.status = 'pending'::public.pass_status then
      failure_code := 'pending'; failure_message := 'Pass is already awaiting guard decision';
    elsif target.status = 'inside'::public.pass_status and requested_mode = 'entry'::public.device_type then
      failure_code := 'already_inside'; failure_message := 'Pass has already been admitted';
    elsif target.status = 'issued'::public.pass_status and requested_mode = 'exit'::public.device_type then
      failure_code := 'not_entered'; failure_message := 'Pass has not recorded an entry yet';
    else
      failure_code := 'invalid_state'; failure_message := 'Pass state cannot transition under current scan';
    end if;

    insert into public.visit_events(pass_id, visitor_id, event, reason, device_id, gate, request_id)
    values (target.id, target.visitor_id, 'invalid_scan'::public.visit_event_type, failure_message, scanner.user_id, scanner.gate, requested_request_id)
    on conflict (request_id, event) do nothing;
    return query select false, target.status::text, failure_code, failure_message;
    return;
  end if;
end;
$$;

revoke all on function api.scan_pass(uuid, text, public.device_type, uuid) from public, anon, authenticated;
grant execute on function api.scan_pass(uuid, text, public.device_type, uuid) to service_role;

-- 10. Service-role transaction for online issuance v2
create or replace function api.issue_online_pass_v2(
  requested_actor_id uuid,
  requested_registration_mode text,
  requested_request_id uuid,
  requested_first_name text,
  requested_middle_name text,
  requested_last_name text,
  requested_contact_number text,
  requested_home_address text,
  requested_purpose text,
  requested_visit_date date,
  requested_photo_intent_id uuid,
  requested_photo_bytes integer,
  requested_photo_sha256 text,
  requested_id_intent_id uuid,
  requested_id_bytes integer,
  requested_id_sha256 text,
  requested_token_digest text,
  requested_arrival_mode text,
  requested_vehicle_type text default null,
  requested_plate_number text default null,
  requested_plate_key text default null,
  requested_color text default null,
  requested_make_model text default null,
  requested_saved_vehicle_id uuid default null,
  requested_returning_profile_id uuid default null,
  requested_returning_match_token_digest text default null
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
  verification_record public.portal_identity_verification_attempts%rowtype;
  returning_attempt_record public.returning_identity_attempts%rowtype;
  returning_profile_record public.returning_visitor_profiles%rowtype;
  existing_pass public.passes%rowtype;
  existing_visitor public.visitors%rowtype;
  existing_decl public.visit_vehicle_declarations%rowtype;
  new_visitor_id uuid;
  new_pass_id uuid;
  new_public_reference uuid;
  starts_at timestamptz;
  ends_at timestamptz;
  full_name_calc text;
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

  -- Validate registration mode and arrival mode parameters
  if requested_registration_mode not in ('new', 'returning') then
    raise exception using errcode = '22023', message = 'invalid registration mode';
  end if;
  if requested_arrival_mode not in ('no_vehicle', 'vehicle') then
    raise exception using errcode = '22023', message = 'invalid arrival mode';
  end if;

  full_name_calc := btrim(concat_ws(' ', nullif(btrim(requested_first_name), ''), nullif(btrim(requested_middle_name), ''), nullif(btrim(requested_last_name), '')));

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

    -- Strict idempotency check: verify all requested attributes match the existing record
    if existing_visitor.registration_mode <> requested_registration_mode
      or existing_visitor.full_name <> full_name_calc
      or existing_visitor.contact_number <> btrim(requested_contact_number)
      or coalesce(existing_visitor.home_address, '') <> btrim(requested_home_address)
      or existing_visitor.purpose <> btrim(requested_purpose)
      or existing_visitor.visit_date <> requested_visit_date
      or existing_visitor.arrival_mode <> requested_arrival_mode
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
    or char_length(btrim(requested_home_address)) not between 5 and 300
    or char_length(btrim(requested_purpose)) not between 3 and 300 then
    raise exception using errcode = '22023', message = 'invalid visitor details';
  end if;

  -- Canonical Philippine Phone Check: +639XXXXXXXXX (13 chars)
  if requested_contact_number !~ '^\+639[0-9]{9}$' then
    raise exception using errcode = '22023', message = 'invalid philippine mobile number';
  end if;

  -- Vehicle validation if arrival_mode = vehicle
  if requested_arrival_mode = 'vehicle' then
    if requested_vehicle_type is null or requested_vehicle_type not in ('car', 'motorcycle', 'van', 'suv', 'truck', 'bicycle', 'other')
      or requested_plate_number is null or char_length(btrim(requested_plate_number)) not between 3 and 16
      or requested_plate_key is null or char_length(btrim(requested_plate_key)) not between 3 and 16
      or requested_color is null or char_length(btrim(requested_color)) not between 2 and 40 then
      raise exception using errcode = '22023', message = 'invalid vehicle declaration details';
    end if;
  end if;

  -- 5. Mode-specific Verification Checks
  if requested_registration_mode = 'new' then
    -- ID upload intent and 1:1 face verification required
    if requested_id_intent_id is null then
      raise exception using errcode = '22023', message = 'identification image required';
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

  elsif requested_registration_mode = 'returning' then
    -- Returning 1:N match attempt required
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
  end if;

  -- 6. Photo upload intent inspection
  select * into photo_intent from public.upload_intents
  where id = requested_photo_intent_id for update;
  if not found or photo_intent.owner_id <> requested_actor_id
    or photo_intent.source <> 'portal'::public.pass_source or photo_intent.kind <> 'photo'::public.evidence_kind
    or photo_intent.status <> 'pending'::public.upload_intent_status or photo_intent.expires_at <= now()
    or requested_photo_bytes not between 1 and photo_intent.max_bytes
    or requested_photo_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'invalid photo upload intent';
  end if;

  -- 7. ID upload intent inspection (if new)
  if requested_registration_mode = 'new' then
    select * into id_intent from public.upload_intents
    where id = requested_id_intent_id for update;
    if not found or id_intent.owner_id <> requested_actor_id
      or id_intent.source <> 'portal'::public.pass_source or id_intent.kind <> 'id'::public.evidence_kind
      or id_intent.status <> 'pending'::public.upload_intent_status or id_intent.expires_at <= now()
      or requested_id_bytes not between 1 and id_intent.max_bytes
      or requested_id_sha256 !~ '^[0-9a-f]{64}$' then
      raise exception using errcode = '22023', message = 'invalid identification upload intent';
    end if;
  end if;

  starts_at := (requested_visit_date + settings.working_hours_start) at time zone settings.timezone;
  ends_at := (requested_visit_date + settings.working_hours_end) at time zone settings.timezone;

  -- 8. Insert visitor record
  insert into public.visitors (
    owner_id, source, created_by_device_id, full_name, contact_number,
    home_address, registration_mode, arrival_mode, returning_profile_id,
    purpose, visit_date, consent_accepted_at,
    identity_verification_id, identity_verified_at, returning_identity_attempt_id
  ) values (
    requested_actor_id, 'portal'::public.pass_source, null,
    full_name_calc, btrim(requested_contact_number),
    btrim(requested_home_address), requested_registration_mode, requested_arrival_mode,
    case when requested_registration_mode = 'returning' then requested_returning_profile_id else null end,
    btrim(requested_purpose), requested_visit_date, now(),
    case when requested_registration_mode = 'new' then verification_record.id else null end,
    case when requested_registration_mode = 'new' then verification_record.verified_at else null end,
    case when requested_registration_mode = 'returning' then returning_attempt_record.id else null end
  ) returning id into new_visitor_id;

  -- 9. Insert visitor photo evidence and claim upload intent
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

  -- 11. Insert pass record
  insert into public.passes (
    visitor_id, token_digest, source, status, valid_from, valid_until, issue_request_id
  ) values (
    new_visitor_id, decode(requested_token_digest, 'hex'), 'portal'::public.pass_source, 'issued',
    starts_at, ends_at, requested_request_id
  ) returning id, passes.public_reference into new_pass_id, new_public_reference;

  -- 12. Insert visit vehicle declaration if arrival_mode = vehicle
  if requested_arrival_mode = 'vehicle' then
    insert into public.visit_vehicle_declarations (
      visitor_id, pass_id, saved_vehicle_id, vehicle_type,
      plate_number, plate_key, color, make_model
    ) values (
      new_visitor_id, new_pass_id, requested_saved_vehicle_id, requested_vehicle_type,
      btrim(requested_plate_number), btrim(requested_plate_key), btrim(requested_color), nullif(btrim(requested_make_model), '')
    );
  end if;

  -- 13. Update returning profile last_used_at and roll expiry if returning
  if requested_registration_mode = 'returning' then
    update public.returning_visitor_profiles set
      last_used_at = now(),
      updated_at = now(),
      expires_at = greatest(expires_at, now() + make_interval(days => settings.returning_profile_retention_days))
    where id = requested_returning_profile_id;
  end if;

  -- 14. Audit event
  insert into public.audit_events (
    actor_id, actor_kind, action, target_type, target_id, request_id, after_state
  ) values (
    requested_actor_id, 'system', 'pass.issue', 'pass', new_pass_id::text, requested_request_id,
    jsonb_build_object(
      'source', 'portal',
      'registrationMode', requested_registration_mode,
      'arrivalMode', requested_arrival_mode,
      'visitDate', requested_visit_date,
      'hasVehicle', (requested_arrival_mode = 'vehicle')
    )
  );

  pass_id := new_pass_id;
  public_reference := new_public_reference;
  valid_from := starts_at;
  valid_until := ends_at;
  return next;
end;
$$;

revoke all on function api.issue_online_pass_v2(uuid, text, uuid, text, text, text, text, text, text, date, uuid, integer, text, uuid, integer, text, text, text, text, text, text, text, text, uuid, uuid, text) from public, anon, authenticated;
grant execute on function api.issue_online_pass_v2(uuid, text, uuid, text, text, text, text, text, text, date, uuid, integer, text, uuid, integer, text, text, text, text, text, text, text, text, uuid, uuid, text) to service_role;
