-- Migration: 20261106000100_office_visit_management_system.sql
-- Description: Office directory, personnel, office staff accounts, specific-person requests, approval-based QR issuance, attendance confirmation, and exit exception handling.

-- 1. Extend public.staff_role enum to include 'office_staff'
alter type public.staff_role add value if not exists 'office_staff';

-- 2. Authoritative Office Directory
create table if not exists public.offices (
  id uuid primary key default gen_random_uuid(),
  name text not null unique check (char_length(btrim(name)) between 2 and 150),
  description text check (description is null or char_length(btrim(description)) <= 500),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references public.staff_profiles(user_id) on delete set null,
  updated_by uuid references public.staff_profiles(user_id) on delete set null
);

create index if not exists idx_offices_active on public.offices(active);

-- 3. Office Personnel Directory
create table if not exists public.office_personnel (
  id uuid primary key default gen_random_uuid(),
  office_id uuid not null references public.offices(id) on delete restrict,
  name text not null check (char_length(btrim(name)) between 2 and 150),
  title text not null check (char_length(btrim(title)) between 2 and 120),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references public.staff_profiles(user_id) on delete set null,
  updated_by uuid references public.staff_profiles(user_id) on delete set null
);

create index if not exists idx_office_personnel_office_id on public.office_personnel(office_id);
create index if not exists idx_office_personnel_active on public.office_personnel(active);

-- 4. Office Staff Assignments
create table if not exists public.office_staff_assignments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.staff_profiles(user_id) on delete cascade,
  office_id uuid not null references public.offices(id) on delete cascade,
  created_at timestamptz not null default now(),
  created_by uuid references public.staff_profiles(user_id) on delete set null,
  unique (user_id, office_id)
);

create index if not exists idx_office_staff_assignments_user_id on public.office_staff_assignments(user_id);
create index if not exists idx_office_staff_assignments_office_id on public.office_staff_assignments(office_id);

-- 5. Office Approval & Attendance Enums
do $$ begin
  if not exists (select 1 from pg_type where typname = 'office_approval_status') then
    create type public.office_approval_status as enum (
      'not_required',
      'pending',
      'approved',
      'rejected'
    );
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_type where typname = 'office_attendance_status') then
    create type public.office_attendance_status as enum (
      'awaiting_entry',
      'awaiting_office_confirmation',
      'confirmed',
      'exited_unconfirmed',
      'completed',
      'cancelled',
      'expired'
    );
  end if;
end $$;

-- 6. Office Visits Table
create table if not exists public.office_visits (
  id uuid primary key default gen_random_uuid(),
  visit_type text not null check (visit_type in ('general', 'specific_person')),
  office_id uuid not null references public.offices(id) on delete restrict,
  personnel_id uuid references public.office_personnel(id) on delete restrict,
  
  -- Pre-approval state
  approval_status public.office_approval_status not null default 'not_required',
  rejection_reason text check (rejection_reason is null or char_length(btrim(rejection_reason)) > 0),
  decided_at timestamptz,
  decided_by uuid references public.staff_profiles(user_id) on delete set null,

  -- Office attendance state
  attendance_status public.office_attendance_status not null default 'awaiting_entry',
  confirmed_at timestamptz,
  confirmed_by uuid references public.staff_profiles(user_id) on delete set null,
  
  -- Linkages
  visitor_id uuid references public.visitors(id) on delete cascade,
  pass_id uuid references public.passes(id) on delete set null,
  
  -- Visitor registration snapshots
  visitor_first_name text not null check (char_length(btrim(visitor_first_name)) >= 1),
  visitor_middle_name text,
  visitor_last_name text not null check (char_length(btrim(visitor_last_name)) >= 1),
  visitor_contact_number text not null check (char_length(btrim(visitor_contact_number)) >= 7),
  visitor_email text,
  visitor_email_verified boolean not null default false,
  visitor_photo_path text,
  visitor_id_path text,
  purpose text not null check (char_length(btrim(purpose)) >= 3),
  visit_date date not null,
  arrival_mode text not null default 'no_vehicle',
  
  -- Vehicle & Address metadata
  vehicle_details jsonb,
  address_details jsonb,
  
  -- Intent IDs
  photo_intent_id uuid,
  id_intent_id uuid,
  vehicle_photo_intent_id uuid,

  -- Email dispatch tracking
  email_delivery_status text not null default 'none' check (email_delivery_status in ('none', 'pending', 'sent', 'failed')),
  email_dispatched_at timestamptz,
  email_error text,

  -- Idempotency and audit
  request_id uuid not null unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_office_visits_office_id on public.office_visits(office_id);
create index if not exists idx_office_visits_pass_id on public.office_visits(pass_id);
create index if not exists idx_office_visits_approval_status on public.office_visits(approval_status);
create index if not exists idx_office_visits_attendance_status on public.office_visits(attendance_status);
create index if not exists idx_office_visits_visit_date on public.office_visits(visit_date);
create index if not exists idx_office_visits_created_at on public.office_visits(created_at desc);

-- 7. Office Visit Auditable Events Table
create table if not exists public.office_visit_events (
  id uuid primary key default gen_random_uuid(),
  office_visit_id uuid not null references public.office_visits(id) on delete cascade,
  event_type text not null,
  actor_id uuid references auth.users(id) on delete set null,
  actor_role text,
  metadata jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_office_visit_events_visit_id on public.office_visit_events(office_visit_id);

-- 8. Office Visit Email Verifications Table (for pre-request email challenge)
create table if not exists public.office_visit_email_verifications (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  code_hash text not null,
  actor_id uuid references auth.users(id) on delete cascade,
  verified boolean not null default false,
  attempts integer not null default 0,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_office_email_verif_email on public.office_visit_email_verifications(email);
create index if not exists idx_office_email_verif_actor on public.office_visit_email_verifications(actor_id);

-- 9. Row Level Security Policies
alter table public.offices enable row level security;
alter table public.office_personnel enable row level security;
alter table public.office_staff_assignments enable row level security;
alter table public.office_visits enable row level security;
alter table public.office_visit_events enable row level security;
alter table public.office_visit_email_verifications enable row level security;

-- Offices RLS
drop policy if exists offices_public_read on public.offices;
create policy offices_public_read on public.offices
  for select using (active = true or auth.role() = 'service_role' or exists (
    select 1 from public.staff_profiles s
    where s.user_id = auth.uid() and s.active and s.role in ('admin', 'superadmin')
  ));

drop policy if exists offices_admin_manage on public.offices;
create policy offices_admin_manage on public.offices
  for all using (auth.role() = 'service_role' or exists (
    select 1 from public.staff_profiles s
    where s.user_id = auth.uid() and s.active and s.role in ('admin', 'superadmin')
  ));

-- Personnel RLS
drop policy if exists personnel_public_read on public.office_personnel;
create policy personnel_public_read on public.office_personnel
  for select using (active = true or auth.role() = 'service_role' or exists (
    select 1 from public.staff_profiles s
    where s.user_id = auth.uid() and s.active and s.role in ('admin', 'superadmin')
  ) or exists (
    select 1 from public.office_staff_assignments a
    where a.office_id = office_personnel.office_id and a.user_id = auth.uid()
  ));

drop policy if exists personnel_staff_manage on public.office_personnel;
create policy personnel_staff_manage on public.office_personnel
  for all using (auth.role() = 'service_role' or exists (
    select 1 from public.staff_profiles s
    where s.user_id = auth.uid() and s.active and s.role in ('admin', 'superadmin')
  ) or exists (
    select 1 from public.office_staff_assignments a
    where a.office_id = office_personnel.office_id and a.user_id = auth.uid()
  ));

-- Assignments RLS
drop policy if exists assignments_staff_read on public.office_staff_assignments;
create policy assignments_staff_read on public.office_staff_assignments
  for select using (auth.role() = 'service_role' or user_id = auth.uid() or exists (
    select 1 from public.staff_profiles s
    where s.user_id = auth.uid() and s.active and s.role in ('admin', 'superadmin')
  ));

drop policy if exists assignments_admin_manage on public.office_staff_assignments;
create policy assignments_admin_manage on public.office_staff_assignments
  for all using (auth.role() = 'service_role' or exists (
    select 1 from public.staff_profiles s
    where s.user_id = auth.uid() and s.active and s.role in ('admin', 'superadmin')
  ));

-- Visits RLS
drop policy if exists visits_office_staff_read on public.office_visits;
create policy visits_office_staff_read on public.office_visits
  for select using (auth.role() = 'service_role' or exists (
    select 1 from public.office_staff_assignments a
    join public.staff_profiles s on s.user_id = a.user_id
    where a.office_id = office_visits.office_id and a.user_id = auth.uid() and s.active
  ) or exists (
    select 1 from public.staff_profiles s
    where s.user_id = auth.uid() and s.active and s.role in ('admin', 'superadmin')
  ));

drop policy if exists visits_admin_manage on public.office_visits;
create policy visits_admin_manage on public.office_visits
  for all using (auth.role() = 'service_role' or exists (
    select 1 from public.staff_profiles s
    where s.user_id = auth.uid() and s.active and s.role in ('admin', 'superadmin')
  ));

-- Events RLS
drop policy if exists events_office_staff_read on public.office_visit_events;
create policy events_office_staff_read on public.office_visit_events
  for select using (auth.role() = 'service_role' or exists (
    select 1 from public.office_visits v
    join public.office_staff_assignments a on a.office_id = v.office_id
    join public.staff_profiles s on s.user_id = a.user_id
    where v.id = office_visit_events.office_visit_id and a.user_id = auth.uid() and s.active
  ) or exists (
    select 1 from public.staff_profiles s
    where s.user_id = auth.uid() and s.active and s.role in ('admin', 'superadmin')
  ));

-- Table Grants
grant select on public.offices to anon, authenticated, service_role;
grant insert, update, delete on public.offices to service_role;

grant select on public.office_personnel to anon, authenticated, service_role;
grant insert, update, delete on public.office_personnel to service_role;

grant select on public.office_staff_assignments to authenticated, service_role;
grant insert, update, delete on public.office_staff_assignments to service_role;

grant select on public.office_visits to authenticated, service_role;
grant insert, update, delete on public.office_visits to service_role;

grant select on public.office_visit_events to authenticated, service_role;
grant insert, update, delete on public.office_visit_events to service_role;

grant select, insert, update, delete on public.office_visit_email_verifications to service_role;

-- 10. Seed Authentic EARIST Institutional Offices and Initial Personnel
insert into public.offices (id, name, description, active) values
  ('11111111-0000-0000-0000-000000000001', 'Office of the President', 'Executive Office of the University President', true),
  ('11111111-0000-0000-0000-000000000002', 'Office of the Vice President for Academic Affairs', 'Supervision of all academic colleges, curricula, and faculty affairs', true),
  ('11111111-0000-0000-0000-000000000003', 'College of Engineering and Technology', 'Engineering, Computer Studies, and Applied Technologies', true),
  ('11111111-0000-0000-0000-000000000004', 'College of Business Administration', 'Accountancy, Marketing, Management, and Entrepreneurship', true),
  ('11111111-0000-0000-0000-000000000005', 'College of Arts and Sciences', 'Humanities, Natural Sciences, and General Education', true),
  ('11111111-0000-0000-0000-000000000006', 'Office of the University Registrar', 'Student records, enrollment certifications, and scholastic documents', true),
  ('11111111-0000-0000-0000-000000000007', 'Admissions and Testing Office', 'University admissions, entrance examinations, and freshman processing', true),
  ('11111111-0000-0000-0000-000000000008', 'Human Resource Management Office', 'Faculty and administrative personnel records and appointments', true),
  ('11111111-0000-0000-0000-000000000009', 'Security and Safety Office', 'Campus security, visitor egress, and emergency response coordination', true)
on conflict (name) do nothing;

insert into public.office_personnel (id, office_id, name, title, active) values
  ('22222222-0000-0000-0000-000000000001', '11111111-0000-0000-0000-000000000001', 'Dr. Rogelio T. Mamaradlo', 'University President', true),
  ('22222222-0000-0000-0000-000000000002', '11111111-0000-0000-0000-000000000001', 'Atty. Maria Elena Santos', 'Executive Secretary', true),
  ('22222222-0000-0000-0000-000000000003', '11111111-0000-0000-0000-000000000002', 'Dr. Grant B. Javier', 'Vice President for Academic Affairs', true),
  ('22222222-0000-0000-0000-000000000004', '11111111-0000-0000-0000-000000000003', 'Engr. Manuel C. De Guzman', 'Dean, College of Engineering and Technology', true),
  ('22222222-0000-0000-0000-000000000005', '11111111-0000-0000-0000-000000000003', 'Prof. Arlene V. Bautista', 'Department Chairperson, Computer Engineering', true),
  ('22222222-0000-0000-0000-000000000006', '11111111-0000-0000-0000-000000000003', 'Prof. Ferdinand M. Reyes', 'Department Chairperson, Mechanical Engineering', true),
  ('22222222-0000-0000-0000-000000000007', '11111111-0000-0000-0000-000000000004', 'Dr. Marilou P. Cruz', 'Dean, College of Business Administration', true),
  ('22222222-0000-0000-0000-000000000008', '11111111-0000-0000-0000-000000000005', 'Dr. Renato L. Ramos', 'Dean, College of Arts and Sciences', true),
  ('22222222-0000-0000-0000-000000000009', '11111111-0000-0000-0000-000000000006', 'Ms. Corazon T. Del Rosario', 'University Registrar', true),
  ('22222222-0000-0000-0000-000000000010', '11111111-0000-0000-0000-000000000007', 'Mr. Jose Antonio Garcia', 'Admissions Officer', true),
  ('22222222-0000-0000-0000-000000000011', '11111111-0000-0000-0000-000000000008', 'Ms. Yolanda S. Mendoza', 'Director, HRMO', true),
  ('22222222-0000-0000-0000-000000000012', '11111111-0000-0000-0000-000000000009', 'Col. Ernesto P. Mercado', 'Chief of University Security', true)
on conflict do nothing;

-- 11. RPC: api.create_specific_person_visit_request
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
  requested_id_intent_id uuid default null,
  requested_vehicle_photo_intent_id uuid default null
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
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'service role required';
  end if;

  -- Validate office existence and active status
  select * into target_office from public.offices
  where id = requested_office_id and active;
  if not found then
    raise exception using errcode = '22023', message = 'office_not_found_or_inactive';
  end if;

  -- Validate personnel existence, office binding, and active status
  select * into target_personnel from public.office_personnel
  where id = requested_personnel_id and office_id = requested_office_id and active;
  if not found then
    raise exception using errcode = '22023', message = 'personnel_not_found_or_inactive';
  end if;

  -- Validate verified email is present and non-empty
  if requested_email is null or char_length(btrim(requested_email)) < 5 then
    raise exception using errcode = '22023', message = 'verified_email_required';
  end if;

  -- Check for duplicate submission by request_id
  select id, request_id, approval_status, attendance_status
  into new_visit_id, requested_request_id, approval_status, attendance_status
  from public.office_visits
  where request_id = requested_request_id;
  if found then
    return query select new_visit_id, requested_request_id, approval_status, attendance_status;
    return;
  end if;

  -- Consume photo upload intent if supplied
  if requested_photo_intent_id is not null then
    select * into photo_intent from public.upload_intents
    where id = requested_photo_intent_id and purpose = 'visitor_photo'
    for update;
    if not found or photo_intent.consumed_at is not null then
      raise exception using errcode = '22023', message = 'invalid_or_consumed_photo_intent';
    end if;
    update public.upload_intents set consumed_at = now() where id = photo_intent.id;
    resolved_photo_path := photo_intent.storage_path;
  end if;

  -- Consume ID upload intent if supplied
  if requested_id_intent_id is not null then
    select * into id_intent from public.upload_intents
    where id = requested_id_intent_id and purpose = 'id_document'
    for update;
    if not found or id_intent.consumed_at is not null then
      raise exception using errcode = '22023', message = 'invalid_or_consumed_id_intent';
    end if;
    update public.upload_intents set consumed_at = now() where id = id_intent.id;
    resolved_id_path := id_intent.storage_path;
  end if;

  -- Consume vehicle photo upload intent if supplied
  if requested_vehicle_photo_intent_id is not null then
    select * into vehicle_photo_intent from public.upload_intents
    where id = requested_vehicle_photo_intent_id and purpose = 'vehicle_photo'
    for update;
    if not found or vehicle_photo_intent.consumed_at is not null then
      raise exception using errcode = '22023', message = 'invalid_or_consumed_vehicle_photo_intent';
    end if;
    update public.upload_intents set consumed_at = now() where id = vehicle_photo_intent.id;
  end if;

  -- Insert specific-person visit request
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
    visitor_photo_path,
    visitor_id_path,
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
    btrim(requested_first_name),
    nullif(btrim(requested_middle_name), ''),
    btrim(requested_last_name),
    btrim(requested_contact_number),
    lower(btrim(requested_email)),
    true,
    resolved_photo_path,
    resolved_id_path,
    btrim(requested_purpose),
    requested_visit_date,
    requested_arrival_mode,
    requested_vehicle_details,
    requested_address_details,
    requested_photo_intent_id,
    requested_id_intent_id,
    requested_vehicle_photo_intent_id,
    requested_request_id
  )
  returning id into new_visit_id;

  -- Log audit event
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
    requested_request_id,
    'pending'::public.office_approval_status,
    'awaiting_entry'::public.office_attendance_status;
end;
$$;

revoke all on function api.create_specific_person_visit_request(
  uuid, uuid, uuid, uuid, text, text, text, text, text, text, date, text, jsonb, jsonb, uuid, uuid, uuid
) from public, anon, authenticated;

grant execute on function api.create_specific_person_visit_request(
  uuid, uuid, uuid, uuid, text, text, text, text, text, text, date, text, jsonb, jsonb, uuid, uuid, uuid
) to service_role;

-- 12. RPC: api.decide_office_visit
create or replace function api.decide_office_visit(
  requested_actor_id uuid,
  requested_visit_id uuid,
  requested_decision text,
  requested_rejection_reason text default null,
  requested_token_digest text default null,
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
  new_visitor_id uuid;
  new_pass_id uuid;
  new_public_ref uuid;
  v_from timestamptz;
  v_until timestamptz;
  v_full_name text;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'service role required';
  end if;

  if requested_decision not in ('approved', 'rejected') then
    raise exception using errcode = '22023', message = 'invalid_decision';
  end if;

  -- Validate actor role and active status
  select * into actor_profile from public.staff_profiles
  where user_id = requested_actor_id and active;
  if not found then
    raise exception using errcode = '42501', message = 'active_staff_required';
  end if;

  -- Lock visit record
  select * into target_visit from public.office_visits
  where id = requested_visit_id
  for update;
  if not found then
    raise exception using errcode = '22023', message = 'visit_not_found';
  end if;

  -- Validate office assignment (unless admin/superadmin)
  if actor_profile.role not in ('admin', 'superadmin') then
    if not exists (
      select 1 from public.office_staff_assignments a
      where a.office_id = target_visit.office_id and a.user_id = requested_actor_id
    ) then
      raise exception using errcode = '42501', message = 'unauthorized_for_this_office';
    end if;
  end if;

  -- Concurrency check: already decided?
  if target_visit.approval_status <> 'pending'::public.office_approval_status then
    -- Safe idempotency return
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

  -- APPROVAL FLOW: Create canonical visitor and pass
  if requested_token_digest is null or requested_token_digest !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'valid_token_digest_required_for_approval';
  end if;

  v_from := target_visit.visit_date::timestamp at time zone 'Asia/Manila';
  v_until := (target_visit.visit_date + 1)::timestamp at time zone 'Asia/Manila';

  v_full_name := btrim(target_visit.visitor_first_name ||
    case when target_visit.visitor_middle_name is not null and char_length(btrim(target_visit.visitor_middle_name)) > 0
      then ' ' || btrim(target_visit.visitor_middle_name) else '' end ||
    ' ' || target_visit.visitor_last_name);

  insert into public.visitors (
    owner_id,
    source,
    full_name,
    contact_number,
    purpose,
    visit_date,
    photo_storage_path,
    id_storage_path,
    consent_accepted_at
  ) values (
    requested_actor_id,
    'portal'::public.pass_source,
    v_full_name,
    target_visit.visitor_contact_number,
    target_visit.purpose,
    target_visit.visit_date,
    target_visit.visitor_photo_path,
    target_visit.visitor_id_path,
    now()
  )
  returning id into new_visitor_id;

  new_public_ref := gen_random_uuid();

  insert into public.passes (
    visitor_id,
    source,
    status,
    token_digest,
    public_reference,
    valid_from,
    valid_until
  ) values (
    new_visitor_id,
    'portal'::public.pass_source,
    'issued'::public.pass_status,
    decode(requested_token_digest, 'hex'),
    new_public_ref,
    v_from,
    v_until
  )
  returning id into new_pass_id;

  -- Link vehicle declaration if applicable
  if target_visit.arrival_mode = 'vehicle' and target_visit.vehicle_details is not null then
    insert into public.visit_vehicle_declarations (
      pass_id,
      visitor_id,
      vehicle_type,
      plate_number,
      plate_key,
      color,
      make_model
    ) values (
      new_pass_id,
      new_visitor_id,
      coalesce(target_visit.vehicle_details->>'vehicleType', 'Motorcycle'),
      coalesce(target_visit.vehicle_details->>'plateNumber', 'N/A'),
      nullif(upper(regexp_replace(coalesce(target_visit.vehicle_details->>'plateNumber', ''), '[^A-Za-z0-9]', '', 'g')), ''),
      coalesce(target_visit.vehicle_details->>'color', 'Unknown'),
      coalesce(target_visit.vehicle_details->>'makeModel', 'Standard')
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

  return query select
    true,
    'approved'::text,
    new_pass_id,
    new_public_ref,
    v_from,
    v_until,
    'Visit approved and QR pass issued.'::text;
end;
$$;

revoke all on function api.decide_office_visit(uuid, uuid, text, text, text, uuid) from public, anon, authenticated;
grant execute on function api.decide_office_visit(uuid, uuid, text, text, text, uuid) to service_role;

-- 13. RPC: api.confirm_office_arrival
create or replace function api.confirm_office_arrival(
  requested_actor_id uuid,
  requested_visit_id uuid,
  requested_request_id uuid default gen_random_uuid()
)
returns table (
  ok boolean,
  attendance_status public.office_attendance_status,
  confirmed_at timestamptz,
  message text
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  target_visit public.office_visits%rowtype;
  target_pass public.passes%rowtype;
  actor_profile public.staff_profiles%rowtype;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'service role required';
  end if;

  -- Validate actor role and active status
  select * into actor_profile from public.staff_profiles
  where user_id = requested_actor_id and active;
  if not found then
    raise exception using errcode = '42501', message = 'active_staff_required';
  end if;

  -- Lock visit record
  select * into target_visit from public.office_visits
  where id = requested_visit_id
  for update;
  if not found then
    raise exception using errcode = '22023', message = 'visit_not_found';
  end if;

  -- Validate office assignment (unless admin/superadmin)
  if actor_profile.role not in ('admin', 'superadmin') then
    if not exists (
      select 1 from public.office_staff_assignments a
      where a.office_id = target_visit.office_id and a.user_id = requested_actor_id
    ) then
      raise exception using errcode = '42501', message = 'unauthorized_for_this_office';
    end if;
  end if;

  -- Idempotency: if already confirmed, safely return success
  if target_visit.attendance_status = 'confirmed'::public.office_attendance_status then
    return query select true, target_visit.attendance_status, target_visit.confirmed_at, 'Arrival already confirmed.'::text;
    return;
  end if;

  -- CRITICAL INVARIANT: Visitor can ONLY be confirmed after canonical gate lifecycle records 'inside'!
  if target_visit.pass_id is null then
    raise exception using errcode = '22023', message = 'no_pass_associated_with_visit';
  end if;

  select * into target_pass from public.passes
  where id = target_visit.pass_id;
  if not found then
    raise exception using errcode = '22023', message = 'pass_not_found';
  end if;

  if target_pass.status <> 'inside'::public.pass_status then
    raise exception using errcode = '22023', message = 'visitor_must_be_inside_campus';
  end if;

  -- Update attendance status
  update public.office_visits set
    attendance_status = 'confirmed'::public.office_attendance_status,
    confirmed_at = now(),
    confirmed_by = requested_actor_id,
    updated_at = now()
  where id = target_visit.id;

  insert into public.office_visit_events (
    office_visit_id,
    event_type,
    actor_id,
    actor_role,
    metadata
  ) values (
    target_visit.id,
    'arrival_confirmed',
    requested_actor_id,
    actor_profile.role::text,
    jsonb_build_object('confirmed_at', now(), 'pass_id', target_visit.pass_id)
  );

  return query select true, 'confirmed'::public.office_attendance_status, now(), 'Office arrival successfully confirmed.'::text;
end;
$$;

revoke all on function api.confirm_office_arrival(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function api.confirm_office_arrival(uuid, uuid, uuid) to service_role;

-- 14. Update api.scan_pass with Office Attendance Integration & Exit Exception Handling
create or replace function api.scan_pass(
  requested_actor_id uuid,
  requested_token_digest text,
  requested_mode public.device_type,
  requested_request_id uuid
)
returns table (
  ok boolean,
  result_status text,
  code text,
  message text
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  scanner public.devices%rowtype;
  target public.passes%rowtype;
  target_decl public.visit_vehicle_declarations%rowtype;
  target_office_visit public.office_visits%rowtype;
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
      -- Check vehicle inside collision
      select * into target_decl from public.visit_vehicle_declarations
      where visit_vehicle_declarations.pass_id = target.id;

      if found and target_decl.plate_key is not null then
        if exists (
          select 1 from public.visit_vehicle_declarations d
          where d.plate_key = target_decl.plate_key
            and coalesce(d.entry_scanned_at, d.entry_recorded_at) is not null
            and coalesce(d.exit_scanned_at, d.exit_recorded_at) is null
            and d.pass_id <> target.id
        ) then
          failure_code := 'vehicle_already_inside';
          failure_message := 'Vehicle entry could not be recorded because this plate is already marked inside campus. Please verify the vehicle and follow campus security procedure.';
          insert into public.visit_events(pass_id, visitor_id, event, reason, device_id, gate, request_id)
          values (target.id, target.visitor_id, 'invalid_scan'::public.visit_event_type, failure_message, scanner.user_id, scanner.gate, requested_request_id)
          on conflict (request_id, event) do nothing;
          return query select false, target.status::text, failure_code, failure_message;
          return;
        end if;
      end if;

      if target.source = 'portal'::public.pass_source then
        if found and target_decl.plate_key is not null then
          begin
            update public.visit_vehicle_declarations set
              entry_recorded_at = coalesce(entry_recorded_at, now()),
              entry_scanned_at = coalesce(entry_scanned_at, now())
            where visit_vehicle_declarations.pass_id = target.id;
          exception when unique_violation then
            failure_code := 'vehicle_already_inside';
            failure_message := 'Vehicle entry could not be recorded because this plate is already marked inside campus. Please verify the vehicle and follow campus security procedure.';
            insert into public.visit_events(pass_id, visitor_id, event, reason, device_id, gate, request_id)
            values (target.id, target.visitor_id, 'invalid_scan'::public.visit_event_type, failure_message, scanner.user_id, scanner.gate, requested_request_id)
            on conflict (request_id, event) do nothing;
            return query select false, target.status::text, failure_code, failure_message;
            return;
          end;
        end if;

        update public.passes set
          status = 'inside'::public.pass_status,
          entry_scanned_at = now(),
          time_in = now(),
          entry_device_id = scanner.user_id,
          gate = scanner.gate,
          updated_at = now(),
          version = version + 1
        where id = target.id;

        insert into public.visit_events(pass_id, visitor_id, event, device_id, gate, request_id)
        values (target.id, target.visitor_id, 'scan_entry'::public.visit_event_type, scanner.user_id, scanner.gate, requested_request_id)
        on conflict (request_id, event) do nothing;

        -- Update linked office visits to awaiting_office_confirmation
        update public.office_visits set
          attendance_status = 'awaiting_office_confirmation'::public.office_attendance_status,
          updated_at = now()
        where pass_id = target.id and attendance_status = 'awaiting_entry'::public.office_attendance_status;

        insert into public.office_visit_events (office_visit_id, event_type, actor_id, actor_role, metadata)
        select ov.id, 'gate_entry', scanner.user_id, 'device', jsonb_build_object('gate', scanner.gate)
        from public.office_visits ov
        where ov.pass_id = target.id;

        return query select true, 'inside'::text, null::text, 'Entry recorded. Please proceed through the normal security inspection.'::text;
        return;
      else
        -- Kiosk passes retain pending guard review
        if found and target_decl.plate_key is not null then
          begin
            update public.visit_vehicle_declarations set
              entry_recorded_at = coalesce(entry_recorded_at, now()),
              entry_scanned_at = coalesce(entry_scanned_at, now())
            where visit_vehicle_declarations.pass_id = target.id;
          exception when unique_violation then
            failure_code := 'vehicle_already_inside';
            failure_message := 'Vehicle entry could not be recorded because this plate is already marked inside campus. Please verify the vehicle and follow campus security procedure.';
            insert into public.visit_events(pass_id, visitor_id, event, reason, device_id, gate, request_id)
            values (target.id, target.visitor_id, 'invalid_scan'::public.visit_event_type, failure_message, scanner.user_id, scanner.gate, requested_request_id)
            on conflict (request_id, event) do nothing;
            return query select false, target.status::text, failure_code, failure_message;
            return;
          end;
        end if;

        update public.passes set
          status = 'pending'::public.pass_status,
          entry_scanned_at = now(),
          entry_device_id = scanner.user_id,
          gate = scanner.gate,
          updated_at = now(),
          version = version + 1
        where id = target.id;

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
    if target.gate is distinct from scanner.gate then
      failure_code := 'wrong_gate';
      failure_message := 'Use the exit scanner assigned to the entry gate';
      insert into public.visit_events(pass_id, visitor_id, event, reason, device_id, gate, request_id)
      values (target.id, target.visitor_id, 'invalid_scan'::public.visit_event_type, failure_message, scanner.user_id, scanner.gate, requested_request_id)
      on conflict (request_id, event) do nothing;
      return query select false, target.status::text, failure_code, failure_message;
      return;
    else
      -- Transition pass to exited
      update public.passes set
        status = 'exited'::public.pass_status,
        time_out = now(),
        exit_device_id = scanner.user_id,
        updated_at = now(),
        version = version + 1
      where id = target.id;

      update public.visit_vehicle_declarations set
        exit_recorded_at = coalesce(exit_recorded_at, now()),
        exit_scanned_at = coalesce(exit_scanned_at, now())
      where visit_vehicle_declarations.pass_id = target.id;

      insert into public.visit_events(pass_id, visitor_id, event, device_id, gate, request_id)
      values (target.id, target.visitor_id, 'scan_exit'::public.visit_event_type, scanner.user_id, scanner.gate, requested_request_id)
      on conflict (request_id, event) do nothing;

      -- Check office visit attendance status
      select * into target_office_visit from public.office_visits
      where pass_id = target.id;

      if found then
        if target_office_visit.attendance_status = 'confirmed'::public.office_attendance_status then
          update public.office_visits set
            attendance_status = 'completed'::public.office_attendance_status,
            updated_at = now()
          where id = target_office_visit.id;

          insert into public.office_visit_events (office_visit_id, event_type, actor_id, actor_role, metadata)
          values (target_office_visit.id, 'gate_exit_confirmed', scanner.user_id, 'device', jsonb_build_object('gate', scanner.gate));

          return query select true, 'exited'::text, null::text, 'Pass successfully exited.'::text;
          return;
        else
          -- Office confirmation is missing.
          -- CRITICAL SAFETY INVARIANT: Never physically block or prevent a person from leaving campus!
          -- Pass transitions to exited, and office attendance status becomes exited_unconfirmed.
          update public.office_visits set
            attendance_status = 'exited_unconfirmed'::public.office_attendance_status,
            updated_at = now()
          where id = target_office_visit.id;

          insert into public.office_visit_events (office_visit_id, event_type, actor_id, actor_role, metadata)
          values (target_office_visit.id, 'gate_exit_unconfirmed', scanner.user_id, 'device', jsonb_build_object('gate', scanner.gate));

          insert into public.visit_events(pass_id, visitor_id, event, reason, device_id, gate, request_id)
          values (target.id, target.visitor_id, 'invalid_scan'::public.visit_event_type, 'Pass exited without office attendance confirmation', scanner.user_id, scanner.gate, requested_request_id)
          on conflict (request_id, event) do nothing;

          return query select true, 'exited'::text, 'office_unconfirmed'::text, 'Pass exited without office confirmation.'::text;
          return;
        end if;
      else
        return query select true, 'exited'::text, null::text, 'Pass successfully exited.'::text;
        return;
      end if;
    end if;
  else
    if target.status in ('expired'::public.pass_status, 'rejected'::public.pass_status) then
      failure_code := target.status::text; failure_message := 'Pass is no longer valid (' || target.status::text || ')';
    elsif target.status = 'exited'::public.pass_status then
      failure_code := 'already_exited'; failure_message := 'Pass has already been used to exit';
    elsif target.status = 'inside'::public.pass_status and requested_mode = 'entry'::public.device_type then
      failure_code := 'already_inside'; failure_message := 'Pass is already marked inside';
    elsif target.status = 'issued'::public.pass_status and requested_mode = 'exit'::public.device_type then
      failure_code := 'not_entered'; failure_message := 'Pass has not been scanned at entry';
    elsif target.status = 'pending'::public.pass_status then
      failure_code := 'pending'; failure_message := 'Pass is pending approval';
    else
      failure_code := 'invalid_state'; failure_message := 'Scan not valid in current pass state';
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

-- 15. RPC: api.record_general_office_visit
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
  target_decl public.visit_vehicle_declarations%rowtype;
  new_visit_id uuid;
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

  select * into target_decl from public.visit_vehicle_declarations
  where pass_id = target_pass.id;

  -- Idempotency check
  select id, public.office_visits.attendance_status into new_visit_id, attendance_status
  from public.office_visits
  where request_id = requested_request_id or pass_id = requested_pass_id;
  if found then
    return query select new_visit_id, attendance_status;
    return;
  end if;

  insert into public.office_visits (
    visit_type,
    office_id,
    approval_status,
    attendance_status,
    visitor_id,
    pass_id,
    visitor_first_name,
    visitor_middle_name,
    visitor_last_name,
    visitor_contact_number,
    purpose,
    visit_date,
    arrival_mode,
    vehicle_details,
    address_details,
    request_id
  ) values (
    'general',
    requested_office_id,
    'not_required'::public.office_approval_status,
    'awaiting_entry'::public.office_attendance_status,
    target_visitor.id,
    target_pass.id,
    target_visitor.full_name,
    null,
    target_visitor.full_name,
    target_visitor.contact_number,
    target_visitor.purpose,
    target_visitor.visit_date,
    case when target_decl.id is not null then 'vehicle' else 'no_vehicle' end,
    case when target_decl.id is not null then jsonb_build_object(
      'vehicleType', target_decl.vehicle_type,
      'plateNumber', target_decl.plate_number,
      'color', target_decl.color,
      'makeModel', target_decl.make_model
    ) else null end,
    jsonb_build_object(
      'homeAddress', target_visitor.home_address,
      'regionCode', target_visitor.psgc_region_code,
      'cityCode', target_visitor.psgc_city_code,
      'barangayCode', target_visitor.psgc_barangay_code
    ),
    requested_request_id
  )
  returning id into new_visit_id;

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
    jsonb_build_object('office_id', requested_office_id, 'visit_type', 'general')
  );

  return query select new_visit_id, 'awaiting_entry'::public.office_attendance_status;
end;
$$;

revoke all on function api.record_general_office_visit(uuid, uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function api.record_general_office_visit(uuid, uuid, uuid, uuid) to service_role;
