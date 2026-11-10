-- ============================================================================
-- Migration 80: Reconcile claim_evidence_for_purge inside pass safeguard
-- ============================================================================
-- Replaces api.claim_evidence_for_purge to check public.passes for on-campus
-- ('inside') status instead of non-existent public.visitors.campus_status column.
-- Preserves all category policy controls, overrides, and mandatory safeguards.
-- ============================================================================

create or replace function api.claim_evidence_for_purge(
  requested_evidence_id uuid,
  requested_claim_id uuid,
  requested_override boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public, api, pg_temp
as $$
declare
  v_evidence record;
  v_settings record;
  v_photo_days integer;
  v_id_days integer;
  v_vehicle_days integer;
  v_default_days integer;
  v_photo_enabled boolean;
  v_id_enabled boolean;
  v_vehicle_enabled boolean;
begin
  select *
    into v_evidence
    from public.visitor_evidence
   where id = requested_evidence_id
     and purged_at is null
   for update skip locked;

  if not found then
    return jsonb_build_object('claimed', false, 'reason', 'not_found_or_locked');
  end if;

  -- Load app settings
  select *
    into v_settings
    from public.app_settings
   where singleton = true;

  v_default_days := coalesce(v_settings.image_retention_days, 7);
  v_photo_days := coalesce(v_settings.photo_retention_days, v_default_days);
  v_id_days := coalesce(v_settings.id_retention_days, 30);
  v_vehicle_days := coalesce(v_settings.vehicle_photo_retention_days, v_default_days);

  v_photo_enabled := coalesce(v_settings.photo_retention_enabled, true);
  v_id_enabled := coalesce(v_settings.id_retention_enabled, true);
  v_vehicle_enabled := coalesce(v_settings.vehicle_photo_retention_enabled, true);

  -- Category policy check (unless Superadmin override is active)
  if not coalesce(requested_override, false) then
    if v_evidence.kind = 'photo' and not v_photo_enabled then
      return jsonb_build_object('claimed', false, 'reason', 'photo_retention_disabled');
    end if;

    if v_evidence.kind = 'id' and not v_id_enabled then
      return jsonb_build_object('claimed', false, 'reason', 'id_retention_disabled');
    end if;

    if v_evidence.kind = 'vehicle_photo' and not v_vehicle_enabled then
      return jsonb_build_object('claimed', false, 'reason', 'vehicle_photo_retention_disabled');
    end if;

    -- Enforce category duration cutoff based on evidence creation
    if v_evidence.kind = 'photo' and v_evidence.created_at > (statement_timestamp() - (v_photo_days || ' days')::interval) then
      return jsonb_build_object('claimed', false, 'reason', 'photo_retention_not_elapsed');
    elsif v_evidence.kind = 'id' and v_evidence.created_at > (statement_timestamp() - (v_id_days || ' days')::interval) then
      return jsonb_build_object('claimed', false, 'reason', 'id_retention_not_elapsed');
    elsif v_evidence.kind = 'vehicle_photo' and v_evidence.created_at > (statement_timestamp() - (v_vehicle_days || ' days')::interval) then
      return jsonb_build_object('claimed', false, 'reason', 'vehicle_photo_retention_not_elapsed');
    end if;

    if v_evidence.expires_at > statement_timestamp() then
      return jsonb_build_object('claimed', false, 'reason', 'not_expired');
    end if;
  end if;

  -- Freshness check: if claimed recently (< 5 min), deny concurrent purge
  if v_evidence.purge_claim_id is not null
     and v_evidence.purge_claim_id <> requested_claim_id
     and v_evidence.purge_claimed_at >= statement_timestamp() - interval '5 minutes' then
    return jsonb_build_object('claimed', false, 'reason', 'concurrent_purge_in_progress');
  end if;

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

  -- SAFEGUARD 4: Visitor currently on campus (pass status = 'inside')
  if exists (
    select 1 from public.passes p
     where p.visitor_id = v_evidence.visitor_id
       and p.status = 'inside'::public.pass_status
  ) then
    return jsonb_build_object('claimed', false, 'reason', 'visitor_currently_inside');
  end if;

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

revoke all on function api.claim_evidence_for_purge(uuid, uuid, boolean) from public, anon, authenticated;
grant execute on function api.claim_evidence_for_purge(uuid, uuid, boolean) to service_role;
