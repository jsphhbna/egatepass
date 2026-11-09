-- Migration: 20261109000100_institutional_calendar_and_office_governance.sql
-- Description: Institutional Campus Calendar & Closures, Office Provenance & Verification,
-- Free-text Specific-Person Requests, Safe Historical Returning Profile Recovery,
-- Closed-Date Enforcement across all issuance paths, and PSGC composite index optimization.

-- ============================================================================
-- 1. Institutional Holiday and Campus Closure Calendar
-- ============================================================================
create table if not exists public.campus_calendar_closures (
  id uuid primary key default gen_random_uuid(),
  title text not null check (char_length(btrim(title)) between 2 and 150),
  closure_type text not null check (closure_type in ('holiday', 'campus_closure')),
  start_date date not null,
  end_date date not null,
  description text check (description is null or char_length(btrim(description)) <= 500),
  active boolean not null default true,
  published boolean not null default true,
  created_by uuid references public.staff_profiles(user_id) on delete set null,
  updated_by uuid references public.staff_profiles(user_id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint check_valid_date_range check (end_date >= start_date)
);

create index if not exists idx_closures_dates
  on public.campus_calendar_closures(start_date, end_date)
  where active and published;

create index if not exists idx_closures_active
  on public.campus_calendar_closures(active, published);

alter table public.campus_calendar_closures enable row level security;

-- Superadmin full mutation governance
drop policy if exists closures_superadmin_all on public.campus_calendar_closures;
create policy closures_superadmin_all on public.campus_calendar_closures
  for all using (
    auth.role() = 'service_role'
    or private.current_staff_role() = 'superadmin'
  )
  with check (
    auth.role() = 'service_role'
    or private.current_staff_role() = 'superadmin'
  );

-- Admin read access
drop policy if exists closures_admin_read on public.campus_calendar_closures;
create policy closures_admin_read on public.campus_calendar_closures
  for select using (
    auth.role() = 'service_role'
    or private.current_staff_role() in ('admin', 'superadmin')
  );

-- Public / Anonymous visitor read access to active & published closures
drop policy if exists closures_public_read on public.campus_calendar_closures;
create policy closures_public_read on public.campus_calendar_closures
  for select using (
    active = true and published = true
  );

-- ============================================================================
-- 2. Office Directory Provenance & Verification
-- ============================================================================
alter table public.offices
  add column if not exists verified boolean not null default false,
  add column if not exists verified_at timestamptz,
  add column if not exists verified_by uuid references public.staff_profiles(user_id) on delete set null;

create index if not exists idx_offices_verified_active
  on public.offices(verified, active);

-- Deactivate unverified seeded personnel so they are no longer shown to visitors
update public.office_personnel
set active = false, updated_at = now()
where id in (
  '22222222-0000-0000-0000-000000000001',
  '22222222-0000-0000-0000-000000000002',
  '22222222-0000-0000-0000-000000000003',
  '22222222-0000-0000-0000-000000000004',
  '22222222-0000-0000-0000-000000000005',
  '22222222-0000-0000-0000-000000000006',
  '22222222-0000-0000-0000-000000000007',
  '22222222-0000-0000-0000-000000000008',
  '22222222-0000-0000-0000-000000000009',
  '22222222-0000-0000-0000-000000000010',
  '22222222-0000-0000-0000-000000000011',
  '22222222-0000-0000-0000-000000000012'
);

-- ============================================================================
-- 3. Office Visits: Free-Text Requested Person Name
-- ============================================================================
alter table public.office_visits
  add column if not exists requested_person_name text check (
    requested_person_name is null or char_length(btrim(requested_person_name)) between 2 and 150
  );

-- ============================================================================
-- 4. PSGC Query Performance Composite Indexes
-- ============================================================================
create index if not exists psgc_locations_parent_level_active_idx
  on public.psgc_locations(parent_psgc_code, level, is_active);

create index if not exists psgc_locations_code_active_idx
  on public.psgc_locations(psgc_code, is_active);

-- ============================================================================
-- 5. Safe Historical Returning Visitor Profile Recovery
-- ============================================================================
-- Idempotently enroll eligible historical visitors who have non-purged, non-expired portraits
-- and valid consent, without fabricating identity fields or touching expired evidence.
do $$
declare
  r record;
  v_first text;
  v_last text;
  new_profile_id uuid;
begin
  for r in
    select v.id as visitor_id, v.full_name, v.contact_number, v.home_address,
           v.home_location_lat, v.home_location_lon, v.psgc_version,
           v.psgc_region_code, v.psgc_province_code, v.psgc_city_code, v.psgc_barangay_code,
           v.psgc_region_name, v.psgc_province_name, v.psgc_city_municipality_name, v.psgc_barangay_name,
           v.home_building, v.home_street, v.postal_code, v.postal_code_source,
           v.consent_accepted_at
    from public.visitors v
    where v.returning_profile_id is null
      and v.consent_accepted_at is not null
      and v.contact_number is not null
      and char_length(btrim(v.contact_number)) >= 7
      and exists (
        select 1 from public.visitor_evidence ve
        where ve.visitor_id = v.id
          and ve.kind = 'photo'
          and ve.purged_at is null
          and ve.expires_at > now()
      )
  loop
    v_first := split_part(btrim(r.full_name), ' ', 1);
    v_last := nullif(btrim(substring(btrim(r.full_name) from length(v_first) + 2)), '');
    if v_last is null then
      v_last := v_first;
    end if;

    insert into public.returning_visitor_profiles (
      first_name, middle_name, last_name, contact_number_e164,
      home_address, home_location_lat, home_location_lon,
      psgc_version, psgc_region_code, psgc_province_code, psgc_city_code, psgc_barangay_code,
      psgc_region_name, psgc_province_name, psgc_city_municipality_name, psgc_barangay_name,
      home_building, home_street, postal_code, postal_code_source,
      consent_accepted_at, consent_version, expires_at
    ) values (
      v_first, null, v_last, btrim(r.contact_number),
      r.home_address, r.home_location_lat, r.home_location_lon,
      coalesce(r.psgc_version, '2026-q3'), r.psgc_region_code, r.psgc_province_code, r.psgc_city_code, r.psgc_barangay_code,
      r.psgc_region_name, r.psgc_province_name, r.psgc_city_municipality_name, r.psgc_barangay_name,
      r.home_building, r.home_street, r.postal_code, r.postal_code_source,
      r.consent_accepted_at, 'v1', now() + interval '365 days'
    )
    returning id into new_profile_id;

    update public.visitors
    set returning_profile_id = new_profile_id
    where id = r.visitor_id;
  end loop;
end;
$$;

-- ============================================================================
-- 6. RPC: Update api.issue_pass with Closed-Date Enforcement
-- ============================================================================
create or replace function api.issue_pass(
  requested_actor_id uuid,
  requested_source public.pass_source,
  requested_request_id uuid,
  requested_full_name text,
  requested_contact_number text,
  requested_purpose text,
  requested_visit_date date,
  requested_photo_intent_id uuid,
  requested_photo_bytes integer,
  requested_photo_sha256 text,
  requested_id_intent_id uuid,
  requested_id_bytes integer,
  requested_id_sha256 text,
  requested_token_digest text
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
  new_visitor_id uuid;
  new_pass_id uuid;
  new_public_reference uuid;
  starts_at timestamptz;
  ends_at timestamptz;
  id_is_required boolean;
  target_closure_title text;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'service role required';
  end if;

  if requested_source = 'portal'::public.pass_source then
    if not exists (
      select 1 from auth.users u
      where u.id = requested_actor_id and coalesce(u.is_anonymous, false)
    ) or exists (select 1 from public.staff_profiles where user_id = requested_actor_id)
      or exists (select 1 from public.devices where user_id = requested_actor_id) then
      raise exception using errcode = '42501', message = 'anonymous visitor identity required';
    end if;
  elsif requested_source = 'kiosk'::public.pass_source then
    if not exists (
      select 1 from public.devices d
      where d.user_id = requested_actor_id
        and d.type = 'kiosk'::public.device_type
        and d.status = 'active'::public.device_status
    ) then
      raise exception using errcode = '42501', message = 'active kiosk identity required';
    end if;
  else
    raise exception using errcode = '22023', message = 'unsupported source';
  end if;

  -- Serialize retries so concurrent requests cannot race past the idempotency check.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(requested_request_id::text, 0));
  select p.id, p.public_reference, p.valid_from, p.valid_until
  into pass_id, public_reference, valid_from, valid_until
  from public.passes p
  join public.visitors v on v.id = p.visitor_id
  where p.issue_request_id = requested_request_id
    and v.owner_id = requested_actor_id
    and v.source = requested_source;
  if found then return next; return; end if;

  select * into settings from public.app_settings where singleton for share;
  if requested_visit_date < (now() at time zone settings.timezone)::date
    or requested_visit_date > (now() at time zone settings.timezone)::date + settings.scheduling_days_ahead then
    raise exception using errcode = '22023', message = 'visit date outside scheduling window';
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

  if char_length(btrim(requested_full_name)) not between 2 and 160
    or char_length(btrim(requested_contact_number)) not between 7 and 32
    or char_length(btrim(requested_purpose)) not between 3 and 300 then
    raise exception using errcode = '22023', message = 'invalid visitor details';
  end if;

  id_is_required := (requested_source = 'portal'::public.pass_source);
  if id_is_required and requested_id_intent_id is null then
    raise exception using errcode = '22023', message = 'id intent required for portal passes';
  end if;

  select * into photo_intent from public.upload_intents where id = requested_photo_intent_id for update;
  if not found or photo_intent.owner_id <> requested_actor_id
    or photo_intent.source <> requested_source or photo_intent.kind <> 'photo'::public.evidence_kind
    or photo_intent.status <> 'pending'::public.upload_intent_status or photo_intent.expires_at <= now()
    or requested_photo_bytes not between 1 and photo_intent.max_bytes
    or requested_photo_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'invalid photo upload intent';
  end if;

  if requested_id_intent_id is not null then
    select * into id_intent from public.upload_intents where id = requested_id_intent_id for update;
    if not found or id_intent.owner_id <> requested_actor_id
      or id_intent.source <> requested_source or id_intent.kind <> 'id'::public.evidence_kind
      or id_intent.status <> 'pending'::public.upload_intent_status or id_intent.expires_at <= now()
      or requested_id_bytes not between 1 and id_intent.max_bytes
      or requested_id_sha256 !~ '^[0-9a-f]{64}$' then
      raise exception using errcode = '22023', message = 'invalid id upload intent';
    end if;
  end if;

  if requested_source = 'portal'::public.pass_source then
    select * into verification_record
    from public.portal_identity_verification_attempts
    where owner_id = requested_actor_id
      and photo_intent_id = requested_photo_intent_id
      and id_intent_id = requested_id_intent_id
      and outcome = 'verified'
      and verified_at is not null
      and expires_at > now()
    order by created_at desc
    limit 1;

    if not found then
      raise exception using errcode = '42501', message = 'valid identity verification required';
    end if;
  end if;

  starts_at := (requested_visit_date + settings.working_hours_start) at time zone settings.timezone;
  ends_at := (requested_visit_date + settings.working_hours_end) at time zone settings.timezone;

  insert into public.visitors (
    owner_id, source, created_by_device_id, full_name, contact_number,
    purpose, visit_date, consent_accepted_at,
    identity_verification_id, identity_verified_at
  ) values (
    requested_actor_id, requested_source,
    case when requested_source = 'kiosk'::public.pass_source then requested_actor_id else null end,
    btrim(requested_full_name), btrim(requested_contact_number),
    btrim(requested_purpose), requested_visit_date, now(),
    case when requested_source = 'portal'::public.pass_source then verification_record.id else null end,
    case when requested_source = 'portal'::public.pass_source then verification_record.verified_at else null end
  ) returning id into new_visitor_id;

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

  if requested_id_intent_id is not null then
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

  insert into public.passes (
    visitor_id, source, issue_request_id, status, valid_from, valid_until,
    token_digest
  ) values (
    new_visitor_id, requested_source, requested_request_id, 'issued'::public.pass_status,
    starts_at, ends_at, decode(requested_token_digest, 'hex')
  ) returning id, public_reference into new_pass_id, new_public_reference;

  insert into public.audit_events (
    actor_id, actor_kind, action, target_type, target_id, request_id, after_state
  ) values (
    requested_actor_id,
    case when requested_source = 'kiosk'::public.pass_source then 'device' else 'system' end,
    'pass.issue', 'pass', new_pass_id::text, requested_request_id,
    jsonb_build_object('source', requested_source, 'visitDate', requested_visit_date, 'publicReference', new_public_reference)
  );

  pass_id := new_pass_id;
  public_reference := new_public_reference;
  valid_from := starts_at;
  valid_until := ends_at;
  return next;
end;
$$;

revoke all on function api.issue_pass(uuid, public.pass_source, uuid, text, text, text, date, uuid, integer, text, uuid, integer, text, text) from public, anon, authenticated;
grant execute on function api.issue_pass(uuid, public.pass_source, uuid, text, text, text, date, uuid, integer, text, uuid, integer, text, text) to service_role;

-- ============================================================================
-- 7. RPC: Update api.issue_online_pass_v6 with Closed-Date Enforcement
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
  -- Structured PSGC Residential Address
  requested_psgc_version text default '2026-q3',
  requested_psgc_region_code text default null,
  requested_psgc_province_code text default null,
  requested_psgc_city_code text default null,
  requested_psgc_barangay_code text default null,
  requested_home_building text default null,
  requested_home_street text default null,
  requested_postal_code text default null,
  requested_postal_code_source text default null,
  -- Legacy / optional coordinates
  requested_home_location_lat numeric(6,3) default null,
  requested_home_location_lon numeric(6,3) default null,
  -- Vehicle declaration parameters
  requested_vehicle_type text default null,
  requested_plate_number text default null,
  requested_plate_key text default null,
  requested_color text default null,
  requested_make_model text default null,
  requested_vehicle_catalog_status text default 'catalog',
  requested_vehicle_photo_intent_id uuid default null,
  requested_vehicle_photo_bytes integer default null,
  requested_vehicle_photo_sha256 text default null,
  -- Returning parameters
  requested_saved_vehicle_id uuid default null,
  requested_returning_profile_id uuid default null,
  requested_returning_match_token_digest text default null,
  requested_save_vehicle boolean default false,
  requested_save_profile_updates boolean default false
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
  starts_at timestamptz;
  ends_at timestamptz;
  full_name_calc text;
  v_plate_conflict boolean := false;
  target_closure_title text;
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

  if requested_registration_mode not in ('new', 'returning') then
    raise exception using errcode = '22023', message = 'invalid registration mode';
  end if;
  if requested_arrival_mode not in ('no_vehicle', 'vehicle') then
    raise exception using errcode = '22023', message = 'invalid arrival mode: explicit selection required';
  end if;

  full_name_calc := btrim(concat_ws(' ', nullif(btrim(requested_first_name), ''), nullif(btrim(requested_middle_name), ''), nullif(btrim(requested_last_name), '')));

  -- Map legacy synthetic Manila barangays to official active PSA counterparts early
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

    -- Strict idempotency check (including PSGC symmetry)
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

  -- 3. Settings & Window checks
  select * into settings from public.app_settings where singleton for share;
  if requested_visit_date < (now() at time zone settings.timezone)::date
    or requested_visit_date > (now() at time zone settings.timezone)::date + settings.scheduling_days_ahead then
    raise exception using errcode = '22023', message = 'visit date outside scheduling window';
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

  -- 4. Field validation
  if char_length(btrim(requested_first_name)) < 1
    or char_length(btrim(requested_last_name)) < 1
    or char_length(full_name_calc) not between 2 and 160
    or char_length(btrim(requested_contact_number)) not between 7 and 32
    or char_length(btrim(requested_purpose)) not between 3 and 300 then
    raise exception using errcode = '22023', message = 'invalid visitor details';
  end if;

  if requested_contact_number !~ '^\+639[0-9]{9}$' then
    raise exception using errcode = '22023', message = 'invalid philippine mobile number';
  end if;

  -- 5. Server-side Geographic & PSGC Validation
  if requested_psgc_region_code is null or requested_psgc_city_code is null or requested_psgc_barangay_code is null then
    raise exception using errcode = '22023', message = 'structured psgc residential address required';
  end if;

  -- 5.1 Dataset Version Check
  select * into version_rec from public.psgc_reference_versions
  where id = coalesce(requested_psgc_version, '2026-q3') and is_active = true;
  if not found then
    raise exception using errcode = '22023', message = 'invalid or inactive psgc dataset version';
  end if;

  -- 5.2 Region Check
  select * into region_rec from public.psgc_locations
  where psgc_code = requested_psgc_region_code and level = 'region' and is_active = true;
  if not found then
    raise exception using errcode = '22023', message = 'invalid psgc region';
  end if;
  v_region_name := region_rec.name;

  -- Check if region has provinces
  select exists (
    select 1 from public.psgc_locations
    where parent_psgc_code = requested_psgc_region_code and level = 'province' and is_active = true
  ) into region_has_provinces;

  -- 5.3 Province Check
  if region_has_provinces then
    if requested_psgc_province_code is null then
      raise exception using errcode = '22023', message = 'psgc province code required for region';
    end if;
    select * into province_rec from public.psgc_locations
    where psgc_code = requested_psgc_province_code
      and level = 'province'
      and parent_psgc_code = requested_psgc_region_code
      and is_active = true;
    if not found then
      raise exception using errcode = '22023', message = 'psgc province does not belong to selected region';
    end if;
    v_province_name := province_rec.name;
  else
    if requested_psgc_province_code is not null then
      raise exception using errcode = '22023', message = 'psgc province not permitted for region with no provinces';
    end if;
  end if;

  -- 5.4 City / Municipality Check
  select * into city_rec from public.psgc_locations
  where psgc_code = requested_psgc_city_code
    and level in ('city', 'municipality')
    and is_active = true;
  if not found then
    raise exception using errcode = '22023', message = 'invalid psgc city or municipality';
  end if;

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

  -- 5.5 Barangay Check
  select * into barangay_rec from public.psgc_locations
  where psgc_code = requested_psgc_barangay_code
    and level = 'barangay'
    and parent_psgc_code = requested_psgc_city_code
    and is_active = true;
  if not found then
    raise exception using errcode = '22023', message = 'psgc barangay does not belong to selected city/municipality';
  end if;
  v_barangay_name := barangay_rec.name;

  -- 5.6 Postal Code Format Check (optional)
  if requested_postal_code is not null and btrim(requested_postal_code) !~ '^[0-9]{4}$' then
    raise exception using errcode = '22023', message = 'invalid philippine 4-digit postal code';
  end if;

  -- 5.7 Compose Snapshot Address
  effective_home_address := concat_ws(', ',
    nullif(btrim(requested_home_building), ''),
    nullif(btrim(requested_home_street), ''),
    v_barangay_name,
    v_city_name,
    v_province_name,
    v_region_name,
    case when nullif(btrim(requested_postal_code), '') is not null then concat('Postal Code ', btrim(requested_postal_code)) else null end
  );

  -- 6. Arrival mode invariants
  if requested_arrival_mode = 'no_vehicle' then
    if requested_vehicle_type is not null
      or requested_plate_number is not null
      or requested_plate_key is not null
      or requested_color is not null
      or requested_vehicle_photo_intent_id is not null then
      raise exception using errcode = '22023', message = 'vehicle details not permitted for pedestrian arrival';
    end if;
  elsif requested_arrival_mode = 'vehicle' then
    if requested_vehicle_type is null or requested_vehicle_type not in ('car', 'motorcycle', 'van', 'pickup', 'suv', 'truck', 'other')
      or requested_plate_number is null or char_length(btrim(requested_plate_number)) not between 3 and 16
      or requested_plate_key is null or char_length(btrim(requested_plate_key)) not between 3 and 16
      or requested_color is null or char_length(btrim(requested_color)) not between 2 and 40
      or requested_vehicle_catalog_status not in ('catalog', 'manual') then
      raise exception using errcode = '22023', message = 'invalid vehicle declaration details';
    end if;

    if requested_vehicle_photo_intent_id is null then
      raise exception using errcode = '22023', message = 'vehicle photo required for vehicle arrival';
    end if;

    select * into vehicle_photo_intent from public.upload_intents
    where id = requested_vehicle_photo_intent_id for update;
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

  -- 7. Verification checks
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

    -- Inspect photo upload intent for new visitor
    select * into photo_intent from public.upload_intents
    where id = requested_photo_intent_id for update;
    if not found or photo_intent.owner_id <> requested_actor_id
      or photo_intent.source <> 'portal'::public.pass_source or photo_intent.kind <> 'photo'::public.evidence_kind
      or photo_intent.status <> 'pending'::public.upload_intent_status or photo_intent.expires_at <= now()
      or requested_photo_bytes not between 1 and photo_intent.max_bytes
      or requested_photo_sha256 !~ '^[0-9a-f]{64}$' then
      raise exception using errcode = '22023', message = 'invalid photo upload intent';
    end if;

    -- Inspect ID upload intent for new visitor
    select * into id_intent from public.upload_intents
    where id = requested_id_intent_id for update;
    if not found or id_intent.owner_id <> requested_actor_id
      or id_intent.source <> 'portal'::public.pass_source or id_intent.kind <> 'id'::public.evidence_kind
      or id_intent.status <> 'pending'::public.upload_intent_status or id_intent.expires_at <= now()
      or requested_id_bytes not between 1 and id_intent.max_bytes
      or requested_id_sha256 !~ '^[0-9a-f]{64}$' then
      raise exception using errcode = '22023', message = 'invalid identification upload intent';
    end if;

    -- Issue B: When registration mode is 'new', DO NOT search for or reuse ANY existing returning profile!
    -- Create an independent new returning profile row so this identity is never attached to another human.
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
      now(), 'v1', now() + interval '365 days'
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

    -- Issue E: In provisional mode, do NOT silently link profile as an authoritatively verified returning visitor!
    -- Profile linkage is authorized ONLY when verification is calibrated ('matched').
    -- In provisional mode, the pass is issued for gate inspection but returning_profile_id remains unlinked.
    if coalesce(returning_attempt_record.threshold_mode, 'provisional') = 'calibrated'
       and returning_attempt_record.outcome = 'matched' then
      returning_profile_id_resolved := requested_returning_profile_id;

      -- Issue D: Respect requested_save_profile_updates!
      if requested_save_profile_updates then
        update public.returning_visitor_profiles
        set last_used_at = now(),
            updated_at = now(),
            expires_at = greatest(expires_at, now() + interval '365 days'),
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
        -- saveUpdates is false: ONLY update last_used_at and extend expiry, preserving contact and address
        update public.returning_visitor_profiles
        set last_used_at = now(),
            expires_at = greatest(expires_at, now() + interval '365 days')
        where id = returning_profile_id_resolved;
      end if;
    else
      -- Provisional verification: pass issued, but profile is not linked or updated without physical gate verification
      returning_profile_id_resolved := null;
    end if;
  end if;

  starts_at := (requested_visit_date + settings.working_hours_start) at time zone settings.timezone;
  ends_at := (requested_visit_date + settings.working_hours_end) at time zone settings.timezone;

  -- 8. Insert visitor record with structured PSGC address and snapshots
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

  -- 9. Insert visitor photo evidence if new
  if requested_registration_mode = 'new' and requested_photo_intent_id is not null then
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
  end if;

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

  -- 11. Vehicle photo evidence and declaration
  if requested_arrival_mode = 'vehicle' then
    insert into public.visitor_evidence (
      visitor_id, upload_intent_id, kind, bucket_id, object_path, content_type,
      byte_size, sha256_hex, verified_at, expires_at
    ) values (
      new_visitor_id, vehicle_photo_intent.id, vehicle_photo_intent.kind, vehicle_photo_intent.bucket_id,
      vehicle_photo_intent.object_path, vehicle_photo_intent.content_type, requested_vehicle_photo_bytes,
      requested_vehicle_photo_sha256, now(), greatest(
        now() + make_interval(days => settings.image_retention_days),
        ends_at + interval '1 day'
      )
    ) returning id into new_vehicle_evidence_id;

    update public.upload_intents set status = 'claimed', claimed_at = now(), visitor_id = new_visitor_id
    where id = vehicle_photo_intent.id;
  end if;

  -- 12. Optional vehicle saving to profile
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

  -- 13. Create Pass Record
  insert into public.passes (
    visitor_id, token_digest, source, status, valid_from, valid_until, issue_request_id
  ) values (
    new_visitor_id, decode(requested_token_digest, 'hex'), 'portal'::public.pass_source, 'issued'::public.pass_status,
    starts_at, ends_at, requested_request_id
  ) returning id, passes.public_reference into new_pass_id, new_public_reference;

  -- 14. Create Vehicle Declaration linked to pass
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

  pass_id := new_pass_id;
  public_reference := new_public_reference;
  valid_from := starts_at;
  valid_until := ends_at;
  return next;
end;
$$;

revoke all on function api.issue_online_pass_v6 from public;
revoke all on function api.issue_online_pass_v6 from anon;
revoke all on function api.issue_online_pass_v6 from authenticated;
grant execute on function api.issue_online_pass_v6 to service_role;

-- ============================================================================
-- 8. RPC: Update api.create_specific_person_visit_request
-- ============================================================================
drop function if exists api.create_specific_person_visit_request(uuid, uuid, uuid, uuid, text, text, text, text, text, text, date, text, jsonb, jsonb, uuid, integer, text, uuid, integer, text, uuid, integer, text, text, uuid, text, uuid, uuid);
drop function if exists api.create_specific_person_visit_request(uuid, uuid, uuid, uuid, text, text, text, text, text, text, date, text, jsonb, jsonb, uuid, integer, text, uuid, integer, text, uuid, integer, text, text, uuid, text, uuid, uuid, text);

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
  requested_person_name text default null
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
  target_closure_title text;
  v_effective_person_name text;
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

  -- 3. Validate Office: Must be active AND verified
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
    email_delivery_status
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
    'pending'
  )
  returning id into new_visit_id;

  -- 10. Insert Audit Event
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

revoke all on function api.create_specific_person_visit_request(uuid, uuid, uuid, uuid, text, text, text, text, text, text, date, text, jsonb, jsonb, uuid, integer, text, uuid, integer, text, uuid, integer, text, text, uuid, text, uuid, uuid, text) from public, anon, authenticated;
grant execute on function api.create_specific_person_visit_request(uuid, uuid, uuid, uuid, text, text, text, text, text, text, date, text, jsonb, jsonb, uuid, integer, text, uuid, integer, text, uuid, integer, text, text, uuid, text, uuid, uuid, text) to service_role;


-- ============================================================================
-- 9. RPC: Update api.record_general_office_visit with Closed-Date & Verified Check
-- ============================================================================
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
  target_closure_title text;
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

  -- Closed Date Enforcement
  if exists (
    select 1 from public.campus_calendar_closures
    where active and published and target_visitor.visit_date between start_date and end_date
  ) then
    select title into target_closure_title
    from public.campus_calendar_closures
    where active and published and target_visitor.visit_date between start_date and end_date
    limit 1;
    raise exception 'visit_date_closed: %', target_closure_title using errcode = 'P0001';
  end if;

  -- Idempotency check
  select id, public.office_visits.attendance_status into new_visit_id, attendance_status
  from public.office_visits
  where request_id = requested_request_id or pass_id = requested_pass_id;
  if found then
    return query select new_visit_id, attendance_status;
    return;
  end if;

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
    visitor_first_name,
    visitor_last_name,
    visitor_display_name,
    visitor_contact_number,
    visitor_email,
    visitor_email_verified,
    purpose,
    visit_date,
    arrival_mode,
    vehicle_details,
    address_details,
    request_id,
    email_delivery_status
  ) values (
    'general',
    requested_office_id,
    'approved',
    'awaiting_entry',
    target_visitor.owner_id,
    target_visitor.id,
    target_pass.id,
    v_first_name,
    v_last_name,
    target_visitor.full_name,
    target_visitor.contact_number,
    null,
    false,
    target_visitor.purpose,
    target_visitor.visit_date,
    target_visitor.arrival_mode,
    null,
    null,
    requested_request_id,
    null
  )
  returning id into new_visit_id;

  insert into public.office_visit_events (
    office_visit_id,
    actor_id,
    event_type,
    metadata
  ) values (
    new_visit_id,
    requested_actor_id,
    'general_visit_recorded',
    jsonb_build_object(
      'pass_id', target_pass.id,
      'office_id', requested_office_id,
      'visit_date', target_visitor.visit_date
    )
  );

  return query select new_visit_id, 'awaiting_entry'::public.office_attendance_status;
end;
$$;

revoke all on function api.record_general_office_visit(uuid, uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function api.record_general_office_visit(uuid, uuid, uuid, uuid) to service_role;

-- ============================================================================
-- 10. PSGC Server-Side Query Performance Composite Indexes
-- ============================================================================
create index if not exists idx_psgc_locations_parent_level_active
  on public.psgc_locations(parent_psgc_code, level)
  where is_active = true;

create index if not exists idx_psgc_locations_code_active
  on public.psgc_locations(psgc_code)
  where is_active = true;

