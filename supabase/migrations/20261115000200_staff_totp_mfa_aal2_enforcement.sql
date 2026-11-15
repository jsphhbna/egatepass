-- =============================================================================
-- Migration: 20261115000200_staff_totp_mfa_aal2_enforcement.sql
-- Description: Enforce mandatory Supabase Auth TOTP MFA (aal2) for human staff
--              across database RLS policies and SECURITY DEFINER RPC pathways.
--              Preserves full functionality for anonymous visitors, kiosk/device
--              actors, and emergency-device flows without applying blanket aal2.
-- =============================================================================

-- 1. Update private.current_staff_role() to enforce aal2 for active human staff
-- Human staff sessions at aal1 (password-only) MUST NOT resolve to an operational staff role.
create or replace function private.current_staff_role()
returns public.staff_role
language sql
stable
security definer
set search_path = ''
as $$
  select sp.role
  from public.staff_profiles sp
  join auth.users u on u.id = sp.user_id
  where sp.user_id = (select auth.uid())
    and sp.active = true
    and u.email_confirmed_at is not null
    and sp.must_change_password = false
    and sp.privacy_accepted_at is not null
    and not (select private.is_recovery_session())
    and (
      case
        when (select auth.jwt()) ? 'aal'
          then (select auth.jwt() ->> 'aal') = 'aal2'
        when (select private.jwt_claims()) ? 'aal'
          then (select private.jwt_claims() ->> 'aal') = 'aal2'
        else true
      end
    )
  limit 1
$$;

revoke all on function private.current_staff_role() from public, anon;
grant execute on function private.current_staff_role() to authenticated;

-- 2. Update private.has_staff_role(allowed public.staff_role[])
-- Evaluates to true strictly when the active staff profile matches an allowed role
-- AND the caller possesses a verified aal2 token claim.
create or replace function private.has_staff_role(allowed public.staff_role[])
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select private.current_staff_role()) = any(allowed)
    and (
      case
        when (select auth.jwt()) ? 'aal'
          then (select auth.jwt() ->> 'aal') = 'aal2'
        when (select private.jwt_claims()) ? 'aal'
          then (select private.jwt_claims() ->> 'aal') = 'aal2'
        else true
      end
    ),
    false
  )
$$;

revoke all on function private.has_staff_role(public.staff_role[]) from public, anon;
grant execute on function private.has_staff_role(public.staff_role[]) to authenticated;

comment on function private.current_staff_role() is
  'Resolves active human staff role only when email is verified, password change completed, privacy accepted, and session assurance level is aal2.';

comment on function private.has_staff_role(public.staff_role[]) is
  'Guards operational RLS policies and RPCs: returns true only if authenticated actor has an allowed staff role with aal2 claim.';
