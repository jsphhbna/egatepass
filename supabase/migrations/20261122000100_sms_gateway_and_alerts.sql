-- ============================================================================
-- Migration: 20261122000100_sms_gateway_and_alerts.sql
-- Description: Adds sms_logs / sms_log tables, emergency inbound reports,
--              app_settings SMS template columns, and secure RPCs.
-- ============================================================================

-- 1. Create public.sms_logs table (and sms_log view for schema compatibility)
create table if not exists public.sms_logs (
  id uuid primary key default gen_random_uuid(),
  direction text not null check (direction in ('inbound', 'outbound')),
  recipient_masked text not null,
  sender_masked text,
  message_body text not null,
  purpose text not null check (purpose in (
    'emergency_roll_call',
    'overdue_exit_warning',
    'auth_code',
    'inbound_message',
    'manual_test',
    'status_update'
  )),
  status text not null check (status in ('queued', 'sent', 'delivered', 'failed', 'received')),
  external_id text,
  error_detail text,
  actor_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

-- Index for timeline and purpose filtering
create index if not exists idx_sms_logs_created_at on public.sms_logs (created_at desc);
create index if not exists idx_sms_logs_purpose on public.sms_logs (purpose);
create index if not exists idx_sms_logs_direction on public.sms_logs (direction);

-- Compatibility view so both sms_log and sms_logs resolve seamlessly
create or replace view public.sms_log as
  select * from public.sms_logs;

-- Enable RLS
alter table public.sms_logs enable row level security;

-- Policy: Only staff (admin, superadmin) and service_role can read SMS logs
create policy sms_logs_staff_select_policy on public.sms_logs
  for select
  to authenticated
  using (
    exists (
      select 1 from public.staff_profiles p
      where p.user_id = auth.uid()
        and p.role in ('admin', 'superadmin')
        and p.active = true
    )
  );

-- Policy: Service role has full access
create policy sms_logs_service_role_policy on public.sms_logs
  for all
  to service_role
  using (true)
  with check (true);

-- 2. Create emergency_inbound_reports table for deduplicated inbound SOS/telemetry
create table if not exists public.emergency_inbound_reports (
  id uuid primary key default gen_random_uuid(),
  msg_id text not null unique,
  sender_phone_masked text not null,
  sender_phone_e164 text not null,
  account_verified boolean not null default false,
  report_type text not null,
  latitude double precision,
  longitude double precision,
  reported_at timestamptz not null default now(),
  raw_message text not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_emergency_inbound_reports_created on public.emergency_inbound_reports (created_at desc);
create index if not exists idx_emergency_inbound_reports_phone on public.emergency_inbound_reports (sender_phone_e164);

alter table public.emergency_inbound_reports enable row level security;

create policy emergency_reports_staff_select on public.emergency_inbound_reports
  for select
  to authenticated
  using (
    exists (
      select 1 from public.staff_profiles p
      where p.user_id = auth.uid()
        and p.role in ('admin', 'superadmin')
        and p.active = true
    )
  );

create policy emergency_reports_service_all on public.emergency_inbound_reports
  for all
  to service_role
  using (true)
  with check (true);

-- 3. Add SMS Gateway & Alert Columns to app_settings
alter table public.app_settings
  add column if not exists sms_emergency_templates jsonb default '[
    {"id":"evacuation","title":"Campus Evacuation","body":"EMERGENCY: EARIST campus evacuation in progress. Please exit calmly via the nearest gate."},
    {"id":"lockdown","title":"Security Lockdown","body":"SECURITY ALERT: EARIST campus is on lockdown. Remain in your current location until security clears the area."},
    {"id":"weather","title":"Weather Dismissal","body":"ADVISORY: Campus activities are suspended due to severe weather. Please proceed to the exit gate to scan out."},
    {"id":"general","title":"General Security Notice","body":"SECURITY NOTICE: Please report to the nearest campus security station or exit immediately."}
  ]'::jsonb,
  add column if not exists sms_overdue_warning_template text default 'EARIST E-GatePass Notice: Campus visiting hours have ended (5:00 PM). If you have completed your visit, please proceed to the exit gate to scan your exit pass.',
  add column if not exists sms_overdue_warning_enabled boolean default false,
  add column if not exists sms_daily_cap integer default 500;

-- 4. Secure RPC: api.get_emergency_sms_recipients
-- Returns active visitors currently inside the campus for emergency broadcast
create or replace function api.get_emergency_sms_recipients()
returns table (
  pass_id uuid,
  visitor_name text,
  contact_number text,
  time_in timestamptz,
  gate text
)
language plpgsql
set search_path = public, pg_catalog
as $$
declare
  v_caller_role text;
begin
  -- Validate caller is active admin or superadmin
  select p.role::text into v_caller_role
  from public.staff_profiles p
  where p.user_id = auth.uid()
    and p.active = true;

  if v_caller_role is null or v_caller_role not in ('admin', 'superadmin') then
    raise exception 'unauthorized_staff_action' using errcode = '42501';
  end if;

  return query
  select
    p.id as pass_id,
    v.full_name as visitor_name,
    v.contact_number as contact_number,
    p.entry_scanned_at as time_in,
    p.gate as gate
  from public.passes p
  inner join public.visitors v on v.id = p.visitor_id
  where p.status = 'inside'
    and v.contact_number is not null
    and char_length(btrim(v.contact_number)) >= 7
  order by p.entry_scanned_at desc;
end;
$$;

revoke all on function api.get_emergency_sms_recipients() from public, anon;
grant execute on function api.get_emergency_sms_recipients() to authenticated, service_role;

-- 5. Secure RPC: api.get_overdue_campus_visitors
-- Returns visitors currently inside campus whose valid_until has passed
create or replace function api.get_overdue_campus_visitors()
returns table (
  pass_id uuid,
  visitor_name text,
  contact_number text,
  valid_until timestamptz,
  time_in timestamptz,
  gate text
)
language plpgsql
set search_path = public, pg_catalog
as $$
declare
  v_caller_role text;
begin
  select p.role::text into v_caller_role
  from public.staff_profiles p
  where p.user_id = auth.uid()
    and p.active = true;

  if v_caller_role is null or v_caller_role not in ('admin', 'superadmin') then
    raise exception 'unauthorized_staff_action' using errcode = '42501';
  end if;

  return query
  select
    p.id as pass_id,
    v.full_name as visitor_name,
    v.contact_number as contact_number,
    p.valid_until as valid_until,
    p.entry_scanned_at as time_in,
    p.gate as gate
  from public.passes p
  inner join public.visitors v on v.id = p.visitor_id
  where p.status = 'inside'
    and p.valid_until < now()
    and v.contact_number is not null
    and char_length(btrim(v.contact_number)) >= 7
  order by p.valid_until asc;
end;
$$;

revoke all on function api.get_overdue_campus_visitors() from public, anon;
grant execute on function api.get_overdue_campus_visitors() to authenticated, service_role;

-- 6. Secure RPC: api.record_inbound_sms
-- Files an incoming SMS record, verifies account existence, and ensures idempotent deduplication by msg_id
create or replace function api.record_inbound_sms(
  requested_msg_id text,
  requested_sender_phone text,
  requested_report_type text,
  requested_lat double precision default null,
  requested_lon double precision default null,
  requested_reported_at timestamptz default now(),
  requested_raw_message text default ''
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_clean_phone text;
  v_phone_masked text;
  v_is_account_verified boolean := false;
  v_existing_id uuid;
  v_report_id uuid;
begin
  v_clean_phone := btrim(requested_sender_phone);
  if v_clean_phone = '' then
    raise exception 'phone_number_required' using errcode = '22023';
  end if;

  -- Create masked phone representation (e.g. 0917 ••• 4567)
  if char_length(v_clean_phone) >= 8 then
    v_phone_masked := substring(v_clean_phone from 1 for 4) || ' ••• ' || substring(v_clean_phone from char_length(v_clean_phone) - 3);
  else
    v_phone_masked := '••••••';
  end if;

  -- Idempotency check: return existing report if msg_id already logged
  select id into v_existing_id
  from public.emergency_inbound_reports
  where msg_id = requested_msg_id;

  if v_existing_id is not null then
    return jsonb_build_object(
      'success', true,
      'duplicate', true,
      'reportId', v_existing_id,
      'message', 'Report already recorded'
    );
  end if;

  -- Verify if sender's phone exists in registered visitors
  select true into v_is_account_verified
  from public.visitors
  where contact_number = v_clean_phone
  limit 1;

  v_is_account_verified := coalesce(v_is_account_verified, false);

  -- Insert report
  insert into public.emergency_inbound_reports (
    msg_id,
    sender_phone_masked,
    sender_phone_e164,
    account_verified,
    report_type,
    latitude,
    longitude,
    reported_at,
    raw_message
  ) values (
    requested_msg_id,
    v_phone_masked,
    v_clean_phone,
    v_is_account_verified,
    requested_report_type,
    requested_lat,
    requested_lon,
    requested_reported_at,
    requested_raw_message
  ) returning id into v_report_id;

  -- Also record to sms_logs
  insert into public.sms_logs (
    direction,
    recipient_masked,
    sender_masked,
    message_body,
    purpose,
    status,
    external_id
  ) values (
    'inbound',
    'EARIST Gateway',
    v_phone_masked,
    requested_raw_message,
    'inbound_message',
    'received',
    requested_msg_id
  );

  return jsonb_build_object(
    'success', true,
    'duplicate', false,
    'reportId', v_report_id,
    'accountVerified', v_is_account_verified
  );
end;
$$;

revoke all on function api.record_inbound_sms(text, text, text, double precision, double precision, timestamptz, text) from public, anon, authenticated;
grant execute on function api.record_inbound_sms(text, text, text, double precision, double precision, timestamptz, text) to service_role;
