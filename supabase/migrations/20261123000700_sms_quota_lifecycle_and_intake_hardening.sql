-- ============================================================================
-- Migration: 20261123000700_sms_quota_lifecycle_and_intake_hardening.sql
-- Description:
--   1. Durable shared replay protection for inbound webhooks (inbound_webhook_replay_logs).
--   2. Strengthens check_and_reserve_sms_quota:
--      - Rejects reuse of consumed/released campaign IDs.
--      - Supports service_role caller for Edge Function automated replies.
--   3. Hardens finalize_sms_quota:
--      - Exact parameter names: p_campaign_id, p_outcome, requested_actor_id.
--      - Supports service_role caller.
--      - Atomic locking and idempotency.
--   4. Auditable stranded reservation reconciliation RPC (reconcile_stranded_sms_reservations).
-- ============================================================================

-- 1. Durable shared replay protection table
create table if not exists public.inbound_webhook_replay_logs (
  request_identifier text primary key,
  created_at timestamptz not null default now()
);

create index if not exists idx_inbound_webhook_replay_logs_created_at
  on public.inbound_webhook_replay_logs (created_at);

revoke all on public.inbound_webhook_replay_logs from public, anon, authenticated;
grant all on public.inbound_webhook_replay_logs to service_role;

-- 2. Durable Replay Verification RPC
create or replace function api.verify_and_record_inbound_replay(
  p_identifier text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_catalog, pg_temp
as $$
declare
  v_inserted boolean := false;
  v_clean_id text;
begin
  v_clean_id := nullif(trim(p_identifier), '');
  if v_clean_id is null then
    return jsonb_build_object('allowed', false, 'error', 'missing_identifier');
  end if;

  -- Prune entries older than 10 minutes to maintain tiny table footprint
  delete from public.inbound_webhook_replay_logs
  where created_at < now() - interval '10 minutes';

  -- Attempt atomic insert
  begin
    insert into public.inbound_webhook_replay_logs (request_identifier)
    values (v_clean_id);
    v_inserted := true;
  exception when unique_violation then
    v_inserted := false;
  end;

  if not v_inserted then
    return jsonb_build_object('allowed', false, 'error', 'replayed_request');
  end if;

  return jsonb_build_object('allowed', true);
end;
$$;

revoke all on function api.verify_and_record_inbound_replay(text) from public, anon, authenticated;
grant execute on function api.verify_and_record_inbound_replay(text) to service_role;

-- 3. Hardened check_and_reserve_sms_quota
drop function if exists api.check_and_reserve_sms_quota(uuid, integer, text);

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
  v_is_service_role boolean := false;
  v_cap integer := 500;
  v_today_date date;
  v_req_count integer;
  v_campaign_id text;
  v_existing_res record;
  v_quota_row record;
  v_current_total integer;
  v_remaining integer;
begin
  -- Check service_role or authenticated staff
  v_is_service_role := (current_setting('request.jwt.claim.role', true) = 'service_role')
    or (current_user in ('service_role', 'postgres', 'supabase_admin'));

  if not v_is_service_role then
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
  else
    v_effective_actor_id := coalesce(requested_actor_id, '00000000-0000-0000-0000-000000000000'::uuid);
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

  -- Idempotency check: if campaign_id is supplied, check existing reservation
  v_campaign_id := nullif(trim(campaign_id), '');
  if v_campaign_id is not null then
    select * into v_existing_res
    from public.sms_quota_reservations
    where public.sms_quota_reservations.campaign_id = v_campaign_id;

    if v_existing_res.id is not null then
      -- STRICT CHECK: Previously consumed or released campaign IDs CANNOT authorize another send!
      if v_existing_res.status != 'reserved' then
        return jsonb_build_object(
          'allowed', false,
          'error', 'campaign_already_finalized',
          'status', v_existing_res.status,
          'campaign_id', v_campaign_id,
          'message', 'This campaign reservation has already been finalized and cannot be reused.'
        );
      end if;

      -- In-flight duplicate retry for still-reserved campaign
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

  -- Atomic Row Lock on Today's Quota
  select * into v_quota_row
  from public.sms_daily_quotas
  where calendar_date = v_today_date
  for update;

  v_current_total := coalesce(v_quota_row.reserved_count, 0) + coalesce(v_quota_row.consumed_count, 0);
  v_remaining := greatest(0, v_cap - v_current_total);

  if (v_current_total + v_req_count) > v_cap then
    return jsonb_build_object(
      'allowed', false,
      'error', 'daily_quota_exceeded',
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

-- 4. Hardened finalize_sms_quota
drop function if exists api.finalize_sms_quota(text, text, uuid);

create or replace function api.finalize_sms_quota(
  p_campaign_id text,
  p_outcome text,
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
  v_is_service_role boolean := false;
  v_res record;
  v_clean_campaign_id text;
  v_clean_outcome text;
begin
  -- Check service_role or authenticated staff
  v_is_service_role := (current_setting('request.jwt.claim.role', true) = 'service_role')
    or (current_user in ('service_role', 'postgres', 'supabase_admin'));

  if not v_is_service_role then
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
  end if;

  v_clean_campaign_id := nullif(trim(p_campaign_id), '');
  if v_clean_campaign_id is null then
    return jsonb_build_object('success', false, 'error', 'campaign_id_required');
  end if;

  v_clean_outcome := lower(trim(coalesce(p_outcome, 'consumed')));

  -- Lock reservation row
  select * into v_res
  from public.sms_quota_reservations
  where public.sms_quota_reservations.campaign_id = v_clean_campaign_id
  for update;

  if v_res.id is null then
    return jsonb_build_object('success', false, 'error', 'reservation_not_found');
  end if;

  -- Idempotency: if already finalized, return current status without modifying quota
  if v_res.status != 'reserved' then
    return jsonb_build_object('success', true, 'status', v_res.status, 'already_finalized', true);
  end if;

  -- Lock daily quota row
  perform 1
  from public.sms_daily_quotas
  where calendar_date = v_res.calendar_date
  for update;

  if v_clean_outcome = 'released' then
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

-- 5. Safe, Auditable Recovery for Stranded Reservations
-- Never blindly refunds; checks public.sms_logs to determine whether dispatch occurred.
create or replace function api.reconcile_stranded_sms_reservations(
  p_older_than_minutes integer default 15,
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
  v_is_service_role boolean := false;
  v_threshold interval;
  v_stranded_rec record;
  v_has_log boolean;
  v_consumed_reconciled integer := 0;
  v_released_reconciled integer := 0;
begin
  v_is_service_role := (current_setting('request.jwt.claim.role', true) = 'service_role')
    or (current_user in ('service_role', 'postgres', 'supabase_admin'));

  if not v_is_service_role then
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
  end if;

  v_threshold := (greatest(5, coalesce(p_older_than_minutes, 15)) || ' minutes')::interval;

  for v_stranded_rec in
    select id, campaign_id, calendar_date, recipient_count
    from public.sms_quota_reservations
    where status = 'reserved'
      and created_at < (now() - v_threshold)
    for update skip locked
  loop
    -- Check if dispatch log exists for this campaign
    select exists (
      select 1
      from public.sms_logs
      where public.sms_logs.campaign_id = v_stranded_rec.campaign_id
    ) into v_has_log;

    perform 1
    from public.sms_daily_quotas
    where calendar_date = v_stranded_rec.calendar_date
    for update;

    if v_has_log then
      -- Dispatch was attempted: mark consumed, do not refund
      update public.sms_daily_quotas
      set reserved_count = greatest(0, reserved_count - v_stranded_rec.recipient_count),
          consumed_count = consumed_count + v_stranded_rec.recipient_count,
          updated_at = now()
      where calendar_date = v_stranded_rec.calendar_date;

      update public.sms_quota_reservations
      set status = 'consumed',
          updated_at = now()
      where id = v_stranded_rec.id;

      v_consumed_reconciled := v_consumed_reconciled + 1;
    else
      -- No dispatch occurred (pre-dispatch abort/crash): release reservation
      update public.sms_daily_quotas
      set reserved_count = greatest(0, reserved_count - v_stranded_rec.recipient_count),
          updated_at = now()
      where calendar_date = v_stranded_rec.calendar_date;

      update public.sms_quota_reservations
      set status = 'released',
          updated_at = now()
      where id = v_stranded_rec.id;

      v_released_reconciled := v_released_reconciled + 1;
    end if;
  end loop;

  return jsonb_build_object(
    'success', true,
    'consumed_reconciled', v_consumed_reconciled,
    'released_reconciled', v_released_reconciled,
    'threshold_minutes', coalesce(p_older_than_minutes, 15)
  );
end;
$$;

revoke all on function api.reconcile_stranded_sms_reservations(integer, uuid) from public, anon, authenticated;
grant execute on function api.reconcile_stranded_sms_reservations(integer, uuid) to service_role;
