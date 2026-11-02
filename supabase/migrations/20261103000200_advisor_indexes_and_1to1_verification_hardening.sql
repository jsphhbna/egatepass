-- ==============================================================================
-- Migration 51: Supabase Advisor Foreign Key Indexing, RLS Hardening & 1:1 Returning Visitor Indexes
-- ==============================================================================
--
-- 1. Covering indexes on all unindexed foreign key relationships to prevent
--    table share locks on parent updates/deletions and accelerate cascade checks.
-- 2. Fast functional indexes for 1:1 returning visitor profile discovery.
-- 3. Default-deny RLS reinforcement on internal utility tables.
-- ==============================================================================

-- 1. Covering indexes on unindexed foreign keys
create index if not exists staff_profiles_created_by_idx
  on public.staff_profiles (created_by)
  where created_by is not null;

create index if not exists devices_created_by_idx
  on public.devices (created_by)
  where created_by is not null;

create index if not exists app_settings_updated_by_idx
  on public.app_settings (updated_by)
  where updated_by is not null;

create index if not exists visitors_identity_verification_id_idx
  on public.visitors (identity_verification_id)
  where identity_verification_id is not null;

create index if not exists visitors_returning_identity_attempt_id_idx
  on public.visitors (returning_identity_attempt_id)
  where returning_identity_attempt_id is not null;

create index if not exists visitors_returning_profile_id_idx
  on public.visitors (returning_profile_id)
  where returning_profile_id is not null;

create index if not exists audit_events_actor_id_idx
  on public.audit_events (actor_id)
  where actor_id is not null;

create index if not exists thermal_templates_created_by_idx
  on public.thermal_templates (created_by)
  where created_by is not null;

create index if not exists thermal_templates_published_by_idx
  on public.thermal_templates (published_by)
  where published_by is not null;

create index if not exists offline_sync_receipts_actor_id_idx
  on public.offline_sync_receipts (actor_id)
  where actor_id is not null;

create index if not exists portal_id_verif_id_intent_idx
  on public.portal_identity_verification_attempts (id_intent_id)
  where id_intent_id is not null;

create index if not exists visit_vehicle_declarations_saved_vehicle_id_idx
  on public.visit_vehicle_declarations (saved_vehicle_id)
  where saved_vehicle_id is not null;

create index if not exists visit_vehicle_declarations_vehicle_photo_evidence_id_idx
  on public.visit_vehicle_declarations (vehicle_photo_evidence_id)
  where vehicle_photo_evidence_id is not null;

create index if not exists visit_vehicle_declarations_visitor_id_idx
  on public.visit_vehicle_declarations (visitor_id)
  where visitor_id is not null;

create index if not exists returning_identity_attempts_matched_profile_id_idx
  on public.returning_identity_attempts (matched_profile_id)
  where matched_profile_id is not null;

create index if not exists returning_identity_attempts_photo_intent_id_idx
  on public.returning_identity_attempts (photo_intent_id)
  where photo_intent_id is not null;

-- 2. Fast functional indexes for 1:1 Returning Visitor Lookup
create index if not exists returning_visitor_profiles_name_lookup_idx
  on public.returning_visitor_profiles (lower(first_name), lower(last_name))
  where revoked_at is null;

create index if not exists returning_visitor_profiles_contact_idx
  on public.returning_visitor_profiles (contact_number_e164)
  where revoked_at is null;

-- 3. Default-deny RLS reinforcement on internal rate limiters and cache
alter table if exists public.nominatim_rate_limiter enable row level security;
alter table if exists public.location_search_cache enable row level security;

revoke all on public.nominatim_rate_limiter from public, anon, authenticated;
grant all on public.nominatim_rate_limiter to service_role;

revoke all on public.location_search_cache from public, anon, authenticated;
grant all on public.location_search_cache to service_role;
