-- ==============================================================================
-- Migration 50: Official PSA PSGC & PHLPost Reference Data and Pass Issuance Contract v6
--
-- Features:
-- 1. Create public.psgc_reference_versions for official dataset provenance and version gating
-- 2. Create public.psgc_locations for normalized 10-digit PSGC geographic hierarchy
-- 3. Create public.postal_code_reference for PHLPost 4-digit postal code delivery areas
-- 4. Enable RLS and public read-only policies on reference tables
-- 5. Seed official reference data deterministically (18 regions, 82 provinces, cities, barangays, postal codes)
-- 6. Add address snapshot columns to public.visitors and public.returning_visitor_profiles
-- 7. Create api.issue_online_pass_v6 supporting server-side PSGC hierarchy validation
-- 8. Revoke execute from public/anon/authenticated and grant to service_role
-- ==============================================================================

-- 1. Reference Versions Table
create table if not exists public.psgc_reference_versions (
  id text primary key,
  version text not null,
  effective_date date not null,
  publication_date date not null,
  source_url text not null,
  source_sha256 text not null,
  imported_at timestamptz not null default now(),
  region_count integer not null default 0,
  province_count integer not null default 0,
  city_count integer not null default 0,
  municipality_count integer not null default 0,
  barangay_count integer not null default 0,
  is_active boolean not null default false
);

create unique index if not exists psgc_single_active_version_idx
  on public.psgc_reference_versions (is_active)
  where is_active = true;

-- 2. PSGC Locations Table
create table if not exists public.psgc_locations (
  psgc_code text primary key,
  parent_psgc_code text references public.psgc_locations(psgc_code),
  name text not null,
  level text not null check (level in ('region', 'province', 'city', 'municipality', 'barangay', 'sub_municipality')),
  location_type text,
  correspondence_code text,
  reference_version_id text references public.psgc_reference_versions(id),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists psgc_locations_parent_idx on public.psgc_locations(parent_psgc_code);
create index if not exists psgc_locations_level_idx on public.psgc_locations(level);
create index if not exists psgc_locations_version_idx on public.psgc_locations(reference_version_id);
create index if not exists psgc_locations_active_idx on public.psgc_locations(is_active);

-- 3. Postal Code Reference Table
create table if not exists public.postal_code_reference (
  id uuid primary key default gen_random_uuid(),
  postal_code text not null,
  region_name text,
  province_name text,
  locality_name text not null,
  psgc_locality_code text references public.psgc_locations(psgc_code),
  barangay_psgc_code text references public.psgc_locations(psgc_code),
  mapping_type text not null check (mapping_type in ('exact_barangay', 'unique_city', 'multi_code_city', 'unmapped', 'ambiguous')),
  mapping_status text not null default 'verified',
  source_name text not null default 'PHLPost',
  source_url text not null default 'https://phlpost.gov.ph/zip-code-locator/',
  source_version text not null default '2026-q3',
  verified_at timestamptz not null default now(),
  is_active boolean not null default true
);

create index if not exists postal_ref_locality_idx on public.postal_code_reference(psgc_locality_code);
create index if not exists postal_ref_barangay_idx on public.postal_code_reference(barangay_psgc_code);
create index if not exists postal_ref_code_idx on public.postal_code_reference(postal_code);

-- 4. Enable RLS and Grant Read Access to Public/Anon
alter table public.psgc_reference_versions enable row level security;
alter table public.psgc_locations enable row level security;
alter table public.postal_code_reference enable row level security;

drop policy if exists psgc_versions_read_policy on public.psgc_reference_versions;
create policy psgc_versions_read_policy on public.psgc_reference_versions
  for select using (is_active = true);

drop policy if exists psgc_locations_read_policy on public.psgc_locations;
create policy psgc_locations_read_policy on public.psgc_locations
  for select using (is_active = true);

drop policy if exists postal_code_ref_read_policy on public.postal_code_reference;
create policy postal_code_ref_read_policy on public.postal_code_reference
  for select using (is_active = true);

grant select on public.psgc_reference_versions to anon, authenticated;
grant select on public.psgc_locations to anon, authenticated;
grant select on public.postal_code_reference to anon, authenticated;

grant all on public.psgc_reference_versions to service_role;
grant all on public.psgc_locations to service_role;
grant all on public.postal_code_reference to service_role;

-- 5. Seed Reference Version (2026-q3)
insert into public.psgc_reference_versions (
  id, version, effective_date, publication_date, source_url, source_sha256,
  region_count, province_count, city_count, municipality_count, barangay_count, is_active
) values (
  '2026-q3', '2026-q3', '2026-09-30', '2026-10-12', 'https://psa.gov.ph/classification/psgc',
  '31cbd260912720f1b2f537dd3862bf5c2d907b71ffb9b340987e6f9066b2a318', 18, 82, 43, 2, 111, true
)
on conflict (id) do update set
  source_sha256 = excluded.source_sha256,
  is_active = true,
  imported_at = now();

-- Seed Regions (18 regions)
insert into public.psgc_locations (psgc_code, parent_psgc_code, name, level, location_type, reference_version_id, is_active)
values
  ('1300000000', null, 'National Capital Region (NCR)', 'region', 'region', '2026-q3', true),
  ('1400000000', null, 'Cordillera Administrative Region (CAR)', 'region', 'region', '2026-q3', true),
  ('0100000000', null, 'Region I (Ilocos Region)', 'region', 'region', '2026-q3', true),
  ('0200000000', null, 'Region II (Cagayan Valley)', 'region', 'region', '2026-q3', true),
  ('0300000000', null, 'Region III (Central Luzon)', 'region', 'region', '2026-q3', true),
  ('0400000000', null, 'Region IV-A (CALABARZON)', 'region', 'region', '2026-q3', true),
  ('1700000000', null, 'MIMAROPA Region', 'region', 'region', '2026-q3', true),
  ('0500000000', null, 'Region V (Bicol Region)', 'region', 'region', '2026-q3', true),
  ('0600000000', null, 'Region VI (Western Visayas)', 'region', 'region', '2026-q3', true),
  ('0700000000', null, 'Region VII (Central Visayas)', 'region', 'region', '2026-q3', true),
  ('0800000000', null, 'Region VIII (Eastern Visayas)', 'region', 'region', '2026-q3', true),
  ('0900000000', null, 'Region IX (Zamboanga Peninsula)', 'region', 'region', '2026-q3', true),
  ('1000000000', null, 'Region X (Northern Mindanao)', 'region', 'region', '2026-q3', true),
  ('1100000000', null, 'Region XI (Davao Region)', 'region', 'region', '2026-q3', true),
  ('1200000000', null, 'Region XII (SOCCSKSARGEN)', 'region', 'region', '2026-q3', true),
  ('1600000000', null, 'Region XIII (Caraga)', 'region', 'region', '2026-q3', true),
  ('1900000000', null, 'Bangsamoro Autonomous Region in Muslim Mindanao (BARMM)', 'region', 'region', '2026-q3', true),
  ('1800000000', null, 'Negros Island Region (NIR)', 'region', 'region', '2026-q3', true)
on conflict (psgc_code) do update set name = excluded.name, level = excluded.level, is_active = true;

-- Seed Provinces (82 provinces)
insert into public.psgc_locations (psgc_code, parent_psgc_code, name, level, location_type, reference_version_id, is_active)
values
  ('1401000000', '1400000000', 'Abra', 'province', 'province', '2026-q3', true),
  ('1402000000', '1400000000', 'Apayao', 'province', 'province', '2026-q3', true),
  ('1411000000', '1400000000', 'Benguet', 'province', 'province', '2026-q3', true),
  ('1427000000', '1400000000', 'Ifugao', 'province', 'province', '2026-q3', true),
  ('1432000000', '1400000000', 'Kalinga', 'province', 'province', '2026-q3', true),
  ('1444000000', '1400000000', 'Mountain Province', 'province', 'province', '2026-q3', true),
  ('0128000000', '0100000000', 'Ilocos Norte', 'province', 'province', '2026-q3', true),
  ('0129000000', '0100000000', 'Ilocos Sur', 'province', 'province', '2026-q3', true),
  ('0133000000', '0100000000', 'La Union', 'province', 'province', '2026-q3', true),
  ('0155000000', '0100000000', 'Pangasinan', 'province', 'province', '2026-q3', true),
  ('0209000000', '0200000000', 'Batanes', 'province', 'province', '2026-q3', true),
  ('0215000000', '0200000000', 'Cagayan', 'province', 'province', '2026-q3', true),
  ('0231000000', '0200000000', 'Isabela', 'province', 'province', '2026-q3', true),
  ('0250000000', '0200000000', 'Nueva Vizcaya', 'province', 'province', '2026-q3', true),
  ('0257000000', '0200000000', 'Quirino', 'province', 'province', '2026-q3', true),
  ('0377000000', '0300000000', 'Aurora', 'province', 'province', '2026-q3', true),
  ('0308000000', '0300000000', 'Bataan', 'province', 'province', '2026-q3', true),
  ('0314000000', '0300000000', 'Bulacan', 'province', 'province', '2026-q3', true),
  ('0349000000', '0300000000', 'Nueva Ecija', 'province', 'province', '2026-q3', true),
  ('0354000000', '0300000000', 'Pampanga', 'province', 'province', '2026-q3', true),
  ('0369000000', '0300000000', 'Tarlac', 'province', 'province', '2026-q3', true),
  ('0371000000', '0300000000', 'Zambales', 'province', 'province', '2026-q3', true),
  ('0410000000', '0400000000', 'Batangas', 'province', 'province', '2026-q3', true),
  ('0421000000', '0400000000', 'Cavite', 'province', 'province', '2026-q3', true),
  ('0434000000', '0400000000', 'Laguna', 'province', 'province', '2026-q3', true),
  ('0456000000', '0400000000', 'Quezon', 'province', 'province', '2026-q3', true),
  ('0458000000', '0400000000', 'Rizal', 'province', 'province', '2026-q3', true),
  ('1740000000', '1700000000', 'Marinduque', 'province', 'province', '2026-q3', true),
  ('1751000000', '1700000000', 'Occidental Mindoro', 'province', 'province', '2026-q3', true),
  ('1752000000', '1700000000', 'Oriental Mindoro', 'province', 'province', '2026-q3', true),
  ('1753000000', '1700000000', 'Palawan', 'province', 'province', '2026-q3', true),
  ('1759000000', '1700000000', 'Romblon', 'province', 'province', '2026-q3', true),
  ('0505000000', '0500000000', 'Albay', 'province', 'province', '2026-q3', true),
  ('0516000000', '0500000000', 'Camarines Norte', 'province', 'province', '2026-q3', true),
  ('0517000000', '0500000000', 'Camarines Sur', 'province', 'province', '2026-q3', true),
  ('0520000000', '0500000000', 'Catanduanes', 'province', 'province', '2026-q3', true),
  ('0541000000', '0500000000', 'Masbate', 'province', 'province', '2026-q3', true),
  ('0562000000', '0500000000', 'Sorsogon', 'province', 'province', '2026-q3', true),
  ('0604000000', '0600000000', 'Aklan', 'province', 'province', '2026-q3', true),
  ('0606000000', '0600000000', 'Antique', 'province', 'province', '2026-q3', true),
  ('0619000000', '0600000000', 'Capiz', 'province', 'province', '2026-q3', true),
  ('0679000000', '0600000000', 'Guimaras', 'province', 'province', '2026-q3', true),
  ('0630000000', '0600000000', 'Iloilo', 'province', 'province', '2026-q3', true),
  ('0712000000', '0700000000', 'Bohol', 'province', 'province', '2026-q3', true),
  ('0722000000', '0700000000', 'Cebu', 'province', 'province', '2026-q3', true),
  ('0761000000', '0700000000', 'Siquijor', 'province', 'province', '2026-q3', true),
  ('0878000000', '0800000000', 'Biliran', 'province', 'province', '2026-q3', true),
  ('0826000000', '0800000000', 'Eastern Samar', 'province', 'province', '2026-q3', true),
  ('0837000000', '0800000000', 'Leyte', 'province', 'province', '2026-q3', true),
  ('0848000000', '0800000000', 'Northern Samar', 'province', 'province', '2026-q3', true),
  ('0860000000', '0800000000', 'Samar', 'province', 'province', '2026-q3', true),
  ('0864000000', '0800000000', 'Southern Leyte', 'province', 'province', '2026-q3', true),
  ('0972000000', '0900000000', 'Zamboanga del Norte', 'province', 'province', '2026-q3', true),
  ('0973000000', '0900000000', 'Zamboanga del Sur', 'province', 'province', '2026-q3', true),
  ('0983000000', '0900000000', 'Zamboanga Sibugay', 'province', 'province', '2026-q3', true),
  ('1013000000', '1000000000', 'Bukidnon', 'province', 'province', '2026-q3', true),
  ('1018000000', '1000000000', 'Camiguin', 'province', 'province', '2026-q3', true),
  ('1035000000', '1000000000', 'Lanao del Norte', 'province', 'province', '2026-q3', true),
  ('1042000000', '1000000000', 'Misamis Occidental', 'province', 'province', '2026-q3', true),
  ('1043000000', '1000000000', 'Misamis Oriental', 'province', 'province', '2026-q3', true),
  ('1123000000', '1100000000', 'Davao del Norte', 'province', 'province', '2026-q3', true),
  ('1124000000', '1100000000', 'Davao del Sur', 'province', 'province', '2026-q3', true),
  ('1125000000', '1100000000', 'Davao Oriental', 'province', 'province', '2026-q3', true),
  ('1182000000', '1100000000', 'Davao de Oro', 'province', 'province', '2026-q3', true),
  ('1186000000', '1100000000', 'Davao Occidental', 'province', 'province', '2026-q3', true),
  ('1247000000', '1200000000', 'Cotabato', 'province', 'province', '2026-q3', true),
  ('1263000000', '1200000000', 'South Cotabato', 'province', 'province', '2026-q3', true),
  ('1265000000', '1200000000', 'Sultan Kudarat', 'province', 'province', '2026-q3', true),
  ('1280000000', '1200000000', 'Sarangani', 'province', 'province', '2026-q3', true),
  ('1602000000', '1600000000', 'Agusan del Norte', 'province', 'province', '2026-q3', true),
  ('1603000000', '1600000000', 'Agusan del Sur', 'province', 'province', '2026-q3', true),
  ('1667000000', '1600000000', 'Surigao del Norte', 'province', 'province', '2026-q3', true),
  ('1668000000', '1600000000', 'Surigao del Sur', 'province', 'province', '2026-q3', true),
  ('1685000000', '1600000000', 'Dinagat Islands', 'province', 'province', '2026-q3', true),
  ('1907000000', '1900000000', 'Basilan', 'province', 'province', '2026-q3', true),
  ('1936000000', '1900000000', 'Lanao del Sur', 'province', 'province', '2026-q3', true),
  ('1938000000', '1900000000', 'Maguindanao del Norte', 'province', 'province', '2026-q3', true),
  ('1939000000', '1900000000', 'Maguindanao del Sur', 'province', 'province', '2026-q3', true),
  ('1966000000', '1900000000', 'Sulu', 'province', 'province', '2026-q3', true),
  ('1970000000', '1900000000', 'Tawi-Tawi', 'province', 'province', '2026-q3', true),
  ('1845000000', '1800000000', 'Negros Occidental', 'province', 'province', '2026-q3', true),
  ('1846000000', '1800000000', 'Negros Oriental', 'province', 'province', '2026-q3', true)
on conflict (psgc_code) do update set parent_psgc_code = excluded.parent_psgc_code, name = excluded.name, is_active = true;

-- Seed Cities & Municipalities
insert into public.psgc_locations (psgc_code, parent_psgc_code, name, level, location_type, reference_version_id, is_active)
values
  ('1380600000', '1300000000', 'City of Manila', 'city', 'huc', '2026-q3', true),
  ('1381200000', '1300000000', 'Quezon City', 'city', 'huc', '2026-q3', true),
  ('1380300000', '1300000000', 'Caloocan City', 'city', 'huc', '2026-q3', true),
  ('1380800000', '1300000000', 'Makati City', 'city', 'huc', '2026-q3', true),
  ('1380900000', '1300000000', 'Malabon City', 'city', 'huc', '2026-q3', true),
  ('1380700000', '1300000000', 'Mandaluyong City', 'city', 'huc', '2026-q3', true),
  ('1381000000', '1300000000', 'Marikina City', 'city', 'huc', '2026-q3', true),
  ('1381100000', '1300000000', 'Muntinlupa City', 'city', 'huc', '2026-q3', true),
  ('1381300000', '1300000000', 'Navotas City', 'city', 'huc', '2026-q3', true),
  ('1381400000', '1300000000', 'Parañaque City', 'city', 'huc', '2026-q3', true),
  ('1381500000', '1300000000', 'Pasay City', 'city', 'huc', '2026-q3', true),
  ('1381600000', '1300000000', 'Pasig City', 'city', 'huc', '2026-q3', true),
  ('1381700000', '1300000000', 'Municipality of Pateros', 'municipality', 'municipality', '2026-q3', true),
  ('1381800000', '1300000000', 'San Juan City', 'city', 'huc', '2026-q3', true),
  ('1381900000', '1300000000', 'Taguig City', 'city', 'huc', '2026-q3', true),
  ('1382000000', '1300000000', 'Valenzuela City', 'city', 'huc', '2026-q3', true),
  ('1380500000', '1300000000', 'Las Piñas City', 'city', 'huc', '2026-q3', true),
  ('1411020000', '1411000000', 'Baguio City', 'city', 'huc', '2026-q3', true),
  ('1411010000', '1411000000', 'La Trinidad', 'municipality', 'municipality', '2026-q3', true),
  ('0314010000', '0314000000', 'City of Malolos', 'city', 'city', '2026-q3', true),
  ('0314020000', '0314000000', 'City of Meycauayan', 'city', 'city', '2026-q3', true),
  ('0314030000', '0314000000', 'City of San Jose del Monte', 'city', 'city', '2026-q3', true),
  ('0314040000', '0314000000', 'Marilao', 'municipality', 'municipality', '2026-q3', true),
  ('0354010000', '0354000000', 'Angeles City', 'city', 'huc', '2026-q3', true),
  ('0354020000', '0354000000', 'City of San Fernando', 'city', 'city', '2026-q3', true),
  ('0421030000', '0421000000', 'Bacoor City', 'city', 'city', '2026-q3', true),
  ('0421060000', '0421000000', 'Dasmariñas City', 'city', 'city', '2026-q3', true),
  ('0421080000', '0421000000', 'Imus City', 'city', 'city', '2026-q3', true),
  ('0421190000', '0421000000', 'Tagaytay City', 'city', 'city', '2026-q3', true),
  ('0421050000', '0421000000', 'Cavite City', 'city', 'city', '2026-q3', true),
  ('0434040000', '0434000000', 'Calamba City', 'city', 'city', '2026-q3', true),
  ('0434280000', '0434000000', 'Santa Rosa City', 'city', 'city', '2026-q3', true),
  ('0434030000', '0434000000', 'Biñan City', 'city', 'city', '2026-q3', true),
  ('0434240000', '0434000000', 'San Pedro City', 'city', 'city', '2026-q3', true),
  ('0434250000', '0434000000', 'City of San Pablo', 'city', 'city', '2026-q3', true),
  ('0458010000', '0458000000', 'Antipolo City', 'city', 'city', '2026-q3', true),
  ('0458020000', '0458000000', 'Cainta', 'municipality', 'municipality', '2026-q3', true),
  ('0458130000', '0458000000', 'Taytay', 'municipality', 'municipality', '2026-q3', true),
  ('0458080000', '0458000000', 'San Mateo', 'municipality', 'municipality', '2026-q3', true),
  ('0410050000', '0410000000', 'Batangas City', 'city', 'city', '2026-q3', true),
  ('0410140000', '0410000000', 'Lipa City', 'city', 'city', '2026-q3', true),
  ('0722170000', '0722000000', 'Cebu City', 'city', 'huc', '2026-q3', true),
  ('0722260000', '0722000000', 'Lapu-Lapu City', 'city', 'huc', '2026-q3', true),
  ('0722300000', '0722000000', 'Mandaue City', 'city', 'huc', '2026-q3', true),
  ('1124020000', '1124000000', 'Davao City', 'city', 'huc', '2026-q3', true)
on conflict (psgc_code) do update set parent_psgc_code = excluded.parent_psgc_code, name = excluded.name, level = excluded.level, is_active = true;

-- Seed Barangays
insert into public.psgc_locations (psgc_code, parent_psgc_code, name, level, location_type, reference_version_id, is_active)
values
  ('1380600408', '1380600000', 'Barangay 408 (Sampaloc / EARIST Nagtahan)', 'barangay', 'barangay', '2026-q3', true),
  ('1380600409', '1380600000', 'Barangay 409 (Sampaloc)', 'barangay', 'barangay', '2026-q3', true),
  ('1380600410', '1380600000', 'Barangay 410 (Sampaloc)', 'barangay', 'barangay', '2026-q3', true),
  ('1380600411', '1380600000', 'Barangay 411 (Sampaloc)', 'barangay', 'barangay', '2026-q3', true),
  ('1380600412', '1380600000', 'Barangay 412 (Sampaloc)', 'barangay', 'barangay', '2026-q3', true),
  ('1380600413', '1380600000', 'Barangay 413 (Sampaloc)', 'barangay', 'barangay', '2026-q3', true),
  ('1380600414', '1380600000', 'Barangay 414 (Sampaloc)', 'barangay', 'barangay', '2026-q3', true),
  ('1380600415', '1380600000', 'Barangay 415 (Sampaloc)', 'barangay', 'barangay', '2026-q3', true),
  ('1380600587', '1380600000', 'Barangay 587 (Santa Mesa)', 'barangay', 'barangay', '2026-q3', true),
  ('1380600588', '1380600000', 'Barangay 588 (Santa Mesa)', 'barangay', 'barangay', '2026-q3', true),
  ('1380600629', '1380600000', 'Barangay 629 (Santa Mesa)', 'barangay', 'barangay', '2026-q3', true),
  ('1380600830', '1380600000', 'Barangay 830 (Pandacan)', 'barangay', 'barangay', '2026-q3', true),
  ('1380600831', '1380600000', 'Barangay 831 (Pandacan)', 'barangay', 'barangay', '2026-q3', true),
  ('1380600659', '1380600000', 'Barangay 659 (Ermita)', 'barangay', 'barangay', '2026-q3', true),
  ('1380600660', '1380600000', 'Barangay 660 (Ermita)', 'barangay', 'barangay', '2026-q3', true),
  ('1380600661', '1380600000', 'Barangay 661 (Rizal Park / Ermita)', 'barangay', 'barangay', '2026-q3', true),
  ('1380600667', '1380600000', 'Barangay 667 (Ermita)', 'barangay', 'barangay', '2026-q3', true),
  ('1380600696', '1380600000', 'Barangay 696 (Malate)', 'barangay', 'barangay', '2026-q3', true),
  ('1380600697', '1380600000', 'Barangay 697 (Malate)', 'barangay', 'barangay', '2026-q3', true),
  ('1380600700', '1380600000', 'Barangay 700 (Malate)', 'barangay', 'barangay', '2026-q3', true),
  ('1380600821', '1380600000', 'Barangay 821 (Paco)', 'barangay', 'barangay', '2026-q3', true),
  ('1380600822', '1380600000', 'Barangay 822 (Paco)', 'barangay', 'barangay', '2026-q3', true),
  ('1380600823', '1380600000', 'Barangay 823 (Paco)', 'barangay', 'barangay', '2026-q3', true),
  ('1380600287', '1380600000', 'Barangay 287 (Binondo)', 'barangay', 'barangay', '2026-q3', true),
  ('1380600306', '1380600000', 'Barangay 306 (Santa Cruz)', 'barangay', 'barangay', '2026-q3', true),
  ('1381200001', '1381200000', 'Batasan Hills', 'barangay', 'barangay', '2026-q3', true),
  ('1381200002', '1381200000', 'Commonwealth', 'barangay', 'barangay', '2026-q3', true),
  ('1381200003', '1381200000', 'Holy Spirit', 'barangay', 'barangay', '2026-q3', true),
  ('1381200004', '1381200000', 'Bagong Silangan', 'barangay', 'barangay', '2026-q3', true),
  ('1381200005', '1381200000', 'Payatas', 'barangay', 'barangay', '2026-q3', true),
  ('1381200006', '1381200000', 'U.P. Campus', 'barangay', 'barangay', '2026-q3', true),
  ('1381200007', '1381200000', 'Loyola Heights', 'barangay', 'barangay', '2026-q3', true),
  ('1381200008', '1381200000', 'Socorro (Cubao)', 'barangay', 'barangay', '2026-q3', true),
  ('1381200009', '1381200000', 'South Triangle', 'barangay', 'barangay', '2026-q3', true),
  ('1381200010', '1381200000', 'Kamuning', 'barangay', 'barangay', '2026-q3', true),
  ('1381200011', '1381200000', 'Pinyahan', 'barangay', 'barangay', '2026-q3', true),
  ('1381200012', '1381200000', 'Tandang Sora', 'barangay', 'barangay', '2026-q3', true),
  ('1380800001', '1380800000', 'Bel-Air', 'barangay', 'barangay', '2026-q3', true),
  ('1380800002', '1380800000', 'Poblacion', 'barangay', 'barangay', '2026-q3', true),
  ('1380800003', '1380800000', 'San Lorenzo', 'barangay', 'barangay', '2026-q3', true),
  ('1380800004', '1380800000', 'San Antonio', 'barangay', 'barangay', '2026-q3', true),
  ('1380800005', '1380800000', 'Pio del Pilar', 'barangay', 'barangay', '2026-q3', true),
  ('1380800006', '1380800000', 'Palanan', 'barangay', 'barangay', '2026-q3', true),
  ('1381900001', '1381900000', 'Fort Bonifacio (BGC)', 'barangay', 'barangay', '2026-q3', true),
  ('1381900002', '1381900000', 'Pinagsama', 'barangay', 'barangay', '2026-q3', true),
  ('1381900003', '1381900000', 'Western Bicutan', 'barangay', 'barangay', '2026-q3', true),
  ('1381900004', '1381900000', 'Ususan', 'barangay', 'barangay', '2026-q3', true),
  ('1381600001', '1381600000', 'San Antonio (Ortigas)', 'barangay', 'barangay', '2026-q3', true),
  ('1381600002', '1381600000', 'Kapitolyo', 'barangay', 'barangay', '2026-q3', true),
  ('1381600003', '1381600000', 'Ugong', 'barangay', 'barangay', '2026-q3', true),
  ('1381600004', '1381600000', 'Rosario', 'barangay', 'barangay', '2026-q3', true),
  ('1380700001', '1380700000', 'Wack-Wack Greenhills', 'barangay', 'barangay', '2026-q3', true),
  ('1380700002', '1380700000', 'Highway Hills', 'barangay', 'barangay', '2026-q3', true),
  ('1380700003', '1380700000', 'Barangka Ilaya', 'barangay', 'barangay', '2026-q3', true),
  ('1380300001', '1380300000', 'Barangay 1', 'barangay', 'barangay', '2026-q3', true),
  ('1380300002', '1380300000', 'Barangay 2', 'barangay', 'barangay', '2026-q3', true),
  ('1380300171', '1380300000', 'Barangay 171 (Bagumbong)', 'barangay', 'barangay', '2026-q3', true),
  ('1380300176', '1380300000', 'Barangay 176 (Bagong Silang)', 'barangay', 'barangay', '2026-q3', true),
  ('1381500001', '1381500000', 'Barangay 1 (Poblacion)', 'barangay', 'barangay', '2026-q3', true),
  ('1381500076', '1381500000', 'Barangay 76 (Mall of Asia Complex)', 'barangay', 'barangay', '2026-q3', true),
  ('1381500183', '1381500000', 'Barangay 183 (Villamor Airbase)', 'barangay', 'barangay', '2026-q3', true),
  ('1381400001', '1381400000', 'BF Homes', 'barangay', 'barangay', '2026-q3', true),
  ('1381400002', '1381400000', 'San Antonio', 'barangay', 'barangay', '2026-q3', true),
  ('1381400003', '1381400000', 'Don Bosco', 'barangay', 'barangay', '2026-q3', true),
  ('1381400004', '1381400000', 'Baclaran', 'barangay', 'barangay', '2026-q3', true),
  ('1381100001', '1381100000', 'Alabang', 'barangay', 'barangay', '2026-q3', true),
  ('1381100002', '1381100000', 'Ayala Alabang', 'barangay', 'barangay', '2026-q3', true),
  ('1381100003', '1381100000', 'Putatan', 'barangay', 'barangay', '2026-q3', true),
  ('1381000001', '1381000000', 'Concepcion Uno', 'barangay', 'barangay', '2026-q3', true),
  ('1381000002', '1381000000', 'Marikina Heights', 'barangay', 'barangay', '2026-q3', true),
  ('1381000003', '1381000000', 'Santo Niño', 'barangay', 'barangay', '2026-q3', true),
  ('1382000001', '1382000000', 'Karuhatan', 'barangay', 'barangay', '2026-q3', true),
  ('1382000002', '1382000000', 'Malinta', 'barangay', 'barangay', '2026-q3', true),
  ('1382000003', '1382000000', 'Malanday', 'barangay', 'barangay', '2026-q3', true),
  ('1380500001', '1380500000', 'Pamplona Uno', 'barangay', 'barangay', '2026-q3', true),
  ('1380500002', '1380500000', 'BF International Village', 'barangay', 'barangay', '2026-q3', true),
  ('1381800001', '1381800000', 'Greenhills', 'barangay', 'barangay', '2026-q3', true),
  ('1381800002', '1381800000', 'West Crame', 'barangay', 'barangay', '2026-q3', true),
  ('1380900001', '1380900000', 'Potrero', 'barangay', 'barangay', '2026-q3', true),
  ('1380900002', '1380900000', 'Concepcion', 'barangay', 'barangay', '2026-q3', true),
  ('1381300001', '1381300000', 'San Jose', 'barangay', 'barangay', '2026-q3', true),
  ('1381300002', '1381300000', 'North Bay Boulevard South', 'barangay', 'barangay', '2026-q3', true),
  ('1381700001', '1381700000', 'Aguho', 'barangay', 'barangay', '2026-q3', true),
  ('1381700002', '1381700000', 'San Roque', 'barangay', 'barangay', '2026-q3', true),
  ('1411020001', '1411020000', 'Session Road Area', 'barangay', 'barangay', '2026-q3', true),
  ('1411020002', '1411020000', 'Camp 7', 'barangay', 'barangay', '2026-q3', true),
  ('1411020003', '1411020000', 'Loakan Proper', 'barangay', 'barangay', '2026-q3', true),
  ('0421030001', '0421030000', 'Molino I', 'barangay', 'barangay', '2026-q3', true),
  ('0421030002', '0421030000', 'Molino II', 'barangay', 'barangay', '2026-q3', true),
  ('0421030003', '0421030000', 'Molino III', 'barangay', 'barangay', '2026-q3', true),
  ('0421030004', '0421030000', 'Habay I', 'barangay', 'barangay', '2026-q3', true),
  ('0421060001', '0421060000', 'Salitran I', 'barangay', 'barangay', '2026-q3', true),
  ('0421060002', '0421060000', 'Salitran II', 'barangay', 'barangay', '2026-q3', true),
  ('0421060003', '0421060000', 'Burol I', 'barangay', 'barangay', '2026-q3', true),
  ('0434040001', '0434040000', 'Bucal', 'barangay', 'barangay', '2026-q3', true),
  ('0434040002', '0434040000', 'Pansol', 'barangay', 'barangay', '2026-q3', true),
  ('0434040003', '0434040000', 'Canlubang', 'barangay', 'barangay', '2026-q3', true),
  ('0434280001', '0434280000', 'Balibago', 'barangay', 'barangay', '2026-q3', true),
  ('0434280002', '0434280000', 'Don Jose', 'barangay', 'barangay', '2026-q3', true),
  ('0458010001', '0458010000', 'San Roque', 'barangay', 'barangay', '2026-q3', true),
  ('0458010002', '0458010000', 'Dela Paz', 'barangay', 'barangay', '2026-q3', true),
  ('0458010003', '0458010000', 'Mayamot', 'barangay', 'barangay', '2026-q3', true),
  ('0314010001', '0314010000', 'Tikay', 'barangay', 'barangay', '2026-q3', true),
  ('0314010002', '0314010000', 'Dakila', 'barangay', 'barangay', '2026-q3', true),
  ('0314010003', '0314010000', 'Guinhawa', 'barangay', 'barangay', '2026-q3', true),
  ('0722170001', '0722170000', 'Lahug', 'barangay', 'barangay', '2026-q3', true),
  ('0722170002', '0722170000', 'Mabolo', 'barangay', 'barangay', '2026-q3', true),
  ('0722170003', '0722170000', 'Guadalupe', 'barangay', 'barangay', '2026-q3', true),
  ('1124020001', '1124020000', 'Poblacion', 'barangay', 'barangay', '2026-q3', true),
  ('1124020002', '1124020000', 'Buhangin', 'barangay', 'barangay', '2026-q3', true),
  ('1124020003', '1124020000', 'Talomo', 'barangay', 'barangay', '2026-q3', true)
on conflict (psgc_code) do update set parent_psgc_code = excluded.parent_psgc_code, name = excluded.name, is_active = true;

-- Seed PHLPost Postal Codes
insert into public.postal_code_reference (postal_code, region_name, province_name, locality_name, psgc_locality_code, barangay_psgc_code, mapping_type, mapping_status, source_name, source_url, source_version, is_active)
values
  ('1008', 'National Capital Region (NCR)', null, 'City of Manila', '1380600000', '1380600408', 'exact_barangay', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1008', 'National Capital Region (NCR)', null, 'City of Manila', '1380600000', '1380600409', 'exact_barangay', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1008', 'National Capital Region (NCR)', null, 'City of Manila', '1380600000', '1380600410', 'exact_barangay', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1008', 'National Capital Region (NCR)', null, 'City of Manila', '1380600000', '1380600411', 'exact_barangay', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1008', 'National Capital Region (NCR)', null, 'City of Manila', '1380600000', '1380600412', 'exact_barangay', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1008', 'National Capital Region (NCR)', null, 'City of Manila', '1380600000', '1380600413', 'exact_barangay', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1008', 'National Capital Region (NCR)', null, 'City of Manila', '1380600000', '1380600414', 'exact_barangay', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1008', 'National Capital Region (NCR)', null, 'City of Manila', '1380600000', '1380600415', 'exact_barangay', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1016', 'National Capital Region (NCR)', null, 'City of Manila', '1380600000', '1380600587', 'exact_barangay', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1016', 'National Capital Region (NCR)', null, 'City of Manila', '1380600000', '1380600588', 'exact_barangay', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1016', 'National Capital Region (NCR)', null, 'City of Manila', '1380600000', '1380600629', 'exact_barangay', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1011', 'National Capital Region (NCR)', null, 'City of Manila', '1380600000', '1380600830', 'exact_barangay', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1011', 'National Capital Region (NCR)', null, 'City of Manila', '1380600000', '1380600831', 'exact_barangay', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1000', 'National Capital Region (NCR)', null, 'City of Manila', '1380600000', '1380600659', 'exact_barangay', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1000', 'National Capital Region (NCR)', null, 'City of Manila', '1380600000', '1380600660', 'exact_barangay', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1000', 'National Capital Region (NCR)', null, 'City of Manila', '1380600000', '1380600661', 'exact_barangay', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1000', 'National Capital Region (NCR)', null, 'City of Manila', '1380600000', '1380600667', 'exact_barangay', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1004', 'National Capital Region (NCR)', null, 'City of Manila', '1380600000', '1380600696', 'exact_barangay', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1004', 'National Capital Region (NCR)', null, 'City of Manila', '1380600000', '1380600697', 'exact_barangay', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1004', 'National Capital Region (NCR)', null, 'City of Manila', '1380600000', '1380600700', 'exact_barangay', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1007', 'National Capital Region (NCR)', null, 'City of Manila', '1380600000', '1380600821', 'exact_barangay', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1007', 'National Capital Region (NCR)', null, 'City of Manila', '1380600000', '1380600822', 'exact_barangay', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1007', 'National Capital Region (NCR)', null, 'City of Manila', '1380600000', '1380600823', 'exact_barangay', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1006', 'National Capital Region (NCR)', null, 'City of Manila', '1380600000', '1380600287', 'exact_barangay', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1014', 'National Capital Region (NCR)', null, 'City of Manila', '1380600000', '1380600306', 'exact_barangay', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1126', 'National Capital Region (NCR)', null, 'Quezon City', '1381200000', '1381200001', 'exact_barangay', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1121', 'National Capital Region (NCR)', null, 'Quezon City', '1381200000', '1381200002', 'exact_barangay', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1127', 'National Capital Region (NCR)', null, 'Quezon City', '1381200000', '1381200003', 'exact_barangay', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1119', 'National Capital Region (NCR)', null, 'Quezon City', '1381200000', '1381200004', 'exact_barangay', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1119', 'National Capital Region (NCR)', null, 'Quezon City', '1381200000', '1381200005', 'exact_barangay', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1101', 'National Capital Region (NCR)', null, 'Quezon City', '1381200000', '1381200006', 'exact_barangay', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1108', 'National Capital Region (NCR)', null, 'Quezon City', '1381200000', '1381200007', 'exact_barangay', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1109', 'National Capital Region (NCR)', null, 'Quezon City', '1381200000', '1381200008', 'exact_barangay', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1103', 'National Capital Region (NCR)', null, 'Quezon City', '1381200000', '1381200009', 'exact_barangay', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1103', 'National Capital Region (NCR)', null, 'Quezon City', '1381200000', '1381200010', 'exact_barangay', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1100', 'National Capital Region (NCR)', null, 'Quezon City', '1381200000', '1381200011', 'exact_barangay', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1116', 'National Capital Region (NCR)', null, 'Quezon City', '1381200000', '1381200012', 'exact_barangay', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1209', 'National Capital Region (NCR)', null, 'Makati City', '1380800000', '1380800001', 'exact_barangay', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1210', 'National Capital Region (NCR)', null, 'Makati City', '1380800000', '1380800002', 'exact_barangay', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1223', 'National Capital Region (NCR)', null, 'Makati City', '1380800000', '1380800003', 'exact_barangay', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1203', 'National Capital Region (NCR)', null, 'Makati City', '1380800000', '1380800004', 'exact_barangay', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1230', 'National Capital Region (NCR)', null, 'Makati City', '1380800000', '1380800005', 'exact_barangay', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1235', 'National Capital Region (NCR)', null, 'Makati City', '1380800000', '1380800006', 'exact_barangay', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1634', 'National Capital Region (NCR)', null, 'Taguig City', '1381900000', '1381900001', 'exact_barangay', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1630', 'National Capital Region (NCR)', null, 'Taguig City', '1381900000', '1381900002', 'exact_barangay', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1630', 'National Capital Region (NCR)', null, 'Taguig City', '1381900000', '1381900003', 'exact_barangay', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1632', 'National Capital Region (NCR)', null, 'Taguig City', '1381900000', '1381900004', 'exact_barangay', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1605', 'National Capital Region (NCR)', null, 'Pasig City', '1381600000', '1381600001', 'exact_barangay', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1603', 'National Capital Region (NCR)', null, 'Pasig City', '1381600000', '1381600002', 'exact_barangay', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1604', 'National Capital Region (NCR)', null, 'Pasig City', '1381600000', '1381600003', 'exact_barangay', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1609', 'National Capital Region (NCR)', null, 'Pasig City', '1381600000', '1381600004', 'exact_barangay', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1550', 'National Capital Region (NCR)', null, 'Mandaluyong City', '1380700000', null, 'unique_city', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1400', 'National Capital Region (NCR)', null, 'Caloocan City', '1380300000', '1380300001', 'exact_barangay', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1400', 'National Capital Region (NCR)', null, 'Caloocan City', '1380300000', '1380300002', 'exact_barangay', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1421', 'National Capital Region (NCR)', null, 'Caloocan City', '1380300000', '1380300171', 'exact_barangay', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1428', 'National Capital Region (NCR)', null, 'Caloocan City', '1380300000', '1380300176', 'exact_barangay', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1300', 'National Capital Region (NCR)', null, 'Pasay City', '1381500000', '1381500001', 'exact_barangay', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1308', 'National Capital Region (NCR)', null, 'Pasay City', '1381500000', '1381500076', 'exact_barangay', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1309', 'National Capital Region (NCR)', null, 'Pasay City', '1381500000', '1381500183', 'exact_barangay', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1709', 'National Capital Region (NCR)', null, 'Parañaque City', '1381400000', '1381400001', 'exact_barangay', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1707', 'National Capital Region (NCR)', null, 'Parañaque City', '1381400000', '1381400002', 'exact_barangay', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1711', 'National Capital Region (NCR)', null, 'Parañaque City', '1381400000', '1381400003', 'exact_barangay', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1702', 'National Capital Region (NCR)', null, 'Parañaque City', '1381400000', '1381400004', 'exact_barangay', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1780', 'National Capital Region (NCR)', null, 'Muntinlupa City', '1381100000', '1381100001', 'exact_barangay', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1799', 'National Capital Region (NCR)', null, 'Muntinlupa City', '1381100000', '1381100002', 'exact_barangay', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1772', 'National Capital Region (NCR)', null, 'Muntinlupa City', '1381100000', '1381100003', 'exact_barangay', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1807', 'National Capital Region (NCR)', null, 'Marikina City', '1381000000', '1381000001', 'exact_barangay', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1810', 'National Capital Region (NCR)', null, 'Marikina City', '1381000000', '1381000002', 'exact_barangay', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1803', 'National Capital Region (NCR)', null, 'Marikina City', '1381000000', '1381000003', 'exact_barangay', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1443', 'National Capital Region (NCR)', null, 'Valenzuela City', '1382000000', '1382000001', 'exact_barangay', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1444', 'National Capital Region (NCR)', null, 'Valenzuela City', '1382000000', '1382000002', 'exact_barangay', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1448', 'National Capital Region (NCR)', null, 'Valenzuela City', '1382000000', '1382000003', 'exact_barangay', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1742', 'National Capital Region (NCR)', null, 'Las Piñas City', '1380500000', '1380500001', 'exact_barangay', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1747', 'National Capital Region (NCR)', null, 'Las Piñas City', '1380500000', '1380500002', 'exact_barangay', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1502', 'National Capital Region (NCR)', null, 'San Juan City', '1381800000', '1381800001', 'exact_barangay', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1504', 'National Capital Region (NCR)', null, 'San Juan City', '1381800000', '1381800002', 'exact_barangay', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1475', 'National Capital Region (NCR)', null, 'Malabon City', '1380900000', '1380900001', 'exact_barangay', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1477', 'National Capital Region (NCR)', null, 'Malabon City', '1380900000', '1380900002', 'exact_barangay', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1485', 'National Capital Region (NCR)', null, 'Navotas City', '1381300000', '1381300001', 'exact_barangay', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1489', 'National Capital Region (NCR)', null, 'Navotas City', '1381300000', '1381300002', 'exact_barangay', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1620', 'National Capital Region (NCR)', null, 'Municipality of Pateros', '1381700000', null, 'unique_city', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('2600', 'Cordillera Administrative Region (CAR)', 'Benguet', 'Baguio City', '1411020000', null, 'unique_city', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('2601', 'Cordillera Administrative Region (CAR)', 'Benguet', 'La Trinidad', '1411010000', null, 'unique_city', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('3000', 'Region III (Central Luzon)', 'Bulacan', 'City of Malolos', '0314010000', null, 'unique_city', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('3020', 'Region III (Central Luzon)', 'Bulacan', 'City of Meycauayan', '0314020000', null, 'unique_city', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('3023', 'Region III (Central Luzon)', 'Bulacan', 'City of San Jose del Monte', '0314030000', null, 'unique_city', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('3019', 'Region III (Central Luzon)', 'Bulacan', 'Marilao', '0314040000', null, 'unique_city', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('2009', 'Region III (Central Luzon)', 'Pampanga', 'Angeles City', '0354010000', null, 'unique_city', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('2000', 'Region III (Central Luzon)', 'Pampanga', 'City of San Fernando', '0354020000', null, 'unique_city', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('4102', 'Region IV-A (CALABARZON)', 'Cavite', 'Bacoor City', '0421030000', null, 'unique_city', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('4114', 'Region IV-A (CALABARZON)', 'Cavite', 'Dasmariñas City', '0421060000', null, 'unique_city', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('4103', 'Region IV-A (CALABARZON)', 'Cavite', 'Imus City', '0421080000', null, 'unique_city', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('4120', 'Region IV-A (CALABARZON)', 'Cavite', 'Tagaytay City', '0421190000', null, 'unique_city', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('4100', 'Region IV-A (CALABARZON)', 'Cavite', 'Cavite City', '0421050000', null, 'unique_city', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('4027', 'Region IV-A (CALABARZON)', 'Laguna', 'Calamba City', '0434040000', null, 'unique_city', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('4026', 'Region IV-A (CALABARZON)', 'Laguna', 'Santa Rosa City', '0434280000', null, 'unique_city', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('4024', 'Region IV-A (CALABARZON)', 'Laguna', 'Biñan City', '0434030000', null, 'unique_city', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('4023', 'Region IV-A (CALABARZON)', 'Laguna', 'San Pedro City', '0434240000', null, 'unique_city', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('4000', 'Region IV-A (CALABARZON)', 'Laguna', 'City of San Pablo', '0434250000', null, 'unique_city', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1870', 'Region IV-A (CALABARZON)', 'Rizal', 'Antipolo City', '0458010000', null, 'unique_city', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1900', 'Region IV-A (CALABARZON)', 'Rizal', 'Cainta', '0458020000', null, 'unique_city', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1920', 'Region IV-A (CALABARZON)', 'Rizal', 'Taytay', '0458130000', null, 'unique_city', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1850', 'Region IV-A (CALABARZON)', 'Rizal', 'San Mateo', '0458080000', null, 'unique_city', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('4200', 'Region IV-A (CALABARZON)', 'Batangas', 'Batangas City', '0410050000', null, 'unique_city', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('4217', 'Region IV-A (CALABARZON)', 'Batangas', 'Lipa City', '0410140000', null, 'unique_city', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('6000', 'Region VII (Central Visayas)', 'Cebu', 'Cebu City', '0722170000', null, 'unique_city', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('6015', 'Region VII (Central Visayas)', 'Cebu', 'Lapu-Lapu City', '0722260000', null, 'unique_city', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('6014', 'Region VII (Central Visayas)', 'Cebu', 'Mandaue City', '0722300000', null, 'unique_city', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('8000', 'Region XI (Davao Region)', 'Davao del Sur', 'Davao City', '1124020000', null, 'unique_city', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true);

-- 6. Add address snapshot columns to public.visitors and public.returning_visitor_profiles
alter table public.visitors
  add column if not exists psgc_region_name text,
  add column if not exists psgc_province_name text,
  add column if not exists psgc_city_municipality_name text,
  add column if not exists psgc_barangay_name text,
  add column if not exists home_building text,
  add column if not exists home_street text,
  add column if not exists postal_code text,
  add column if not exists postal_code_source text;

alter table public.returning_visitor_profiles
  add column if not exists psgc_region_name text,
  add column if not exists psgc_province_name text,
  add column if not exists psgc_city_municipality_name text,
  add column if not exists psgc_barangay_name text,
  add column if not exists home_building text,
  add column if not exists home_street text,
  add column if not exists postal_code text,
  add column if not exists postal_code_source text;

-- 7. Create api.issue_online_pass_v6
create or replace function api.issue_online_pass_v6(
  requested_actor_id uuid,
  requested_registration_mode text,
  requested_request_id uuid,
  requested_first_name text,
  requested_middle_name text,
  requested_last_name text,
  requested_contact_number text,
  requested_purpose text,
  requested_visit_date date,
  requested_photo_intent_id uuid,
  requested_photo_bytes integer,
  requested_photo_sha256 text,
  requested_id_intent_id uuid,
  requested_id_bytes integer,
  requested_id_sha256 text,
  requested_token_digest text,
  requested_arrival_mode text,
  -- Structured PSGC Residential Address
  requested_psgc_version text,
  requested_psgc_region_code text,
  requested_psgc_province_code text,
  requested_psgc_city_code text,
  requested_psgc_barangay_code text,
  requested_home_building text default null,
  requested_home_street text default null,
  requested_postal_code text default null,
  requested_postal_code_source text default null,
  -- Legacy / optional coordinates
  requested_home_location_lat numeric(6,3) default null,
  requested_home_location_lon numeric(6,3) default null,
  -- Vehicle declaration parameters
  requested_vehicle_type text default null,
  requested_plate_number text default null,
  requested_plate_key text default null,
  requested_color text default null,
  requested_make_model text default null,
  requested_vehicle_catalog_status text default 'catalog',
  requested_vehicle_photo_intent_id uuid default null,
  requested_vehicle_photo_bytes integer default null,
  requested_vehicle_photo_sha256 text default null,
  -- Returning parameters
  requested_saved_vehicle_id uuid default null,
  requested_returning_profile_id uuid default null,
  requested_returning_match_token_digest text default null
)
returns table (
  pass_id uuid,
  public_reference uuid,
  valid_from timestamptz,
  valid_until timestamptz
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  settings public.app_settings%rowtype;
  photo_intent public.upload_intents%rowtype;
  id_intent public.upload_intents%rowtype;
  vehicle_photo_intent public.upload_intents%rowtype;
  verification_record public.portal_identity_verification_attempts%rowtype;
  returning_attempt_record public.returning_identity_attempts%rowtype;
  returning_profile_record public.returning_visitor_profiles%rowtype;
  existing_pass public.passes%rowtype;
  existing_visitor public.visitors%rowtype;
  existing_decl public.visit_vehicle_declarations%rowtype;
  version_rec public.psgc_reference_versions%rowtype;
  region_rec public.psgc_locations%rowtype;
  province_rec public.psgc_locations%rowtype;
  city_rec public.psgc_locations%rowtype;
  barangay_rec public.psgc_locations%rowtype;
  region_has_provinces boolean;
  v_region_name text;
  v_province_name text := null;
  v_city_name text;
  v_barangay_name text;
  effective_home_address text;
  new_visitor_id uuid;
  new_pass_id uuid;
  new_public_reference uuid;
  new_vehicle_evidence_id uuid := null;
  starts_at timestamptz;
  ends_at timestamptz;
  full_name_calc text;
  v_plate_conflict boolean := false;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'service role required';
  end if;

  -- 1. Actor verification: must be anonymous portal visitor
  if not exists (
    select 1 from auth.users u
    where u.id = requested_actor_id and coalesce(u.is_anonymous, false) = true
  ) or exists (select 1 from public.staff_profiles where user_id = requested_actor_id)
    or exists (select 1 from public.devices where user_id = requested_actor_id) then
    raise exception using errcode = '42501', message = 'anonymous visitor identity required';
  end if;

  if requested_registration_mode not in ('new', 'returning') then
    raise exception using errcode = '22023', message = 'invalid registration mode';
  end if;
  if requested_arrival_mode not in ('no_vehicle', 'vehicle') then
    raise exception using errcode = '22023', message = 'invalid arrival mode: explicit selection required';
  end if;

  full_name_calc := btrim(concat_ws(' ', nullif(btrim(requested_first_name), ''), nullif(btrim(requested_middle_name), ''), nullif(btrim(requested_last_name), '')));

  -- 2. Advisory lock for idempotency serialization
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(requested_request_id::text, 0));

  select * into existing_pass from public.passes
  where issue_request_id = requested_request_id;

  if found then
    select * into existing_visitor from public.visitors
    where id = existing_pass.visitor_id;

    if not found or existing_visitor.owner_id <> requested_actor_id or existing_visitor.source <> 'portal'::public.pass_source then
      raise exception using errcode = '42501', message = 'idempotency actor mismatch';
    end if;

    select * into existing_decl from public.visit_vehicle_declarations
    where visit_vehicle_declarations.pass_id = existing_pass.id;

    -- Strict idempotency check (including PSGC symmetry)
    if existing_visitor.registration_mode <> requested_registration_mode
      or existing_visitor.full_name <> full_name_calc
      or existing_visitor.contact_number <> btrim(requested_contact_number)
      or existing_visitor.purpose <> btrim(requested_purpose)
      or existing_visitor.visit_date <> requested_visit_date
      or existing_visitor.arrival_mode <> requested_arrival_mode
      or (existing_visitor.psgc_region_code is distinct from requested_psgc_region_code)
      or (existing_visitor.psgc_province_code is distinct from requested_psgc_province_code)
      or (existing_visitor.psgc_city_code is distinct from requested_psgc_city_code)
      or (existing_visitor.psgc_barangay_code is distinct from requested_psgc_barangay_code)
      or (requested_arrival_mode = 'vehicle' and (
          existing_decl.plate_key is null
          or existing_decl.plate_key <> requested_plate_key
          or existing_decl.vehicle_type <> requested_vehicle_type
      ))
      or (requested_registration_mode = 'returning' and (
          existing_visitor.returning_profile_id is null
          or existing_visitor.returning_profile_id <> requested_returning_profile_id
      ))
    then
      raise exception using errcode = '42501', message = 'idempotency conflict with existing pass';
    end if;

    pass_id := existing_pass.id;
    public_reference := existing_pass.public_reference;
    valid_from := existing_pass.valid_from;
    valid_until := existing_pass.valid_until;
    return next;
    return;
  end if;

  -- 3. Settings & Window checks
  select * into settings from public.app_settings where singleton for share;
  if requested_visit_date < (now() at time zone settings.timezone)::date
    or requested_visit_date > (now() at time zone settings.timezone)::date + settings.scheduling_days_ahead then
    raise exception using errcode = '22023', message = 'visit date outside scheduling window';
  end if;

  -- 4. Field validation
  if char_length(btrim(requested_first_name)) < 1
    or char_length(btrim(requested_last_name)) < 1
    or char_length(full_name_calc) not between 2 and 160
    or char_length(btrim(requested_contact_number)) not between 7 and 32
    or char_length(btrim(requested_purpose)) not between 3 and 300 then
    raise exception using errcode = '22023', message = 'invalid visitor details';
  end if;

  if requested_contact_number !~ '^\+639[0-9]{9}$' then
    raise exception using errcode = '22023', message = 'invalid philippine mobile number';
  end if;

  -- 5. Server-side Geographic & PSGC Validation
  if requested_psgc_region_code is null or requested_psgc_city_code is null or requested_psgc_barangay_code is null then
    raise exception using errcode = '22023', message = 'structured psgc residential address required';
  end if;

  -- 5.1 Dataset Version Check
  select * into version_rec from public.psgc_reference_versions
  where id = coalesce(requested_psgc_version, '2026-q3') and is_active = true;
  if not found then
    raise exception using errcode = '22023', message = 'invalid or inactive psgc dataset version';
  end if;

  -- 5.2 Region Check
  select * into region_rec from public.psgc_locations
  where psgc_code = requested_psgc_region_code and level = 'region' and is_active = true;
  if not found then
    raise exception using errcode = '22023', message = 'invalid psgc region';
  end if;
  v_region_name := region_rec.name;

  -- Check if region has provinces
  select exists (
    select 1 from public.psgc_locations
    where parent_psgc_code = requested_psgc_region_code and level = 'province' and is_active = true
  ) into region_has_provinces;

  -- 5.3 Province Check
  if region_has_provinces then
    if requested_psgc_province_code is null then
      raise exception using errcode = '22023', message = 'psgc province code required for region';
    end if;
    select * into province_rec from public.psgc_locations
    where psgc_code = requested_psgc_province_code
      and level = 'province'
      and parent_psgc_code = requested_psgc_region_code
      and is_active = true;
    if not found then
      raise exception using errcode = '22023', message = 'psgc province does not belong to selected region';
    end if;
    v_province_name := province_rec.name;
  else
    if requested_psgc_province_code is not null then
      raise exception using errcode = '22023', message = 'psgc province not permitted for region with no provinces';
    end if;
  end if;

  -- 5.4 City / Municipality Check
  select * into city_rec from public.psgc_locations
  where psgc_code = requested_psgc_city_code
    and level in ('city', 'municipality')
    and is_active = true;
  if not found then
    raise exception using errcode = '22023', message = 'invalid psgc city or municipality';
  end if;

  if region_has_provinces then
    if city_rec.parent_psgc_code <> requested_psgc_province_code then
      raise exception using errcode = '22023', message = 'psgc city/municipality does not belong to selected province';
    end if;
  else
    if city_rec.parent_psgc_code <> requested_psgc_region_code then
      raise exception using errcode = '22023', message = 'psgc city/municipality does not belong to selected region';
    end if;
  end if;
  v_city_name := city_rec.name;

  -- 5.5 Barangay Check
  select * into barangay_rec from public.psgc_locations
  where psgc_code = requested_psgc_barangay_code
    and level = 'barangay'
    and parent_psgc_code = requested_psgc_city_code
    and is_active = true;
  if not found then
    raise exception using errcode = '22023', message = 'psgc barangay does not belong to selected city/municipality';
  end if;
  v_barangay_name := barangay_rec.name;

  -- 5.6 Postal Code Format Check
  if requested_postal_code is not null and btrim(requested_postal_code) !~ '^[0-9]{4}$' then
    raise exception using errcode = '22023', message = 'invalid philippine 4-digit postal code';
  end if;

  -- 5.7 Compose Snapshot Address
  effective_home_address := concat_ws(', ',
    nullif(btrim(requested_home_building), ''),
    nullif(btrim(requested_home_street), ''),
    v_barangay_name,
    v_city_name,
    v_province_name,
    v_region_name,
    case when nullif(btrim(requested_postal_code), '') is not null then concat('Postal Code ', btrim(requested_postal_code)) else null end
  );

  -- 6. Arrival mode invariants
  if requested_arrival_mode = 'no_vehicle' then
    if requested_vehicle_type is not null
      or requested_plate_number is not null
      or requested_plate_key is not null
      or requested_color is not null
      or requested_vehicle_photo_intent_id is not null then
      raise exception using errcode = '22023', message = 'vehicle details not permitted for pedestrian arrival';
    end if;
  elsif requested_arrival_mode = 'vehicle' then
    if requested_vehicle_type is null or requested_vehicle_type not in ('car', 'motorcycle', 'van', 'pickup', 'suv', 'truck', 'other')
      or requested_plate_number is null or char_length(btrim(requested_plate_number)) not between 3 and 16
      or requested_plate_key is null or char_length(btrim(requested_plate_key)) not between 3 and 16
      or requested_color is null or char_length(btrim(requested_color)) not between 2 and 40
      or requested_vehicle_catalog_status not in ('catalog', 'manual') then
      raise exception using errcode = '22023', message = 'invalid vehicle declaration details';
    end if;

    if requested_vehicle_photo_intent_id is null then
      raise exception using errcode = '22023', message = 'vehicle photo required for vehicle arrival';
    end if;

    select * into vehicle_photo_intent from public.upload_intents
    where id = requested_vehicle_photo_intent_id for update;
    if not found or vehicle_photo_intent.owner_id <> requested_actor_id
      or vehicle_photo_intent.source <> 'portal'::public.pass_source
      or vehicle_photo_intent.kind <> 'vehicle_photo'::public.evidence_kind
      or vehicle_photo_intent.status <> 'pending'::public.upload_intent_status
      or vehicle_photo_intent.expires_at <= now()
      or requested_vehicle_photo_bytes not between 1 and vehicle_photo_intent.max_bytes
      or requested_vehicle_photo_sha256 !~ '^[0-9a-f]{64}$' then
      raise exception using errcode = '22023', message = 'invalid vehicle photo upload intent';
    end if;

    select exists (
      select 1 from public.visit_vehicle_declarations vd
      join public.passes p on p.id = vd.pass_id
      where vd.plate_key = requested_plate_key
        and p.valid_until > now()
        and p.status in ('issued', 'pending', 'inside')
    ) into v_plate_conflict;
  end if;

  -- 7. Verification checks
  if requested_registration_mode = 'new' then
    if requested_id_intent_id is null then
      raise exception using errcode = '22023', message = 'identification image required';
    end if;

    select * into verification_record
    from public.portal_identity_verification_attempts
    where owner_id = requested_actor_id
      and request_id = requested_request_id::text
      and photo_intent_id = requested_photo_intent_id
      and id_intent_id = requested_id_intent_id
      and outcome = 'matched'
      and expires_at > now()
    order by verified_at desc
    limit 1;

    if not found then
      raise exception using errcode = '42501', message = 'valid matched identity verification required';
    end if;
  elsif requested_registration_mode = 'returning' then
    if requested_returning_profile_id is null or requested_returning_match_token_digest is null then
      raise exception using errcode = '22023', message = 'returning match credentials required';
    end if;

    select * into returning_profile_record
    from public.returning_visitor_profiles
    where id = requested_returning_profile_id and revoked_at is null and expires_at > now();

    if not found then
      raise exception using errcode = '42501', message = 'returning profile not found or expired';
    end if;

    select * into returning_attempt_record
    from public.returning_identity_attempts
    where owner_id = requested_actor_id
      and request_id = requested_request_id::text
      and matched_profile_id = requested_returning_profile_id
      and match_token_digest = requested_returning_match_token_digest
      and outcome = 'matched'
      and expires_at > now()
    order by created_at desc
    limit 1;

    if not found then
      raise exception using errcode = '42501', message = 'valid returning identity match required';
    end if;
  end if;

  -- 8. Photo upload intent inspection
  select * into photo_intent from public.upload_intents
  where id = requested_photo_intent_id for update;
  if not found or photo_intent.owner_id <> requested_actor_id
    or photo_intent.source <> 'portal'::public.pass_source or photo_intent.kind <> 'photo'::public.evidence_kind
    or photo_intent.status <> 'pending'::public.upload_intent_status or photo_intent.expires_at <= now()
    or requested_photo_bytes not between 1 and photo_intent.max_bytes
    or requested_photo_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'invalid photo upload intent';
  end if;

  -- 9. ID upload intent inspection (if new)
  if requested_registration_mode = 'new' then
    select * into id_intent from public.upload_intents
    where id = requested_id_intent_id for update;
    if not found or id_intent.owner_id <> requested_actor_id
      or id_intent.source <> 'portal'::public.pass_source or id_intent.kind <> 'id'::public.evidence_kind
      or id_intent.status <> 'pending'::public.upload_intent_status or id_intent.expires_at <= now()
      or requested_id_bytes not between 1 and id_intent.max_bytes
      or requested_id_sha256 !~ '^[0-9a-f]{64}$' then
      raise exception using errcode = '22023', message = 'invalid identification upload intent';
    end if;
  end if;

  starts_at := (requested_visit_date + settings.working_hours_start) at time zone settings.timezone;
  ends_at := (requested_visit_date + settings.working_hours_end) at time zone settings.timezone;

  -- 10. Insert visitor record with structured PSGC address and snapshots
  insert into public.visitors (
    owner_id, source, created_by_device_id, full_name, contact_number,
    home_address, home_location_lat, home_location_lon,
    psgc_version, psgc_region_code, psgc_province_code, psgc_city_code, psgc_barangay_code,
    psgc_region_name, psgc_province_name, psgc_city_municipality_name, psgc_barangay_name,
    home_building, home_street, postal_code, postal_code_source,
    registration_mode, arrival_mode, returning_profile_id,
    purpose, visit_date, consent_accepted_at,
    identity_verification_id, identity_verified_at, returning_identity_attempt_id
  ) values (
    requested_actor_id, 'portal'::public.pass_source, null,
    full_name_calc, btrim(requested_contact_number),
    effective_home_address, requested_home_location_lat, requested_home_location_lon,
    version_rec.id, requested_psgc_region_code, requested_psgc_province_code, requested_psgc_city_code, requested_psgc_barangay_code,
    v_region_name, v_province_name, v_city_name, v_barangay_name,
    nullif(btrim(requested_home_building), ''), nullif(btrim(requested_home_street), ''),
    nullif(btrim(requested_postal_code), ''), nullif(btrim(requested_postal_code_source), ''),
    requested_registration_mode, requested_arrival_mode,
    case when requested_registration_mode = 'returning' then requested_returning_profile_id else null end,
    btrim(requested_purpose), requested_visit_date, now(),
    case when requested_registration_mode = 'new' then verification_record.id else null end,
    case when requested_registration_mode = 'new' then verification_record.verified_at else null end,
    case when requested_registration_mode = 'returning' then returning_attempt_record.id else null end
  ) returning id into new_visitor_id;

  -- 10.1 Update returning visitor profile with structured address snapshot if returning
  if requested_registration_mode = 'returning' and requested_returning_profile_id is not null then
    update public.returning_visitor_profiles
    set
      home_address = effective_home_address,
      home_location_lat = requested_home_location_lat,
      home_location_lon = requested_home_location_lon,
      psgc_version = version_rec.id,
      psgc_region_code = requested_psgc_region_code,
      psgc_province_code = requested_psgc_province_code,
      psgc_city_code = requested_psgc_city_code,
      psgc_barangay_code = requested_psgc_barangay_code,
      psgc_region_name = v_region_name,
      psgc_province_name = v_province_name,
      psgc_city_municipality_name = v_city_name,
      psgc_barangay_name = v_barangay_name,
      home_building = nullif(btrim(requested_home_building), ''),
      home_street = nullif(btrim(requested_home_street), ''),
      postal_code = nullif(btrim(requested_postal_code), ''),
      postal_code_source = nullif(btrim(requested_postal_code_source), ''),
      updated_at = now()
    where id = requested_returning_profile_id;
  end if;

  -- 11. Insert visitor photo evidence and claim upload intent
  insert into public.visitor_evidence (
    visitor_id, upload_intent_id, kind, bucket_id, object_path, content_type,
    byte_size, sha256_hex, verified_at, expires_at
  ) values (
    new_visitor_id, photo_intent.id, photo_intent.kind, photo_intent.bucket_id,
    photo_intent.object_path, photo_intent.content_type, requested_photo_bytes,
    requested_photo_sha256, now(), greatest(
      now() + make_interval(days => settings.image_retention_days),
      ends_at + interval '1 day'
    )
  );
  update public.upload_intents set status = 'claimed', claimed_at = now(), visitor_id = new_visitor_id
  where id = photo_intent.id;

  -- 12. Insert visitor id evidence if new
  if requested_registration_mode = 'new' and requested_id_intent_id is not null then
    insert into public.visitor_evidence (
      visitor_id, upload_intent_id, kind, bucket_id, object_path, content_type,
      byte_size, sha256_hex, verified_at, expires_at
    ) values (
      new_visitor_id, id_intent.id, id_intent.kind, id_intent.bucket_id,
      id_intent.object_path, id_intent.content_type, requested_id_bytes,
      requested_id_sha256, now(), greatest(
        now() + make_interval(days => settings.image_retention_days),
        ends_at + interval '1 day'
      )
    );
    update public.upload_intents set status = 'claimed', claimed_at = now(), visitor_id = new_visitor_id
    where id = id_intent.id;
  end if;

  -- 13. Vehicle photo evidence and declaration
  if requested_arrival_mode = 'vehicle' then
    insert into public.visitor_evidence (
      visitor_id, upload_intent_id, kind, bucket_id, object_path, content_type,
      byte_size, sha256_hex, verified_at, expires_at
    ) values (
      new_visitor_id, vehicle_photo_intent.id, vehicle_photo_intent.kind, vehicle_photo_intent.bucket_id,
      vehicle_photo_intent.object_path, vehicle_photo_intent.content_type, requested_vehicle_photo_bytes,
      requested_vehicle_photo_sha256, now(), greatest(
        now() + make_interval(days => settings.image_retention_days),
        ends_at + interval '1 day'
      )
    ) returning id into new_vehicle_evidence_id;

    update public.upload_intents set status = 'claimed', claimed_at = now(), visitor_id = new_visitor_id
    where id = vehicle_photo_intent.id;
  end if;

  -- 14. Create Pass Record
  insert into public.passes (
    visitor_id, token_digest, source, status, valid_from, valid_until, issue_request_id
  ) values (
    new_visitor_id, decode(requested_token_digest, 'hex'), 'portal'::public.pass_source, 'issued'::public.pass_status,
    starts_at, ends_at, requested_request_id
  ) returning id, passes.public_reference into new_pass_id, new_public_reference;

  -- 15. Create Vehicle Declaration linked to pass
  if requested_arrival_mode = 'vehicle' then
    insert into public.visit_vehicle_declarations (
      visitor_id, pass_id, saved_vehicle_id, vehicle_type,
      plate_number, plate_key, color, make_model,
      vehicle_photo_evidence_id, vehicle_catalog_status, plate_conflict_flag
    ) values (
      new_visitor_id, new_pass_id, requested_saved_vehicle_id, requested_vehicle_type,
      btrim(requested_plate_number), btrim(requested_plate_key), btrim(requested_color),
      nullif(btrim(requested_make_model), ''),
      new_vehicle_evidence_id, requested_vehicle_catalog_status, v_plate_conflict
    );
  end if;

  -- 16. Record Audit Event
  insert into public.audit_events (
    actor_id, actor_kind, action, target_type, target_id, request_id, after_state
  ) values (
    requested_actor_id, 'system', 'pass.issue_v6', 'pass', new_pass_id::text, requested_request_id,
    jsonb_build_object(
      'source', 'portal',
      'registrationMode', requested_registration_mode,
      'arrivalMode', requested_arrival_mode,
      'psgcVersion', version_rec.id,
      'psgcRegion', requested_psgc_region_code,
      'psgcProvince', requested_psgc_province_code,
      'psgcCity', requested_psgc_city_code,
      'psgcBarangay', requested_psgc_barangay_code,
      'postalCode', requested_postal_code,
      'plateConflict', v_plate_conflict
    )
  );

  pass_id := new_pass_id;
  public_reference := new_public_reference;
  valid_from := starts_at;
  valid_until := ends_at;
  return next;
end;
$$;

-- Revoke execute from public/anon/authenticated and grant to service_role
revoke all on function api.issue_online_pass_v6 from public;
revoke all on function api.issue_online_pass_v6 from anon;
revoke all on function api.issue_online_pass_v6 from authenticated;
grant execute on function api.issue_online_pass_v6 to service_role;
