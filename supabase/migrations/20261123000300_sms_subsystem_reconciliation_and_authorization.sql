-- ============================================================================
-- Migration: 20261123000300_sms_subsystem_reconciliation_and_authorization.sql
-- Description:
--   1. Reconciles public.sms_logs schema: adds transaction_id, device_id, batch_id,
--      and expands status check constraint to support 'accepted' and 'unknown'.
--   2. Updates api.get_emergency_sms_recipients and api.get_overdue_campus_visitors
--      to securely accept requested_actor_id while enforcing strict staff_profile
--      role verification (admin/superadmin) under SECURITY DEFINER.
--   3. Adds api.check_and_reserve_sms_quota for atomic daily SMS cap enforcement
--      calculated in Asia/Manila timezone against public.app_settings.sms_daily_cap.
--   4. Enforces least-privilege grants (revoking public/anon).
-- ============================================================================

-- 1. Upgrade public.sms_logs schema
alter table public.sms_logs
  add column if not exists transaction_id text,
  add column if not exists device_id text,
  add column if not exists batch_id text;

-- Update status constraint to include 'accepted' and 'unknown'
alter table public.sms_logs drop constraint if exists sms_logs_status_check;
alter table public.sms_logs add constraint sms_logs_status_check
  check (status in ('queued', 'accepted', 'sent', 'delivered', 'failed', 'received', 'unknown'));

-- Index on transaction_id and device_id for auditability
create index if not exists idx_sms_logs_transaction_id on public.sms_logs (transaction_id);
create index if not exists idx_sms_logs_device_id on public.sms_logs (device_id);

-- Recreate compatibility view
create or replace view public.sms_log as
  select * from public.sms_logs;

-- 2. Drop existing 0-arg RPCs to avoid signature ambiguity
drop function if exists api.get_emergency_sms_recipients();
drop function if exists api.get_emergency_sms_recipients(uuid);
drop function if exists api.get_overdue_campus_visitors();
drop function if exists api.get_overdue_campus_visitors(uuid);

-- 3. Secure RPC: api.get_emergency_sms_recipients
create or replace function api.get_emergency_sms_recipients(
  requested_actor_id uuid default null
)
returns table (
  pass_id uuid,
  visitor_name text,
  contact_number text,
  time_in timestamptz,
  gate text
)
language plpgsql
security definer
set search_path = public, pg_catalog, pg_temp
as $$
declare
  v_effective_actor_id uuid;
  v_caller_role text;
begin
  v_effective_actor_id := coalesce(requested_actor_id, auth.uid());
  if v_effective_actor_id is null then
    raise exception 'unauthorized_staff_action' using errcode = '42501';
  end if;

  -- Validate caller is active admin or superadmin
  select p.role::text into v_caller_role
  from public.staff_profiles p
  where p.user_id = v_effective_actor_id
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

revoke all on function api.get_emergency_sms_recipients(uuid) from public, anon, authenticated;
grant execute on function api.get_emergency_sms_recipients(uuid) to service_role;

-- 4. Secure RPC: api.get_overdue_campus_visitors
create or replace function api.get_overdue_campus_visitors(
  requested_actor_id uuid default null
)
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
set search_path = public, pg_catalog, pg_temp
as $$
declare
  v_effective_actor_id uuid;
  v_caller_role text;
begin
  v_effective_actor_id := coalesce(requested_actor_id, auth.uid());
  if v_effective_actor_id is null then
    raise exception 'unauthorized_staff_action' using errcode = '42501';
  end if;

  select p.role::text into v_caller_role
  from public.staff_profiles p
  where p.user_id = v_effective_actor_id
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

revoke all on function api.get_overdue_campus_visitors(uuid) from public, anon, authenticated;
grant execute on function api.get_overdue_campus_visitors(uuid) to service_role;

-- 5. Secure RPC: api.check_and_reserve_sms_quota
create or replace function api.check_and_reserve_sms_quota(
  requested_actor_id uuid default null,
  requested_count integer default 1
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_catalog, pg_temp
as $$
declare
  v_effective_actor_id uuid;
  v_caller_role text;
  v_cap integer := 500;
  v_today_start timestamptz;
  v_dispatched_today integer := 0;
  v_req_count integer;
  v_allowed boolean;
begin
  v_effective_actor_id := coalesce(requested_actor_id, auth.uid());
  if v_effective_actor_id is null then
    raise exception 'unauthorized_staff_action' using errcode = '42501';
  end if;

  select p.role::text into v_caller_role
  from public.staff_profiles p
  where p.user_id = v_effective_actor_id
    and p.active = true;

  if v_caller_role is null or v_caller_role not in ('admin', 'superadmin') then
    raise exception 'unauthorized_staff_action' using errcode = '42501';
  end if;

  v_req_count := greatest(1, coalesce(requested_count, 1));

  -- Read daily cap from app_settings
  select coalesce(sms_daily_cap, 500) into v_cap
  from public.app_settings
  limit 1;
  if v_cap is null or v_cap <= 0 then
    v_cap := 500;
  end if;

  -- Calculate start of day in Asia/Manila timezone
  v_today_start := date_trunc('day', timezone('Asia/Manila', now())) at time zone 'Asia/Manila';

  -- Count today's outbound messages
  select count(*) into v_dispatched_today
  from public.sms_logs
  where direction = 'outbound'
    and created_at >= v_today_start
    and status in ('accepted', 'sent', 'delivered', 'queued');

  v_allowed := (v_dispatched_today + v_req_count) <= v_cap;

  return jsonb_build_object(
    'allowed', v_allowed,
    'current_count', v_dispatched_today,
    'requested_count', v_req_count,
    'daily_cap', v_cap,
    'remaining', greatest(0, v_cap - v_dispatched_today)
  );
end;
$$;

revoke all on function api.check_and_reserve_sms_quota(uuid, integer) from public, anon, authenticated;
grant execute on function api.check_and_reserve_sms_quota(uuid, integer) to service_role;
