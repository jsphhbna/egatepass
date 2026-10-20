-- E-GatePass canonical Supabase schema.
-- This migration is additive and contains no legacy Firebase data migration.

create extension if not exists pgcrypto with schema extensions;
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

do $$ begin
  create type public.staff_role as enum ('guard', 'admin', 'superadmin');
exception when duplicate_object then null; end $$;
do $$ begin
  create type public.device_type as enum ('kiosk', 'entry', 'exit');
exception when duplicate_object then null; end $$;
do $$ begin
  create type public.device_status as enum ('active', 'revoked');
exception when duplicate_object then null; end $$;
do $$ begin
  create type public.pass_source as enum ('portal', 'kiosk');
exception when duplicate_object then null; end $$;
do $$ begin
  create type public.pass_status as enum ('issued', 'pending', 'inside', 'rejected', 'exited', 'expired');
exception when duplicate_object then null; end $$;
do $$ begin
  create type public.evidence_kind as enum ('photo', 'id');
exception when duplicate_object then null; end $$;
do $$ begin
  create type public.upload_intent_status as enum ('pending', 'uploaded', 'claimed', 'expired');
exception when duplicate_object then null; end $$;
do $$ begin
  create type public.peak_mode_scope as enum ('off', 'portal', 'kiosk', 'both');
exception when duplicate_object then null; end $$;
do $$ begin
  create type public.visit_event_type as enum ('invalid_scan', 'scan_entry', 'approved', 'rejected', 'scan_exit');
exception when duplicate_object then null; end $$;
do $$ begin
  create type public.reconciliation_status as enum ('pending', 'resolved', 'abandoned');
exception when duplicate_object then null; end $$;

create table if not exists public.staff_profiles (
  user_id uuid primary key references auth.users(id) on delete restrict,
  display_name text not null check (char_length(btrim(display_name)) between 2 and 120),
  role public.staff_role not null,
  active boolean not null default true,
  must_change_password boolean not null default false,
  privacy_accepted_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.devices (
  user_id uuid primary key references auth.users(id) on delete restrict,
  alias text not null check (alias = lower(alias) and alias ~ '^[a-z0-9][a-z0-9-]{2,62}$'),
  name text not null check (char_length(btrim(name)) between 2 and 120),
  type public.device_type not null,
  gate text not null check (char_length(btrim(gate)) between 1 and 80),
  status public.device_status not null default 'active',
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_seen_at timestamptz
);

create unique index if not exists devices_alias_unique on public.devices (lower(alias));
create index if not exists devices_type_status_idx on public.devices (type, status);

create table if not exists public.app_settings (
  singleton boolean primary key default true check (singleton),
  working_hours_start time not null default time '08:00',
  working_hours_end time not null default time '17:00',
  timezone text not null default 'Asia/Manila' check (timezone = 'Asia/Manila'),
  scheduling_days_ahead smallint not null default 30 check (scheduling_days_ahead between 0 and 90),
  peak_mode public.peak_mode_scope not null default 'off',
  visit_purposes jsonb not null default '[{"label":"Meeting","requiresDetails":false,"detailPrompt":""}]'::jsonb check (jsonb_typeof(visit_purposes) = 'array'),
  rejection_reasons jsonb not null default '["Invalid ID","No prior appointment","Underage","Refused inspection"]'::jsonb check (jsonb_typeof(rejection_reasons) = 'array'),
  image_retention_days smallint not null default 7 check (image_retention_days between 1 and 365),
  visitor_retention_days smallint not null default 30 check (visitor_retention_days between 1 and 730),
  audit_retention_days smallint not null default 365 check (audit_retention_days between 30 and 3650),
  reconciliation_retention_days smallint not null default 90 check (reconciliation_retention_days between 30 and 3650),
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now(),
  check (working_hours_start < working_hours_end)
);

insert into public.app_settings (singleton) values (true) on conflict (singleton) do nothing;

create table if not exists public.visitors (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete restrict,
  source public.pass_source not null,
  created_by_device_id uuid references public.devices(user_id) on delete restrict,
  full_name text not null check (char_length(btrim(full_name)) between 2 and 160),
  contact_number text not null check (char_length(btrim(contact_number)) between 7 and 32),
  email text check (email is null or char_length(email) between 3 and 320),
  purpose text not null check (char_length(btrim(purpose)) between 2 and 500),
  visit_date date not null,
  consent_accepted_at timestamptz not null,
  created_at timestamptz not null default now(),
  anonymized_at timestamptz,
  check ((source = 'portal' and created_by_device_id is null) or (source = 'kiosk' and created_by_device_id is not null))
);

create index if not exists visitors_owner_created_idx on public.visitors (owner_id, created_at desc);
create index if not exists visitors_visit_date_idx on public.visitors (visit_date, created_at desc);

create table if not exists public.upload_intents (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  source public.pass_source not null,
  kind public.evidence_kind not null,
  bucket_id text not null check (bucket_id in ('visitor-photos', 'visitor-ids')),
  object_path text not null unique,
  content_type text not null check (content_type in ('image/jpeg', 'image/png', 'image/webp')),
  max_bytes integer not null default 5242880 check (max_bytes between 1 and 5242880),
  status public.upload_intent_status not null default 'pending',
  expires_at timestamptz not null,
  claimed_at timestamptz,
  visitor_id uuid references public.visitors(id) on delete restrict,
  created_at timestamptz not null default now(),
  check ((kind = 'photo' and bucket_id = 'visitor-photos') or (kind = 'id' and bucket_id = 'visitor-ids')),
  check ((status = 'claimed' and claimed_at is not null and visitor_id is not null) or status <> 'claimed')
);

create index if not exists upload_intents_owner_status_idx on public.upload_intents (owner_id, status, expires_at);

create table if not exists public.visitor_evidence (
  id uuid primary key default gen_random_uuid(),
  visitor_id uuid not null references public.visitors(id) on delete restrict,
  upload_intent_id uuid not null unique references public.upload_intents(id) on delete restrict,
  kind public.evidence_kind not null,
  bucket_id text not null check (bucket_id in ('visitor-photos', 'visitor-ids')),
  object_path text not null unique,
  content_type text not null check (content_type in ('image/jpeg', 'image/png', 'image/webp')),
  byte_size integer not null check (byte_size between 1 and 5242880),
  sha256_hex text not null check (sha256_hex ~ '^[0-9a-f]{64}$'),
  verified_at timestamptz not null,
  expires_at timestamptz not null,
  purged_at timestamptz,
  created_at timestamptz not null default now(),
  unique (visitor_id, kind),
  check ((kind = 'photo' and bucket_id = 'visitor-photos') or (kind = 'id' and bucket_id = 'visitor-ids'))
);

create index if not exists visitor_evidence_expiry_idx on public.visitor_evidence (expires_at) where purged_at is null;

create table if not exists public.passes (
  id uuid primary key default gen_random_uuid(),
  visitor_id uuid not null unique references public.visitors(id) on delete restrict,
  public_reference uuid not null default gen_random_uuid() unique,
  token_digest bytea not null unique check (octet_length(token_digest) = 32),
  source public.pass_source not null,
  status public.pass_status not null default 'issued',
  valid_from timestamptz not null,
  valid_until timestamptz not null,
  issued_at timestamptz not null default now(),
  entry_scanned_at timestamptz,
  decided_at timestamptz,
  time_in timestamptz,
  time_out timestamptz,
  entry_device_id uuid references public.devices(user_id) on delete restrict,
  exit_device_id uuid references public.devices(user_id) on delete restrict,
  decided_by uuid references public.staff_profiles(user_id) on delete restrict,
  rejection_reason text,
  gate text,
  version integer not null default 1 check (version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (valid_from < valid_until),
  check ((status = 'rejected' and rejection_reason is not null) or (status <> 'rejected' and rejection_reason is null))
);

create index if not exists passes_status_validity_idx on public.passes (status, valid_until);
create index if not exists passes_pending_idx on public.passes (entry_scanned_at) where status = 'pending';

create table if not exists public.visit_events (
  id bigint generated always as identity primary key,
  pass_id uuid references public.passes(id) on delete restrict,
  visitor_id uuid references public.visitors(id) on delete restrict,
  event public.visit_event_type not null,
  reason text,
  device_id uuid references public.devices(user_id) on delete restrict,
  gate text,
  guard_id uuid references public.staff_profiles(user_id) on delete restrict,
  occurred_at timestamptz not null default now(),
  request_id uuid not null,
  details jsonb not null default '{}'::jsonb check (jsonb_typeof(details) = 'object')
);

create unique index if not exists visit_events_request_event_unique on public.visit_events (request_id, event);
create index if not exists visit_events_pass_time_idx on public.visit_events (pass_id, occurred_at desc);
create index if not exists visit_events_time_idx on public.visit_events (occurred_at desc);

create table if not exists public.audit_events (
  id bigint generated always as identity primary key,
  actor_id uuid references auth.users(id) on delete set null,
  actor_kind text not null check (actor_kind in ('staff', 'device', 'system')),
  actor_role text,
  action text not null check (char_length(action) between 2 and 120),
  target_type text not null check (char_length(target_type) between 2 and 80),
  target_id text,
  before_state jsonb,
  after_state jsonb,
  request_id uuid,
  outcome text not null default 'success' check (outcome in ('success', 'denied', 'partial', 'failure')),
  occurred_at timestamptz not null default now(),
  check (before_state is null or jsonb_typeof(before_state) = 'object'),
  check (after_state is null or jsonb_typeof(after_state) = 'object')
);

create index if not exists audit_events_time_idx on public.audit_events (occurred_at desc);
create index if not exists audit_events_action_time_idx on public.audit_events (action, occurred_at desc);

create table if not exists public.reconciliation_tasks (
  id uuid primary key default gen_random_uuid(),
  operation text not null check (char_length(operation) between 2 and 120),
  status public.reconciliation_status not null default 'pending',
  reference_type text not null,
  reference_id text,
  safe_context jsonb not null default '{}'::jsonb check (jsonb_typeof(safe_context) = 'object'),
  last_error_code text,
  attempts integer not null default 0 check (attempts >= 0),
  next_attempt_at timestamptz,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((status = 'resolved' and resolved_at is not null) or status <> 'resolved')
);

create index if not exists reconciliation_pending_idx on public.reconciliation_tasks (next_attempt_at, created_at) where status = 'pending';

create table if not exists public.incident_holds (
  id uuid primary key default gen_random_uuid(),
  visitor_id uuid references public.visitors(id) on delete restrict,
  pass_id uuid references public.passes(id) on delete restrict,
  reason text not null check (char_length(btrim(reason)) between 5 and 500),
  active boolean not null default true,
  created_by uuid not null references public.staff_profiles(user_id) on delete restrict,
  created_at timestamptz not null default now(),
  released_by uuid references public.staff_profiles(user_id) on delete restrict,
  released_at timestamptz,
  check (visitor_id is not null or pass_id is not null),
  check ((active and released_at is null and released_by is null) or (not active and released_at is not null and released_by is not null))
);

create unique index if not exists incident_holds_active_visitor_unique on public.incident_holds (visitor_id) where active and visitor_id is not null;
create unique index if not exists incident_holds_active_pass_unique on public.incident_holds (pass_id) where active and pass_id is not null;

create table if not exists public.rate_limit_buckets (
  key_digest bytea not null,
  action text not null,
  window_started_at timestamptz not null,
  request_count integer not null default 0 check (request_count >= 0),
  expires_at timestamptz not null,
  primary key (key_digest, action, window_started_at)
);

create index if not exists rate_limit_expiry_idx on public.rate_limit_buckets (expires_at);

create table if not exists public.maintenance_state (
  job_name text primary key,
  cursor_value text,
  last_started_at timestamptz,
  last_completed_at timestamptz,
  last_outcome text check (last_outcome in ('success', 'partial', 'failure')),
  updated_at timestamptz not null default now()
);

create or replace function private.set_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists staff_profiles_set_updated_at on public.staff_profiles;
create trigger staff_profiles_set_updated_at before update on public.staff_profiles
for each row execute function private.set_updated_at();
drop trigger if exists devices_set_updated_at on public.devices;
create trigger devices_set_updated_at before update on public.devices
for each row execute function private.set_updated_at();
drop trigger if exists passes_set_updated_at on public.passes;
create trigger passes_set_updated_at before update on public.passes
for each row execute function private.set_updated_at();
drop trigger if exists reconciliation_set_updated_at on public.reconciliation_tasks;
create trigger reconciliation_set_updated_at before update on public.reconciliation_tasks
for each row execute function private.set_updated_at();

create or replace function private.enforce_pass_source()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  visitor_source public.pass_source;
begin
  select v.source into visitor_source from public.visitors v where v.id = new.visitor_id;
  if visitor_source is null or visitor_source <> new.source then
    raise exception using errcode = '23514', message = 'pass source must match visitor source';
  end if;
  return new;
end;
$$;

drop trigger if exists passes_enforce_source on public.passes;
create trigger passes_enforce_source before insert or update of visitor_id, source on public.passes
for each row execute function private.enforce_pass_source();

create or replace function private.protect_last_superadmin()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  removes_active_superadmin boolean;
  remaining_count integer;
begin
  if tg_op = 'DELETE' then
    removes_active_superadmin := old.role = 'superadmin'::public.staff_role and old.active;
  else
    removes_active_superadmin := old.role = 'superadmin'::public.staff_role
      and old.active
      and (new.role <> 'superadmin'::public.staff_role or not new.active);
  end if;

  if removes_active_superadmin then
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('egatepass:last-active-superadmin'));
    select count(*) into remaining_count
    from public.staff_profiles sp
    where sp.role = 'superadmin'::public.staff_role and sp.active and sp.user_id <> old.user_id;
    if remaining_count < 1 then
      raise exception using errcode = '23514', message = 'cannot remove the last active super admin';
    end if;
  end if;

  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

drop trigger if exists staff_profiles_protect_last_superadmin on public.staff_profiles;
create trigger staff_profiles_protect_last_superadmin
before update of role, active or delete on public.staff_profiles
for each row execute function private.protect_last_superadmin();

create or replace function private.bootstrap_super_admin(target_user_id uuid, target_display_name text)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if current_user not in ('postgres', 'supabase_admin') then
    raise exception using errcode = '42501', message = 'bootstrap requires an authorized database operator';
  end if;
  if not exists (select 1 from auth.users u where u.id = target_user_id) then
    raise exception using errcode = '23503', message = 'Auth user does not exist';
  end if;
  if exists (select 1 from public.staff_profiles) then
    raise exception using errcode = '23514', message = 'bootstrap is allowed only before the first staff profile';
  end if;

  insert into public.staff_profiles (user_id, display_name, role, active, must_change_password, created_by)
  values (target_user_id, target_display_name, 'superadmin', true, true, target_user_id);
  insert into public.audit_events (actor_id, actor_kind, actor_role, action, target_type, target_id, after_state)
  values (target_user_id, 'system', 'bootstrap', 'superadmin.bootstrap', 'staff_profile', target_user_id::text,
    jsonb_build_object('role', 'superadmin', 'active', true, 'mustChangePassword', true));
end;
$$;

revoke all on function private.bootstrap_super_admin(uuid, text) from public, anon, authenticated;
revoke all on function private.set_updated_at() from public, anon, authenticated;
revoke all on function private.enforce_pass_source() from public, anon, authenticated;
revoke all on function private.protect_last_superadmin() from public, anon, authenticated;
