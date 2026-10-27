-- Migration 33: deep_dive_root_cause_closure
-- Implements root-cause database repairs:
-- 1. Serialized thermal template version allocation via private.allocate_thermal_template_version() and pg_advisory_xact_lock
-- 2. Replacement of api.admin_save_thermal_template and api.admin_restore_thermal_template to use serialized version allocator
-- 3. Server-side enforcement in api.guard_sync_offline_registration that visitor visitDate matches Manila calendar date of requested_occurred_at

-- =============================================================================
-- 1. SERIALIZED THERMAL TEMPLATE VERSION ALLOCATOR (ROOT CAUSE 11)
-- =============================================================================
create or replace function private.allocate_thermal_template_version()
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  next_v integer;
begin
  -- Transaction-scoped advisory lock guarantees serialized version allocation across concurrent sessions
  perform pg_advisory_xact_lock(hashtext('thermal_templates_version_alloc'));
  select coalesce(max(version), 0) + 1 into next_v from public.thermal_templates;
  return next_v;
end;
$$;

revoke all on function private.allocate_thermal_template_version() from public, anon, authenticated;

-- =============================================================================
-- 2. HARDEN api.admin_save_thermal_template (USE SERIALIZED ALLOCATOR)
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
begin
  if (select private.is_recovery_session()) then
    raise exception using errcode = '42501', message = 'recovery_session_forbidden';
  end if;

  if actor_role is distinct from 'superadmin'::public.staff_role then
    raise exception using errcode = '42501', message = 'superadmin required';
  end if;

  if requested_name is null or char_length(btrim(requested_name)) < 2 then
    raise exception using errcode = '22023', message = 'template name required';
  end if;

  -- Validate layout with unified canonical schema
  perform private.validate_thermal_template_layout(requested_layout);

  if target_version is not null then
    update public.thermal_templates
    set name = requested_name, layout = requested_layout, status = 'draft'
    where version = target_version and status = 'draft'
    returning id into target_id;
  end if;

  if target_id is null then
    target_version := (select private.allocate_thermal_template_version());
    insert into public.thermal_templates (
      name, version, status, layout, created_by
    ) values (
      requested_name, target_version, 'draft', requested_layout, caller_id
    ) returning id into target_id;
  end if;

  return jsonb_build_object('id', target_id, 'version', target_version, 'status', 'draft');
end;
$$;

revoke all on function api.admin_save_thermal_template(text, jsonb, integer) from public, anon;
grant execute on function api.admin_save_thermal_template(text, jsonb, integer) to authenticated;

-- =============================================================================
-- 3. HARDEN api.admin_restore_thermal_template (USE SERIALIZED ALLOCATOR)
-- =============================================================================
create or replace function api.admin_restore_thermal_template(
  source_version integer
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
  source_template public.thermal_templates%rowtype;
  new_version integer;
  new_id uuid;
begin
  if (select private.is_recovery_session()) then
    raise exception using errcode = '42501', message = 'recovery_session_forbidden';
  end if;

  if actor_role is distinct from 'superadmin'::public.staff_role then
    raise exception using errcode = '42501', message = 'superadmin required';
  end if;

  select * into source_template from public.thermal_templates
  where version = source_version;
  if not found then
    raise exception using errcode = 'P0002', message = 'source template version not found';
  end if;

  -- Validate layout before restoring as published
  perform private.validate_thermal_template_layout(source_template.layout);

  new_version := (select private.allocate_thermal_template_version());

  -- Archive current published
  update public.thermal_templates set status = 'archived' where status = 'published';

  -- Create restored version and immediately publish it
  insert into public.thermal_templates (
    name, version, status, layout, created_by, published_by, published_at
  ) values (
    source_template.name || ' (Restored from v' || source_version || ')',
    new_version,
    'published',
    source_template.layout,
    caller_id,
    caller_id,
    statement_timestamp()
  ) returning id into new_id;

  return jsonb_build_object('id', new_id, 'version', new_version, 'status', 'published');
end;
$$;

revoke all on function api.admin_restore_thermal_template(integer) from public, anon;
grant execute on function api.admin_restore_thermal_template(integer) to authenticated;

-- =============================================================================
-- 4. HARDEN api.guard_sync_offline_registration (ROOT CAUSE 13 VISIT DATE MATCH)
-- =============================================================================
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

  -- Root Cause 13 Enforcement: visitor.visitDate MUST equal the Manila calendar date represented by requested_occurred_at
  if visit_date_val is distinct from ((requested_occurred_at at time zone 'Asia/Manila')::date) then
    raise exception using errcode = '22023', message = 'visit_date_must_match_occurrence_date';
  end if;

  -- Approved offline registration strictly REQUIRES valid ID evidence
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

  -- Compute normalized fingerprint
  v_norm_visitor := lower(btrim(full_name_val)) || '|' || btrim(contact_number_val) || '|' ||
                    lower(coalesce(email_val, '')) || '|' || lower(btrim(purpose_val)) || '|' || visit_date_str;
  v_fingerprint := encode(sha256((
    v_norm_visitor || '|' || requested_action || '|' || requested_occurred_at::text || '|' ||
    requested_photo_sha256 || '|' || coalesce(requested_id_sha256, '')
  )::bytea), 'hex');

  -- Idempotency Check
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
      -- Same registration ID + different payload = conflict
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

  -- Validate and lock Photo Upload Intent
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

  -- Validate and lock ID Upload Intent if provided
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

  -- Insert visitor using real public.visitors schema
  insert into public.visitors (
    id, owner_id, source, created_by_device_id, full_name, contact_number,
    email, purpose, visit_date, consent_accepted_at
  ) values (
    new_visitor_id, actor.user_id, 'guard_offline'::public.pass_source, null,
    full_name_val, contact_number_val, email_val, purpose_val,
    visit_date_val, requested_occurred_at
  );

  -- Attach visitor_evidence using real schema
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

  -- Generate opaque bearer token digest
  raw_token := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
  token_digest_val := sha256(raw_token::bytea);

  pass_status_val := case when requested_action = 'approved' then 'inside'::public.pass_status else 'rejected'::public.pass_status end;
  v_day_start := date_trunc('day', requested_occurred_at at time zone 'Asia/Manila') at time zone 'Asia/Manila';
  v_day_end := (date_trunc('day', requested_occurred_at at time zone 'Asia/Manila') + interval '1 day') at time zone 'Asia/Manila';

  -- Insert canonical pass record
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

  -- Insert visit event with truthful occurred_at
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

  -- Store sync receipt with fingerprint for robust idempotency
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
