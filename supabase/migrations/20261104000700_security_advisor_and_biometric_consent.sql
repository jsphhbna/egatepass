-- Migration: 20261104000700_security_advisor_and_biometric_consent.sql
-- Description:
-- 1. Consolidate thermal_templates RLS policies to eliminate multiple permissive SELECT policies
--    identified by Supabase Security Advisor (thermal_templates_superadmin_all + thermal_templates_read_published).
-- 2. Explicitly tighten backend-only table permissions in accordance with the established
--    least-privilege matrix:
--    - public.maintenance_state: revoke all from public, anon, authenticated; service_role has SELECT, INSERT, UPDATE only (no DELETE)
--    - public.rate_limit_buckets: revoke all from public, anon, authenticated, service_role (RPC-only access)

-- ============================================================================
-- Section 1: Consolidate thermal_templates RLS policies
-- ============================================================================

drop policy if exists thermal_templates_superadmin_all on public.thermal_templates;
drop policy if exists thermal_templates_read_published on public.thermal_templates;
drop policy if exists thermal_templates_select on public.thermal_templates;
drop policy if exists thermal_templates_superadmin_insert on public.thermal_templates;
drop policy if exists thermal_templates_superadmin_update on public.thermal_templates;
drop policy if exists thermal_templates_superadmin_delete on public.thermal_templates;

-- Single consolidated SELECT policy for authenticated users:
-- Superadmins can view all templates (draft, published, archived);
-- Kiosks and staff (admin/superadmin) can view published templates.
create policy thermal_templates_select on public.thermal_templates
  for select to authenticated
  using (
    (select private.has_staff_role(array['superadmin']::public.staff_role[]))
    or (
      status = 'published'
      and (
        (select private.current_device_type()) = 'kiosk'::public.device_type
        or (select private.has_staff_role(array['admin', 'superadmin']::public.staff_role[]))
      )
    )
  );

-- Explicit write policies restricted strictly to Superadmins
create policy thermal_templates_superadmin_insert on public.thermal_templates
  for insert to authenticated
  with check ((select private.has_staff_role(array['superadmin']::public.staff_role[])));

create policy thermal_templates_superadmin_update on public.thermal_templates
  for update to authenticated
  using ((select private.has_staff_role(array['superadmin']::public.staff_role[])))
  with check ((select private.has_staff_role(array['superadmin']::public.staff_role[])));

create policy thermal_templates_superadmin_delete on public.thermal_templates
  for delete to authenticated
  using ((select private.has_staff_role(array['superadmin']::public.staff_role[])));

-- ============================================================================
-- Section 2: Explicitly tighten backend-only table permissions
-- ============================================================================

revoke all on public.maintenance_state from public, anon, authenticated;
revoke delete on public.maintenance_state from service_role;
grant select, insert, update on public.maintenance_state to service_role;

revoke all on public.rate_limit_buckets from public, anon, authenticated, service_role;
