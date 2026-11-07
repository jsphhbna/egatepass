-- Migration 67: Durable Email Recovery, Claim Invariants & Webhook Reconciliation
-- Updates api.record_resend_delivery_event to reconcile 'reconciliation_required' outbox status upon email.sent event
-- Updates api.claim_office_visit_email_for_delivery to block claiming 'reconciliation_required' rows
-- Updates api.record_office_visit_email_result to allow bounded recovery of 'reconciliation_required' and return jsonb

-- 1. Reconcile api.claim_office_visit_email_for_delivery
create or replace function api.claim_office_visit_email_for_delivery(
  requested_visit_id uuid,
  requested_email_type text
)
returns table (
  outbox_id uuid,
  office_visit_id uuid,
  email_type text,
  recipient_email text,
  encrypted_token_payload text,
  rejection_reason text,
  attempt_count integer,
  claim_id uuid,
  idempotency_key text
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  target_outbox public.office_visit_email_outbox%rowtype;
  new_claim_id uuid;
  v_lease_expiry timestamptz;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'service role required';
  end if;

  select * into target_outbox
  from public.office_visit_email_outbox oveo
  where oveo.office_visit_id = requested_visit_id and oveo.email_type = requested_email_type
  for update;

  if not found then
    return;
  end if;

  if target_outbox.delivery_status in ('sent', 'delivered') then
    raise exception using errcode = '40900', message = 'email_already_sent_or_delivered';
  end if;

  if target_outbox.delivery_status in ('unknown', 'reconciliation_required') then
    raise exception using errcode = '40900', message = 'email_delivery_outcome_unknown_reconciliation_required';
  end if;

  if target_outbox.delivery_status = 'processing' then
    if target_outbox.lease_expires_at is not null and target_outbox.lease_expires_at > now() then
      raise exception using errcode = '40900', message = 'email_lease_active_in_progress';
    end if;
  end if;

  new_claim_id := gen_random_uuid();
  v_lease_expiry := now() + interval '5 minutes';

  if target_outbox.idempotency_key is null then
    target_outbox.idempotency_key := 'office-email-' || target_outbox.id::text;
  end if;

  update public.office_visit_email_outbox set
    delivery_status = 'processing',
    claim_id = new_claim_id,
    claimed_at = now(),
    lease_expires_at = v_lease_expiry,
    retry_count = target_outbox.retry_count + 1,
    idempotency_key = target_outbox.idempotency_key,
    last_attempt_at = now(),
    updated_at = now()
  where id = target_outbox.id;

  update public.office_visits set
    email_delivery_status = 'processing',
    updated_at = now()
  where id = target_outbox.office_visit_id;

  return query select
    target_outbox.id,
    target_outbox.office_visit_id,
    target_outbox.email_type,
    target_outbox.recipient_email,
    target_outbox.encrypted_token_payload,
    target_outbox.rejection_reason,
    target_outbox.retry_count + 1,
    new_claim_id,
    target_outbox.idempotency_key;
end;
$$;

revoke all on function api.claim_office_visit_email_for_delivery(uuid, text) from public, anon, authenticated;
grant execute on function api.claim_office_visit_email_for_delivery(uuid, text) to service_role;

-- 2. Reconcile api.record_office_visit_email_result
drop function if exists api.record_office_visit_email_result(uuid, uuid, text, text, text);

create or replace function api.record_office_visit_email_result(
  requested_outbox_id uuid,
  requested_claim_id uuid,
  requested_status text,
  requested_provider_message_id text default null,
  requested_error text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  target_outbox public.office_visit_email_outbox%rowtype;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'service role required';
  end if;

  if requested_status not in ('sent', 'delivered', 'failed', 'unknown', 'reconciliation_required') then
    raise exception using errcode = '22023', message = 'invalid_delivery_status';
  end if;

  select * into target_outbox from public.office_visit_email_outbox
  where id = requested_outbox_id for update;

  if not found then
    return jsonb_build_object('ok', false, 'error', 'outbox_record_not_found');
  end if;

  -- 1. Active claim verification: stale worker cannot overwrite newer claim or cleared claim
  if target_outbox.claim_id is null or requested_claim_id is null or target_outbox.claim_id <> requested_claim_id then
    raise exception using errcode = '40900', message = 'stale_or_invalid_claim_cannot_overwrite';
  end if;

  -- 2. Lease expiry verification: allow reconciliation_required even if lease expired to protect against duplicate send
  if requested_status <> 'reconciliation_required' and target_outbox.lease_expires_at is not null and target_outbox.lease_expires_at < now() then
    raise exception using errcode = '40900', message = 'expired_claim_cannot_overwrite';
  end if;

  -- 3. Terminal state protection: never regress delivered
  if target_outbox.delivery_status = 'delivered' and requested_status <> 'delivered' then
    return jsonb_build_object('ok', true, 'status', 'delivered', 'noop', true);
  end if;

  -- 4. Never overwrite sent or delivered with failure or unknown
  if target_outbox.delivery_status in ('sent', 'delivered') and requested_status in ('failed', 'unknown') then
    return jsonb_build_object('ok', true, 'status', target_outbox.delivery_status, 'noop', true);
  end if;

  update public.office_visit_email_outbox set
    delivery_status = requested_status,
    provider_message_id = coalesce(requested_provider_message_id, provider_message_id),
    last_error = requested_error,
    claim_id = null,
    lease_expires_at = null,
    delivered_at = case when requested_status = 'delivered' then now() else delivered_at end,
    updated_at = now()
  where id = requested_outbox_id;

  update public.office_visits set
    email_delivery_status = requested_status,
    email_dispatched_at = case when requested_status in ('sent', 'delivered') then coalesce(email_dispatched_at, now()) else email_dispatched_at end,
    email_error = requested_error,
    updated_at = now()
  where id = target_outbox.office_visit_id;

  return jsonb_build_object(
    'ok', true,
    'outbox_id', requested_outbox_id,
    'status', requested_status
  );
end;
$$;

revoke all on function api.record_office_visit_email_result(uuid, uuid, text, text, text) from public, anon, authenticated;
grant execute on function api.record_office_visit_email_result(uuid, uuid, text, text, text) to service_role;

-- 3. Reconcile api.record_resend_delivery_event
drop function if exists api.record_resend_delivery_event(text, text, text, text, text, text, timestamptz);
drop function if exists api.record_resend_delivery_event(text, text, text, text, text, text, timestamptz, uuid);

create or replace function api.record_resend_delivery_event(
  requested_provider_event_id text,
  requested_event_type text,
  requested_email_id text,
  requested_outcome text,
  requested_recipient_masked text,
  requested_subject_sanitized text,
  requested_occurred_at timestamptz,
  requested_outbox_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_inserted_id uuid;
  v_audit_id bigint;
  v_outcome text;
  v_occurred timestamptz;
  v_office_outbox public.office_visit_email_outbox%rowtype;
begin
  if auth.role() <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;

  if requested_provider_event_id is null or trim(requested_provider_event_id) = '' then
    raise exception 'missing_provider_event_id' using errcode = '22023';
  end if;

  if requested_event_type is null or trim(requested_event_type) = '' then
    raise exception 'missing_event_type' using errcode = '22023';
  end if;

  v_occurred := coalesce(requested_occurred_at, now());
  v_outcome := case
    when requested_outcome in ('success', 'denied', 'partial', 'failure') then requested_outcome
    else 'failure'
  end;

  -- 1. Claim provider event ID idempotently
  begin
    insert into public.resend_webhook_events (
      provider_event_id,
      event_type,
      email_id,
      created_at
    )
    values (
      trim(requested_provider_event_id),
      trim(requested_event_type),
      trim(requested_email_id),
      v_occurred
    )
    returning id into v_inserted_id;
  exception when unique_violation then
    return jsonb_build_object(
      'ok', true,
      'status', 'already_processed',
      'duplicate', true,
      'provider_event_id', trim(requested_provider_event_id),
      'event_type', trim(requested_event_type),
      'email_id', trim(requested_email_id)
    );
  end;

  -- 2. Correlate with office visit email outbox: match by provider message ID OR stable outbox correlation ID
  select * into v_office_outbox
  from public.office_visit_email_outbox
  where (
    (trim(requested_email_id) <> '' and provider_message_id = trim(requested_email_id))
    or (requested_outbox_id is not null and id = requested_outbox_id)
  )
  for update;

  if found then
    -- Record provider message ID if missing on outbox (e.g. transport timeout on initial send)
    if v_office_outbox.provider_message_id is null and trim(requested_email_id) <> '' then
      update public.office_visit_email_outbox
      set provider_message_id = trim(requested_email_id)
      where id = v_office_outbox.id;
    end if;

    if trim(requested_event_type) = 'email.delivered' then
      -- If not already delivered, OR if previously only marked delivered by manual staff,
      -- record authoritative provider delivery while preserving manual reconciliation audit history.
      if v_office_outbox.delivery_status <> 'delivered' or v_office_outbox.confirmation_source = 'manual_staff' then
        update public.office_visit_email_outbox set
          delivery_status = 'delivered',
          delivered_at = v_occurred,
          claim_id = null,
          lease_expires_at = null,
          reconciliation_source = 'resend_webhook',
          confirmation_source = 'provider_webhook',
          updated_at = now()
        where id = v_office_outbox.id;

        update public.office_visits set
          email_delivery_status = 'delivered',
          confirmation_source = 'provider_webhook',
          updated_at = now()
        where id = v_office_outbox.office_visit_id;
      end if;
    elsif trim(requested_event_type) in ('email.bounced', 'email.complained', 'email.failed') then
      -- Do not regress if already confirmed delivered
      if v_office_outbox.delivery_status <> 'delivered' then
        update public.office_visit_email_outbox set
          delivery_status = 'failed',
          last_error = trim(requested_event_type),
          claim_id = null,
          lease_expires_at = null,
          reconciliation_source = 'resend_webhook',
          confirmation_source = null,
          reconciled_by = null,
          updated_at = now()
        where id = v_office_outbox.id;

        update public.office_visits set
          email_delivery_status = 'failed',
          email_error = trim(requested_event_type),
          confirmation_source = null,
          updated_at = now()
        where id = v_office_outbox.office_visit_id;
      end if;
    elsif trim(requested_event_type) = 'email.sent' then
      -- Allow transitioning from pending, processing, unknown, OR reconciliation_required
      if v_office_outbox.delivery_status in ('pending', 'processing', 'unknown', 'reconciliation_required') then
        update public.office_visit_email_outbox set
          delivery_status = 'sent',
          claim_id = null,
          lease_expires_at = null,
          reconciliation_source = 'resend_webhook',
          updated_at = now()
        where id = v_office_outbox.id;

        update public.office_visits set
          email_delivery_status = 'sent',
          email_dispatched_at = coalesce(email_dispatched_at, v_occurred),
          updated_at = now()
        where id = v_office_outbox.office_visit_id;
      end if;
    end if;

    -- Record event in office_visit_events
    insert into public.office_visit_events (
      office_visit_id, event_type, actor_id, actor_role, metadata
    ) values (
      v_office_outbox.office_visit_id,
      'resend_delivery_event',
      null,
      'system',
      jsonb_build_object(
        'provider_event_id', trim(requested_provider_event_id),
        'event_type', trim(requested_event_type),
        'email_id', trim(requested_email_id),
        'occurred_at', v_occurred,
        'confirmation_source', 'provider_webhook'
      )
    );
  end if;

  -- 3. Insert append-only audit event
  insert into public.audit_events (
    action,
    actor_kind,
    actor_role,
    target_type,
    target_id,
    outcome,
    after_state,
    occurred_at
  )
  values (
    'resend.delivery_event',
    'system',
    'webhook',
    'email',
    trim(requested_email_id),
    v_outcome,
    jsonb_build_object(
      'eventType', trim(requested_event_type),
      'emailId', trim(requested_email_id),
      'outboxId', requested_outbox_id,
      'providerEventId', trim(requested_provider_event_id),
      'recipientMasked', requested_recipient_masked,
      'subjectSanitized', requested_subject_sanitized,
      'correlatedOfficeOutboxId', v_office_outbox.id,
      'delivery_status', case
        when trim(requested_event_type) = 'email.delivered' then 'delivered'
        when trim(requested_event_type) in ('email.bounced', 'email.complained', 'email.failed') then 'failed'
        when trim(requested_event_type) = 'email.sent' then 'sent'
        else 'other'
      end,
      'timestamp', to_char(v_occurred at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    ),
    v_occurred
  )
  returning id into v_audit_id;

  return jsonb_build_object(
    'ok', true,
    'status', 'processed',
    'duplicate', false,
    'provider_event_id', trim(requested_provider_event_id),
    'event_id', v_inserted_id,
    'audit_id', v_audit_id,
    'email_id', trim(requested_email_id),
    'event_type', trim(requested_event_type),
    'outcome', v_outcome,
    'correlated_office_outbox_id', v_office_outbox.id
  );
end;
$$;

revoke all on function api.record_resend_delivery_event(text, text, text, text, text, text, timestamptz, uuid) from public, anon, authenticated;
grant execute on function api.record_resend_delivery_event(text, text, text, text, text, text, timestamptz, uuid) to service_role;

-- Backward-compatibility 7-parameter overload
create or replace function api.record_resend_delivery_event(
  requested_provider_event_id text,
  requested_event_type text,
  requested_email_id text,
  requested_outcome text,
  requested_recipient_masked text,
  requested_subject_sanitized text,
  requested_occurred_at timestamptz default now()
)
returns jsonb
language sql
volatile
security definer
set search_path = ''
as $$
  select api.record_resend_delivery_event(
    requested_provider_event_id,
    requested_event_type,
    requested_email_id,
    requested_outcome,
    requested_recipient_masked,
    requested_subject_sanitized,
    requested_occurred_at,
    null::uuid
  );
$$;

revoke all on function api.record_resend_delivery_event(text, text, text, text, text, text, timestamptz) from public, anon, authenticated;
grant execute on function api.record_resend_delivery_event(text, text, text, text, text, text, timestamptz) to service_role;
