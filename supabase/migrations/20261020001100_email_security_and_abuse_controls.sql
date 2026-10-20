-- ============================================================================
-- Migration: 20261020001100_email_security_and_abuse_controls.sql
-- Description:
--   1. EMAIL-H02: Reject mismatched terminal states in email finalizer RPCs
--      returning explicit match_status ('matched', 'already_finalized_same_status', 'terminal_conflict')
--   2. EMAIL-M01: Cross-pass recipient and actor rate limits
--   3. EMAIL-M02: Require active, eligible kiosk device state for kiosk email actions
--   4. PRIVACY-M03: Coordinated DB purge-claim protocol for visitor evidence
-- ============================================================================

-- PRIVACY-M03: Add purge claim columns to visitor_evidence
alter table public.visitor_evidence add column if not exists purge_claim_id uuid;
alter table public.visitor_evidence add column if not exists purge_claimed_at timestamptz;

create index if not exists visitor_evidence_purge_claim_idx
  on public.visitor_evidence (purge_claimed_at)
  where purged_at is null and purge_claim_id is not null;

-- EMAIL-M01: Index on recipient_email and created_at for fast cross-pass rate-limit counts
create index if not exists pass_email_verifications_recipient_created_idx
  on public.pass_email_verifications (recipient_email, created_at);

-- ----------------------------------------------------------------------------
-- 1. api.finalize_email_verification_code
-- ----------------------------------------------------------------------------
create or replace function api.finalize_email_verification_code(
  requested_verification_id uuid,
  requested_request_id uuid,
  requested_delivery_status text,
  requested_provider_delivery_id text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row record;
begin
  if requested_delivery_status not in ('sent_to_provider', 'delivery_failed', 'outcome_unknown') then
    raise exception 'invalid_delivery_status' using errcode = '22023';
  end if;

  select ev.id, ev.code_delivery_status into v_row
    from public.pass_email_verifications ev
   where ev.id = requested_verification_id and ev.request_id = requested_request_id
   for update;
  if not found then raise exception 'verification_not_found' using errcode = 'P0002'; end if;

  if v_row.code_delivery_status <> 'code_sending' then
    if v_row.code_delivery_status = requested_delivery_status then
      return jsonb_build_object(
        'success', true,
        'match_status', 'already_finalized_same_status',
        'persisted_status', v_row.code_delivery_status,
        'code_delivery_status', v_row.code_delivery_status,
        'idempotent_replay', true
      );
    else
      return jsonb_build_object(
        'success', false,
        'match_status', 'terminal_conflict',
        'persisted_status', v_row.code_delivery_status,
        'code_delivery_status', v_row.code_delivery_status,
        'idempotent_replay', false
      );
    end if;
  end if;

  update public.pass_email_verifications ev
     set code_delivery_status = requested_delivery_status,
         code_provider_delivery_id = case when requested_delivery_status = 'sent_to_provider' then requested_provider_delivery_id else null end,
         code_sent_at = case when requested_delivery_status = 'sent_to_provider' then statement_timestamp() else null end
   where ev.id = v_row.id and ev.code_delivery_status = 'code_sending';

  return jsonb_build_object(
    'success', true,
    'match_status', 'matched',
    'persisted_status', requested_delivery_status,
    'code_delivery_status', requested_delivery_status,
    'idempotent_replay', false
  );
end;
$$;

revoke all on function api.finalize_email_verification_code(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function api.finalize_email_verification_code(uuid, uuid, text, text) to service_role;

-- ----------------------------------------------------------------------------
-- 2. api.finalize_email_dispatch
-- ----------------------------------------------------------------------------
create or replace function api.finalize_email_dispatch(
  requested_verification_id uuid,
  requested_send_request_id uuid,
  requested_delivery_status text,
  requested_provider_delivery_id text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row record;
begin
  if requested_delivery_status not in ('sent_to_provider', 'delivery_failed', 'outcome_unknown') then
    raise exception 'invalid_delivery_status' using errcode = '22023';
  end if;

  select ev.id, ev.delivery_status into v_row
    from public.pass_email_verifications ev
   where ev.id = requested_verification_id and ev.send_request_id = requested_send_request_id
   for update;
  if not found then raise exception 'claim_not_found' using errcode = 'P0002'; end if;

  -- Terminal states are fenced. A stale failure can never overwrite acceptance.
  if v_row.delivery_status <> 'sending' then
    if v_row.delivery_status = requested_delivery_status then
      return jsonb_build_object(
        'success', true,
        'match_status', 'already_finalized_same_status',
        'persisted_status', v_row.delivery_status,
        'delivery_status', v_row.delivery_status,
        'idempotent_replay', true
      );
    else
      return jsonb_build_object(
        'success', false,
        'match_status', 'terminal_conflict',
        'persisted_status', v_row.delivery_status,
        'delivery_status', v_row.delivery_status,
        'idempotent_replay', false
      );
    end if;
  end if;

  update public.pass_email_verifications ev
     set delivery_status = requested_delivery_status,
         provider_delivery_id = case when requested_delivery_status = 'sent_to_provider' then requested_provider_delivery_id else null end,
         sent_at = case when requested_delivery_status = 'sent_to_provider' then statement_timestamp() else null end
   where ev.id = v_row.id and ev.delivery_status = 'sending' and ev.send_request_id = requested_send_request_id;

  return jsonb_build_object(
    'success', true,
    'match_status', 'matched',
    'persisted_status', requested_delivery_status,
    'delivery_status', requested_delivery_status,
    'idempotent_replay', false
  );
end;
$$;

revoke all on function api.finalize_email_dispatch(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function api.finalize_email_dispatch(uuid, uuid, text, text) to service_role;

-- ----------------------------------------------------------------------------
-- 3. api.request_email_verification_code
-- ----------------------------------------------------------------------------
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
set search_path = ''
as $$
declare
  v_pass record;
  v_existing record;
  v_recipient text := lower(trim(requested_recipient_email));
  v_pass_recent_count integer;
  v_recipient_recent_count integer;
  v_actor_recent_count integer;
begin
  -- Common serialization boundary for all code writers
  select p.id, p.status, p.valid_until, v.owner_id, v.source
    into v_pass
    from public.passes p
    join public.visitors v on v.id = p.visitor_id
   where p.id = requested_pass_id
   for update;

  if not found then raise exception 'pass_not_found' using errcode = 'P0002'; end if;
  if v_pass.owner_id <> requested_actor_id then raise exception 'access_denied' using errcode = '42501'; end if;
  if v_pass.status <> 'issued' then raise exception 'pass_not_active' using errcode = 'P0001'; end if;
  if v_pass.valid_until <= statement_timestamp() then raise exception 'pass_expired' using errcode = 'P0001'; end if;
  if v_recipient = '' or requested_code_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid_request' using errcode = '22023';
  end if;

  -- EMAIL-M02: Active kiosk device check
  if v_pass.source = 'kiosk' then
    if not exists (
      select 1 from public.devices d
       where d.user_id = requested_actor_id
         and d.type = 'kiosk'
         and d.status = 'active'
         and d.deleted_at is null
    ) then
      raise exception 'kiosk_device_revoked' using errcode = '42501';
    end if;
  end if;

  -- Idempotency replay check
  select ev.id, ev.pass_id, ev.request_actor_id, ev.recipient_email, ev.expires_at, ev.code_delivery_status
    into v_existing
    from public.pass_email_verifications ev
   where ev.request_id = requested_request_id
   for update;

  if found then
    if v_existing.pass_id <> requested_pass_id
      or v_existing.request_actor_id is distinct from requested_actor_id
      or lower(trim(v_existing.recipient_email)) <> v_recipient then
      raise exception 'idempotency_key_mismatch' using errcode = 'P0008';
    end if;
    return jsonb_build_object(
      'verification_id', v_existing.id,
      'expires_at', v_existing.expires_at,
      'code_delivery_status', v_existing.code_delivery_status,
      'dispatch_code', false,
      'idempotent_replay', true
    );
  end if;

  -- Per-pass rate limit (max 3 challenges per pass in 15 minutes)
  select count(*) into v_pass_recent_count
    from public.pass_email_verifications ev
   where ev.pass_id = requested_pass_id
     and ev.created_at >= statement_timestamp() - interval '15 minutes';
  if v_pass_recent_count >= 3 then raise exception 'too_many_requests' using errcode = 'P0003'; end if;

  -- EMAIL-M01: Cross-pass recipient abuse limit (max 5 challenges to same email across all passes in 15 minutes)
  select count(*) into v_recipient_recent_count
    from public.pass_email_verifications ev
   where lower(trim(ev.recipient_email)) = v_recipient
     and ev.created_at >= statement_timestamp() - interval '15 minutes';
  if v_recipient_recent_count >= 5 then raise exception 'too_many_requests_recipient' using errcode = 'P0003'; end if;

  -- EMAIL-M01: Per-actor rate limit for portal visitors (max 10 challenges per actor in 15 minutes)
  if v_pass.source <> 'kiosk' then
    select count(*) into v_actor_recent_count
      from public.pass_email_verifications ev
     where ev.request_actor_id = requested_actor_id
       and ev.created_at >= statement_timestamp() - interval '15 minutes';
    if v_actor_recent_count >= 10 then raise exception 'too_many_requests_actor' using errcode = 'P0003'; end if;
  end if;

  insert into public.pass_email_verifications (
    id, pass_id, recipient_email, code_hash, attempts, verified, expires_at,
    request_id, request_actor_id, code_delivery_status, delivery_status, created_at
  ) values (
    requested_verification_id, requested_pass_id, v_recipient, requested_code_hash,
    0, false, requested_expires_at, requested_request_id, requested_actor_id,
    'code_sending', 'pending', statement_timestamp()
  );

  return jsonb_build_object(
    'verification_id', requested_verification_id,
    'expires_at', requested_expires_at,
    'code_delivery_status', 'code_sending',
    'dispatch_code', true,
    'idempotent_replay', false
  );
end;
$$;

revoke all on function api.request_email_verification_code(uuid, uuid, text, text, uuid, uuid, timestamptz) from public, anon, authenticated;
grant execute on function api.request_email_verification_code(uuid, uuid, text, text, uuid, uuid, timestamptz) to service_role;

-- ----------------------------------------------------------------------------
-- 4. api.verify_and_claim_email_dispatch
-- ----------------------------------------------------------------------------
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
set search_path = ''
as $$
declare
  v_pass record;
  v_verif record;
  v_now timestamptz := statement_timestamp();
  v_stale boolean := false;
begin
  select p.id, p.status, p.valid_until, v.owner_id, v.source
    into v_pass
    from public.passes p
    join public.visitors v on v.id = p.visitor_id
   where p.id = requested_pass_id
   for update;

  if not found then raise exception 'pass_not_found' using errcode = 'P0002'; end if;
  if v_pass.owner_id <> requested_actor_id then raise exception 'access_denied' using errcode = '42501'; end if;
  if v_pass.status <> 'issued' then raise exception 'pass_not_active' using errcode = 'P0001'; end if;
  if v_pass.valid_until <= v_now then raise exception 'pass_expired' using errcode = 'P0001'; end if;

  -- EMAIL-M02: Active kiosk device check
  if v_pass.source = 'kiosk' then
    if not exists (
      select 1 from public.devices d
       where d.user_id = requested_actor_id
         and d.type = 'kiosk'
         and d.status = 'active'
         and d.deleted_at is null
    ) then
      raise exception 'kiosk_device_revoked' using errcode = '42501';
    end if;
  end if;

  select * into v_verif
    from public.pass_email_verifications ev
   where ev.id = requested_verification_id and ev.pass_id = requested_pass_id
   for update;

  if not found then raise exception 'verification_not_found' using errcode = 'P0002'; end if;
  if lower(trim(v_verif.recipient_email)) <> lower(trim(requested_recipient_email)) then
    raise exception 'recipient_mismatch' using errcode = 'P0008';
  end if;

  if v_verif.code_delivery_status <> 'sent_to_provider' then
    raise exception 'verification_delivery_unconfirmed' using errcode = 'P0005';
  end if;

  -- Idempotent dispatch replay check
  if v_verif.send_request_id = requested_send_request_id then
    if v_verif.delivery_status = 'sending'
       and v_verif.dispatch_claimed_at is not null
       and v_verif.dispatch_claimed_at < v_now - interval '15 minutes' then
      update public.pass_email_verifications
         set delivery_status = 'outcome_unknown'
       where id = v_verif.id and delivery_status = 'sending';
      v_verif.delivery_status := 'outcome_unknown';
      v_stale := true;
    end if;

    return jsonb_build_object(
      'success', true,
      'idempotent_replay', true,
      'dispatch_authorized', false,
      'delivery_status', v_verif.delivery_status,
      'stale_claim_promoted', v_stale
    );
  end if;

  if v_verif.verified and v_verif.delivery_status = 'sent_to_provider' then
    raise exception 'code_already_used' using errcode = 'P0004';
  end if;

  if v_verif.delivery_status = 'sending' then
    raise exception 'dispatch_in_progress' using errcode = 'P0005';
  end if;

  if v_verif.expires_at <= v_now then
    raise exception 'code_expired' using errcode = 'P0006';
  end if;

  if v_verif.attempts >= 5 then
    raise exception 'max_attempts_exceeded' using errcode = 'P0007';
  end if;

  if v_verif.code_hash <> requested_expected_hash then
    update public.pass_email_verifications
       set attempts = attempts + 1
     where id = v_verif.id;

    return jsonb_build_object(
      'success', false,
      'error', 'invalid_code',
      'attempts_remaining', greatest(0, 5 - (v_verif.attempts + 1)),
      'idempotent_replay', false,
      'dispatch_authorized', false,
      'delivery_status', v_verif.delivery_status
    );
  end if;

  update public.pass_email_verifications
     set verified = true,
         delivery_status = 'sending',
         send_request_id = requested_send_request_id,
         dispatch_claimed_at = v_now
   where id = v_verif.id;

  return jsonb_build_object(
    'success', true,
    'idempotent_replay', false,
    'dispatch_authorized', true,
    'delivery_status', 'sending',
    'stale_claim_promoted', false
  );
end;
$$;

revoke all on function api.verify_and_claim_email_dispatch(uuid, uuid, uuid, text, text, uuid) from public, anon, authenticated;
grant execute on function api.verify_and_claim_email_dispatch(uuid, uuid, uuid, text, text, uuid) to service_role;

-- ----------------------------------------------------------------------------
-- 5. PRIVACY-M03: api.claim_evidence_for_purge
-- ----------------------------------------------------------------------------
create or replace function api.claim_evidence_for_purge(
  requested_evidence_id uuid,
  requested_claim_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_evidence record;
begin
  select ve.id, ve.visitor_id, ve.bucket_id, ve.object_path, ve.purged_at, ve.purge_claim_id, ve.purge_claimed_at
    into v_evidence
    from public.visitor_evidence ve
   where ve.id = requested_evidence_id
   for update;

  if not found then
    return jsonb_build_object('claimed', false, 'reason', 'evidence_not_found');
  end if;

  if v_evidence.purged_at is not null then
    return jsonb_build_object('claimed', false, 'reason', 'already_purged');
  end if;

  -- Check if claimed recently by another worker (< 5 min)
  if v_evidence.purge_claim_id is not null
     and v_evidence.purge_claim_id <> requested_claim_id
     and v_evidence.purge_claimed_at >= statement_timestamp() - interval '5 minutes' then
    return jsonb_build_object('claimed', false, 'reason', 'concurrent_purge_in_progress');
  end if;

  -- Active incident hold by visitor_id
  if exists (
    select 1 from public.incident_holds ih
     where ih.visitor_id = v_evidence.visitor_id
       and ih.active = true
  ) then
    return jsonb_build_object('claimed', false, 'reason', 'active_visitor_hold');
  end if;

  -- Active incident hold by pass_id belonging to this visitor
  if exists (
    select 1 from public.incident_holds ih
     join public.passes p on p.id = ih.pass_id
     where p.visitor_id = v_evidence.visitor_id
       and ih.active = true
  ) then
    return jsonb_build_object('claimed', false, 'reason', 'active_pass_hold');
  end if;

  -- Active, pending, or future issued passes for this visitor
  if exists (
    select 1 from public.passes p
     where p.visitor_id = v_evidence.visitor_id
       and (
         p.status in ('inside', 'pending')
         or (p.status = 'issued' and p.valid_until > statement_timestamp())
       )
  ) then
    return jsonb_build_object('claimed', false, 'reason', 'active_or_future_pass_exists');
  end if;

  update public.visitor_evidence
     set purge_claim_id = requested_claim_id,
         purge_claimed_at = statement_timestamp()
   where id = v_evidence.id;

  return jsonb_build_object(
    'claimed', true,
    'evidence_id', v_evidence.id,
    'visitor_id', v_evidence.visitor_id,
    'bucket_id', v_evidence.bucket_id,
    'object_path', v_evidence.object_path
  );
end;
$$;

revoke all on function api.claim_evidence_for_purge(uuid, uuid) from public, anon, authenticated;
grant execute on function api.claim_evidence_for_purge(uuid, uuid) to service_role;

-- ----------------------------------------------------------------------------
-- 6. PRIVACY-M03: api.finalize_evidence_purge
-- ----------------------------------------------------------------------------
create or replace function api.finalize_evidence_purge(
  requested_evidence_id uuid,
  requested_claim_id uuid,
  requested_success boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row record;
begin
  select ve.id, ve.purged_at, ve.purge_claim_id
    into v_row
    from public.visitor_evidence ve
   where ve.id = requested_evidence_id
   for update;

  if not found then
    return jsonb_build_object('success', false, 'reason', 'evidence_not_found');
  end if;

  if requested_success then
    update public.visitor_evidence
       set purged_at = coalesce(purged_at, statement_timestamp()),
           purge_claim_id = null,
           purge_claimed_at = null
     where id = v_row.id;
    return jsonb_build_object('success', true, 'purged', true);
  else
    -- On failure, release claim so it can be reconciled/retried later
    update public.visitor_evidence
       set purge_claim_id = null,
           purge_claimed_at = null
     where id = v_row.id;
    return jsonb_build_object('success', true, 'purged', false, 'claim_released', true);
  end if;
end;
$$;

revoke all on function api.finalize_evidence_purge(uuid, uuid, boolean) from public, anon, authenticated;
grant execute on function api.finalize_evidence_purge(uuid, uuid, boolean) to service_role;
