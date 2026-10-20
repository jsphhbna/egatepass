-- Additive migration 20261020001300_cross_layer_root_cause_hardening.sql
-- Hardens RLS operational predicates, fixes email challenge owner join,
-- adds incident hold atomic create/release, enforces upload intent quotas,
-- and rechecks pass expiration before guard approval without transaction rollback.

-- ============================================================================
-- 1. P0-01: RLS Staff Operational Eligibility Predicate
-- ============================================================================
-- Staff must be active, have confirmed email, have completed forced password change,
-- and have accepted privacy terms to hold an operational staff role in RLS.

create or replace function private.current_staff_role()
returns public.staff_role
language sql
stable
security definer
set search_path = ''
as $$
  select sp.role
  from public.staff_profiles sp
  join auth.users u on u.id = sp.user_id
  where sp.user_id = (select auth.uid())
    and sp.active = true
    and u.email_confirmed_at is not null
    and sp.must_change_password = false
    and sp.privacy_accepted_at is not null
  limit 1
$$;

-- Allow staff users during onboarding to always read their own staff profile
-- so useAuth can load must_change_password and privacy_accepted_at without deadlock.
drop policy if exists staff_profiles_select on public.staff_profiles;
create policy staff_profiles_select on public.staff_profiles for select to authenticated
using (
  user_id = (select auth.uid())
  or (select private.has_staff_role(array['admin','superadmin']::public.staff_role[]))
);

-- Ensure staff can acknowledge privacy even before full operational eligibility
-- REPAIR 1A & 1B: Preserves canonical RETURNS timestamptz and valid audit_events columns
create or replace function api.acknowledge_privacy()
returns timestamptz
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  caller_id uuid := (select auth.uid());
  accepted_at timestamptz;
  caller_role public.staff_role;
begin
  if caller_id is null then
    raise exception using errcode = '42501', message = 'authentication required';
  end if;

  update public.staff_profiles
     set privacy_accepted_at = coalesce(privacy_accepted_at, now()),
         updated_at = now()
   where user_id = caller_id
     and active = true
  returning privacy_accepted_at, role into accepted_at, caller_role;

  if accepted_at is null then
    raise exception using errcode = 'P0002', message = 'staff profile not found or inactive';
  end if;

  insert into public.audit_events (
    actor_id, actor_kind, actor_role, action, target_type, target_id, after_state
  ) values (
    caller_id, 'staff', caller_role::text, 'privacy.acknowledged', 'staff_profile', caller_id::text,
    jsonb_build_object('accepted', true, 'timestamp', accepted_at)
  );

  return accepted_at;
end;
$$;

revoke all on function api.acknowledge_privacy() from public, anon;
grant execute on function api.acknowledge_privacy() to authenticated, service_role;

-- ============================================================================
-- 2. P0-02, REPAIR 2A, REPAIR 2B: Email Verification Challenge Hardening
-- ============================================================================
-- Joins passes to visitors to resolve owner_id and source authoritatively.
-- Uses request_actor_id consistently and binds idempotency replay strictly to
-- the (pass_id, request_actor_id, recipient_email) tuple.

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
volatile
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
  v_actor_lock_key bigint;
  v_recipient_lock_key bigint;
begin
  v_recipient := lower(trim(coalesce(requested_recipient_email, '')));

  -- 1. Pass lock (serializes requests targeting the same pass)
  -- P0-02 FIX: Join passes to visitors to resolve owner_id and source correctly
  select p.id, p.status, p.valid_until, v.owner_id, v.source into v_pass
    from public.passes p
    join public.visitors v on v.id = p.visitor_id
   where p.id = requested_pass_id
   for update of p;

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

  -- 2. REPAIR 2B: Idempotency replay check under pass lock
  -- Binds request_id to pass_id, request_actor_id, and recipient_email
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

  -- 3. Concurrency serialization across distinct passes:
  -- Acquire deterministic advisory transaction locks to eliminate cross-pass count-then-insert races.
  if v_pass.source <> 'kiosk' and requested_actor_id is not null then
    perform pg_advisory_xact_lock(1, hashtext(requested_actor_id::text));
  end if;
  perform pg_advisory_xact_lock(2, hashtext(v_recipient));

  -- 4. Sliding-window rate limit checks (15 minutes)
  -- (a) Max 3 requests per individual pass
  select count(*) into v_pass_recent_count
    from public.pass_email_verifications
   where pass_id = requested_pass_id
     and created_at >= statement_timestamp() - interval '15 minutes';

  if v_pass_recent_count >= 3 then
    raise exception 'too_many_requests' using errcode = 'P0003';
  end if;

  -- (b) Max 5 requests per recipient email across all passes
  select count(*) into v_recipient_recent_count
    from public.pass_email_verifications
   where recipient_email = v_recipient
     and created_at >= statement_timestamp() - interval '15 minutes';

  if v_recipient_recent_count >= 5 then
    raise exception 'too_many_requests_recipient' using errcode = 'P0003';
  end if;

  -- (c) Max 10 requests per actor across all passes (REPAIR 2A: uses request_actor_id)
  select count(*) into v_actor_recent_count
    from public.pass_email_verifications ev
   where ev.request_actor_id = requested_actor_id
     and ev.created_at >= statement_timestamp() - interval '15 minutes';

  if v_actor_recent_count >= 10 then
    raise exception 'too_many_requests_actor' using errcode = 'P0003';
  end if;

  -- 5. Insert challenge row in code_sending state (REPAIR 2A: uses request_actor_id)
  insert into public.pass_email_verifications (
    id, pass_id, request_id, request_actor_id, recipient_email, code_hash,
    code_delivery_status, delivery_status, expires_at, created_at
  ) values (
    requested_verification_id, requested_pass_id, requested_request_id, requested_actor_id,
    v_recipient, requested_code_hash, 'code_sending', 'pending', requested_expires_at, now()
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

-- ============================================================================
-- 3. P0-03: Explicit Least-Privilege Schema Grants
-- ============================================================================

grant usage on schema api to authenticated, service_role;
grant usage on schema public to anon, authenticated, service_role;
revoke all on schema private from public, anon, authenticated;
grant usage on schema private to service_role;

-- ============================================================================
-- 4. P0-04, REPAIR GROUP 3: Incident Hold Create & Release Protocol
-- ============================================================================
-- Matches the trusted Vercel service-role caller contract:
--   create_incident_hold(requested_actor_id, requested_visitor_id, requested_pass_id, requested_reason, requested_request_id)
--   release_incident_hold(requested_actor_id, requested_hold_id, requested_reason, requested_request_id)

create or replace function api.create_incident_hold(
  requested_actor_id uuid,
  requested_visitor_id uuid,
  requested_pass_id uuid,
  requested_reason text,
  requested_request_id uuid default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor public.staff_profiles%rowtype;
  new_hold_id uuid := gen_random_uuid();
  v_visitor_id uuid := requested_visitor_id;
  v_pass_id uuid := requested_pass_id;
  v_evidence_record record;
  cleaned_reason text := btrim(coalesce(requested_reason, ''));
  v_existing_hold_id uuid;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'service role required';
  end if;

  select * into actor
    from public.staff_profiles
   where user_id = requested_actor_id
     and active = true
     and not must_change_password
     and privacy_accepted_at is not null
   for share;

  if not found or actor.role is distinct from 'superadmin'::public.staff_role then
    raise exception using errcode = '42501', message = 'superadmin required';
  end if;

  if char_length(cleaned_reason) not between 5 and 500 then
    raise exception using errcode = '22023', message = 'reason must be between 5 and 500 characters';
  end if;

  if v_visitor_id is null and v_pass_id is null then
    raise exception using errcode = '22023', message = 'visitor_id or pass_id required';
  end if;

  -- Resolve visitor_id from pass_id if not provided
  if v_pass_id is not null and v_visitor_id is null then
    select p.visitor_id into v_visitor_id
      from public.passes p
     where p.id = v_pass_id;
    if not found then
      raise exception using errcode = 'P0002', message = 'pass not found';
    end if;
  end if;

  -- Lock visitor row to serialize against concurrent purge claims
  if v_visitor_id is not null then
    perform 1 from public.visitors v where v.id = v_visitor_id for update;
    if not found then
      raise exception using errcode = 'P0002', message = 'visitor not found';
    end if;
  end if;

  -- Check if an active hold already exists for this pass or visitor
  if v_pass_id is not null then
    select id into v_existing_hold_id
      from public.incident_holds
     where pass_id = v_pass_id and active = true
     limit 1;
    if found then
      return jsonb_build_object(
        'success', true,
        'hold_id', v_existing_hold_id,
        'conflict', null,
        'already_active', true
      );
    end if;
  end if;

  if v_visitor_id is not null then
    select id into v_existing_hold_id
      from public.incident_holds
     where visitor_id = v_visitor_id and active = true
     limit 1;
    if found then
      return jsonb_build_object(
        'success', true,
        'hold_id', v_existing_hold_id,
        'conflict', null,
        'already_active', true
      );
    end if;
  end if;

  -- Check if any evidence for this visitor has already been permanently purged or claimed
  for v_evidence_record in
    select id, purged_at, purge_claim_id, purge_claimed_at
      from public.visitor_evidence
     where visitor_id = v_visitor_id
  loop
    if v_evidence_record.purged_at is not null then
      return jsonb_build_object(
        'success', false,
        'conflict', 'evidence_already_purged',
        'message', 'Evidence for this visitor has already been permanently purged'
      );
    end if;

    if v_evidence_record.purge_claim_id is not null
       and v_evidence_record.purge_claimed_at >= statement_timestamp() - interval '5 minutes' then
      return jsonb_build_object(
        'success', false,
        'conflict', 'purge_in_progress',
        'message', 'Evidence purge claim is currently in progress. Retry or investigate.'
      );
    end if;
  end loop;

  -- Insert incident hold
  insert into public.incident_holds (
    id, visitor_id, pass_id, reason, active, created_by, created_at
  ) values (
    new_hold_id, v_visitor_id, v_pass_id, cleaned_reason, true, requested_actor_id, now()
  );

  -- Audit log entry with valid schema columns
  insert into public.audit_events (
    actor_id, actor_kind, actor_role, action, target_type, target_id, request_id, outcome, after_state
  ) values (
    requested_actor_id, 'staff', 'superadmin', 'incident_hold.created', 'incident_hold', new_hold_id::text,
    requested_request_id, 'success',
    jsonb_build_object(
      'visitor_id', v_visitor_id,
      'pass_id', v_pass_id,
      'reason', cleaned_reason
    )
  );

  return jsonb_build_object(
    'success', true,
    'hold_id', new_hold_id,
    'conflict', null
  );
end;
$$;

create or replace function api.release_incident_hold(
  requested_actor_id uuid,
  requested_hold_id uuid,
  requested_reason text default null,
  requested_request_id uuid default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor public.staff_profiles%rowtype;
  target_hold public.incident_holds%rowtype;
  cleaned_reason text := btrim(coalesce(requested_reason, ''));
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'service role required';
  end if;

  select * into actor
    from public.staff_profiles
   where user_id = requested_actor_id
     and active = true
     and not must_change_password
     and privacy_accepted_at is not null
   for share;

  if not found or actor.role is distinct from 'superadmin'::public.staff_role then
    raise exception using errcode = '42501', message = 'superadmin required';
  end if;

  if requested_reason is not null and char_length(cleaned_reason) not between 1 and 500 then
    raise exception using errcode = '22023', message = 'release reason must be between 1 and 500 characters';
  end if;

  select * into target_hold
    from public.incident_holds
   where id = requested_hold_id
   for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'incident_hold_not_found';
  end if;

  if not target_hold.active then
    return jsonb_build_object(
      'success', true,
      'hold_id', target_hold.id,
      'already_released', true
    );
  end if;

  update public.incident_holds
     set active = false,
         released_by = requested_actor_id,
         released_at = now()
   where id = target_hold.id;

  insert into public.audit_events (
    actor_id, actor_kind, actor_role, action, target_type, target_id, request_id, outcome, after_state
  ) values (
    requested_actor_id, 'staff', 'superadmin', 'incident_hold.released', 'incident_hold', target_hold.id::text,
    requested_request_id, 'success',
    jsonb_build_object(
      'visitor_id', target_hold.visitor_id,
      'pass_id', target_hold.pass_id,
      'release_reason', cleaned_reason
    )
  );

  return jsonb_build_object(
    'success', true,
    'hold_id', target_hold.id,
    'active', false,
    'released_at', now()
  );
end;
$$;

revoke all on function api.create_incident_hold(uuid, uuid, uuid, text, uuid) from public, anon, authenticated;
revoke all on function api.release_incident_hold(uuid, uuid, text, uuid) from public, anon, authenticated;
grant execute on function api.create_incident_hold(uuid, uuid, uuid, text, uuid) to service_role;
grant execute on function api.release_incident_hold(uuid, uuid, text, uuid) to service_role;

-- ============================================================================
-- 5. HIGH-03, REPAIR GROUP 4: Guard Approval Expired Pass Recheck
-- ============================================================================
-- If an awaiting-guard pass expired before the guard clicked approve,
-- transitions to expired, writes audit/event record, and returns 'expired'
-- without raising an exception (which would roll back the transaction).

create or replace function api.decide_visit(
  requested_actor_id uuid,
  requested_pass_id uuid,
  requested_decision text,
  requested_reason text,
  requested_request_id uuid
)
returns public.pass_status
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor public.staff_profiles%rowtype;
  target public.passes%rowtype;
  next_status public.pass_status;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'service role required';
  end if;

  select * into actor from public.staff_profiles
  where user_id = requested_actor_id and active and not must_change_password
    and privacy_accepted_at is not null for share;
  if not found or actor.role not in ('guard'::public.staff_role, 'admin'::public.staff_role, 'superadmin'::public.staff_role) then
    raise exception using errcode = '42501', message = 'active guard or administrator required';
  end if;

  if requested_decision not in ('approved', 'rejected')
    or (requested_decision = 'approved' and requested_reason is not null)
    or (requested_decision = 'rejected' and char_length(btrim(coalesce(requested_reason, ''))) not between 1 and 500) then
    raise exception using errcode = '22023', message = 'invalid decision';
  end if;

  select * into target from public.passes where id = requested_pass_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'pass not found'; end if;
  if target.status <> 'pending'::public.pass_status then
    raise exception using errcode = '40001', message = 'pass is no longer pending';
  end if;

  -- REPAIR GROUP 4: Guard cannot approve an expired pass.
  -- Persist the expired status and commit instead of raising an exception.
  if requested_decision = 'approved' and target.valid_until <= statement_timestamp() then
    update public.passes set
      status = 'expired'::public.pass_status, updated_at = now(), version = version + 1
    where id = target.id;

    insert into public.visit_events(pass_id, visitor_id, event, reason, gate, guard_id, request_id)
    values (target.id, target.visitor_id, 'invalid_scan'::public.visit_event_type, 'pass_has_expired', target.gate, actor.user_id, requested_request_id)
    on conflict (request_id, event) do nothing;

    insert into public.audit_events (
      actor_id, actor_kind, actor_role, action, target_type, target_id, request_id, outcome, after_state
    ) values (
      actor.user_id, 'staff', actor.role::text, 'pass.expired_pending_decision', 'pass', target.id::text,
      requested_request_id, 'success', jsonb_build_object('reason', 'pass_has_expired')
    );

    return 'expired'::public.pass_status;
  end if;

  next_status := case requested_decision when 'approved' then 'inside'::public.pass_status else 'rejected'::public.pass_status end;

  update public.passes set
    status = next_status, decided_at = now(),
    time_in = case when next_status = 'inside' then now() else time_in end,
    decided_by = actor.user_id,
    rejection_reason = case when next_status = 'rejected' then btrim(requested_reason) else null end,
    updated_at = now(), version = version + 1
  where id = target.id;

  insert into public.visit_events(pass_id, visitor_id, event, reason, gate, guard_id, request_id)
  values (
    target.id, target.visitor_id,
    case when next_status = 'inside' then 'approved'::public.visit_event_type else 'rejected'::public.visit_event_type end,
    case when next_status = 'rejected' then btrim(requested_reason) else null end,
    target.gate, actor.user_id, requested_request_id
  );

  return next_status;
end;
$$;

revoke all on function api.decide_visit(uuid, uuid, text, text, uuid) from public, anon, authenticated;
grant execute on function api.decide_visit(uuid, uuid, text, text, uuid) to service_role;

-- ============================================================================
-- 6. MED-04: Upload Intent Rate Limiting / Quotas
-- ============================================================================

create or replace function api.create_upload_intent(
  requested_source public.pass_source,
  requested_kind public.evidence_kind,
  requested_content_type text
)
returns table (
  intent_id uuid,
  bucket_id text,
  object_path text,
  expires_at timestamptz,
  max_bytes integer
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  caller_id uuid := (select auth.uid());
  caller_device_type public.device_type := (select private.current_device_type());
  new_intent_id uuid := gen_random_uuid();
  target_bucket text;
  target_extension text;
  target_path text;
  target_expiry timestamptz := now() + interval '15 minutes';
  pending_count integer;
begin
  if caller_id is null then
    raise exception using errcode = '42501', message = 'authentication required';
  end if;

  if requested_source = 'kiosk'::public.pass_source then
    if caller_device_type is distinct from 'kiosk'::public.device_type then
      raise exception using errcode = '42501', message = 'active kiosk identity required';
    end if;
  elsif requested_source = 'portal'::public.pass_source then
    if not (select private.is_portal_actor()) then
      raise exception using errcode = '42501', message = 'visitor identity required';
    end if;

    -- REPAIR GROUP 21: Serialize concurrent upload intent creations per caller
    perform pg_advisory_xact_lock(hashtext('upload_intent:' || caller_id::text));

    -- MED-04: Cap active pending intents for anonymous portal callers
    select count(*) into pending_count
      from public.upload_intents
     where owner_id = caller_id
       and status = 'pending'::public.upload_intent_status
       and expires_at > statement_timestamp();

    if pending_count >= 10 then
      raise exception using errcode = 'P0003', message = 'too_many_pending_intents';
    end if;
  else
    raise exception using errcode = '22023', message = 'unsupported source';
  end if;

  target_bucket := case requested_kind
    when 'photo'::public.evidence_kind then 'visitor-photos'
    when 'id'::public.evidence_kind then 'visitor-ids'
  end;
  target_extension := case requested_content_type
    when 'image/jpeg' then 'jpg'
    when 'image/png' then 'png'
    when 'image/webp' then 'webp'
    else null
  end;
  if target_extension is null then
    raise exception using errcode = '22023', message = 'unsupported content type';
  end if;

  target_path := caller_id::text || '/' || new_intent_id::text || '/' || requested_kind::text || '.' || target_extension;
  insert into public.upload_intents (
    id, owner_id, source, kind, bucket_id, object_path, content_type, max_bytes, expires_at
  ) values (
    new_intent_id, caller_id, requested_source, requested_kind, target_bucket,
    target_path, requested_content_type, 5242880, target_expiry
  );

  return query select new_intent_id, target_bucket, target_path, target_expiry, 5242880;
end;
$$;

revoke all on function api.create_upload_intent(public.pass_source, public.evidence_kind, text) from public, anon;
grant execute on function api.create_upload_intent(public.pass_source, public.evidence_kind, text) to authenticated;

-- ============================================================================
-- 7. MED-01: Guard Queue Pagination & Total Backlog Count
-- ============================================================================

drop function if exists api.guard_dashboard();

create or replace function api.guard_dashboard(
  requested_limit integer default 50,
  requested_offset integer default 0
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor public.staff_profiles%rowtype;
  queue jsonb;
  stats jsonb;
  reasons jsonb;
  v_limit integer := least(greatest(coalesce(requested_limit, 50), 1), 200);
  v_offset integer := greatest(coalesce(requested_offset, 0), 0);
  v_pending_total bigint;
  v_has_more boolean;
begin
  select * into actor from public.staff_profiles
  where user_id = (select auth.uid()) and active and not must_change_password
    and privacy_accepted_at is not null;
  if not found or actor.role not in ('guard'::public.staff_role, 'admin'::public.staff_role, 'superadmin'::public.staff_role) then
    raise exception using errcode = '42501', message = 'active guard or administrator required';
  end if;

  select count(*) into v_pending_total
  from public.passes
  where status = 'pending'::public.pass_status;

  select coalesce(jsonb_agg(item order by item->>'scannedAt'), '[]'::jsonb) into queue
  from (
    select jsonb_build_object(
      'id', p.id, 'visitorName', v.full_name, 'purpose', v.purpose,
      'source', p.source, 'status', p.status, 'validFrom', p.valid_from,
      'validUntil', p.valid_until, 'scannedAt', p.entry_scanned_at, 'gate', p.gate,
      'photoEvidenceId', (select ve.id from public.visitor_evidence ve where ve.visitor_id = v.id and ve.kind = 'photo' and ve.purged_at is null),
      'idEvidenceId', (select ve.id from public.visitor_evidence ve where ve.visitor_id = v.id and ve.kind = 'id' and ve.purged_at is null)
    ) as item
    from public.passes p join public.visitors v on v.id = p.visitor_id
    where p.status = 'pending'::public.pass_status
    order by p.entry_scanned_at asc
    limit v_limit offset v_offset
  ) pending;

  v_has_more := v_pending_total > (v_offset + v_limit);

  select jsonb_build_object(
    'inside', count(*) filter (where status = 'inside'),
    'exited', count(*) filter (where status = 'exited'),
    'rejected', count(*) filter (where status = 'rejected'),
    'total', count(*)
  ) into stats from public.passes
  where issued_at >= date_trunc('day', now() at time zone 'Asia/Manila') at time zone 'Asia/Manila';

  select rejection_reasons into reasons from public.app_settings where singleton;

  return jsonb_build_object(
    'queue', queue,
    'stats', stats,
    'rejectionReasons', coalesce(reasons, '[]'::jsonb),
    'pendingTotal', v_pending_total,
    'hasMore', v_has_more
  );
end;
$$;

revoke all on function api.guard_dashboard(integer, integer) from public, anon;
grant execute on function api.guard_dashboard(integer, integer) to authenticated;
