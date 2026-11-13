-- ==============================================================================
-- Migration 96: PSGC Valenzuela Reconciliation & Workflow Governance
-- ==============================================================================

begin;

-- ------------------------------------------------------------------------------
-- 1. Reconcile City of Valenzuela (1381600000) and all 33 Official PSA Barangays
-- ------------------------------------------------------------------------------

-- Clean up any obsolete/misaligned references
delete from public.postal_code_reference
where psgc_locality_code in ('1381600000', '1382000000')
   or barangay_psgc_code like '13816%'
   or barangay_psgc_code like '13820%';

delete from public.psgc_locations
where parent_psgc_code in ('1381600000', '1382000000');

delete from public.psgc_locations
where psgc_code in ('1381600000', '1382000000');

-- Insert City of Valenzuela under NCR (1300000000)
insert into public.psgc_locations (psgc_code, parent_psgc_code, name, level, location_type, reference_version_id, is_active)
values
  ('1381600000', '1300000000', 'City of Valenzuela', 'city', 'huc', '2026-q3', true);

-- Insert all 33 official PSA barangays of Valenzuela (1381600001 - 1381600033)
insert into public.psgc_locations (psgc_code, parent_psgc_code, name, level, location_type, reference_version_id, is_active)
values
  ('1381600001', '1381600000', 'Arkong Bato', 'barangay', 'barangay', '2026-q3', true),
  ('1381600002', '1381600000', 'Bagbaguin', 'barangay', 'barangay', '2026-q3', true),
  ('1381600003', '1381600000', 'Balangkas', 'barangay', 'barangay', '2026-q3', true),
  ('1381600004', '1381600000', 'Parada', 'barangay', 'barangay', '2026-q3', true),
  ('1381600005', '1381600000', 'Bignay', 'barangay', 'barangay', '2026-q3', true),
  ('1381600006', '1381600000', 'Bisig', 'barangay', 'barangay', '2026-q3', true),
  ('1381600007', '1381600000', 'Canumay West', 'barangay', 'barangay', '2026-q3', true),
  ('1381600008', '1381600000', 'Karuhatan', 'barangay', 'barangay', '2026-q3', true),
  ('1381600009', '1381600000', 'Coloong', 'barangay', 'barangay', '2026-q3', true),
  ('1381600010', '1381600000', 'Dalandanan', 'barangay', 'barangay', '2026-q3', true),
  ('1381600011', '1381600000', 'Gen. T. de Leon', 'barangay', 'barangay', '2026-q3', true),
  ('1381600012', '1381600000', 'Isla', 'barangay', 'barangay', '2026-q3', true),
  ('1381600013', '1381600000', 'Lawang Bato', 'barangay', 'barangay', '2026-q3', true),
  ('1381600014', '1381600000', 'Lingunan', 'barangay', 'barangay', '2026-q3', true),
  ('1381600015', '1381600000', 'Mabolo', 'barangay', 'barangay', '2026-q3', true),
  ('1381600016', '1381600000', 'Malanday', 'barangay', 'barangay', '2026-q3', true),
  ('1381600017', '1381600000', 'Malinta', 'barangay', 'barangay', '2026-q3', true),
  ('1381600018', '1381600000', 'Mapulang Lupa', 'barangay', 'barangay', '2026-q3', true),
  ('1381600019', '1381600000', 'Marulas', 'barangay', 'barangay', '2026-q3', true),
  ('1381600020', '1381600000', 'Maysan', 'barangay', 'barangay', '2026-q3', true),
  ('1381600021', '1381600000', 'Palasan', 'barangay', 'barangay', '2026-q3', true),
  ('1381600022', '1381600000', 'Pariancillo Villa', 'barangay', 'barangay', '2026-q3', true),
  ('1381600023', '1381600000', 'Paso de Blas', 'barangay', 'barangay', '2026-q3', true),
  ('1381600024', '1381600000', 'Pasolo', 'barangay', 'barangay', '2026-q3', true),
  ('1381600025', '1381600000', 'Poblacion', 'barangay', 'barangay', '2026-q3', true),
  ('1381600026', '1381600000', 'Pulo', 'barangay', 'barangay', '2026-q3', true),
  ('1381600027', '1381600000', 'Punturin', 'barangay', 'barangay', '2026-q3', true),
  ('1381600028', '1381600000', 'Rincon', 'barangay', 'barangay', '2026-q3', true),
  ('1381600029', '1381600000', 'Tagalag', 'barangay', 'barangay', '2026-q3', true),
  ('1381600030', '1381600000', 'Ugong', 'barangay', 'barangay', '2026-q3', true),
  ('1381600031', '1381600000', 'Veinte Reales', 'barangay', 'barangay', '2026-q3', true),
  ('1381600032', '1381600000', 'Wawang Pulo', 'barangay', 'barangay', '2026-q3', true),
  ('1381600033', '1381600000', 'Canumay East', 'barangay', 'barangay', '2026-q3', true);

-- Reinsert Postal Code mappings for Valenzuela
insert into public.postal_code_reference (
  postal_code, region_name, province_name, locality_name, psgc_locality_code, barangay_psgc_code,
  mapping_type, mapping_status, source_name, source_url, source_version, is_active
)
values
  ('1443', 'National Capital Region (NCR)', null, 'City of Valenzuela', '1381600000', '1381600008', 'exact_barangay', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1444', 'National Capital Region (NCR)', null, 'City of Valenzuela', '1381600000', '1381600017', 'exact_barangay', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1448', 'National Capital Region (NCR)', null, 'City of Valenzuela', '1381600000', '1381600016', 'exact_barangay', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true);

commit;
