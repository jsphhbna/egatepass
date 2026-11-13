-- ==============================================================================
-- Migration 100: Comprehensive Reconciliation of Postal Codes, Visit Requests & Decisions
-- ==============================================================================
-- 1. Inserts all reconciled NCR postal codes into public.postal_code_reference
--    including exact barangay mapping for EARIST Campus (1008 -> 1380600408).
-- 2. Ensures EARIST Campus canonical name in psgc_locations for 1380600408 and 1380606014.
-- 3. Canonical api.create_specific_person_visit_request with proper precedence,
--    idempotency actor mismatch check, provisional returning mode, and vehicle checks.
-- 4. Canonical api.decide_office_visit with campus_calendar_closures and fail-closed hold checks.
-- ==============================================================================

begin;

-- 1. Ensure EARIST Campus canonical names in psgc_locations
update public.psgc_locations
set name = 'Barangay 408 (Zone 42 / EARIST Campus)'
where psgc_code in ('1380600408', '1380606014');

-- 2. Clean up NCR postal code references to prevent duplicate key conflicts
delete from public.postal_code_reference
where psgc_locality_code like '13%' or barangay_psgc_code like '13%';

-- 3. Insert all 82 reconciled NCR postal code references
insert into public.postal_code_reference (
  postal_code, region_name, province_name, locality_name, psgc_locality_code, barangay_psgc_code,
  mapping_type, mapping_status, source_name, source_url, source_version, is_active
)
values
  ('1008', 'National Capital Region (NCR)', null, 'City of Manila', '1380600000', '1380600408', 'exact_barangay', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1008', 'National Capital Region (NCR)', null, 'City of Manila', '1380600000', '1380606014', 'exact_barangay', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1008', 'National Capital Region (NCR)', null, 'City of Manila', '1380600000', '1380606015', 'exact_barangay', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1008', 'National Capital Region (NCR)', null, 'City of Manila', '1380600000', '1380606016', 'exact_barangay', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1008', 'National Capital Region (NCR)', null, 'City of Manila', '1380600000', '1380606017', 'exact_barangay', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1008', 'National Capital Region (NCR)', null, 'City of Manila', '1380600000', '1380606018', 'exact_barangay', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1008', 'National Capital Region (NCR)', null, 'City of Manila', '1380600000', '1380606019', 'exact_barangay', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1008', 'National Capital Region (NCR)', null, 'City of Manila', '1380600000', '1380606020', 'exact_barangay', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1008', 'National Capital Region (NCR)', null, 'City of Manila', '1380600000', '1380606021', 'exact_barangay', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1016', 'National Capital Region (NCR)', null, 'City of Manila', '1380600000', '1380606193', 'exact_barangay', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1016', 'National Capital Region (NCR)', null, 'City of Manila', '1380600000', '1380606195', 'exact_barangay', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1016', 'National Capital Region (NCR)', null, 'City of Manila', '1380600000', '1380606236', 'exact_barangay', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1011', 'National Capital Region (NCR)', null, 'City of Manila', '1380600000', '1380611045', 'exact_barangay', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1011', 'National Capital Region (NCR)', null, 'City of Manila', '1380600000', '1380611046', 'exact_barangay', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1000', 'National Capital Region (NCR)', null, 'City of Manila', '1380600000', '1380608001', 'exact_barangay', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1000', 'National Capital Region (NCR)', null, 'City of Manila', '1380600000', '1380608003', 'exact_barangay', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1000', 'National Capital Region (NCR)', null, 'City of Manila', '1380600000', '1380608005', 'exact_barangay', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1000', 'National Capital Region (NCR)', null, 'City of Manila', '1380600000', '1380608009', 'exact_barangay', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1004', 'National Capital Region (NCR)', null, 'City of Manila', '1380600000', '1380610011', 'exact_barangay', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1004', 'National Capital Region (NCR)', null, 'City of Manila', '1380600000', '1380610012', 'exact_barangay', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1004', 'National Capital Region (NCR)', null, 'City of Manila', '1380600000', '1380610015', 'exact_barangay', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1007', 'National Capital Region (NCR)', null, 'City of Manila', '1380600000', '1380611036', 'exact_barangay', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1007', 'National Capital Region (NCR)', null, 'City of Manila', '1380600000', '1380611037', 'exact_barangay', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1007', 'National Capital Region (NCR)', null, 'City of Manila', '1380600000', '1380611038', 'exact_barangay', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1006', 'National Capital Region (NCR)', null, 'City of Manila', '1380600000', '1380602001', 'exact_barangay', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1014', 'National Capital Region (NCR)', null, 'City of Manila', '1380600000', '1380603015', 'exact_barangay', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1126', 'National Capital Region (NCR)', null, 'Quezon City', '1381300000', '1381200001', 'exact_barangay', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1121', 'National Capital Region (NCR)', null, 'Quezon City', '1381300000', '1381200002', 'exact_barangay', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1127', 'National Capital Region (NCR)', null, 'Quezon City', '1381300000', '1381200003', 'exact_barangay', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1119', 'National Capital Region (NCR)', null, 'Quezon City', '1381300000', '1381200004', 'exact_barangay', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1119', 'National Capital Region (NCR)', null, 'Quezon City', '1381300000', '1381200005', 'exact_barangay', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1101', 'National Capital Region (NCR)', null, 'Quezon City', '1381300000', '1381200006', 'exact_barangay', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1108', 'National Capital Region (NCR)', null, 'Quezon City', '1381300000', '1381200007', 'exact_barangay', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1109', 'National Capital Region (NCR)', null, 'Quezon City', '1381300000', '1381200008', 'exact_barangay', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1103', 'National Capital Region (NCR)', null, 'Quezon City', '1381300000', '1381200009', 'exact_barangay', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1103', 'National Capital Region (NCR)', null, 'Quezon City', '1381300000', '1381200010', 'exact_barangay', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1100', 'National Capital Region (NCR)', null, 'Quezon City', '1381300000', '1381200011', 'exact_barangay', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1116', 'National Capital Region (NCR)', null, 'Quezon City', '1381300000', '1381200012', 'exact_barangay', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1209', 'National Capital Region (NCR)', null, 'City of Makati', '1380300000', '1380800001', 'exact_barangay', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1210', 'National Capital Region (NCR)', null, 'City of Makati', '1380300000', '1380800002', 'exact_barangay', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1223', 'National Capital Region (NCR)', null, 'City of Makati', '1380300000', '1380800003', 'exact_barangay', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1203', 'National Capital Region (NCR)', null, 'City of Makati', '1380300000', '1380800004', 'exact_barangay', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1230', 'National Capital Region (NCR)', null, 'City of Makati', '1380300000', '1380800005', 'exact_barangay', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1235', 'National Capital Region (NCR)', null, 'City of Makati', '1380300000', '1380800006', 'exact_barangay', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1634', 'National Capital Region (NCR)', null, 'City of Taguig', '1381500000', '1381500001', 'exact_barangay', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1630', 'National Capital Region (NCR)', null, 'City of Taguig', '1381500000', '1381500002', 'exact_barangay', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1630', 'National Capital Region (NCR)', null, 'City of Taguig', '1381500000', '1381500003', 'exact_barangay', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1632', 'National Capital Region (NCR)', null, 'City of Taguig', '1381500000', '1381500004', 'exact_barangay', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1605', 'National Capital Region (NCR)', null, 'City of Pasig', '1381200000', '1381600001', 'exact_barangay', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1603', 'National Capital Region (NCR)', null, 'City of Pasig', '1381200000', '1381600002', 'exact_barangay', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1604', 'National Capital Region (NCR)', null, 'City of Pasig', '1381200000', '1381600003', 'exact_barangay', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1609', 'National Capital Region (NCR)', null, 'City of Pasig', '1381200000', '1381600004', 'exact_barangay', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1550', 'National Capital Region (NCR)', null, 'City of Mandaluyong', '1380500000', null, 'unique_city', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1400', 'National Capital Region (NCR)', null, 'City of Caloocan', '1380100000', '1380300001', 'exact_barangay', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1400', 'National Capital Region (NCR)', null, 'City of Caloocan', '1380100000', '1380300002', 'exact_barangay', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1421', 'National Capital Region (NCR)', null, 'City of Caloocan', '1380100000', '1380100171', 'exact_barangay', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1428', 'National Capital Region (NCR)', null, 'City of Caloocan', '1380100000', null, 'multi_code_city', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1300', 'National Capital Region (NCR)', null, 'Pasay City', '1381100000', '1381500001', 'exact_barangay', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1308', 'National Capital Region (NCR)', null, 'Pasay City', '1381100000', '1381100076', 'exact_barangay', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1309', 'National Capital Region (NCR)', null, 'Pasay City', '1381100000', '1381100183', 'exact_barangay', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1709', 'National Capital Region (NCR)', null, 'City of Parañaque', '1381000000', '1381400001', 'exact_barangay', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1707', 'National Capital Region (NCR)', null, 'City of Parañaque', '1381000000', '1381400002', 'exact_barangay', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1711', 'National Capital Region (NCR)', null, 'City of Parañaque', '1381000000', '1381400003', 'exact_barangay', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1702', 'National Capital Region (NCR)', null, 'City of Parañaque', '1381000000', '1381400004', 'exact_barangay', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1780', 'National Capital Region (NCR)', null, 'City of Muntinlupa', '1380800000', '1381100001', 'exact_barangay', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1799', 'National Capital Region (NCR)', null, 'City of Muntinlupa', '1380800000', '1381100002', 'exact_barangay', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1772', 'National Capital Region (NCR)', null, 'City of Muntinlupa', '1380800000', '1381100003', 'exact_barangay', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1807', 'National Capital Region (NCR)', null, 'City of Marikina', '1380700000', '1381000001', 'exact_barangay', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1810', 'National Capital Region (NCR)', null, 'City of Marikina', '1380700000', '1381000002', 'exact_barangay', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1803', 'National Capital Region (NCR)', null, 'City of Marikina', '1380700000', '1381000003', 'exact_barangay', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1443', 'National Capital Region (NCR)', null, 'City of Valenzuela', '1381600000', '1381600001', 'exact_barangay', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1444', 'National Capital Region (NCR)', null, 'City of Valenzuela', '1381600000', '1381600002', 'exact_barangay', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1448', 'National Capital Region (NCR)', null, 'City of Valenzuela', '1381600000', '1381600003', 'exact_barangay', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1742', 'National Capital Region (NCR)', null, 'City of Las Piñas', '1380200000', '1380500001', 'exact_barangay', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1747', 'National Capital Region (NCR)', null, 'City of Las Piñas', '1380200000', '1380500002', 'exact_barangay', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1502', 'National Capital Region (NCR)', null, 'City of San Juan', '1381400000', '1381400001', 'exact_barangay', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1504', 'National Capital Region (NCR)', null, 'City of San Juan', '1381400000', '1381400002', 'exact_barangay', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1475', 'National Capital Region (NCR)', null, 'City of Malabon', '1380400000', '1380900001', 'exact_barangay', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1477', 'National Capital Region (NCR)', null, 'City of Malabon', '1380400000', '1380900002', 'exact_barangay', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1485', 'National Capital Region (NCR)', null, 'City of Navotas', '1380900000', '1381300001', 'exact_barangay', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1489', 'National Capital Region (NCR)', null, 'City of Navotas', '1380900000', '1381300002', 'exact_barangay', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true),
  ('1620', 'National Capital Region (NCR)', null, 'Municipality of Pateros', '1381700000', null, 'unique_city', 'verified', 'PHLPost', 'https://phlpost.gov.ph/zip-code-locator/', '2026-q3', true);

-- 4. Re-declare api.create_specific_person_visit_request
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
  v_home_addr text;
  v_expected_gate text;
  v_normalized_email text;
  new_public_ref uuid := null;
  v_from timestamptz := null;
  v_until timestamptz := null;
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

  select * into existing_visit from public.office_visits ov
  where ov.request_id = requested_request_id;
  if found then
    if existing_visit.visitor_actor_id <> requested_actor_id then
      raise exception using errcode = '42501', message = 'request_id_actor_mismatch';
    end if;

    select ovo.encrypted_tracking_token into v_existing_encrypted_token
    from public.office_visit_acknowledgement_outbox ovo
    where ovo.office_visit_id = existing_visit.id
    order by ovo.created_at desc limit 1;

    if existing_visit.pass_id is not null then
      select p.public_reference, p.valid_from, p.valid_until
      into new_public_ref, v_from, v_until
      from public.passes p where p.id = existing_visit.pass_id;
    end if;

    return query select
      existing_visit.id,
      existing_visit.request_id,
      existing_visit.approval_status,
      existing_visit.attendance_status,
      coalesce(v_existing_encrypted_token, requested_encrypted_tracking_token),
      existing_visit.pass_id,
      new_public_ref,
      v_from,
      v_until,
      existing_visit.decision_source,
      existing_visit.office_requires_approval_snapshot;
    return;
  end if;

  -- 1. Check office existence and active status
  select * into target_office from public.offices
  where id = requested_office_id and archived_at is null;
  if not found or not target_office.active then
    raise exception using errcode = '22023', message = 'office_not_found_or_inactive';
  end if;

  -- 2. Check date horizon
  select * into settings from public.app_settings where singleton for share;
  v_manila_today := (now() at time zone coalesce(settings.timezone, 'Asia/Manila'))::date;
  v_max_date := v_manila_today + coalesce(settings.scheduling_days_ahead, 14);

  if requested_visit_date is null then
    raise exception using errcode = '22023', message = 'invalid_visit_date';
  end if;
  if requested_visit_date < v_manila_today then
    raise exception using errcode = '22023', message = 'visit_date_in_past';
  end if;
  if requested_visit_date > v_max_date then
    raise exception using errcode = '22023', message = 'visit_date_beyond_horizon';
  end if;

  -- 3. Check campus closures
  select title into target_closure_title from public.campus_calendar_closures
  where active = true and published = true
    and requested_visit_date between start_date and end_date
  limit 1;
  if target_closure_title is not null then
    raise exception 'visit_date_closed: %', target_closure_title using errcode = '22023';
  end if;

  -- 4. Check office publication status
  if target_office.publication_status <> 'published' then
    raise exception using errcode = '22023', message = 'office_not_found_or_unpublished';
  end if;

  -- 5. Check personnel if specified
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

  -- 6. Check office calendar schedules on date
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

  -- Vehicle validation
  if requested_arrival_mode = 'vehicle' then
    if requested_vehicle_details is null or (requested_vehicle_details->>'plateNumber') is null then
      raise exception using errcode = '22023', message = 'vehicle_details_required';
    end if;
    v_plate_key := upper(regexp_replace(requested_vehicle_details->>'plateNumber', '[^a-zA-Z0-9]', '', 'g'));
    if char_length(v_plate_key) < 3 then
      raise exception using errcode = '22023', message = 'invalid_plate_number';
    end if;

    if exists (
      select 1 from public.visit_vehicle_declarations vvd
      join public.passes p on p.id = vvd.pass_id
      where vvd.plate_key = v_plate_key
        and (vvd.entry_recorded_at is not null and vvd.exit_recorded_at is null or p.status in ('inside'))
    ) then
      raise exception using errcode = '40900', message = 'plate_already_active_on_campus';
    end if;
  elsif requested_arrival_mode = 'no_vehicle' then
    if requested_vehicle_details is not null or requested_vehicle_photo_intent_id is not null then
      raise exception using errcode = '22023', message = 'unexpected_vehicle_details';
    end if;
  else
    raise exception using errcode = '22023', message = 'invalid_arrival_mode';
  end if;

  if requested_registration_mode = 'new' then
    if requested_photo_intent_id is null or requested_id_intent_id is null then
      raise exception using errcode = '22023', message = 'intents_required_for_new_registration';
    end if;

    select * into photo_intent from public.upload_intents
    where id = requested_photo_intent_id and owner_id = requested_actor_id and kind = 'photo' and status in ('pending', 'uploaded');
    if not found then
      raise exception using errcode = '22023', message = 'invalid_photo_upload_intent';
    end if;

    select * into id_intent from public.upload_intents
    where id = requested_id_intent_id and owner_id = requested_actor_id and kind = 'id' and status in ('pending', 'uploaded');
    if not found then
      raise exception using errcode = '22023', message = 'invalid_id_upload_intent';
    end if;

    if requested_identity_verification_id is not null then
      select * into verification_record from public.portal_identity_verification_attempts
      where id = requested_identity_verification_id
        and owner_id = requested_actor_id
        and photo_intent_id = requested_photo_intent_id
        and id_intent_id = requested_id_intent_id
        and outcome = 'matched'
        and expires_at > now();
      if found then
        v_bound_verification_id := verification_record.id;
      end if;
    end if;
  elsif requested_registration_mode = 'returning' then
    if requested_returning_profile_id is null or requested_returning_match_token_digest is null then
      raise exception using errcode = '42501', message = 'returning_match_credentials_required';
    end if;

    select * into returning_profile_record
    from public.returning_visitor_profiles
    where id = requested_returning_profile_id and revoked_at is null and expires_at > now();
    if not found then
      raise exception using errcode = '42501', message = 'returning_profile_not_found_or_expired';
    end if;

    select * into returning_attempt_record
    from public.returning_identity_attempts ria
    where ria.owner_id = requested_actor_id
      and ria.request_id = requested_request_id::text
      and ria.matched_profile_id = requested_returning_profile_id
      and ria.match_token_digest = requested_returning_match_token_digest
      and ria.outcome in ('matched', 'provisional_matched')
      and ria.expires_at > now()
    order by ria.created_at desc
    limit 1;
    if not found then
      raise exception using errcode = '42501', message = 'valid_returning_identity_match_required';
    end if;

    v_bound_profile_id := returning_profile_record.id;
    v_bound_returning_id := returning_attempt_record.id;
  else
    raise exception using errcode = '22023', message = 'invalid_registration_mode';
  end if;

  if requested_arrival_mode = 'vehicle' and requested_vehicle_photo_intent_id is not null then
    select * into vehicle_photo_intent from public.upload_intents
    where id = requested_vehicle_photo_intent_id and owner_id = requested_actor_id and kind = 'vehicle_photo' and status in ('pending', 'uploaded');
    if not found then
      raise exception using errcode = '22023', message = 'invalid_vehicle_photo_upload_intent';
    end if;
  end if;

  v_full_name := btrim(concat_ws(' ', nullif(btrim(requested_first_name), ''), nullif(btrim(requested_middle_name), ''), nullif(btrim(requested_last_name), '')));
  v_expected_gate := coalesce(
    nullif(btrim(coalesce(requested_expected_gate, '')), ''),
    nullif(btrim(coalesce(settings.default_expected_gate, '')), ''),
    'Main Gate'
  );

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
    office_requires_approval_snapshot, decision_source, source, expected_gate
  ) values (
    requested_visit_type, requested_office_id, requested_personnel_id, v_effective_person_name,
    'pending'::public.office_approval_status, 'awaiting_entry'::public.office_attendance_status,
    btrim(requested_first_name), nullif(btrim(requested_middle_name), ''), btrim(requested_last_name), v_full_name,
    btrim(requested_contact_number), v_normalized_email, (v_normalized_email is not null),
    requested_actor_id, btrim(requested_purpose), requested_visit_date, requested_arrival_mode,
    requested_vehicle_details, requested_address_details,
    requested_photo_intent_id, requested_photo_bytes, requested_photo_sha256,
    requested_id_intent_id, requested_id_bytes, requested_id_sha256,
    requested_vehicle_photo_intent_id, requested_vehicle_photo_bytes, requested_vehicle_photo_sha256,
    requested_registration_mode, v_bound_profile_id, v_bound_verification_id, v_bound_returning_id,
    requested_request_id, 'pending',
    requested_tracking_token_digest, coalesce(requested_tracking_token_expires_at, now() + interval '30 days'),
    true, null, requested_source, v_expected_gate
  ) returning id into new_visit_id;

  if photo_intent.id is not null or id_intent.id is not null then
    update public.upload_intents
    set held_until = greatest(expires_at, now() + interval '14 days')
    where id in (photo_intent.id, id_intent.id);
  end if;

  if requested_encrypted_tracking_token is not null and v_normalized_email is not null then
    insert into public.office_visit_acknowledgement_outbox (
      office_visit_id, recipient_email, encrypted_tracking_token, idempotency_key, delivery_status
    ) values (
      new_visit_id, v_normalized_email, requested_encrypted_tracking_token, 'office-ack-' || new_visit_id::text, 'pending'
    ) on conflict (office_visit_id) do nothing;
  end if;

  insert into public.office_visit_events (
    office_visit_id, event_type, actor_id, actor_role, metadata
  ) values (
    new_visit_id, 'request_submitted', requested_actor_id,
    case when requested_source = 'kiosk'::public.pass_source then 'device' else 'visitor' end,
    jsonb_build_object(
      'visit_type', requested_visit_type,
      'office_id', requested_office_id,
      'personnel_id', requested_personnel_id,
      'requested_person_name', v_effective_person_name,
      'visit_date', requested_visit_date,
      'office_requires_approval_snapshot', true,
      'source', requested_source
    )
  );

  return query select
    new_visit_id,
    requested_request_id,
    'pending'::public.office_approval_status,
    'awaiting_entry'::public.office_attendance_status,
    requested_encrypted_tracking_token,
    null::uuid,
    null::uuid,
    null::timestamptz,
    null::timestamptz,
    null::text,
    true;
end;
$$;

-- 5. Re-declare api.decide_office_visit with campus_calendar_closures and fail-closed hold checks
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

  if target_visit.approval_status <> 'pending'::public.office_approval_status then
    if target_visit.approval_status::text = requested_decision then
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
    else
      raise exception using errcode = '40900', message = 'visit_already_decided';
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
      jsonb_build_object('reason', btrim(requested_rejection_reason), 'decision_source', 'manual_staff')
    );

    return query select true, 'rejected'::text, null::uuid, null::uuid, null::timestamptz, null::timestamptz, 'Visit rejected.'::text;
    return;
  end if;

  -- APPROVAL FLOW
  select * into target_office from public.offices
  where id = target_visit.office_id and active = true and publication_status = 'published';
  if not found then
    raise exception using errcode = '40900', message = 'office_no_longer_active_or_published';
  end if;

  -- Enforce campus closure check AT APPROVAL TIME
  if exists (
    select 1 from public.campus_calendar_closures
    where active and published and target_visit.visit_date between start_date and end_date
  ) then
    select title into target_closure_title
    from public.campus_calendar_closures
    where active and published and target_visit.visit_date between start_date and end_date
    limit 1;
    raise exception 'visit_date_closed: %', target_closure_title using errcode = 'P0001';
  end if;

  if requested_token_digest is null or requested_token_digest !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'valid_token_digest_required_for_approval';
  end if;
  if target_visit.visitor_actor_id is null then
    raise exception using errcode = '22023', message = 'missing_visitor_actor_identity';
  end if;

  select * into settings from public.app_settings where singleton for share;
  v_manila_today := (now() at time zone coalesce(settings.timezone, 'Asia/Manila'))::date;
  if target_visit.visit_date < v_manila_today then
    update public.office_visits set
      approval_status = 'rejected'::public.office_approval_status,
      attendance_status = 'expired'::public.office_attendance_status,
      rejection_reason = 'Visit date has passed prior to approval.',
      decided_at = now(), decided_by = requested_actor_id, decision_source = 'manual_staff', updated_at = now()
    where id = target_visit.id;
    update public.upload_intents set held_until = null
    where id in (target_visit.photo_intent_id, target_visit.id_intent_id, target_visit.vehicle_photo_intent_id);
    insert into public.office_visit_events (office_visit_id, event_type, actor_id, actor_role, metadata)
    values (target_visit.id, 'rejected', requested_actor_id, actor_profile.role::text,
      jsonb_build_object('reason', 'Visit date has passed prior to approval.', 'code', 'visit_date_expired'));
    return query select false, 'rejected'::text, null::uuid, null::uuid, null::timestamptz, null::timestamptz, 'visit_date_expired'::text;
    return;
  end if;

  v_from := (target_visit.visit_date + settings.working_hours_start) at time zone settings.timezone;
  v_until := (target_visit.visit_date + settings.working_hours_end) at time zone settings.timezone;

  if v_until <= now() then
    update public.office_visits set
      approval_status = 'rejected'::public.office_approval_status,
      attendance_status = 'expired'::public.office_attendance_status,
      rejection_reason = 'Pass validity window has ended for this date.',
      decided_at = now(), decided_by = requested_actor_id, decision_source = 'manual_staff', updated_at = now()
    where id = target_visit.id;
    update public.upload_intents set held_until = null
    where id in (target_visit.photo_intent_id, target_visit.id_intent_id, target_visit.vehicle_photo_intent_id);
    insert into public.office_visit_events (office_visit_id, event_type, actor_id, actor_role, metadata)
    values (target_visit.id, 'rejected', requested_actor_id, actor_profile.role::text,
      jsonb_build_object('reason', 'Pass validity window has ended for this date.', 'code', 'pass_validity_window_ended'));
    return query select false, 'rejected'::text, null::uuid, null::uuid, null::timestamptz, null::timestamptz, 'pass_validity_window_ended'::text;
    return;
  end if;

  if target_visit.registration_mode = 'new' then
    if target_visit.photo_intent_id is null or (target_visit.source = 'portal'::public.pass_source and target_visit.id_intent_id is null) then
      update public.office_visits set
        approval_status = 'rejected'::public.office_approval_status,
        attendance_status = 'expired'::public.office_attendance_status,
        rejection_reason = 'Required photo or ID upload intent is missing.',
        decided_at = now(), decided_by = requested_actor_id, decision_source = 'manual_staff', updated_at = now()
      where id = target_visit.id;
      update public.upload_intents set held_until = null
      where id in (target_visit.photo_intent_id, target_visit.id_intent_id, target_visit.vehicle_photo_intent_id);
      insert into public.office_visit_events (office_visit_id, event_type, actor_id, actor_role, metadata)
      values (target_visit.id, 'rejected', requested_actor_id, actor_profile.role::text,
        jsonb_build_object('reason', 'Required photo or ID upload intent is missing.', 'code', 'missing_required_evidence_intents'));
      return query select false, 'rejected'::text, null::uuid, null::uuid, null::timestamptz, null::timestamptz, 'missing_required_evidence_intents'::text;
      return;
    end if;

    select * into photo_intent from public.upload_intents where id = target_visit.photo_intent_id for update;
    if not found
      or photo_intent.owner_id <> target_visit.visitor_actor_id
      or photo_intent.source <> target_visit.source
      or photo_intent.kind <> 'photo'::public.evidence_kind
      or photo_intent.status not in ('pending'::public.upload_intent_status, 'uploaded'::public.upload_intent_status)
      or (target_visit.source = 'portal'::public.pass_source and photo_intent.status <> 'uploaded'::public.upload_intent_status)
      or photo_intent.expires_at <= now()
      or photo_intent.storage_cleaned_at is not null
      or photo_intent.held_until is null
      or photo_intent.held_until < now()
      or not exists (
        select 1 from storage.objects so
        where so.bucket_id = photo_intent.bucket_id
          and so.name = photo_intent.object_path
      )
      or target_visit.photo_bytes is null
      or target_visit.photo_bytes <= 0
      or target_visit.photo_sha256 is null
      or target_visit.photo_sha256 !~ '^[0-9a-f]{64}$'
      or target_visit.photo_sha256 = repeat('0', 64)
    then
      update public.office_visits set
        approval_status = 'rejected'::public.office_approval_status,
        attendance_status = 'expired'::public.office_attendance_status,
        rejection_reason = 'Visitor portrait evidence is invalid, expired, or removed.',
        decided_at = now(), decided_by = requested_actor_id, decision_source = 'manual_staff', updated_at = now()
      where id = target_visit.id;
      update public.upload_intents set held_until = null
      where id in (target_visit.photo_intent_id, target_visit.id_intent_id, target_visit.vehicle_photo_intent_id);
      insert into public.office_visit_events (office_visit_id, event_type, actor_id, actor_role, metadata)
      values (target_visit.id, 'rejected', requested_actor_id, actor_profile.role::text,
        jsonb_build_object('reason', 'Visitor portrait evidence is invalid, expired, or removed.', 'code', 'invalid_or_expired_photo_evidence'));
      return query select false, 'rejected'::text, null::uuid, null::uuid, null::timestamptz, null::timestamptz, 'invalid_or_expired_photo_evidence'::text;
      return;
    end if;

    if target_visit.id_intent_id is not null then
      select * into id_intent from public.upload_intents where id = target_visit.id_intent_id for update;
      if not found
        or id_intent.owner_id <> target_visit.visitor_actor_id
        or id_intent.source <> target_visit.source
        or id_intent.kind <> 'id'::public.evidence_kind
        or id_intent.status not in ('pending'::public.upload_intent_status, 'uploaded'::public.upload_intent_status)
        or (target_visit.source = 'portal'::public.pass_source and id_intent.status <> 'uploaded'::public.upload_intent_status)
        or id_intent.expires_at <= now()
        or id_intent.storage_cleaned_at is not null
        or id_intent.held_until is null
        or id_intent.held_until < now()
        or not exists (
          select 1 from storage.objects so
          where so.bucket_id = id_intent.bucket_id
            and so.name = id_intent.object_path
        )
        or target_visit.id_bytes is null
        or target_visit.id_bytes <= 0
        or target_visit.id_sha256 is null
        or target_visit.id_sha256 !~ '^[0-9a-f]{64}$'
        or target_visit.id_sha256 = repeat('0', 64)
      then
        update public.office_visits set
          approval_status = 'rejected'::public.office_approval_status,
          attendance_status = 'expired'::public.office_attendance_status,
          rejection_reason = 'Visitor identification evidence is invalid, expired, or removed.',
          decided_at = now(), decided_by = requested_actor_id, decision_source = 'manual_staff', updated_at = now()
        where id = target_visit.id;
        update public.upload_intents set held_until = null
        where id in (target_visit.photo_intent_id, target_visit.id_intent_id, target_visit.vehicle_photo_intent_id);
        insert into public.office_visit_events (office_visit_id, event_type, actor_id, actor_role, metadata)
        values (target_visit.id, 'rejected', requested_actor_id, actor_profile.role::text,
          jsonb_build_object('reason', 'Visitor identification evidence is invalid, expired, or removed.', 'code', 'invalid_or_expired_id_evidence'));
        return query select false, 'rejected'::text, null::uuid, null::uuid, null::timestamptz, null::timestamptz, 'invalid_or_expired_id_evidence'::text;
        return;
      end if;
    end if;
  elsif target_visit.registration_mode = 'returning' then
    if target_visit.returning_profile_id is null then
      update public.office_visits set
        approval_status = 'rejected'::public.office_approval_status,
        attendance_status = 'expired'::public.office_attendance_status,
        rejection_reason = 'Returning visitor profile linkage is missing.',
        decided_at = now(), decided_by = requested_actor_id, decision_source = 'manual_staff', updated_at = now()
      where id = target_visit.id;
      return query select false, 'rejected'::text, null::uuid, null::uuid, null::timestamptz, null::timestamptz, 'missing_returning_profile_id'::text;
      return;
    end if;
    select * into returning_profile_rec from public.returning_visitor_profiles
    where id = target_visit.returning_profile_id and revoked_at is null and expires_at > now();
    if not found then
      update public.office_visits set
        approval_status = 'rejected'::public.office_approval_status,
        attendance_status = 'expired'::public.office_attendance_status,
        rejection_reason = 'Returning visitor profile is revoked or expired.',
        decided_at = now(), decided_by = requested_actor_id, decision_source = 'manual_staff', updated_at = now()
      where id = target_visit.id;
      return query select false, 'rejected'::text, null::uuid, null::uuid, null::timestamptz, null::timestamptz, 'invalid_returning_profile'::text;
      return;
    end if;
  else
    raise exception using errcode = '22023', message = 'invalid_registration_mode';
  end if;

  if target_visit.arrival_mode = 'vehicle' and target_visit.vehicle_photo_intent_id is not null then
    select * into vehicle_photo_intent from public.upload_intents where id = target_visit.vehicle_photo_intent_id for update;
    if not found
      or vehicle_photo_intent.owner_id <> target_visit.visitor_actor_id
      or vehicle_photo_intent.source <> target_visit.source
      or vehicle_photo_intent.kind <> 'vehicle_photo'::public.evidence_kind
      or vehicle_photo_intent.status not in ('pending'::public.upload_intent_status, 'uploaded'::public.upload_intent_status)
      or (target_visit.source = 'portal'::public.pass_source and vehicle_photo_intent.status <> 'uploaded'::public.upload_intent_status)
      or vehicle_photo_intent.expires_at <= now()
      or vehicle_photo_intent.storage_cleaned_at is not null
      or vehicle_photo_intent.held_until is null
      or vehicle_photo_intent.held_until < now()
      or not exists (
        select 1 from storage.objects so
        where so.bucket_id = vehicle_photo_intent.bucket_id
          and so.name = vehicle_photo_intent.object_path
      )
      or target_visit.vehicle_photo_bytes is null
      or target_visit.vehicle_photo_bytes <= 0
      or target_visit.vehicle_photo_sha256 is null
      or target_visit.vehicle_photo_sha256 !~ '^[0-9a-f]{64}$'
      or target_visit.vehicle_photo_sha256 = repeat('0', 64)
    then
      update public.office_visits set
        approval_status = 'rejected'::public.office_approval_status,
        attendance_status = 'expired'::public.office_attendance_status,
        rejection_reason = 'Vehicle photo evidence is invalid, expired, or missing.',
        decided_at = now(), decided_by = requested_actor_id, decision_source = 'manual_staff', updated_at = now()
      where id = target_visit.id;
      update public.upload_intents set held_until = null
      where id in (target_visit.photo_intent_id, target_visit.id_intent_id, target_visit.vehicle_photo_intent_id);
      insert into public.office_visit_events (office_visit_id, event_type, actor_id, actor_role, metadata)
      values (target_visit.id, 'rejected', requested_actor_id, actor_profile.role::text,
        jsonb_build_object('reason', 'Vehicle photo evidence is invalid, expired, or missing.', 'code', 'invalid_vehicle_photo_evidence'));
      return query select false, 'rejected'::text, null::uuid, null::uuid, null::timestamptz, null::timestamptz, 'invalid_vehicle_photo_evidence'::text;
      return;
    end if;
  end if;

  v_full_name := btrim(concat_ws(' ', target_visit.visitor_first_name, target_visit.visitor_middle_name, target_visit.visitor_last_name));
  v_addr := target_visit.address_details;
  v_veh := target_visit.vehicle_details;
  v_expected_gate := coalesce(
    nullif(btrim(coalesce(target_visit.expected_gate, '')), ''),
    nullif(btrim(coalesce(settings.default_expected_gate, '')), '')
  );

  insert into public.visitors (
    owner_id, source, created_by_device_id, full_name, contact_number,
    home_address, home_location_lat, home_location_lon,
    psgc_version, psgc_region_code, psgc_province_code, psgc_city_code, psgc_barangay_code,
    psgc_region_name, psgc_province_name, psgc_city_municipality_name, psgc_barangay_name,
    home_building, home_street,
    purpose, visit_date, consent_accepted_at,
    registration_mode, arrival_mode, returning_profile_id,
    identity_verification_id, returning_identity_attempt_id
  ) values (
    target_visit.visitor_actor_id, target_visit.source,
    case when target_visit.source = 'kiosk'::public.pass_source then target_visit.visitor_actor_id else null end,
    v_full_name, target_visit.visitor_contact_number,
    coalesce(v_addr->>'homeAddress', ''),
    (v_addr->>'lat')::numeric, (v_addr->>'lon')::numeric,
    v_addr->>'psgcVersion', v_addr->>'regionCode', v_addr->>'provinceCode', v_addr->>'cityCode', v_addr->>'barangayCode',
    v_addr->>'regionName', v_addr->>'provinceName', v_addr->>'cityName', v_addr->>'barangayName',
    v_addr->>'homeBuilding', v_addr->>'homeStreet',
    target_visit.purpose, target_visit.visit_date, target_visit.created_at,
    target_visit.registration_mode, target_visit.arrival_mode, target_visit.returning_profile_id,
    target_visit.identity_verification_id, target_visit.returning_attempt_id
  ) returning id into new_visitor_id;

  if target_visit.registration_mode = 'new' then
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

commit;
