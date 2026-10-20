-- Service-only staff/device governance with actor-matrix enforcement and audit.

alter table public.devices add column if not exists deleted_at timestamptz;

create or replace function api.create_staff_profile(
  requested_actor_id uuid, requested_user_id uuid, requested_name text, requested_role public.staff_role,
  requested_request_id uuid
)
returns void language plpgsql volatile security definer set search_path = '' as $$
declare actor_role public.staff_role;
begin
  if auth.role() <> 'service_role' then raise exception using errcode = '42501', message = 'service role required'; end if;
  select role into actor_role from public.staff_profiles where user_id = requested_actor_id and active and not must_change_password and privacy_accepted_at is not null;
  if actor_role = 'admin' and requested_role <> 'guard'::public.staff_role then raise exception using errcode = '42501', message = 'admins may create guards only'; end if;
  if actor_role not in ('admin'::public.staff_role, 'superadmin'::public.staff_role) then raise exception using errcode = '42501', message = 'administrator required'; end if;
  if requested_role = 'superadmin'::public.staff_role then raise exception using errcode = '42501', message = 'super admin creation requires a role-change review'; end if;
  insert into public.staff_profiles(user_id, display_name, role, active, must_change_password, created_by)
  values (requested_user_id, btrim(requested_name), requested_role, true, requested_role = 'guard', requested_actor_id);
  insert into public.audit_events(actor_id, actor_kind, actor_role, action, target_type, target_id, request_id, after_state)
  values (requested_actor_id, 'staff', actor_role::text, 'staff.create', 'staff_profile', requested_user_id::text, requested_request_id,
    jsonb_build_object('role', requested_role, 'active', true));
end $$;

create or replace function api.update_staff_profile(
  requested_actor_id uuid, requested_user_id uuid, requested_role public.staff_role, requested_active boolean,
  requested_request_id uuid
)
returns void language plpgsql volatile security definer set search_path = '' as $$
declare actor_role public.staff_role; target public.staff_profiles%rowtype; next_role public.staff_role; next_active boolean;
begin
  if auth.role() <> 'service_role' then raise exception using errcode = '42501', message = 'service role required'; end if;
  select role into actor_role from public.staff_profiles where user_id = requested_actor_id and active and not must_change_password and privacy_accepted_at is not null;
  select * into target from public.staff_profiles where user_id = requested_user_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'staff profile not found'; end if;
  if requested_user_id = requested_actor_id then raise exception using errcode = '42501', message = 'self-management denied'; end if;
  next_role := coalesce(requested_role, target.role); next_active := coalesce(requested_active, target.active);
  if actor_role = 'admin'::public.staff_role and (target.role <> 'guard'::public.staff_role or next_role <> 'guard'::public.staff_role) then
    raise exception using errcode = '42501', message = 'admins may manage guards only';
  end if;
  if actor_role not in ('admin'::public.staff_role, 'superadmin'::public.staff_role) then raise exception using errcode = '42501', message = 'administrator required'; end if;
  update public.staff_profiles set role = next_role, active = next_active where user_id = target.user_id;
  insert into public.audit_events(actor_id, actor_kind, actor_role, action, target_type, target_id, request_id, before_state, after_state)
  values (requested_actor_id, 'staff', actor_role::text, 'staff.update', 'staff_profile', target.user_id::text, requested_request_id,
    jsonb_build_object('role', target.role, 'active', target.active), jsonb_build_object('role', next_role, 'active', next_active));
end $$;

create or replace function api.create_device_profile(
  requested_actor_id uuid, requested_user_id uuid, requested_alias text, requested_name text,
  requested_type public.device_type, requested_gate text, requested_request_id uuid
)
returns void language plpgsql volatile security definer set search_path = '' as $$
declare actor_role public.staff_role;
begin
  if auth.role() <> 'service_role' then raise exception using errcode = '42501', message = 'service role required'; end if;
  select role into actor_role from public.staff_profiles where user_id = requested_actor_id and active and not must_change_password and privacy_accepted_at is not null;
  if actor_role not in ('admin'::public.staff_role, 'superadmin'::public.staff_role) then raise exception using errcode = '42501', message = 'administrator required'; end if;
  insert into public.devices(user_id, alias, name, type, gate, status, created_by)
  values (requested_user_id, requested_alias, btrim(requested_name), requested_type, btrim(requested_gate), 'active', requested_actor_id);
  insert into public.audit_events(actor_id, actor_kind, actor_role, action, target_type, target_id, request_id, after_state)
  values (requested_actor_id, 'staff', actor_role::text, 'device.create', 'device', requested_user_id::text, requested_request_id,
    jsonb_build_object('alias', requested_alias, 'type', requested_type, 'gate', btrim(requested_gate), 'status', 'active'));
end $$;

create or replace function api.update_device_profile(
  requested_actor_id uuid, requested_user_id uuid, requested_status public.device_status,
  requested_alias text, requested_request_id uuid
)
returns void language plpgsql volatile security definer set search_path = '' as $$
declare actor_role public.staff_role; target public.devices%rowtype;
begin
  if auth.role() <> 'service_role' then raise exception using errcode = '42501', message = 'service role required'; end if;
  select role into actor_role from public.staff_profiles where user_id = requested_actor_id and active and not must_change_password and privacy_accepted_at is not null;
  select * into target from public.devices where user_id = requested_user_id and deleted_at is null for update;
  if not found then raise exception using errcode = 'P0002', message = 'device not found'; end if;
  if actor_role not in ('admin'::public.staff_role, 'superadmin'::public.staff_role) then raise exception using errcode = '42501', message = 'administrator required'; end if;
  if requested_alias is not null and actor_role <> 'superadmin'::public.staff_role then raise exception using errcode = '42501', message = 'super admin required for credentials'; end if;
  update public.devices set status = coalesce(requested_status, status), alias = coalesce(requested_alias, alias)
  where user_id = target.user_id;
  insert into public.audit_events(actor_id, actor_kind, actor_role, action, target_type, target_id, request_id, before_state, after_state)
  values (requested_actor_id, 'staff', actor_role::text, 'device.update', 'device', target.user_id::text, requested_request_id,
    jsonb_build_object('alias', target.alias, 'status', target.status),
    jsonb_build_object('alias', coalesce(requested_alias, target.alias), 'status', coalesce(requested_status, target.status)));
end $$;

create or replace function api.retire_device(
  requested_actor_id uuid, requested_user_id uuid, requested_request_id uuid
)
returns void language plpgsql volatile security definer set search_path = '' as $$
declare actor_role public.staff_role; target public.devices%rowtype;
begin
  if auth.role() <> 'service_role' then raise exception using errcode = '42501', message = 'service role required'; end if;
  select role into actor_role from public.staff_profiles where user_id = requested_actor_id and active and not must_change_password and privacy_accepted_at is not null;
  if actor_role <> 'superadmin'::public.staff_role then raise exception using errcode = '42501', message = 'super admin required'; end if;
  select * into target from public.devices where user_id = requested_user_id and deleted_at is null for update;
  if not found then raise exception using errcode = 'P0002', message = 'device not found'; end if;
  update public.devices set status = 'revoked', deleted_at = now() where user_id = target.user_id;
  insert into public.audit_events(actor_id, actor_kind, actor_role, action, target_type, target_id, request_id, before_state, after_state)
  values (requested_actor_id, 'staff', actor_role::text, 'device.retire', 'device', target.user_id::text, requested_request_id,
    jsonb_build_object('alias', target.alias, 'status', target.status), jsonb_build_object('status', 'revoked', 'retired', true));
end $$;

revoke all on function api.create_staff_profile(uuid,uuid,text,public.staff_role,uuid) from public, anon, authenticated;
revoke all on function api.update_staff_profile(uuid,uuid,public.staff_role,boolean,uuid) from public, anon, authenticated;
revoke all on function api.create_device_profile(uuid,uuid,text,text,public.device_type,text,uuid) from public, anon, authenticated;
revoke all on function api.update_device_profile(uuid,uuid,public.device_status,text,uuid) from public, anon, authenticated;
revoke all on function api.retire_device(uuid,uuid,uuid) from public, anon, authenticated;
grant execute on function api.create_staff_profile(uuid,uuid,text,public.staff_role,uuid) to service_role;
grant execute on function api.update_staff_profile(uuid,uuid,public.staff_role,boolean,uuid) to service_role;
grant execute on function api.create_device_profile(uuid,uuid,text,text,public.device_type,text,uuid) to service_role;
grant execute on function api.update_device_profile(uuid,uuid,public.device_status,text,uuid) to service_role;
grant execute on function api.retire_device(uuid,uuid,uuid) to service_role;
