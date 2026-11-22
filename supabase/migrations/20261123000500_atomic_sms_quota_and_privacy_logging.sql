-- Migration: 20261123000500_atomic_sms_quota_and_privacy_logging.sql
-- Description: Establishes atomic daily quota reservation with Asia/Manila calendar day,
--              per-recipient quota accounting, concurrency locking, and privacy-first SMS logging.

-- 1. Create daily quota tracking ledger
create table if not exists public.sms_daily_quotas (
  calendar_date date primary key,
  reserved_count integer not null default 0 check (reserved_count >= 0),
  consumed_count integer not null default 0 check (consumed_count >= 0),
  max_cap integer not null default 500 check (max_cap >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 2. Create per-campaign reservation records
create table if not exists public.sms_quota_reservations (
  id uuid primary key default gen_random_uuid(),
  calendar_date date not null,
  campaign_id text not null,
  actor_id uuid references auth.users(id) on delete set null,
  recipient_count integer not null check (recipient_count > 0),
  status text not null check (status in ('reserved', 'consumed', 'released')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists idx_sms_quota_reservations_campaign
  on public.sms_quota_reservations (campaign_id);

create index if not exists idx_sms_quota_reservations_date_status
  on public.sms_quota_reservations (calendar_date, status);

-- 3. Upgrade public.sms_logs for privacy and per-recipient tracking
alter table public.sms_logs alter column message_body drop not null;
alter table public.sms_logs add column if not exists recipient_count integer not null default 1;
alter table public.sms_logs add column if not exists campaign_id text;
create index if not exists idx_sms_logs_campaign_id on public.sms_logs (campaign_id);

-- Refresh compatibility view
create or replace view public.sms_log as
  select * from public.sms_logs;

-- 4. Enable RLS and restrict table access to service_role
alter table public.sms_daily_quotas enable row level security;
alter table public.sms_quota_reservations enable row level security;

revoke all on public.sms_daily_quotas from public, anon, authenticated;
grant all on public.sms_daily_quotas to service_role;

revoke all on public.sms_quota_reservations from public, anon, authenticated;
grant all on public.sms_quota_reservations to service_role;

-- 5. Seed today's consumed count from existing outbound logs
insert into public.sms_daily_quotas (calendar_date, consumed_count, max_cap)
values (
  (timezone('Asia/Manila', now()))::date,
  coalesce((
    select count(*)
    from public.sms_logs
    where direction = 'outbound'
      and created_at >= (date_trunc('day', timezone('Asia/Manila', now())) at time zone 'Asia/Manila')
      and status in ('accepted', 'sent', 'delivered', 'queued')
  ), 0),
  500
)
on conflict (calendar_date) do update
set consumed_count = excluded.consumed_count;

-- 6. Drop previous 2-parameter signature to prevent ambiguous overload
drop function if exists api.check_and_reserve_sms_quota(uuid, integer);

-- 7. Atomic Quota Reservation RPC
create or replace function api.check_and_reserve_sms_quota(
  requested_actor_id uuid default null,
  requested_count integer default 1,
  campaign_id text default null
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
  v_today_date date;
  v_req_count integer;
  v_campaign_id text;
  v_existing_res record;
  v_quota_row record;
  v_current_total integer;
  v_remaining integer;
begin
  -- 1. Authorization: active admin or superadmin
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

  v_req_count := coalesce(requested_count, 1);
  v_today_date := (timezone('Asia/Manila', now()))::date;

  -- Read daily cap from app_settings
  select coalesce(sms_daily_cap, 500) into v_cap
  from public.app_settings
  limit 1;
  if v_cap is null or v_cap <= 0 then
    v_cap := 500;
  end if;

  -- Ensure daily quota row exists for today
  insert into public.sms_daily_quotas (calendar_date, max_cap)
  values (v_today_date, v_cap)
  on conflict (calendar_date) do update
  set max_cap = excluded.max_cap;

  -- Idempotency check: if campaign_id is supplied, check if already reserved
  v_campaign_id := nullif(trim(campaign_id), '');
  if v_campaign_id is not null then
    select * into v_existing_res
    from public.sms_quota_reservations
    where public.sms_quota_reservations.campaign_id = v_campaign_id;

    if v_existing_res.id is not null then
      select * into v_quota_row
      from public.sms_daily_quotas
      where calendar_date = v_today_date;

      v_current_total := coalesce(v_quota_row.reserved_count, 0) + coalesce(v_quota_row.consumed_count, 0);
      return jsonb_build_object(
        'allowed', true,
        'already_reserved', true,
        'reservation_id', v_existing_res.id,
        'campaign_id', v_campaign_id,
        'requested_count', v_existing_res.recipient_count,
        'status', v_existing_res.status,
        'current_count', v_current_total,
        'daily_cap', v_cap,
        'remaining', greatest(0, v_cap - v_current_total)
      );
    end if;
  else
    v_campaign_id := 'camp_' || gen_random_uuid()::text;
  end if;

  -- Read-only query (requested_count <= 0)
  if v_req_count <= 0 then
    select * into v_quota_row
    from public.sms_daily_quotas
    where calendar_date = v_today_date;

    v_current_total := coalesce(v_quota_row.reserved_count, 0) + coalesce(v_quota_row.consumed_count, 0);
    return jsonb_build_object(
      'allowed', true,
      'read_only', true,
      'current_count', v_current_total,
      'daily_cap', v_cap,
      'remaining', greatest(0, v_cap - v_current_total)
    );
  end if;

  -- ATOMIC ROW LOCK: Lock today's row FOR UPDATE
  select * into v_quota_row
  from public.sms_daily_quotas
  where calendar_date = v_today_date
  for update;

  v_current_total := coalesce(v_quota_row.reserved_count, 0) + coalesce(v_quota_row.consumed_count, 0);
  v_remaining := greatest(0, v_cap - v_current_total);

  if (v_current_total + v_req_count) > v_cap then
    return jsonb_build_object(
      'allowed', false,
      'current_count', v_current_total,
      'requested_count', v_req_count,
      'daily_cap', v_cap,
      'remaining', v_remaining
    );
  end if;

  -- Increment reserved_count atomically
  update public.sms_daily_quotas
  set reserved_count = reserved_count + v_req_count,
      updated_at = now()
  where calendar_date = v_today_date;

  insert into public.sms_quota_reservations (
    calendar_date,
    campaign_id,
    actor_id,
    recipient_count,
    status
  ) values (
    v_today_date,
    v_campaign_id,
    v_effective_actor_id,
    v_req_count,
    'reserved'
  );

  return jsonb_build_object(
    'allowed', true,
    'campaign_id', v_campaign_id,
    'requested_count', v_req_count,
    'current_count', v_current_total + v_req_count,
    'daily_cap', v_cap,
    'remaining', v_cap - (v_current_total + v_req_count)
  );
end;
$$;

revoke all on function api.check_and_reserve_sms_quota(uuid, integer, text) from public, anon, authenticated;
grant execute on function api.check_and_reserve_sms_quota(uuid, integer, text) to service_role;

-- 8. Quota Finalization RPC
create or replace function api.finalize_sms_quota(
  p_campaign_id text,
  p_outcome text, -- 'consumed' | 'released' | 'timeout' | 'unknown'
  requested_actor_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_catalog, pg_temp
as $$
declare
  v_effective_actor_id uuid;
  v_caller_role text;
  v_res record;
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

  if p_campaign_id is null or trim(p_campaign_id) = '' then
    return jsonb_build_object('success', false, 'error', 'campaign_id_required');
  end if;

  select * into v_res
  from public.sms_quota_reservations
  where public.sms_quota_reservations.campaign_id = trim(p_campaign_id)
  for update;

  if v_res.id is null then
    return jsonb_build_object('success', false, 'error', 'reservation_not_found');
  end if;

  if v_res.status != 'reserved' then
    return jsonb_build_object('success', true, 'status', v_res.status, 'already_finalized', true);
  end if;

  perform 1
  from public.sms_daily_quotas
  where calendar_date = v_res.calendar_date
  for update;

  if p_outcome = 'released' then
    update public.sms_daily_quotas
    set reserved_count = greatest(0, reserved_count - v_res.recipient_count),
        updated_at = now()
    where calendar_date = v_res.calendar_date;

    update public.sms_quota_reservations
    set status = 'released',
        updated_at = now()
    where id = v_res.id;

    return jsonb_build_object('success', true, 'status', 'released', 'refunded_count', v_res.recipient_count);
  else
    -- Outcome is 'consumed', 'timeout', or 'unknown' (NEVER refund ambiguous results)
    update public.sms_daily_quotas
    set reserved_count = greatest(0, reserved_count - v_res.recipient_count),
        consumed_count = consumed_count + v_res.recipient_count,
        updated_at = now()
    where calendar_date = v_res.calendar_date;

    update public.sms_quota_reservations
    set status = 'consumed',
        updated_at = now()
    where id = v_res.id;

    return jsonb_build_object('success', true, 'status', 'consumed', 'consumed_count', v_res.recipient_count);
  end if;
end;
$$;

revoke all on function api.finalize_sms_quota(text, text, uuid) from public, anon, authenticated;
grant execute on function api.finalize_sms_quota(text, text, uuid) to service_role;
