-- ============================================================================
-- Migration: 20261020000900_qr_email_idempotency.sql
-- Description: Additive idempotency, locked state claim, and delivery status
--              for optional QR email verification (P0-01, P0-02).
-- ============================================================================

-- 1. Additive columns for idempotent requests and durable delivery state
alter table public.pass_email_verifications
  add column if not exists request_id uuid,
  add column if not exists send_request_id uuid,
  add column if not exists delivery_status text not null default 'pending'
    check (delivery_status in ('pending', 'sending', 'sent_to_provider', 'delivery_failed')),
  add column if not exists provider_delivery_id text,
  add column if not exists sent_at timestamptz;

-- 2. Partial unique indexes for idempotent replay protection
create unique index if not exists pass_email_verifications_request_id_idx
  on public.pass_email_verifications (request_id)
  where request_id is not null;

create unique index if not exists pass_email_verifications_send_request_id_idx
  on public.pass_email_verifications (send_request_id)
  where send_request_id is not null;

-- 3. Atomic RPC: Request verification code with rate-limiting and idempotency
create or replace function api.request_email_verification_code(
  requested_pass_id uuid,
  requested_actor_id uuid,
  requested_recipient_email text,
  requested_code_hash text,
  requested_request_id uuid,
  requested_verification_id uuid,
  requested_expires_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_pass record;
  v_existing record;
  v_window_start timestamptz;
  v_recent_count integer;
  v_recipient text;
begin
  v_recipient := lower(trim(requested_recipient_email));

  -- Check pass existence and ownership
  select p.id, p.status, p.valid_until, v.owner_id
  into v_pass
  from public.passes p
  join public.visitors v on v.id = p.visitor_id
  where p.id = requested_pass_id;

  if not found then
    raise exception 'pass_not_found' using errcode = 'P0002';
  end if;

  if v_pass.owner_id <> requested_actor_id then
    raise exception 'access_denied' using errcode = '42501';
  end if;

  if v_pass.status <> 'issued' then
    raise exception 'pass_not_active' using errcode = 'P0001';
  end if;

  if v_pass.valid_until <= now() then
    raise exception 'pass_expired' using errcode = 'P0001';
  end if;

  -- Idempotency check: if this request_id was already processed, return existing row
  select id, expires_at into v_existing
  from public.pass_email_verifications
  where request_id = requested_request_id;

  if found then
    return jsonb_build_object(
      'verification_id', v_existing.id,
      'expires_at', v_existing.expires_at,
      'idempotent_replay', true
    );
  end if;

  -- Rate limit check: max 3 requests per 15 minutes for this pass
  v_window_start := now() - interval '15 minutes';
  select count(*) into v_recent_count
  from public.pass_email_verifications
  where pass_id = requested_pass_id
    and created_at >= v_window_start;

  if v_recent_count >= 3 then
    raise exception 'too_many_requests' using errcode = 'P0003';
  end if;

  -- Insert new verification challenge atomically
  insert into public.pass_email_verifications (
    id,
    pass_id,
    recipient_email,
    code_hash,
    attempts,
    verified,
    expires_at,
    request_id,
    delivery_status,
    created_at
  ) values (
    requested_verification_id,
    requested_pass_id,
    v_recipient,
    requested_code_hash,
    0,
    false,
    requested_expires_at,
    requested_request_id,
    'pending',
    now()
  );

  return jsonb_build_object(
    'verification_id', requested_verification_id,
    'expires_at', requested_expires_at,
    'idempotent_replay', false
  );
end;
$$;

revoke all on function api.request_email_verification_code(uuid, uuid, text, text, uuid, uuid, timestamptz) from public, anon, authenticated;
grant execute on function api.request_email_verification_code(uuid, uuid, text, text, uuid, uuid, timestamptz) to service_role;

-- 4. Atomic RPC: Verify challenge code and claim dispatch lock (FOR UPDATE)
create or replace function api.verify_and_claim_email_dispatch(
  requested_verification_id uuid,
  requested_pass_id uuid,
  requested_actor_id uuid,
  requested_recipient_email text,
  requested_expected_hash text,
  requested_send_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_verif record;
  v_pass record;
  v_recipient text;
begin
  v_recipient := lower(trim(requested_recipient_email));

  -- Lock row for update to eliminate concurrency races
  select *
  into v_verif
  from public.pass_email_verifications
  where id = requested_verification_id
    and pass_id = requested_pass_id
  for update;

  if not found then
    raise exception 'verification_not_found' using errcode = 'P0002';
  end if;

  -- Verify pass owner
  select v.owner_id into v_pass
  from public.passes p
  join public.visitors v on v.id = p.visitor_id
  where p.id = requested_pass_id;

  if v_pass.owner_id <> requested_actor_id then
    raise exception 'access_denied' using errcode = '42501';
  end if;

  -- Idempotent send replay
  if v_verif.send_request_id = requested_send_request_id then
    return jsonb_build_object(
      'success', true,
      'status', v_verif.delivery_status,
      'recipient_email', v_verif.recipient_email,
      'idempotent_replay', true
    );
  end if;

  if v_verif.verified and v_verif.delivery_status = 'sent_to_provider' then
    raise exception 'code_already_used' using errcode = 'P0004';
  end if;

  if v_verif.delivery_status = 'sending' then
    raise exception 'dispatch_in_progress' using errcode = 'P0005';
  end if;

  if v_verif.expires_at <= now() then
    raise exception 'code_expired' using errcode = 'P0006';
  end if;

  if v_verif.attempts >= 3 then
    raise exception 'max_attempts_exceeded' using errcode = 'P0007';
  end if;

  if lower(trim(v_verif.recipient_email)) <> v_recipient then
    raise exception 'recipient_mismatch' using errcode = 'P0008';
  end if;

  -- Hash mismatch check: increment attempts atomically
  if v_verif.code_hash <> requested_expected_hash then
    update public.pass_email_verifications
    set attempts = attempts + 1
    where id = v_verif.id;

    return jsonb_build_object(
      'success', false,
      'error', 'invalid_code',
      'attempts_remaining', greatest(0, 2 - v_verif.attempts)
    );
  end if;

  -- Verified and locked for sending
  update public.pass_email_verifications
  set verified = true,
      delivery_status = 'sending',
      send_request_id = requested_send_request_id
  where id = v_verif.id;

  return jsonb_build_object(
    'success', true,
    'recipient_email', v_verif.recipient_email,
    'idempotent_replay', false
  );
end;
$$;

revoke all on function api.verify_and_claim_email_dispatch(uuid, uuid, uuid, text, text, uuid) from public, anon, authenticated;
grant execute on function api.verify_and_claim_email_dispatch(uuid, uuid, uuid, text, text, uuid) to service_role;

-- 5. Atomic RPC: Finalize email dispatch with provider delivery outcome
create or replace function api.finalize_email_dispatch(
  requested_verification_id uuid,
  requested_send_request_id uuid,
  requested_delivery_status text,
  requested_provider_delivery_id text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_verif record;
begin
  select *
  into v_verif
  from public.pass_email_verifications
  where id = requested_verification_id
    and send_request_id = requested_send_request_id
  for update;

  if not found then
    raise exception 'verification_not_found' using errcode = 'P0002';
  end if;

  if requested_delivery_status = 'sent_to_provider' then
    update public.pass_email_verifications
    set delivery_status = 'sent_to_provider',
        provider_delivery_id = requested_provider_delivery_id,
        sent_at = now()
    where id = v_verif.id;
  else
    -- Provider failed: unlock verification to preserve retry path
    update public.pass_email_verifications
    set delivery_status = 'delivery_failed',
        send_request_id = null
    where id = v_verif.id;
  end if;

  return jsonb_build_object(
    'success', true,
    'delivery_status', requested_delivery_status
  );
end;
$$;

revoke all on function api.finalize_email_dispatch(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function api.finalize_email_dispatch(uuid, uuid, text, text) to service_role;
