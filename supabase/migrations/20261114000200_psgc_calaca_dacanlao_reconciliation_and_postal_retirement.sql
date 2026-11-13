-- Migration 103: PSGC Calaca & Dacanlao Nationwide Reconciliation and Postal Reference Retirement
-- =============================================================================================

-- 1. Deactivate abolished Barangay San Rafael (0401007038) in City of Calaca, Batangas
-- per official PSA Q1 2026 PSGC update (consolidated under Barangay Dacanlao 0401007019).
update public.psgc_locations
set is_active = false,
    updated_at = now()
where psgc_code = '0401007038';

-- 2. Confirm and ensure official canonical Barangay Dacanlao (0401007019) is active under City of Calaca (0401007000)
update public.psgc_locations
set parent_psgc_code = '0401007000',
    name = 'Dacanlao',
    level = 'barangay',
    location_type = 'barangay',
    reference_version_id = '2026-q3',
    is_active = true,
    updated_at = now()
where psgc_code = '0401007019';

-- 3. Ensure City of Calaca (0401007000) is active under Province of Batangas (0410000000)
update public.psgc_locations
set parent_psgc_code = '0410000000',
    name = 'City of Calaca',
    level = 'city',
    location_type = 'city',
    reference_version_id = '2026-q3',
    is_active = true,
    updated_at = now()
where psgc_code = '0401007000';

-- 4. Complete Postal Code Reference Decommissioning
-- Deactivate all active postal code mappings from active lookup while preserving rows for historical integrity.
update public.postal_code_reference
set is_active = false
where is_active = true;

-- 5. Revoke execution on retired legacy template enrollment RPC and drop function
revoke all on function api.enroll_returning_visitor_v1 from public, anon, authenticated, service_role;
drop function if exists api.enroll_returning_visitor_v1;

-- 6. Fully revoke all permissions on retired returning_face_templates table
revoke all on public.returning_face_templates from public, anon, authenticated, service_role;
