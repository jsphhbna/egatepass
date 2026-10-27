-- Migration 32: production_wiring_closure
-- Strictly scoped final production wiring repair.

-- =============================================================================
-- 1. DROP OBSOLETE OVERLOADED api.guard_sync_offline_event RPC (FIX 1)
-- =============================================================================
-- Live database currently contains two guard_sync_offline_event overloads:
--   api.guard_sync_offline_event(uuid, uuid, text, text, integer, timestamptz, text)  -- Canonical (Migration 31)
--   api.guard_sync_offline_event(uuid, uuid, text, text, timestamptz, text, integer)  -- Obsolete (Migration 30)
-- Drop the obsolete signature so only the canonical signature survives.

drop function if exists api.guard_sync_offline_event(
  uuid,
  uuid,
  text,
  text,
  timestamptz,
  text,
  integer
);

-- =============================================================================
-- 2. HARDEN AND ALIGN THERMAL TEMPLATE VALIDATOR (FIX 4 SCHEMA PARITY)
-- =============================================================================
-- Synchronize PostgreSQL validator with TypeScript Zod schema:
-- - Maximum elements: 40 (previously 50 in SQL, 40 in TS)
-- - Strictly disallow legacy properties: 'isLocked', 'isRequired', 'label'
-- - Exact canonical property allowlist:
--     id, type, field, x, y, width, height, fontSize, fontWeight, align, text, isMandatory
-- - Canonical primitives: text, qr, divider, rectangle
-- - Canonical field bindings:
--     institution_name, system_title, visitor_name, visit_date,
--     pass_reference, validity_window, purpose, custom
-- - QR minimum dimensions: 140x140

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
  if elements is null or jsonb_typeof(elements) <> 'array' or jsonb_array_length(elements) < 5 or jsonb_array_length(elements) > 40 then
    raise exception using errcode = '22023', message = 'invalid elements count (must be between 5 and 40)';
  end if;

  for elem in select * from jsonb_array_elements(elements) loop
    if jsonb_typeof(elem) <> 'object' then
      raise exception using errcode = '22023', message = 'element must be an object';
    end if;

    -- Strict canonical property allowlist (identical to TypeScript Zod schema)
    for elem_key in select jsonb_object_keys(elem) loop
      if elem_key not in (
        'id', 'type', 'field', 'x', 'y', 'width', 'height',
        'fontSize', 'fontWeight', 'align', 'text', 'isMandatory'
      ) then
        raise exception using errcode = '22023', message = ('unsupported property in element: ' || coalesce(elem_key, 'null'));
      end if;
    end loop;

    -- Canonical Element Primitives
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

-- =============================================================================
-- 3. UPGRADE api.get_published_thermal_template() CONTRACT (FIX 3)
-- =============================================================================
-- Return version, name, and layout as an object for server endpoints and kiosks.

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

revoke all on function api.get_published_thermal_template() from public, anon;
grant execute on function api.get_published_thermal_template() to authenticated, service_role;

-- =============================================================================
-- 4. HARDEN api.admin_restore_thermal_template (VALIDATE BEFORE PUBLISHING)
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

  select coalesce(max(version), 0) + 1 into new_version from public.thermal_templates;

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

-- =============================================================================
-- 5. NORMALIZE PUBLISHED THERMAL TEMPLATE TO CANONICAL SCHEMA (FIX 2)
-- =============================================================================
-- Idempotently inspect published templates:
-- If currently published template has legacy types/properties or fails validator:
--   - Archive it unchanged (preserving historical version 1 immutability)
--   - Insert canonical published version 2 (or next version) matching BUNDLED_DEFAULT_THERMAL_TEMPLATE
-- If a valid canonical published template already exists, leave it alone.

do $$
declare
  curr_pub record;
  is_legacy boolean;
  elem jsonb;
  new_ver integer;
  canonical_layout jsonb := '{
    "width": 384,
    "height": 640,
    "elements": [
      {
        "id": "el-inst-header",
        "type": "text",
        "field": "institution_name",
        "text": "EARIST E-GATEPASS",
        "x": 10,
        "y": 20,
        "width": 364,
        "height": 36,
        "fontSize": 22,
        "fontWeight": "bold",
        "align": "center",
        "isMandatory": true
      },
      {
        "id": "el-inst-sub",
        "type": "text",
        "field": "system_title",
        "text": "CAMPUS VISITOR PASS",
        "x": 10,
        "y": 56,
        "width": 364,
        "height": 24,
        "fontSize": 13,
        "fontWeight": "bold",
        "align": "center",
        "isMandatory": false
      },
      {
        "id": "el-divider-1",
        "type": "divider",
        "x": 16,
        "y": 84,
        "width": 352,
        "height": 4,
        "isMandatory": false
      },
      {
        "id": "el-visitor-name",
        "type": "text",
        "field": "visitor_name",
        "x": 16,
        "y": 98,
        "width": 352,
        "height": 38,
        "fontSize": 20,
        "fontWeight": "bold",
        "align": "center",
        "isMandatory": true
      },
      {
        "id": "el-visit-date",
        "type": "text",
        "field": "visit_date",
        "x": 16,
        "y": 138,
        "width": 352,
        "height": 24,
        "fontSize": 14,
        "fontWeight": "bold",
        "align": "center",
        "isMandatory": true
      },
      {
        "id": "el-validity-window",
        "type": "text",
        "field": "validity_window",
        "x": 16,
        "y": 164,
        "width": 352,
        "height": 20,
        "fontSize": 11,
        "fontWeight": "normal",
        "align": "center",
        "isMandatory": false
      },
      {
        "id": "el-qr-code",
        "type": "qr",
        "x": 82,
        "y": 194,
        "width": 220,
        "height": 220,
        "isMandatory": true
      },
      {
        "id": "el-pass-ref",
        "type": "text",
        "field": "pass_reference",
        "x": 16,
        "y": 426,
        "width": 352,
        "height": 28,
        "fontSize": 16,
        "fontWeight": "bold",
        "align": "center",
        "isMandatory": true
      },
      {
        "id": "el-purpose",
        "type": "text",
        "field": "purpose",
        "x": 20,
        "y": 458,
        "width": 344,
        "height": 30,
        "fontSize": 11,
        "fontWeight": "normal",
        "align": "center",
        "isMandatory": false
      },
      {
        "id": "el-divider-2",
        "type": "divider",
        "x": 16,
        "y": 494,
        "width": 352,
        "height": 4,
        "isMandatory": false
      },
      {
        "id": "el-notice-1",
        "type": "text",
        "field": "custom",
        "text": "Scan at campus gate entrance & exit.",
        "x": 16,
        "y": 508,
        "width": 352,
        "height": 20,
        "fontSize": 11,
        "fontWeight": "normal",
        "align": "center",
        "isMandatory": false
      },
      {
        "id": "el-notice-2",
        "type": "text",
        "field": "custom",
        "text": "Keep this ticket during your stay.",
        "x": 16,
        "y": 530,
        "width": 352,
        "height": 20,
        "fontSize": 11,
        "fontWeight": "normal",
        "align": "center",
        "isMandatory": false
      },
      {
        "id": "el-footer",
        "type": "text",
        "field": "custom",
        "text": "Nagtahan, Sampaloc, Manila",
        "x": 16,
        "y": 570,
        "width": 352,
        "height": 20,
        "fontSize": 10,
        "fontWeight": "normal",
        "align": "center",
        "isMandatory": false
      }
    ]
  }'::jsonb;
begin
  for curr_pub in
    select id, version, layout from public.thermal_templates where status = 'published'
  loop
    is_legacy := false;
    for elem in select * from jsonb_array_elements(coalesce(curr_pub.layout->'elements', '[]'::jsonb)) loop
      if elem->>'type' not in ('text', 'qr', 'divider', 'rectangle')
         or elem ? 'isLocked'
         or elem ? 'isRequired'
         or elem ? 'label' then
        is_legacy := true;
        exit;
      end if;
    end loop;

    if not is_legacy then
      begin
        perform private.validate_thermal_template_layout(curr_pub.layout);
      exception when others then
        is_legacy := true;
      end;
    end if;

    if is_legacy then
      update public.thermal_templates
      set status = 'archived'
      where id = curr_pub.id;
    end if;
  end loop;

  -- If no published template remains, insert canonical version
  if not exists (select 1 from public.thermal_templates where status = 'published') then
    select coalesce(max(version), 0) + 1 into new_ver from public.thermal_templates;

    insert into public.thermal_templates (
      name,
      version,
      status,
      layout,
      published_at
    ) values (
      'Default Institutional 384px Template',
      new_ver,
      'published',
      canonical_layout,
      statement_timestamp()
    );
  end if;
end;
$$;
