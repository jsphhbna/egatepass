-- 20261020001200_concurrency_and_purge_contract_hardening.sql
-- Additive hardening:
-- 1. Enforces exact claim_id ownership, row locking, freshness lease, and standardized JSON contract in api.finalize_evidence_purge
-- 2. Enforces server-side expiry revalidation and authoritative object paths in api.claim_evidence_for_purge
-- 3. Provides transaction-level deterministic advisory locking in api.request_email_verification_code across distinct passes for recipient and actor abuse limits

-- ----------------------------------------------------------------------------
-- 1. api.claim_evidence_for_purge
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
  if requested_evidence_id is null or requested_claim_id is null then
    return jsonb_build_object('claimed', false, 'reason', 'invalid_argument');
  end if;

  select ve.id, ve.visitor_id, ve.bucket_id, ve.object_path, ve.purged_at, ve.expires_at, ve.purge_claim_id, ve.purge_claimed_at
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

  -- Server-side expiration revalidation
  if v_evidence.expires_at > statement_timestamp() then
    return jsonb_build_object('claimed', false, 'reason', 'not_expired');
  end if;

  -- Freshness check: if claimed recently by another worker (< 5 min), deny concurrent purge
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
    'object_path', v_evidence.object_path,
    'claim_id', requested_claim_id,
    'claimed_at', statement_timestamp()
  );
end;
$$;

revoke all on function api.claim_evidence_for_purge(uuid, uuid) from public, anon, authenticated;
grant execute on function api.claim_evidence_for_purge(uuid, uuid) to service_role;

-- ----------------------------------------------------------------------------
-- 2. api.finalize_evidence_purge
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
  if requested_evidence_id is null or requested_claim_id is null then
    return jsonb_build_object(
      'success', false,
      'finalized', false,
      'match_status', 'invalid_argument',
      'reason', 'null_id'
    );
  end if;

  select ve.id, ve.purged_at, ve.purge_claim_id, ve.purge_claimed_at
    into v_row
    from public.visitor_evidence ve
   where ve.id = requested_evidence_id
   for update;

  if not found then
    return jsonb_build_object(
      'success', false,
      'finalized', false,
      'match_status', 'not_found',
      'reason', 'evidence_not_found'
    );
  end if;

  -- Terminal check: already purged
  if v_row.purged_at is not null then
    return jsonb_build_object(
      'success', false,
      'finalized', false,
      'match_status', 'terminal_conflict',
      'purged', true,
      'reason', 'already_purged'
    );
  end if;

  -- Claim existence check
  if v_row.purge_claim_id is null then
    return jsonb_build_object(
      'success', false,
      'finalized', false,
      'match_status', 'not_claimed',
      'reason', 'no_active_claim'
    );
  end if;

  -- Exact claim ID match check (prevents cross-worker claim clearing or unauthorized completion)
  if v_row.purge_claim_id <> requested_claim_id then
    return jsonb_build_object(
      'success', false,
      'finalized', false,
      'match_status', 'claim_mismatch',
      'reason', 'claim_id_mismatch'
    );
  end if;

  -- Freshness/lease check (5 minutes lease limit)
  if v_row.purge_claimed_at < statement_timestamp() - interval '5 minutes' then
    return jsonb_build_object(
      'success', false,
      'finalized', false,
      'match_status', 'expired_claim',
      'reason', 'claim_lease_expired'
    );
  end if;

  if requested_success then
    update public.visitor_evidence
       set purged_at = statement_timestamp(),
           purge_claim_id = null,
           purge_claimed_at = null
     where id = v_row.id;
    return jsonb_build_object(
      'success', true,
      'finalized', true,
      'match_status', 'matched',
      'purged', true,
      'purged_at', statement_timestamp()
    );
  else
    -- On failure, release claim so it can be reconciled/retried later by authorized processes
    update public.visitor_evidence
       set purge_claim_id = null,
           purge_claimed_at = null
     where id = v_row.id;
    return jsonb_build_object(
      'success', true,
      'finalized', true,
      'match_status', 'claim_released',
      'purged', false,
      'claim_released', true
    );
  end if;
end;
$$;

revoke all on function api.finalize_evidence_purge(uuid, uuid, boolean) from public, anon, authenticated;
grant execute on function api.finalize_evidence_purge(uuid, uuid, boolean) to service_role;

-- ----------------------------------------------------------------------------
-- 3. api.request_email_verification_code (with deterministic advisory locks)
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
  v_recipient text;
  v_existing record;
  v_pass_recent_count bigint;
  v_recipient_recent_count bigint;
  v_actor_recent_count bigint;
begin
  v_recipient := lower(trim(coalesce(requested_recipient_email, '')));

  -- 1. Pass lock (serializes requests targeting the same pass)
  select * into v_pass
    from public.passes
   where id = requested_pass_id
   for update;

  if not found then raise exception 'pass_not_found' using errcode = 'P0002'; end if;
  if v_pass.owner_id <> requested_actor_id then raise exception 'access_denied' using errcode = '42501'; end if;
  if v_pass.status <> 'issued' then raise exception 'pass_not_active' using errcode = 'P0001'; end if;
  if v_pass.valid_until <= statement_timestamp() then raise exception 'pass_expired' using errcode = 'P0001'; end if;
  if v_recipient = '' or requested_code_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid_request' using errcode = '22023';
  end if;

  -- Active kiosk device check
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

  -- Idempotency replay check under pass lock
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

  -- 2. Concurrency serialization across distinct passes:
  -- Acquire deterministic advisory transaction locks to eliminate cross-pass count-then-insert races.
  -- Strict hierarchy prevents deadlocks:
  -- Level 1: Actor lock (if portal actor)
  -- Level 2: Recipient lock
  if v_pass.source <> 'kiosk' and requested_actor_id is not null then
    perform pg_advisory_xact_lock(1, hashtext(requested_actor_id::text));
  end if;
  perform pg_advisory_xact_lock(2, hashtext(v_recipient));

  -- Per-pass rate limit (max 3 challenges per pass in 15 minutes)
  select count(*) into v_pass_recent_count
    from public.pass_email_verifications ev
   where ev.pass_id = requested_pass_id
     and ev.created_at >= statement_timestamp() - interval '15 minutes';
  if v_pass_recent_count >= 3 then raise exception 'too_many_requests' using errcode = 'P0003'; end if;

  -- Cross-pass recipient abuse limit (max 5 challenges to same email across all passes in 15 minutes)
  select count(*) into v_recipient_recent_count
    from public.pass_email_verifications ev
   where lower(trim(ev.recipient_email)) = v_recipient
     and ev.created_at >= statement_timestamp() - interval '15 minutes';
  if v_recipient_recent_count >= 5 then raise exception 'too_many_requests_recipient' using errcode = 'P0003'; end if;

  -- Per-actor rate limit for portal visitors (max 10 challenges per actor in 15 minutes)
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
