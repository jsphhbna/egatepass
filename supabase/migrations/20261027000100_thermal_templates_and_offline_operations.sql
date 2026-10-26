-- Migration: 20261027000100_thermal_templates_and_offline_operations.sql
-- Description: Adds thermal template versioning, offline sync idempotency receipts,
--              guard visitor recovery RPCs, and offline registration & sync transactions.

-- =============================================================================
-- 1. ADD 'guard_offline' TO public.pass_source ENUM
-- =============================================================================
alter type public.pass_source add value if not exists 'guard_offline';

-- =============================================================================
-- 2. EXTEND public.passes FOR OFFLINE REGISTRATION TRACKING
-- =============================================================================
alter table public.passes
  add column if not exists offline_registration_id uuid unique,
  add column if not exists offline_synced_at timestamptz;

create index if not exists idx_passes_offline_registration_id
  on public.passes(offline_registration_id)
  where offline_registration_id is not null;

-- =============================================================================
-- 3. THERMAL TEMPLATES TABLE (SUPER ADMIN OWNED, VERSIONED)
-- =============================================================================
create table if not exists public.thermal_templates (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  version integer not null,
  status text not null check (status in ('draft', 'published', 'archived')),
  layout jsonb not null,
  created_by uuid references auth.users(id),
  published_by uuid references auth.users(id),
  created_at timestamptz not null default statement_timestamp(),
  published_at timestamptz,
  constraint uq_thermal_template_version unique (version)
);

create index if not exists idx_thermal_templates_status on public.thermal_templates(status);

alter table public.thermal_templates enable row level security;
revoke all on public.thermal_templates from anon, authenticated;
grant select on public.thermal_templates to authenticated;

drop policy if exists thermal_templates_superadmin_all on public.thermal_templates;
create policy thermal_templates_superadmin_all on public.thermal_templates
  for all to authenticated
  using ((select private.has_staff_role(array['superadmin']::public.staff_role[])))
  with check ((select private.has_staff_role(array['superadmin']::public.staff_role[])));

drop policy if exists thermal_templates_read_published on public.thermal_templates;
create policy thermal_templates_read_published on public.thermal_templates
  for select to authenticated
  using (
    status = 'published'
    and (
      (select private.current_device_type()) = 'kiosk'::public.device_type
      or (select private.has_staff_role(array['guard', 'admin', 'superadmin']::public.staff_role[]))
    )
  );

-- Seed Version 1 Known-Good Published Default
insert into public.thermal_templates (
  name,
  version,
  status,
  layout,
  published_at
)
values (
  'Default Institutional 384px Template',
  1,
  'published',
  '{"width":384,"elements":[{"id":"inst-name","type":"institution_name","label":"Institution Name","x":192,"y":24,"fontSize":16,"fontWeight":"bold","align":"center","isLocked":true,"isRequired":true},{"id":"inst-sub","type":"static_text","label":"Subtitle","x":192,"y":44,"fontSize":10,"fontWeight":"normal","align":"center","text":"CAMPUS VISITOR PASS","isLocked":false,"isRequired":false},{"id":"div-1","type":"divider","label":"Divider","x":20,"y":58,"width":344,"height":1,"isLocked":false,"isRequired":false},{"id":"vis-name","type":"visitor_name","label":"Visitor Name","x":192,"y":88,"fontSize":20,"fontWeight":"bold","align":"center","isLocked":true,"isRequired":true},{"id":"vis-date","type":"visit_date","label":"Visit Date","x":192,"y":114,"fontSize":12,"fontWeight":"bold","align":"center","isLocked":true,"isRequired":true},{"id":"qr-code","type":"qr_code","label":"QR Code","x":87,"y":134,"width":210,"height":210,"isLocked":true,"isRequired":true},{"id":"pass-ref","type":"pass_reference","label":"Pass Reference","x":192,"y":364,"fontSize":12,"fontWeight":"bold","align":"center","isLocked":true,"isRequired":true},{"id":"recovery-note","type":"static_text","label":"Recovery Notice","x":192,"y":386,"fontSize":9,"fontWeight":"normal","align":"center","text":"Lost QR? Present valid ID to Guard.","isLocked":false,"isRequired":false}]}'::jsonb,
  statement_timestamp()
)
on conflict (version) do nothing;

-- =============================================================================
-- 4. OFFLINE SYNC RECEIPTS TABLE (IDEMPOTENCY & RECONCILIATION)
-- =============================================================================
create table if not exists public.offline_sync_receipts (
  event_id uuid primary key,
  offline_registration_id uuid,
  pass_id uuid references public.passes(id),
  action text not null check (action in ('approve_entry', 'reject_entry', 'record_exit', 'register_visitor')),
  status text not null check (status in ('applied', 'conflict', 'duplicate')),
  client_occurred_at timestamptz not null,
  server_synced_at timestamptz not null default statement_timestamp(),
  actor_id uuid not null references auth.users(id),
  conflict_reason text,
  payload jsonb not null default '{}'::jsonb,
  result jsonb not null default '{}'::jsonb
);

create index if not exists idx_offline_receipts_reg_id on public.offline_sync_receipts(offline_registration_id);
create index if not exists idx_offline_receipts_pass_id on public.offline_sync_receipts(pass_id);

alter table public.offline_sync_receipts enable row level security;
revoke all on public.offline_sync_receipts from anon, authenticated;
grant select on public.offline_sync_receipts to authenticated;

drop policy if exists offline_sync_receipts_staff_select on public.offline_sync_receipts;
create policy offline_sync_receipts_staff_select on public.offline_sync_receipts
  for select to authenticated
  using ((select private.has_staff_role(array['guard', 'admin', 'superadmin']::public.staff_role[])));

-- =============================================================================
-- 5. UPDATE private.can_read_visitor TO PERMIT GUARD RECOVERY FOR ISSUED/INSIDE
-- =============================================================================
create or replace function private.can_read_visitor(target_visitor_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.visitors v
    where v.id = target_visitor_id
      and (
        (
          v.owner_id = (select auth.uid())
          and v.source = 'portal'::public.pass_source
          and (select private.is_portal_actor())
        )
        or (select private.has_staff_role(array['admin','superadmin']::public.staff_role[]))
        or (
          (select private.has_staff_role(array['guard']::public.staff_role[]))
          and exists (
            select 1 from public.passes p
            where p.visitor_id = v.id
              and p.status in ('issued'::public.pass_status, 'pending'::public.pass_status, 'inside'::public.pass_status)
          )
        )
      )
  )
$$;

-- =============================================================================
-- 6. UPDATE api.create_upload_intent TO SUPPORT guard_offline
-- =============================================================================
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
  if requested_source = 'kiosk'::public.pass_source then
    if caller_device_type is distinct from 'kiosk'::public.device_type then
      raise exception using errcode = '42501', message = 'active kiosk identity required';
    end if;
  elsif requested_source = 'portal'::public.pass_source then
    if not (select private.is_portal_actor()) then
      raise exception using errcode = '42501', message = 'visitor identity required';
    end if;

    perform pg_advisory_xact_lock(hashtext('upload_intent:' || caller_id::text));

    select count(*) into pending_count
      from public.upload_intents ui
     where ui.owner_id = caller_id
       and ui.status = 'pending'::public.upload_intent_status
       and ui.expires_at > statement_timestamp();

    if pending_count >= 10 then
      raise exception using errcode = 'P0003', message = 'too_many_pending_intents';
    end if;
  elsif requested_source = 'guard_offline'::public.pass_source then
    if not (select private.has_staff_role(array['guard', 'superadmin']::public.staff_role[])) then
      raise exception using errcode = '42501', message = 'active guard or administrator required';
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

-- =============================================================================
-- 7. RPC: api.guard_search_recovery_visitors (PHASE 4.2)
-- =============================================================================
create or replace function api.guard_search_recovery_visitors(
  query text,
  requested_limit integer default 20
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  caller_role public.staff_role := (select private.current_staff_role());
  v_limit integer := least(greatest(coalesce(requested_limit, 20), 1), 50);
  clean_query text := btrim(coalesce(query, ''));
  results jsonb;
  v_day_start timestamptz := date_trunc('day', statement_timestamp() at time zone 'Asia/Manila') at time zone 'Asia/Manila';
  v_day_end timestamptz := (date_trunc('day', statement_timestamp() at time zone 'Asia/Manila') + interval '1 day') at time zone 'Asia/Manila';
begin
  if (select private.is_recovery_session()) then
    raise exception using errcode = '42501', message = 'recovery_session_forbidden';
  end if;

  if caller_role is null or caller_role not in ('guard'::public.staff_role, 'admin'::public.staff_role, 'superadmin'::public.staff_role) then
    raise exception using errcode = '42501', message = 'active guard or administrator required';
  end if;

  if clean_query = '' or char_length(clean_query) < 2 then
    return '[]'::jsonb;
  end if;

  select coalesce(jsonb_agg(item), '[]'::jsonb) into results
  from (
    select jsonb_build_object(
      'id', p.id,
      'visitorId', v.id,
      'visitorName', v.full_name,
      'contactNumber', v.contact_number,
      'purpose', v.purpose,
      'status', p.status,
      'source', p.source,
      'validFrom', p.valid_from,
      'validUntil', p.valid_until,
      'timeIn', p.time_in,
      'timeOut', p.time_out,
      'scannedAt', p.entry_scanned_at,
      'gate', p.gate,
      'photoEvidenceId', (
        select ve.id from public.visitor_evidence ve
        where ve.visitor_id = v.id and ve.kind = 'photo'::public.evidence_kind and ve.purged_at is null
        limit 1
      ),
      'idEvidenceId', (
        select ve.id from public.visitor_evidence ve
        where ve.visitor_id = v.id and ve.kind = 'id'::public.evidence_kind and ve.purged_at is null
        limit 1
      )
    ) as item
    from public.passes p
    join public.visitors v on v.id = p.visitor_id
    where p.status in ('issued'::public.pass_status, 'pending'::public.pass_status, 'inside'::public.pass_status)
      and p.valid_from >= v_day_start
      and p.valid_from < v_day_end
      and (
        v.full_name ilike ('%' || clean_query || '%')
        or v.contact_number ilike ('%' || clean_query || '%')
        or p.id::text ilike (clean_query || '%')
      )
    order by p.created_at desc
    limit v_limit
  ) sub;

  return results;
end;
$$;

revoke all on function api.guard_search_recovery_visitors(text, integer) from public, anon;
grant execute on function api.guard_search_recovery_visitors(text, integer) to authenticated;

-- =============================================================================
-- 8. RPC: api.guard_recover_pass_action (PHASE 4.4 - MANUAL RECOVERY ACTIONS)
-- =============================================================================
create or replace function api.guard_recover_pass_action(
  requested_pass_id uuid,
  requested_action text,
  requested_reason text default null
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
  next_status public.pass_status;
  clean_reason text := btrim(coalesce(requested_reason, ''));
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

  if requested_action not in ('approve_entry', 'reject_entry', 'record_exit') then
    raise exception using errcode = '22023', message = 'invalid recovery action';
  end if;

  select * into target from public.passes where id = requested_pass_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'pass not found';
  end if;

  if requested_action = 'approve_entry' then
    if target.status not in ('issued'::public.pass_status, 'pending'::public.pass_status) then
      raise exception using errcode = '40001', message = 'pass is not eligible for entry approval';
    end if;
    next_status := 'inside'::public.pass_status;

    update public.passes set
      status = next_status,
      time_in = coalesce(time_in, statement_timestamp()),
      entry_scanned_at = coalesce(entry_scanned_at, statement_timestamp()),
      decided_at = statement_timestamp(),
      decided_by = actor.user_id,
      gate = coalesce(gate, 'Recovery Gate'),
      updated_at = statement_timestamp(),
      version = version + 1
    where id = target.id;

    insert into public.visit_events (
      pass_id, visitor_id, event, reason, gate, guard_id, request_id
    ) values (
      target.id, target.visitor_id, 'approved'::public.visit_event_type,
      case when clean_reason <> '' then clean_reason else 'visitor_recovery' end,
      coalesce(target.gate, 'Recovery Gate'), actor.user_id, gen_random_uuid()
    );

    insert into public.audit_events (
      actor_id, actor_kind, actor_role, action, target_type, target_id, outcome, after_state
    ) values (
      actor.user_id, 'staff', actor.role, 'gate.visitor_recovery_approve', 'passes', target.id, 'success',
      jsonb_build_object('source', 'visitor_recovery', 'status', 'inside')
    );

  elsif requested_action = 'reject_entry' then
    if target.status not in ('issued'::public.pass_status, 'pending'::public.pass_status) then
      raise exception using errcode = '40001', message = 'pass is not eligible for rejection';
    end if;
    if clean_reason = '' then
      clean_reason := 'Rejected by Guard during visitor recovery';
    end if;
    next_status := 'rejected'::public.pass_status;

    update public.passes set
      status = next_status,
      decided_at = statement_timestamp(),
      decided_by = actor.user_id,
      rejection_reason = clean_reason,
      updated_at = statement_timestamp(),
      version = version + 1
    where id = target.id;

    insert into public.visit_events (
      pass_id, visitor_id, event, reason, gate, guard_id, request_id
    ) values (
      target.id, target.visitor_id, 'rejected'::public.visit_event_type,
      clean_reason, coalesce(target.gate, 'Recovery Gate'), actor.user_id, gen_random_uuid()
    );

    insert into public.audit_events (
      actor_id, actor_kind, actor_role, action, target_type, target_id, outcome, after_state
    ) values (
      actor.user_id, 'staff', actor.role, 'gate.visitor_recovery_reject', 'passes', target.id, 'success',
      jsonb_build_object('source', 'visitor_recovery', 'status', 'rejected', 'reason', clean_reason)
    );

  elsif requested_action = 'record_exit' then
    if target.status <> 'inside'::public.pass_status then
      raise exception using errcode = '40001', message = 'pass is not recorded as inside';
    end if;
    next_status := 'exited'::public.pass_status;

    update public.passes set
      status = next_status,
      time_out = statement_timestamp(),
      updated_at = statement_timestamp(),
      version = version + 1
    where id = target.id;

    insert into public.visit_events (
      pass_id, visitor_id, event, reason, gate, guard_id, request_id
    ) values (
      target.id, target.visitor_id, 'scan_exit'::public.visit_event_type,
      case when clean_reason <> '' then clean_reason else 'visitor_recovery_exit' end,
      coalesce(target.gate, 'Recovery Gate'), actor.user_id, gen_random_uuid()
    );

    insert into public.audit_events (
      actor_id, actor_kind, actor_role, action, target_type, target_id, outcome, after_state
    ) values (
      actor.user_id, 'staff', actor.role, 'gate.visitor_recovery_exit', 'passes', target.id, 'success',
      jsonb_build_object('source', 'visitor_recovery', 'status', 'exited')
    );
  end if;

  return jsonb_build_object('success', true, 'passId', target.id, 'status', next_status);
end;
$$;

revoke all on function api.guard_recover_pass_action(uuid, text, text) from public, anon;
grant execute on function api.guard_recover_pass_action(uuid, text, text) to authenticated;

-- =============================================================================
-- 9. RPC: api.guard_sync_offline_event (PHASE 10.1 - EXISTING PASS SYNC)
-- =============================================================================
create or replace function api.guard_sync_offline_event(
  requested_event_id uuid,
  requested_pass_id uuid,
  requested_action text,
  requested_expected_status text,
  requested_occurred_at timestamptz,
  requested_reason text default null
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

  -- 2. Timestamp sanity check (Phase 10.6)
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
      task_type, payload
    ) values (
      'offline_sync_timestamp_skew',
      jsonb_build_object('eventId', requested_event_id, 'passId', requested_pass_id, 'occurredAt', requested_occurred_at)
    );

    return jsonb_build_object(
      'status', 'conflict',
      'reason', 'suspicious_client_timestamp',
      'eventId', requested_event_id
    );
  end if;

  -- 3. Row-lock target pass
  select * into target from public.passes where id = requested_pass_id for update;
  if not found then
    insert into public.offline_sync_receipts (
      event_id, pass_id, action, status, client_occurred_at, actor_id, conflict_reason, payload
    ) values (
      requested_event_id, requested_pass_id, requested_action, 'conflict', requested_occurred_at, actor.user_id,
      'pass_not_found', jsonb_build_object('expectedStatus', requested_expected_status)
    );
    return jsonb_build_object('status', 'conflict', 'reason', 'pass_not_found', 'eventId', requested_event_id);
  end if;

  -- 4. Conflict detection: Check current server state vs expected state (Phase 10.5)
  if target.status::text <> requested_expected_status then
    insert into public.offline_sync_receipts (
      event_id, pass_id, action, status, client_occurred_at, actor_id, conflict_reason, payload
    ) values (
      requested_event_id, requested_pass_id, requested_action, 'conflict', requested_occurred_at, actor.user_id,
      'status_mismatch: expected ' || requested_expected_status || ' but found ' || target.status::text,
      jsonb_build_object('expectedStatus', requested_expected_status, 'serverStatus', target.status::text)
    );

    insert into public.reconciliation_tasks (
      task_type, payload
    ) values (
      'offline_sync_status_conflict',
      jsonb_build_object(
        'eventId', requested_event_id,
        'passId', requested_pass_id,
        'expectedStatus', requested_expected_status,
        'serverStatus', target.status::text
      )
    );

    return jsonb_build_object(
      'status', 'conflict',
      'reason', 'status_mismatch',
      'serverStatus', target.status::text,
      'eventId', requested_event_id
    );
  end if;

  -- 5. Apply state transition with honest provenance
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
      pass_id, visitor_id, event, reason, gate, guard_id, request_id
    ) values (
      target.id, target.visitor_id, 'approved'::public.visit_event_type,
      'guard_offline_sync', coalesce(target.gate, 'Offline Gate'), actor.user_id, requested_event_id
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
      pass_id, visitor_id, event, reason, gate, guard_id, request_id
    ) values (
      target.id, target.visitor_id, 'rejected'::public.visit_event_type,
      coalesce(requested_reason, 'guard_offline_sync'), coalesce(target.gate, 'Offline Gate'), actor.user_id, requested_event_id
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
      pass_id, visitor_id, event, reason, gate, guard_id, request_id
    ) values (
      target.id, target.visitor_id, 'scan_exit'::public.visit_event_type,
      'guard_offline_sync', coalesce(target.gate, 'Offline Gate'), actor.user_id, requested_event_id
    );
  else
    raise exception using errcode = '22023', message = 'invalid action';
  end if;

  res := jsonb_build_object('nextStatus', next_status, 'passId', target.id);

  insert into public.offline_sync_receipts (
    event_id, pass_id, action, status, client_occurred_at, actor_id, payload, result
  ) values (
    requested_event_id, target.id, requested_action, 'applied', requested_occurred_at, actor.user_id,
    jsonb_build_object('expectedStatus', requested_expected_status, 'reason', requested_reason),
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

revoke all on function api.guard_sync_offline_event(uuid, uuid, text, text, timestamptz, text) from public, anon;
grant execute on function api.guard_sync_offline_event(uuid, uuid, text, text, timestamptz, text) to authenticated;

-- =============================================================================
-- 10. RPC: api.guard_sync_offline_registration (PHASE 10.2 - NEW OFFLINE VISITOR)
-- =============================================================================
create or replace function api.guard_sync_offline_registration(
  requested_registration_id uuid,
  requested_visitor jsonb,
  requested_action text,
  requested_occurred_at timestamptz,
  requested_photo_intent_id uuid,
  requested_id_intent_id uuid default null,
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
  existing_pass public.passes%rowtype;
  new_visitor_id uuid := gen_random_uuid();
  new_pass_id uuid := gen_random_uuid();
  pass_status_val public.pass_status;
  first_name_val text := btrim(coalesce(requested_visitor->>'firstName', ''));
  middle_name_val text := nullif(btrim(coalesce(requested_visitor->>'middleName', '')), '');
  last_name_val text := btrim(coalesce(requested_visitor->>'lastName', ''));
  full_name_val text;
  contact_number_val text := btrim(coalesce(requested_visitor->>'contactNumber', ''));
  purpose_val text := btrim(coalesce(requested_visitor->>'purpose', ''));
  visit_date_val text := btrim(coalesce(requested_visitor->>'visitDate', ''));
  raw_token text;
  token_digest_val bytea;
  photo_intent public.upload_intents%rowtype;
  id_intent public.upload_intents%rowtype;
  v_day_start timestamptz;
  v_day_end timestamptz;
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

  -- 1. Idempotency Check (Phase 10.2): Never duplicate on retry with same offlineRegistrationId
  select * into existing_pass from public.passes
  where offline_registration_id = requested_registration_id;
  if found then
    return jsonb_build_object(
      'status', 'applied',
      'duplicate', true,
      'passId', existing_pass.id,
      'visitorId', existing_pass.visitor_id,
      'passStatus', existing_pass.status
    );
  end if;

  -- 2. Validate mandatory fields
  if first_name_val = '' or last_name_val = '' or contact_number_val = '' or purpose_val = '' or visit_date_val = '' then
    raise exception using errcode = '22023', message = 'missing required visitor registration fields';
  end if;

  full_name_val := first_name_val || coalesce(' ' || middle_name_val, '') || ' ' || last_name_val;

  -- 3. Validate Photo Intent
  select * into photo_intent from public.upload_intents
  where id = requested_photo_intent_id and bucket_id = 'visitor-photos' for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'photo upload intent not found';
  end if;

  -- 4. Validate ID Intent if provided
  if requested_id_intent_id is not null then
    select * into id_intent from public.upload_intents
    where id = requested_id_intent_id and bucket_id = 'visitor-ids' for update;
    if not found then
      raise exception using errcode = 'P0002', message = 'id upload intent not found';
    end if;
  end if;

  -- 5. Create visitor with source = 'guard_offline'
  insert into public.visitors (
    id, first_name, middle_name, last_name, full_name, contact_number, purpose, source, owner_id
  ) values (
    new_visitor_id, first_name_val, middle_name_val, last_name_val, full_name_val, contact_number_val,
    purpose_val, 'guard_offline'::public.pass_source, actor.user_id
  );

  -- 6. Link photo evidence
  update public.upload_intents
  set visitor_id = new_visitor_id, status = 'uploaded'::public.upload_intent_status
  where id = photo_intent.id;

  insert into public.visitor_evidence (
    visitor_id, kind, bucket_id, object_path, content_type, bytes
  ) values (
    new_visitor_id, 'photo'::public.evidence_kind, photo_intent.bucket_id,
    photo_intent.object_path, photo_intent.content_type, photo_intent.max_bytes
  );

  -- Link ID evidence if provided
  if id_intent.id is not null then
    update public.upload_intents
    set visitor_id = new_visitor_id, status = 'uploaded'::public.upload_intent_status
    where id = id_intent.id;

    insert into public.visitor_evidence (
      visitor_id, kind, bucket_id, object_path, content_type, bytes
    ) values (
      new_visitor_id, 'id'::public.evidence_kind, id_intent.bucket_id,
      id_intent.object_path, id_intent.content_type, id_intent.max_bytes
    );
  end if;

  -- 7. Generate secure opaque pass token
  raw_token := encode(gen_random_bytes(32), 'hex');
  token_digest_val := digest(raw_token, 'sha256');

  pass_status_val := case when requested_action = 'approved' then 'inside'::public.pass_status else 'rejected'::public.pass_status end;
  v_day_start := requested_occurred_at;
  v_day_end := requested_occurred_at + interval '12 hours';

  -- 8. Insert canonical pass record
  insert into public.passes (
    id, visitor_id, token_digest, status, source, offline_registration_id,
    time_in, decided_at, decided_by, rejection_reason,
    valid_from, valid_until, gate, offline_synced_at
  ) values (
    new_pass_id, new_visitor_id, token_digest_val, pass_status_val, 'guard_offline'::public.pass_source,
    requested_registration_id,
    case when requested_action = 'approved' then requested_occurred_at else null end,
    requested_occurred_at, actor.user_id,
    case when requested_action = 'rejected' then coalesce(requested_rejection_reason, 'Rejected offline by guard') else null end,
    v_day_start, v_day_end, 'Offline Gate', statement_timestamp()
  );

  -- 9. Insert visit lifecycle event
  insert into public.visit_events (
    pass_id, visitor_id, event, reason, gate, guard_id, request_id
  ) values (
    new_pass_id, new_visitor_id,
    case when requested_action = 'approved' then 'approved'::public.visit_event_type else 'rejected'::public.visit_event_type end,
    'guard_offline_registration', 'Offline Gate', actor.user_id, requested_registration_id
  );

  res := jsonb_build_object(
    'passId', new_pass_id,
    'visitorId', new_visitor_id,
    'passStatus', pass_status_val
  );

  -- 10. Store sync receipt for registration idempotency
  insert into public.offline_sync_receipts (
    event_id, offline_registration_id, pass_id, action, status, client_occurred_at, actor_id, payload, result
  ) values (
    requested_registration_id, requested_registration_id, new_pass_id, 'register_visitor', 'applied',
    requested_occurred_at, actor.user_id,
    requested_visitor,
    res
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
    'passStatus', pass_status_val
  );
end;
$$;

revoke all on function api.guard_sync_offline_registration(uuid, jsonb, text, timestamptz, uuid, uuid, text) from public, anon;
grant execute on function api.guard_sync_offline_registration(uuid, jsonb, text, timestamptz, uuid, uuid, text) to authenticated;

-- =============================================================================
-- 11. RPCs: SUPER ADMIN THERMAL TEMPLATE MANAGEMENT (PHASE 3)
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
begin
  if actor_role is distinct from 'superadmin'::public.staff_role then
    raise exception using errcode = '42501', message = 'superadmin required';
  end if;

  if (requested_layout->>'width')::integer is distinct from 384 then
    raise exception using errcode = '22023', message = 'template width must be 384px';
  end if;

  elements := requested_layout->'elements';
  if elements is null or jsonb_typeof(elements) <> 'array' or jsonb_array_length(elements) < 5 then
    raise exception using errcode = '22023', message = 'invalid elements schema';
  end if;

  for elem in select * from jsonb_array_elements(elements) loop
    if elem->>'type' = 'institution_name' then has_inst := true; end if;
    if elem->>'type' = 'visitor_name' then has_name := true; end if;
    if elem->>'type' = 'visit_date' then has_date := true; end if;
    if elem->>'type' = 'qr_code' then has_qr := true; end if;
    if elem->>'type' = 'pass_reference' then has_ref := true; end if;
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
begin
  if actor_role is distinct from 'superadmin'::public.staff_role then
    raise exception using errcode = '42501', message = 'superadmin required';
  end if;

  select id into target_id from public.thermal_templates
  where version = requested_version for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'template version not found';
  end if;

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
  if actor_role is distinct from 'superadmin'::public.staff_role then
    raise exception using errcode = '42501', message = 'superadmin required';
  end if;

  select * into source_template from public.thermal_templates
  where version = source_version;
  if not found then
    raise exception using errcode = 'P0002', message = 'source template version not found';
  end if;

  select coalesce(max(version), 0) + 1 into new_version from public.thermal_templates;

  -- Archive current published
  update public.thermal_templates set status = 'archived' where status = 'published';

  -- Create restored version and immediately publish it (Phase 3.4: create new version, never mutate history)
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

create or replace function api.get_published_thermal_template()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  published_layout jsonb;
begin
  select layout into published_layout from public.thermal_templates
  where status = 'published'
  order by version desc
  limit 1;

  return coalesce(published_layout, 'null'::jsonb);
end;
$$;

revoke all on function api.admin_save_thermal_template(text, jsonb, integer) from public, anon;
revoke all on function api.admin_publish_thermal_template(integer) from public, anon;
revoke all on function api.admin_restore_thermal_template(integer) from public, anon;
revoke all on function api.get_published_thermal_template() from public, anon;

grant execute on function api.admin_save_thermal_template(text, jsonb, integer) to authenticated;
grant execute on function api.admin_publish_thermal_template(integer) to authenticated;
grant execute on function api.admin_restore_thermal_template(integer) to authenticated;
grant execute on function api.get_published_thermal_template() to authenticated;
