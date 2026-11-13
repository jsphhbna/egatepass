-- ==============================================================================
-- Migration 94: PSGC Full Reconciliation (Quezon City 142 Barangays, Pasig, Navotas)
-- ==============================================================================

begin;

-- 1. Clean up stale/mismatched references in postal_code_reference
delete from public.postal_code_reference
where psgc_locality_code in ('1381200000', '1381300000', '1381600000', '1380900000', '1380400000')
   or barangay_psgc_code like '13812%'
   or barangay_psgc_code like '13813%'
   or barangay_psgc_code like '13816%'
   or barangay_psgc_code like '13809%'
   or barangay_psgc_code like '13804%';

-- 2. Clean up child barangays in psgc_locations
delete from public.psgc_locations
where parent_psgc_code in ('1381200000', '1381300000', '1381600000', '1380900000', '1380400000');

-- 3. Delete old city rows to allow clean key realignment
delete from public.psgc_locations
where psgc_code in ('1381200000', '1381300000', '1381600000', '1380900000', '1380400000');

-- 4. Insert reconciled cities
insert into public.psgc_locations (psgc_code, parent_psgc_code, name, level, location_type, reference_version_id, is_active)
values
  ('1381300000', '1300000000', 'Quezon City', 'city', 'huc', '2026-q3', true),
  ('1381200000', '1300000000', 'City of Pasig', 'city', 'huc', '2026-q3', true),
  ('1380900000', '1300000000', 'City of Navotas', 'city', 'huc', '2026-q3', true),
  ('1380400000', '1300000000', 'City of Malabon', 'city', 'huc', '2026-q3', true);

-- 5. Insert all 142 official PSA Quezon City barangays (1381300001 - 1381300142)
insert into public.psgc_locations (psgc_code, parent_psgc_code, name, level, location_type, reference_version_id, is_active)
values
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
  ('1381300129', '1381300000', 'Vasra', 'barangay', 'barangay', '2026-q3', true),
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
  ('1381300142', '1381300000', 'North Fairview', 'barangay', 'barangay', '2026-q3', true);

-- 6. Insert all 30 official PSA Pasig City barangays (1381200001 - 1381200030)
insert into public.psgc_locations (psgc_code, parent_psgc_code, name, level, location_type, reference_version_id, is_active)
values
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
  ('1381200023', '1381200000', 'San Nicolas (Pob.)', 'barangay', 'barangay', '2026-q3', true),
  ('1381200024', '1381200000', 'Santa Cruz', 'barangay', 'barangay', '2026-q3', true),
  ('1381200025', '1381200000', 'Santa Rosa', 'barangay', 'barangay', '2026-q3', true),
  ('1381200026', '1381200000', 'Santo Tomas', 'barangay', 'barangay', '2026-q3', true),
  ('1381200027', '1381200000', 'Santolan', 'barangay', 'barangay', '2026-q3', true),
  ('1381200028', '1381200000', 'Sumilang', 'barangay', 'barangay', '2026-q3', true),
  ('1381200029', '1381200000', 'Ugong', 'barangay', 'barangay', '2026-q3', true),
  ('1381200030', '1381200000', 'Santa Lucia', 'barangay', 'barangay', '2026-q3', true);

-- 7. Insert all 18 official PSA Navotas City barangays (1380900001 - 1380900018)
insert into public.psgc_locations (psgc_code, parent_psgc_code, name, level, location_type, reference_version_id, is_active)
values
  ('1380900001', '1380900000', 'Sipac-Almacen', 'barangay', 'barangay', '2026-q3', true),
  ('1380900002', '1380900000', 'Bagumbayan North', 'barangay', 'barangay', '2026-q3', true),
  ('1380900003', '1380900000', 'Bagumbayan South', 'barangay', 'barangay', '2026-q3', true),
  ('1380900004', '1380900000', 'Bangculasi', 'barangay', 'barangay', '2026-q3', true),
  ('1380900005', '1380900000', 'Daanghari', 'barangay', 'barangay', '2026-q3', true),
  ('1380900006', '1380900000', 'Navotas East', 'barangay', 'barangay', '2026-q3', true),
  ('1380900007', '1380900000', 'Navotas West', 'barangay', 'barangay', '2026-q3', true),
  ('1380900008', '1380900000', 'North Bay Boulevard North', 'barangay', 'barangay', '2026-q3', true),
  ('1380900009', '1380900000', 'NBBS Kaunlaran', 'barangay', 'barangay', '2026-q3', true),
  ('1380900010', '1380900000', 'San Jose (Pob.)', 'barangay', 'barangay', '2026-q3', true),
  ('1380900011', '1380900000', 'San Rafael Village', 'barangay', 'barangay', '2026-q3', true),
  ('1380900012', '1380900000', 'San Roque', 'barangay', 'barangay', '2026-q3', true),
  ('1380900013', '1380900000', 'Tangos South', 'barangay', 'barangay', '2026-q3', true),
  ('1380900014', '1380900000', 'Tanza 1', 'barangay', 'barangay', '2026-q3', true),
  ('1380900015', '1380900000', 'NBBS Dagat-dagatan', 'barangay', 'barangay', '2026-q3', true),
  ('1380900016', '1380900000', 'NBBS Proper', 'barangay', 'barangay', '2026-q3', true),
  ('1380900017', '1380900000', 'Tangos North', 'barangay', 'barangay', '2026-q3', true),
  ('1380900018', '1380900000', 'Tanza 2', 'barangay', 'barangay', '2026-q3', true);

-- 8. Re-insert official postal code references for QC, Pasig, Navotas
insert into public.postal_code_reference (
  postal_code, region_name, province_name, locality_name, psgc_locality_code,
  barangay_psgc_code, mapping_type, mapping_status, source_name, source_url, source_version, is_active
)
values
  ('1106', 'National Capital Region (NCR)', null, 'Quezon City', '1381300000', '1381300005', 'exact_barangay', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1105', 'National Capital Region (NCR)', null, 'Quezon City', '1381300000', '1381300001', 'exact_barangay', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1113', 'National Capital Region (NCR)', null, 'Quezon City', '1381300000', '1381300004', 'exact_barangay', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1126', 'National Capital Region (NCR)', null, 'Quezon City', '1381300000', null, 'multi_code_city', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1605', 'National Capital Region (NCR)', null, 'City of Pasig', '1381200000', null, 'multi_code_city', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1485', 'National Capital Region (NCR)', null, 'City of Navotas', '1380900000', null, 'unique_city', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true);

commit;
