-- Migration: 20261027000200_offline_operations_reliability_closure.sql
-- Description: Targeted reliability and security closure pass:
--              1. Kiosk operator PIN security table and server verification RPC with brute-force lockout.
--              2. visitors source check constraint repair permitting 'guard_offline'.
--              3. Offline registration RPC rewrite matching actual visitors/visitor_evidence schemas,
--                 strictly requiring ID evidence on approval, and fingerprint idempotency.
--              4. Offline event RPC rewrite with version fencing, server-enforced legal status
--                 transitions, and real reconciliation_tasks schema inserts.
--              5. Dedicated paginated offline recovery snapshot RPC (api.guard_offline_snapshot_page).
--              6. Strict server-side thermal print template layout validation.

-- =============================================================================
-- 1. REPAIR public.visitors SOURCE CONSTRAINT (R02)
-- =============================================================================
alter table public.visitors drop constraint if exists visitors_check;
alter table public.visitors drop constraint if exists visitors_source_check;

alter table public.visitors add constraint visitors_source_check check (
  (source = 'portal'::public.pass_source and created_by_device_id is null) or
  (source = 'kiosk'::public.pass_source and created_by_device_id is not null) or
  (source = 'guard_offline'::public.pass_source and created_by_device_id is null and owner_id is not null)
);

-- =============================================================================
-- 2. KIOSK OPERATOR CONFIGURATION & SERVER-SIDE PIN SECURITY (R01)
-- =============================================================================
create table if not exists private.kiosk_operator_config (
  singleton boolean primary key default true check (singleton),
  pin_salt text not null,
  pin_hash text not null,
  failed_attempts integer not null default 0 check (failed_attempts >= 0),
  locked_until timestamptz,
  updated_at timestamptz not null default statement_timestamp(),
  updated_by uuid references auth.users(id)
);

-- Seed initial non-guessable 6-digit institutional PIN salted hash ('839174')
-- Salt: 64-char hex; Hash: sha256('kiosk_pin:' || salt || ':' || '839174')
-- Never matches any of: 1234, 9999, abcd, 0000, 1904, 123456
insert into private.kiosk_operator_config (
  singleton,
  pin_salt,
  pin_hash,
  failed_attempts,
  locked_until,
  updated_at
) values (
  true,
  'c4d8e9f1a2b3c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0',
  encode(sha256(('kiosk_pin:c4d8e9f1a2b3c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0:839174')::bytea), 'hex'),
  0,
  null,
  statement_timestamp()
) on conflict (singleton) do nothing;

create or replace function api.verify_kiosk_operator_pin(
  requested_pin text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  caller_device_type public.device_type := (select private.current_device_type());
  caller_role public.staff_role := (select private.current_staff_role());
  cfg record;
  clean_pin text := btrim(coalesce(requested_pin, ''));
  computed_hash text;
  is_valid boolean;
  new_failures integer;
  lock_duration interval := interval '5 minutes';
  remaining_seconds integer;
begin
  if (select private.is_recovery_session()) then
    raise exception using errcode = '42501', message = 'recovery_session_forbidden';
  end if;

  -- Caller must be an authenticated kiosk device or authorized staff member
  if caller_device_type is distinct from 'kiosk'::public.device_type
     and (caller_role is null or caller_role not in ('guard'::public.staff_role, 'admin'::public.staff_role, 'superadmin'::public.staff_role)) then
    raise exception using errcode = '42501', message = 'kiosk_or_staff_required';
  end if;

  select * into cfg from private.kiosk_operator_config where singleton = true for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'kiosk_operator_config_missing';
  end if;

  -- Check lockout
  if cfg.locked_until is not null and cfg.locked_until > statement_timestamp() then
    remaining_seconds := ceil(extract(epoch from (cfg.locked_until - statement_timestamp())))::integer;
    return jsonb_build_object(
      'valid', false,
      'locked', true,
      'retryAfterSeconds', greatest(remaining_seconds, 1)
    );
  end if;

  -- Format validation: require 6 to 12 numeric digits
  if clean_pin !~ '^[0-9]{6,12}$' then
    new_failures := cfg.failed_attempts + 1;
    update private.kiosk_operator_config set
      failed_attempts = new_failures,
      locked_until = case when new_failures >= 5 then statement_timestamp() + lock_duration else null end,
      updated_at = statement_timestamp()
    where singleton = true;

    return jsonb_build_object(
      'valid', false,
      'locked', (new_failures >= 5),
      'retryAfterSeconds', case when new_failures >= 5 then 300 else null end
    );
  end if;

  -- Compare salted SHA-256 hash
  computed_hash := encode(sha256(('kiosk_pin:' || cfg.pin_salt || ':' || clean_pin)::bytea), 'hex');
  is_valid := (computed_hash = cfg.pin_hash);

  if is_valid then
    update private.kiosk_operator_config set
      failed_attempts = 0,
      locked_until = null,
      updated_at = statement_timestamp()
    where singleton = true;

    return jsonb_build_object('valid', true);
  else
    new_failures := cfg.failed_attempts + 1;
    update private.kiosk_operator_config set
      failed_attempts = new_failures,
      locked_until = case when new_failures >= 5 then statement_timestamp() + lock_duration else null end,
      updated_at = statement_timestamp()
    where singleton = true;

    return jsonb_build_object(
      'valid', false,
      'locked', (new_failures >= 5),
      'retryAfterSeconds', case when new_failures >= 5 then 300 else null end
    );
  end if;
end;
$$;

create or replace function api.admin_set_kiosk_operator_pin(
  new_pin text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  caller_role public.staff_role := (select private.current_staff_role());
  caller_id uuid := (select auth.uid());
  clean_pin text := btrim(coalesce(new_pin, ''));
  new_salt text;
  new_hash text;
begin
  if (select private.is_recovery_session()) then
    raise exception using errcode = '42501', message = 'recovery_session_forbidden';
  end if;

  if caller_role is distinct from 'superadmin'::public.staff_role then
    raise exception using errcode = '42501', message = 'superadmin_required';
  end if;

  if clean_pin !~ '^[0-9]{6,12}$' then
    raise exception using errcode = '22023', message = 'pin_must_be_6_to_12_digits';
  end if;

  new_salt := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
  new_hash := encode(sha256(('kiosk_pin:' || new_salt || ':' || clean_pin)::bytea), 'hex');

  insert into private.kiosk_operator_config (
    singleton, pin_salt, pin_hash, failed_attempts, locked_until, updated_at, updated_by
  ) values (
    true, new_salt, new_hash, 0, null, statement_timestamp(), caller_id
  ) on conflict (singleton) do update set
    pin_salt = new_salt,
    pin_hash = new_hash,
    failed_attempts = 0,
    locked_until = null,
    updated_at = statement_timestamp(),
    updated_by = caller_id;

  return jsonb_build_object('success', true);
end;
$$;

revoke all on function api.verify_kiosk_operator_pin(text) from public, anon;
revoke all on function api.admin_set_kiosk_operator_pin(text) from public, anon;
grant execute on function api.verify_kiosk_operator_pin(text) to authenticated;
grant execute on function api.admin_set_kiosk_operator_pin(text) to authenticated;

-- =============================================================================
-- 3. OFFLINE SYNC RECEIPTS HARDENING (R07)
-- =============================================================================
alter table public.offline_sync_receipts
  add column if not exists fingerprint text;

-- =============================================================================
-- 4. REPAIR api.guard_sync_offline_registration (R02, R03, R04, R07, R09)
-- =============================================================================
drop function if exists api.guard_sync_offline_registration(uuid, jsonb, text, timestamptz, uuid, uuid, text);

create or replace function api.guard_sync_offline_registration(
  requested_registration_id uuid,
  requested_visitor jsonb,
  requested_action text,
  requested_occurred_at timestamptz,
  requested_photo_intent_id uuid,
  requested_photo_byte_size integer,
  requested_photo_sha256 text,
  requested_id_intent_id uuid default null,
  requested_id_byte_size integer default null,
  requested_id_sha256 text default null,
  requested_rejection_reason text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor public.staff_profiles%rowtype;
  existing_receipt public.offline_sync_receipts%rowtype;
  new_visitor_id uuid := gen_random_uuid();
  new_pass_id uuid := gen_random_uuid();
  new_public_ref uuid := gen_random_uuid();
  pass_status_val public.pass_status;
  first_name_val text := btrim(coalesce(requested_visitor->>'firstName', ''));
  middle_name_val text := nullif(btrim(coalesce(requested_visitor->>'middleName', '')), '');
  last_name_val text := btrim(coalesce(requested_visitor->>'lastName', ''));
  full_name_val text;
  contact_number_val text := btrim(coalesce(requested_visitor->>'contactNumber', ''));
  email_val text := nullif(btrim(coalesce(requested_visitor->>'email', '')), '');
  purpose_val text := btrim(coalesce(requested_visitor->>'purpose', ''));
  visit_date_str text := btrim(coalesce(requested_visitor->>'visitDate', ''));
  visit_date_val date;
  raw_token text;
  token_digest_val bytea;
  photo_intent public.upload_intents%rowtype;
  id_intent public.upload_intents%rowtype;
  v_day_start timestamptz;
  v_day_end timestamptz;
  v_fingerprint text;
  v_norm_visitor text;
  res jsonb;
begin
  if (select private.is_recovery_session()) then
    raise exception using errcode = '42501', message = 'recovery_session_forbidden';
  end if;

  select * into actor from public.staff_profiles
  where user_id = (select auth.uid()) and active and not must_change_password
    and privacy_accepted_at is not null for share;
  if not found or actor.role not in ('guard'::public.staff_role, 'superadmin'::public.staff_role) then
    raise exception using errcode = '42501', message = 'active guard or superadmin required';
  end if;

  if requested_action not in ('approved', 'rejected') then
    raise exception using errcode = '22023', message = 'invalid registration action';
  end if;

  -- Timestamp sanity check
  if requested_occurred_at > statement_timestamp() + interval '5 minutes'
     or requested_occurred_at < statement_timestamp() - interval '7 days' then
    insert into public.reconciliation_tasks (
      operation, reference_type, reference_id, safe_context, last_error_code
    ) values (
      'offline_sync_timestamp_skew', 'offline_registration', requested_registration_id::text,
      jsonb_build_object('registrationId', requested_registration_id, 'occurredAt', requested_occurred_at),
      'suspicious_client_timestamp'
    );

    return jsonb_build_object(
      'status', 'conflict',
      'reason', 'suspicious_client_timestamp',
      'registrationId', requested_registration_id
    );
  end if;

  -- Parse and validate visit date (Manila semantics)
  begin
    visit_date_val := visit_date_str::date;
  exception when others then
    raise exception using errcode = '22023', message = 'invalid visit_date format';
  end;

  -- 1. R03 Requirement: Approved offline registration strictly REQUIRES valid ID evidence
  if requested_action = 'approved' then
    if requested_id_intent_id is null or requested_id_byte_size is null or requested_id_sha256 is null then
      raise exception using errcode = '22023', message = 'valid_id_evidence_required_for_approval';
    end if;
  end if;

  -- Mandatory field checks
  if first_name_val = '' or last_name_val = '' or contact_number_val = '' or purpose_val = '' then
    raise exception using errcode = '22023', message = 'missing required visitor registration fields';
  end if;

  full_name_val := first_name_val || coalesce(' ' || middle_name_val, '') || ' ' || last_name_val;

  -- Compute normalized fingerprint (R07)
  v_norm_visitor := lower(btrim(full_name_val)) || '|' || btrim(contact_number_val) || '|' ||
                    lower(coalesce(email_val, '')) || '|' || lower(btrim(purpose_val)) || '|' || visit_date_str;
  v_fingerprint := encode(sha256((
    v_norm_visitor || '|' || requested_action || '|' || requested_occurred_at::text || '|' ||
    requested_photo_sha256 || '|' || coalesce(requested_id_sha256, '')
  )::bytea), 'hex');

  -- 2. Idempotency Check (R07)
  select * into existing_receipt from public.offline_sync_receipts
  where offline_registration_id = requested_registration_id and action = 'register_visitor';
  if found then
    if existing_receipt.fingerprint = v_fingerprint or existing_receipt.fingerprint is null then
      -- Same registration ID + same normalized payload = canonical return
      return jsonb_build_object(
        'status', 'applied',
        'duplicate', true,
        'passId', existing_receipt.pass_id,
        'visitorId', existing_receipt.result->>'visitorId',
        'passStatus', existing_receipt.result->>'passStatus',
        'publicReference', existing_receipt.result->>'publicReference'
      );
    else
      -- Same registration ID + different payload = conflict (R07)
      insert into public.reconciliation_tasks (
        operation, reference_type, reference_id, safe_context, last_error_code
      ) values (
        'offline_registration_payload_conflict', 'offline_registration', requested_registration_id::text,
        jsonb_build_object(
          'registrationId', requested_registration_id,
          'existingFingerprint', existing_receipt.fingerprint,
          'newFingerprint', v_fingerprint
        ),
        'modified_payload_conflict'
      );

      return jsonb_build_object(
        'status', 'conflict',
        'reason', 'modified_payload_conflict',
        'registrationId', requested_registration_id
      );
    end if;
  end if;

  -- 3. Validate and lock Photo Upload Intent (R04)
  select * into photo_intent from public.upload_intents
  where id = requested_photo_intent_id and bucket_id = 'visitor-photos' for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'photo upload intent not found';
  end if;

  if requested_photo_byte_size < 12 or requested_photo_byte_size > 5242880 then
    raise exception using errcode = '22023', message = 'invalid_photo_byte_size';
  end if;
  if requested_photo_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'invalid_photo_sha256';
  end if;

  -- 4. Validate and lock ID Upload Intent if provided (R04)
  if requested_id_intent_id is not null then
    select * into id_intent from public.upload_intents
    where id = requested_id_intent_id and bucket_id = 'visitor-ids' for update;
    if not found then
      raise exception using errcode = 'P0002', message = 'id upload intent not found';
    end if;

    if requested_id_byte_size < 12 or requested_id_byte_size > 5242880 then
      raise exception using errcode = '22023', message = 'invalid_id_byte_size';
    end if;
    if requested_id_sha256 !~ '^[0-9a-f]{64}$' then
      raise exception using errcode = '22023', message = 'invalid_id_sha256';
    end if;
  end if;

  -- 5. Insert visitor using real public.visitors schema (R02)
  insert into public.visitors (
    id, owner_id, source, created_by_device_id, full_name, contact_number,
    email, purpose, visit_date, consent_accepted_at
  ) values (
    new_visitor_id, actor.user_id, 'guard_offline'::public.pass_source, null,
    full_name_val, contact_number_val, email_val, purpose_val,
    visit_date_val, requested_occurred_at
  );

  -- 6. Attach visitor_evidence using real schema (R04)
  update public.upload_intents
  set visitor_id = new_visitor_id, status = 'claimed'::public.upload_intent_status, claimed_at = statement_timestamp()
  where id = photo_intent.id;

  insert into public.visitor_evidence (
    visitor_id, upload_intent_id, kind, bucket_id, object_path,
    content_type, byte_size, sha256_hex, verified_at, expires_at
  ) values (
    new_visitor_id, photo_intent.id, 'photo'::public.evidence_kind, photo_intent.bucket_id,
    photo_intent.object_path, photo_intent.content_type, requested_photo_byte_size,
    requested_photo_sha256, statement_timestamp(), statement_timestamp() + interval '7 days'
  );

  if id_intent.id is not null then
    update public.upload_intents
    set visitor_id = new_visitor_id, status = 'claimed'::public.upload_intent_status, claimed_at = statement_timestamp()
    where id = id_intent.id;

    insert into public.visitor_evidence (
      visitor_id, upload_intent_id, kind, bucket_id, object_path,
      content_type, byte_size, sha256_hex, verified_at, expires_at
    ) values (
      new_visitor_id, id_intent.id, 'id'::public.evidence_kind, id_intent.bucket_id,
      id_intent.object_path, id_intent.content_type, requested_id_byte_size,
      requested_id_sha256, statement_timestamp(), statement_timestamp() + interval '7 days'
    );
  end if;

  -- 7. Generate opaque bearer token digest
  raw_token := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
  token_digest_val := sha256(raw_token::bytea);

  pass_status_val := case when requested_action = 'approved' then 'inside'::public.pass_status else 'rejected'::public.pass_status end;
  v_day_start := date_trunc('day', requested_occurred_at at time zone 'Asia/Manila') at time zone 'Asia/Manila';
  v_day_end := (date_trunc('day', requested_occurred_at at time zone 'Asia/Manila') + interval '1 day') at time zone 'Asia/Manila';

  -- 8. Insert canonical pass record (R09 true offline occurrence time)
  insert into public.passes (
    id, visitor_id, public_reference, token_digest, status, source, offline_registration_id,
    time_in, decided_at, decided_by, rejection_reason,
    valid_from, valid_until, gate, offline_synced_at, version
  ) values (
    new_pass_id, new_visitor_id, new_public_ref, token_digest_val, pass_status_val, 'guard_offline'::public.pass_source,
    requested_registration_id,
    case when requested_action = 'approved' then requested_occurred_at else null end,
    requested_occurred_at, actor.user_id,
    case when requested_action = 'rejected' then coalesce(requested_rejection_reason, 'Rejected offline by guard') else null end,
    v_day_start, v_day_end, 'Offline Gate', statement_timestamp(), 1
  );

  -- 9. Insert visit event with truthful occurred_at (R09)
  insert into public.visit_events (
    pass_id, visitor_id, event, reason, gate, guard_id, occurred_at, request_id, details
  ) values (
    new_pass_id, new_visitor_id,
    case when requested_action = 'approved' then 'approved'::public.visit_event_type else 'rejected'::public.visit_event_type end,
    'guard_offline_registration', 'Offline Gate', actor.user_id, requested_occurred_at, requested_registration_id,
    jsonb_build_object('offline_synced_at', statement_timestamp())
  );

  res := jsonb_build_object(
    'passId', new_pass_id,
    'visitorId', new_visitor_id,
    'passStatus', pass_status_val,
    'publicReference', new_public_ref
  );

  -- 10. Store sync receipt with fingerprint for robust idempotency (R07)
  insert into public.offline_sync_receipts (
    event_id, offline_registration_id, pass_id, action, status, client_occurred_at, actor_id,
    conflict_reason, payload, result, fingerprint
  ) values (
    requested_registration_id, requested_registration_id, new_pass_id, 'register_visitor', 'applied',
    requested_occurred_at, actor.user_id, null, requested_visitor, res, v_fingerprint
  );

  insert into public.audit_events (
    actor_id, actor_kind, actor_role, action, target_type, target_id, outcome, after_state
  ) values (
    actor.user_id, 'staff', actor.role, 'gate.sync_offline_registration', 'passes', new_pass_id, 'success',
    jsonb_build_object('source', 'guard_offline', 'status', pass_status_val, 'offlineRegistrationId', requested_registration_id)
  );

  return jsonb_build_object(
    'status', 'applied',
    'passId', new_pass_id,
    'visitorId', new_visitor_id,
    'passStatus', pass_status_val,
    'publicReference', new_public_ref
  );
end;
$$;

revoke all on function api.guard_sync_offline_registration(uuid, jsonb, text, timestamptz, uuid, integer, text, uuid, integer, text, text) from public, anon;
grant execute on function api.guard_sync_offline_registration(uuid, jsonb, text, timestamptz, uuid, integer, text, uuid, integer, text, text) to authenticated;

-- =============================================================================
-- 5. REPAIR api.guard_sync_offline_event (R05, R06, R08, R09)
-- =============================================================================
drop function if exists api.guard_sync_offline_event(uuid, uuid, text, text, timestamptz, text);

create or replace function api.guard_sync_offline_event(
  requested_event_id uuid,
  requested_pass_id uuid,
  requested_action text,
  requested_expected_status text,
  requested_occurred_at timestamptz,
  requested_reason text default null,
  requested_expected_version integer default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor public.staff_profiles%rowtype;
  target public.passes%rowtype;
  existing_receipt public.offline_sync_receipts%rowtype;
  actual_pass_id uuid := requested_pass_id;
  next_status public.pass_status;
  res jsonb;
begin
  if (select private.is_recovery_session()) then
    raise exception using errcode = '42501', message = 'recovery_session_forbidden';
  end if;

  select * into actor from public.staff_profiles
  where user_id = (select auth.uid()) and active and not must_change_password
    and privacy_accepted_at is not null for share;
  if not found or actor.role not in ('guard'::public.staff_role, 'superadmin'::public.staff_role) then
    raise exception using errcode = '42501', message = 'active guard or superadmin required';
  end if;

  -- 1. Idempotency Check: if eventId was already submitted, return the original receipt
  select * into existing_receipt from public.offline_sync_receipts
  where event_id = requested_event_id;
  if found then
    return jsonb_build_object(
      'status', existing_receipt.status,
      'duplicate', true,
      'eventId', existing_receipt.event_id,
      'result', existing_receipt.result
    );
  end if;

  -- 2. Timestamp sanity check (Phase 10.6 & R09)
  if requested_occurred_at > statement_timestamp() + interval '5 minutes'
     or requested_occurred_at < statement_timestamp() - interval '7 days' then
    insert into public.offline_sync_receipts (
      event_id, pass_id, action, status, client_occurred_at, actor_id, conflict_reason, payload
    ) values (
      requested_event_id, requested_pass_id, requested_action, 'conflict', requested_occurred_at, actor.user_id,
      'suspicious_client_timestamp: occurred_at out of credible range',
      jsonb_build_object('expectedStatus', requested_expected_status, 'reason', requested_reason)
    );

    insert into public.reconciliation_tasks (
      operation, reference_type, reference_id, safe_context, last_error_code
    ) values (
      'offline_sync_timestamp_skew', 'pass', requested_pass_id::text,
      jsonb_build_object('eventId', requested_event_id, 'passId', requested_pass_id, 'occurredAt', requested_occurred_at),
      'suspicious_client_timestamp'
    );

    return jsonb_build_object(
      'status', 'conflict',
      'reason', 'suspicious_client_timestamp',
      'eventId', requested_event_id
    );
  end if;

  -- 3. Row-lock target pass; also resolve via offline_registration_id if offline created (R08)
  select * into target from public.passes where id = actual_pass_id for update;
  if not found then
    select * into target from public.passes where offline_registration_id = actual_pass_id for update;
    if found then
      actual_pass_id := target.id;
    else
      insert into public.offline_sync_receipts (
        event_id, pass_id, action, status, client_occurred_at, actor_id, conflict_reason, payload
      ) values (
        requested_event_id, requested_pass_id, requested_action, 'conflict', requested_occurred_at, actor.user_id,
        'pass_not_found', jsonb_build_object('expectedStatus', requested_expected_status)
      );

      insert into public.reconciliation_tasks (
        operation, reference_type, reference_id, safe_context, last_error_code
      ) values (
        'offline_sync_pass_not_found', 'pass', requested_pass_id::text,
        jsonb_build_object('eventId', requested_event_id, 'passId', requested_pass_id),
        'pass_not_found'
      );

      return jsonb_build_object('status', 'conflict', 'reason', 'pass_not_found', 'eventId', requested_event_id);
    end if;
  end if;

  -- 4. Version Fencing (R05)
  if requested_expected_version is not null and target.version <> requested_expected_version then
    insert into public.offline_sync_receipts (
      event_id, pass_id, action, status, client_occurred_at, actor_id, conflict_reason, payload
    ) values (
      requested_event_id, target.id, requested_action, 'conflict', requested_occurred_at, actor.user_id,
      'version_conflict: expected v' || requested_expected_version || ' but server is v' || target.version,
      jsonb_build_object(
        'expectedVersion', requested_expected_version,
        'serverVersion', target.version,
        'expectedStatus', requested_expected_status,
        'serverStatus', target.status::text
      )
    );

    insert into public.reconciliation_tasks (
      operation, reference_type, reference_id, safe_context, last_error_code
    ) values (
      'offline_sync_version_conflict', 'pass', target.id::text,
      jsonb_build_object(
        'eventId', requested_event_id,
        'expectedVersion', requested_expected_version,
        'serverVersion', target.version,
        'expectedStatus', requested_expected_status,
        'serverStatus', target.status::text
      ),
      'version_conflict'
    );

    return jsonb_build_object(
      'status', 'conflict',
      'reason', 'version_conflict',
      'serverVersion', target.version,
      'eventId', requested_event_id
    );
  end if;

  -- 5. Server-Enforced Legal Lifecycle Transitions (R05)
  if requested_action in ('approve_entry', 'reject_entry') then
    if target.status not in ('issued'::public.pass_status, 'pending'::public.pass_status) then
      insert into public.offline_sync_receipts (
        event_id, pass_id, action, status, client_occurred_at, actor_id, conflict_reason, payload
      ) values (
        requested_event_id, target.id, requested_action, 'conflict', requested_occurred_at, actor.user_id,
        'illegal_transition: ' || requested_action || ' only permitted from issued/pending, current is ' || target.status::text,
        jsonb_build_object('expectedStatus', requested_expected_status, 'serverStatus', target.status::text)
      );

      insert into public.reconciliation_tasks (
        operation, reference_type, reference_id, safe_context, last_error_code
      ) values (
        'offline_sync_status_conflict', 'pass', target.id::text,
        jsonb_build_object(
          'eventId', requested_event_id,
          'action', requested_action,
          'serverStatus', target.status::text
        ),
        'illegal_status_transition'
      );

      return jsonb_build_object(
        'status', 'conflict',
        'reason', 'illegal_status_transition',
        'serverStatus', target.status::text,
        'eventId', requested_event_id
      );
    end if;

  elsif requested_action = 'record_exit' then
    if target.status <> 'inside'::public.pass_status then
      insert into public.offline_sync_receipts (
        event_id, pass_id, action, status, client_occurred_at, actor_id, conflict_reason, payload
      ) values (
        requested_event_id, target.id, requested_action, 'conflict', requested_occurred_at, actor.user_id,
        'illegal_transition: record_exit only permitted from inside, current is ' || target.status::text,
        jsonb_build_object('expectedStatus', requested_expected_status, 'serverStatus', target.status::text)
      );

      insert into public.reconciliation_tasks (
        operation, reference_type, reference_id, safe_context, last_error_code
      ) values (
        'offline_sync_status_conflict', 'pass', target.id::text,
        jsonb_build_object(
          'eventId', requested_event_id,
          'action', requested_action,
          'serverStatus', target.status::text
        ),
        'illegal_status_transition'
      );

      return jsonb_build_object(
        'status', 'conflict',
        'reason', 'illegal_status_transition',
        'serverStatus', target.status::text,
        'eventId', requested_event_id
      );
    end if;

    -- Sequence sanity check: time_out must not be earlier than time_in
    if target.time_in is not null and requested_occurred_at < target.time_in then
      insert into public.offline_sync_receipts (
        event_id, pass_id, action, status, client_occurred_at, actor_id, conflict_reason, payload
      ) values (
        requested_event_id, target.id, requested_action, 'conflict', requested_occurred_at, actor.user_id,
        'impossible_sequencing: time_out earlier than time_in',
        jsonb_build_object('timeIn', target.time_in, 'timeOut', requested_occurred_at)
      );

      insert into public.reconciliation_tasks (
        operation, reference_type, reference_id, safe_context, last_error_code
      ) values (
        'offline_sync_timestamp_skew', 'pass', target.id::text,
        jsonb_build_object('eventId', requested_event_id, 'timeIn', target.time_in, 'timeOut', requested_occurred_at),
        'time_out_before_time_in'
      );

      return jsonb_build_object(
        'status', 'conflict',
        'reason', 'time_out_before_time_in',
        'eventId', requested_event_id
      );
    end if;

  else
    raise exception using errcode = '22023', message = 'invalid action';
  end if;

  -- 6. Status mismatch check against client expectation
  if target.status::text <> requested_expected_status then
    insert into public.offline_sync_receipts (
      event_id, pass_id, action, status, client_occurred_at, actor_id, conflict_reason, payload
    ) values (
      requested_event_id, target.id, requested_action, 'conflict', requested_occurred_at, actor.user_id,
      'status_mismatch: expected ' || requested_expected_status || ' but found ' || target.status::text,
      jsonb_build_object('expectedStatus', requested_expected_status, 'serverStatus', target.status::text)
    );

    insert into public.reconciliation_tasks (
      operation, reference_type, reference_id, safe_context, last_error_code
    ) values (
      'offline_sync_status_conflict', 'pass', target.id::text,
      jsonb_build_object(
        'eventId', requested_event_id,
        'passId', target.id,
        'expectedStatus', requested_expected_status,
        'serverStatus', target.status::text
      ),
      'status_mismatch'
    );

    return jsonb_build_object(
      'status', 'conflict',
      'reason', 'status_mismatch',
      'serverStatus', target.status::text,
      'eventId', requested_event_id
    );
  end if;

  -- 7. Apply state transition with truthful occurrence timestamp (R09)
  if requested_action = 'approve_entry' then
    next_status := 'inside'::public.pass_status;
    update public.passes set
      status = next_status,
      time_in = coalesce(time_in, requested_occurred_at),
      entry_scanned_at = coalesce(entry_scanned_at, requested_occurred_at),
      decided_at = requested_occurred_at,
      decided_by = actor.user_id,
      updated_at = statement_timestamp(),
      offline_synced_at = statement_timestamp(),
      version = version + 1
    where id = target.id;

    insert into public.visit_events (
      pass_id, visitor_id, event, reason, gate, guard_id, occurred_at, request_id, details
    ) values (
      target.id, target.visitor_id, 'approved'::public.visit_event_type,
      'guard_offline_sync', coalesce(target.gate, 'Offline Gate'), actor.user_id, requested_occurred_at, requested_event_id,
      jsonb_build_object('offline_synced_at', statement_timestamp())
    );

  elsif requested_action = 'reject_entry' then
    next_status := 'rejected'::public.pass_status;
    update public.passes set
      status = next_status,
      decided_at = requested_occurred_at,
      decided_by = actor.user_id,
      rejection_reason = coalesce(requested_reason, 'Rejected offline by guard'),
      updated_at = statement_timestamp(),
      offline_synced_at = statement_timestamp(),
      version = version + 1
    where id = target.id;

    insert into public.visit_events (
      pass_id, visitor_id, event, reason, gate, guard_id, occurred_at, request_id, details
    ) values (
      target.id, target.visitor_id, 'rejected'::public.visit_event_type,
      coalesce(requested_reason, 'guard_offline_sync'), coalesce(target.gate, 'Offline Gate'), actor.user_id,
      requested_occurred_at, requested_event_id,
      jsonb_build_object('offline_synced_at', statement_timestamp())
    );

  elsif requested_action = 'record_exit' then
    next_status := 'exited'::public.pass_status;
    update public.passes set
      status = next_status,
      time_out = requested_occurred_at,
      updated_at = statement_timestamp(),
      offline_synced_at = statement_timestamp(),
      version = version + 1
    where id = target.id;

    insert into public.visit_events (
      pass_id, visitor_id, event, reason, gate, guard_id, occurred_at, request_id, details
    ) values (
      target.id, target.visitor_id, 'scan_exit'::public.visit_event_type,
      'guard_offline_sync', coalesce(target.gate, 'Offline Gate'), actor.user_id, requested_occurred_at, requested_event_id,
      jsonb_build_object('offline_synced_at', statement_timestamp())
    );
  end if;

  res := jsonb_build_object('nextStatus', next_status, 'passId', target.id);

  insert into public.offline_sync_receipts (
    event_id, pass_id, action, status, client_occurred_at, actor_id, payload, result
  ) values (
    requested_event_id, target.id, requested_action, 'applied', requested_occurred_at, actor.user_id,
    jsonb_build_object('expectedStatus', requested_expected_status, 'expectedVersion', requested_expected_version, 'reason', requested_reason),
    res
  );

  insert into public.audit_events (
    actor_id, actor_kind, actor_role, action, target_type, target_id, outcome, after_state
  ) values (
    actor.user_id, 'staff', actor.role, 'gate.sync_offline_event', 'passes', target.id, 'success',
    jsonb_build_object('source', 'guard_offline', 'status', next_status, 'eventId', requested_event_id)
  );

  return jsonb_build_object('status', 'applied', 'eventId', requested_event_id, 'result', res);
end;
$$;

revoke all on function api.guard_sync_offline_event(uuid, uuid, text, text, timestamptz, text, integer) from public, anon;
grant execute on function api.guard_sync_offline_event(uuid, uuid, text, text, timestamptz, text, integer) to authenticated;

-- =============================================================================
-- 6. RPC: api.guard_offline_snapshot_page (R10)
-- =============================================================================
create or replace function api.guard_offline_snapshot_page(
  requested_cursor text default null,
  requested_limit integer default 50
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  caller_role public.staff_role := (select private.current_staff_role());
  v_limit integer := least(greatest(coalesce(requested_limit, 50), 1), 100);
  v_day_start timestamptz := date_trunc('day', statement_timestamp() at time zone 'Asia/Manila') at time zone 'Asia/Manila';
  v_day_end timestamptz := (date_trunc('day', statement_timestamp() at time zone 'Asia/Manila') + interval '1 day') at time zone 'Asia/Manila';
  cursor_id uuid := null;
  items_json jsonb := '[]'::jsonb;
  next_cursor text := null;
  has_more boolean := false;
  row_count integer := 0;
begin
  if (select private.is_recovery_session()) then
    raise exception using errcode = '42501', message = 'recovery_session_forbidden';
  end if;

  if caller_role is null or caller_role not in ('guard'::public.staff_role, 'admin'::public.staff_role, 'superadmin'::public.staff_role) then
    raise exception using errcode = '42501', message = 'active guard or administrator required';
  end if;

  if requested_cursor is not null and btrim(requested_cursor) <> '' then
    begin
      cursor_id := btrim(requested_cursor)::uuid;
    exception when others then
      raise exception using errcode = '22023', message = 'invalid_cursor';
    end;
  end if;

  select
    coalesce(
      jsonb_agg(
        jsonb_build_object(
          'passId', sub.pass_id,
          'publicReference', sub.public_reference,
          'visitorId', sub.visitor_id,
          'visitorName', sub.visitor_name,
          'contactNumber', sub.contact_number,
          'purpose', sub.purpose,
          'visitDate', sub.visit_date,
          'status', sub.status,
          'version', sub.version,
          'validFrom', sub.valid_from,
          'validUntil', sub.valid_until,
          'timeIn', sub.time_in,
          'gate', sub.gate,
          'photoEvidenceId', sub.photo_evidence_id,
          'idEvidenceId', sub.id_evidence_id
        )
      ),
      '[]'::jsonb
    ),
    count(*)
  into items_json, row_count
  from (
    select
      p.id as pass_id,
      p.public_reference,
      v.id as visitor_id,
      v.full_name as visitor_name,
      v.contact_number,
      v.purpose,
      v.visit_date::text as visit_date,
      p.status::text as status,
      p.version,
      p.valid_from,
      p.valid_until,
      p.time_in,
      p.gate,
      (
        select ve.id from public.visitor_evidence ve
        where ve.visitor_id = v.id and ve.kind = 'photo'::public.evidence_kind and ve.purged_at is null
        limit 1
      ) as photo_evidence_id,
      (
        select ve.id from public.visitor_evidence ve
        where ve.visitor_id = v.id and ve.kind = 'id'::public.evidence_kind and ve.purged_at is null
        limit 1
      ) as id_evidence_id
    from public.passes p
    join public.visitors v on v.id = p.visitor_id
    where p.status in ('issued'::public.pass_status, 'pending'::public.pass_status, 'inside'::public.pass_status)
      and p.valid_from >= v_day_start
      and p.valid_from < v_day_end
      and (cursor_id is null or p.id > cursor_id)
    order by p.id asc
    limit (v_limit + 1)
  ) sub;

  if row_count > v_limit then
    has_more := true;
    -- Next cursor is the last item within the requested limit
    next_cursor := items_json->(v_limit - 1)->>'passId';
    items_json := (
      select jsonb_agg(elem)
      from jsonb_array_elements(items_json) with ordinality as arr(elem, idx)
      where idx <= v_limit
    );
  else
    has_more := false;
    next_cursor := null;
  end if;

  return jsonb_build_object(
    'items', coalesce(items_json, '[]'::jsonb),
    'nextCursor', next_cursor,
    'hasMore', has_more
  );
end;
$$;

revoke all on function api.guard_offline_snapshot_page(text, integer) from public, anon;
grant execute on function api.guard_offline_snapshot_page(text, integer) to authenticated;

-- =============================================================================
-- 7. STRICT SERVER-SIDE THERMAL TEMPLATE VALIDATION (R14)
-- =============================================================================
create or replace function api.admin_save_thermal_template(
  requested_name text,
  requested_layout jsonb,
  requested_version integer default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor_role public.staff_role := (select private.current_staff_role());
  caller_id uuid := (select auth.uid());
  target_version integer := requested_version;
  target_id uuid;
  elements jsonb;
  has_inst boolean := false;
  has_name boolean := false;
  has_date boolean := false;
  has_qr boolean := false;
  has_ref boolean := false;
  elem jsonb;
  elem_key text;
  elem_type text;
  elem_x integer;
  elem_y integer;
  elem_w integer;
  elem_h integer;
  elem_font integer;
  elem_text text;
begin
  if (select private.is_recovery_session()) then
    raise exception using errcode = '42501', message = 'recovery_session_forbidden';
  end if;

  if actor_role is distinct from 'superadmin'::public.staff_role then
    raise exception using errcode = '42501', message = 'superadmin required';
  end if;

  -- Strict Width & Canvas Validation (R14)
  if (requested_layout->>'width')::integer is distinct from 384 then
    raise exception using errcode = '22023', message = 'template width must be exactly 384px';
  end if;

  elements := requested_layout->'elements';
  if elements is null or jsonb_typeof(elements) <> 'array' or jsonb_array_length(elements) < 5 or jsonb_array_length(elements) > 50 then
    raise exception using errcode = '22023', message = 'invalid elements count (must be between 5 and 50)';
  end if;

  for elem in select * from jsonb_array_elements(elements) loop
    elem_type := elem->>'type';

    -- Known element types allowlist
    if elem_type not in ('institution_name', 'static_text', 'divider', 'visitor_name', 'visit_date', 'qr_code', 'pass_reference') then
      raise exception using errcode = '22023', message = ('unsupported element type: ' || coalesce(elem_type, 'null'));
    end if;

    -- Known property allowlist: reject arbitrary unknown JSON properties
    for elem_key in select jsonb_object_keys(elem) loop
      if elem_key not in ('id', 'type', 'label', 'x', 'y', 'width', 'height', 'fontSize', 'fontWeight', 'align', 'text', 'isLocked', 'isRequired') then
        raise exception using errcode = '22023', message = ('unsupported property in element: ' || coalesce(elem_key, 'null'));
      end if;
    end loop;

    -- Coordinate bounds
    elem_x := (elem->>'x')::integer;
    elem_y := (elem->>'y')::integer;
    if elem_x is null or elem_x < 0 or elem_x > 384 then
      raise exception using errcode = '22023', message = 'x coordinate out of bounds (0-384)';
    end if;
    if elem_y is null or elem_y < 0 or elem_y > 2000 then
      raise exception using errcode = '22023', message = 'y coordinate out of bounds (0-2000)';
    end if;

    -- Width/height bounds if present
    if elem ? 'width' then
      elem_w := (elem->>'width')::integer;
      if elem_w < 1 or elem_w > 384 then
        raise exception using errcode = '22023', message = 'element width out of bounds (1-384)';
      end if;
    end if;

    if elem ? 'height' then
      elem_h := (elem->>'height')::integer;
      if elem_h < 1 or elem_h > 2000 then
        raise exception using errcode = '22023', message = 'element height out of bounds (1-2000)';
      end if;
    end if;

    -- QR minimum size: at least 100x100
    if elem_type = 'qr_code' then
      if elem_w is null or elem_w < 100 or elem_h is null or elem_h < 100 then
        raise exception using errcode = '22023', message = 'qr_code minimum size is 100x100';
      end if;
    end if;

    -- Font size bounds
    if elem ? 'fontSize' then
      elem_font := (elem->>'fontSize')::integer;
      if elem_font < 8 or elem_font > 48 then
        raise exception using errcode = '22023', message = 'font size out of bounds (8-48)';
      end if;
    end if;

    -- Text content safety: no HTML, scripts, or remote URLs
    if elem ? 'text' then
      elem_text := coalesce(elem->>'text', '');
      if elem_text ~* '[<>]' or elem_text ~* 'javascript:' or elem_text ~* 'https?://' then
        raise exception using errcode = '22023', message = 'element text contains forbidden markup or URLs';
      end if;
    end if;

    -- Mandatory elements flags
    if elem_type = 'institution_name' then has_inst := true; end if;
    if elem_type = 'visitor_name' then has_name := true; end if;
    if elem_type = 'visit_date' then has_date := true; end if;
    if elem_type = 'qr_code' then has_qr := true; end if;
    if elem_type = 'pass_reference' then has_ref := true; end if;
  end loop;

  if not (has_inst and has_name and has_date and has_qr and has_ref) then
    raise exception using errcode = '22023', message = 'missing mandatory locked template elements';
  end if;

  if target_version is not null then
    update public.thermal_templates
    set name = requested_name, layout = requested_layout, status = 'draft'
    where version = target_version and status = 'draft'
    returning id into target_id;
  end if;

  if target_id is null then
    select coalesce(max(version), 0) + 1 into target_version from public.thermal_templates;
    insert into public.thermal_templates (
      name, version, status, layout, created_by
    ) values (
      requested_name, target_version, 'draft', requested_layout, caller_id
    ) returning id into target_id;
  end if;

  return jsonb_build_object('id', target_id, 'version', target_version, 'status', 'draft');
end;
$$;

create or replace function api.admin_publish_thermal_template(
  requested_version integer
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor_role public.staff_role := (select private.current_staff_role());
  caller_id uuid := (select auth.uid());
  target_id uuid;
  target_layout jsonb;
begin
  if (select private.is_recovery_session()) then
    raise exception using errcode = '42501', message = 'recovery_session_forbidden';
  end if;

  if actor_role is distinct from 'superadmin'::public.staff_role then
    raise exception using errcode = '42501', message = 'superadmin required';
  end if;

  select id, layout into target_id, target_layout from public.thermal_templates
  where version = requested_version for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'template version not found';
  end if;

  -- Re-validate layout with strict rules before publishing
  perform api.admin_save_thermal_template('Validation Check', target_layout, requested_version);

  -- Archive previously published templates
  update public.thermal_templates
  set status = 'archived'
  where status = 'published' and version <> requested_version;

  -- Publish target template
  update public.thermal_templates
  set status = 'published', published_at = statement_timestamp(), published_by = caller_id
  where version = requested_version;

  return jsonb_build_object('version', requested_version, 'status', 'published');
end;
$$;

revoke all on function api.admin_save_thermal_template(text, jsonb, integer) from public, anon;
revoke all on function api.admin_publish_thermal_template(integer) from public, anon;
grant execute on function api.admin_save_thermal_template(text, jsonb, integer) to authenticated;
grant execute on function api.admin_publish_thermal_template(integer) to authenticated;
