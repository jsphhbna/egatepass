-- Targeted QR-email security and integration-contract correction.
-- Additive only: migrations 00100-00900 remain immutable history.

alter table public.pass_email_verifications
  add column if not exists code_delivery_status text not null default 'outcome_unknown',
  add column if not exists code_provider_delivery_id text,
  add column if not exists code_sent_at timestamptz,
  add column if not exists dispatch_claimed_at timestamptz,
  add column if not exists request_actor_id uuid;

alter table public.pass_email_verifications
  drop constraint if exists pass_email_verifications_delivery_status_check;

alter table public.pass_email_verifications
  add constraint pass_email_verifications_delivery_status_check
  check (delivery_status in ('pending', 'sending', 'sent_to_provider', 'delivery_failed', 'outcome_unknown'));

alter table public.pass_email_verifications
  drop constraint if exists pass_email_verifications_code_delivery_status_check;

alter table public.pass_email_verifications
  add constraint pass_email_verifications_code_delivery_status_check
  check (code_delivery_status in ('code_sending', 'sent_to_provider', 'delivery_failed', 'outcome_unknown'));

create index if not exists pass_email_verifications_pass_created_idx
  on public.pass_email_verifications (pass_id, created_at desc);

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
  v_recent_count integer;
begin
  -- The parent pass row is the common serialization boundary for all code writers.
  select p.id, p.status, p.valid_until, v.owner_id
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

  select count(*) into v_recent_count
    from public.pass_email_verifications ev
   where ev.pass_id = requested_pass_id
     and ev.created_at >= statement_timestamp() - interval '15 minutes';
  if v_recent_count >= 3 then raise exception 'too_many_requests' using errcode = 'P0003'; end if;

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
    return jsonb_build_object('success', true, 'code_delivery_status', v_row.code_delivery_status, 'idempotent_replay', true);
  end if;

  update public.pass_email_verifications ev
     set code_delivery_status = requested_delivery_status,
         code_provider_delivery_id = case when requested_delivery_status = 'sent_to_provider' then requested_provider_delivery_id else null end,
         code_sent_at = case when requested_delivery_status = 'sent_to_provider' then statement_timestamp() else null end
   where ev.id = v_row.id and ev.code_delivery_status = 'code_sending';
  return jsonb_build_object('success', true, 'code_delivery_status', requested_delivery_status, 'idempotent_replay', false);
end;
$$;

revoke all on function api.finalize_email_verification_code(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function api.finalize_email_verification_code(uuid, uuid, text, text) to service_role;

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
  v_verification record;
  v_pass record;
  v_conflict uuid;
  v_recipient text := lower(trim(requested_recipient_email));
begin
  select p.status, p.valid_until, v.owner_id into v_pass
    from public.passes p
    join public.visitors v on v.id = p.visitor_id
   where p.id = requested_pass_id
   for update;
  if not found then raise exception 'pass_not_found' using errcode = 'P0002'; end if;
  if v_pass.owner_id <> requested_actor_id then raise exception 'access_denied' using errcode = '42501'; end if;
  if v_pass.status <> 'issued' then raise exception 'pass_not_active' using errcode = 'P0001'; end if;
  if v_pass.valid_until <= statement_timestamp() then raise exception 'pass_expired' using errcode = 'P0001'; end if;

  -- Use the same parent-pass -> verification-row lock order as code requests.
  select ev.* into v_verification
    from public.pass_email_verifications ev
   where ev.id = requested_verification_id and ev.pass_id = requested_pass_id
   for update;
  if not found then raise exception 'verification_not_found' using errcode = 'P0002'; end if;

  if lower(trim(v_verification.recipient_email)) <> v_recipient then raise exception 'recipient_mismatch' using errcode = 'P0008'; end if;
  if v_verification.code_delivery_status <> 'sent_to_provider' then
    raise exception 'verification_delivery_unconfirmed' using errcode = 'P0005';
  end if;

  -- Replay is evaluated only after all current authorization and tuple checks.
  if v_verification.send_request_id = requested_send_request_id then
    if v_verification.delivery_status = 'sending'
      and v_verification.dispatch_claimed_at < statement_timestamp() - interval '15 minutes' then
      update public.pass_email_verifications ev
         set delivery_status = 'outcome_unknown'
       where ev.id = v_verification.id and ev.delivery_status = 'sending';
      v_verification.delivery_status := 'outcome_unknown';
      return jsonb_build_object(
        'success', true,
        'delivery_status', v_verification.delivery_status,
        'dispatch_authorized', false,
        'stale_claim_promoted', true,
        'idempotent_replay', true
      );
    end if;
    return jsonb_build_object(
      'success', true,
      'delivery_status', v_verification.delivery_status,
      'dispatch_authorized', false,
      'stale_claim_promoted', false,
      'idempotent_replay', true
    );
  end if;

  select ev.id into v_conflict
    from public.pass_email_verifications ev
   where ev.send_request_id = requested_send_request_id and ev.id <> requested_verification_id;
  if found then raise exception 'idempotency_key_mismatch' using errcode = 'P0008'; end if;

  if v_verification.delivery_status in ('sending', 'sent_to_provider', 'outcome_unknown') then
    raise exception 'dispatch_in_progress' using errcode = 'P0005';
  end if;
  if v_verification.expires_at <= statement_timestamp() then raise exception 'code_expired' using errcode = 'P0006'; end if;
  if v_verification.attempts >= 3 then raise exception 'max_attempts_exceeded' using errcode = 'P0007'; end if;

  if v_verification.code_hash <> requested_expected_hash then
    update public.pass_email_verifications ev set attempts = ev.attempts + 1 where ev.id = v_verification.id;
    return jsonb_build_object(
      'success', false,
      'error', 'invalid_code',
      'attempts_remaining', greatest(0, 2 - v_verification.attempts),
      'delivery_status', v_verification.delivery_status,
      'dispatch_authorized', false,
      'idempotent_replay', false
    );
  end if;

  update public.pass_email_verifications ev
     set verified = true, delivery_status = 'sending',
         send_request_id = requested_send_request_id, dispatch_claimed_at = statement_timestamp()
   where ev.id = v_verification.id;
  return jsonb_build_object(
    'success', true,
    'delivery_status', 'sending',
    'dispatch_authorized', true,
    'stale_claim_promoted', false,
    'idempotent_replay', false
  );
end;
$$;

revoke all on function api.verify_and_claim_email_dispatch(uuid, uuid, uuid, text, text, uuid) from public, anon, authenticated;
grant execute on function api.verify_and_claim_email_dispatch(uuid, uuid, uuid, text, text, uuid) to service_role;

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
    return jsonb_build_object('success', true, 'delivery_status', v_row.delivery_status, 'idempotent_replay', true);
  end if;

  update public.pass_email_verifications ev
     set delivery_status = requested_delivery_status,
         provider_delivery_id = case when requested_delivery_status = 'sent_to_provider' then requested_provider_delivery_id else null end,
         sent_at = case when requested_delivery_status = 'sent_to_provider' then statement_timestamp() else null end
   where ev.id = v_row.id and ev.delivery_status = 'sending' and ev.send_request_id = requested_send_request_id;
  return jsonb_build_object('success', true, 'delivery_status', requested_delivery_status, 'idempotent_replay', false);
end;
$$;

revoke all on function api.finalize_email_dispatch(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function api.finalize_email_dispatch(uuid, uuid, text, text) to service_role;
