-- Forward migration to add explicit ::text cast for public.evidence_kind comparison in api.claim_evidence_for_purge

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
