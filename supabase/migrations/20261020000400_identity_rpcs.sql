-- Identity lifecycle operations that require trusted database state.

create or replace function api.acknowledge_privacy()
returns timestamptz
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  caller_id uuid := (select auth.uid());
  accepted_at timestamptz;
  caller_role public.staff_role;
begin
  if caller_id is null then
    raise exception using errcode = '42501', message = 'authentication required';
  end if;

  update public.staff_profiles
  set privacy_accepted_at = coalesce(privacy_accepted_at, now())
  where user_id = caller_id and active
  returning privacy_accepted_at, role into accepted_at, caller_role;

  if accepted_at is null then
    raise exception using errcode = '42501', message = 'active staff identity required';
  end if;

  insert into public.audit_events (
    actor_id, actor_kind, actor_role, action, target_type, target_id, after_state
  ) values (
    caller_id, 'staff', caller_role::text, 'privacy.acknowledged',
    'staff_profile', caller_id::text, jsonb_build_object('accepted', true)
  );

  return accepted_at;
end;
$$;

create or replace function api.finalize_guard_password_change(target_user_id uuid)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  changed boolean := false;
begin
  if (select auth.role()) <> 'service_role' then
    raise exception using errcode = '42501', message = 'service role required';
  end if;

  perform 1
  from public.staff_profiles
  where user_id = target_user_id
  for update;

  update public.staff_profiles
  set must_change_password = false
  where user_id = target_user_id
    and role = 'guard'::public.staff_role
    and active
    and must_change_password
  returning true into changed;

  if not coalesce(changed, false) then
    raise exception using errcode = '42501', message = 'eligible guard identity required';
  end if;

  insert into public.audit_events (
    actor_id, actor_kind, actor_role, action, target_type, target_id, after_state
  ) values (
    target_user_id, 'staff', 'guard', 'guard.password_change_completed',
    'staff_profile', target_user_id::text, jsonb_build_object('mustChangePassword', false)
  );

  return true;
end;
$$;

revoke all on function api.acknowledge_privacy() from public, anon;
grant execute on function api.acknowledge_privacy() to authenticated;

revoke all on function api.finalize_guard_password_change(uuid) from public, anon, authenticated;
grant execute on function api.finalize_guard_password_change(uuid) to service_role;

comment on function api.acknowledge_privacy() is
  'Records the active staff caller privacy acknowledgement and writes a server-authored audit event.';
comment on function api.finalize_guard_password_change(uuid) is
  'Server-only transactional finalization after the Vercel endpoint verifies the old password and changes the Auth password.';
