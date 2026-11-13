-- ==============================================================================
-- Migration 97: Comprehensive PSA NCR PSGC Reconciliation & Workflow Alignment
-- ==============================================================================
-- 1. Full PSA Q3 2026 reconciliation of all 17 NCR LGUs (16 Cities + 1 Municipality)
--    and all 1,715 official barangays with correct 10-digit codes and parent relationships.
-- 2. Removes legacy requires_approval_before_pass bypass in api.create_specific_person_visit_request
--    ensuring specific person visits unconditionally require office approval.
-- 3. Makes api.decide_office_visit transactionally idempotent for repeat submissions.
-- ==============================================================================

begin;

-- ------------------------------------------------------------------------------
-- 1. Clean up obsolete NCR entries in postal_code_reference and psgc_locations
-- ------------------------------------------------------------------------------

delete from public.postal_code_reference
where psgc_locality_code like '13%' or barangay_psgc_code like '13%';

delete from public.psgc_locations
where level = 'barangay' and psgc_code like '13%';

delete from public.psgc_locations
where level in ('city', 'municipality', 'sub_municipality') and psgc_code like '13%';

-- Ensure Region 13 (NCR) exists
insert into public.psgc_locations (psgc_code, parent_psgc_code, name, level, location_type, reference_version_id, is_active)
values ('1300000000', null, 'National Capital Region (NCR)', 'region', 'region', '2026-q3', true)
on conflict (psgc_code) do update set
  name = excluded.name,
  level = excluded.level,
  reference_version_id = excluded.reference_version_id,
  is_active = excluded.is_active;

-- ------------------------------------------------------------------------------
-- 2. Insert all 17 NCR LGUs (16 Highly Urbanized Cities + 1 Municipality)
-- ------------------------------------------------------------------------------

insert into public.psgc_locations (psgc_code, parent_psgc_code, name, level, location_type, reference_version_id, is_active)
values
  ('1380100000', '1300000000', 'City of Caloocan', 'city', 'huc', '2026-q3', true),
  ('1380200000', '1300000000', 'City of Las Piñas', 'city', 'huc', '2026-q3', true),
  ('1380300000', '1300000000', 'City of Makati', 'city', 'huc', '2026-q3', true),
  ('1380400000', '1300000000', 'City of Malabon', 'city', 'huc', '2026-q3', true),
  ('1380500000', '1300000000', 'City of Mandaluyong', 'city', 'huc', '2026-q3', true),
  ('1380600000', '1300000000', 'City of Manila', 'city', 'huc', '2026-q3', true),
  ('1380700000', '1300000000', 'City of Marikina', 'city', 'huc', '2026-q3', true),
  ('1380800000', '1300000000', 'City of Muntinlupa', 'city', 'huc', '2026-q3', true),
  ('1380900000', '1300000000', 'City of Navotas', 'city', 'huc', '2026-q3', true),
  ('1381000000', '1300000000', 'City of Parañaque', 'city', 'huc', '2026-q3', true),
  ('1381100000', '1300000000', 'Pasay City', 'city', 'huc', '2026-q3', true),
  ('1381200000', '1300000000', 'City of Pasig', 'city', 'huc', '2026-q3', true),
  ('1381300000', '1300000000', 'Quezon City', 'city', 'huc', '2026-q3', true),
  ('1381400000', '1300000000', 'City of San Juan', 'city', 'huc', '2026-q3', true),
  ('1381500000', '1300000000', 'City of Taguig', 'city', 'huc', '2026-q3', true),
  ('1381600000', '1300000000', 'City of Valenzuela', 'city', 'huc', '2026-q3', true),
  ('1381700000', '1300000000', 'Municipality of Pateros', 'municipality', 'municipality', '2026-q3', true)
on conflict (psgc_code) do update set
  parent_psgc_code = excluded.parent_psgc_code,
  name = excluded.name,
  level = excluded.level,
  location_type = excluded.location_type,
  reference_version_id = excluded.reference_version_id,
  is_active = excluded.is_active;

-- ------------------------------------------------------------------------------
-- 3. Insert all 1,715 official PSA NCR barangays
-- ------------------------------------------------------------------------------

insert into public.psgc_locations (psgc_code, parent_psgc_code, name, level, location_type, reference_version_id, is_active)
values
  ('1380100001', '1380100000', 'Barangay 1', 'barangay', 'barangay', '2026-q3', true),
  ('1380100002', '1380100000', 'Barangay 2', 'barangay', 'barangay', '2026-q3', true),
  ('1380100003', '1380100000', 'Barangay 3', 'barangay', 'barangay', '2026-q3', true),
  ('1380100004', '1380100000', 'Barangay 4', 'barangay', 'barangay', '2026-q3', true),
  ('1380100005', '1380100000', 'Barangay 5', 'barangay', 'barangay', '2026-q3', true),
  ('1380100006', '1380100000', 'Barangay 6', 'barangay', 'barangay', '2026-q3', true),
  ('1380100007', '1380100000', 'Barangay 7', 'barangay', 'barangay', '2026-q3', true),
  ('1380100008', '1380100000', 'Barangay 8', 'barangay', 'barangay', '2026-q3', true),
  ('1380100009', '1380100000', 'Barangay 9', 'barangay', 'barangay', '2026-q3', true),
  ('1380100010', '1380100000', 'Barangay 10', 'barangay', 'barangay', '2026-q3', true),
  ('1380100011', '1380100000', 'Barangay 11', 'barangay', 'barangay', '2026-q3', true),
  ('1380100012', '1380100000', 'Barangay 12', 'barangay', 'barangay', '2026-q3', true),
  ('1380100013', '1380100000', 'Barangay 13', 'barangay', 'barangay', '2026-q3', true),
  ('1380100014', '1380100000', 'Barangay 14', 'barangay', 'barangay', '2026-q3', true),
  ('1380100015', '1380100000', 'Barangay 15', 'barangay', 'barangay', '2026-q3', true),
  ('1380100016', '1380100000', 'Barangay 16', 'barangay', 'barangay', '2026-q3', true),
  ('1380100017', '1380100000', 'Barangay 17', 'barangay', 'barangay', '2026-q3', true),
  ('1380100018', '1380100000', 'Barangay 18', 'barangay', 'barangay', '2026-q3', true),
  ('1380100019', '1380100000', 'Barangay 19', 'barangay', 'barangay', '2026-q3', true),
  ('1380100020', '1380100000', 'Barangay 20', 'barangay', 'barangay', '2026-q3', true),
  ('1380100021', '1380100000', 'Barangay 21', 'barangay', 'barangay', '2026-q3', true),
  ('1380100022', '1380100000', 'Barangay 22', 'barangay', 'barangay', '2026-q3', true),
  ('1380100023', '1380100000', 'Barangay 23', 'barangay', 'barangay', '2026-q3', true),
  ('1380100024', '1380100000', 'Barangay 24', 'barangay', 'barangay', '2026-q3', true),
  ('1380100025', '1380100000', 'Barangay 25', 'barangay', 'barangay', '2026-q3', true),
  ('1380100026', '1380100000', 'Barangay 26', 'barangay', 'barangay', '2026-q3', true),
  ('1380100027', '1380100000', 'Barangay 27', 'barangay', 'barangay', '2026-q3', true),
  ('1380100028', '1380100000', 'Barangay 28', 'barangay', 'barangay', '2026-q3', true),
  ('1380100029', '1380100000', 'Barangay 29', 'barangay', 'barangay', '2026-q3', true),
  ('1380100030', '1380100000', 'Barangay 30', 'barangay', 'barangay', '2026-q3', true),
  ('1380100031', '1380100000', 'Barangay 31', 'barangay', 'barangay', '2026-q3', true),
  ('1380100032', '1380100000', 'Barangay 32', 'barangay', 'barangay', '2026-q3', true),
  ('1380100033', '1380100000', 'Barangay 33', 'barangay', 'barangay', '2026-q3', true),
  ('1380100034', '1380100000', 'Barangay 34', 'barangay', 'barangay', '2026-q3', true),
  ('1380100035', '1380100000', 'Barangay 35', 'barangay', 'barangay', '2026-q3', true),
  ('1380100036', '1380100000', 'Barangay 36', 'barangay', 'barangay', '2026-q3', true),
  ('1380100037', '1380100000', 'Barangay 37', 'barangay', 'barangay', '2026-q3', true),
  ('1380100038', '1380100000', 'Barangay 38', 'barangay', 'barangay', '2026-q3', true),
  ('1380100039', '1380100000', 'Barangay 39', 'barangay', 'barangay', '2026-q3', true),
  ('1380100040', '1380100000', 'Barangay 40', 'barangay', 'barangay', '2026-q3', true),
  ('1380100041', '1380100000', 'Barangay 41', 'barangay', 'barangay', '2026-q3', true),
  ('1380100042', '1380100000', 'Barangay 42', 'barangay', 'barangay', '2026-q3', true),
  ('1380100043', '1380100000', 'Barangay 43', 'barangay', 'barangay', '2026-q3', true),
  ('1380100044', '1380100000', 'Barangay 44', 'barangay', 'barangay', '2026-q3', true),
  ('1380100045', '1380100000', 'Barangay 45', 'barangay', 'barangay', '2026-q3', true),
  ('1380100046', '1380100000', 'Barangay 46', 'barangay', 'barangay', '2026-q3', true),
  ('1380100047', '1380100000', 'Barangay 47', 'barangay', 'barangay', '2026-q3', true),
  ('1380100048', '1380100000', 'Barangay 48', 'barangay', 'barangay', '2026-q3', true),
  ('1380100049', '1380100000', 'Barangay 49', 'barangay', 'barangay', '2026-q3', true),
  ('1380100050', '1380100000', 'Barangay 50', 'barangay', 'barangay', '2026-q3', true),
  ('1380100051', '1380100000', 'Barangay 51', 'barangay', 'barangay', '2026-q3', true),
  ('1380100052', '1380100000', 'Barangay 52', 'barangay', 'barangay', '2026-q3', true),
  ('1380100053', '1380100000', 'Barangay 53', 'barangay', 'barangay', '2026-q3', true),
  ('1380100054', '1380100000', 'Barangay 54', 'barangay', 'barangay', '2026-q3', true),
  ('1380100055', '1380100000', 'Barangay 55', 'barangay', 'barangay', '2026-q3', true),
  ('1380100056', '1380100000', 'Barangay 56', 'barangay', 'barangay', '2026-q3', true),
  ('1380100057', '1380100000', 'Barangay 57', 'barangay', 'barangay', '2026-q3', true),
  ('1380100058', '1380100000', 'Barangay 58', 'barangay', 'barangay', '2026-q3', true),
  ('1380100059', '1380100000', 'Barangay 59', 'barangay', 'barangay', '2026-q3', true),
  ('1380100060', '1380100000', 'Barangay 60', 'barangay', 'barangay', '2026-q3', true),
  ('1380100061', '1380100000', 'Barangay 61', 'barangay', 'barangay', '2026-q3', true),
  ('1380100062', '1380100000', 'Barangay 62', 'barangay', 'barangay', '2026-q3', true),
  ('1380100063', '1380100000', 'Barangay 63', 'barangay', 'barangay', '2026-q3', true),
  ('1380100064', '1380100000', 'Barangay 64', 'barangay', 'barangay', '2026-q3', true),
  ('1380100065', '1380100000', 'Barangay 65', 'barangay', 'barangay', '2026-q3', true),
  ('1380100066', '1380100000', 'Barangay 66', 'barangay', 'barangay', '2026-q3', true),
  ('1380100067', '1380100000', 'Barangay 67', 'barangay', 'barangay', '2026-q3', true),
  ('1380100068', '1380100000', 'Barangay 68', 'barangay', 'barangay', '2026-q3', true),
  ('1380100069', '1380100000', 'Barangay 69', 'barangay', 'barangay', '2026-q3', true),
  ('1380100070', '1380100000', 'Barangay 70', 'barangay', 'barangay', '2026-q3', true),
  ('1380100071', '1380100000', 'Barangay 71', 'barangay', 'barangay', '2026-q3', true),
  ('1380100072', '1380100000', 'Barangay 72', 'barangay', 'barangay', '2026-q3', true),
  ('1380100073', '1380100000', 'Barangay 73', 'barangay', 'barangay', '2026-q3', true),
  ('1380100074', '1380100000', 'Barangay 74', 'barangay', 'barangay', '2026-q3', true),
  ('1380100075', '1380100000', 'Barangay 75', 'barangay', 'barangay', '2026-q3', true),
  ('1380100076', '1380100000', 'Barangay 76', 'barangay', 'barangay', '2026-q3', true),
  ('1380100077', '1380100000', 'Barangay 77', 'barangay', 'barangay', '2026-q3', true),
  ('1380100078', '1380100000', 'Barangay 78', 'barangay', 'barangay', '2026-q3', true),
  ('1380100079', '1380100000', 'Barangay 79', 'barangay', 'barangay', '2026-q3', true),
  ('1380100080', '1380100000', 'Barangay 80', 'barangay', 'barangay', '2026-q3', true),
  ('1380100081', '1380100000', 'Barangay 81', 'barangay', 'barangay', '2026-q3', true),
  ('1380100082', '1380100000', 'Barangay 82', 'barangay', 'barangay', '2026-q3', true),
  ('1380100083', '1380100000', 'Barangay 83', 'barangay', 'barangay', '2026-q3', true),
  ('1380100084', '1380100000', 'Barangay 84', 'barangay', 'barangay', '2026-q3', true),
  ('1380100085', '1380100000', 'Barangay 85', 'barangay', 'barangay', '2026-q3', true),
  ('1380100086', '1380100000', 'Barangay 86', 'barangay', 'barangay', '2026-q3', true),
  ('1380100087', '1380100000', 'Barangay 87', 'barangay', 'barangay', '2026-q3', true),
  ('1380100088', '1380100000', 'Barangay 88', 'barangay', 'barangay', '2026-q3', true),
  ('1380100089', '1380100000', 'Barangay 89', 'barangay', 'barangay', '2026-q3', true),
  ('1380100090', '1380100000', 'Barangay 90', 'barangay', 'barangay', '2026-q3', true),
  ('1380100091', '1380100000', 'Barangay 91', 'barangay', 'barangay', '2026-q3', true),
  ('1380100092', '1380100000', 'Barangay 92', 'barangay', 'barangay', '2026-q3', true),
  ('1380100093', '1380100000', 'Barangay 93', 'barangay', 'barangay', '2026-q3', true),
  ('1380100094', '1380100000', 'Barangay 94', 'barangay', 'barangay', '2026-q3', true),
  ('1380100095', '1380100000', 'Barangay 95', 'barangay', 'barangay', '2026-q3', true),
  ('1380100096', '1380100000', 'Barangay 96', 'barangay', 'barangay', '2026-q3', true),
  ('1380100097', '1380100000', 'Barangay 97', 'barangay', 'barangay', '2026-q3', true),
  ('1380100098', '1380100000', 'Barangay 98', 'barangay', 'barangay', '2026-q3', true),
  ('1380100099', '1380100000', 'Barangay 99', 'barangay', 'barangay', '2026-q3', true),
  ('1380100100', '1380100000', 'Barangay 100', 'barangay', 'barangay', '2026-q3', true),
  ('1380100101', '1380100000', 'Barangay 101', 'barangay', 'barangay', '2026-q3', true),
  ('1380100102', '1380100000', 'Barangay 102', 'barangay', 'barangay', '2026-q3', true),
  ('1380100103', '1380100000', 'Barangay 103', 'barangay', 'barangay', '2026-q3', true),
  ('1380100104', '1380100000', 'Barangay 104', 'barangay', 'barangay', '2026-q3', true),
  ('1380100105', '1380100000', 'Barangay 105', 'barangay', 'barangay', '2026-q3', true),
  ('1380100106', '1380100000', 'Barangay 106', 'barangay', 'barangay', '2026-q3', true),
  ('1380100107', '1380100000', 'Barangay 107', 'barangay', 'barangay', '2026-q3', true),
  ('1380100108', '1380100000', 'Barangay 108', 'barangay', 'barangay', '2026-q3', true),
  ('1380100109', '1380100000', 'Barangay 109', 'barangay', 'barangay', '2026-q3', true),
  ('1380100110', '1380100000', 'Barangay 110', 'barangay', 'barangay', '2026-q3', true),
  ('1380100111', '1380100000', 'Barangay 111', 'barangay', 'barangay', '2026-q3', true),
  ('1380100112', '1380100000', 'Barangay 112', 'barangay', 'barangay', '2026-q3', true),
  ('1380100113', '1380100000', 'Barangay 113', 'barangay', 'barangay', '2026-q3', true),
  ('1380100114', '1380100000', 'Barangay 114', 'barangay', 'barangay', '2026-q3', true),
  ('1380100115', '1380100000', 'Barangay 115', 'barangay', 'barangay', '2026-q3', true),
  ('1380100116', '1380100000', 'Barangay 116', 'barangay', 'barangay', '2026-q3', true),
  ('1380100117', '1380100000', 'Barangay 117', 'barangay', 'barangay', '2026-q3', true),
  ('1380100118', '1380100000', 'Barangay 118', 'barangay', 'barangay', '2026-q3', true),
  ('1380100119', '1380100000', 'Barangay 119', 'barangay', 'barangay', '2026-q3', true),
  ('1380100120', '1380100000', 'Barangay 120', 'barangay', 'barangay', '2026-q3', true),
  ('1380100121', '1380100000', 'Barangay 121', 'barangay', 'barangay', '2026-q3', true),
  ('1380100122', '1380100000', 'Barangay 122', 'barangay', 'barangay', '2026-q3', true),
  ('1380100123', '1380100000', 'Barangay 123', 'barangay', 'barangay', '2026-q3', true),
  ('1380100124', '1380100000', 'Barangay 124', 'barangay', 'barangay', '2026-q3', true),
  ('1380100125', '1380100000', 'Barangay 125', 'barangay', 'barangay', '2026-q3', true),
  ('1380100126', '1380100000', 'Barangay 126', 'barangay', 'barangay', '2026-q3', true),
  ('1380100127', '1380100000', 'Barangay 127', 'barangay', 'barangay', '2026-q3', true),
  ('1380100128', '1380100000', 'Barangay 128', 'barangay', 'barangay', '2026-q3', true),
  ('1380100129', '1380100000', 'Barangay 129', 'barangay', 'barangay', '2026-q3', true),
  ('1380100130', '1380100000', 'Barangay 130', 'barangay', 'barangay', '2026-q3', true),
  ('1380100131', '1380100000', 'Barangay 131', 'barangay', 'barangay', '2026-q3', true),
  ('1380100132', '1380100000', 'Barangay 132', 'barangay', 'barangay', '2026-q3', true),
  ('1380100133', '1380100000', 'Barangay 133', 'barangay', 'barangay', '2026-q3', true),
  ('1380100134', '1380100000', 'Barangay 134', 'barangay', 'barangay', '2026-q3', true),
  ('1380100135', '1380100000', 'Barangay 135', 'barangay', 'barangay', '2026-q3', true),
  ('1380100136', '1380100000', 'Barangay 136', 'barangay', 'barangay', '2026-q3', true),
  ('1380100137', '1380100000', 'Barangay 137', 'barangay', 'barangay', '2026-q3', true),
  ('1380100138', '1380100000', 'Barangay 138', 'barangay', 'barangay', '2026-q3', true),
  ('1380100139', '1380100000', 'Barangay 139', 'barangay', 'barangay', '2026-q3', true),
  ('1380100140', '1380100000', 'Barangay 140', 'barangay', 'barangay', '2026-q3', true),
  ('1380100141', '1380100000', 'Barangay 141', 'barangay', 'barangay', '2026-q3', true),
  ('1380100142', '1380100000', 'Barangay 142', 'barangay', 'barangay', '2026-q3', true),
  ('1380100143', '1380100000', 'Barangay 143', 'barangay', 'barangay', '2026-q3', true),
  ('1380100144', '1380100000', 'Barangay 144', 'barangay', 'barangay', '2026-q3', true),
  ('1380100145', '1380100000', 'Barangay 145', 'barangay', 'barangay', '2026-q3', true),
  ('1380100146', '1380100000', 'Barangay 146', 'barangay', 'barangay', '2026-q3', true),
  ('1380100147', '1380100000', 'Barangay 147', 'barangay', 'barangay', '2026-q3', true),
  ('1380100148', '1380100000', 'Barangay 148', 'barangay', 'barangay', '2026-q3', true),
  ('1380100149', '1380100000', 'Barangay 149', 'barangay', 'barangay', '2026-q3', true),
  ('1380100150', '1380100000', 'Barangay 150', 'barangay', 'barangay', '2026-q3', true),
  ('1380100151', '1380100000', 'Barangay 151', 'barangay', 'barangay', '2026-q3', true),
  ('1380100152', '1380100000', 'Barangay 152', 'barangay', 'barangay', '2026-q3', true),
  ('1380100153', '1380100000', 'Barangay 153', 'barangay', 'barangay', '2026-q3', true),
  ('1380100154', '1380100000', 'Barangay 154', 'barangay', 'barangay', '2026-q3', true),
  ('1380100155', '1380100000', 'Barangay 155', 'barangay', 'barangay', '2026-q3', true),
  ('1380100156', '1380100000', 'Barangay 156', 'barangay', 'barangay', '2026-q3', true),
  ('1380100157', '1380100000', 'Barangay 157', 'barangay', 'barangay', '2026-q3', true),
  ('1380100158', '1380100000', 'Barangay 158', 'barangay', 'barangay', '2026-q3', true),
  ('1380100159', '1380100000', 'Barangay 159', 'barangay', 'barangay', '2026-q3', true),
  ('1380100160', '1380100000', 'Barangay 160', 'barangay', 'barangay', '2026-q3', true),
  ('1380100161', '1380100000', 'Barangay 161', 'barangay', 'barangay', '2026-q3', true),
  ('1380100162', '1380100000', 'Barangay 162', 'barangay', 'barangay', '2026-q3', true),
  ('1380100163', '1380100000', 'Barangay 163', 'barangay', 'barangay', '2026-q3', true),
  ('1380100164', '1380100000', 'Barangay 164', 'barangay', 'barangay', '2026-q3', true),
  ('1380100165', '1380100000', 'Barangay 165', 'barangay', 'barangay', '2026-q3', true),
  ('1380100166', '1380100000', 'Barangay 166', 'barangay', 'barangay', '2026-q3', true),
  ('1380100167', '1380100000', 'Barangay 167', 'barangay', 'barangay', '2026-q3', true),
  ('1380100168', '1380100000', 'Barangay 168', 'barangay', 'barangay', '2026-q3', true),
  ('1380100169', '1380100000', 'Barangay 169', 'barangay', 'barangay', '2026-q3', true),
  ('1380100170', '1380100000', 'Barangay 170', 'barangay', 'barangay', '2026-q3', true),
  ('1380100171', '1380100000', 'Barangay 171', 'barangay', 'barangay', '2026-q3', true),
  ('1380100172', '1380100000', 'Barangay 172', 'barangay', 'barangay', '2026-q3', true),
  ('1380100173', '1380100000', 'Barangay 173', 'barangay', 'barangay', '2026-q3', true),
  ('1380100174', '1380100000', 'Barangay 174', 'barangay', 'barangay', '2026-q3', true),
  ('1380100175', '1380100000', 'Barangay 175', 'barangay', 'barangay', '2026-q3', true),
  ('1380100177', '1380100000', 'Barangay 177', 'barangay', 'barangay', '2026-q3', true),
  ('1380100178', '1380100000', 'Barangay 178', 'barangay', 'barangay', '2026-q3', true),
  ('1380100179', '1380100000', 'Barangay 179', 'barangay', 'barangay', '2026-q3', true),
  ('1380100180', '1380100000', 'Barangay 180', 'barangay', 'barangay', '2026-q3', true),
  ('1380100181', '1380100000', 'Barangay 181', 'barangay', 'barangay', '2026-q3', true),
  ('1380100182', '1380100000', 'Barangay 182', 'barangay', 'barangay', '2026-q3', true),
  ('1380100183', '1380100000', 'Barangay 183', 'barangay', 'barangay', '2026-q3', true),
  ('1380100184', '1380100000', 'Barangay 184', 'barangay', 'barangay', '2026-q3', true),
  ('1380100185', '1380100000', 'Barangay 185', 'barangay', 'barangay', '2026-q3', true),
  ('1380100186', '1380100000', 'Barangay 186', 'barangay', 'barangay', '2026-q3', true),
  ('1380100187', '1380100000', 'Barangay 187', 'barangay', 'barangay', '2026-q3', true),
  ('1380100188', '1380100000', 'Barangay 188', 'barangay', 'barangay', '2026-q3', true),
  ('1380100189', '1380100000', 'Barangay 176-A', 'barangay', 'barangay', '2026-q3', true),
  ('1380100190', '1380100000', 'Barangay 176-B', 'barangay', 'barangay', '2026-q3', true),
  ('1380100191', '1380100000', 'Barangay 176-C', 'barangay', 'barangay', '2026-q3', true),
  ('1380100192', '1380100000', 'Barangay 176-D', 'barangay', 'barangay', '2026-q3', true),
  ('1380100193', '1380100000', 'Barangay 176-E', 'barangay', 'barangay', '2026-q3', true),
  ('1380100194', '1380100000', 'Barangay 176-F', 'barangay', 'barangay', '2026-q3', true),
  ('1380200001', '1380200000', 'Almanza Uno', 'barangay', 'barangay', '2026-q3', true),
  ('1380200002', '1380200000', 'Daniel Fajardo', 'barangay', 'barangay', '2026-q3', true),
  ('1380200003', '1380200000', 'Elias Aldana', 'barangay', 'barangay', '2026-q3', true),
  ('1380200004', '1380200000', 'Ilaya', 'barangay', 'barangay', '2026-q3', true),
  ('1380200005', '1380200000', 'Manuyo Uno', 'barangay', 'barangay', '2026-q3', true),
  ('1380200006', '1380200000', 'Pamplona Uno', 'barangay', 'barangay', '2026-q3', true),
  ('1380200007', '1380200000', 'Pulang Lupa Uno', 'barangay', 'barangay', '2026-q3', true)
on conflict (psgc_code) do update set
  parent_psgc_code = excluded.parent_psgc_code,
  name = excluded.name,
  level = excluded.level,
  location_type = excluded.location_type,
  reference_version_id = excluded.reference_version_id,
  is_active = excluded.is_active;

insert into public.psgc_locations (psgc_code, parent_psgc_code, name, level, location_type, reference_version_id, is_active)
values
  ('1380200008', '1380200000', 'Talon Uno', 'barangay', 'barangay', '2026-q3', true),
  ('1380200009', '1380200000', 'Zapote', 'barangay', 'barangay', '2026-q3', true),
  ('1380200010', '1380200000', 'Almanza Dos', 'barangay', 'barangay', '2026-q3', true),
  ('1380200011', '1380200000', 'B. F. International Village', 'barangay', 'barangay', '2026-q3', true),
  ('1380200012', '1380200000', 'Manuyo Dos', 'barangay', 'barangay', '2026-q3', true),
  ('1380200013', '1380200000', 'Pamplona Dos', 'barangay', 'barangay', '2026-q3', true),
  ('1380200014', '1380200000', 'Pamplona Tres', 'barangay', 'barangay', '2026-q3', true),
  ('1380200015', '1380200000', 'Pilar', 'barangay', 'barangay', '2026-q3', true),
  ('1380200016', '1380200000', 'Pulang Lupa Dos', 'barangay', 'barangay', '2026-q3', true),
  ('1380200017', '1380200000', 'Talon Dos', 'barangay', 'barangay', '2026-q3', true),
  ('1380200018', '1380200000', 'Talon Tres', 'barangay', 'barangay', '2026-q3', true),
  ('1380200019', '1380200000', 'Talon Kuatro', 'barangay', 'barangay', '2026-q3', true),
  ('1380200020', '1380200000', 'Talon Singko', 'barangay', 'barangay', '2026-q3', true),
  ('1380300001', '1380300000', 'Bangkal', 'barangay', 'barangay', '2026-q3', true),
  ('1380300002', '1380300000', 'Bel-Air', 'barangay', 'barangay', '2026-q3', true),
  ('1380300005', '1380300000', 'Carmona', 'barangay', 'barangay', '2026-q3', true),
  ('1380300006', '1380300000', 'Dasmariñas', 'barangay', 'barangay', '2026-q3', true),
  ('1380300008', '1380300000', 'Forbes Park', 'barangay', 'barangay', '2026-q3', true),
  ('1380300009', '1380300000', 'Guadalupe Nuevo', 'barangay', 'barangay', '2026-q3', true),
  ('1380300010', '1380300000', 'Guadalupe Viejo', 'barangay', 'barangay', '2026-q3', true),
  ('1380300011', '1380300000', 'Kasilawan', 'barangay', 'barangay', '2026-q3', true),
  ('1380300012', '1380300000', 'La Paz', 'barangay', 'barangay', '2026-q3', true),
  ('1380300013', '1380300000', 'Magallanes', 'barangay', 'barangay', '2026-q3', true),
  ('1380300014', '1380300000', 'Olympia', 'barangay', 'barangay', '2026-q3', true),
  ('1380300015', '1380300000', 'Palanan', 'barangay', 'barangay', '2026-q3', true),
  ('1380300017', '1380300000', 'Pinagkaisahan', 'barangay', 'barangay', '2026-q3', true),
  ('1380300018', '1380300000', 'Pio Del Pilar', 'barangay', 'barangay', '2026-q3', true),
  ('1380300020', '1380300000', 'Poblacion', 'barangay', 'barangay', '2026-q3', true),
  ('1380300023', '1380300000', 'San Antonio', 'barangay', 'barangay', '2026-q3', true),
  ('1380300024', '1380300000', 'San Isidro', 'barangay', 'barangay', '2026-q3', true),
  ('1380300025', '1380300000', 'San Lorenzo', 'barangay', 'barangay', '2026-q3', true),
  ('1380300026', '1380300000', 'Santa Cruz', 'barangay', 'barangay', '2026-q3', true),
  ('1380300027', '1380300000', 'Singkamas', 'barangay', 'barangay', '2026-q3', true),
  ('1380300029', '1380300000', 'Tejeros', 'barangay', 'barangay', '2026-q3', true),
  ('1380300030', '1380300000', 'Urdaneta', 'barangay', 'barangay', '2026-q3', true),
  ('1380300031', '1380300000', 'Valenzuela', 'barangay', 'barangay', '2026-q3', true),
  ('1380400001', '1380400000', 'Acacia', 'barangay', 'barangay', '2026-q3', true),
  ('1380400002', '1380400000', 'Baritan', 'barangay', 'barangay', '2026-q3', true),
  ('1380400003', '1380400000', 'Bayan-bayanan', 'barangay', 'barangay', '2026-q3', true),
  ('1380400004', '1380400000', 'Catmon', 'barangay', 'barangay', '2026-q3', true),
  ('1380400005', '1380400000', 'Concepcion', 'barangay', 'barangay', '2026-q3', true),
  ('1380400006', '1380400000', 'Dampalit', 'barangay', 'barangay', '2026-q3', true),
  ('1380400007', '1380400000', 'Flores', 'barangay', 'barangay', '2026-q3', true),
  ('1380400008', '1380400000', 'Hulong Duhat', 'barangay', 'barangay', '2026-q3', true),
  ('1380400009', '1380400000', 'Ibaba', 'barangay', 'barangay', '2026-q3', true),
  ('1380400010', '1380400000', 'Longos', 'barangay', 'barangay', '2026-q3', true),
  ('1380400011', '1380400000', 'Maysilo', 'barangay', 'barangay', '2026-q3', true),
  ('1380400012', '1380400000', 'Muzon', 'barangay', 'barangay', '2026-q3', true),
  ('1380400013', '1380400000', 'Niugan', 'barangay', 'barangay', '2026-q3', true),
  ('1380400014', '1380400000', 'Panghulo', 'barangay', 'barangay', '2026-q3', true),
  ('1380400015', '1380400000', 'Potrero', 'barangay', 'barangay', '2026-q3', true),
  ('1380400016', '1380400000', 'San Agustin', 'barangay', 'barangay', '2026-q3', true),
  ('1380400017', '1380400000', 'Santolan', 'barangay', 'barangay', '2026-q3', true),
  ('1380400018', '1380400000', 'Tañong', 'barangay', 'barangay', '2026-q3', true),
  ('1380400019', '1380400000', 'Tinajeros', 'barangay', 'barangay', '2026-q3', true),
  ('1380400020', '1380400000', 'Tonsuya', 'barangay', 'barangay', '2026-q3', true),
  ('1380400021', '1380400000', 'Tugatog', 'barangay', 'barangay', '2026-q3', true),
  ('1380500001', '1380500000', 'Addition Hills', 'barangay', 'barangay', '2026-q3', true),
  ('1380500002', '1380500000', 'Bagong Silang', 'barangay', 'barangay', '2026-q3', true),
  ('1380500003', '1380500000', 'Barangka Drive', 'barangay', 'barangay', '2026-q3', true),
  ('1380500004', '1380500000', 'Barangka Ibaba', 'barangay', 'barangay', '2026-q3', true),
  ('1380500005', '1380500000', 'Barangka Ilaya', 'barangay', 'barangay', '2026-q3', true),
  ('1380500006', '1380500000', 'Barangka Itaas', 'barangay', 'barangay', '2026-q3', true),
  ('1380500007', '1380500000', 'Burol', 'barangay', 'barangay', '2026-q3', true),
  ('1380500008', '1380500000', 'Buayang Bato', 'barangay', 'barangay', '2026-q3', true),
  ('1380500009', '1380500000', 'Daang Bakal', 'barangay', 'barangay', '2026-q3', true),
  ('1380500010', '1380500000', 'Hagdang Bato Itaas', 'barangay', 'barangay', '2026-q3', true),
  ('1380500011', '1380500000', 'Hagdang Bato Libis', 'barangay', 'barangay', '2026-q3', true),
  ('1380500012', '1380500000', 'Harapin Ang Bukas', 'barangay', 'barangay', '2026-q3', true),
  ('1380500013', '1380500000', 'Highway Hills', 'barangay', 'barangay', '2026-q3', true),
  ('1380500014', '1380500000', 'Hulo', 'barangay', 'barangay', '2026-q3', true),
  ('1380500015', '1380500000', 'Mabini-J. Rizal', 'barangay', 'barangay', '2026-q3', true),
  ('1380500016', '1380500000', 'Malamig', 'barangay', 'barangay', '2026-q3', true),
  ('1380500017', '1380500000', 'Mauway', 'barangay', 'barangay', '2026-q3', true),
  ('1380500018', '1380500000', 'Namayan', 'barangay', 'barangay', '2026-q3', true),
  ('1380500019', '1380500000', 'New Zañiga', 'barangay', 'barangay', '2026-q3', true),
  ('1380500020', '1380500000', 'Old Zañiga', 'barangay', 'barangay', '2026-q3', true),
  ('1380500021', '1380500000', 'Pag-asa', 'barangay', 'barangay', '2026-q3', true),
  ('1380500022', '1380500000', 'Plainview', 'barangay', 'barangay', '2026-q3', true),
  ('1380500023', '1380500000', 'Pleasant Hills', 'barangay', 'barangay', '2026-q3', true),
  ('1380500024', '1380500000', 'Poblacion', 'barangay', 'barangay', '2026-q3', true),
  ('1380500025', '1380500000', 'San Jose', 'barangay', 'barangay', '2026-q3', true),
  ('1380500026', '1380500000', 'Vergara', 'barangay', 'barangay', '2026-q3', true),
  ('1380500027', '1380500000', 'Wack-wack Greenhills', 'barangay', 'barangay', '2026-q3', true),
  ('1380601001', '1380600000', 'Barangay 1', 'barangay', 'barangay', '2026-q3', true),
  ('1380601002', '1380600000', 'Barangay 2', 'barangay', 'barangay', '2026-q3', true),
  ('1380601003', '1380600000', 'Barangay 3', 'barangay', 'barangay', '2026-q3', true),
  ('1380601004', '1380600000', 'Barangay 4', 'barangay', 'barangay', '2026-q3', true),
  ('1380601005', '1380600000', 'Barangay 5', 'barangay', 'barangay', '2026-q3', true),
  ('1380601006', '1380600000', 'Barangay 6', 'barangay', 'barangay', '2026-q3', true),
  ('1380601007', '1380600000', 'Barangay 7', 'barangay', 'barangay', '2026-q3', true),
  ('1380601008', '1380600000', 'Barangay 8', 'barangay', 'barangay', '2026-q3', true),
  ('1380601009', '1380600000', 'Barangay 9', 'barangay', 'barangay', '2026-q3', true),
  ('1380601010', '1380600000', 'Barangay 10', 'barangay', 'barangay', '2026-q3', true),
  ('1380601011', '1380600000', 'Barangay 11', 'barangay', 'barangay', '2026-q3', true),
  ('1380601012', '1380600000', 'Barangay 12', 'barangay', 'barangay', '2026-q3', true),
  ('1380601013', '1380600000', 'Barangay 13', 'barangay', 'barangay', '2026-q3', true),
  ('1380601014', '1380600000', 'Barangay 14', 'barangay', 'barangay', '2026-q3', true),
  ('1380601015', '1380600000', 'Barangay 15', 'barangay', 'barangay', '2026-q3', true),
  ('1380601016', '1380600000', 'Barangay 16', 'barangay', 'barangay', '2026-q3', true),
  ('1380601017', '1380600000', 'Barangay 17', 'barangay', 'barangay', '2026-q3', true),
  ('1380601018', '1380600000', 'Barangay 18', 'barangay', 'barangay', '2026-q3', true),
  ('1380601019', '1380600000', 'Barangay 19', 'barangay', 'barangay', '2026-q3', true),
  ('1380601020', '1380600000', 'Barangay 20', 'barangay', 'barangay', '2026-q3', true),
  ('1380601025', '1380600000', 'Barangay 25', 'barangay', 'barangay', '2026-q3', true),
  ('1380601026', '1380600000', 'Barangay 26', 'barangay', 'barangay', '2026-q3', true),
  ('1380601028', '1380600000', 'Barangay 28', 'barangay', 'barangay', '2026-q3', true),
  ('1380601029', '1380600000', 'Barangay 29', 'barangay', 'barangay', '2026-q3', true),
  ('1380601030', '1380600000', 'Barangay 30', 'barangay', 'barangay', '2026-q3', true),
  ('1380601031', '1380600000', 'Barangay 31', 'barangay', 'barangay', '2026-q3', true),
  ('1380601032', '1380600000', 'Barangay 32', 'barangay', 'barangay', '2026-q3', true),
  ('1380601033', '1380600000', 'Barangay 33', 'barangay', 'barangay', '2026-q3', true),
  ('1380601034', '1380600000', 'Barangay 34', 'barangay', 'barangay', '2026-q3', true),
  ('1380601035', '1380600000', 'Barangay 35', 'barangay', 'barangay', '2026-q3', true),
  ('1380601036', '1380600000', 'Barangay 36', 'barangay', 'barangay', '2026-q3', true),
  ('1380601037', '1380600000', 'Barangay 37', 'barangay', 'barangay', '2026-q3', true),
  ('1380601038', '1380600000', 'Barangay 38', 'barangay', 'barangay', '2026-q3', true),
  ('1380601039', '1380600000', 'Barangay 39', 'barangay', 'barangay', '2026-q3', true),
  ('1380601041', '1380600000', 'Barangay 41', 'barangay', 'barangay', '2026-q3', true),
  ('1380601042', '1380600000', 'Barangay 42', 'barangay', 'barangay', '2026-q3', true),
  ('1380601043', '1380600000', 'Barangay 43', 'barangay', 'barangay', '2026-q3', true),
  ('1380601044', '1380600000', 'Barangay 44', 'barangay', 'barangay', '2026-q3', true),
  ('1380601045', '1380600000', 'Barangay 45', 'barangay', 'barangay', '2026-q3', true),
  ('1380601046', '1380600000', 'Barangay 46', 'barangay', 'barangay', '2026-q3', true),
  ('1380601047', '1380600000', 'Barangay 47', 'barangay', 'barangay', '2026-q3', true),
  ('1380601048', '1380600000', 'Barangay 48', 'barangay', 'barangay', '2026-q3', true),
  ('1380601049', '1380600000', 'Barangay 49', 'barangay', 'barangay', '2026-q3', true),
  ('1380601050', '1380600000', 'Barangay 50', 'barangay', 'barangay', '2026-q3', true),
  ('1380601051', '1380600000', 'Barangay 51', 'barangay', 'barangay', '2026-q3', true),
  ('1380601052', '1380600000', 'Barangay 52', 'barangay', 'barangay', '2026-q3', true),
  ('1380601053', '1380600000', 'Barangay 53', 'barangay', 'barangay', '2026-q3', true),
  ('1380601054', '1380600000', 'Barangay 54', 'barangay', 'barangay', '2026-q3', true),
  ('1380601055', '1380600000', 'Barangay 55', 'barangay', 'barangay', '2026-q3', true),
  ('1380601056', '1380600000', 'Barangay 56', 'barangay', 'barangay', '2026-q3', true),
  ('1380601057', '1380600000', 'Barangay 57', 'barangay', 'barangay', '2026-q3', true),
  ('1380601058', '1380600000', 'Barangay 58', 'barangay', 'barangay', '2026-q3', true),
  ('1380601059', '1380600000', 'Barangay 59', 'barangay', 'barangay', '2026-q3', true),
  ('1380601060', '1380600000', 'Barangay 60', 'barangay', 'barangay', '2026-q3', true),
  ('1380601061', '1380600000', 'Barangay 61', 'barangay', 'barangay', '2026-q3', true),
  ('1380601062', '1380600000', 'Barangay 62', 'barangay', 'barangay', '2026-q3', true),
  ('1380601063', '1380600000', 'Barangay 63', 'barangay', 'barangay', '2026-q3', true),
  ('1380601064', '1380600000', 'Barangay 64', 'barangay', 'barangay', '2026-q3', true),
  ('1380601065', '1380600000', 'Barangay 65', 'barangay', 'barangay', '2026-q3', true),
  ('1380601066', '1380600000', 'Barangay 66', 'barangay', 'barangay', '2026-q3', true),
  ('1380601067', '1380600000', 'Barangay 67', 'barangay', 'barangay', '2026-q3', true),
  ('1380601068', '1380600000', 'Barangay 68', 'barangay', 'barangay', '2026-q3', true),
  ('1380601069', '1380600000', 'Barangay 69', 'barangay', 'barangay', '2026-q3', true),
  ('1380601070', '1380600000', 'Barangay 70', 'barangay', 'barangay', '2026-q3', true),
  ('1380601071', '1380600000', 'Barangay 71', 'barangay', 'barangay', '2026-q3', true),
  ('1380601072', '1380600000', 'Barangay 72', 'barangay', 'barangay', '2026-q3', true),
  ('1380601073', '1380600000', 'Barangay 73', 'barangay', 'barangay', '2026-q3', true),
  ('1380601074', '1380600000', 'Barangay 74', 'barangay', 'barangay', '2026-q3', true),
  ('1380601075', '1380600000', 'Barangay 75', 'barangay', 'barangay', '2026-q3', true),
  ('1380601076', '1380600000', 'Barangay 76', 'barangay', 'barangay', '2026-q3', true),
  ('1380601077', '1380600000', 'Barangay 77', 'barangay', 'barangay', '2026-q3', true),
  ('1380601078', '1380600000', 'Barangay 78', 'barangay', 'barangay', '2026-q3', true),
  ('1380601079', '1380600000', 'Barangay 79', 'barangay', 'barangay', '2026-q3', true),
  ('1380601080', '1380600000', 'Barangay 80', 'barangay', 'barangay', '2026-q3', true),
  ('1380601081', '1380600000', 'Barangay 81', 'barangay', 'barangay', '2026-q3', true),
  ('1380601082', '1380600000', 'Barangay 82', 'barangay', 'barangay', '2026-q3', true),
  ('1380601083', '1380600000', 'Barangay 83', 'barangay', 'barangay', '2026-q3', true),
  ('1380601084', '1380600000', 'Barangay 84', 'barangay', 'barangay', '2026-q3', true),
  ('1380601085', '1380600000', 'Barangay 85', 'barangay', 'barangay', '2026-q3', true),
  ('1380601086', '1380600000', 'Barangay 86', 'barangay', 'barangay', '2026-q3', true),
  ('1380601087', '1380600000', 'Barangay 87', 'barangay', 'barangay', '2026-q3', true),
  ('1380601088', '1380600000', 'Barangay 88', 'barangay', 'barangay', '2026-q3', true),
  ('1380601089', '1380600000', 'Barangay 89', 'barangay', 'barangay', '2026-q3', true),
  ('1380601090', '1380600000', 'Barangay 90', 'barangay', 'barangay', '2026-q3', true),
  ('1380601091', '1380600000', 'Barangay 91', 'barangay', 'barangay', '2026-q3', true),
  ('1380601092', '1380600000', 'Barangay 92', 'barangay', 'barangay', '2026-q3', true),
  ('1380601093', '1380600000', 'Barangay 93', 'barangay', 'barangay', '2026-q3', true),
  ('1380601094', '1380600000', 'Barangay 94', 'barangay', 'barangay', '2026-q3', true),
  ('1380601095', '1380600000', 'Barangay 95', 'barangay', 'barangay', '2026-q3', true),
  ('1380601096', '1380600000', 'Barangay 96', 'barangay', 'barangay', '2026-q3', true),
  ('1380601097', '1380600000', 'Barangay 97', 'barangay', 'barangay', '2026-q3', true),
  ('1380601098', '1380600000', 'Barangay 98', 'barangay', 'barangay', '2026-q3', true),
  ('1380601099', '1380600000', 'Barangay 99', 'barangay', 'barangay', '2026-q3', true),
  ('1380601100', '1380600000', 'Barangay 100', 'barangay', 'barangay', '2026-q3', true),
  ('1380601101', '1380600000', 'Barangay 101', 'barangay', 'barangay', '2026-q3', true),
  ('1380601102', '1380600000', 'Barangay 102', 'barangay', 'barangay', '2026-q3', true),
  ('1380601103', '1380600000', 'Barangay 103', 'barangay', 'barangay', '2026-q3', true),
  ('1380601104', '1380600000', 'Barangay 104', 'barangay', 'barangay', '2026-q3', true),
  ('1380601105', '1380600000', 'Barangay 105', 'barangay', 'barangay', '2026-q3', true),
  ('1380601106', '1380600000', 'Barangay 106', 'barangay', 'barangay', '2026-q3', true),
  ('1380601107', '1380600000', 'Barangay 107', 'barangay', 'barangay', '2026-q3', true),
  ('1380601108', '1380600000', 'Barangay 108', 'barangay', 'barangay', '2026-q3', true),
  ('1380601109', '1380600000', 'Barangay 109', 'barangay', 'barangay', '2026-q3', true),
  ('1380601110', '1380600000', 'Barangay 110', 'barangay', 'barangay', '2026-q3', true),
  ('1380601111', '1380600000', 'Barangay 111', 'barangay', 'barangay', '2026-q3', true),
  ('1380601112', '1380600000', 'Barangay 112', 'barangay', 'barangay', '2026-q3', true),
  ('1380601116', '1380600000', 'Barangay 116', 'barangay', 'barangay', '2026-q3', true),
  ('1380601117', '1380600000', 'Barangay 117', 'barangay', 'barangay', '2026-q3', true),
  ('1380601118', '1380600000', 'Barangay 118', 'barangay', 'barangay', '2026-q3', true),
  ('1380601119', '1380600000', 'Barangay 119', 'barangay', 'barangay', '2026-q3', true),
  ('1380601120', '1380600000', 'Barangay 120', 'barangay', 'barangay', '2026-q3', true),
  ('1380601121', '1380600000', 'Barangay 121', 'barangay', 'barangay', '2026-q3', true),
  ('1380601122', '1380600000', 'Barangay 122', 'barangay', 'barangay', '2026-q3', true),
  ('1380601123', '1380600000', 'Barangay 123', 'barangay', 'barangay', '2026-q3', true),
  ('1380601124', '1380600000', 'Barangay 124', 'barangay', 'barangay', '2026-q3', true),
  ('1380601125', '1380600000', 'Barangay 125', 'barangay', 'barangay', '2026-q3', true)
on conflict (psgc_code) do update set
  parent_psgc_code = excluded.parent_psgc_code,
  name = excluded.name,
  level = excluded.level,
  location_type = excluded.location_type,
  reference_version_id = excluded.reference_version_id,
  is_active = excluded.is_active;

insert into public.psgc_locations (psgc_code, parent_psgc_code, name, level, location_type, reference_version_id, is_active)
values
  ('1380601126', '1380600000', 'Barangay 126', 'barangay', 'barangay', '2026-q3', true),
  ('1380601127', '1380600000', 'Barangay 127', 'barangay', 'barangay', '2026-q3', true),
  ('1380601128', '1380600000', 'Barangay 128', 'barangay', 'barangay', '2026-q3', true),
  ('1380601129', '1380600000', 'Barangay 129', 'barangay', 'barangay', '2026-q3', true),
  ('1380601130', '1380600000', 'Barangay 130', 'barangay', 'barangay', '2026-q3', true),
  ('1380601131', '1380600000', 'Barangay 131', 'barangay', 'barangay', '2026-q3', true),
  ('1380601132', '1380600000', 'Barangay 132', 'barangay', 'barangay', '2026-q3', true),
  ('1380601133', '1380600000', 'Barangay 133', 'barangay', 'barangay', '2026-q3', true),
  ('1380601134', '1380600000', 'Barangay 134', 'barangay', 'barangay', '2026-q3', true),
  ('1380601135', '1380600000', 'Barangay 135', 'barangay', 'barangay', '2026-q3', true),
  ('1380601136', '1380600000', 'Barangay 136', 'barangay', 'barangay', '2026-q3', true),
  ('1380601137', '1380600000', 'Barangay 137', 'barangay', 'barangay', '2026-q3', true),
  ('1380601138', '1380600000', 'Barangay 138', 'barangay', 'barangay', '2026-q3', true),
  ('1380601139', '1380600000', 'Barangay 139', 'barangay', 'barangay', '2026-q3', true),
  ('1380601140', '1380600000', 'Barangay 140', 'barangay', 'barangay', '2026-q3', true),
  ('1380601141', '1380600000', 'Barangay 141', 'barangay', 'barangay', '2026-q3', true),
  ('1380601142', '1380600000', 'Barangay 142', 'barangay', 'barangay', '2026-q3', true),
  ('1380601143', '1380600000', 'Barangay 143', 'barangay', 'barangay', '2026-q3', true),
  ('1380601144', '1380600000', 'Barangay 144', 'barangay', 'barangay', '2026-q3', true),
  ('1380601145', '1380600000', 'Barangay 145', 'barangay', 'barangay', '2026-q3', true),
  ('1380601146', '1380600000', 'Barangay 146', 'barangay', 'barangay', '2026-q3', true),
  ('1380601147', '1380600000', 'Barangay 147', 'barangay', 'barangay', '2026-q3', true),
  ('1380601148', '1380600000', 'Barangay 148', 'barangay', 'barangay', '2026-q3', true),
  ('1380601149', '1380600000', 'Barangay 149', 'barangay', 'barangay', '2026-q3', true),
  ('1380601150', '1380600000', 'Barangay 150', 'barangay', 'barangay', '2026-q3', true),
  ('1380601151', '1380600000', 'Barangay 151', 'barangay', 'barangay', '2026-q3', true),
  ('1380601152', '1380600000', 'Barangay 152', 'barangay', 'barangay', '2026-q3', true),
  ('1380601153', '1380600000', 'Barangay 153', 'barangay', 'barangay', '2026-q3', true),
  ('1380601154', '1380600000', 'Barangay 154', 'barangay', 'barangay', '2026-q3', true),
  ('1380601155', '1380600000', 'Barangay 155', 'barangay', 'barangay', '2026-q3', true),
  ('1380601156', '1380600000', 'Barangay 156', 'barangay', 'barangay', '2026-q3', true),
  ('1380601157', '1380600000', 'Barangay 157', 'barangay', 'barangay', '2026-q3', true),
  ('1380601158', '1380600000', 'Barangay 158', 'barangay', 'barangay', '2026-q3', true),
  ('1380601159', '1380600000', 'Barangay 159', 'barangay', 'barangay', '2026-q3', true),
  ('1380601160', '1380600000', 'Barangay 160', 'barangay', 'barangay', '2026-q3', true),
  ('1380601161', '1380600000', 'Barangay 161', 'barangay', 'barangay', '2026-q3', true),
  ('1380601162', '1380600000', 'Barangay 162', 'barangay', 'barangay', '2026-q3', true),
  ('1380601163', '1380600000', 'Barangay 163', 'barangay', 'barangay', '2026-q3', true),
  ('1380601164', '1380600000', 'Barangay 164', 'barangay', 'barangay', '2026-q3', true),
  ('1380601165', '1380600000', 'Barangay 165', 'barangay', 'barangay', '2026-q3', true),
  ('1380601166', '1380600000', 'Barangay 166', 'barangay', 'barangay', '2026-q3', true),
  ('1380601167', '1380600000', 'Barangay 167', 'barangay', 'barangay', '2026-q3', true),
  ('1380601168', '1380600000', 'Barangay 168', 'barangay', 'barangay', '2026-q3', true),
  ('1380601169', '1380600000', 'Barangay 169', 'barangay', 'barangay', '2026-q3', true),
  ('1380601170', '1380600000', 'Barangay 170', 'barangay', 'barangay', '2026-q3', true),
  ('1380601171', '1380600000', 'Barangay 171', 'barangay', 'barangay', '2026-q3', true),
  ('1380601172', '1380600000', 'Barangay 172', 'barangay', 'barangay', '2026-q3', true),
  ('1380601173', '1380600000', 'Barangay 173', 'barangay', 'barangay', '2026-q3', true),
  ('1380601174', '1380600000', 'Barangay 174', 'barangay', 'barangay', '2026-q3', true),
  ('1380601175', '1380600000', 'Barangay 175', 'barangay', 'barangay', '2026-q3', true),
  ('1380601176', '1380600000', 'Barangay 176', 'barangay', 'barangay', '2026-q3', true),
  ('1380601177', '1380600000', 'Barangay 177', 'barangay', 'barangay', '2026-q3', true),
  ('1380601178', '1380600000', 'Barangay 178', 'barangay', 'barangay', '2026-q3', true),
  ('1380601179', '1380600000', 'Barangay 179', 'barangay', 'barangay', '2026-q3', true),
  ('1380601180', '1380600000', 'Barangay 180', 'barangay', 'barangay', '2026-q3', true),
  ('1380601181', '1380600000', 'Barangay 181', 'barangay', 'barangay', '2026-q3', true),
  ('1380601182', '1380600000', 'Barangay 182', 'barangay', 'barangay', '2026-q3', true),
  ('1380601183', '1380600000', 'Barangay 183', 'barangay', 'barangay', '2026-q3', true),
  ('1380601184', '1380600000', 'Barangay 184', 'barangay', 'barangay', '2026-q3', true),
  ('1380601185', '1380600000', 'Barangay 185', 'barangay', 'barangay', '2026-q3', true),
  ('1380601186', '1380600000', 'Barangay 186', 'barangay', 'barangay', '2026-q3', true),
  ('1380601187', '1380600000', 'Barangay 187', 'barangay', 'barangay', '2026-q3', true),
  ('1380601188', '1380600000', 'Barangay 188', 'barangay', 'barangay', '2026-q3', true),
  ('1380601189', '1380600000', 'Barangay 189', 'barangay', 'barangay', '2026-q3', true),
  ('1380601190', '1380600000', 'Barangay 190', 'barangay', 'barangay', '2026-q3', true),
  ('1380601191', '1380600000', 'Barangay 191', 'barangay', 'barangay', '2026-q3', true),
  ('1380601192', '1380600000', 'Barangay 192', 'barangay', 'barangay', '2026-q3', true),
  ('1380601193', '1380600000', 'Barangay 193', 'barangay', 'barangay', '2026-q3', true),
  ('1380601194', '1380600000', 'Barangay 194', 'barangay', 'barangay', '2026-q3', true),
  ('1380601195', '1380600000', 'Barangay 195', 'barangay', 'barangay', '2026-q3', true),
  ('1380601196', '1380600000', 'Barangay 196', 'barangay', 'barangay', '2026-q3', true),
  ('1380601197', '1380600000', 'Barangay 197', 'barangay', 'barangay', '2026-q3', true),
  ('1380601198', '1380600000', 'Barangay 198', 'barangay', 'barangay', '2026-q3', true),
  ('1380601199', '1380600000', 'Barangay 199', 'barangay', 'barangay', '2026-q3', true),
  ('1380601200', '1380600000', 'Barangay 200', 'barangay', 'barangay', '2026-q3', true),
  ('1380601201', '1380600000', 'Barangay 201', 'barangay', 'barangay', '2026-q3', true),
  ('1380601202', '1380600000', 'Barangay 202', 'barangay', 'barangay', '2026-q3', true),
  ('1380601203', '1380600000', 'Barangay 202-A', 'barangay', 'barangay', '2026-q3', true),
  ('1380601204', '1380600000', 'Barangay 203', 'barangay', 'barangay', '2026-q3', true),
  ('1380601205', '1380600000', 'Barangay 204', 'barangay', 'barangay', '2026-q3', true),
  ('1380601206', '1380600000', 'Barangay 205', 'barangay', 'barangay', '2026-q3', true),
  ('1380601207', '1380600000', 'Barangay 206', 'barangay', 'barangay', '2026-q3', true),
  ('1380601208', '1380600000', 'Barangay 207', 'barangay', 'barangay', '2026-q3', true),
  ('1380601209', '1380600000', 'Barangay 208', 'barangay', 'barangay', '2026-q3', true),
  ('1380601210', '1380600000', 'Barangay 209', 'barangay', 'barangay', '2026-q3', true),
  ('1380601211', '1380600000', 'Barangay 210', 'barangay', 'barangay', '2026-q3', true),
  ('1380601212', '1380600000', 'Barangay 211', 'barangay', 'barangay', '2026-q3', true),
  ('1380601213', '1380600000', 'Barangay 212', 'barangay', 'barangay', '2026-q3', true),
  ('1380601214', '1380600000', 'Barangay 213', 'barangay', 'barangay', '2026-q3', true),
  ('1380601215', '1380600000', 'Barangay 214', 'barangay', 'barangay', '2026-q3', true),
  ('1380601216', '1380600000', 'Barangay 215', 'barangay', 'barangay', '2026-q3', true),
  ('1380601217', '1380600000', 'Barangay 216', 'barangay', 'barangay', '2026-q3', true),
  ('1380601218', '1380600000', 'Barangay 217', 'barangay', 'barangay', '2026-q3', true),
  ('1380601219', '1380600000', 'Barangay 218', 'barangay', 'barangay', '2026-q3', true),
  ('1380601220', '1380600000', 'Barangay 219', 'barangay', 'barangay', '2026-q3', true),
  ('1380601221', '1380600000', 'Barangay 220', 'barangay', 'barangay', '2026-q3', true),
  ('1380601222', '1380600000', 'Barangay 221', 'barangay', 'barangay', '2026-q3', true),
  ('1380601223', '1380600000', 'Barangay 222', 'barangay', 'barangay', '2026-q3', true),
  ('1380601224', '1380600000', 'Barangay 223', 'barangay', 'barangay', '2026-q3', true),
  ('1380601225', '1380600000', 'Barangay 224', 'barangay', 'barangay', '2026-q3', true),
  ('1380601226', '1380600000', 'Barangay 225', 'barangay', 'barangay', '2026-q3', true),
  ('1380601227', '1380600000', 'Barangay 226', 'barangay', 'barangay', '2026-q3', true),
  ('1380601228', '1380600000', 'Barangay 227', 'barangay', 'barangay', '2026-q3', true),
  ('1380601229', '1380600000', 'Barangay 228', 'barangay', 'barangay', '2026-q3', true),
  ('1380601230', '1380600000', 'Barangay 229', 'barangay', 'barangay', '2026-q3', true),
  ('1380601231', '1380600000', 'Barangay 230', 'barangay', 'barangay', '2026-q3', true),
  ('1380601232', '1380600000', 'Barangay 231', 'barangay', 'barangay', '2026-q3', true),
  ('1380601233', '1380600000', 'Barangay 232', 'barangay', 'barangay', '2026-q3', true),
  ('1380601234', '1380600000', 'Barangay 233', 'barangay', 'barangay', '2026-q3', true),
  ('1380601235', '1380600000', 'Barangay 234', 'barangay', 'barangay', '2026-q3', true),
  ('1380601236', '1380600000', 'Barangay 235', 'barangay', 'barangay', '2026-q3', true),
  ('1380601237', '1380600000', 'Barangay 236', 'barangay', 'barangay', '2026-q3', true),
  ('1380601238', '1380600000', 'Barangay 237', 'barangay', 'barangay', '2026-q3', true),
  ('1380601239', '1380600000', 'Barangay 238', 'barangay', 'barangay', '2026-q3', true),
  ('1380601240', '1380600000', 'Barangay 239', 'barangay', 'barangay', '2026-q3', true),
  ('1380601241', '1380600000', 'Barangay 240', 'barangay', 'barangay', '2026-q3', true),
  ('1380601242', '1380600000', 'Barangay 241', 'barangay', 'barangay', '2026-q3', true),
  ('1380601243', '1380600000', 'Barangay 242', 'barangay', 'barangay', '2026-q3', true),
  ('1380601244', '1380600000', 'Barangay 243', 'barangay', 'barangay', '2026-q3', true),
  ('1380601245', '1380600000', 'Barangay 244', 'barangay', 'barangay', '2026-q3', true),
  ('1380601246', '1380600000', 'Barangay 245', 'barangay', 'barangay', '2026-q3', true),
  ('1380601247', '1380600000', 'Barangay 246', 'barangay', 'barangay', '2026-q3', true),
  ('1380601248', '1380600000', 'Barangay 247', 'barangay', 'barangay', '2026-q3', true),
  ('1380601249', '1380600000', 'Barangay 248', 'barangay', 'barangay', '2026-q3', true),
  ('1380601250', '1380600000', 'Barangay 249', 'barangay', 'barangay', '2026-q3', true),
  ('1380601251', '1380600000', 'Barangay 250', 'barangay', 'barangay', '2026-q3', true),
  ('1380601252', '1380600000', 'Barangay 251', 'barangay', 'barangay', '2026-q3', true),
  ('1380601253', '1380600000', 'Barangay 252', 'barangay', 'barangay', '2026-q3', true),
  ('1380601254', '1380600000', 'Barangay 253', 'barangay', 'barangay', '2026-q3', true),
  ('1380601255', '1380600000', 'Barangay 254', 'barangay', 'barangay', '2026-q3', true),
  ('1380601256', '1380600000', 'Barangay 255', 'barangay', 'barangay', '2026-q3', true),
  ('1380601257', '1380600000', 'Barangay 256', 'barangay', 'barangay', '2026-q3', true),
  ('1380601258', '1380600000', 'Barangay 257', 'barangay', 'barangay', '2026-q3', true),
  ('1380601259', '1380600000', 'Barangay 258', 'barangay', 'barangay', '2026-q3', true),
  ('1380601260', '1380600000', 'Barangay 259', 'barangay', 'barangay', '2026-q3', true),
  ('1380601261', '1380600000', 'Barangay 260', 'barangay', 'barangay', '2026-q3', true),
  ('1380601262', '1380600000', 'Barangay 261', 'barangay', 'barangay', '2026-q3', true),
  ('1380601263', '1380600000', 'Barangay 262', 'barangay', 'barangay', '2026-q3', true),
  ('1380601264', '1380600000', 'Barangay 263', 'barangay', 'barangay', '2026-q3', true),
  ('1380601265', '1380600000', 'Barangay 264', 'barangay', 'barangay', '2026-q3', true),
  ('1380601266', '1380600000', 'Barangay 265', 'barangay', 'barangay', '2026-q3', true),
  ('1380601267', '1380600000', 'Barangay 266', 'barangay', 'barangay', '2026-q3', true),
  ('1380601268', '1380600000', 'Barangay 267', 'barangay', 'barangay', '2026-q3', true),
  ('1380602001', '1380600000', 'Barangay 287', 'barangay', 'barangay', '2026-q3', true),
  ('1380602002', '1380600000', 'Barangay 288', 'barangay', 'barangay', '2026-q3', true),
  ('1380602003', '1380600000', 'Barangay 289', 'barangay', 'barangay', '2026-q3', true),
  ('1380602004', '1380600000', 'Barangay 290', 'barangay', 'barangay', '2026-q3', true),
  ('1380602005', '1380600000', 'Barangay 291', 'barangay', 'barangay', '2026-q3', true),
  ('1380602006', '1380600000', 'Barangay 292', 'barangay', 'barangay', '2026-q3', true),
  ('1380602007', '1380600000', 'Barangay 293', 'barangay', 'barangay', '2026-q3', true),
  ('1380602008', '1380600000', 'Barangay 294', 'barangay', 'barangay', '2026-q3', true),
  ('1380602009', '1380600000', 'Barangay 295', 'barangay', 'barangay', '2026-q3', true),
  ('1380602010', '1380600000', 'Barangay 296', 'barangay', 'barangay', '2026-q3', true),
  ('1380603003', '1380600000', 'Barangay 383', 'barangay', 'barangay', '2026-q3', true),
  ('1380603004', '1380600000', 'Barangay 384', 'barangay', 'barangay', '2026-q3', true),
  ('1380603005', '1380600000', 'Barangay 385', 'barangay', 'barangay', '2026-q3', true),
  ('1380603006', '1380600000', 'Barangay 386', 'barangay', 'barangay', '2026-q3', true),
  ('1380603007', '1380600000', 'Barangay 387', 'barangay', 'barangay', '2026-q3', true),
  ('1380603008', '1380600000', 'Barangay 388', 'barangay', 'barangay', '2026-q3', true),
  ('1380603009', '1380600000', 'Barangay 389', 'barangay', 'barangay', '2026-q3', true),
  ('1380603010', '1380600000', 'Barangay 390', 'barangay', 'barangay', '2026-q3', true),
  ('1380603011', '1380600000', 'Barangay 391', 'barangay', 'barangay', '2026-q3', true),
  ('1380603012', '1380600000', 'Barangay 392', 'barangay', 'barangay', '2026-q3', true),
  ('1380603013', '1380600000', 'Barangay 393', 'barangay', 'barangay', '2026-q3', true),
  ('1380603014', '1380600000', 'Barangay 394', 'barangay', 'barangay', '2026-q3', true),
  ('1380603015', '1380600000', 'Barangay 306', 'barangay', 'barangay', '2026-q3', true),
  ('1380603016', '1380600000', 'Barangay 307', 'barangay', 'barangay', '2026-q3', true),
  ('1380603017', '1380600000', 'Barangay 308', 'barangay', 'barangay', '2026-q3', true),
  ('1380603018', '1380600000', 'Barangay 309', 'barangay', 'barangay', '2026-q3', true),
  ('1380604001', '1380600000', 'Barangay 268', 'barangay', 'barangay', '2026-q3', true),
  ('1380604002', '1380600000', 'Barangay 269', 'barangay', 'barangay', '2026-q3', true),
  ('1380604003', '1380600000', 'Barangay 270', 'barangay', 'barangay', '2026-q3', true),
  ('1380604004', '1380600000', 'Barangay 271', 'barangay', 'barangay', '2026-q3', true),
  ('1380604005', '1380600000', 'Barangay 272', 'barangay', 'barangay', '2026-q3', true),
  ('1380604006', '1380600000', 'Barangay 273', 'barangay', 'barangay', '2026-q3', true),
  ('1380604007', '1380600000', 'Barangay 274', 'barangay', 'barangay', '2026-q3', true),
  ('1380604008', '1380600000', 'Barangay 275', 'barangay', 'barangay', '2026-q3', true),
  ('1380604009', '1380600000', 'Barangay 276', 'barangay', 'barangay', '2026-q3', true),
  ('1380604014', '1380600000', 'Barangay 281', 'barangay', 'barangay', '2026-q3', true),
  ('1380604015', '1380600000', 'Barangay 282', 'barangay', 'barangay', '2026-q3', true),
  ('1380604016', '1380600000', 'Barangay 283', 'barangay', 'barangay', '2026-q3', true),
  ('1380604017', '1380600000', 'Barangay 284', 'barangay', 'barangay', '2026-q3', true),
  ('1380604018', '1380600000', 'Barangay 285', 'barangay', 'barangay', '2026-q3', true),
  ('1380604019', '1380600000', 'Barangay 286', 'barangay', 'barangay', '2026-q3', true),
  ('1380605001', '1380600000', 'Barangay 297', 'barangay', 'barangay', '2026-q3', true),
  ('1380605002', '1380600000', 'Barangay 298', 'barangay', 'barangay', '2026-q3', true),
  ('1380605003', '1380600000', 'Barangay 299', 'barangay', 'barangay', '2026-q3', true),
  ('1380605004', '1380600000', 'Barangay 300', 'barangay', 'barangay', '2026-q3', true),
  ('1380605005', '1380600000', 'Barangay 301', 'barangay', 'barangay', '2026-q3', true),
  ('1380605006', '1380600000', 'Barangay 302', 'barangay', 'barangay', '2026-q3', true),
  ('1380605007', '1380600000', 'Barangay 303', 'barangay', 'barangay', '2026-q3', true),
  ('1380605008', '1380600000', 'Barangay 304', 'barangay', 'barangay', '2026-q3', true),
  ('1380605009', '1380600000', 'Barangay 305', 'barangay', 'barangay', '2026-q3', true),
  ('1380605012', '1380600000', 'Barangay 310', 'barangay', 'barangay', '2026-q3', true),
  ('1380605013', '1380600000', 'Barangay 311', 'barangay', 'barangay', '2026-q3', true),
  ('1380605014', '1380600000', 'Barangay 312', 'barangay', 'barangay', '2026-q3', true),
  ('1380605015', '1380600000', 'Barangay 313', 'barangay', 'barangay', '2026-q3', true),
  ('1380605016', '1380600000', 'Barangay 314', 'barangay', 'barangay', '2026-q3', true),
  ('1380605017', '1380600000', 'Barangay 315', 'barangay', 'barangay', '2026-q3', true),
  ('1380605018', '1380600000', 'Barangay 316', 'barangay', 'barangay', '2026-q3', true)
on conflict (psgc_code) do update set
  parent_psgc_code = excluded.parent_psgc_code,
  name = excluded.name,
  level = excluded.level,
  location_type = excluded.location_type,
  reference_version_id = excluded.reference_version_id,
  is_active = excluded.is_active;

insert into public.psgc_locations (psgc_code, parent_psgc_code, name, level, location_type, reference_version_id, is_active)
values
  ('1380605019', '1380600000', 'Barangay 317', 'barangay', 'barangay', '2026-q3', true),
  ('1380605020', '1380600000', 'Barangay 318', 'barangay', 'barangay', '2026-q3', true),
  ('1380605021', '1380600000', 'Barangay 319', 'barangay', 'barangay', '2026-q3', true),
  ('1380605022', '1380600000', 'Barangay 320', 'barangay', 'barangay', '2026-q3', true),
  ('1380605023', '1380600000', 'Barangay 321', 'barangay', 'barangay', '2026-q3', true),
  ('1380605024', '1380600000', 'Barangay 322', 'barangay', 'barangay', '2026-q3', true),
  ('1380605025', '1380600000', 'Barangay 323', 'barangay', 'barangay', '2026-q3', true),
  ('1380605026', '1380600000', 'Barangay 324', 'barangay', 'barangay', '2026-q3', true),
  ('1380605027', '1380600000', 'Barangay 325', 'barangay', 'barangay', '2026-q3', true),
  ('1380605028', '1380600000', 'Barangay 326', 'barangay', 'barangay', '2026-q3', true),
  ('1380605029', '1380600000', 'Barangay 327', 'barangay', 'barangay', '2026-q3', true),
  ('1380605030', '1380600000', 'Barangay 328', 'barangay', 'barangay', '2026-q3', true),
  ('1380605031', '1380600000', 'Barangay 329', 'barangay', 'barangay', '2026-q3', true),
  ('1380605032', '1380600000', 'Barangay 330', 'barangay', 'barangay', '2026-q3', true),
  ('1380605033', '1380600000', 'Barangay 331', 'barangay', 'barangay', '2026-q3', true),
  ('1380605034', '1380600000', 'Barangay 332', 'barangay', 'barangay', '2026-q3', true),
  ('1380605035', '1380600000', 'Barangay 333', 'barangay', 'barangay', '2026-q3', true),
  ('1380605036', '1380600000', 'Barangay 334', 'barangay', 'barangay', '2026-q3', true),
  ('1380605037', '1380600000', 'Barangay 335', 'barangay', 'barangay', '2026-q3', true),
  ('1380605038', '1380600000', 'Barangay 336', 'barangay', 'barangay', '2026-q3', true),
  ('1380605039', '1380600000', 'Barangay 337', 'barangay', 'barangay', '2026-q3', true),
  ('1380605040', '1380600000', 'Barangay 338', 'barangay', 'barangay', '2026-q3', true),
  ('1380605041', '1380600000', 'Barangay 339', 'barangay', 'barangay', '2026-q3', true),
  ('1380605042', '1380600000', 'Barangay 340', 'barangay', 'barangay', '2026-q3', true),
  ('1380605043', '1380600000', 'Barangay 341', 'barangay', 'barangay', '2026-q3', true),
  ('1380605044', '1380600000', 'Barangay 342', 'barangay', 'barangay', '2026-q3', true),
  ('1380605045', '1380600000', 'Barangay 343', 'barangay', 'barangay', '2026-q3', true),
  ('1380605046', '1380600000', 'Barangay 344', 'barangay', 'barangay', '2026-q3', true),
  ('1380605047', '1380600000', 'Barangay 345', 'barangay', 'barangay', '2026-q3', true),
  ('1380605048', '1380600000', 'Barangay 346', 'barangay', 'barangay', '2026-q3', true),
  ('1380605049', '1380600000', 'Barangay 347', 'barangay', 'barangay', '2026-q3', true),
  ('1380605050', '1380600000', 'Barangay 348', 'barangay', 'barangay', '2026-q3', true),
  ('1380605051', '1380600000', 'Barangay 349', 'barangay', 'barangay', '2026-q3', true),
  ('1380605052', '1380600000', 'Barangay 350', 'barangay', 'barangay', '2026-q3', true),
  ('1380605053', '1380600000', 'Barangay 351', 'barangay', 'barangay', '2026-q3', true),
  ('1380605054', '1380600000', 'Barangay 352', 'barangay', 'barangay', '2026-q3', true),
  ('1380605055', '1380600000', 'Barangay 353', 'barangay', 'barangay', '2026-q3', true),
  ('1380605056', '1380600000', 'Barangay 354', 'barangay', 'barangay', '2026-q3', true),
  ('1380605057', '1380600000', 'Barangay 355', 'barangay', 'barangay', '2026-q3', true),
  ('1380605058', '1380600000', 'Barangay 356', 'barangay', 'barangay', '2026-q3', true),
  ('1380605059', '1380600000', 'Barangay 357', 'barangay', 'barangay', '2026-q3', true),
  ('1380605060', '1380600000', 'Barangay 358', 'barangay', 'barangay', '2026-q3', true),
  ('1380605061', '1380600000', 'Barangay 359', 'barangay', 'barangay', '2026-q3', true),
  ('1380605062', '1380600000', 'Barangay 360', 'barangay', 'barangay', '2026-q3', true),
  ('1380605063', '1380600000', 'Barangay 361', 'barangay', 'barangay', '2026-q3', true),
  ('1380605064', '1380600000', 'Barangay 362', 'barangay', 'barangay', '2026-q3', true),
  ('1380605065', '1380600000', 'Barangay 363', 'barangay', 'barangay', '2026-q3', true),
  ('1380605066', '1380600000', 'Barangay 364', 'barangay', 'barangay', '2026-q3', true),
  ('1380605067', '1380600000', 'Barangay 365', 'barangay', 'barangay', '2026-q3', true),
  ('1380605069', '1380600000', 'Barangay 366', 'barangay', 'barangay', '2026-q3', true),
  ('1380605070', '1380600000', 'Barangay 367', 'barangay', 'barangay', '2026-q3', true),
  ('1380605071', '1380600000', 'Barangay 368', 'barangay', 'barangay', '2026-q3', true),
  ('1380605072', '1380600000', 'Barangay 369', 'barangay', 'barangay', '2026-q3', true),
  ('1380605073', '1380600000', 'Barangay 370', 'barangay', 'barangay', '2026-q3', true),
  ('1380605074', '1380600000', 'Barangay 371', 'barangay', 'barangay', '2026-q3', true),
  ('1380605075', '1380600000', 'Barangay 372', 'barangay', 'barangay', '2026-q3', true),
  ('1380605076', '1380600000', 'Barangay 373', 'barangay', 'barangay', '2026-q3', true),
  ('1380605077', '1380600000', 'Barangay 374', 'barangay', 'barangay', '2026-q3', true),
  ('1380605078', '1380600000', 'Barangay 375', 'barangay', 'barangay', '2026-q3', true),
  ('1380605079', '1380600000', 'Barangay 376', 'barangay', 'barangay', '2026-q3', true),
  ('1380605080', '1380600000', 'Barangay 377', 'barangay', 'barangay', '2026-q3', true),
  ('1380605081', '1380600000', 'Barangay 378', 'barangay', 'barangay', '2026-q3', true),
  ('1380605082', '1380600000', 'Barangay 379', 'barangay', 'barangay', '2026-q3', true),
  ('1380605083', '1380600000', 'Barangay 380', 'barangay', 'barangay', '2026-q3', true),
  ('1380605084', '1380600000', 'Barangay 381', 'barangay', 'barangay', '2026-q3', true),
  ('1380605085', '1380600000', 'Barangay 382', 'barangay', 'barangay', '2026-q3', true),
  ('1380606001', '1380600000', 'Barangay 395', 'barangay', 'barangay', '2026-q3', true),
  ('1380606002', '1380600000', 'Barangay 396', 'barangay', 'barangay', '2026-q3', true),
  ('1380606003', '1380600000', 'Barangay 397', 'barangay', 'barangay', '2026-q3', true),
  ('1380606004', '1380600000', 'Barangay 398', 'barangay', 'barangay', '2026-q3', true),
  ('1380606005', '1380600000', 'Barangay 399', 'barangay', 'barangay', '2026-q3', true),
  ('1380606006', '1380600000', 'Barangay 400', 'barangay', 'barangay', '2026-q3', true),
  ('1380606007', '1380600000', 'Barangay 401', 'barangay', 'barangay', '2026-q3', true),
  ('1380606008', '1380600000', 'Barangay 402', 'barangay', 'barangay', '2026-q3', true),
  ('1380606009', '1380600000', 'Barangay 403', 'barangay', 'barangay', '2026-q3', true),
  ('1380606010', '1380600000', 'Barangay 404', 'barangay', 'barangay', '2026-q3', true),
  ('1380606011', '1380600000', 'Barangay 405', 'barangay', 'barangay', '2026-q3', true),
  ('1380606012', '1380600000', 'Barangay 406', 'barangay', 'barangay', '2026-q3', true),
  ('1380606013', '1380600000', 'Barangay 407', 'barangay', 'barangay', '2026-q3', true),
  ('1380606014', '1380600000', 'Barangay 408', 'barangay', 'barangay', '2026-q3', true),
  ('1380606015', '1380600000', 'Barangay 409', 'barangay', 'barangay', '2026-q3', true),
  ('1380606016', '1380600000', 'Barangay 410', 'barangay', 'barangay', '2026-q3', true),
  ('1380606017', '1380600000', 'Barangay 411', 'barangay', 'barangay', '2026-q3', true),
  ('1380606018', '1380600000', 'Barangay 412', 'barangay', 'barangay', '2026-q3', true),
  ('1380606019', '1380600000', 'Barangay 413', 'barangay', 'barangay', '2026-q3', true),
  ('1380606020', '1380600000', 'Barangay 414', 'barangay', 'barangay', '2026-q3', true),
  ('1380606021', '1380600000', 'Barangay 415', 'barangay', 'barangay', '2026-q3', true),
  ('1380606022', '1380600000', 'Barangay 416', 'barangay', 'barangay', '2026-q3', true),
  ('1380606023', '1380600000', 'Barangay 417', 'barangay', 'barangay', '2026-q3', true),
  ('1380606024', '1380600000', 'Barangay 418', 'barangay', 'barangay', '2026-q3', true),
  ('1380606025', '1380600000', 'Barangay 419', 'barangay', 'barangay', '2026-q3', true),
  ('1380606026', '1380600000', 'Barangay 420', 'barangay', 'barangay', '2026-q3', true),
  ('1380606027', '1380600000', 'Barangay 421', 'barangay', 'barangay', '2026-q3', true),
  ('1380606028', '1380600000', 'Barangay 422', 'barangay', 'barangay', '2026-q3', true),
  ('1380606029', '1380600000', 'Barangay 423', 'barangay', 'barangay', '2026-q3', true),
  ('1380606030', '1380600000', 'Barangay 424', 'barangay', 'barangay', '2026-q3', true),
  ('1380606031', '1380600000', 'Barangay 425', 'barangay', 'barangay', '2026-q3', true),
  ('1380606032', '1380600000', 'Barangay 426', 'barangay', 'barangay', '2026-q3', true),
  ('1380606033', '1380600000', 'Barangay 427', 'barangay', 'barangay', '2026-q3', true),
  ('1380606034', '1380600000', 'Barangay 428', 'barangay', 'barangay', '2026-q3', true),
  ('1380606035', '1380600000', 'Barangay 429', 'barangay', 'barangay', '2026-q3', true),
  ('1380606036', '1380600000', 'Barangay 430', 'barangay', 'barangay', '2026-q3', true),
  ('1380606037', '1380600000', 'Barangay 431', 'barangay', 'barangay', '2026-q3', true),
  ('1380606038', '1380600000', 'Barangay 432', 'barangay', 'barangay', '2026-q3', true),
  ('1380606039', '1380600000', 'Barangay 433', 'barangay', 'barangay', '2026-q3', true),
  ('1380606040', '1380600000', 'Barangay 434', 'barangay', 'barangay', '2026-q3', true),
  ('1380606041', '1380600000', 'Barangay 435', 'barangay', 'barangay', '2026-q3', true),
  ('1380606042', '1380600000', 'Barangay 436', 'barangay', 'barangay', '2026-q3', true),
  ('1380606043', '1380600000', 'Barangay 437', 'barangay', 'barangay', '2026-q3', true),
  ('1380606044', '1380600000', 'Barangay 438', 'barangay', 'barangay', '2026-q3', true),
  ('1380606045', '1380600000', 'Barangay 439', 'barangay', 'barangay', '2026-q3', true),
  ('1380606046', '1380600000', 'Barangay 440', 'barangay', 'barangay', '2026-q3', true),
  ('1380606047', '1380600000', 'Barangay 441', 'barangay', 'barangay', '2026-q3', true),
  ('1380606048', '1380600000', 'Barangay 442', 'barangay', 'barangay', '2026-q3', true),
  ('1380606049', '1380600000', 'Barangay 443', 'barangay', 'barangay', '2026-q3', true),
  ('1380606050', '1380600000', 'Barangay 444', 'barangay', 'barangay', '2026-q3', true),
  ('1380606051', '1380600000', 'Barangay 445', 'barangay', 'barangay', '2026-q3', true),
  ('1380606052', '1380600000', 'Barangay 446', 'barangay', 'barangay', '2026-q3', true),
  ('1380606053', '1380600000', 'Barangay 447', 'barangay', 'barangay', '2026-q3', true),
  ('1380606054', '1380600000', 'Barangay 448', 'barangay', 'barangay', '2026-q3', true),
  ('1380606055', '1380600000', 'Barangay 449', 'barangay', 'barangay', '2026-q3', true),
  ('1380606056', '1380600000', 'Barangay 450', 'barangay', 'barangay', '2026-q3', true),
  ('1380606057', '1380600000', 'Barangay 451', 'barangay', 'barangay', '2026-q3', true),
  ('1380606058', '1380600000', 'Barangay 452', 'barangay', 'barangay', '2026-q3', true),
  ('1380606059', '1380600000', 'Barangay 453', 'barangay', 'barangay', '2026-q3', true),
  ('1380606060', '1380600000', 'Barangay 454', 'barangay', 'barangay', '2026-q3', true),
  ('1380606061', '1380600000', 'Barangay 455', 'barangay', 'barangay', '2026-q3', true),
  ('1380606062', '1380600000', 'Barangay 456', 'barangay', 'barangay', '2026-q3', true),
  ('1380606063', '1380600000', 'Barangay 457', 'barangay', 'barangay', '2026-q3', true),
  ('1380606064', '1380600000', 'Barangay 458', 'barangay', 'barangay', '2026-q3', true),
  ('1380606065', '1380600000', 'Barangay 459', 'barangay', 'barangay', '2026-q3', true),
  ('1380606066', '1380600000', 'Barangay 460', 'barangay', 'barangay', '2026-q3', true),
  ('1380606067', '1380600000', 'Barangay 461', 'barangay', 'barangay', '2026-q3', true),
  ('1380606068', '1380600000', 'Barangay 462', 'barangay', 'barangay', '2026-q3', true),
  ('1380606069', '1380600000', 'Barangay 463', 'barangay', 'barangay', '2026-q3', true),
  ('1380606070', '1380600000', 'Barangay 464', 'barangay', 'barangay', '2026-q3', true),
  ('1380606071', '1380600000', 'Barangay 465', 'barangay', 'barangay', '2026-q3', true),
  ('1380606072', '1380600000', 'Barangay 466', 'barangay', 'barangay', '2026-q3', true),
  ('1380606073', '1380600000', 'Barangay 467', 'barangay', 'barangay', '2026-q3', true),
  ('1380606074', '1380600000', 'Barangay 468', 'barangay', 'barangay', '2026-q3', true),
  ('1380606075', '1380600000', 'Barangay 469', 'barangay', 'barangay', '2026-q3', true),
  ('1380606076', '1380600000', 'Barangay 470', 'barangay', 'barangay', '2026-q3', true),
  ('1380606077', '1380600000', 'Barangay 471', 'barangay', 'barangay', '2026-q3', true),
  ('1380606078', '1380600000', 'Barangay 472', 'barangay', 'barangay', '2026-q3', true),
  ('1380606079', '1380600000', 'Barangay 473', 'barangay', 'barangay', '2026-q3', true),
  ('1380606080', '1380600000', 'Barangay 474', 'barangay', 'barangay', '2026-q3', true),
  ('1380606081', '1380600000', 'Barangay 475', 'barangay', 'barangay', '2026-q3', true),
  ('1380606082', '1380600000', 'Barangay 476', 'barangay', 'barangay', '2026-q3', true),
  ('1380606083', '1380600000', 'Barangay 477', 'barangay', 'barangay', '2026-q3', true),
  ('1380606084', '1380600000', 'Barangay 478', 'barangay', 'barangay', '2026-q3', true),
  ('1380606085', '1380600000', 'Barangay 479', 'barangay', 'barangay', '2026-q3', true),
  ('1380606086', '1380600000', 'Barangay 480', 'barangay', 'barangay', '2026-q3', true),
  ('1380606087', '1380600000', 'Barangay 481', 'barangay', 'barangay', '2026-q3', true),
  ('1380606088', '1380600000', 'Barangay 482', 'barangay', 'barangay', '2026-q3', true),
  ('1380606089', '1380600000', 'Barangay 483', 'barangay', 'barangay', '2026-q3', true),
  ('1380606090', '1380600000', 'Barangay 484', 'barangay', 'barangay', '2026-q3', true),
  ('1380606091', '1380600000', 'Barangay 485', 'barangay', 'barangay', '2026-q3', true),
  ('1380606092', '1380600000', 'Barangay 486', 'barangay', 'barangay', '2026-q3', true),
  ('1380606093', '1380600000', 'Barangay 487', 'barangay', 'barangay', '2026-q3', true),
  ('1380606094', '1380600000', 'Barangay 488', 'barangay', 'barangay', '2026-q3', true),
  ('1380606095', '1380600000', 'Barangay 489', 'barangay', 'barangay', '2026-q3', true),
  ('1380606096', '1380600000', 'Barangay 490', 'barangay', 'barangay', '2026-q3', true),
  ('1380606097', '1380600000', 'Barangay 491', 'barangay', 'barangay', '2026-q3', true),
  ('1380606098', '1380600000', 'Barangay 492', 'barangay', 'barangay', '2026-q3', true),
  ('1380606099', '1380600000', 'Barangay 493', 'barangay', 'barangay', '2026-q3', true),
  ('1380606100', '1380600000', 'Barangay 494', 'barangay', 'barangay', '2026-q3', true),
  ('1380606101', '1380600000', 'Barangay 495', 'barangay', 'barangay', '2026-q3', true),
  ('1380606102', '1380600000', 'Barangay 496', 'barangay', 'barangay', '2026-q3', true),
  ('1380606103', '1380600000', 'Barangay 497', 'barangay', 'barangay', '2026-q3', true),
  ('1380606104', '1380600000', 'Barangay 498', 'barangay', 'barangay', '2026-q3', true),
  ('1380606105', '1380600000', 'Barangay 499', 'barangay', 'barangay', '2026-q3', true),
  ('1380606106', '1380600000', 'Barangay 500', 'barangay', 'barangay', '2026-q3', true),
  ('1380606107', '1380600000', 'Barangay 501', 'barangay', 'barangay', '2026-q3', true),
  ('1380606108', '1380600000', 'Barangay 502', 'barangay', 'barangay', '2026-q3', true),
  ('1380606109', '1380600000', 'Barangay 503', 'barangay', 'barangay', '2026-q3', true),
  ('1380606110', '1380600000', 'Barangay 504', 'barangay', 'barangay', '2026-q3', true),
  ('1380606111', '1380600000', 'Barangay 505', 'barangay', 'barangay', '2026-q3', true),
  ('1380606112', '1380600000', 'Barangay 506', 'barangay', 'barangay', '2026-q3', true),
  ('1380606113', '1380600000', 'Barangay 507', 'barangay', 'barangay', '2026-q3', true),
  ('1380606114', '1380600000', 'Barangay 508', 'barangay', 'barangay', '2026-q3', true),
  ('1380606115', '1380600000', 'Barangay 509', 'barangay', 'barangay', '2026-q3', true),
  ('1380606116', '1380600000', 'Barangay 510', 'barangay', 'barangay', '2026-q3', true),
  ('1380606117', '1380600000', 'Barangay 511', 'barangay', 'barangay', '2026-q3', true),
  ('1380606118', '1380600000', 'Barangay 512', 'barangay', 'barangay', '2026-q3', true),
  ('1380606119', '1380600000', 'Barangay 513', 'barangay', 'barangay', '2026-q3', true),
  ('1380606120', '1380600000', 'Barangay 514', 'barangay', 'barangay', '2026-q3', true),
  ('1380606121', '1380600000', 'Barangay 515', 'barangay', 'barangay', '2026-q3', true),
  ('1380606122', '1380600000', 'Barangay 516', 'barangay', 'barangay', '2026-q3', true),
  ('1380606123', '1380600000', 'Barangay 517', 'barangay', 'barangay', '2026-q3', true),
  ('1380606124', '1380600000', 'Barangay 518', 'barangay', 'barangay', '2026-q3', true),
  ('1380606125', '1380600000', 'Barangay 519', 'barangay', 'barangay', '2026-q3', true),
  ('1380606126', '1380600000', 'Barangay 520', 'barangay', 'barangay', '2026-q3', true),
  ('1380606127', '1380600000', 'Barangay 521', 'barangay', 'barangay', '2026-q3', true),
  ('1380606128', '1380600000', 'Barangay 522', 'barangay', 'barangay', '2026-q3', true),
  ('1380606129', '1380600000', 'Barangay 523', 'barangay', 'barangay', '2026-q3', true),
  ('1380606130', '1380600000', 'Barangay 524', 'barangay', 'barangay', '2026-q3', true),
  ('1380606131', '1380600000', 'Barangay 525', 'barangay', 'barangay', '2026-q3', true),
  ('1380606132', '1380600000', 'Barangay 526', 'barangay', 'barangay', '2026-q3', true),
  ('1380606133', '1380600000', 'Barangay 527', 'barangay', 'barangay', '2026-q3', true),
  ('1380606134', '1380600000', 'Barangay 528', 'barangay', 'barangay', '2026-q3', true)
on conflict (psgc_code) do update set
  parent_psgc_code = excluded.parent_psgc_code,
  name = excluded.name,
  level = excluded.level,
  location_type = excluded.location_type,
  reference_version_id = excluded.reference_version_id,
  is_active = excluded.is_active;

insert into public.psgc_locations (psgc_code, parent_psgc_code, name, level, location_type, reference_version_id, is_active)
values
  ('1380606135', '1380600000', 'Barangay 529', 'barangay', 'barangay', '2026-q3', true),
  ('1380606136', '1380600000', 'Barangay 530', 'barangay', 'barangay', '2026-q3', true),
  ('1380606137', '1380600000', 'Barangay 531', 'barangay', 'barangay', '2026-q3', true),
  ('1380606138', '1380600000', 'Barangay 532', 'barangay', 'barangay', '2026-q3', true),
  ('1380606139', '1380600000', 'Barangay 533', 'barangay', 'barangay', '2026-q3', true),
  ('1380606140', '1380600000', 'Barangay 534', 'barangay', 'barangay', '2026-q3', true),
  ('1380606141', '1380600000', 'Barangay 535', 'barangay', 'barangay', '2026-q3', true),
  ('1380606142', '1380600000', 'Barangay 536', 'barangay', 'barangay', '2026-q3', true),
  ('1380606143', '1380600000', 'Barangay 537', 'barangay', 'barangay', '2026-q3', true),
  ('1380606144', '1380600000', 'Barangay 538', 'barangay', 'barangay', '2026-q3', true),
  ('1380606145', '1380600000', 'Barangay 539', 'barangay', 'barangay', '2026-q3', true),
  ('1380606146', '1380600000', 'Barangay 540', 'barangay', 'barangay', '2026-q3', true),
  ('1380606147', '1380600000', 'Barangay 541', 'barangay', 'barangay', '2026-q3', true),
  ('1380606148', '1380600000', 'Barangay 542', 'barangay', 'barangay', '2026-q3', true),
  ('1380606149', '1380600000', 'Barangay 543', 'barangay', 'barangay', '2026-q3', true),
  ('1380606150', '1380600000', 'Barangay 544', 'barangay', 'barangay', '2026-q3', true),
  ('1380606151', '1380600000', 'Barangay 545', 'barangay', 'barangay', '2026-q3', true),
  ('1380606152', '1380600000', 'Barangay 546', 'barangay', 'barangay', '2026-q3', true),
  ('1380606153', '1380600000', 'Barangay 547', 'barangay', 'barangay', '2026-q3', true),
  ('1380606154', '1380600000', 'Barangay 548', 'barangay', 'barangay', '2026-q3', true),
  ('1380606155', '1380600000', 'Barangay 549', 'barangay', 'barangay', '2026-q3', true),
  ('1380606156', '1380600000', 'Barangay 550', 'barangay', 'barangay', '2026-q3', true),
  ('1380606157', '1380600000', 'Barangay 551', 'barangay', 'barangay', '2026-q3', true),
  ('1380606158', '1380600000', 'Barangay 552', 'barangay', 'barangay', '2026-q3', true),
  ('1380606159', '1380600000', 'Barangay 553', 'barangay', 'barangay', '2026-q3', true),
  ('1380606160', '1380600000', 'Barangay 554', 'barangay', 'barangay', '2026-q3', true),
  ('1380606161', '1380600000', 'Barangay 555', 'barangay', 'barangay', '2026-q3', true),
  ('1380606162', '1380600000', 'Barangay 556', 'barangay', 'barangay', '2026-q3', true),
  ('1380606163', '1380600000', 'Barangay 557', 'barangay', 'barangay', '2026-q3', true),
  ('1380606164', '1380600000', 'Barangay 558', 'barangay', 'barangay', '2026-q3', true),
  ('1380606165', '1380600000', 'Barangay 559', 'barangay', 'barangay', '2026-q3', true),
  ('1380606166', '1380600000', 'Barangay 560', 'barangay', 'barangay', '2026-q3', true),
  ('1380606167', '1380600000', 'Barangay 561', 'barangay', 'barangay', '2026-q3', true),
  ('1380606168', '1380600000', 'Barangay 562', 'barangay', 'barangay', '2026-q3', true),
  ('1380606169', '1380600000', 'Barangay 563', 'barangay', 'barangay', '2026-q3', true),
  ('1380606170', '1380600000', 'Barangay 564', 'barangay', 'barangay', '2026-q3', true),
  ('1380606171', '1380600000', 'Barangay 565', 'barangay', 'barangay', '2026-q3', true),
  ('1380606172', '1380600000', 'Barangay 566', 'barangay', 'barangay', '2026-q3', true),
  ('1380606173', '1380600000', 'Barangay 567', 'barangay', 'barangay', '2026-q3', true),
  ('1380606174', '1380600000', 'Barangay 568', 'barangay', 'barangay', '2026-q3', true),
  ('1380606175', '1380600000', 'Barangay 569', 'barangay', 'barangay', '2026-q3', true),
  ('1380606176', '1380600000', 'Barangay 570', 'barangay', 'barangay', '2026-q3', true),
  ('1380606177', '1380600000', 'Barangay 571', 'barangay', 'barangay', '2026-q3', true),
  ('1380606178', '1380600000', 'Barangay 572', 'barangay', 'barangay', '2026-q3', true),
  ('1380606179', '1380600000', 'Barangay 573', 'barangay', 'barangay', '2026-q3', true),
  ('1380606180', '1380600000', 'Barangay 574', 'barangay', 'barangay', '2026-q3', true),
  ('1380606181', '1380600000', 'Barangay 575', 'barangay', 'barangay', '2026-q3', true),
  ('1380606182', '1380600000', 'Barangay 576', 'barangay', 'barangay', '2026-q3', true),
  ('1380606183', '1380600000', 'Barangay 577', 'barangay', 'barangay', '2026-q3', true),
  ('1380606184', '1380600000', 'Barangay 578', 'barangay', 'barangay', '2026-q3', true),
  ('1380606185', '1380600000', 'Barangay 579', 'barangay', 'barangay', '2026-q3', true),
  ('1380606186', '1380600000', 'Barangay 580', 'barangay', 'barangay', '2026-q3', true),
  ('1380606187', '1380600000', 'Barangay 581', 'barangay', 'barangay', '2026-q3', true),
  ('1380606188', '1380600000', 'Barangay 582', 'barangay', 'barangay', '2026-q3', true),
  ('1380606189', '1380600000', 'Barangay 583', 'barangay', 'barangay', '2026-q3', true),
  ('1380606190', '1380600000', 'Barangay 584', 'barangay', 'barangay', '2026-q3', true),
  ('1380606191', '1380600000', 'Barangay 585', 'barangay', 'barangay', '2026-q3', true),
  ('1380606192', '1380600000', 'Barangay 586', 'barangay', 'barangay', '2026-q3', true),
  ('1380606193', '1380600000', 'Barangay 587', 'barangay', 'barangay', '2026-q3', true),
  ('1380606194', '1380600000', 'Barangay 587-A', 'barangay', 'barangay', '2026-q3', true),
  ('1380606195', '1380600000', 'Barangay 588', 'barangay', 'barangay', '2026-q3', true),
  ('1380606196', '1380600000', 'Barangay 589', 'barangay', 'barangay', '2026-q3', true),
  ('1380606197', '1380600000', 'Barangay 590', 'barangay', 'barangay', '2026-q3', true),
  ('1380606198', '1380600000', 'Barangay 591', 'barangay', 'barangay', '2026-q3', true),
  ('1380606199', '1380600000', 'Barangay 592', 'barangay', 'barangay', '2026-q3', true),
  ('1380606200', '1380600000', 'Barangay 593', 'barangay', 'barangay', '2026-q3', true),
  ('1380606201', '1380600000', 'Barangay 594', 'barangay', 'barangay', '2026-q3', true),
  ('1380606202', '1380600000', 'Barangay 595', 'barangay', 'barangay', '2026-q3', true),
  ('1380606203', '1380600000', 'Barangay 596', 'barangay', 'barangay', '2026-q3', true),
  ('1380606204', '1380600000', 'Barangay 597', 'barangay', 'barangay', '2026-q3', true),
  ('1380606205', '1380600000', 'Barangay 598', 'barangay', 'barangay', '2026-q3', true),
  ('1380606206', '1380600000', 'Barangay 599', 'barangay', 'barangay', '2026-q3', true),
  ('1380606207', '1380600000', 'Barangay 600', 'barangay', 'barangay', '2026-q3', true),
  ('1380606208', '1380600000', 'Barangay 601', 'barangay', 'barangay', '2026-q3', true),
  ('1380606209', '1380600000', 'Barangay 602', 'barangay', 'barangay', '2026-q3', true),
  ('1380606210', '1380600000', 'Barangay 603', 'barangay', 'barangay', '2026-q3', true),
  ('1380606211', '1380600000', 'Barangay 604', 'barangay', 'barangay', '2026-q3', true),
  ('1380606212', '1380600000', 'Barangay 605', 'barangay', 'barangay', '2026-q3', true),
  ('1380606213', '1380600000', 'Barangay 606', 'barangay', 'barangay', '2026-q3', true),
  ('1380606214', '1380600000', 'Barangay 607', 'barangay', 'barangay', '2026-q3', true),
  ('1380606215', '1380600000', 'Barangay 608', 'barangay', 'barangay', '2026-q3', true),
  ('1380606216', '1380600000', 'Barangay 609', 'barangay', 'barangay', '2026-q3', true),
  ('1380606217', '1380600000', 'Barangay 610', 'barangay', 'barangay', '2026-q3', true),
  ('1380606218', '1380600000', 'Barangay 611', 'barangay', 'barangay', '2026-q3', true),
  ('1380606219', '1380600000', 'Barangay 612', 'barangay', 'barangay', '2026-q3', true),
  ('1380606220', '1380600000', 'Barangay 613', 'barangay', 'barangay', '2026-q3', true),
  ('1380606221', '1380600000', 'Barangay 614', 'barangay', 'barangay', '2026-q3', true),
  ('1380606222', '1380600000', 'Barangay 615', 'barangay', 'barangay', '2026-q3', true),
  ('1380606223', '1380600000', 'Barangay 616', 'barangay', 'barangay', '2026-q3', true),
  ('1380606224', '1380600000', 'Barangay 617', 'barangay', 'barangay', '2026-q3', true),
  ('1380606225', '1380600000', 'Barangay 618', 'barangay', 'barangay', '2026-q3', true),
  ('1380606226', '1380600000', 'Barangay 619', 'barangay', 'barangay', '2026-q3', true),
  ('1380606227', '1380600000', 'Barangay 620', 'barangay', 'barangay', '2026-q3', true),
  ('1380606228', '1380600000', 'Barangay 621', 'barangay', 'barangay', '2026-q3', true),
  ('1380606229', '1380600000', 'Barangay 622', 'barangay', 'barangay', '2026-q3', true),
  ('1380606230', '1380600000', 'Barangay 623', 'barangay', 'barangay', '2026-q3', true),
  ('1380606231', '1380600000', 'Barangay 624', 'barangay', 'barangay', '2026-q3', true),
  ('1380606232', '1380600000', 'Barangay 625', 'barangay', 'barangay', '2026-q3', true),
  ('1380606233', '1380600000', 'Barangay 626', 'barangay', 'barangay', '2026-q3', true),
  ('1380606234', '1380600000', 'Barangay 627', 'barangay', 'barangay', '2026-q3', true),
  ('1380606235', '1380600000', 'Barangay 628', 'barangay', 'barangay', '2026-q3', true),
  ('1380606236', '1380600000', 'Barangay 629', 'barangay', 'barangay', '2026-q3', true),
  ('1380606237', '1380600000', 'Barangay 630', 'barangay', 'barangay', '2026-q3', true),
  ('1380606238', '1380600000', 'Barangay 631', 'barangay', 'barangay', '2026-q3', true),
  ('1380606239', '1380600000', 'Barangay 632', 'barangay', 'barangay', '2026-q3', true),
  ('1380606240', '1380600000', 'Barangay 633', 'barangay', 'barangay', '2026-q3', true),
  ('1380606241', '1380600000', 'Barangay 634', 'barangay', 'barangay', '2026-q3', true),
  ('1380606242', '1380600000', 'Barangay 635', 'barangay', 'barangay', '2026-q3', true),
  ('1380606243', '1380600000', 'Barangay 636', 'barangay', 'barangay', '2026-q3', true),
  ('1380607001', '1380600000', 'Barangay 637', 'barangay', 'barangay', '2026-q3', true),
  ('1380607002', '1380600000', 'Barangay 638', 'barangay', 'barangay', '2026-q3', true),
  ('1380607003', '1380600000', 'Barangay 639', 'barangay', 'barangay', '2026-q3', true),
  ('1380607004', '1380600000', 'Barangay 640', 'barangay', 'barangay', '2026-q3', true),
  ('1380607005', '1380600000', 'Barangay 641', 'barangay', 'barangay', '2026-q3', true),
  ('1380607006', '1380600000', 'Barangay 642', 'barangay', 'barangay', '2026-q3', true),
  ('1380607007', '1380600000', 'Barangay 643', 'barangay', 'barangay', '2026-q3', true),
  ('1380607008', '1380600000', 'Barangay 644', 'barangay', 'barangay', '2026-q3', true),
  ('1380607009', '1380600000', 'Barangay 645', 'barangay', 'barangay', '2026-q3', true),
  ('1380607010', '1380600000', 'Barangay 646', 'barangay', 'barangay', '2026-q3', true),
  ('1380607011', '1380600000', 'Barangay 647', 'barangay', 'barangay', '2026-q3', true),
  ('1380607012', '1380600000', 'Barangay 648', 'barangay', 'barangay', '2026-q3', true),
  ('1380608001', '1380600000', 'Barangay 659', 'barangay', 'barangay', '2026-q3', true),
  ('1380608002', '1380600000', 'Barangay 659-A', 'barangay', 'barangay', '2026-q3', true),
  ('1380608003', '1380600000', 'Barangay 660', 'barangay', 'barangay', '2026-q3', true),
  ('1380608004', '1380600000', 'Barangay 660-A', 'barangay', 'barangay', '2026-q3', true),
  ('1380608005', '1380600000', 'Barangay 661', 'barangay', 'barangay', '2026-q3', true),
  ('1380608008', '1380600000', 'Barangay 666', 'barangay', 'barangay', '2026-q3', true),
  ('1380608009', '1380600000', 'Barangay 667', 'barangay', 'barangay', '2026-q3', true),
  ('1380608010', '1380600000', 'Barangay 668', 'barangay', 'barangay', '2026-q3', true),
  ('1380608011', '1380600000', 'Barangay 669', 'barangay', 'barangay', '2026-q3', true),
  ('1380608012', '1380600000', 'Barangay 670', 'barangay', 'barangay', '2026-q3', true),
  ('1380608013', '1380600000', 'Barangay 663', 'barangay', 'barangay', '2026-q3', true),
  ('1380608014', '1380600000', 'Barangay 663-A', 'barangay', 'barangay', '2026-q3', true),
  ('1380608015', '1380600000', 'Barangay 664', 'barangay', 'barangay', '2026-q3', true),
  ('1380609001', '1380600000', 'Barangay 654', 'barangay', 'barangay', '2026-q3', true),
  ('1380609002', '1380600000', 'Barangay 655', 'barangay', 'barangay', '2026-q3', true),
  ('1380609003', '1380600000', 'Barangay 656', 'barangay', 'barangay', '2026-q3', true),
  ('1380609004', '1380600000', 'Barangay 657', 'barangay', 'barangay', '2026-q3', true),
  ('1380609005', '1380600000', 'Barangay 658', 'barangay', 'barangay', '2026-q3', true),
  ('1380610004', '1380600000', 'Barangay 689', 'barangay', 'barangay', '2026-q3', true),
  ('1380610005', '1380600000', 'Barangay 690', 'barangay', 'barangay', '2026-q3', true),
  ('1380610006', '1380600000', 'Barangay 691', 'barangay', 'barangay', '2026-q3', true),
  ('1380610007', '1380600000', 'Barangay 692', 'barangay', 'barangay', '2026-q3', true),
  ('1380610008', '1380600000', 'Barangay 693', 'barangay', 'barangay', '2026-q3', true),
  ('1380610009', '1380600000', 'Barangay 694', 'barangay', 'barangay', '2026-q3', true),
  ('1380610010', '1380600000', 'Barangay 695', 'barangay', 'barangay', '2026-q3', true),
  ('1380610011', '1380600000', 'Barangay 696', 'barangay', 'barangay', '2026-q3', true),
  ('1380610012', '1380600000', 'Barangay 697', 'barangay', 'barangay', '2026-q3', true),
  ('1380610013', '1380600000', 'Barangay 698', 'barangay', 'barangay', '2026-q3', true),
  ('1380610014', '1380600000', 'Barangay 699', 'barangay', 'barangay', '2026-q3', true),
  ('1380610015', '1380600000', 'Barangay 700', 'barangay', 'barangay', '2026-q3', true),
  ('1380610016', '1380600000', 'Barangay 701', 'barangay', 'barangay', '2026-q3', true),
  ('1380610017', '1380600000', 'Barangay 702', 'barangay', 'barangay', '2026-q3', true),
  ('1380610018', '1380600000', 'Barangay 703', 'barangay', 'barangay', '2026-q3', true),
  ('1380610019', '1380600000', 'Barangay 704', 'barangay', 'barangay', '2026-q3', true),
  ('1380610020', '1380600000', 'Barangay 705', 'barangay', 'barangay', '2026-q3', true),
  ('1380610021', '1380600000', 'Barangay 706', 'barangay', 'barangay', '2026-q3', true),
  ('1380610022', '1380600000', 'Barangay 707', 'barangay', 'barangay', '2026-q3', true),
  ('1380610023', '1380600000', 'Barangay 708', 'barangay', 'barangay', '2026-q3', true),
  ('1380610024', '1380600000', 'Barangay 709', 'barangay', 'barangay', '2026-q3', true),
  ('1380610025', '1380600000', 'Barangay 710', 'barangay', 'barangay', '2026-q3', true),
  ('1380610026', '1380600000', 'Barangay 711', 'barangay', 'barangay', '2026-q3', true),
  ('1380610027', '1380600000', 'Barangay 712', 'barangay', 'barangay', '2026-q3', true),
  ('1380610028', '1380600000', 'Barangay 713', 'barangay', 'barangay', '2026-q3', true),
  ('1380610029', '1380600000', 'Barangay 714', 'barangay', 'barangay', '2026-q3', true),
  ('1380610030', '1380600000', 'Barangay 715', 'barangay', 'barangay', '2026-q3', true),
  ('1380610031', '1380600000', 'Barangay 716', 'barangay', 'barangay', '2026-q3', true),
  ('1380610032', '1380600000', 'Barangay 717', 'barangay', 'barangay', '2026-q3', true),
  ('1380610033', '1380600000', 'Barangay 718', 'barangay', 'barangay', '2026-q3', true),
  ('1380610034', '1380600000', 'Barangay 719', 'barangay', 'barangay', '2026-q3', true),
  ('1380610035', '1380600000', 'Barangay 720', 'barangay', 'barangay', '2026-q3', true),
  ('1380610036', '1380600000', 'Barangay 721', 'barangay', 'barangay', '2026-q3', true),
  ('1380610037', '1380600000', 'Barangay 722', 'barangay', 'barangay', '2026-q3', true),
  ('1380610038', '1380600000', 'Barangay 723', 'barangay', 'barangay', '2026-q3', true),
  ('1380610039', '1380600000', 'Barangay 724', 'barangay', 'barangay', '2026-q3', true),
  ('1380610040', '1380600000', 'Barangay 725', 'barangay', 'barangay', '2026-q3', true),
  ('1380610041', '1380600000', 'Barangay 726', 'barangay', 'barangay', '2026-q3', true),
  ('1380610042', '1380600000', 'Barangay 727', 'barangay', 'barangay', '2026-q3', true),
  ('1380610043', '1380600000', 'Barangay 728', 'barangay', 'barangay', '2026-q3', true),
  ('1380610044', '1380600000', 'Barangay 729', 'barangay', 'barangay', '2026-q3', true),
  ('1380610045', '1380600000', 'Barangay 730', 'barangay', 'barangay', '2026-q3', true),
  ('1380610046', '1380600000', 'Barangay 731', 'barangay', 'barangay', '2026-q3', true),
  ('1380610047', '1380600000', 'Barangay 732', 'barangay', 'barangay', '2026-q3', true),
  ('1380610048', '1380600000', 'Barangay 733', 'barangay', 'barangay', '2026-q3', true),
  ('1380610052', '1380600000', 'Barangay 738', 'barangay', 'barangay', '2026-q3', true),
  ('1380610053', '1380600000', 'Barangay 739', 'barangay', 'barangay', '2026-q3', true),
  ('1380610054', '1380600000', 'Barangay 740', 'barangay', 'barangay', '2026-q3', true),
  ('1380610055', '1380600000', 'Barangay 741', 'barangay', 'barangay', '2026-q3', true),
  ('1380610056', '1380600000', 'Barangay 742', 'barangay', 'barangay', '2026-q3', true),
  ('1380610057', '1380600000', 'Barangay 743', 'barangay', 'barangay', '2026-q3', true),
  ('1380610058', '1380600000', 'Barangay 744', 'barangay', 'barangay', '2026-q3', true),
  ('1380610059', '1380600000', 'Barangay 688', 'barangay', 'barangay', '2026-q3', true),
  ('1380610060', '1380600000', 'Barangay 735', 'barangay', 'barangay', '2026-q3', true),
  ('1380610061', '1380600000', 'Barangay 736', 'barangay', 'barangay', '2026-q3', true),
  ('1380610062', '1380600000', 'Barangay 737', 'barangay', 'barangay', '2026-q3', true),
  ('1380610063', '1380600000', 'Barangay 734', 'barangay', 'barangay', '2026-q3', true),
  ('1380611001', '1380600000', 'Barangay 662', 'barangay', 'barangay', '2026-q3', true),
  ('1380611004', '1380600000', 'Barangay 664-A', 'barangay', 'barangay', '2026-q3', true),
  ('1380611005', '1380600000', 'Barangay 671', 'barangay', 'barangay', '2026-q3', true),
  ('1380611006', '1380600000', 'Barangay 672', 'barangay', 'barangay', '2026-q3', true)
on conflict (psgc_code) do update set
  parent_psgc_code = excluded.parent_psgc_code,
  name = excluded.name,
  level = excluded.level,
  location_type = excluded.location_type,
  reference_version_id = excluded.reference_version_id,
  is_active = excluded.is_active;

insert into public.psgc_locations (psgc_code, parent_psgc_code, name, level, location_type, reference_version_id, is_active)
values
  ('1380611007', '1380600000', 'Barangay 673', 'barangay', 'barangay', '2026-q3', true),
  ('1380611008', '1380600000', 'Barangay 674', 'barangay', 'barangay', '2026-q3', true),
  ('1380611009', '1380600000', 'Barangay 675', 'barangay', 'barangay', '2026-q3', true),
  ('1380611010', '1380600000', 'Barangay 676', 'barangay', 'barangay', '2026-q3', true),
  ('1380611011', '1380600000', 'Barangay 677', 'barangay', 'barangay', '2026-q3', true),
  ('1380611012', '1380600000', 'Barangay 678', 'barangay', 'barangay', '2026-q3', true),
  ('1380611013', '1380600000', 'Barangay 679', 'barangay', 'barangay', '2026-q3', true),
  ('1380611014', '1380600000', 'Barangay 680', 'barangay', 'barangay', '2026-q3', true),
  ('1380611015', '1380600000', 'Barangay 681', 'barangay', 'barangay', '2026-q3', true),
  ('1380611016', '1380600000', 'Barangay 682', 'barangay', 'barangay', '2026-q3', true),
  ('1380611017', '1380600000', 'Barangay 683', 'barangay', 'barangay', '2026-q3', true),
  ('1380611018', '1380600000', 'Barangay 684', 'barangay', 'barangay', '2026-q3', true),
  ('1380611019', '1380600000', 'Barangay 685', 'barangay', 'barangay', '2026-q3', true),
  ('1380611023', '1380600000', 'Barangay 809', 'barangay', 'barangay', '2026-q3', true),
  ('1380611024', '1380600000', 'Barangay 810', 'barangay', 'barangay', '2026-q3', true),
  ('1380611025', '1380600000', 'Barangay 811', 'barangay', 'barangay', '2026-q3', true),
  ('1380611026', '1380600000', 'Barangay 812', 'barangay', 'barangay', '2026-q3', true),
  ('1380611027', '1380600000', 'Barangay 813', 'barangay', 'barangay', '2026-q3', true),
  ('1380611028', '1380600000', 'Barangay 814', 'barangay', 'barangay', '2026-q3', true),
  ('1380611029', '1380600000', 'Barangay 815', 'barangay', 'barangay', '2026-q3', true),
  ('1380611030', '1380600000', 'Barangay 816', 'barangay', 'barangay', '2026-q3', true),
  ('1380611031', '1380600000', 'Barangay 817', 'barangay', 'barangay', '2026-q3', true),
  ('1380611032', '1380600000', 'Barangay 818', 'barangay', 'barangay', '2026-q3', true),
  ('1380611034', '1380600000', 'Barangay 819', 'barangay', 'barangay', '2026-q3', true),
  ('1380611035', '1380600000', 'Barangay 820', 'barangay', 'barangay', '2026-q3', true),
  ('1380611036', '1380600000', 'Barangay 821', 'barangay', 'barangay', '2026-q3', true),
  ('1380611037', '1380600000', 'Barangay 822', 'barangay', 'barangay', '2026-q3', true),
  ('1380611038', '1380600000', 'Barangay 823', 'barangay', 'barangay', '2026-q3', true),
  ('1380611039', '1380600000', 'Barangay 824', 'barangay', 'barangay', '2026-q3', true),
  ('1380611040', '1380600000', 'Barangay 825', 'barangay', 'barangay', '2026-q3', true),
  ('1380611041', '1380600000', 'Barangay 826', 'barangay', 'barangay', '2026-q3', true),
  ('1380611042', '1380600000', 'Barangay 827', 'barangay', 'barangay', '2026-q3', true),
  ('1380611043', '1380600000', 'Barangay 828', 'barangay', 'barangay', '2026-q3', true),
  ('1380611044', '1380600000', 'Barangay 829', 'barangay', 'barangay', '2026-q3', true),
  ('1380611045', '1380600000', 'Barangay 830', 'barangay', 'barangay', '2026-q3', true),
  ('1380611046', '1380600000', 'Barangay 831', 'barangay', 'barangay', '2026-q3', true),
  ('1380611047', '1380600000', 'Barangay 832', 'barangay', 'barangay', '2026-q3', true),
  ('1380611048', '1380600000', 'Barangay 686', 'barangay', 'barangay', '2026-q3', true),
  ('1380611049', '1380600000', 'Barangay 687', 'barangay', 'barangay', '2026-q3', true),
  ('1380612001', '1380600000', 'Barangay 833', 'barangay', 'barangay', '2026-q3', true),
  ('1380612002', '1380600000', 'Barangay 834', 'barangay', 'barangay', '2026-q3', true),
  ('1380612003', '1380600000', 'Barangay 835', 'barangay', 'barangay', '2026-q3', true),
  ('1380612004', '1380600000', 'Barangay 836', 'barangay', 'barangay', '2026-q3', true),
  ('1380612005', '1380600000', 'Barangay 837', 'barangay', 'barangay', '2026-q3', true),
  ('1380612006', '1380600000', 'Barangay 838', 'barangay', 'barangay', '2026-q3', true),
  ('1380612007', '1380600000', 'Barangay 839', 'barangay', 'barangay', '2026-q3', true),
  ('1380612008', '1380600000', 'Barangay 840', 'barangay', 'barangay', '2026-q3', true),
  ('1380612009', '1380600000', 'Barangay 841', 'barangay', 'barangay', '2026-q3', true),
  ('1380612010', '1380600000', 'Barangay 842', 'barangay', 'barangay', '2026-q3', true),
  ('1380612011', '1380600000', 'Barangay 843', 'barangay', 'barangay', '2026-q3', true),
  ('1380612012', '1380600000', 'Barangay 844', 'barangay', 'barangay', '2026-q3', true),
  ('1380612013', '1380600000', 'Barangay 845', 'barangay', 'barangay', '2026-q3', true),
  ('1380612014', '1380600000', 'Barangay 846', 'barangay', 'barangay', '2026-q3', true),
  ('1380612015', '1380600000', 'Barangay 847', 'barangay', 'barangay', '2026-q3', true),
  ('1380612016', '1380600000', 'Barangay 848', 'barangay', 'barangay', '2026-q3', true),
  ('1380612017', '1380600000', 'Barangay 849', 'barangay', 'barangay', '2026-q3', true),
  ('1380612018', '1380600000', 'Barangay 850', 'barangay', 'barangay', '2026-q3', true),
  ('1380612019', '1380600000', 'Barangay 851', 'barangay', 'barangay', '2026-q3', true),
  ('1380612020', '1380600000', 'Barangay 852', 'barangay', 'barangay', '2026-q3', true),
  ('1380612021', '1380600000', 'Barangay 853', 'barangay', 'barangay', '2026-q3', true),
  ('1380612023', '1380600000', 'Barangay 855', 'barangay', 'barangay', '2026-q3', true),
  ('1380612024', '1380600000', 'Barangay 856', 'barangay', 'barangay', '2026-q3', true),
  ('1380612025', '1380600000', 'Barangay 857', 'barangay', 'barangay', '2026-q3', true),
  ('1380612026', '1380600000', 'Barangay 858', 'barangay', 'barangay', '2026-q3', true),
  ('1380612027', '1380600000', 'Barangay 859', 'barangay', 'barangay', '2026-q3', true),
  ('1380612028', '1380600000', 'Barangay 860', 'barangay', 'barangay', '2026-q3', true),
  ('1380612029', '1380600000', 'Barangay 861', 'barangay', 'barangay', '2026-q3', true),
  ('1380612030', '1380600000', 'Barangay 862', 'barangay', 'barangay', '2026-q3', true),
  ('1380612031', '1380600000', 'Barangay 863', 'barangay', 'barangay', '2026-q3', true),
  ('1380612032', '1380600000', 'Barangay 864', 'barangay', 'barangay', '2026-q3', true),
  ('1380612033', '1380600000', 'Barangay 865', 'barangay', 'barangay', '2026-q3', true),
  ('1380612034', '1380600000', 'Barangay 867', 'barangay', 'barangay', '2026-q3', true),
  ('1380612035', '1380600000', 'Barangay 868', 'barangay', 'barangay', '2026-q3', true),
  ('1380612036', '1380600000', 'Barangay 870', 'barangay', 'barangay', '2026-q3', true),
  ('1380612037', '1380600000', 'Barangay 871', 'barangay', 'barangay', '2026-q3', true),
  ('1380612038', '1380600000', 'Barangay 872', 'barangay', 'barangay', '2026-q3', true),
  ('1380612039', '1380600000', 'Barangay 869', 'barangay', 'barangay', '2026-q3', true),
  ('1380613001', '1380600000', 'Barangay 649', 'barangay', 'barangay', '2026-q3', true),
  ('1380613002', '1380600000', 'Barangay 650', 'barangay', 'barangay', '2026-q3', true),
  ('1380613003', '1380600000', 'Barangay 651', 'barangay', 'barangay', '2026-q3', true),
  ('1380613004', '1380600000', 'Barangay 652', 'barangay', 'barangay', '2026-q3', true),
  ('1380613005', '1380600000', 'Barangay 653', 'barangay', 'barangay', '2026-q3', true),
  ('1380614002', '1380600000', 'Barangay 745', 'barangay', 'barangay', '2026-q3', true),
  ('1380614003', '1380600000', 'Barangay 746', 'barangay', 'barangay', '2026-q3', true),
  ('1380614004', '1380600000', 'Barangay 747', 'barangay', 'barangay', '2026-q3', true),
  ('1380614005', '1380600000', 'Barangay 748', 'barangay', 'barangay', '2026-q3', true),
  ('1380614006', '1380600000', 'Barangay 749', 'barangay', 'barangay', '2026-q3', true),
  ('1380614007', '1380600000', 'Barangay 750', 'barangay', 'barangay', '2026-q3', true),
  ('1380614008', '1380600000', 'Barangay 751', 'barangay', 'barangay', '2026-q3', true),
  ('1380614009', '1380600000', 'Barangay 752', 'barangay', 'barangay', '2026-q3', true),
  ('1380614010', '1380600000', 'Barangay 753', 'barangay', 'barangay', '2026-q3', true),
  ('1380614011', '1380600000', 'Barangay 755', 'barangay', 'barangay', '2026-q3', true),
  ('1380614012', '1380600000', 'Barangay 756', 'barangay', 'barangay', '2026-q3', true),
  ('1380614013', '1380600000', 'Barangay 757', 'barangay', 'barangay', '2026-q3', true),
  ('1380614014', '1380600000', 'Barangay 758', 'barangay', 'barangay', '2026-q3', true),
  ('1380614015', '1380600000', 'Barangay 759', 'barangay', 'barangay', '2026-q3', true),
  ('1380614016', '1380600000', 'Barangay 760', 'barangay', 'barangay', '2026-q3', true),
  ('1380614017', '1380600000', 'Barangay 761', 'barangay', 'barangay', '2026-q3', true),
  ('1380614018', '1380600000', 'Barangay 762', 'barangay', 'barangay', '2026-q3', true),
  ('1380614019', '1380600000', 'Barangay 763', 'barangay', 'barangay', '2026-q3', true),
  ('1380614020', '1380600000', 'Barangay 764', 'barangay', 'barangay', '2026-q3', true),
  ('1380614021', '1380600000', 'Barangay 765', 'barangay', 'barangay', '2026-q3', true),
  ('1380614022', '1380600000', 'Barangay 766', 'barangay', 'barangay', '2026-q3', true),
  ('1380614023', '1380600000', 'Barangay 767', 'barangay', 'barangay', '2026-q3', true),
  ('1380614024', '1380600000', 'Barangay 768', 'barangay', 'barangay', '2026-q3', true),
  ('1380614025', '1380600000', 'Barangay 769', 'barangay', 'barangay', '2026-q3', true),
  ('1380614026', '1380600000', 'Barangay 770', 'barangay', 'barangay', '2026-q3', true),
  ('1380614027', '1380600000', 'Barangay 771', 'barangay', 'barangay', '2026-q3', true),
  ('1380614028', '1380600000', 'Barangay 772', 'barangay', 'barangay', '2026-q3', true),
  ('1380614029', '1380600000', 'Barangay 773', 'barangay', 'barangay', '2026-q3', true),
  ('1380614030', '1380600000', 'Barangay 774', 'barangay', 'barangay', '2026-q3', true),
  ('1380614031', '1380600000', 'Barangay 775', 'barangay', 'barangay', '2026-q3', true),
  ('1380614032', '1380600000', 'Barangay 776', 'barangay', 'barangay', '2026-q3', true),
  ('1380614033', '1380600000', 'Barangay 777', 'barangay', 'barangay', '2026-q3', true),
  ('1380614034', '1380600000', 'Barangay 778', 'barangay', 'barangay', '2026-q3', true),
  ('1380614035', '1380600000', 'Barangay 779', 'barangay', 'barangay', '2026-q3', true),
  ('1380614036', '1380600000', 'Barangay 780', 'barangay', 'barangay', '2026-q3', true),
  ('1380614037', '1380600000', 'Barangay 781', 'barangay', 'barangay', '2026-q3', true),
  ('1380614038', '1380600000', 'Barangay 782', 'barangay', 'barangay', '2026-q3', true),
  ('1380614039', '1380600000', 'Barangay 783', 'barangay', 'barangay', '2026-q3', true),
  ('1380614040', '1380600000', 'Barangay 784', 'barangay', 'barangay', '2026-q3', true),
  ('1380614041', '1380600000', 'Barangay 785', 'barangay', 'barangay', '2026-q3', true),
  ('1380614042', '1380600000', 'Barangay 786', 'barangay', 'barangay', '2026-q3', true),
  ('1380614043', '1380600000', 'Barangay 787', 'barangay', 'barangay', '2026-q3', true),
  ('1380614044', '1380600000', 'Barangay 788', 'barangay', 'barangay', '2026-q3', true),
  ('1380614045', '1380600000', 'Barangay 789', 'barangay', 'barangay', '2026-q3', true),
  ('1380614046', '1380600000', 'Barangay 790', 'barangay', 'barangay', '2026-q3', true),
  ('1380614047', '1380600000', 'Barangay 791', 'barangay', 'barangay', '2026-q3', true),
  ('1380614048', '1380600000', 'Barangay 792', 'barangay', 'barangay', '2026-q3', true),
  ('1380614049', '1380600000', 'Barangay 793', 'barangay', 'barangay', '2026-q3', true),
  ('1380614050', '1380600000', 'Barangay 794', 'barangay', 'barangay', '2026-q3', true),
  ('1380614051', '1380600000', 'Barangay 795', 'barangay', 'barangay', '2026-q3', true),
  ('1380614052', '1380600000', 'Barangay 796', 'barangay', 'barangay', '2026-q3', true),
  ('1380614053', '1380600000', 'Barangay 797', 'barangay', 'barangay', '2026-q3', true),
  ('1380614054', '1380600000', 'Barangay 798', 'barangay', 'barangay', '2026-q3', true),
  ('1380614055', '1380600000', 'Barangay 799', 'barangay', 'barangay', '2026-q3', true),
  ('1380614056', '1380600000', 'Barangay 800', 'barangay', 'barangay', '2026-q3', true),
  ('1380614057', '1380600000', 'Barangay 801', 'barangay', 'barangay', '2026-q3', true),
  ('1380614058', '1380600000', 'Barangay 802', 'barangay', 'barangay', '2026-q3', true),
  ('1380614059', '1380600000', 'Barangay 803', 'barangay', 'barangay', '2026-q3', true),
  ('1380614060', '1380600000', 'Barangay 804', 'barangay', 'barangay', '2026-q3', true),
  ('1380614061', '1380600000', 'Barangay 805', 'barangay', 'barangay', '2026-q3', true),
  ('1380614062', '1380600000', 'Barangay 806', 'barangay', 'barangay', '2026-q3', true),
  ('1380614063', '1380600000', 'Barangay 807', 'barangay', 'barangay', '2026-q3', true),
  ('1380614064', '1380600000', 'Barangay 866', 'barangay', 'barangay', '2026-q3', true),
  ('1380614066', '1380600000', 'Barangay 873', 'barangay', 'barangay', '2026-q3', true),
  ('1380614067', '1380600000', 'Barangay 874', 'barangay', 'barangay', '2026-q3', true),
  ('1380614068', '1380600000', 'Barangay 875', 'barangay', 'barangay', '2026-q3', true),
  ('1380614069', '1380600000', 'Barangay 876', 'barangay', 'barangay', '2026-q3', true),
  ('1380614070', '1380600000', 'Barangay 877', 'barangay', 'barangay', '2026-q3', true),
  ('1380614071', '1380600000', 'Barangay 878', 'barangay', 'barangay', '2026-q3', true),
  ('1380614072', '1380600000', 'Barangay 879', 'barangay', 'barangay', '2026-q3', true),
  ('1380614073', '1380600000', 'Barangay 880', 'barangay', 'barangay', '2026-q3', true),
  ('1380614074', '1380600000', 'Barangay 881', 'barangay', 'barangay', '2026-q3', true),
  ('1380614075', '1380600000', 'Barangay 882', 'barangay', 'barangay', '2026-q3', true),
  ('1380614076', '1380600000', 'Barangay 883', 'barangay', 'barangay', '2026-q3', true),
  ('1380614077', '1380600000', 'Barangay 884', 'barangay', 'barangay', '2026-q3', true),
  ('1380614078', '1380600000', 'Barangay 885', 'barangay', 'barangay', '2026-q3', true),
  ('1380614079', '1380600000', 'Barangay 886', 'barangay', 'barangay', '2026-q3', true),
  ('1380614080', '1380600000', 'Barangay 887', 'barangay', 'barangay', '2026-q3', true),
  ('1380614081', '1380600000', 'Barangay 888', 'barangay', 'barangay', '2026-q3', true),
  ('1380614082', '1380600000', 'Barangay 889', 'barangay', 'barangay', '2026-q3', true),
  ('1380614083', '1380600000', 'Barangay 890', 'barangay', 'barangay', '2026-q3', true),
  ('1380614084', '1380600000', 'Barangay 891', 'barangay', 'barangay', '2026-q3', true),
  ('1380614085', '1380600000', 'Barangay 892', 'barangay', 'barangay', '2026-q3', true),
  ('1380614086', '1380600000', 'Barangay 893', 'barangay', 'barangay', '2026-q3', true),
  ('1380614087', '1380600000', 'Barangay 894', 'barangay', 'barangay', '2026-q3', true),
  ('1380614088', '1380600000', 'Barangay 895', 'barangay', 'barangay', '2026-q3', true),
  ('1380614089', '1380600000', 'Barangay 896', 'barangay', 'barangay', '2026-q3', true),
  ('1380614090', '1380600000', 'Barangay 897', 'barangay', 'barangay', '2026-q3', true),
  ('1380614091', '1380600000', 'Barangay 898', 'barangay', 'barangay', '2026-q3', true),
  ('1380614092', '1380600000', 'Barangay 899', 'barangay', 'barangay', '2026-q3', true),
  ('1380614093', '1380600000', 'Barangay 900', 'barangay', 'barangay', '2026-q3', true),
  ('1380614094', '1380600000', 'Barangay 901', 'barangay', 'barangay', '2026-q3', true),
  ('1380614095', '1380600000', 'Barangay 902', 'barangay', 'barangay', '2026-q3', true),
  ('1380614096', '1380600000', 'Barangay 903', 'barangay', 'barangay', '2026-q3', true),
  ('1380614097', '1380600000', 'Barangay 904', 'barangay', 'barangay', '2026-q3', true),
  ('1380614098', '1380600000', 'Barangay 905', 'barangay', 'barangay', '2026-q3', true),
  ('1380614099', '1380600000', 'Barangay 754', 'barangay', 'barangay', '2026-q3', true),
  ('1380614100', '1380600000', 'Barangay 808', 'barangay', 'barangay', '2026-q3', true),
  ('1380614101', '1380600000', 'Barangay 818-A', 'barangay', 'barangay', '2026-q3', true),
  ('1380700001', '1380700000', 'Barangka', 'barangay', 'barangay', '2026-q3', true),
  ('1380700002', '1380700000', 'Calumpang', 'barangay', 'barangay', '2026-q3', true),
  ('1380700003', '1380700000', 'Concepcion Uno', 'barangay', 'barangay', '2026-q3', true),
  ('1380700004', '1380700000', 'Jesus De La Peña', 'barangay', 'barangay', '2026-q3', true),
  ('1380700005', '1380700000', 'Malanday', 'barangay', 'barangay', '2026-q3', true),
  ('1380700006', '1380700000', 'Nangka', 'barangay', 'barangay', '2026-q3', true),
  ('1380700007', '1380700000', 'Parang', 'barangay', 'barangay', '2026-q3', true),
  ('1380700008', '1380700000', 'San Roque', 'barangay', 'barangay', '2026-q3', true),
  ('1380700009', '1380700000', 'Santa Elena', 'barangay', 'barangay', '2026-q3', true),
  ('1380700010', '1380700000', 'Santo Niño', 'barangay', 'barangay', '2026-q3', true),
  ('1380700011', '1380700000', 'Tañong', 'barangay', 'barangay', '2026-q3', true),
  ('1380700012', '1380700000', 'Concepcion Dos', 'barangay', 'barangay', '2026-q3', true),
  ('1380700013', '1380700000', 'Marikina Heights', 'barangay', 'barangay', '2026-q3', true),
  ('1380700014', '1380700000', 'Industrial Valley', 'barangay', 'barangay', '2026-q3', true),
  ('1380700015', '1380700000', 'Fortune', 'barangay', 'barangay', '2026-q3', true),
  ('1380700016', '1380700000', 'Tumana', 'barangay', 'barangay', '2026-q3', true),
  ('1380800001', '1380800000', 'Alabang', 'barangay', 'barangay', '2026-q3', true),
  ('1380800002', '1380800000', 'Bayanan', 'barangay', 'barangay', '2026-q3', true),
  ('1380800003', '1380800000', 'Buli', 'barangay', 'barangay', '2026-q3', true)
on conflict (psgc_code) do update set
  parent_psgc_code = excluded.parent_psgc_code,
  name = excluded.name,
  level = excluded.level,
  location_type = excluded.location_type,
  reference_version_id = excluded.reference_version_id,
  is_active = excluded.is_active;

insert into public.psgc_locations (psgc_code, parent_psgc_code, name, level, location_type, reference_version_id, is_active)
values
  ('1380800004', '1380800000', 'Cupang', 'barangay', 'barangay', '2026-q3', true),
  ('1380800005', '1380800000', 'Poblacion', 'barangay', 'barangay', '2026-q3', true),
  ('1380800006', '1380800000', 'Putatan', 'barangay', 'barangay', '2026-q3', true),
  ('1380800007', '1380800000', 'Sucat', 'barangay', 'barangay', '2026-q3', true),
  ('1380800008', '1380800000', 'Tunasan', 'barangay', 'barangay', '2026-q3', true),
  ('1380800009', '1380800000', 'New Alabang Village', 'barangay', 'barangay', '2026-q3', true),
  ('1380900001', '1380900000', 'Sipac-Almacen', 'barangay', 'barangay', '2026-q3', true),
  ('1380900002', '1380900000', 'Bagumbayan North', 'barangay', 'barangay', '2026-q3', true),
  ('1380900003', '1380900000', 'Bagumbayan South', 'barangay', 'barangay', '2026-q3', true),
  ('1380900004', '1380900000', 'Bangculasi', 'barangay', 'barangay', '2026-q3', true),
  ('1380900005', '1380900000', 'Daanghari', 'barangay', 'barangay', '2026-q3', true),
  ('1380900006', '1380900000', 'Navotas East', 'barangay', 'barangay', '2026-q3', true),
  ('1380900007', '1380900000', 'Navotas West', 'barangay', 'barangay', '2026-q3', true),
  ('1380900008', '1380900000', 'North Bay Boulevard North', 'barangay', 'barangay', '2026-q3', true),
  ('1380900009', '1380900000', 'NBBS Kaunlaran', 'barangay', 'barangay', '2026-q3', true),
  ('1380900010', '1380900000', 'San Jose', 'barangay', 'barangay', '2026-q3', true),
  ('1380900011', '1380900000', 'San Rafael Village', 'barangay', 'barangay', '2026-q3', true),
  ('1380900012', '1380900000', 'San Roque', 'barangay', 'barangay', '2026-q3', true),
  ('1380900013', '1380900000', 'Tangos South', 'barangay', 'barangay', '2026-q3', true),
  ('1380900014', '1380900000', 'Tanza 1', 'barangay', 'barangay', '2026-q3', true),
  ('1380900015', '1380900000', 'NBBS Dagat-dagatan', 'barangay', 'barangay', '2026-q3', true),
  ('1380900016', '1380900000', 'NBBS Proper', 'barangay', 'barangay', '2026-q3', true),
  ('1380900017', '1380900000', 'Tangos North', 'barangay', 'barangay', '2026-q3', true),
  ('1380900018', '1380900000', 'Tanza 2', 'barangay', 'barangay', '2026-q3', true),
  ('1381000001', '1381000000', 'Baclaran', 'barangay', 'barangay', '2026-q3', true),
  ('1381000002', '1381000000', 'Don Galo', 'barangay', 'barangay', '2026-q3', true),
  ('1381000003', '1381000000', 'La Huerta', 'barangay', 'barangay', '2026-q3', true),
  ('1381000004', '1381000000', 'San Dionisio', 'barangay', 'barangay', '2026-q3', true),
  ('1381000005', '1381000000', 'Santo Niño', 'barangay', 'barangay', '2026-q3', true),
  ('1381000006', '1381000000', 'Tambo', 'barangay', 'barangay', '2026-q3', true),
  ('1381000007', '1381000000', 'B. F. Homes', 'barangay', 'barangay', '2026-q3', true),
  ('1381000008', '1381000000', 'Don Bosco', 'barangay', 'barangay', '2026-q3', true),
  ('1381000009', '1381000000', 'Marcelo Green Village', 'barangay', 'barangay', '2026-q3', true),
  ('1381000010', '1381000000', 'Merville', 'barangay', 'barangay', '2026-q3', true),
  ('1381000011', '1381000000', 'Moonwalk', 'barangay', 'barangay', '2026-q3', true),
  ('1381000012', '1381000000', 'San Antonio', 'barangay', 'barangay', '2026-q3', true),
  ('1381000013', '1381000000', 'San Isidro', 'barangay', 'barangay', '2026-q3', true),
  ('1381000014', '1381000000', 'San Martin De Porres', 'barangay', 'barangay', '2026-q3', true),
  ('1381000015', '1381000000', 'Sun Valley', 'barangay', 'barangay', '2026-q3', true),
  ('1381000016', '1381000000', 'Vitalez', 'barangay', 'barangay', '2026-q3', true),
  ('1381100001', '1381100000', 'Barangay 1', 'barangay', 'barangay', '2026-q3', true),
  ('1381100002', '1381100000', 'Barangay 2', 'barangay', 'barangay', '2026-q3', true),
  ('1381100003', '1381100000', 'Barangay 3', 'barangay', 'barangay', '2026-q3', true),
  ('1381100004', '1381100000', 'Barangay 4', 'barangay', 'barangay', '2026-q3', true),
  ('1381100005', '1381100000', 'Barangay 5', 'barangay', 'barangay', '2026-q3', true),
  ('1381100006', '1381100000', 'Barangay 6', 'barangay', 'barangay', '2026-q3', true),
  ('1381100007', '1381100000', 'Barangay 7', 'barangay', 'barangay', '2026-q3', true),
  ('1381100008', '1381100000', 'Barangay 8', 'barangay', 'barangay', '2026-q3', true),
  ('1381100009', '1381100000', 'Barangay 9', 'barangay', 'barangay', '2026-q3', true),
  ('1381100010', '1381100000', 'Barangay 10', 'barangay', 'barangay', '2026-q3', true),
  ('1381100011', '1381100000', 'Barangay 11', 'barangay', 'barangay', '2026-q3', true),
  ('1381100012', '1381100000', 'Barangay 12', 'barangay', 'barangay', '2026-q3', true),
  ('1381100013', '1381100000', 'Barangay 13', 'barangay', 'barangay', '2026-q3', true),
  ('1381100014', '1381100000', 'Barangay 14', 'barangay', 'barangay', '2026-q3', true),
  ('1381100015', '1381100000', 'Barangay 15', 'barangay', 'barangay', '2026-q3', true),
  ('1381100016', '1381100000', 'Barangay 16', 'barangay', 'barangay', '2026-q3', true),
  ('1381100017', '1381100000', 'Barangay 17', 'barangay', 'barangay', '2026-q3', true),
  ('1381100018', '1381100000', 'Barangay 18', 'barangay', 'barangay', '2026-q3', true),
  ('1381100019', '1381100000', 'Barangay 19', 'barangay', 'barangay', '2026-q3', true),
  ('1381100020', '1381100000', 'Barangay 20', 'barangay', 'barangay', '2026-q3', true),
  ('1381100021', '1381100000', 'Barangay 21', 'barangay', 'barangay', '2026-q3', true),
  ('1381100022', '1381100000', 'Barangay 22', 'barangay', 'barangay', '2026-q3', true),
  ('1381100023', '1381100000', 'Barangay 23', 'barangay', 'barangay', '2026-q3', true),
  ('1381100024', '1381100000', 'Barangay 24', 'barangay', 'barangay', '2026-q3', true),
  ('1381100025', '1381100000', 'Barangay 25', 'barangay', 'barangay', '2026-q3', true),
  ('1381100026', '1381100000', 'Barangay 26', 'barangay', 'barangay', '2026-q3', true),
  ('1381100027', '1381100000', 'Barangay 27', 'barangay', 'barangay', '2026-q3', true),
  ('1381100028', '1381100000', 'Barangay 28', 'barangay', 'barangay', '2026-q3', true),
  ('1381100029', '1381100000', 'Barangay 29', 'barangay', 'barangay', '2026-q3', true),
  ('1381100030', '1381100000', 'Barangay 30', 'barangay', 'barangay', '2026-q3', true),
  ('1381100031', '1381100000', 'Barangay 31', 'barangay', 'barangay', '2026-q3', true),
  ('1381100032', '1381100000', 'Barangay 32', 'barangay', 'barangay', '2026-q3', true),
  ('1381100033', '1381100000', 'Barangay 33', 'barangay', 'barangay', '2026-q3', true),
  ('1381100034', '1381100000', 'Barangay 34', 'barangay', 'barangay', '2026-q3', true),
  ('1381100035', '1381100000', 'Barangay 35', 'barangay', 'barangay', '2026-q3', true),
  ('1381100036', '1381100000', 'Barangay 36', 'barangay', 'barangay', '2026-q3', true),
  ('1381100037', '1381100000', 'Barangay 37', 'barangay', 'barangay', '2026-q3', true),
  ('1381100038', '1381100000', 'Barangay 38', 'barangay', 'barangay', '2026-q3', true),
  ('1381100039', '1381100000', 'Barangay 39', 'barangay', 'barangay', '2026-q3', true),
  ('1381100040', '1381100000', 'Barangay 40', 'barangay', 'barangay', '2026-q3', true),
  ('1381100041', '1381100000', 'Barangay 41', 'barangay', 'barangay', '2026-q3', true),
  ('1381100042', '1381100000', 'Barangay 42', 'barangay', 'barangay', '2026-q3', true),
  ('1381100043', '1381100000', 'Barangay 43', 'barangay', 'barangay', '2026-q3', true),
  ('1381100044', '1381100000', 'Barangay 44', 'barangay', 'barangay', '2026-q3', true),
  ('1381100045', '1381100000', 'Barangay 45', 'barangay', 'barangay', '2026-q3', true),
  ('1381100046', '1381100000', 'Barangay 46', 'barangay', 'barangay', '2026-q3', true),
  ('1381100047', '1381100000', 'Barangay 47', 'barangay', 'barangay', '2026-q3', true),
  ('1381100048', '1381100000', 'Barangay 48', 'barangay', 'barangay', '2026-q3', true),
  ('1381100049', '1381100000', 'Barangay 49', 'barangay', 'barangay', '2026-q3', true),
  ('1381100050', '1381100000', 'Barangay 50', 'barangay', 'barangay', '2026-q3', true),
  ('1381100051', '1381100000', 'Barangay 51', 'barangay', 'barangay', '2026-q3', true),
  ('1381100052', '1381100000', 'Barangay 52', 'barangay', 'barangay', '2026-q3', true),
  ('1381100053', '1381100000', 'Barangay 53', 'barangay', 'barangay', '2026-q3', true),
  ('1381100054', '1381100000', 'Barangay 54', 'barangay', 'barangay', '2026-q3', true),
  ('1381100055', '1381100000', 'Barangay 55', 'barangay', 'barangay', '2026-q3', true),
  ('1381100056', '1381100000', 'Barangay 56', 'barangay', 'barangay', '2026-q3', true),
  ('1381100057', '1381100000', 'Barangay 57', 'barangay', 'barangay', '2026-q3', true),
  ('1381100058', '1381100000', 'Barangay 58', 'barangay', 'barangay', '2026-q3', true),
  ('1381100059', '1381100000', 'Barangay 59', 'barangay', 'barangay', '2026-q3', true),
  ('1381100060', '1381100000', 'Barangay 60', 'barangay', 'barangay', '2026-q3', true),
  ('1381100061', '1381100000', 'Barangay 61', 'barangay', 'barangay', '2026-q3', true),
  ('1381100062', '1381100000', 'Barangay 62', 'barangay', 'barangay', '2026-q3', true),
  ('1381100063', '1381100000', 'Barangay 63', 'barangay', 'barangay', '2026-q3', true),
  ('1381100064', '1381100000', 'Barangay 64', 'barangay', 'barangay', '2026-q3', true),
  ('1381100065', '1381100000', 'Barangay 65', 'barangay', 'barangay', '2026-q3', true),
  ('1381100066', '1381100000', 'Barangay 66', 'barangay', 'barangay', '2026-q3', true),
  ('1381100067', '1381100000', 'Barangay 67', 'barangay', 'barangay', '2026-q3', true),
  ('1381100068', '1381100000', 'Barangay 68', 'barangay', 'barangay', '2026-q3', true),
  ('1381100069', '1381100000', 'Barangay 69', 'barangay', 'barangay', '2026-q3', true),
  ('1381100070', '1381100000', 'Barangay 70', 'barangay', 'barangay', '2026-q3', true),
  ('1381100071', '1381100000', 'Barangay 71', 'barangay', 'barangay', '2026-q3', true),
  ('1381100072', '1381100000', 'Barangay 72', 'barangay', 'barangay', '2026-q3', true),
  ('1381100073', '1381100000', 'Barangay 73', 'barangay', 'barangay', '2026-q3', true),
  ('1381100074', '1381100000', 'Barangay 74', 'barangay', 'barangay', '2026-q3', true),
  ('1381100075', '1381100000', 'Barangay 75', 'barangay', 'barangay', '2026-q3', true),
  ('1381100076', '1381100000', 'Barangay 76', 'barangay', 'barangay', '2026-q3', true),
  ('1381100077', '1381100000', 'Barangay 77', 'barangay', 'barangay', '2026-q3', true),
  ('1381100078', '1381100000', 'Barangay 78', 'barangay', 'barangay', '2026-q3', true),
  ('1381100079', '1381100000', 'Barangay 79', 'barangay', 'barangay', '2026-q3', true),
  ('1381100080', '1381100000', 'Barangay 80', 'barangay', 'barangay', '2026-q3', true),
  ('1381100081', '1381100000', 'Barangay 81', 'barangay', 'barangay', '2026-q3', true),
  ('1381100082', '1381100000', 'Barangay 82', 'barangay', 'barangay', '2026-q3', true),
  ('1381100083', '1381100000', 'Barangay 83', 'barangay', 'barangay', '2026-q3', true),
  ('1381100084', '1381100000', 'Barangay 84', 'barangay', 'barangay', '2026-q3', true),
  ('1381100085', '1381100000', 'Barangay 85', 'barangay', 'barangay', '2026-q3', true),
  ('1381100086', '1381100000', 'Barangay 86', 'barangay', 'barangay', '2026-q3', true),
  ('1381100087', '1381100000', 'Barangay 87', 'barangay', 'barangay', '2026-q3', true),
  ('1381100088', '1381100000', 'Barangay 88', 'barangay', 'barangay', '2026-q3', true),
  ('1381100089', '1381100000', 'Barangay 89', 'barangay', 'barangay', '2026-q3', true),
  ('1381100090', '1381100000', 'Barangay 90', 'barangay', 'barangay', '2026-q3', true),
  ('1381100091', '1381100000', 'Barangay 91', 'barangay', 'barangay', '2026-q3', true),
  ('1381100092', '1381100000', 'Barangay 92', 'barangay', 'barangay', '2026-q3', true),
  ('1381100093', '1381100000', 'Barangay 93', 'barangay', 'barangay', '2026-q3', true),
  ('1381100094', '1381100000', 'Barangay 94', 'barangay', 'barangay', '2026-q3', true),
  ('1381100095', '1381100000', 'Barangay 95', 'barangay', 'barangay', '2026-q3', true),
  ('1381100096', '1381100000', 'Barangay 96', 'barangay', 'barangay', '2026-q3', true),
  ('1381100097', '1381100000', 'Barangay 97', 'barangay', 'barangay', '2026-q3', true),
  ('1381100098', '1381100000', 'Barangay 98', 'barangay', 'barangay', '2026-q3', true),
  ('1381100099', '1381100000', 'Barangay 99', 'barangay', 'barangay', '2026-q3', true),
  ('1381100100', '1381100000', 'Barangay 100', 'barangay', 'barangay', '2026-q3', true),
  ('1381100101', '1381100000', 'Barangay 101', 'barangay', 'barangay', '2026-q3', true),
  ('1381100102', '1381100000', 'Barangay 102', 'barangay', 'barangay', '2026-q3', true),
  ('1381100103', '1381100000', 'Barangay 103', 'barangay', 'barangay', '2026-q3', true),
  ('1381100104', '1381100000', 'Barangay 104', 'barangay', 'barangay', '2026-q3', true),
  ('1381100105', '1381100000', 'Barangay 105', 'barangay', 'barangay', '2026-q3', true),
  ('1381100106', '1381100000', 'Barangay 106', 'barangay', 'barangay', '2026-q3', true),
  ('1381100107', '1381100000', 'Barangay 107', 'barangay', 'barangay', '2026-q3', true),
  ('1381100108', '1381100000', 'Barangay 108', 'barangay', 'barangay', '2026-q3', true),
  ('1381100109', '1381100000', 'Barangay 109', 'barangay', 'barangay', '2026-q3', true),
  ('1381100110', '1381100000', 'Barangay 110', 'barangay', 'barangay', '2026-q3', true),
  ('1381100111', '1381100000', 'Barangay 111', 'barangay', 'barangay', '2026-q3', true),
  ('1381100112', '1381100000', 'Barangay 112', 'barangay', 'barangay', '2026-q3', true),
  ('1381100113', '1381100000', 'Barangay 113', 'barangay', 'barangay', '2026-q3', true),
  ('1381100114', '1381100000', 'Barangay 114', 'barangay', 'barangay', '2026-q3', true),
  ('1381100115', '1381100000', 'Barangay 115', 'barangay', 'barangay', '2026-q3', true),
  ('1381100116', '1381100000', 'Barangay 116', 'barangay', 'barangay', '2026-q3', true),
  ('1381100117', '1381100000', 'Barangay 117', 'barangay', 'barangay', '2026-q3', true),
  ('1381100118', '1381100000', 'Barangay 118', 'barangay', 'barangay', '2026-q3', true),
  ('1381100119', '1381100000', 'Barangay 119', 'barangay', 'barangay', '2026-q3', true),
  ('1381100120', '1381100000', 'Barangay 120', 'barangay', 'barangay', '2026-q3', true),
  ('1381100121', '1381100000', 'Barangay 121', 'barangay', 'barangay', '2026-q3', true),
  ('1381100122', '1381100000', 'Barangay 122', 'barangay', 'barangay', '2026-q3', true),
  ('1381100123', '1381100000', 'Barangay 123', 'barangay', 'barangay', '2026-q3', true),
  ('1381100124', '1381100000', 'Barangay 124', 'barangay', 'barangay', '2026-q3', true),
  ('1381100125', '1381100000', 'Barangay 125', 'barangay', 'barangay', '2026-q3', true),
  ('1381100126', '1381100000', 'Barangay 126', 'barangay', 'barangay', '2026-q3', true),
  ('1381100127', '1381100000', 'Barangay 127', 'barangay', 'barangay', '2026-q3', true),
  ('1381100128', '1381100000', 'Barangay 128', 'barangay', 'barangay', '2026-q3', true),
  ('1381100129', '1381100000', 'Barangay 129', 'barangay', 'barangay', '2026-q3', true),
  ('1381100130', '1381100000', 'Barangay 130', 'barangay', 'barangay', '2026-q3', true),
  ('1381100131', '1381100000', 'Barangay 131', 'barangay', 'barangay', '2026-q3', true),
  ('1381100132', '1381100000', 'Barangay 132', 'barangay', 'barangay', '2026-q3', true),
  ('1381100133', '1381100000', 'Barangay 133', 'barangay', 'barangay', '2026-q3', true),
  ('1381100134', '1381100000', 'Barangay 134', 'barangay', 'barangay', '2026-q3', true),
  ('1381100135', '1381100000', 'Barangay 135', 'barangay', 'barangay', '2026-q3', true),
  ('1381100136', '1381100000', 'Barangay 136', 'barangay', 'barangay', '2026-q3', true),
  ('1381100137', '1381100000', 'Barangay 137', 'barangay', 'barangay', '2026-q3', true),
  ('1381100138', '1381100000', 'Barangay 138', 'barangay', 'barangay', '2026-q3', true),
  ('1381100139', '1381100000', 'Barangay 139', 'barangay', 'barangay', '2026-q3', true),
  ('1381100140', '1381100000', 'Barangay 140', 'barangay', 'barangay', '2026-q3', true),
  ('1381100141', '1381100000', 'Barangay 141', 'barangay', 'barangay', '2026-q3', true),
  ('1381100142', '1381100000', 'Barangay 142', 'barangay', 'barangay', '2026-q3', true),
  ('1381100143', '1381100000', 'Barangay 143', 'barangay', 'barangay', '2026-q3', true),
  ('1381100144', '1381100000', 'Barangay 144', 'barangay', 'barangay', '2026-q3', true),
  ('1381100145', '1381100000', 'Barangay 145', 'barangay', 'barangay', '2026-q3', true),
  ('1381100146', '1381100000', 'Barangay 146', 'barangay', 'barangay', '2026-q3', true),
  ('1381100147', '1381100000', 'Barangay 147', 'barangay', 'barangay', '2026-q3', true),
  ('1381100148', '1381100000', 'Barangay 148', 'barangay', 'barangay', '2026-q3', true),
  ('1381100149', '1381100000', 'Barangay 149', 'barangay', 'barangay', '2026-q3', true),
  ('1381100150', '1381100000', 'Barangay 150', 'barangay', 'barangay', '2026-q3', true),
  ('1381100151', '1381100000', 'Barangay 151', 'barangay', 'barangay', '2026-q3', true),
  ('1381100152', '1381100000', 'Barangay 152', 'barangay', 'barangay', '2026-q3', true),
  ('1381100153', '1381100000', 'Barangay 153', 'barangay', 'barangay', '2026-q3', true),
  ('1381100154', '1381100000', 'Barangay 154', 'barangay', 'barangay', '2026-q3', true),
  ('1381100155', '1381100000', 'Barangay 155', 'barangay', 'barangay', '2026-q3', true),
  ('1381100156', '1381100000', 'Barangay 156', 'barangay', 'barangay', '2026-q3', true),
  ('1381100157', '1381100000', 'Barangay 157', 'barangay', 'barangay', '2026-q3', true),
  ('1381100158', '1381100000', 'Barangay 158', 'barangay', 'barangay', '2026-q3', true),
  ('1381100159', '1381100000', 'Barangay 159', 'barangay', 'barangay', '2026-q3', true),
  ('1381100160', '1381100000', 'Barangay 160', 'barangay', 'barangay', '2026-q3', true)
on conflict (psgc_code) do update set
  parent_psgc_code = excluded.parent_psgc_code,
  name = excluded.name,
  level = excluded.level,
  location_type = excluded.location_type,
  reference_version_id = excluded.reference_version_id,
  is_active = excluded.is_active;

insert into public.psgc_locations (psgc_code, parent_psgc_code, name, level, location_type, reference_version_id, is_active)
values
  ('1381100161', '1381100000', 'Barangay 161', 'barangay', 'barangay', '2026-q3', true),
  ('1381100162', '1381100000', 'Barangay 162', 'barangay', 'barangay', '2026-q3', true),
  ('1381100163', '1381100000', 'Barangay 163', 'barangay', 'barangay', '2026-q3', true),
  ('1381100164', '1381100000', 'Barangay 164', 'barangay', 'barangay', '2026-q3', true),
  ('1381100165', '1381100000', 'Barangay 165', 'barangay', 'barangay', '2026-q3', true),
  ('1381100166', '1381100000', 'Barangay 166', 'barangay', 'barangay', '2026-q3', true),
  ('1381100167', '1381100000', 'Barangay 167', 'barangay', 'barangay', '2026-q3', true),
  ('1381100168', '1381100000', 'Barangay 168', 'barangay', 'barangay', '2026-q3', true),
  ('1381100169', '1381100000', 'Barangay 169', 'barangay', 'barangay', '2026-q3', true),
  ('1381100170', '1381100000', 'Barangay 170', 'barangay', 'barangay', '2026-q3', true),
  ('1381100171', '1381100000', 'Barangay 171', 'barangay', 'barangay', '2026-q3', true),
  ('1381100172', '1381100000', 'Barangay 172', 'barangay', 'barangay', '2026-q3', true),
  ('1381100173', '1381100000', 'Barangay 173', 'barangay', 'barangay', '2026-q3', true),
  ('1381100174', '1381100000', 'Barangay 174', 'barangay', 'barangay', '2026-q3', true),
  ('1381100175', '1381100000', 'Barangay 175', 'barangay', 'barangay', '2026-q3', true),
  ('1381100176', '1381100000', 'Barangay 176', 'barangay', 'barangay', '2026-q3', true),
  ('1381100177', '1381100000', 'Barangay 177', 'barangay', 'barangay', '2026-q3', true),
  ('1381100178', '1381100000', 'Barangay 178', 'barangay', 'barangay', '2026-q3', true),
  ('1381100179', '1381100000', 'Barangay 179', 'barangay', 'barangay', '2026-q3', true),
  ('1381100180', '1381100000', 'Barangay 180', 'barangay', 'barangay', '2026-q3', true),
  ('1381100181', '1381100000', 'Barangay 181', 'barangay', 'barangay', '2026-q3', true),
  ('1381100182', '1381100000', 'Barangay 182', 'barangay', 'barangay', '2026-q3', true),
  ('1381100183', '1381100000', 'Barangay 183', 'barangay', 'barangay', '2026-q3', true),
  ('1381100184', '1381100000', 'Barangay 184', 'barangay', 'barangay', '2026-q3', true),
  ('1381100185', '1381100000', 'Barangay 185', 'barangay', 'barangay', '2026-q3', true),
  ('1381100186', '1381100000', 'Barangay 186', 'barangay', 'barangay', '2026-q3', true),
  ('1381100187', '1381100000', 'Barangay 187', 'barangay', 'barangay', '2026-q3', true),
  ('1381100188', '1381100000', 'Barangay 188', 'barangay', 'barangay', '2026-q3', true),
  ('1381100189', '1381100000', 'Barangay 189', 'barangay', 'barangay', '2026-q3', true),
  ('1381100190', '1381100000', 'Barangay 190', 'barangay', 'barangay', '2026-q3', true),
  ('1381100191', '1381100000', 'Barangay 191', 'barangay', 'barangay', '2026-q3', true),
  ('1381100192', '1381100000', 'Barangay 192', 'barangay', 'barangay', '2026-q3', true),
  ('1381100193', '1381100000', 'Barangay 193', 'barangay', 'barangay', '2026-q3', true),
  ('1381100194', '1381100000', 'Barangay 194', 'barangay', 'barangay', '2026-q3', true),
  ('1381100195', '1381100000', 'Barangay 195', 'barangay', 'barangay', '2026-q3', true),
  ('1381100196', '1381100000', 'Barangay 196', 'barangay', 'barangay', '2026-q3', true),
  ('1381100197', '1381100000', 'Barangay 197', 'barangay', 'barangay', '2026-q3', true),
  ('1381100198', '1381100000', 'Barangay 198', 'barangay', 'barangay', '2026-q3', true),
  ('1381100199', '1381100000', 'Barangay 199', 'barangay', 'barangay', '2026-q3', true),
  ('1381100200', '1381100000', 'Barangay 200', 'barangay', 'barangay', '2026-q3', true),
  ('1381100201', '1381100000', 'Barangay 201', 'barangay', 'barangay', '2026-q3', true),
  ('1381200001', '1381200000', 'Bagong Ilog', 'barangay', 'barangay', '2026-q3', true),
  ('1381200002', '1381200000', 'Bagong Katipunan', 'barangay', 'barangay', '2026-q3', true),
  ('1381200003', '1381200000', 'Bambang', 'barangay', 'barangay', '2026-q3', true),
  ('1381200004', '1381200000', 'Buting', 'barangay', 'barangay', '2026-q3', true),
  ('1381200005', '1381200000', 'Caniogan', 'barangay', 'barangay', '2026-q3', true),
  ('1381200006', '1381200000', 'Dela Paz', 'barangay', 'barangay', '2026-q3', true),
  ('1381200007', '1381200000', 'Kalawaan', 'barangay', 'barangay', '2026-q3', true),
  ('1381200008', '1381200000', 'Kapasigan', 'barangay', 'barangay', '2026-q3', true),
  ('1381200009', '1381200000', 'Kapitolyo', 'barangay', 'barangay', '2026-q3', true),
  ('1381200010', '1381200000', 'Malinao', 'barangay', 'barangay', '2026-q3', true),
  ('1381200011', '1381200000', 'Manggahan', 'barangay', 'barangay', '2026-q3', true),
  ('1381200012', '1381200000', 'Maybunga', 'barangay', 'barangay', '2026-q3', true),
  ('1381200013', '1381200000', 'Oranbo', 'barangay', 'barangay', '2026-q3', true),
  ('1381200014', '1381200000', 'Palatiw', 'barangay', 'barangay', '2026-q3', true),
  ('1381200015', '1381200000', 'Pinagbuhatan', 'barangay', 'barangay', '2026-q3', true),
  ('1381200016', '1381200000', 'Pineda', 'barangay', 'barangay', '2026-q3', true),
  ('1381200017', '1381200000', 'Rosario', 'barangay', 'barangay', '2026-q3', true),
  ('1381200018', '1381200000', 'Sagad', 'barangay', 'barangay', '2026-q3', true),
  ('1381200019', '1381200000', 'San Antonio', 'barangay', 'barangay', '2026-q3', true),
  ('1381200020', '1381200000', 'San Joaquin', 'barangay', 'barangay', '2026-q3', true),
  ('1381200021', '1381200000', 'San Jose', 'barangay', 'barangay', '2026-q3', true),
  ('1381200022', '1381200000', 'San Miguel', 'barangay', 'barangay', '2026-q3', true),
  ('1381200023', '1381200000', 'San Nicolas', 'barangay', 'barangay', '2026-q3', true),
  ('1381200024', '1381200000', 'Santa Cruz', 'barangay', 'barangay', '2026-q3', true),
  ('1381200025', '1381200000', 'Santa Rosa', 'barangay', 'barangay', '2026-q3', true),
  ('1381200026', '1381200000', 'Santo Tomas', 'barangay', 'barangay', '2026-q3', true),
  ('1381200027', '1381200000', 'Santolan', 'barangay', 'barangay', '2026-q3', true),
  ('1381200028', '1381200000', 'Sumilang', 'barangay', 'barangay', '2026-q3', true),
  ('1381200029', '1381200000', 'Ugong', 'barangay', 'barangay', '2026-q3', true),
  ('1381200030', '1381200000', 'Santa Lucia', 'barangay', 'barangay', '2026-q3', true),
  ('1381300001', '1381300000', 'Alicia', 'barangay', 'barangay', '2026-q3', true),
  ('1381300002', '1381300000', 'Amihan', 'barangay', 'barangay', '2026-q3', true),
  ('1381300003', '1381300000', 'Apolonio Samson', 'barangay', 'barangay', '2026-q3', true),
  ('1381300004', '1381300000', 'Aurora', 'barangay', 'barangay', '2026-q3', true),
  ('1381300005', '1381300000', 'Baesa', 'barangay', 'barangay', '2026-q3', true),
  ('1381300006', '1381300000', 'Bagbag', 'barangay', 'barangay', '2026-q3', true),
  ('1381300007', '1381300000', 'Bagumbuhay', 'barangay', 'barangay', '2026-q3', true),
  ('1381300008', '1381300000', 'Bagong Lipunan Ng Crame', 'barangay', 'barangay', '2026-q3', true),
  ('1381300009', '1381300000', 'Bagong Pag-asa', 'barangay', 'barangay', '2026-q3', true),
  ('1381300010', '1381300000', 'Bagong Silangan', 'barangay', 'barangay', '2026-q3', true),
  ('1381300011', '1381300000', 'Bagumbayan', 'barangay', 'barangay', '2026-q3', true),
  ('1381300012', '1381300000', 'Bahay Toro', 'barangay', 'barangay', '2026-q3', true),
  ('1381300013', '1381300000', 'Balingasa', 'barangay', 'barangay', '2026-q3', true),
  ('1381300014', '1381300000', 'Bayanihan', 'barangay', 'barangay', '2026-q3', true),
  ('1381300015', '1381300000', 'Blue Ridge A', 'barangay', 'barangay', '2026-q3', true),
  ('1381300016', '1381300000', 'Blue Ridge B', 'barangay', 'barangay', '2026-q3', true),
  ('1381300017', '1381300000', 'Botocan', 'barangay', 'barangay', '2026-q3', true),
  ('1381300018', '1381300000', 'Bungad', 'barangay', 'barangay', '2026-q3', true),
  ('1381300019', '1381300000', 'Camp Aguinaldo', 'barangay', 'barangay', '2026-q3', true),
  ('1381300020', '1381300000', 'Central', 'barangay', 'barangay', '2026-q3', true),
  ('1381300021', '1381300000', 'Claro', 'barangay', 'barangay', '2026-q3', true),
  ('1381300022', '1381300000', 'Commonwealth', 'barangay', 'barangay', '2026-q3', true),
  ('1381300023', '1381300000', 'New Era', 'barangay', 'barangay', '2026-q3', true),
  ('1381300024', '1381300000', 'Kristong Hari', 'barangay', 'barangay', '2026-q3', true),
  ('1381300025', '1381300000', 'Culiat', 'barangay', 'barangay', '2026-q3', true),
  ('1381300026', '1381300000', 'Damar', 'barangay', 'barangay', '2026-q3', true),
  ('1381300027', '1381300000', 'Damayan', 'barangay', 'barangay', '2026-q3', true),
  ('1381300028', '1381300000', 'Damayang Lagi', 'barangay', 'barangay', '2026-q3', true),
  ('1381300029', '1381300000', 'Del Monte', 'barangay', 'barangay', '2026-q3', true),
  ('1381300030', '1381300000', 'Dioquino Zobel', 'barangay', 'barangay', '2026-q3', true),
  ('1381300031', '1381300000', 'Doña Imelda', 'barangay', 'barangay', '2026-q3', true),
  ('1381300032', '1381300000', 'Doña Josefa', 'barangay', 'barangay', '2026-q3', true),
  ('1381300033', '1381300000', 'Don Manuel', 'barangay', 'barangay', '2026-q3', true),
  ('1381300034', '1381300000', 'Duyan-duyan', 'barangay', 'barangay', '2026-q3', true),
  ('1381300035', '1381300000', 'E. Rodriguez', 'barangay', 'barangay', '2026-q3', true),
  ('1381300036', '1381300000', 'East Kamias', 'barangay', 'barangay', '2026-q3', true),
  ('1381300037', '1381300000', 'Escopa I', 'barangay', 'barangay', '2026-q3', true),
  ('1381300038', '1381300000', 'Escopa II', 'barangay', 'barangay', '2026-q3', true),
  ('1381300039', '1381300000', 'Escopa III', 'barangay', 'barangay', '2026-q3', true),
  ('1381300040', '1381300000', 'Escopa IV', 'barangay', 'barangay', '2026-q3', true),
  ('1381300041', '1381300000', 'Fairview', 'barangay', 'barangay', '2026-q3', true),
  ('1381300042', '1381300000', 'N.S. Amoranto', 'barangay', 'barangay', '2026-q3', true),
  ('1381300043', '1381300000', 'Gulod', 'barangay', 'barangay', '2026-q3', true),
  ('1381300044', '1381300000', 'Horseshoe', 'barangay', 'barangay', '2026-q3', true),
  ('1381300045', '1381300000', 'Immaculate Concepcion', 'barangay', 'barangay', '2026-q3', true),
  ('1381300046', '1381300000', 'Kaligayahan', 'barangay', 'barangay', '2026-q3', true),
  ('1381300047', '1381300000', 'Kalusugan', 'barangay', 'barangay', '2026-q3', true),
  ('1381300048', '1381300000', 'Kamuning', 'barangay', 'barangay', '2026-q3', true),
  ('1381300049', '1381300000', 'Katipunan', 'barangay', 'barangay', '2026-q3', true),
  ('1381300050', '1381300000', 'Kaunlaran', 'barangay', 'barangay', '2026-q3', true),
  ('1381300051', '1381300000', 'Krus Na Ligas', 'barangay', 'barangay', '2026-q3', true),
  ('1381300052', '1381300000', 'Laging Handa', 'barangay', 'barangay', '2026-q3', true),
  ('1381300053', '1381300000', 'Libis', 'barangay', 'barangay', '2026-q3', true),
  ('1381300054', '1381300000', 'Lourdes', 'barangay', 'barangay', '2026-q3', true),
  ('1381300055', '1381300000', 'Loyola Heights', 'barangay', 'barangay', '2026-q3', true),
  ('1381300056', '1381300000', 'Maharlika', 'barangay', 'barangay', '2026-q3', true),
  ('1381300057', '1381300000', 'Malaya', 'barangay', 'barangay', '2026-q3', true),
  ('1381300058', '1381300000', 'Manresa', 'barangay', 'barangay', '2026-q3', true),
  ('1381300059', '1381300000', 'Mangga', 'barangay', 'barangay', '2026-q3', true),
  ('1381300060', '1381300000', 'Mariana', 'barangay', 'barangay', '2026-q3', true),
  ('1381300061', '1381300000', 'Mariblo', 'barangay', 'barangay', '2026-q3', true),
  ('1381300062', '1381300000', 'Marilag', 'barangay', 'barangay', '2026-q3', true),
  ('1381300063', '1381300000', 'Masagana', 'barangay', 'barangay', '2026-q3', true),
  ('1381300064', '1381300000', 'Masambong', 'barangay', 'barangay', '2026-q3', true),
  ('1381300065', '1381300000', 'Santo Domingo', 'barangay', 'barangay', '2026-q3', true),
  ('1381300066', '1381300000', 'Matandang Balara', 'barangay', 'barangay', '2026-q3', true),
  ('1381300067', '1381300000', 'Milagrosa', 'barangay', 'barangay', '2026-q3', true),
  ('1381300068', '1381300000', 'Nagkaisang Nayon', 'barangay', 'barangay', '2026-q3', true),
  ('1381300069', '1381300000', 'Nayong Kanluran', 'barangay', 'barangay', '2026-q3', true),
  ('1381300070', '1381300000', 'Novaliches Proper', 'barangay', 'barangay', '2026-q3', true),
  ('1381300071', '1381300000', 'Obrero', 'barangay', 'barangay', '2026-q3', true),
  ('1381300072', '1381300000', 'Old Capitol Site', 'barangay', 'barangay', '2026-q3', true),
  ('1381300073', '1381300000', 'Paang Bundok', 'barangay', 'barangay', '2026-q3', true),
  ('1381300074', '1381300000', 'Pag-ibig Sa Nayon', 'barangay', 'barangay', '2026-q3', true),
  ('1381300075', '1381300000', 'Paligsahan', 'barangay', 'barangay', '2026-q3', true),
  ('1381300076', '1381300000', 'Paltok', 'barangay', 'barangay', '2026-q3', true),
  ('1381300077', '1381300000', 'Pansol', 'barangay', 'barangay', '2026-q3', true),
  ('1381300078', '1381300000', 'Paraiso', 'barangay', 'barangay', '2026-q3', true),
  ('1381300079', '1381300000', 'Pasong Putik Proper', 'barangay', 'barangay', '2026-q3', true),
  ('1381300080', '1381300000', 'Pasong Tamo', 'barangay', 'barangay', '2026-q3', true),
  ('1381300081', '1381300000', 'Phil-Am', 'barangay', 'barangay', '2026-q3', true),
  ('1381300082', '1381300000', 'Pinyahan', 'barangay', 'barangay', '2026-q3', true),
  ('1381300083', '1381300000', 'Pinagkaisahan', 'barangay', 'barangay', '2026-q3', true),
  ('1381300084', '1381300000', 'Project 6', 'barangay', 'barangay', '2026-q3', true),
  ('1381300085', '1381300000', 'Quirino 2-A', 'barangay', 'barangay', '2026-q3', true),
  ('1381300086', '1381300000', 'Quirino 2-B', 'barangay', 'barangay', '2026-q3', true),
  ('1381300087', '1381300000', 'Quirino 2-C', 'barangay', 'barangay', '2026-q3', true),
  ('1381300088', '1381300000', 'Quirino 3-A', 'barangay', 'barangay', '2026-q3', true),
  ('1381300089', '1381300000', 'Ramon Magsaysay', 'barangay', 'barangay', '2026-q3', true),
  ('1381300090', '1381300000', 'Roxas', 'barangay', 'barangay', '2026-q3', true),
  ('1381300091', '1381300000', 'Sacred Heart', 'barangay', 'barangay', '2026-q3', true),
  ('1381300092', '1381300000', 'Saint Ignatius', 'barangay', 'barangay', '2026-q3', true),
  ('1381300093', '1381300000', 'Saint Peter', 'barangay', 'barangay', '2026-q3', true),
  ('1381300094', '1381300000', 'Salvacion', 'barangay', 'barangay', '2026-q3', true),
  ('1381300095', '1381300000', 'San Agustin', 'barangay', 'barangay', '2026-q3', true),
  ('1381300096', '1381300000', 'San Antonio', 'barangay', 'barangay', '2026-q3', true),
  ('1381300097', '1381300000', 'San Bartolome', 'barangay', 'barangay', '2026-q3', true),
  ('1381300098', '1381300000', 'San Isidro', 'barangay', 'barangay', '2026-q3', true),
  ('1381300099', '1381300000', 'San Isidro Labrador', 'barangay', 'barangay', '2026-q3', true),
  ('1381300100', '1381300000', 'San Jose', 'barangay', 'barangay', '2026-q3', true),
  ('1381300101', '1381300000', 'San Martin De Porres', 'barangay', 'barangay', '2026-q3', true),
  ('1381300102', '1381300000', 'San Roque', 'barangay', 'barangay', '2026-q3', true),
  ('1381300103', '1381300000', 'San Vicente', 'barangay', 'barangay', '2026-q3', true),
  ('1381300104', '1381300000', 'Santa Cruz', 'barangay', 'barangay', '2026-q3', true),
  ('1381300105', '1381300000', 'Santa Lucia', 'barangay', 'barangay', '2026-q3', true),
  ('1381300106', '1381300000', 'Santa Monica', 'barangay', 'barangay', '2026-q3', true),
  ('1381300107', '1381300000', 'Santa Teresita', 'barangay', 'barangay', '2026-q3', true),
  ('1381300108', '1381300000', 'Santo Cristo', 'barangay', 'barangay', '2026-q3', true),
  ('1381300109', '1381300000', 'Santo Niño', 'barangay', 'barangay', '2026-q3', true),
  ('1381300110', '1381300000', 'Santol', 'barangay', 'barangay', '2026-q3', true),
  ('1381300111', '1381300000', 'Sauyo', 'barangay', 'barangay', '2026-q3', true),
  ('1381300112', '1381300000', 'Sienna', 'barangay', 'barangay', '2026-q3', true),
  ('1381300113', '1381300000', 'Sikatuna Village', 'barangay', 'barangay', '2026-q3', true),
  ('1381300114', '1381300000', 'Silangan', 'barangay', 'barangay', '2026-q3', true),
  ('1381300115', '1381300000', 'Socorro', 'barangay', 'barangay', '2026-q3', true),
  ('1381300116', '1381300000', 'South Triangle', 'barangay', 'barangay', '2026-q3', true),
  ('1381300117', '1381300000', 'Tagumpay', 'barangay', 'barangay', '2026-q3', true),
  ('1381300118', '1381300000', 'Talayan', 'barangay', 'barangay', '2026-q3', true),
  ('1381300119', '1381300000', 'Talipapa', 'barangay', 'barangay', '2026-q3', true),
  ('1381300120', '1381300000', 'Tandang Sora', 'barangay', 'barangay', '2026-q3', true),
  ('1381300121', '1381300000', 'Tatalon', 'barangay', 'barangay', '2026-q3', true),
  ('1381300122', '1381300000', 'Teachers Village East', 'barangay', 'barangay', '2026-q3', true),
  ('1381300123', '1381300000', 'Teachers Village West', 'barangay', 'barangay', '2026-q3', true),
  ('1381300124', '1381300000', 'U.P. Campus', 'barangay', 'barangay', '2026-q3', true),
  ('1381300125', '1381300000', 'U.P. Village', 'barangay', 'barangay', '2026-q3', true),
  ('1381300126', '1381300000', 'Ugong Norte', 'barangay', 'barangay', '2026-q3', true),
  ('1381300127', '1381300000', 'Unang Sigaw', 'barangay', 'barangay', '2026-q3', true),
  ('1381300128', '1381300000', 'Valencia', 'barangay', 'barangay', '2026-q3', true),
  ('1381300129', '1381300000', 'Vasra', 'barangay', 'barangay', '2026-q3', true)
on conflict (psgc_code) do update set
  parent_psgc_code = excluded.parent_psgc_code,
  name = excluded.name,
  level = excluded.level,
  location_type = excluded.location_type,
  reference_version_id = excluded.reference_version_id,
  is_active = excluded.is_active;

insert into public.psgc_locations (psgc_code, parent_psgc_code, name, level, location_type, reference_version_id, is_active)
values
  ('1381300130', '1381300000', 'Veterans Village', 'barangay', 'barangay', '2026-q3', true),
  ('1381300131', '1381300000', 'Villa Maria Clara', 'barangay', 'barangay', '2026-q3', true),
  ('1381300132', '1381300000', 'West Kamias', 'barangay', 'barangay', '2026-q3', true),
  ('1381300133', '1381300000', 'West Triangle', 'barangay', 'barangay', '2026-q3', true),
  ('1381300134', '1381300000', 'White Plains', 'barangay', 'barangay', '2026-q3', true),
  ('1381300135', '1381300000', 'Balong Bato', 'barangay', 'barangay', '2026-q3', true),
  ('1381300136', '1381300000', 'Capri', 'barangay', 'barangay', '2026-q3', true),
  ('1381300137', '1381300000', 'Sangandaan', 'barangay', 'barangay', '2026-q3', true),
  ('1381300138', '1381300000', 'Payatas', 'barangay', 'barangay', '2026-q3', true),
  ('1381300139', '1381300000', 'Batasan Hills', 'barangay', 'barangay', '2026-q3', true),
  ('1381300140', '1381300000', 'Holy Spirit', 'barangay', 'barangay', '2026-q3', true),
  ('1381300141', '1381300000', 'Greater Lagro', 'barangay', 'barangay', '2026-q3', true),
  ('1381300142', '1381300000', 'North Fairview', 'barangay', 'barangay', '2026-q3', true),
  ('1381400001', '1381400000', 'Addition Hills', 'barangay', 'barangay', '2026-q3', true),
  ('1381400002', '1381400000', 'Balong-Bato', 'barangay', 'barangay', '2026-q3', true),
  ('1381400003', '1381400000', 'Batis', 'barangay', 'barangay', '2026-q3', true),
  ('1381400004', '1381400000', 'Corazon De Jesus', 'barangay', 'barangay', '2026-q3', true),
  ('1381400005', '1381400000', 'Ermitaño', 'barangay', 'barangay', '2026-q3', true),
  ('1381400006', '1381400000', 'Halo-halo', 'barangay', 'barangay', '2026-q3', true),
  ('1381400007', '1381400000', 'Isabelita', 'barangay', 'barangay', '2026-q3', true),
  ('1381400008', '1381400000', 'Kabayanan', 'barangay', 'barangay', '2026-q3', true),
  ('1381400009', '1381400000', 'Little Baguio', 'barangay', 'barangay', '2026-q3', true),
  ('1381400010', '1381400000', 'Maytunas', 'barangay', 'barangay', '2026-q3', true),
  ('1381400011', '1381400000', 'Onse', 'barangay', 'barangay', '2026-q3', true),
  ('1381400012', '1381400000', 'Pasadeña', 'barangay', 'barangay', '2026-q3', true),
  ('1381400013', '1381400000', 'Pedro Cruz', 'barangay', 'barangay', '2026-q3', true),
  ('1381400014', '1381400000', 'Progreso', 'barangay', 'barangay', '2026-q3', true),
  ('1381400015', '1381400000', 'Rivera', 'barangay', 'barangay', '2026-q3', true),
  ('1381400016', '1381400000', 'Salapan', 'barangay', 'barangay', '2026-q3', true),
  ('1381400017', '1381400000', 'San Perfecto', 'barangay', 'barangay', '2026-q3', true),
  ('1381400018', '1381400000', 'Santa Lucia', 'barangay', 'barangay', '2026-q3', true),
  ('1381400019', '1381400000', 'Tibagan', 'barangay', 'barangay', '2026-q3', true),
  ('1381400020', '1381400000', 'West Crame', 'barangay', 'barangay', '2026-q3', true),
  ('1381400021', '1381400000', 'Greenhills', 'barangay', 'barangay', '2026-q3', true),
  ('1381500001', '1381500000', 'Tanyag', 'barangay', 'barangay', '2026-q3', true),
  ('1381500002', '1381500000', 'Bagumbayan', 'barangay', 'barangay', '2026-q3', true),
  ('1381500003', '1381500000', 'Bambang', 'barangay', 'barangay', '2026-q3', true),
  ('1381500004', '1381500000', 'Calzada', 'barangay', 'barangay', '2026-q3', true),
  ('1381500005', '1381500000', 'Hagonoy', 'barangay', 'barangay', '2026-q3', true),
  ('1381500006', '1381500000', 'Ibayo-Tipas', 'barangay', 'barangay', '2026-q3', true),
  ('1381500007', '1381500000', 'Ligid-Tipas', 'barangay', 'barangay', '2026-q3', true),
  ('1381500008', '1381500000', 'Lower Bicutan', 'barangay', 'barangay', '2026-q3', true),
  ('1381500009', '1381500000', 'Maharlika Village', 'barangay', 'barangay', '2026-q3', true),
  ('1381500010', '1381500000', 'Napindan', 'barangay', 'barangay', '2026-q3', true),
  ('1381500011', '1381500000', 'Palingon', 'barangay', 'barangay', '2026-q3', true),
  ('1381500012', '1381500000', 'Santa Ana', 'barangay', 'barangay', '2026-q3', true),
  ('1381500013', '1381500000', 'Central Signal Village', 'barangay', 'barangay', '2026-q3', true),
  ('1381500014', '1381500000', 'Tuktukan', 'barangay', 'barangay', '2026-q3', true),
  ('1381500015', '1381500000', 'Upper Bicutan', 'barangay', 'barangay', '2026-q3', true),
  ('1381500016', '1381500000', 'Ususan', 'barangay', 'barangay', '2026-q3', true),
  ('1381500017', '1381500000', 'Wawa', 'barangay', 'barangay', '2026-q3', true),
  ('1381500018', '1381500000', 'Western Bicutan', 'barangay', 'barangay', '2026-q3', true),
  ('1381500019', '1381500000', 'Central Bicutan', 'barangay', 'barangay', '2026-q3', true),
  ('1381500020', '1381500000', 'Fort Bonifacio', 'barangay', 'barangay', '2026-q3', true),
  ('1381500021', '1381500000', 'Katuparan', 'barangay', 'barangay', '2026-q3', true),
  ('1381500022', '1381500000', 'New Lower Bicutan', 'barangay', 'barangay', '2026-q3', true),
  ('1381500023', '1381500000', 'North Daang Hari', 'barangay', 'barangay', '2026-q3', true),
  ('1381500024', '1381500000', 'North Signal Village', 'barangay', 'barangay', '2026-q3', true),
  ('1381500025', '1381500000', 'Pinagsama', 'barangay', 'barangay', '2026-q3', true),
  ('1381500026', '1381500000', 'San Miguel', 'barangay', 'barangay', '2026-q3', true),
  ('1381500027', '1381500000', 'South Daang Hari', 'barangay', 'barangay', '2026-q3', true),
  ('1381500028', '1381500000', 'South Signal Village', 'barangay', 'barangay', '2026-q3', true),
  ('1381500029', '1381500000', 'Cembo', 'barangay', 'barangay', '2026-q3', true),
  ('1381500030', '1381500000', 'Comembo', 'barangay', 'barangay', '2026-q3', true),
  ('1381500031', '1381500000', 'East Rembo', 'barangay', 'barangay', '2026-q3', true),
  ('1381500032', '1381500000', 'Pembo', 'barangay', 'barangay', '2026-q3', true),
  ('1381500033', '1381500000', 'Pitogo', 'barangay', 'barangay', '2026-q3', true),
  ('1381500034', '1381500000', 'Post Proper Northside', 'barangay', 'barangay', '2026-q3', true),
  ('1381500035', '1381500000', 'Post Proper Southside', 'barangay', 'barangay', '2026-q3', true),
  ('1381500036', '1381500000', 'Rizal', 'barangay', 'barangay', '2026-q3', true),
  ('1381500037', '1381500000', 'South Cembo', 'barangay', 'barangay', '2026-q3', true),
  ('1381500038', '1381500000', 'West Rembo', 'barangay', 'barangay', '2026-q3', true),
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
  ('1381600011', '1381600000', 'Gen. T. De Leon', 'barangay', 'barangay', '2026-q3', true),
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
  ('1381600023', '1381600000', 'Paso De Blas', 'barangay', 'barangay', '2026-q3', true),
  ('1381600024', '1381600000', 'Pasolo', 'barangay', 'barangay', '2026-q3', true),
  ('1381600025', '1381600000', 'Poblacion', 'barangay', 'barangay', '2026-q3', true),
  ('1381600026', '1381600000', 'Pulo', 'barangay', 'barangay', '2026-q3', true),
  ('1381600027', '1381600000', 'Punturin', 'barangay', 'barangay', '2026-q3', true),
  ('1381600028', '1381600000', 'Rincon', 'barangay', 'barangay', '2026-q3', true),
  ('1381600029', '1381600000', 'Tagalag', 'barangay', 'barangay', '2026-q3', true),
  ('1381600030', '1381600000', 'Ugong', 'barangay', 'barangay', '2026-q3', true),
  ('1381600031', '1381600000', 'Viente Reales', 'barangay', 'barangay', '2026-q3', true),
  ('1381600032', '1381600000', 'Wawang Pulo', 'barangay', 'barangay', '2026-q3', true),
  ('1381600033', '1381600000', 'Canumay East', 'barangay', 'barangay', '2026-q3', true),
  ('1381701001', '1381700000', 'Aguho', 'barangay', 'barangay', '2026-q3', true),
  ('1381701002', '1381700000', 'Magtanggol', 'barangay', 'barangay', '2026-q3', true),
  ('1381701003', '1381700000', 'Martires Del 96', 'barangay', 'barangay', '2026-q3', true),
  ('1381701004', '1381700000', 'Poblacion', 'barangay', 'barangay', '2026-q3', true),
  ('1381701005', '1381700000', 'San Pedro', 'barangay', 'barangay', '2026-q3', true),
  ('1381701006', '1381700000', 'San Roque', 'barangay', 'barangay', '2026-q3', true),
  ('1381701007', '1381700000', 'Santa Ana', 'barangay', 'barangay', '2026-q3', true),
  ('1381701008', '1381700000', 'Santo Rosario-Kanluran', 'barangay', 'barangay', '2026-q3', true),
  ('1381701009', '1381700000', 'Santo Rosario-Silangan', 'barangay', 'barangay', '2026-q3', true),
  ('1381701010', '1381700000', 'Tabacalera', 'barangay', 'barangay', '2026-q3', true)
on conflict (psgc_code) do update set
  parent_psgc_code = excluded.parent_psgc_code,
  name = excluded.name,
  level = excluded.level,
  location_type = excluded.location_type,
  reference_version_id = excluded.reference_version_id,
  is_active = excluded.is_active;

-- ------------------------------------------------------------------------------
-- 4. Reinsert NCR Postal Code References
-- ------------------------------------------------------------------------------

insert into public.postal_code_reference (
  postal_code, region_name, province_name, locality_name, psgc_locality_code, barangay_psgc_code,
  mapping_type, mapping_status, source_name, source_url, source_version, is_active
)
values
  ('1008', 'National Capital Region (NCR)', null, 'City of Manila', '1380600000', '1380606014', 'exact_barangay', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1016', 'National Capital Region (NCR)', null, 'City of Manila', '1380600000', '1380606193', 'exact_barangay', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1400', 'National Capital Region (NCR)', null, 'City of Caloocan', '1380100000', null, 'unique_city', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1740', 'National Capital Region (NCR)', null, 'City of Las Piñas', '1380200000', null, 'unique_city', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1200', 'National Capital Region (NCR)', null, 'City of Makati', '1380300000', null, 'unique_city', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1470', 'National Capital Region (NCR)', null, 'City of Malabon', '1380400000', null, 'unique_city', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1550', 'National Capital Region (NCR)', null, 'City of Mandaluyong', '1380500000', null, 'unique_city', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1800', 'National Capital Region (NCR)', null, 'City of Marikina', '1380700000', null, 'unique_city', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1770', 'National Capital Region (NCR)', null, 'City of Muntinlupa', '1380800000', null, 'unique_city', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1485', 'National Capital Region (NCR)', null, 'City of Navotas', '1380900000', null, 'unique_city', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1700', 'National Capital Region (NCR)', null, 'City of Parañaque', '1381000000', null, 'unique_city', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1300', 'National Capital Region (NCR)', null, 'Pasay City', '1381100000', null, 'unique_city', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1600', 'National Capital Region (NCR)', null, 'City of Pasig', '1381200000', null, 'unique_city', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1100', 'National Capital Region (NCR)', null, 'Quezon City', '1381300000', null, 'unique_city', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1500', 'National Capital Region (NCR)', null, 'City of San Juan', '1381400000', null, 'unique_city', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1630', 'National Capital Region (NCR)', null, 'City of Taguig', '1381500000', null, 'unique_city', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1443', 'National Capital Region (NCR)', null, 'City of Valenzuela', '1381600000', '1381600008', 'exact_barangay', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1444', 'National Capital Region (NCR)', null, 'City of Valenzuela', '1381600000', '1381600017', 'exact_barangay', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1448', 'National Capital Region (NCR)', null, 'City of Valenzuela', '1381600000', '1381600016', 'exact_barangay', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1620', 'National Capital Region (NCR)', null, 'Municipality of Pateros', '1381700000', null, 'unique_city', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true);

-- ------------------------------------------------------------------------------
-- 5. Re-declare api.create_specific_person_visit_request
--    Unconditionally requires office approval for specific person requests.
-- ------------------------------------------------------------------------------

create or replace function api.create_specific_person_visit_request(
  requested_actor_id uuid,
  requested_request_id uuid,
  requested_office_id uuid,
  requested_personnel_id uuid default null,
  requested_first_name text default null,
  requested_middle_name text default null,
  requested_last_name text default null,
  requested_contact_number text default null,
  requested_email text default null,
  requested_purpose text default null,
  requested_visit_date date default null,
  requested_arrival_mode text default 'no_vehicle',
  requested_vehicle_details jsonb default null,
  requested_address_details jsonb default null,
  requested_photo_intent_id uuid default null,
  requested_photo_bytes integer default null,
  requested_photo_sha256 text default null,
  requested_id_intent_id uuid default null,
  requested_id_bytes integer default null,
  requested_id_sha256 text default null,
  requested_vehicle_photo_intent_id uuid default null,
  requested_vehicle_photo_bytes integer default null,
  requested_vehicle_photo_sha256 text default null,
  requested_registration_mode text default 'new',
  requested_returning_profile_id uuid default null,
  requested_returning_match_token_digest text default null,
  requested_identity_verification_id uuid default null,
  requested_returning_attempt_id uuid default null,
  requested_person_name text default null,
  requested_tracking_token_digest text default null,
  requested_tracking_token_expires_at timestamptz default null,
  requested_encrypted_tracking_token text default null,
  requested_visit_type text default 'specific_person',
  requested_source public.pass_source default 'portal',
  requested_pass_token_digest text default null,
  requested_expected_gate text default null
)
returns table (
  visit_id uuid,
  request_id uuid,
  approval_status public.office_approval_status,
  attendance_status public.office_attendance_status,
  encrypted_tracking_token text,
  pass_id uuid,
  public_reference uuid,
  valid_from timestamptz,
  valid_until timestamptz,
  decision_source text,
  office_requires_approval_snapshot boolean
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  target_office public.offices%rowtype;
  office_sched_status text;
  office_sched_reason text;
  target_personnel public.office_personnel%rowtype;
  settings public.app_settings%rowtype;
  new_visit_id uuid;
  existing_visit public.office_visits%rowtype;
  photo_intent public.upload_intents%rowtype;
  id_intent public.upload_intents%rowtype;
  vehicle_photo_intent public.upload_intents%rowtype;
  verification_record public.portal_identity_verification_attempts%rowtype;
  returning_attempt_record public.returning_identity_attempts%rowtype;
  returning_profile_record public.returning_visitor_profiles%rowtype;
  v_bound_profile_id uuid := null;
  v_bound_verification_id uuid := null;
  v_bound_returning_id uuid := null;
  v_plate_key text;
  v_manila_today date;
  v_max_date date;
  target_closure_title text;
  v_effective_person_name text;
  v_existing_encrypted_token text := null;
  v_full_name text;
  v_expected_gate text;
  v_normalized_email text;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'service role required';
  end if;

  if requested_visit_type not in ('general', 'specific_person') then
    raise exception using errcode = '22023', message = 'invalid_visit_type';
  end if;

  if requested_source not in ('portal'::public.pass_source, 'kiosk'::public.pass_source) then
    raise exception using errcode = '22023', message = 'unsupported_source';
  end if;

  if requested_source = 'portal'::public.pass_source then
    if not exists (
      select 1 from auth.users u
      where u.id = requested_actor_id and coalesce(u.is_anonymous, false) = true
    ) or exists (select 1 from public.staff_profiles where user_id = requested_actor_id)
      or exists (select 1 from public.devices where user_id = requested_actor_id) then
      raise exception using errcode = '42501', message = 'anonymous visitor identity required';
    end if;
  else
    if not exists (
      select 1 from public.devices d
      where d.user_id = requested_actor_id
        and d.type = 'kiosk'::public.device_type
        and d.status = 'active'::public.device_status
    ) then
      raise exception using errcode = '42501', message = 'active_kiosk_identity_required';
    end if;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(requested_request_id::text, 0));

  select * into existing_visit from public.office_visits
  where request_id = requested_request_id;
  if found then
    select outbox.encrypted_token_payload into v_existing_encrypted_token
    from public.office_visit_email_outbox outbox
    where outbox.office_visit_id = existing_visit.id and outbox.email_type = 'tracking_ack'
    order by outbox.created_at desc limit 1;

    return query select
      existing_visit.id,
      existing_visit.request_id,
      existing_visit.approval_status,
      existing_visit.attendance_status,
      coalesce(v_existing_encrypted_token, requested_encrypted_tracking_token),
      existing_visit.pass_id,
      null::uuid,
      null::timestamptz,
      null::timestamptz,
      existing_visit.decision_source,
      true;
    return;
  end if;

  select * into target_office from public.offices
  where id = requested_office_id and active and publication_status = 'published' and archived_at is null;
  if not found then
    raise exception using errcode = '22023', message = 'office_not_found_or_unpublished';
  end if;

  if requested_personnel_id is not null then
    select * into target_personnel from public.office_personnel
    where id = requested_personnel_id and office_id = requested_office_id and active;
    if not found then
      raise exception using errcode = '22023', message = 'personnel_not_found';
    end if;
    v_effective_person_name := coalesce(nullif(btrim(requested_person_name), ''), target_personnel.name);
  else
    v_effective_person_name := nullif(btrim(requested_person_name), '');
  end if;

  select * into settings from public.app_settings order by updated_at desc limit 1;
  v_manila_today := (timezone('Asia/Manila', now()))::date;
  v_max_date := v_manila_today + make_interval(days => coalesce(settings.max_advance_booking_days, 14));

  if requested_visit_date is null or requested_visit_date < v_manila_today or requested_visit_date > v_max_date then
    raise exception using errcode = '22023', message = 'invalid_visit_date';
  end if;

  select title into target_closure_title from public.campus_closures
  where requested_visit_date between start_date and end_date limit 1;
  if target_closure_title is not null then
    raise exception using errcode = '22023', message = 'campus_closed_on_date';
  end if;

  select status, reason into office_sched_status, office_sched_reason
  from public.office_calendar_schedules
  where office_id = requested_office_id and schedule_date = requested_visit_date;
  if office_sched_status is not null and office_sched_status in ('closed', 'maintenance', 'holiday') then
    raise exception using errcode = '22023', message = 'office_closed_on_date';
  end if;

  if requested_first_name is null or char_length(btrim(requested_first_name)) = 0 then
    raise exception using errcode = '22023', message = 'first_name_required';
  end if;
  if requested_last_name is null or char_length(btrim(requested_last_name)) = 0 then
    raise exception using errcode = '22023', message = 'last_name_required';
  end if;
  if requested_contact_number is null or char_length(btrim(requested_contact_number)) < 7 then
    raise exception using errcode = '22023', message = 'contact_number_required';
  end if;

  -- For specific_person, email is mandatory
  if requested_visit_type = 'specific_person' and (requested_email is null or char_length(btrim(requested_email)) = 0) then
    raise exception using errcode = '22023', message = 'email_required_for_specific_person';
  end if;
  v_normalized_email := nullif(lower(btrim(requested_email)), '');

  if requested_purpose is null or char_length(btrim(requested_purpose)) < 3 then
    raise exception using errcode = '22023', message = 'purpose_too_short';
  end if;

  if requested_arrival_mode = 'vehicle' then
    if requested_vehicle_details is null or (requested_vehicle_details->>'plateNumber') is null then
      raise exception using errcode = '22023', message = 'vehicle_details_required';
    end if;
    v_plate_key := upper(regexp_replace(requested_vehicle_details->>'plateNumber', '[^a-zA-Z0-9]', '', 'g'));
    if char_length(v_plate_key) < 4 then
      raise exception using errcode = '22023', message = 'invalid_plate_number';
    end if;
  end if;

  if requested_registration_mode = 'new' then
    if requested_photo_intent_id is null or requested_id_intent_id is null then
      raise exception using errcode = '22023', message = 'intents_required_for_new_registration';
    end if;

    select * into photo_intent from public.upload_intents
    where id = requested_photo_intent_id and actor_id = requested_actor_id
      and kind = 'photo'::public.upload_intent_kind and status = 'pending'::public.upload_intent_status;
    if not found or photo_intent.expires_at < now() or photo_intent.sha256_hex <> requested_photo_sha256
       or (requested_photo_bytes is not null and requested_photo_bytes not between 1 and photo_intent.max_bytes) then
      raise exception using errcode = '22023', message = 'invalid_photo_upload_intent';
    end if;

    select * into id_intent from public.upload_intents
    where id = requested_id_intent_id and actor_id = requested_actor_id
      and kind = 'id'::public.upload_intent_kind and status = 'pending'::public.upload_intent_status;
    if not found or id_intent.expires_at < now() or id_intent.sha256_hex <> requested_id_sha256
       or (requested_id_bytes is not null and requested_id_bytes not between 1 and id_intent.max_bytes) then
      raise exception using errcode = '22023', message = 'invalid_id_upload_intent';
    end if;

    update public.upload_intents set held_until = greatest(expires_at, now() + interval '14 days')
    where id in (photo_intent.id, id_intent.id);

  elsif requested_registration_mode = 'returning' then
    if requested_returning_profile_id is null or requested_identity_verification_id is null then
      raise exception using errcode = '22023', message = 'returning_verification_linkage_required';
    end if;

    select * into returning_profile_record from public.returning_visitor_profiles
    where id = requested_returning_profile_id and status = 'active';
    if not found then
      raise exception using errcode = '22023', message = 'invalid_returning_profile';
    end if;

    select * into verification_record from public.portal_identity_verification_attempts
    where id = requested_identity_verification_id and visitor_actor_id = requested_actor_id
      and returning_profile_id = requested_returning_profile_id and decision = 'matched';
    if not found or verification_record.expires_at < now() then
      raise exception using errcode = '22023', message = 'unmatched_or_expired_portal_verification';
    end if;

    if requested_returning_attempt_id is not null then
      select * into returning_attempt_record from public.returning_identity_attempts
      where id = requested_returning_attempt_id and returning_profile_id = requested_returning_profile_id
        and verified_at is not null;
      if not found then
        raise exception using errcode = '22023', message = 'unverified_returning_attempt';
      end if;
      v_bound_returning_id := returning_attempt_record.id;
    end if;

    v_bound_profile_id := returning_profile_record.id;
    v_bound_verification_id := verification_record.id;
  else
    raise exception using errcode = '22023', message = 'invalid_registration_mode';
  end if;

  if requested_arrival_mode = 'vehicle' and requested_vehicle_photo_intent_id is not null then
    select * into vehicle_photo_intent from public.upload_intents
    where id = requested_vehicle_photo_intent_id and actor_id = requested_actor_id
      and kind = 'vehicle_photo'::public.upload_intent_kind and status = 'pending'::public.upload_intent_status;
    if not found or vehicle_photo_intent.expires_at < now() or vehicle_photo_intent.sha256_hex <> requested_vehicle_photo_sha256
       or (requested_vehicle_photo_bytes is not null and requested_vehicle_photo_bytes not between 1 and vehicle_photo_intent.max_bytes) then
      raise exception using errcode = '22023', message = 'invalid_vehicle_photo_upload_intent';
    end if;

    update public.upload_intents set held_until = greatest(expires_at, now() + interval '14 days')
    where id = vehicle_photo_intent.id;
  end if;

  v_expected_gate := coalesce(nullif(btrim(requested_expected_gate), ''), target_office.expected_gate, 'Gate 1');
  v_full_name := btrim(concat_ws(' ', nullif(btrim(requested_first_name), ''), nullif(btrim(requested_middle_name), ''), nullif(btrim(requested_last_name), '')));

  -- Unconditionally create pending office visit request with ZERO ordinary pass
  insert into public.office_visits (
    visit_type, office_id, personnel_id, requested_person_name,
    approval_status, attendance_status,
    visitor_first_name, visitor_middle_name, visitor_last_name, visitor_display_name,
    visitor_contact_number, visitor_email, visitor_email_verified,
    visitor_actor_id, purpose, visit_date, arrival_mode,
    vehicle_details, address_details,
    photo_intent_id, photo_bytes, photo_sha256,
    id_intent_id, id_bytes, id_sha256,
    vehicle_photo_intent_id, vehicle_photo_bytes, vehicle_photo_sha256,
    registration_mode, returning_profile_id, identity_verification_id, returning_attempt_id,
    request_id, email_delivery_status,
    tracking_token_digest, tracking_token_expires_at,
    source, office_requires_approval_snapshot, expected_gate
  ) values (
    requested_visit_type, requested_office_id, requested_personnel_id, v_effective_person_name,
    'pending'::public.office_approval_status, 'pending'::public.office_attendance_status,
    btrim(requested_first_name), nullif(btrim(requested_middle_name), ''), btrim(requested_last_name), v_full_name,
    btrim(requested_contact_number), v_normalized_email, (v_normalized_email is not null),
    requested_actor_id, btrim(requested_purpose), requested_visit_date, requested_arrival_mode,
    requested_vehicle_details, requested_address_details,
    requested_photo_intent_id, requested_photo_bytes, requested_photo_sha256,
    requested_id_intent_id, requested_id_bytes, requested_id_sha256,
    requested_vehicle_photo_intent_id, requested_vehicle_photo_bytes, requested_vehicle_photo_sha256,
    requested_registration_mode, v_bound_profile_id, v_bound_verification_id, v_bound_returning_id,
    requested_request_id, case when v_normalized_email is not null then 'pending' else 'none' end,
    requested_tracking_token_digest, coalesce(requested_tracking_token_expires_at, now() + interval '30 days'),
    requested_source, true, v_expected_gate
  ) returning id into new_visit_id;

  if v_normalized_email is not null and requested_encrypted_tracking_token is not null then
    insert into public.office_visit_email_outbox (
      office_visit_id, email_type, recipient_email, encrypted_token_payload, delivery_status, idempotency_key
    ) values (
      new_visit_id, 'tracking_ack', v_normalized_email, requested_encrypted_tracking_token, 'pending',
      'tracking-ack-' || new_visit_id::text
    ) on conflict (office_visit_id, email_type) do nothing;
  end if;

  insert into public.office_visit_events (
    office_visit_id, event_type, actor_id, actor_role, metadata
  ) values (
    new_visit_id, 'requested', requested_actor_id, 'visitor',
    jsonb_build_object(
      'visit_type', requested_visit_type,
      'office_id', requested_office_id,
      'personnel_id', requested_personnel_id,
      'purpose', requested_purpose,
      'visit_date', requested_visit_date,
      'arrival_mode', requested_arrival_mode,
      'registration_mode', requested_registration_mode,
      'returning_profile_id', v_bound_profile_id,
      'source', requested_source,
      'office_requires_approval_snapshot', true
    )
  );

  return query select
    new_visit_id,
    requested_request_id,
    'pending'::public.office_approval_status,
    'pending'::public.office_attendance_status,
    requested_encrypted_tracking_token,
    null::uuid,
    null::uuid,
    null::timestamptz,
    null::timestamptz,
    null::text,
    true;
end;
$$;

revoke all on function api.create_specific_person_visit_request(
  uuid, uuid, uuid, uuid, text, text, text, text, text, text, date, text, jsonb, jsonb,
  uuid, integer, text, uuid, integer, text, uuid, integer, text, text, uuid, text, uuid, uuid,
  text, text, timestamptz, text, text, public.pass_source, text, text
) from public, anon, authenticated;

grant execute on function api.create_specific_person_visit_request(
  uuid, uuid, uuid, uuid, text, text, text, text, text, text, date, text, jsonb, jsonb,
  uuid, integer, text, uuid, integer, text, uuid, integer, text, text, uuid, text, uuid, uuid,
  text, text, timestamptz, text, text, public.pass_source, text, text
) to service_role;

-- ------------------------------------------------------------------------------
-- 6. Update api.decide_office_visit to make repeat submissions transactionally idempotent
-- ------------------------------------------------------------------------------

create or replace function api.decide_office_visit(
  requested_actor_id uuid,
  requested_visit_id uuid,
  requested_decision text,
  requested_rejection_reason text default null,
  requested_token_digest text default null,
  requested_encrypted_payload text default null,
  requested_idempotency_key text default null,
  requested_request_id uuid default gen_random_uuid()
)
returns table (
  ok boolean,
  decision text,
  pass_id uuid,
  public_reference uuid,
  valid_from timestamptz,
  valid_until timestamptz,
  message text
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  target_visit public.office_visits%rowtype;
  target_office public.offices%rowtype;
  office_sched_status text;
  office_sched_reason text;
  actor_profile public.staff_profiles%rowtype;
  settings public.app_settings%rowtype;
  new_visitor_id uuid;
  new_pass_id uuid;
  new_public_ref uuid;
  new_veh_ev_id uuid := null;
  v_from timestamptz;
  v_until timestamptz;
  v_full_name text;
  v_addr jsonb;
  v_veh jsonb;
  photo_intent public.upload_intents%rowtype;
  id_intent public.upload_intents%rowtype;
  vehicle_photo_intent public.upload_intents%rowtype;
  returning_profile_rec public.returning_visitor_profiles%rowtype;
  v_idempotency_key text;
  v_manila_today date;
  target_closure_title text;
  v_expected_gate text;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'service role required';
  end if;

  if requested_decision not in ('approved', 'rejected') then
    raise exception using errcode = '22023', message = 'invalid_decision';
  end if;

  select * into actor_profile from public.staff_profiles
  where user_id = requested_actor_id and active;
  if not found then
    raise exception using errcode = '42501', message = 'active_staff_required';
  end if;

  select * into target_visit from public.office_visits
  where id = requested_visit_id
  for update;
  if not found then
    raise exception using errcode = '22023', message = 'visit_not_found';
  end if;

  if actor_profile.role not in ('admin', 'superadmin') then
    if not exists (
      select 1 from public.office_staff_assignments a
      where a.office_id = target_visit.office_id and a.user_id = requested_actor_id
    ) then
      raise exception using errcode = '42501', message = 'unauthorized_for_this_office';
    end if;
  end if;

  -- Transactionally Idempotent: If visit has already been decided, return current authoritative decision
  if target_visit.approval_status <> 'pending'::public.office_approval_status then
    if target_visit.approval_status = 'approved'::public.office_approval_status and target_visit.pass_id is not null then
      select p.public_reference, p.valid_from, p.valid_until
      into new_public_ref, v_from, v_until
      from public.passes p where p.id = target_visit.pass_id;

      return query select true, 'approved'::text, target_visit.pass_id, new_public_ref, v_from, v_until, 'Visit already approved.'::text;
      return;
    else
      return query select true, 'rejected'::text, null::uuid, null::uuid, null::timestamptz, null::timestamptz, 'Visit already rejected.'::text;
      return;
    end if;
  end if;

  -- REJECTION FLOW
  if requested_decision = 'rejected' then
    if requested_rejection_reason is null or char_length(btrim(requested_rejection_reason)) = 0 then
      raise exception using errcode = '22023', message = 'rejection_reason_required';
    end if;

    update public.office_visits set
      approval_status = 'rejected'::public.office_approval_status,
      rejection_reason = btrim(requested_rejection_reason),
      decided_at = now(),
      decided_by = requested_actor_id,
      decision_source = 'manual_staff',
      attendance_status = 'cancelled'::public.office_attendance_status,
      updated_at = now()
    where id = target_visit.id;

    update public.upload_intents set held_until = null
    where id in (target_visit.photo_intent_id, target_visit.id_intent_id, target_visit.vehicle_photo_intent_id);

    if target_visit.visitor_email is not null then
      v_idempotency_key := coalesce(requested_idempotency_key, 'office-rejection-' || target_visit.id::text);
      insert into public.office_visit_email_outbox (
        office_visit_id, email_type, recipient_email, rejection_reason, delivery_status, idempotency_key
      ) values (
        target_visit.id, 'rejection', target_visit.visitor_email, btrim(requested_rejection_reason), 'pending', v_idempotency_key
      ) on conflict (office_visit_id, email_type) do nothing;
    end if;

    insert into public.office_visit_events (
      office_visit_id, event_type, actor_id, actor_role, metadata
    ) values (
      target_visit.id, 'rejected', requested_actor_id, actor_profile.role::text,
      jsonb_build_object(
        'reason', btrim(requested_rejection_reason),
        'decision_source', 'manual_staff',
        'office_requires_approval_snapshot', target_visit.office_requires_approval_snapshot
      )
    );

    return query select true, 'rejected'::text, null::uuid, null::uuid, null::timestamptz, null::timestamptz, 'Visit rejected.'::text;
    return;
  end if;

  -- APPROVAL FLOW
  if requested_token_digest is null or requested_token_digest !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'valid_token_digest_required';
  end if;

  select * into target_office from public.offices
  where id = target_visit.office_id and active and publication_status = 'published' and archived_at is null;
  if not found then
    raise exception using errcode = '22023', message = 'office_not_found_or_unpublished';
  end if;

  select title into target_closure_title from public.campus_closures
  where target_visit.visit_date between start_date and end_date limit 1;
  if target_closure_title is not null then
    raise exception using errcode = '22023', message = 'campus_closed_on_date';
  end if;

  select status, reason into office_sched_status, office_sched_reason
  from public.office_calendar_schedules
  where office_id = target_visit.office_id and schedule_date = target_visit.visit_date;
  if office_sched_status is not null and office_sched_status in ('closed', 'maintenance', 'holiday') then
    raise exception using errcode = '22023', message = 'office_closed_on_date';
  end if;

  select * into settings from public.app_settings order by updated_at desc limit 1;
  v_manila_today := (timezone('Asia/Manila', now()))::date;

  if target_visit.visit_date = v_manila_today then
    v_from := timezone('Asia/Manila', target_visit.visit_date::timestamp + coalesce(settings.pass_valid_from_time, '07:00:00'::time));
    v_until := timezone('Asia/Manila', target_visit.visit_date::timestamp + coalesce(settings.pass_valid_until_time, '19:00:00'::time));
  else
    v_from := timezone('Asia/Manila', target_visit.visit_date::timestamp + coalesce(settings.pass_valid_from_time, '07:00:00'::time));
    v_until := timezone('Asia/Manila', target_visit.visit_date::timestamp + coalesce(settings.pass_valid_until_time, '19:00:00'::time));
  end if;

  v_expected_gate := coalesce(target_visit.expected_gate, target_office.expected_gate, 'Gate 1');
  v_full_name := btrim(concat_ws(' ', nullif(btrim(target_visit.visitor_first_name), ''), nullif(btrim(target_visit.visitor_middle_name), ''), nullif(btrim(target_visit.visitor_last_name), '')));
  v_addr := target_visit.address_details;
  v_veh := target_visit.vehicle_details;

  if target_visit.registration_mode = 'returning' then
    select * into returning_profile_rec from public.returning_visitor_profiles
    where id = target_visit.returning_profile_id;
    if not found then
      raise exception using errcode = '22023', message = 'returning_profile_not_found';
    end if;

    insert into public.visitors (
      owner_id, source, full_name, contact_number, email, purpose, visit_date, consent_accepted_at,
      registration_mode, arrival_mode, returning_profile_id, returning_identity_attempt_id,
      identity_verification_id, identity_verified_at,
      psgc_region_code, psgc_province_code, psgc_city_code, psgc_barangay_code,
      psgc_region_name, psgc_province_name, psgc_city_municipality_name, psgc_barangay_name,
      home_building, home_street
    ) values (
      target_visit.visitor_actor_id, target_visit.source, v_full_name, target_visit.visitor_contact_number,
      target_visit.visitor_email, target_visit.purpose, target_visit.visit_date, now(),
      'returning', target_visit.arrival_mode, target_visit.returning_profile_id, target_visit.returning_attempt_id,
      target_visit.identity_verification_id, now(),
      v_addr->>'psgcRegionCode', v_addr->>'psgcProvinceCode', v_addr->>'psgcCityCode', v_addr->>'psgcBarangayCode',
      v_addr->>'psgcRegionName', v_addr->>'psgcProvinceName', v_addr->>'psgcCityName', v_addr->>'psgcBarangayName',
      v_addr->>'homeBuilding', v_addr->>'homeStreet'
    ) returning id into new_visitor_id;

    update public.returning_visitor_profiles set
      last_used_at = now(),
      visit_count = visit_count + 1,
      updated_at = now()
    where id = target_visit.returning_profile_id;

  else
    select * into photo_intent from public.upload_intents where id = target_visit.photo_intent_id;
    if not found then
      raise exception using errcode = '22023', message = 'photo_intent_not_found';
    end if;

    if target_visit.id_intent_id is not null then
      select * into id_intent from public.upload_intents where id = target_visit.id_intent_id;
    end if;

    if target_visit.arrival_mode = 'vehicle' and target_visit.vehicle_photo_intent_id is not null then
      select * into vehicle_photo_intent from public.upload_intents where id = target_visit.vehicle_photo_intent_id;
    end if;

    insert into public.visitors (
      owner_id, source, full_name, contact_number, email, purpose, visit_date, consent_accepted_at,
      registration_mode, arrival_mode,
      psgc_region_code, psgc_province_code, psgc_city_code, psgc_barangay_code,
      psgc_region_name, psgc_province_name, psgc_city_municipality_name, psgc_barangay_name,
      home_building, home_street
    ) values (
      target_visit.visitor_actor_id, target_visit.source, v_full_name, target_visit.visitor_contact_number,
      target_visit.visitor_email, target_visit.purpose, target_visit.visit_date, now(),
      'new', target_visit.arrival_mode,
      v_addr->>'psgcRegionCode', v_addr->>'psgcProvinceCode', v_addr->>'psgcCityCode', v_addr->>'psgcBarangayCode',
      v_addr->>'psgcRegionName', v_addr->>'psgcProvinceName', v_addr->>'psgcCityName', v_addr->>'psgcBarangayName',
      v_addr->>'homeBuilding', v_addr->>'homeStreet'
    ) returning id into new_visitor_id;

    insert into public.visitor_evidence (
      visitor_id, upload_intent_id, kind, bucket_id, object_path, content_type,
      byte_size, sha256_hex, verified_at, expires_at
    ) values (
      new_visitor_id, photo_intent.id, photo_intent.kind, photo_intent.bucket_id, photo_intent.object_path, photo_intent.content_type,
      target_visit.photo_bytes, target_visit.photo_sha256, now(),
      greatest(now() + make_interval(days => settings.image_retention_days), v_until + interval '1 day')
    );
    update public.upload_intents set status = 'claimed'::public.upload_intent_status, claimed_at = now(), visitor_id = new_visitor_id, held_until = null
    where id = photo_intent.id;

    if target_visit.id_intent_id is not null then
      insert into public.visitor_evidence (
        visitor_id, upload_intent_id, kind, bucket_id, object_path, content_type,
        byte_size, sha256_hex, verified_at, expires_at
      ) values (
        new_visitor_id, id_intent.id, id_intent.kind, id_intent.bucket_id, id_intent.object_path, id_intent.content_type,
        target_visit.id_bytes, target_visit.id_sha256, now(),
        greatest(now() + make_interval(days => settings.image_retention_days), v_until + interval '1 day')
      );
      update public.upload_intents set status = 'claimed'::public.upload_intent_status, claimed_at = now(), visitor_id = new_visitor_id, held_until = null
      where id = id_intent.id;
    end if;
  end if;

  if target_visit.arrival_mode = 'vehicle' and target_visit.vehicle_photo_intent_id is not null then
    insert into public.visitor_evidence (
      visitor_id, upload_intent_id, kind, bucket_id, object_path, content_type,
      byte_size, sha256_hex, verified_at, expires_at
    ) values (
      new_visitor_id, vehicle_photo_intent.id, vehicle_photo_intent.kind, vehicle_photo_intent.bucket_id,
      vehicle_photo_intent.object_path, vehicle_photo_intent.content_type,
      target_visit.vehicle_photo_bytes, target_visit.vehicle_photo_sha256, now(),
      greatest(now() + make_interval(days => settings.image_retention_days), v_until + interval '1 day')
    ) returning id into new_veh_ev_id;
    update public.upload_intents set status = 'claimed'::public.upload_intent_status, claimed_at = now(), visitor_id = new_visitor_id, held_until = null
    where id = vehicle_photo_intent.id;
  end if;

  new_public_ref := gen_random_uuid();
  insert into public.passes (
    visitor_id, source, status, token_digest, public_reference, valid_from, valid_until, issue_request_id, expected_gate
  ) values (
    new_visitor_id, target_visit.source, 'issued'::public.pass_status, decode(requested_token_digest, 'hex'),
    new_public_ref, v_from, v_until, target_visit.request_id, v_expected_gate
  ) returning id into new_pass_id;

  if target_visit.arrival_mode = 'vehicle' and v_veh is not null then
    insert into public.visit_vehicle_declarations (
      pass_id, visitor_id, vehicle_type, plate_number, plate_key, color, make_model, vehicle_photo_evidence_id
    ) values (
      new_pass_id, new_visitor_id, v_veh->>'vehicleType', v_veh->>'plateNumber',
      upper(regexp_replace(v_veh->>'plateNumber', '[^a-zA-Z0-9]', '', 'g')),
      v_veh->>'color', coalesce(v_veh->>'makeModel', ''), new_veh_ev_id
    );
  end if;

  update public.office_visits set
    approval_status = 'approved'::public.office_approval_status,
    attendance_status = 'awaiting_entry'::public.office_attendance_status,
    visitor_id = new_visitor_id,
    pass_id = new_pass_id,
    decided_at = now(),
    decided_by = requested_actor_id,
    decision_source = 'manual_staff',
    expected_gate = v_expected_gate,
    updated_at = now()
  where id = target_visit.id;

  if target_visit.visitor_email is not null then
    v_idempotency_key := coalesce(requested_idempotency_key, 'office-approval-' || target_visit.id::text);
    insert into public.office_visit_email_outbox (
      office_visit_id, email_type, recipient_email, encrypted_token_payload, delivery_status, idempotency_key
    ) values (
      target_visit.id, 'approval', target_visit.visitor_email, requested_encrypted_payload, 'pending', v_idempotency_key
    ) on conflict (office_visit_id, email_type) do nothing;
  end if;

  insert into public.office_visit_events (
    office_visit_id, event_type, actor_id, actor_role, metadata
  ) values (
    target_visit.id, 'approved', requested_actor_id, actor_profile.role::text,
    jsonb_build_object(
      'pass_id', new_pass_id,
      'public_reference', new_public_ref,
      'valid_from', v_from,
      'valid_until', v_until,
      'decision_source', 'manual_staff',
      'office_requires_approval_snapshot', target_visit.office_requires_approval_snapshot,
      'registration_mode', target_visit.registration_mode,
      'returning_profile_id', target_visit.returning_profile_id
    )
  );

  return query select true, 'approved'::text, new_pass_id, new_public_ref, v_from, v_until, 'Visit approved successfully.'::text;
end;
$$;

revoke all on function api.decide_office_visit(uuid, uuid, text, text, text, text, text, uuid) from public, anon, authenticated;
grant execute on function api.decide_office_visit(uuid, uuid, text, text, text, text, text, uuid) to service_role;

commit;
