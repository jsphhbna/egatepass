-- Migration: 20261024142836_bootstrap_super_admin_hardening.sql
-- Description: Harden private.bootstrap_super_admin with confirmed human Auth identity validation,
--              anonymous/device rejection, display name bounds, and one-time first staff profile lock.

create or replace function private.bootstrap_super_admin(
  target_user_id uuid,
  target_display_name text
)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  target_user record;
  trimmed_name text;
begin
  -- 1. Operator check: only authorized postgres/supabase_admin DB operators may execute
  if current_user not in ('postgres', 'supabase_admin') then
    raise exception using errcode = '42501', message = 'bootstrap requires an authorized database operator';
  end if;

  -- 2. Target validation: verify target exists in auth.users
  select id, email, email_confirmed_at, is_anonymous
  into target_user
  from auth.users
  where id = target_user_id;

  if not found then
    raise exception using errcode = '23503', message = 'Auth user does not exist';
  end if;

  -- 3. Reject anonymous Auth users
  if coalesce(target_user.is_anonymous, false) then
    raise exception using errcode = '23514', message = 'anonymous users cannot be bootstrapped as super admin';
  end if;

  -- 4. Require usable non-empty email
  if target_user.email is null or btrim(target_user.email) = '' then
    raise exception using errcode = '23514', message = 'bootstrap target must have a valid email';
  end if;

  -- 5. Require confirmed email
  if target_user.email_confirmed_at is null then
    raise exception using errcode = '23514', message = 'bootstrap target email must be confirmed';
  end if;

  -- 6. Reject managed device identities (@devices.egatepass.invalid namespace)
  if lower(target_user.email) like '%@devices.egatepass.invalid' then
    raise exception using errcode = '23514', message = 'managed device identities cannot be bootstrapped as super admin';
  end if;

  -- 7. Display name validation: trimmed length between 2 and 120 characters
  trimmed_name := btrim(target_display_name);
  if char_length(trimmed_name) < 2 or char_length(trimmed_name) > 120 then
    raise exception using errcode = '23514', message = 'display name must be between 2 and 120 characters';
  end if;

  -- 8. One-time lock: bootstrap is permitted only before the very first staff profile exists
  if exists (select 1 from public.staff_profiles) then
    raise exception using errcode = '23514', message = 'bootstrap is allowed only before the first staff profile';
  end if;

  -- 9. Insert initial Super Admin staff profile
  insert into public.staff_profiles (
    user_id,
    display_name,
    role,
    active,
    must_change_password,
    created_by
  )
  values (
    target_user_id,
    trimmed_name,
    'superadmin'::public.staff_role,
    true,
    true,
    target_user_id
  );

  -- 10. Record immutable bootstrap audit event
  insert into public.audit_events (
    actor_id,
    actor_kind,
    actor_role,
    action,
    target_type,
    target_id,
    after_state
  )
  values (
    target_user_id,
    'system',
    'bootstrap',
    'superadmin.bootstrap',
    'staff_profile',
    target_user_id::text,
    jsonb_build_object(
      'role', 'superadmin',
      'active', true,
      'mustChangePassword', true
    )
  );
end;
$$;

-- Ensure execute is strictly revoked from public, anon, and authenticated
revoke all on function private.bootstrap_super_admin(uuid, text) from public, anon, authenticated;