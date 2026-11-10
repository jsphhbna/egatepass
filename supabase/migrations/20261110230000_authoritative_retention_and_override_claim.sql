-- Migration 81: Authoritative Retention Policy Synchronization & Superadmin Override Claim Enforcement
-- 1. Updates api.update_retention_policies to authoritatively recalculate expires_at on unpurged visitor_evidence
-- 2. Enhances api.claim_evidence_for_purge with independent Superadmin override contract validation and fail-closed category checks

-- ============================================================================
-- 1. RPC: api.update_retention_policies
-- Authoritatively updates retention settings, appends audit history, and
-- recalculates expires_at for all unpurged visitor_evidence rows according
-- to the new category durations.
-- ============================================================================
create or replace function api.update_retention_policies(
  requested_actor_id uuid,
  requested_photo_enabled boolean,
  requested_photo_days integer,
  requested_id_enabled boolean,
  requested_id_days integer,
  requested_vehicle_enabled boolean,
  requested_vehicle_days integer,
  requested_visitor_enabled boolean,
  requested_visitor_days integer,
  requested_returning_enabled boolean,
  requested_returning_days integer,
  requested_override_reason text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor_role public.staff_role;
  effective_reason text;
  old_settings record;
  audit_entry jsonb;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'service role required';
  end if;

  select role into actor_role from public.staff_profiles
  where user_id = requested_actor_id
    and active
    and not must_change_password
    and privacy_accepted_at is not null;

  if actor_role is null or actor_role <> 'superadmin'::public.staff_role then
    raise exception using errcode = '42501', message = 'Only Superadmin can modify data retention policies';
  end if;

  -- Bounded validation checks
  if requested_photo_days < 1 or requested_photo_days > 365 then
    raise exception using errcode = '23514', message = 'photo_retention_days must be between 1 and 365';
  end if;
  if requested_id_days < 1 or requested_id_days > 365 then
    raise exception using errcode = '23514', message = 'id_retention_days must be between 1 and 365';
  end if;
  if requested_vehicle_days < 1 or requested_vehicle_days > 365 then
    raise exception using errcode = '23514', message = 'vehicle_photo_retention_days must be between 1 and 365';
  end if;
  if requested_visitor_days < 7 or requested_visitor_days > 730 then
    raise exception using errcode = '23514', message = 'visitor_retention_days must be between 7 and 730';
  end if;
  if requested_returning_days < 1 or requested_returning_days > 365 then
    raise exception using errcode = '23514', message = 'returning_profile_retention_days must be between 1 and 365';
  end if;

  effective_reason := nullif(btrim(coalesce(requested_override_reason, '')), '');
  if effective_reason is null then
    effective_reason := 'Superadmin policy update';
  end if;

  -- Load current settings for audit history
  select
    photo_retention_enabled,
    photo_retention_days,
    id_retention_enabled,
    id_retention_days,
    vehicle_photo_retention_enabled,
    vehicle_photo_retention_days,
    visitor_retention_enabled,
    visitor_retention_days,
    returning_profile_retention_enabled,
    returning_profile_retention_days
  into old_settings
  from public.app_settings
  where singleton = true;

  audit_entry := jsonb_build_object(
    'timestamp', now(),
    'superadmin_id', requested_actor_id,
    'reason', effective_reason,
    'previous', jsonb_build_object(
      'photo_retention_enabled', old_settings.photo_retention_enabled,
      'photo_retention_days', old_settings.photo_retention_days,
      'id_retention_enabled', old_settings.id_retention_enabled,
      'id_retention_days', old_settings.id_retention_days,
      'vehicle_photo_retention_enabled', old_settings.vehicle_photo_retention_enabled,
      'vehicle_photo_retention_days', old_settings.vehicle_photo_retention_days,
      'visitor_retention_enabled', old_settings.visitor_retention_enabled,
      'visitor_retention_days', old_settings.visitor_retention_days,
      'returning_profile_retention_enabled', old_settings.returning_profile_retention_enabled,
      'returning_profile_retention_days', old_settings.returning_profile_retention_days
    ),
    'new', jsonb_build_object(
      'photo_retention_enabled', requested_photo_enabled,
      'photo_retention_days', requested_photo_days,
      'id_retention_enabled', requested_id_enabled,
      'id_retention_days', requested_id_days,
      'vehicle_photo_retention_enabled', requested_vehicle_enabled,
      'vehicle_photo_retention_days', requested_vehicle_days,
      'visitor_retention_enabled', requested_visitor_enabled,
      'visitor_retention_days', requested_visitor_days,
      'returning_profile_retention_enabled', requested_returning_enabled,
      'returning_profile_retention_days', requested_returning_days
    )
  );

  update public.app_settings
  set
    photo_retention_enabled = requested_photo_enabled,
    photo_retention_days = requested_photo_days,
    id_retention_enabled = requested_id_enabled,
    id_retention_days = requested_id_days,
    vehicle_photo_retention_enabled = requested_vehicle_enabled,
    vehicle_photo_retention_days = requested_vehicle_days,
    visitor_retention_enabled = requested_visitor_enabled,
    visitor_retention_days = requested_visitor_days,
    returning_profile_retention_enabled = requested_returning_enabled,
    returning_profile_retention_days = requested_returning_days,
    retention_overrides = case
      when jsonb_array_length(retention_overrides) >= 50
      then (retention_overrides - 0) || jsonb_build_array(audit_entry)
      else retention_overrides || jsonb_build_array(audit_entry)
    end,
    updated_at = now()
  where singleton = true;

  -- Authoritatively recalculate expires_at on all unpurged evidence rows based on the new category durations
  update public.visitor_evidence
     set expires_at = coalesce(created_at, verified_at, now()) + make_interval(days => requested_photo_days)
   where kind = 'photo' and purged_at is null;

  update public.visitor_evidence
     set expires_at = coalesce(created_at, verified_at, now()) + make_interval(days => requested_id_days)
   where kind = 'id' and purged_at is null;

  update public.visitor_evidence
     set expires_at = coalesce(created_at, verified_at, now()) + make_interval(days => requested_vehicle_days)
   where kind = 'vehicle_photo' and purged_at is null;

  -- Record structured audit event
  insert into public.audit_events (
    actor_id,
    actor_kind,
    actor_role,
    action,
    target_type,
    target_id,
    after_state
  ) values (
    requested_actor_id,
    'staff',
    'superadmin',
    'maintenance.retention_override',
    'app_settings',
    'retention_policies',
    audit_entry
  );

  return audit_entry;
end;
$$;

revoke all on function api.update_retention_policies(
  uuid, boolean, integer, boolean, integer, boolean, integer, boolean, integer, boolean, integer, text
) from public, anon, authenticated;
grant execute on function api.update_retention_policies(
  uuid, boolean, integer, boolean, integer, boolean, integer, boolean, integer, boolean, integer, text
) to service_role;


-- ============================================================================
-- 2. RPC: api.claim_evidence_for_purge
-- Replaces existing definition with independent Superadmin override contract
-- verification, fail-closed settings validation, and mandatory safeguards.
-- ============================================================================
drop function if exists api.claim_evidence_for_purge(uuid, uuid, boolean);
drop function if exists api.claim_evidence_for_purge(uuid, uuid);

create or replace function api.claim_evidence_for_purge(
  requested_evidence_id uuid,
  requested_claim_id uuid,
  requested_override boolean default false,
  requested_actor_id uuid default null,
  requested_override_reason text default null,
  requested_override_categories text[] default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_evidence record;
  settings record;
  category_days integer;
  category_enabled boolean;
  category_cutoff timestamptz;
  effective_expiry timestamptz;
  actor_role public.staff_role;
  cat_item text;
begin
  if requested_evidence_id is null or requested_claim_id is null then
    return jsonb_build_object('claimed', false, 'reason', 'invalid_argument');
  end if;

  select ve.id, ve.visitor_id, ve.bucket_id, ve.object_path, ve.purged_at, ve.expires_at,
         ve.created_at, ve.verified_at, ve.kind, ve.purge_claim_id, ve.purge_claimed_at
    into v_evidence
    from public.visitor_evidence ve
   where ve.id = requested_evidence_id
   for update;

  if not found then
    return jsonb_build_object('claimed', false, 'reason', 'evidence_not_found');
  end if;

  if v_evidence.purged_at is not null then
    return jsonb_build_object('claimed', false, 'reason', 'already_purged');
  end if;

  -- Freshness check: if claimed recently (< 5 min), deny concurrent purge
  if v_evidence.purge_claim_id is not null
     and v_evidence.purge_claim_id <> requested_claim_id
     and v_evidence.purge_claimed_at >= statement_timestamp() - interval '5 minutes' then
    return jsonb_build_object('claimed', false, 'reason', 'concurrent_purge_in_progress');
  end if;

  -- ==========================================================================
  -- MANDATORY SAFEGUARDS (IMMUTABLE — CAN NEVER BE BYPASSED UNDER ANY CIRCUMSTANCES)
  -- ==========================================================================

  -- SAFEGUARD 1: Active incident hold by visitor_id
  if exists (
    select 1 from public.incident_holds ih
     where ih.visitor_id = v_evidence.visitor_id
       and ih.active = true
  ) then
    return jsonb_build_object('claimed', false, 'reason', 'active_visitor_hold');
  end if;

  -- SAFEGUARD 2: Active incident hold by pass_id belonging to this visitor
  if exists (
    select 1 from public.incident_holds ih
     join public.passes p on p.id = ih.pass_id
     where p.visitor_id = v_evidence.visitor_id
       and ih.active = true
  ) then
    return jsonb_build_object('claimed', false, 'reason', 'active_pass_hold');
  end if;

  -- SAFEGUARD 3: Active, pending, or future issued passes for this visitor
  if exists (
    select 1 from public.passes p
     where p.visitor_id = v_evidence.visitor_id
       and (
         p.status in ('inside', 'pending')
         or (p.status = 'issued' and p.valid_until > statement_timestamp())
       )
  ) then
    return jsonb_build_object('claimed', false, 'reason', 'active_or_future_pass_exists');
  end if;

  -- SAFEGUARD 4: Visitor currently on campus (passes.status = 'inside')
  if exists (
    select 1 from public.passes p
     where p.visitor_id = v_evidence.visitor_id
       and p.status = 'inside'::public.pass_status
  ) then
    return jsonb_build_object('claimed', false, 'reason', 'visitor_currently_inside');
  end if;

  -- ==========================================================================
  -- SUPERADMIN OVERRIDE vs NORMAL RETENTION POLICY ELIGIBILITY
  -- ==========================================================================
  if requested_override then
    -- Independent verification of Superadmin authorization contract
    if requested_actor_id is null then
      return jsonb_build_object('claimed', false, 'reason', 'unauthorized_override_missing_actor');
    end if;

    select role into actor_role from public.staff_profiles
    where user_id = requested_actor_id
      and active
      and not must_change_password
      and privacy_accepted_at is not null;

    if actor_role is null or actor_role <> 'superadmin'::public.staff_role then
      return jsonb_build_object('claimed', false, 'reason', 'unauthorized_override_superadmin_required');
    end if;

    if requested_override_reason is null or length(btrim(requested_override_reason)) < 10 then
      return jsonb_build_object('claimed', false, 'reason', 'invalid_override_reason');
    end if;

    if requested_override_categories is null or cardinality(requested_override_categories) = 0 then
      return jsonb_build_object('claimed', false, 'reason', 'missing_override_categories');
    end if;

    foreach cat_item in array requested_override_categories loop
      if cat_item not in ('photo', 'id', 'vehicle_photo') then
        return jsonb_build_object('claimed', false, 'reason', 'invalid_override_categories');
      end if;
    end loop;

    if not (v_evidence.kind::text = any(requested_override_categories)) then
      return jsonb_build_object('claimed', false, 'reason', 'category_not_in_override');
    end if;

    -- Override explicitly authorized: normal retention deadline and toggle bypassed!
  else
    -- Normal retention policy eligibility
    select photo_retention_enabled, id_retention_enabled, vehicle_photo_retention_enabled,
           photo_retention_days, id_retention_days, vehicle_photo_retention_days,
           image_retention_days
      into settings
      from public.app_settings
     where singleton = true;

    if not found or settings is null then
      return jsonb_build_object('claimed', false, 'reason', 'settings_unavailable');
    end if;

    if v_evidence.kind = 'photo' then
      category_enabled := coalesce(settings.photo_retention_enabled, true);
      category_days := coalesce(settings.photo_retention_days, settings.image_retention_days, 7);
    elsif v_evidence.kind = 'id' then
      category_enabled := coalesce(settings.id_retention_enabled, true);
      category_days := coalesce(settings.id_retention_days, 30);
    elsif v_evidence.kind = 'vehicle_photo' then
      category_enabled := coalesce(settings.vehicle_photo_retention_enabled, true);
      category_days := coalesce(settings.vehicle_photo_retention_days, settings.image_retention_days, 7);
    else
      category_enabled := true;
      category_days := coalesce(settings.image_retention_days, 7);
    end if;

    if not category_enabled then
      return jsonb_build_object('claimed', false, 'reason', 'category_retention_disabled');
    end if;

    category_cutoff := statement_timestamp() - make_interval(days => category_days);
    if coalesce(v_evidence.created_at, v_evidence.verified_at) > category_cutoff then
      return jsonb_build_object('claimed', false, 'reason', 'category_retention_not_expired');
    end if;

    effective_expiry := coalesce(v_evidence.created_at, v_evidence.verified_at, statement_timestamp()) + make_interval(days => category_days);
    if effective_expiry > statement_timestamp() then
      return jsonb_build_object('claimed', false, 'reason', 'not_expired');
    end if;
  end if;

  -- All checks passed: grant purge claim
  update public.visitor_evidence
     set purge_claim_id = requested_claim_id,
         purge_claimed_at = statement_timestamp()
   where id = v_evidence.id;

  return jsonb_build_object(
    'claimed', true,
    'evidence_id', v_evidence.id,
    'visitor_id', v_evidence.visitor_id,
    'bucket_id', v_evidence.bucket_id,
    'object_path', v_evidence.object_path,
    'claim_id', requested_claim_id,
    'claimed_at', statement_timestamp()
  );
end;
$$;

revoke all on function api.claim_evidence_for_purge(uuid, uuid, boolean, uuid, text, text[]) from public, anon, authenticated;
grant execute on function api.claim_evidence_for_purge(uuid, uuid, boolean, uuid, text, text[]) to service_role;
