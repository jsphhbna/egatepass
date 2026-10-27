-- Migration 31: final_cross_layer_closure
-- Strictly scoped corrective pass to close cross-layer contract mismatches.

-- =============================================================================
-- 1. DELETE SEPARATE KIOSK OPERATOR PIN SYSTEM (FIX 1 & FIX 2)
-- =============================================================================
drop function if exists api.verify_kiosk_operator_pin(text);
drop function if exists api.admin_set_kiosk_operator_pin(text);
drop table if exists private.kiosk_operator_config cascade;

-- =============================================================================
-- 2. HARDEN api.guard_sync_offline_event EXPECTED VERSION CONTRACT (FIX 4)
-- =============================================================================
drop function if exists api.guard_sync_offline_event(uuid, uuid, text, text, integer, timestamptz, text);

create or replace function api.guard_sync_offline_event(
  requested_event_id uuid,
  requested_pass_id uuid,
  requested_action text,
  requested_expected_status text,
  requested_expected_version integer,
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
  existing_receipt public.offline_sync_receipts%rowtype;
  target public.passes%rowtype;
  actual_pass_id uuid := requested_pass_id;
  new_event_id uuid := gen_random_uuid();
  pass_status_val public.pass_status;
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

  -- 4. Mandatory Expected Version Fencing (FIX 4)
  -- For existing canonical passes, requested_expected_version MUST be supplied.
  if requested_expected_version is null then
    insert into public.offline_sync_receipts (
      event_id, pass_id, action, status, client_occurred_at, actor_id, conflict_reason, payload
    ) values (
      requested_event_id, target.id, requested_action, 'conflict', requested_occurred_at, actor.user_id,
      'expected_version_required',
      jsonb_build_object('serverVersion', target.version, 'expectedStatus', requested_expected_status)
    );

    insert into public.reconciliation_tasks (
      operation, reference_type, reference_id, safe_context, last_error_code
    ) values (
      'offline_sync_version_missing', 'pass', target.id::text,
      jsonb_build_object('eventId', requested_event_id, 'passId', target.id, 'serverVersion', target.version),
      'expected_version_required'
    );

    return jsonb_build_object(
      'status', 'conflict',
      'reason', 'expected_version_required',
      'eventId', requested_event_id
    );
  end if;

  if target.version <> requested_expected_version then
    insert into public.offline_sync_receipts (
      event_id, pass_id, action, status, client_occurred_at, actor_id, conflict_reason, payload
    ) values (
      requested_event_id, target.id, requested_action, 'conflict', requested_occurred_at, actor.user_id,
      'version_conflict: expected v' || requested_expected_version || ' but server is v' || target.version,
      jsonb_build_object(
        'expectedVersion', requested_expected_version,
        'serverVersion', target.version,
        'expectedStatus', requested_expected_status
      )
    );

    insert into public.reconciliation_tasks (
      operation, reference_type, reference_id, safe_context, last_error_code
    ) values (
      'offline_sync_version_conflict', 'pass', target.id::text,
      jsonb_build_object(
        'eventId', requested_event_id, 'passId', target.id,
        'expectedVersion', requested_expected_version, 'serverVersion', target.version
      ),
      'version_conflict'
    );

    return jsonb_build_object(
      'status', 'conflict',
      'reason', 'version_conflict',
      'eventId', requested_event_id
    );
  end if;

  -- 5. Status Transition Legitimacy Check (R05)
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
    pass_status_val := 'inside'::public.pass_status;
    update public.passes set
      status = pass_status_val,
      version = target.version + 1,
      time_in = coalesce(target.time_in, requested_occurred_at),
      gate = coalesce(target.gate, 'Offline Gate'),
      updated_at = statement_timestamp(),
      offline_synced_at = statement_timestamp()
    where id = target.id;

    insert into public.visit_events (
      pass_id, visitor_id, event, reason, gate, guard_id, occurred_at, request_id, details
    ) values (
      target.id, target.visitor_id, 'approved'::public.visit_event_type,
      'guard_offline_sync', coalesce(target.gate, 'Offline Gate'), actor.user_id, requested_occurred_at, requested_event_id,
      jsonb_build_object('offline_synced_at', statement_timestamp())
    );

  elsif requested_action = 'reject_entry' then
    pass_status_val := 'rejected'::public.pass_status;
    update public.passes set
      status = pass_status_val,
      version = target.version + 1,
      decided_at = requested_occurred_at,
      decided_by = actor.user_id,
      rejection_reason = coalesce(requested_reason, 'Rejected offline by guard'),
      updated_at = statement_timestamp(),
      offline_synced_at = statement_timestamp()
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
    pass_status_val := 'exited'::public.pass_status;
    update public.passes set
      status = pass_status_val,
      version = target.version + 1,
      time_out = requested_occurred_at,
      updated_at = statement_timestamp(),
      offline_synced_at = statement_timestamp()
    where id = target.id;

    insert into public.visit_events (
      pass_id, visitor_id, event, reason, gate, guard_id, occurred_at, request_id, details
    ) values (
      target.id, target.visitor_id, 'scan_exit'::public.visit_event_type,
      'guard_offline_sync', coalesce(target.gate, 'Offline Gate'), actor.user_id, requested_occurred_at, requested_event_id,
      jsonb_build_object('offline_synced_at', statement_timestamp())
    );
  end if;

  insert into public.offline_sync_receipts (
    event_id, pass_id, action, status, client_occurred_at, actor_id, payload, result
  ) values (
    requested_event_id, target.id, requested_action, 'applied', requested_occurred_at, actor.user_id,
    jsonb_build_object('expectedStatus', requested_expected_status, 'expectedVersion', requested_expected_version, 'reason', requested_reason),
    jsonb_build_object('nextStatus', pass_status_val::text, 'passId', target.id, 'version', target.version + 1)
  );

  return jsonb_build_object(
    'status', 'applied',
    'eventId', requested_event_id,
    'newStatus', pass_status_val::text,
    'version', target.version + 1
  );
end;
$$;

revoke all on function api.guard_sync_offline_event(uuid, uuid, text, text, integer, timestamptz, text) from public, anon;
grant execute on function api.guard_sync_offline_event(uuid, uuid, text, text, integer, timestamptz, text) to authenticated;

-- =============================================================================
-- 3. UNIFY THERMAL TEMPLATE VALIDATOR SCHEMA (FIX 5)
-- =============================================================================
create or replace function private.validate_thermal_template_layout(
  requested_layout jsonb
)
returns void
language plpgsql
immutable
set search_path = ''
as $$
declare
  layout_w integer;
  layout_h integer;
  elements jsonb;
  elem jsonb;
  elem_key text;
  elem_type text;
  elem_field text;
  elem_x integer;
  elem_y integer;
  elem_w integer;
  elem_h integer;
  elem_font integer;
  elem_weight text;
  elem_align text;
  elem_text text;
  has_inst boolean := false;
  has_name boolean := false;
  has_date boolean := false;
  has_qr boolean := false;
  has_ref boolean := false;
begin
  if requested_layout is null or jsonb_typeof(requested_layout) <> 'object' then
    raise exception using errcode = '22023', message = 'template layout must be an object';
  end if;

  -- Validate width: exactly 384px (native MXW01 width)
  layout_w := (requested_layout->>'width')::integer;
  if layout_w is distinct from 384 then
    raise exception using errcode = '22023', message = 'template width must be exactly 384px';
  end if;

  -- Validate height: 400px to 1600px
  layout_h := (requested_layout->>'height')::integer;
  if layout_h is null or layout_h < 400 or layout_h > 1600 then
    raise exception using errcode = '22023', message = 'template height must be between 400 and 1600px';
  end if;

  elements := requested_layout->'elements';
  if elements is null or jsonb_typeof(elements) <> 'array' or jsonb_array_length(elements) < 5 or jsonb_array_length(elements) > 50 then
    raise exception using errcode = '22023', message = 'invalid elements count (must be between 5 and 50)';
  end if;

  for elem in select * from jsonb_array_elements(elements) loop
    if jsonb_typeof(elem) <> 'object' then
      raise exception using errcode = '22023', message = 'element must be an object';
    end if;

    -- Known property allowlist: reject arbitrary unknown JSON properties
    for elem_key in select jsonb_object_keys(elem) loop
      if elem_key not in (
        'id', 'type', 'field', 'label', 'x', 'y', 'width', 'height',
        'fontSize', 'fontWeight', 'align', 'text', 'isMandatory', 'isLocked', 'isRequired'
      ) then
        raise exception using errcode = '22023', message = ('unsupported property in element: ' || coalesce(elem_key, 'null'));
      end if;
    end loop;

    -- Canonical Element Primitives (FIX 5)
    elem_type := elem->>'type';
    if elem_type not in ('text', 'qr', 'divider', 'rectangle') then
      raise exception using errcode = '22023', message = ('unsupported element type: ' || coalesce(elem_type, 'null'));
    end if;

    -- Field Bindings (if present)
    if elem ? 'field' then
      elem_field := elem->>'field';
      if elem_field not in (
        'institution_name', 'system_title', 'visitor_name', 'visit_date',
        'pass_reference', 'validity_window', 'purpose', 'custom'
      ) then
        raise exception using errcode = '22023', message = ('unsupported field binding: ' || coalesce(elem_field, 'null'));
      end if;
    else
      elem_field := null;
    end if;

    -- Coordinate bounds
    elem_x := (elem->>'x')::integer;
    elem_y := (elem->>'y')::integer;
    if elem_x is null or elem_x < 0 or elem_x > 384 then
      raise exception using errcode = '22023', message = 'x coordinate out of bounds (0-384)';
    end if;
    if elem_y is null or elem_y < 0 or elem_y > layout_h then
      raise exception using errcode = '22023', message = 'y coordinate out of bounds';
    end if;

    -- Width/height bounds
    elem_w := (elem->>'width')::integer;
    elem_h := (elem->>'height')::integer;
    if elem_w is null or elem_w < 1 or elem_w > 384 then
      raise exception using errcode = '22023', message = 'element width out of bounds (1-384)';
    end if;
    if elem_h is null or elem_h < 1 or elem_h > layout_h then
      raise exception using errcode = '22023', message = 'element height out of bounds';
    end if;

    -- Canvas boundary checks
    if (elem_x + elem_w) > (layout_w + 1) then
      raise exception using errcode = '22023', message = 'element exceeds canvas width';
    end if;
    if (elem_y + elem_h) > (layout_h + 1) then
      raise exception using errcode = '22023', message = 'element exceeds canvas height';
    end if;

    -- QR minimum size: at least 140x140 for hardware scan reliability
    if elem_type = 'qr' then
      if elem_w < 140 or elem_h < 140 then
        raise exception using errcode = '22023', message = 'qr minimum size is 140x140';
      end if;
    end if;

    -- Font size bounds
    if elem ? 'fontSize' then
      elem_font := (elem->>'fontSize')::integer;
      if elem_font is null or elem_font < 8 or elem_font > 48 then
        raise exception using errcode = '22023', message = 'font size out of bounds (8-48)';
      end if;
    end if;

    -- Font weight bounds
    if elem ? 'fontWeight' then
      elem_weight := elem->>'fontWeight';
      if elem_weight not in ('normal', 'bold') then
        raise exception using errcode = '22023', message = 'fontWeight must be normal or bold';
      end if;
    end if;

    -- Align bounds
    if elem ? 'align' then
      elem_align := elem->>'align';
      if elem_align not in ('left', 'center', 'right') then
        raise exception using errcode = '22023', message = 'align must be left, center, or right';
      end if;
    end if;

    -- Text content safety: no HTML, scripts, or remote URLs
    if elem ? 'text' then
      elem_text := coalesce(elem->>'text', '');
      if elem_text ~* '[<>]' or elem_text ~* 'javascript:' or elem_text ~* 'https?://' then
        raise exception using errcode = '22023', message = 'element text contains forbidden markup or URLs';
      end if;
    end if;

    -- Mandatory elements tracking
    if elem_type = 'text' and (elem_field = 'institution_name' or (elem ? 'text' and elem->>'text' ~* 'EARIST')) then
      has_inst := true;
    end if;
    if elem_type = 'text' and elem_field = 'visitor_name' then
      has_name := true;
    end if;
    if elem_type = 'text' and elem_field = 'visit_date' then
      has_date := true;
    end if;
    if elem_type = 'qr' then
      has_qr := true;
    end if;
    if elem_type = 'text' and elem_field = 'pass_reference' then
      has_ref := true;
    end if;
  end loop;

  if not (has_inst and has_name and has_date and has_qr and has_ref) then
    raise exception using errcode = '22023', message = 'missing mandatory locked template elements';
  end if;
end;
$$;

grant execute on function private.validate_thermal_template_layout(jsonb) to authenticated, service_role;

-- Replace api.admin_save_thermal_template
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

-- Replace api.admin_publish_thermal_template
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

  -- Re-validate layout with unified canonical schema
  perform private.validate_thermal_template_layout(target_layout);

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

-- =============================================================================
-- 4. FIX ONLINE RECOVERY SEARCH BY PUBLIC PASS REFERENCE (FIX 6)
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
  norm_ref_query text := regexp_replace(upper(regexp_replace(clean_query, '^EG-?', '', 'i')), '[^A-F0-9]', '', 'g');
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
      'publicReference', p.public_reference,
      'passReference', ('EG-' || upper(substr(replace(p.public_reference::text, '-', ''), 1, 8))),
      'visitorId', v.id,
      'visitorName', v.full_name,
      'contactNumber', v.contact_number,
      'purpose', v.purpose,
      'status', p.status,
      'version', p.version,
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
        or (char_length(norm_ref_query) >= 2 and replace(upper(p.public_reference::text), '-', '') like (norm_ref_query || '%'))
      )
    order by p.created_at desc
    limit v_limit
  ) sub;

  return results;
end;
$$;

revoke all on function api.guard_search_recovery_visitors(text, integer) from public, anon;
grant execute on function api.guard_search_recovery_visitors(text, integer) to authenticated;
