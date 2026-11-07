-- ==============================================================================
-- Migration 66: Post-Release Root-Cause Closure & Production Reliability Remediation
--
-- 1. IP Privacy: replace raw client_ip with keyed ip_hmac on office_visit_email_verifications
-- 2. Deadlock-free sorted multi-dimensional advisory locking in request_office_email_verification_slot
-- 3. Provenance tracking: confirmation_source ('manual_staff' vs 'provider_webhook') and manual_confirmed_at
-- 4. Reconcile api.reconcile_office_visit_email and api.record_resend_delivery_event for truthful provenance
-- 5. Prevent duplicate returning visitor vehicle declarations with unique index
-- ==============================================================================

-- 1. IP Privacy on office_visit_email_verifications
alter table public.office_visit_email_verifications
  add column if not exists ip_hmac text default null;

create index if not exists idx_office_email_verif_ip_hmac_created
  on public.office_visit_email_verifications(ip_hmac, created_at);

-- Clear any legacy raw IP storage for privacy compliance
update public.office_visit_email_verifications
  set client_ip = null
  where client_ip is not null;

drop index if exists public.idx_office_email_verif_ip_created;

-- 2. Delivery Provenance tracking on office_visit_email_outbox and office_visits
alter table public.office_visit_email_outbox
  add column if not exists confirmation_source text default null check (confirmation_source in ('manual_staff', 'provider_webhook')),
  add column if not exists manual_confirmed_at timestamptz default null;

alter table public.office_visits
  add column if not exists confirmation_source text default null check (confirmation_source in ('manual_staff', 'provider_webhook'));

-- 3. Unique index for returning visitor vehicles to prevent duplicate entries on retry
delete from public.returning_visitor_vehicles a
using public.returning_visitor_vehicles b
where a.profile_id = b.profile_id
  and a.plate_key = b.plate_key
  and a.archived_at is null
  and b.archived_at is null
  and a.created_at < b.created_at;

create unique index if not exists returning_visitor_vehicles_profile_plate_uniq
  on public.returning_visitor_vehicles(profile_id, plate_key)
  where archived_at is null;

-- 4. Multi-dimensional sorted advisory locking in request_office_email_verification_slot
drop function if exists api.request_office_email_verification_slot(uuid, text, text, text, timestamptz);

create or replace function api.request_office_email_verification_slot(
  requested_actor_id uuid,
  requested_email text,
  requested_ip_hmac text,
  requested_code_hash text,
  requested_expires_at timestamptz
)
returns table (
  allowed boolean,
  error_code text,
  verification_id uuid
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  lock_keys bigint[];
  k bigint;
  window_start timestamptz := now() - interval '15 minutes';
  actor_cnt integer;
  email_cnt integer;
  ip_cnt integer;
  inserted_id uuid;
  norm_email text;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'service role required';
  end if;

  norm_email := lower(btrim(requested_email));
  if norm_email is null or char_length(norm_email) = 0 then
    return query select false, 'invalid_email'::text, null::uuid;
    return;
  end if;

  -- Derive 64-bit advisory lock keys for actor, email, and IP (if provided)
  lock_keys := array[
    ('x' || substr(md5('act:' || requested_actor_id::text), 1, 16))::bit(64)::bigint,
    ('x' || substr(md5('eml:' || norm_email), 1, 16))::bit(64)::bigint
  ];

  if requested_ip_hmac is not null and btrim(requested_ip_hmac) <> '' then
    lock_keys := array_append(lock_keys, ('x' || substr(md5('ip:' || btrim(requested_ip_hmac)), 1, 16))::bit(64)::bigint);
  end if;

  -- Acquire all advisory locks in strict ascending integer order to guarantee deadlock-free concurrency
  for k in (select distinct unnest(lock_keys) as lk order by lk asc) loop
    perform pg_advisory_xact_lock(k);
  end loop;

  -- 1. Check rate limit for actor (max 5 per 15m)
  select count(*) into actor_cnt
  from public.office_visit_email_verifications
  where actor_id = requested_actor_id
    and created_at > window_start;

  if actor_cnt >= 5 then
    return query select false, 'too_many_actor_requests'::text, null::uuid;
    return;
  end if;

  -- 2. Check rate limit for normalized email (max 5 per 15m)
  select count(*) into email_cnt
  from public.office_visit_email_verifications
  where email = norm_email
    and created_at > window_start;

  if email_cnt >= 5 then
    return query select false, 'too_many_email_requests'::text, null::uuid;
    return;
  end if;

  -- 3. Check rate limit for client IP HMAC (max 15 per 15m) if provided
  if requested_ip_hmac is not null and btrim(requested_ip_hmac) <> '' then
    select count(*) into ip_cnt
    from public.office_visit_email_verifications
    where ip_hmac = btrim(requested_ip_hmac)
      and created_at > window_start;

    if ip_cnt >= 15 then
      return query select false, 'too_many_ip_requests'::text, null::uuid;
      return;
    end if;
  end if;

  -- Insert challenge row atomically
  insert into public.office_visit_email_verifications (
    email,
    code_hash,
    actor_id,
    ip_hmac,
    expires_at,
    verified,
    attempts
  ) values (
    norm_email,
    requested_code_hash,
    requested_actor_id,
    nullif(btrim(requested_ip_hmac), ''),
    requested_expires_at,
    false,
    0
  )
  returning id into inserted_id;

  return query select true, null::text, inserted_id;
end;
$$;

revoke all on function api.request_office_email_verification_slot(uuid, text, text, text, timestamptz) from public, anon, authenticated;
grant execute on function api.request_office_email_verification_slot(uuid, text, text, text, timestamptz) to service_role;

-- 5. Reconcile api.reconcile_office_visit_email (truthful manual confirmation provenance)
create or replace function api.reconcile_office_visit_email(
  requested_actor_id uuid,
  requested_visit_id uuid,
  requested_action text,
  requested_note text default null
)
returns table (
  ok boolean,
  action text,
  new_status text,
  message text
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  target_visit public.office_visits%rowtype;
  target_outbox public.office_visit_email_outbox%rowtype;
  actor_profile public.staff_profiles%rowtype;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'service role required';
  end if;

  if requested_action not in ('mark_delivered', 'permit_retry') then
    raise exception using errcode = '22023', message = 'invalid_reconciliation_action';
  end if;

  -- 1. Validate staff actor
  select * into actor_profile from public.staff_profiles
  where user_id = requested_actor_id and active;
  if not found then
    raise exception using errcode = '42501', message = 'active_staff_required';
  end if;

  -- 2. Lock visit record
  select * into target_visit from public.office_visits
  where id = requested_visit_id for update;
  if not found then
    raise exception using errcode = '22023', message = 'visit_not_found';
  end if;

  -- 3. Validate office assignment (unless admin/superadmin)
  if actor_profile.role not in ('admin', 'superadmin') then
    if not exists (
      select 1 from public.office_staff_assignments a
      where a.office_id = target_visit.office_id and a.user_id = requested_actor_id
    ) then
      raise exception using errcode = '42501', message = 'unauthorized_for_this_office';
    end if;
  end if;

  -- 4. Lock outbox record
  select * into target_outbox from public.office_visit_email_outbox
  where office_visit_id = requested_visit_id
  for update;
  if not found then
    raise exception using errcode = '22023', message = 'outbox_record_not_found';
  end if;

  if target_outbox.delivery_status = 'delivered' then
    raise exception using errcode = '40900', message = 'email_already_delivered';
  end if;

  if requested_action = 'mark_delivered' then
    if requested_note is null or char_length(btrim(requested_note)) < 3 then
      raise exception using errcode = '22023', message = 'reconciliation_note_required_for_manual_delivery';
    end if;

    update public.office_visit_email_outbox set
      delivery_status = 'delivered',
      claim_id = null,
      lease_expires_at = null,
      last_error = btrim(requested_note),
      reconciled_by = requested_actor_id,
      reconciliation_source = 'manual_staff',
      confirmation_source = 'manual_staff',
      manual_confirmed_at = now(),
      reconciliation_note = btrim(requested_note),
      updated_at = now()
    where id = target_outbox.id;

    update public.office_visits set
      email_delivery_status = 'delivered',
      confirmation_source = 'manual_staff',
      updated_at = now()
    where id = target_visit.id;

    insert into public.office_visit_events (
      office_visit_id, event_type, actor_id, actor_role, metadata
    ) values (
      target_visit.id, 'email_reconciled', requested_actor_id, actor_profile.role::text,
      jsonb_build_object(
        'action', 'mark_delivered',
        'previous_status', target_outbox.delivery_status,
        'new_status', 'delivered',
        'confirmation_source', 'manual_staff',
        'note', btrim(requested_note)
      )
    );

    return query select true, 'mark_delivered'::text, 'delivered'::text, 'Email delivery manually confirmed by staff.'::text;
    return;
  elsif requested_action = 'permit_retry' then
    update public.office_visit_email_outbox set
      delivery_status = 'failed',
      claim_id = null,
      lease_expires_at = null,
      last_error = coalesce(btrim(requested_note), 'Retry permitted by staff after uncertain delivery.'),
      reconciled_by = requested_actor_id,
      reconciliation_source = 'manual_staff',
      confirmation_source = null,
      reconciliation_note = btrim(requested_note),
      updated_at = now()
    where id = target_outbox.id;

    update public.office_visits set
      email_delivery_status = 'failed',
      email_error = coalesce(btrim(requested_note), 'Retry permitted by staff.'),
      confirmation_source = null,
      updated_at = now()
    where id = target_visit.id;

    insert into public.office_visit_events (
      office_visit_id, event_type, actor_id, actor_role, metadata
    ) values (
      target_visit.id, 'email_reconciled', requested_actor_id, actor_profile.role::text,
      jsonb_build_object(
        'action', 'permit_retry',
        'previous_status', target_outbox.delivery_status,
        'new_status', 'failed',
        'note', btrim(requested_note)
      )
    );

    return query select true, 'permit_retry'::text, 'failed'::text, 'Delivery reset to failed; retry permitted.'::text;
    return;
  end if;
end;
$$;

revoke all on function api.reconcile_office_visit_email(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function api.reconcile_office_visit_email(uuid, uuid, text, text) to service_role;

-- 6. Reconcile api.record_resend_delivery_event (truthful provider confirmation without destroying manual audit)
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
      if v_office_outbox.delivery_status in ('pending', 'processing', 'unknown') then
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
