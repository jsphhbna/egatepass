-- =============================================================================
-- Migration 91: PL/pgSQL Lint Remediation for api.delete_draft_office,
-- api.update_device_profile, and api.retire_device
-- =============================================================================

create or replace function api.delete_draft_office(
  requested_actor_id uuid,
  requested_office_id uuid,
  requested_request_id uuid default gen_random_uuid()
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor_role public.staff_role;
  target_office public.offices%rowtype;
  has_refs boolean := false;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'service role required';
  end if;

  select role into actor_role
  from public.staff_profiles
  where user_id = requested_actor_id
    and active
    and not must_change_password
    and privacy_accepted_at is not null;

  if actor_role is null or actor_role not in ('admin'::public.staff_role, 'superadmin'::public.staff_role) then
    raise exception using errcode = '42501', message = 'administrator required';
  end if;

  select * into target_office
  from public.offices
  where id = requested_office_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'office_not_found';
  end if;

  if target_office.publication_status <> 'draft' or target_office.published_at is not null or target_office.archived_at is not null then
    raise exception using errcode = '40900', message = 'only_unused_draft_office_may_be_deleted';
  end if;

  select (
    exists (select 1 from public.office_visits where office_id = target_office.id)
    or exists (select 1 from public.office_personnel where office_id = target_office.id)
    or exists (select 1 from public.office_staff_assignments where office_id = target_office.id)
    or exists (select 1 from public.office_provisioning_operations where office_id = target_office.id)
    or exists (select 1 from public.reconciliation_tasks where reference_type in ('office', 'office_visit') and reference_id = target_office.id::text)
    or exists (
      select 1 from public.audit_events
      where target_type in ('office', 'office_visit')
        and target_id = target_office.id::text
        and action not in ('office.create', 'office.created', 'office.update', 'office.updated')
    )
  ) into has_refs;

  if not has_refs and to_regclass('public.emergency_gate_records') is not null then
    execute 'select exists (select 1 from public.emergency_gate_records where destination_office_id = $1)'
      into has_refs
      using target_office.id;
  end if;

  if has_refs then
    raise exception using errcode = '40900', message = 'office_has_dependencies_use_archive';
  end if;

  delete from public.offices where id = target_office.id;

  insert into public.audit_events (
    actor_id, actor_kind, actor_role, action, target_type, target_id, request_id, before_state
  ) values (
    requested_actor_id,
    'staff',
    actor_role::text,
    'office.draft_deleted',
    'office',
    target_office.id::text,
    requested_request_id,
    jsonb_build_object(
      'name', target_office.name,
      'publicationStatus', target_office.publication_status,
      'active', target_office.active
    )
  );

  return jsonb_build_object('deleted', true, 'id', target_office.id, 'name', target_office.name);
end;
$$;

create or replace function api.update_device_profile(
  requested_actor_id uuid,
  requested_user_id uuid,
  requested_status public.device_status default null,
  requested_alias text default null,
  requested_request_id uuid default null,
  requested_name text default null,
  requested_gate text default null
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor_role public.staff_role;
  target public.devices%rowtype;
  next_status public.device_status;
  next_alias text;
  next_name text;
  next_gate text;
  gate_changed boolean;
  status_changed boolean;
  audit_action text;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'service role required';
  end if;

  select sp.role into actor_role
  from public.staff_profiles sp
  where sp.user_id = requested_actor_id
    and sp.active
    and not sp.must_change_password
    and sp.privacy_accepted_at is not null;

  if actor_role not in ('admin'::public.staff_role, 'superadmin'::public.staff_role) then
    raise exception using errcode = '42501', message = 'administrator required';
  end if;

  select * into target
  from public.devices d
  where d.user_id = requested_user_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'device not found';
  end if;

  if target.deleted_at is not null then
    raise exception using errcode = '42501', message = 'cannot modify retired device';
  end if;

  next_status := coalesce(requested_status, target.status);
  next_alias := coalesce(nullif(lower(btrim(requested_alias)), ''), target.alias);
  next_name := coalesce(nullif(btrim(requested_name), ''), target.name);
  next_gate := coalesce(nullif(regexp_replace(btrim(requested_gate), '\s+', ' ', 'g'), ''), target.gate);

  gate_changed := btrim(lower(next_gate)) is distinct from btrim(lower(target.gate));
  status_changed := next_status is distinct from target.status;

  if gate_changed and target.type = 'emergency_device'::public.device_type and actor_role <> 'superadmin'::public.staff_role then
    raise exception using errcode = '42501', message = 'superadmin_required_for_emergency_gate_reassignment';
  end if;

  update public.devices
  set
    status = next_status,
    alias = next_alias,
    name = next_name,
    gate = next_gate,
    updated_at = now()
  where user_id = target.user_id;

  if target.type = 'emergency_device'::public.device_type and (gate_changed or next_status <> 'active'::public.device_status) then
    update public.emergency_device_manifests
    set revoked_at = coalesce(revoked_at, now())
    where device_user_id = target.user_id
      and revoked_at is null;
  end if;

  if gate_changed then
    audit_action := 'device.gate_changed';
  elsif status_changed and next_status = 'revoked'::public.device_status then
    audit_action := 'device.revoke';
  elsif status_changed and next_status = 'active'::public.device_status then
    audit_action := 'device.activate';
  else
    audit_action := 'device.update';
  end if;

  insert into public.audit_events(
    actor_id, actor_kind, actor_role, action, target_type, target_id, request_id, before_state, after_state
  ) values (
    requested_actor_id,
    'staff',
    actor_role::text,
    audit_action,
    'device',
    target.user_id::text,
    coalesce(requested_request_id, gen_random_uuid()),
    jsonb_build_object('status', target.status, 'alias', target.alias, 'name', target.name, 'gate', target.gate),
    jsonb_build_object('status', next_status, 'alias', next_alias, 'name', next_name, 'gate', next_gate)
  );
end $$;

create or replace function api.retire_device(
  requested_actor_id uuid,
  requested_user_id uuid,
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
  target public.devices%rowtype;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'service role required';
  end if;

  select sp.role into actor_role
  from public.staff_profiles sp
  where sp.user_id = requested_actor_id
    and sp.active
    and not sp.must_change_password
    and sp.privacy_accepted_at is not null;

  if actor_role <> 'superadmin'::public.staff_role then
    raise exception using errcode = '42501', message = 'superadmin required';
  end if;

  select * into target from public.devices where user_id = requested_user_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'device not found';
  end if;

  update public.devices
  set status = 'revoked'::public.device_status,
      deleted_at = coalesce(deleted_at, now()),
      updated_at = now()
  where user_id = requested_user_id;

  update public.emergency_device_manifests
  set revoked_at = coalesce(revoked_at, now())
  where device_user_id = requested_user_id
    and revoked_at is null;

  insert into public.audit_events(
    actor_id, actor_kind, actor_role, action, target_type, target_id, request_id, before_state, after_state
  ) values (
    requested_actor_id,
    'staff',
    actor_role::text,
    'device.retire',
    'device',
    requested_user_id::text,
    requested_request_id,
    jsonb_build_object('status', target.status, 'gate', target.gate),
    jsonb_build_object('status', 'revoked', 'retired', true, 'deleted', true)
  );
end $$;

revoke all on function api.delete_draft_office(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function api.delete_draft_office(uuid, uuid, uuid) to service_role;

revoke all on function api.update_device_profile(uuid, uuid, public.device_status, text, uuid, text, text) from public, anon, authenticated;
grant execute on function api.update_device_profile(uuid, uuid, public.device_status, text, uuid, text, text) to service_role;

revoke all on function api.retire_device(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function api.retire_device(uuid, uuid, uuid) to service_role;
