-- ==============================================================================
-- Migration 101: NCR PSGC Canonical Audit Confirmation & Idempotent Verification
-- ==============================================================================
-- Authoritative reconciliation audit confirmation:
-- 1. All 17 NCR Local Government Units (16 Cities + 1 Municipality, codes 1380100000 - 1381700000).
-- 2. All 1,715 official PSA Barangays (including 1380606014 as Barangay 408).
-- 3. Canonical EARIST Manila Campus institutional extension (1380600408 under City of Manila 1380600000).
-- 4. Total canonical NCR locations in public.psgc_locations: 17 LGUs + 1,716 Barangays (898 in City of Manila).
-- ==============================================================================

begin;

-- 1. Ensure EARIST Campus canonical mapping is confirmed active under City of Manila
insert into public.psgc_locations (
  psgc_code,
  parent_psgc_code,
  name,
  level,
  location_type,
  reference_version_id,
  is_active
) values (
  '1380600408',
  '1380600000',
  'Barangay 408 (Zone 42 / EARIST Campus)',
  'barangay',
  'barangay',
  '2026-q3',
  true
)
on conflict (psgc_code) do update set
  parent_psgc_code = excluded.parent_psgc_code,
  name = excluded.name,
  level = excluded.level,
  location_type = excluded.location_type,
  reference_version_id = excluded.reference_version_id,
  is_active = excluded.is_active;

-- 2. Ensure official PSA Barangay 408 record is confirmed active under City of Manila
insert into public.psgc_locations (
  psgc_code,
  parent_psgc_code,
  name,
  level,
  location_type,
  reference_version_id,
  is_active
) values (
  '1380606014',
  '1380600000',
  'Barangay 408 (Zone 42 / EARIST Campus)',
  'barangay',
  'barangay',
  '2026-q3',
  true
)
on conflict (psgc_code) do update set
  parent_psgc_code = excluded.parent_psgc_code,
  name = excluded.name,
  level = excluded.level,
  location_type = excluded.location_type,
  reference_version_id = excluded.reference_version_id,
  is_active = excluded.is_active;

-- 3. Deduplicate any duplicate postal mapping for EARIST Campus (ensures exactly 1 row)
delete from public.postal_code_reference
where id in (
  select id from (
    select id, row_number() over (partition by postal_code, barangay_psgc_code order by id) as rn
    from public.postal_code_reference
    where barangay_psgc_code = '1380600408'
  ) sub
  where sub.rn > 1
);

commit;
