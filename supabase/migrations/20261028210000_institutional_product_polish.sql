-- =============================================================================
-- Migration: 20261028210000_institutional_product_polish.sql
-- Description: Institutional UX upgrade: visitor instructions, staff permanent
--              decommission state & RPC, and authoritative Guard pending queue search.
-- =============================================================================

-- =============================================================================
-- 1. APP_SETTINGS.VISITOR_INSTRUCTIONS
-- =============================================================================

alter table public.app_settings
  add column if not exists visitor_instructions jsonb not null default '[
    "Follow the EARIST visitor dress code and campus policies.",
    "Bring a valid ID for identity verification at the gate.",
    "Keep your E-GatePass ready before approaching the entrance.",
    "This visitor pass is personal and non-transferable.",
    "Scan your E-GatePass when leaving the campus."
  ]'::jsonb;

alter table public.app_settings
  drop constraint if exists app_settings_visitor_instructions_check;

alter table public.app_settings
  add constraint app_settings_visitor_instructions_check
  check (
    jsonb_typeof(visitor_instructions) = 'array'
    and jsonb_array_length(visitor_instructions) >= 1
    and jsonb_array_length(visitor_instructions) <= 8
  );

-- Grant select on visitor_instructions to anon
grant select (visitor_instructions) on public.app_settings to anon;

create or replace function api.update_visitor_instructions(
  requested_actor_id uuid,
  requested_instructions jsonb
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor_role public.staff_role;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'service role required';
  end if;

  select role into actor_role
  from public.staff_profiles
  where user_id = requested_actor_id and active and not must_change_password;

  if actor_role is null or actor_role not in ('admin'::public.staff_role, 'superadmin'::public.staff_role) then
    raise exception using errcode = '42501', message = 'administrator required';
  end if;

  if jsonb_typeof(requested_instructions) <> 'array' or jsonb_array_length(requested_instructions) < 1 or jsonb_array_length(requested_instructions) > 8 then
    raise exception using errcode = '23514', message = 'visitor_instructions must be an array of 1 to 8 items';
  end if;

  update public.app_settings
  set visitor_instructions = requested_instructions,
      updated_at = clock_timestamp()
  where singleton;
end $$;

revoke all on function api.update_visitor_instructions(uuid, jsonb) from public, anon, authenticated;
grant execute on function api.update_visitor_instructions(uuid, jsonb) to service_role;

-- =============================================================================
-- 2. STAFF_PROFILES DECOMMISSION STATE
-- =============================================================================

alter table public.staff_profiles
  add column if not exists decommissioned_at timestamptz null,
  add column if not exists decommissioned_by uuid null references auth.users(id) on delete set null,
  add column if not exists decommission_reason text null;

alter table public.staff_profiles
  drop constraint if exists staff_profiles_decommissioned_inactive_check;

alter table public.staff_profiles
  add constraint staff_profiles_decommissioned_inactive_check
  check (decommissioned_at is null or active = false);

alter table public.staff_profiles
  drop constraint if exists staff_profiles_decommission_reason_check;

alter table public.staff_profiles
  add constraint staff_profiles_decommission_reason_check
  check (decommission_reason is null or (length(btrim(decommission_reason)) between 5 and 240));

-- =============================================================================
-- 3. API.DECOMMISSION_STAFF_PROFILE RPC
-- =============================================================================

create or replace function api.decommission_staff_profile(
  requested_target_uid uuid,
  requested_reason text,
  requested_actor_id uuid default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := coalesce(auth.uid(), requested_actor_id);
  v_actor_role public.staff_role;
  target_profile public.staff_profiles%rowtype;
  v_clean_reason text := btrim(coalesce(requested_reason, ''));
  v_now timestamptz := statement_timestamp();
begin
  if v_actor_id is null then
    raise exception using errcode = '42501', message = 'authentication_required';
  end if;

  -- 1. Caller must be an active Super Admin
  select role into v_actor_role
  from public.staff_profiles
  where user_id = v_actor_id
    and active = true
    and must_change_password = false
    and privacy_accepted_at is not null;

  if v_actor_role is null or v_actor_role <> 'superadmin'::public.staff_role then
    raise exception using errcode = '42501', message = 'active super admin required';
  end if;

  -- 2. Caller cannot decommission self
  if requested_target_uid = v_actor_id then
    raise exception using errcode = '42501', message = 'cannot decommission self';
  end if;

  -- 3. Target profile must exist
  select * into target_profile
  from public.staff_profiles
  where user_id = requested_target_uid
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'staff profile not found';
  end if;

  -- 4. Target cannot be a managed device identity
  if target_profile.role = 'device'::public.staff_role or exists (
    select 1 from public.devices where user_id = requested_target_uid
  ) then
    raise exception using errcode = '42501', message = 'cannot decommission managed device identity';
  end if;

  -- 5. Target must not already be decommissioned
  if target_profile.decommissioned_at is not null then
    raise exception using errcode = 'P0004', message = 'staff profile already decommissioned';
  end if;

  -- 6. Target must already have active = false
  if target_profile.active = true then
    raise exception using errcode = '42501', message = 'target staff profile must be deactivated before decommissioning';
  end if;

  -- 7. Reason required: 5-240 characters
  if length(v_clean_reason) < 5 or length(v_clean_reason) > 240 then
    raise exception using errcode = '22023', message = 'decommission reason must be between 5 and 240 characters';
  end if;

  -- 8. Apply decommission mutation while retaining historical row and attribution
  update public.staff_profiles
  set
    decommissioned_at = v_now,
    decommissioned_by = v_actor_id,
    decommission_reason = v_clean_reason,
    active = false,
    must_change_password = false,
    updated_at = v_now
  where user_id = requested_target_uid;

  -- 9. Record administrative audit event
  insert into public.audit_events (
    actor_id,
    actor_kind,
    actor_role,
    action,
    target_type,
    target_id,
    request_id,
    before_state,
    after_state,
    outcome
  )
  values (
    v_actor_id,
    'staff',
    'superadmin',
    'staff.decommissioned',
    'staff_profile',
    requested_target_uid::text,
    gen_random_uuid(),
    jsonb_build_object(
      'active', target_profile.active,
      'role', target_profile.role,
      'decommissioned_at', target_profile.decommissioned_at
    ),
    jsonb_build_object(
      'active', false,
      'role', target_profile.role,
      'decommissioned_at', v_now,
      'decommission_reason', v_clean_reason
    ),
    'success'
  );

  return jsonb_build_object(
    'ok', true,
    'targetUid', requested_target_uid,
    'decommissionedAt', v_now
  );
end;
$$;

revoke all on function api.decommission_staff_profile(uuid, text, uuid) from public, anon;
grant execute on function api.decommission_staff_profile(uuid, text, uuid) to authenticated, service_role;

comment on function api.decommission_staff_profile(uuid, text, uuid) is
  'Permanently decommissions an inactive staff account while preserving historical audit attribution. Super Admin only.';

-- =============================================================================
-- 4. API.GUARD_SEARCH_PENDING_QUEUE RPC
-- =============================================================================

create or replace function api.guard_search_pending_queue(
  requested_query text,
  requested_limit integer default 50
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := auth.uid();
  caller_role public.staff_role;
  v_clean_query text := btrim(coalesce(requested_query, ''));
  v_limit integer := coalesce(requested_limit, 50);
  results jsonb;
begin
  -- Recovery session confinement
  if (select private.is_recovery_session()) then
    raise exception using errcode = '42501', message = 'recovery_session_forbidden';
  end if;

  -- Check authorized staff role
  select role into caller_role
  from public.staff_profiles
  where user_id = v_actor_id
    and active = true
    and must_change_password = false
    and privacy_accepted_at is not null;

  if caller_role is null or caller_role not in (
    'guard'::public.staff_role,
    'admin'::public.staff_role,
    'superadmin'::public.staff_role
  ) then
    raise exception using errcode = '42501', message = 'active guard or administrator required';
  end if;

  -- Reject query < 2 or > 100 characters
  if length(v_clean_query) < 2 or length(v_clean_query) > 100 then
    raise exception using errcode = '22023', message = 'search query must be between 2 and 100 characters';
  end if;

  -- Reject limit < 1 or > 100
  if v_limit < 1 or v_limit > 100 then
    raise exception using errcode = '22023', message = 'limit must be between 1 and 100';
  end if;

  -- Expire stale pending passes before calculating results
  update public.passes
  set
    status = 'expired'::public.pass_status,
    updated_at = statement_timestamp(),
    version = version + 1
  where status in ('issued'::public.pass_status, 'pending'::public.pass_status)
    and valid_until <= statement_timestamp();

  -- Execute authoritative search on passes with pending status
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', q.id,
        'visitorName', q.full_name,
        'purpose', q.purpose,
        'source', q.source,
        'status', q.status,
        'validFrom', q.valid_from,
        'validUntil', q.valid_until,
        'scannedAt', q.entry_scanned_at,
        'gate', q.gate,
        'publicReference', q.public_reference,
        'contactNumber', q.contact_number,
        'photoEvidenceId', (
          select ve.id
          from public.visitor_evidence ve
          where ve.visitor_id = q.visitor_id
            and ve.kind = 'photo'::public.evidence_kind
            and ve.purged_at is null
        ),
        'idEvidenceId', (
          select ve.id
          from public.visitor_evidence ve
          where ve.visitor_id = q.visitor_id
            and ve.kind = 'id'::public.evidence_kind
            and ve.purged_at is null
        )
      )
      order by q.entry_scanned_at asc nulls last, q.id asc
    ),
    '[]'::jsonb
  ) into results
  from (
    select
      p.id,
      p.visitor_id,
      p.source,
      p.status,
      p.valid_from,
      p.valid_until,
      p.entry_scanned_at,
      p.gate,
      p.public_reference,
      v.full_name,
      v.purpose,
      v.contact_number
    from public.passes p
    join public.visitors v on v.id = p.visitor_id
    where p.status = 'pending'::public.pass_status
      and (
        v.full_name ilike '%' || v_clean_query || '%'
        or v.contact_number ilike '%' || v_clean_query || '%'
        or v.purpose ilike '%' || v_clean_query || '%'
        or p.public_reference::text ilike '%' || v_clean_query || '%'
      )
    order by p.entry_scanned_at asc nulls last, p.id asc
    limit v_limit
  ) q;

  return results;
end;
$$;

revoke all on function api.guard_search_pending_queue(text, integer) from public, anon;
grant execute on function api.guard_search_pending_queue(text, integer) to authenticated, service_role;

comment on function api.guard_search_pending_queue(text, integer) is
  'Authoritative search across all pending passes by visitor name, contact, purpose, or pass reference. Guard, Admin, and Super Admin only.';
