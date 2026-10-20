-- =============================================================================
-- Migration: 20261020204805_public_registration_settings_and_auth_hardening.sql
-- Description: Safe anon settings column RLS & admin-controlled device credential change trigger
-- =============================================================================

-- =============================================================================
-- 1. SAFE ANON SETTINGS ACCESS
-- =============================================================================

-- Add anon SELECT RLS policy restricted to singleton = true
drop policy if exists app_settings_anon_select on public.app_settings;
create policy app_settings_anon_select
  on public.app_settings
  for select
  to anon
  using (singleton = true);

-- Grant anon column-level SELECT ONLY for safe public settings columns
revoke all on public.app_settings from anon;
grant select (
  working_hours_start,
  working_hours_end,
  timezone,
  scheduling_days_ahead,
  peak_mode,
  visit_purposes
) on public.app_settings to anon;

-- Ensure authenticated role retains full select
grant select on public.app_settings to authenticated;

-- =============================================================================
-- 2. PROTECT MANAGED CREDENTIALS TRIGGER (REPLACE AUTH.ROLE() CHECK)
-- =============================================================================

create or replace function public.protect_managed_credentials()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  is_managed_device boolean;
  password_changed boolean;
  email_changed boolean;
  old_marker text;
  new_marker text;
begin
  -- 1. Anonymous accounts cannot set passwords
  -- E-GatePass does not support converting an anonymous visitor actor into a password-bearing account.
  if coalesce(old.is_anonymous, false) is true then
    if (new.encrypted_password is distinct from old.encrypted_password) then
      raise exception using errcode = '42501', message = 'anonymous accounts cannot set passwords';
    end if;
  end if;

  -- 2. Determine device identity:
  -- Devices have @devices.egatepass.invalid email OR an active/existing record in public.devices.
  is_managed_device := (
    lower(coalesce(old.email, '')) like '%@devices.egatepass.invalid'
    or exists (
      select 1
        from public.devices d
       where d.user_id = old.id
    )
  );

  -- 3. Determine credential change
  password_changed := new.encrypted_password is distinct from old.encrypted_password;
  email_changed := new.email is distinct from old.email;

  -- 4. Managed Device Governance:
  -- If password or email changed, require a fresh, admin-controlled rotation marker in raw_app_meta_data.
  if is_managed_device and (password_changed or email_changed) then
    old_marker := old.raw_app_meta_data ->> 'egatepass_device_credential_change_id';
    new_marker := new.raw_app_meta_data ->> 'egatepass_device_credential_change_id';

    if new_marker is null or btrim(new_marker) = '' or new_marker is not distinct from old_marker then
      raise exception using errcode = '42501', message = 'device credentials are super admin managed';
    end if;
  end if;

  -- 5. Housekeeping updates are allowed through when credentials did not change.
  return new;
end;
$$;

-- 8. Harden the trigger function: revoke direct execution privileges from application roles
revoke all on function public.protect_managed_credentials() from public, anon, authenticated;

-- Ensure trigger is attached to auth.users if auth.users exists
do $$
begin
  if exists (
    select 1
      from information_schema.columns
     where table_schema = 'auth'
       and table_name = 'users'
       and column_name = 'encrypted_password'
  ) then
    drop trigger if exists trg_protect_managed_credentials on auth.users;
    create trigger trg_protect_managed_credentials
      before update on auth.users
      for each row
      execute function public.protect_managed_credentials();
  end if;
end;
$$;
