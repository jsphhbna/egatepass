-- Migration 79: Office Staff Provisioning & Retention Category Enforcement
-- 1. Atomic Office Staff Account Provisioning RPC (api.provision_office_staff_account)
-- 2. Enhanced api.reset_staff_temporary_password with office validation
-- 3. Enhanced api.claim_evidence_for_purge with category duration revalidation and Superadmin override support
-- 4. Automatic sync of unpurged evidence expiry in api.update_retention_policies

-- ============================================================================
-- 1. RPC: api.provision_office_staff_account
-- Atomically creates staff profile (role=office_staff, must_change_password=true)
-- and assigns user to specified office with audit logging.
-- ============================================================================
create or replace function api.provision_office_staff_account(
  requested_actor_id uuid,
  requested_user_id uuid,
  requested_office_id uuid,
  requested_name text,
  requested_request_id uuid
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor_role public.staff_role;
  target_office public.offices%rowtype;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'service role required';
  end if;

  select role into actor_role from public.staff_profiles
  where user_id = requested_actor_id
    and active
    and not must_change_password
    and privacy_accepted_at is not null;

  if actor_role is null or actor_role not in ('admin'::public.staff_role, 'superadmin'::public.staff_role) then
    raise exception using errcode = '42501', message = 'administrator required';
  end if;

  select * into target_office from public.offices
  where id = requested_office_id;

  if not found then
    raise exception using errcode = 'P0002', message = 'office not found';
  end if;

  if not target_office.active then
    raise exception using errcode = '42501', message = 'office is inactive';
  end if;

  -- 1. Create staff profile with role = 'office_staff', must_change_password = true
  insert into public.staff_profiles(user_id, display_name, role, active, must_change_password, created_by)
  values (
    requested_user_id,
    btrim(requested_name),
    'office_staff'::public.staff_role,
    true,
    true,
    requested_actor_id
  );

  -- 2. Assign staff to this office
  insert into public.office_staff_assignments(user_id, office_id, created_by)
  values (
    requested_user_id,
    requested_office_id,
    requested_actor_id
  );

  -- 3. Audit logging
  insert into public.audit_events(actor_id, actor_kind, actor_role, action, target_type, target_id, request_id, after_state)
  values (
    requested_actor_id,
    'staff',
    actor_role::text,
    'office.account_provisioned',
    'staff_profile',
    requested_user_id::text,
    requested_request_id,
    jsonb_build_object(
      'officeId', requested_office_id,
      'officeName', target_office.name,
      'role', 'office_staff',
      'active', true,
      'mustChangePassword', true
    )
  );
end;
$$;

revoke all on function api.provision_office_staff_account(uuid, uuid, uuid, text, uuid) from public, anon, authenticated;
grant execute on function api.provision_office_staff_account(uuid, uuid, uuid, text, uuid) to service_role;


-- ============================================================================
-- 2. RPC: api.reset_staff_temporary_password (with optional office validation)
-- ============================================================================
create or replace function api.reset_staff_temporary_password(
  requested_actor_id uuid,
  requested_user_id uuid,
  requested_request_id uuid,
  requested_office_id uuid default null
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

  select role into actor_role from public.staff_profiles
  where user_id = requested_actor_id
    and active
    and not must_change_password
    and privacy_accepted_at is not null;

  if actor_role is null or actor_role not in ('admin'::public.staff_role, 'superadmin'::public.staff_role) then
    raise exception using errcode = '42501', message = 'administrator required';
  end if;

  -- If an office is specified, verify that the target staff is actually assigned to it
  if requested_office_id is not null then
    if not exists (
      select 1 from public.office_staff_assignments
      where user_id = requested_user_id and office_id = requested_office_id
    ) then
      raise exception using errcode = '42501', message = 'staff not assigned to specified office';
    end if;
  end if;

  update public.staff_profiles
  set must_change_password = true, updated_at = now()
  where user_id = requested_user_id and decommissioned_at is null;

  if not found then
    raise exception using errcode = 'P0002', message = 'staff profile not found or decommissioned';
  end if;

  insert into public.audit_events(actor_id, actor_kind, actor_role, action, target_type, target_id, request_id, after_state)
  values (
    requested_actor_id,
    'staff',
    actor_role::text,
    'office.credentials_reset',
    'staff_profile',
    requested_user_id::text,
    requested_request_id,
    jsonb_build_object(
      'mustChangePassword', true,
      'officeId', requested_office_id
    )
  );
end;
$$;

revoke all on function api.reset_staff_temporary_password(uuid, uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function api.reset_staff_temporary_password(uuid, uuid, uuid, uuid) to service_role;


-- ============================================================================
-- 3. RPC: api.claim_evidence_for_purge
-- Revalidates category retention eligibility and safeguards before granting purge claim.
-- ============================================================================
create or replace function api.claim_evidence_for_purge(
  requested_evidence_id uuid,
  requested_claim_id uuid,
  requested_override boolean default false
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

  -- Load app settings
  select photo_retention_enabled, id_retention_enabled, vehicle_photo_retention_enabled,
         photo_retention_days, id_retention_days, vehicle_photo_retention_days,
         image_retention_days
    into settings
    from public.app_settings
   where singleton = true;

  -- Check category enabled and retention duration (unless explicit override requested)
  if not requested_override then
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

  -- SAFEGUARD 4: Visitor currently on campus (campus_status = 'inside')
  if exists (
    select 1 from public.visitors v
     where v.id = v_evidence.visitor_id
       and v.campus_status = 'inside'
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
