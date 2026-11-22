-- ============================================================================
-- Migration: 20261122000100_sms_gateway_and_alerts.sql
-- Description: Adds sms_logs table, app_settings SMS template columns,
--              and secure RPCs for emergency roll call SMS & overdue warnings.
-- ============================================================================

-- 1. Create public.sms_logs table
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

-- Enable RLS
alter table public.sms_logs enable row level security;

-- Policy: Only staff (admin, superadmin) and service_role can read SMS logs
create policy sms_logs_staff_select_policy on public.sms_logs
  for select
  to authenticated
  using (
    exists (
      select 1 from public.profiles p
      where p.id = auth.uid()
        and p.role in ('admin', 'superadmin')
        and p.is_active = true
    )
  );

-- Policy: Service role has full access
create policy sms_logs_service_role_policy on public.sms_logs
  for all
  to service_role
  using (true)
  with check (true);

-- 2. Add SMS Gateway & Alert Columns to app_settings
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

-- 3. Secure RPC: api.get_emergency_sms_recipients
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
security definer
set search_path = public, pg_catalog
as $$
declare
  v_caller_role text;
begin
  -- Validate caller is active admin or superadmin
  select p.role into v_caller_role
  from public.profiles p
  where p.id = auth.uid()
    and p.is_active = true;

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

grant execute on function api.get_emergency_sms_recipients() to authenticated, service_role;

-- 4. Secure RPC: api.get_overdue_campus_visitors
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
security definer
set search_path = public, pg_catalog
as $$
declare
  v_caller_role text;
begin
  select p.role into v_caller_role
  from public.profiles p
  where p.id = auth.uid()
    and p.is_active = true;

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

grant execute on function api.get_overdue_campus_visitors() to authenticated, service_role;
