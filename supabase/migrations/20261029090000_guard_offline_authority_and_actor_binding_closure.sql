-- =============================================================================
-- Migration 37: Guard Offline Authority & Actor Binding Closure
--
-- 1. Rebuild api.guard_sync_offline_registration trust boundary:
--    - Service-role only execution (auth.role() = 'service_role')
--    - Explicit requested_actor_id parameter representing verified Guard/Superadmin
--    - Revoke EXECUTE from public, anon, authenticated
--    - Defense-in-depth upload intent validation (owner, source, kind, bucket, status, expires_at, byte bounds, sha256)
--    - Authoritative configured photo and ID retention (respecting scheduled visit window)
-- 2. Restrict api.get_published_thermal_template() to service_role only
-- =============================================================================

-- Drop previous function signature so browser authenticated cannot invoke it
drop function if exists api.guard_sync_offline_registration(
  uuid, jsonb, text, timestamptz, uuid, integer, text, uuid, integer, text, text
);

create or replace function api.guard_sync_offline_registration(
  requested_actor_id uuid,
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
  settings public.app_settings%rowtype;
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
  photo_retention_val integer;
  id_retention_val integer;
  v_day_start timestamptz;
  v_day_end timestamptz;
  v_fingerprint text;
  v_norm_visitor text;
  res jsonb;
begin
  -- Strict Service Role Check: Browser / Client connections must never execute this directly
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'service_role_required';
  end if;

  if (select private.is_recovery_session()) then
    raise exception using errcode = '42501', message = 'recovery_session_forbidden';
  end if;

  -- Independently validate the verified actor identity passed from the trusted server
  select * into actor from public.staff_profiles
  where user_id = requested_actor_id
    and active
    and not must_change_password
    and privacy_accepted_at is not null
  for share;

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

  -- Manila calendar date must strictly match occurrence date
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

  -- Defense-in-depth: Validate and lock Photo Upload Intent
  select * into photo_intent from public.upload_intents
  where id = requested_photo_intent_id for update;
  if not found
     or photo_intent.owner_id <> requested_actor_id
     or photo_intent.source <> 'guard_offline'::public.pass_source
     or photo_intent.kind <> 'photo'::public.evidence_kind
     or photo_intent.bucket_id <> 'visitor-photos'
     or photo_intent.status <> 'pending'::public.upload_intent_status
     or photo_intent.expires_at <= statement_timestamp() then
    raise exception using errcode = '22023', message = 'invalid_photo_upload_intent';
  end if;

  if requested_photo_byte_size < 12 or requested_photo_byte_size > photo_intent.max_bytes then
    raise exception using errcode = '22023', message = 'invalid_photo_byte_size';
  end if;
  if requested_photo_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'invalid_photo_sha256';
  end if;

  -- Defense-in-depth: Validate and lock ID Upload Intent if provided
  if requested_id_intent_id is not null then
    select * into id_intent from public.upload_intents
    where id = requested_id_intent_id for update;
    if not found
       or id_intent.owner_id <> requested_actor_id
       or id_intent.source <> 'guard_offline'::public.pass_source
       or id_intent.kind <> 'id'::public.evidence_kind
       or id_intent.bucket_id <> 'visitor-ids'
       or id_intent.status <> 'pending'::public.upload_intent_status
       or id_intent.expires_at <= statement_timestamp() then
      raise exception using errcode = '22023', message = 'invalid_id_upload_intent';
    end if;

    if requested_id_byte_size < 12 or requested_id_byte_size > id_intent.max_bytes then
      raise exception using errcode = '22023', message = 'invalid_id_byte_size';
    end if;
    if requested_id_sha256 !~ '^[0-9a-f]{64}$' then
      raise exception using errcode = '22023', message = 'invalid_id_sha256';
    end if;
  end if;

  -- Load authoritative configured retention settings
  select * into settings from public.app_settings where singleton for share;
  photo_retention_val := coalesce(settings.photo_retention_days, settings.image_retention_days, 7)::integer;
  id_retention_val := coalesce(settings.id_retention_days, 30)::integer;

  v_day_start := date_trunc('day', requested_occurred_at at time zone coalesce(settings.timezone, 'Asia/Manila')) at time zone coalesce(settings.timezone, 'Asia/Manila');
  v_day_end := (date_trunc('day', requested_occurred_at at time zone coalesce(settings.timezone, 'Asia/Manila')) + interval '1 day') at time zone coalesce(settings.timezone, 'Asia/Manila');

  -- Insert visitor using real public.visitors schema with verified actor
  insert into public.visitors (
    id, owner_id, source, created_by_device_id, full_name, contact_number,
    email, purpose, visit_date, consent_accepted_at
  ) values (
    new_visitor_id, actor.user_id, 'guard_offline'::public.pass_source, null,
    full_name_val, contact_number_val, email_val, purpose_val,
    visit_date_val, requested_occurred_at
  );

  -- Claim photo intent and attach visitor_evidence with authoritative lifecycle
  update public.upload_intents
  set visitor_id = new_visitor_id, status = 'claimed'::public.upload_intent_status, claimed_at = statement_timestamp()
  where id = photo_intent.id;

  insert into public.visitor_evidence (
    visitor_id, upload_intent_id, kind, bucket_id, object_path,
    content_type, byte_size, sha256_hex, verified_at, expires_at
  ) values (
    new_visitor_id, photo_intent.id, 'photo'::public.evidence_kind, photo_intent.bucket_id,
    photo_intent.object_path, photo_intent.content_type, requested_photo_byte_size,
    requested_photo_sha256, statement_timestamp(), greatest(
      statement_timestamp() + make_interval(days => photo_retention_val),
      v_day_end + interval '1 day'
    )
  );

  -- Claim ID intent and attach ID evidence with authoritative lifecycle
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
      requested_id_sha256, statement_timestamp(), greatest(
        statement_timestamp() + make_interval(days => id_retention_val),
        v_day_end + interval '1 day'
      )
    );
  end if;

  -- Generate opaque bearer token digest
  raw_token := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
  token_digest_val := sha256(raw_token::bytea);

  pass_status_val := case when requested_action = 'approved' then 'inside'::public.pass_status else 'rejected'::public.pass_status end;

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

  -- Insert visit event with truthful occurred_at and actor binding
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

  -- Store sync receipt with fingerprint and actor attribution
  insert into public.offline_sync_receipts (
    event_id, offline_registration_id, pass_id, action, status, client_occurred_at, actor_id,
    conflict_reason, payload, result, fingerprint
  ) values (
    requested_registration_id, requested_registration_id, new_pass_id, 'register_visitor', 'applied',
    requested_occurred_at, actor.user_id, null, requested_visitor, res, v_fingerprint
  );

  -- Audit event recording verified actor
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

-- Strict least privilege: revoke all access from client-facing roles, grant only to service_role
revoke all on function api.guard_sync_offline_registration(
  uuid, uuid, jsonb, text, timestamptz, uuid, integer, text, uuid, integer, text, text
) from public, anon, authenticated;

grant execute on function api.guard_sync_offline_registration(
  uuid, uuid, jsonb, text, timestamptz, uuid, integer, text, uuid, integer, text, text
) to service_role;


-- =============================================================================
-- 2. HARDEN api.get_published_thermal_template() TO SERVICE_ROLE ONLY
-- =============================================================================

create or replace function api.get_published_thermal_template()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  published_rec record;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'service_role_required';
  end if;

  select version, layout, name into published_rec from public.thermal_templates
  where status = 'published'
  order by version desc
  limit 1;

  if not found then
    return null;
  end if;

  return jsonb_build_object(
    'version', published_rec.version,
    'layout', published_rec.layout,
    'name', published_rec.name
  );
end;
$$;

revoke all on function api.get_published_thermal_template() from public, anon, authenticated;
grant execute on function api.get_published_thermal_template() to service_role;
