-- Migration: 20261021155132_service_role_backend_table_grants.sql
-- Description: Restore least-privilege table access for service_role backend operations.
--
-- Background:
--   During database hardening, broad table privileges were revoked from service_role.
--   However, the trusted Vercel backend server operates using the Supabase service_role key
--   and performs deliberate direct table operations (e.g. idempotent replay lookup on passes,
--   actor role verification on staff_profiles, audit event insertion, maintenance state tracking, etc.).
--   This migration restores only the specific, audited privileges required by server handlers
--   while strictly preserving least privilege, immutable audit logs, and RPC-only mutation boundaries.

-- 1. app_settings: Server reads configuration in retention-maintenance, settings, and purge-images.
--    Mutations remain strictly RPC-only via api.update_app_settings.
grant select on public.app_settings to service_role;

-- 2. audit_events: Server writes audit events across administrative, gate, auth, and purge endpoints.
--    Server reads audit events for activity feed and retention queries, and deletes aged records during retention cleanup.
--    Audit records are immutable: UPDATE remains strictly forbidden.
grant select, insert, delete on public.audit_events to service_role;
grant usage, select on sequence public.audit_events_id_seq to service_role;

-- 3. devices: Server reads device metadata for actor verification and admin listings.
--    Mutations remain strictly RPC-only via api.create_device_profile, api.update_device_profile, and api.retire_device.
grant select on public.devices to service_role;

-- 4. incident_holds: Server checks active holds during gate evidence retrieval and purge operations.
--    Mutations remain strictly RPC-only via api.create_incident_hold and api.release_incident_hold.
grant select on public.incident_holds to service_role;

-- 5. maintenance_state: Server queries and upserts job cursors (e.g. evidence purge cursor) during maintenance.
--    Upsert requires SELECT, INSERT, and UPDATE. DELETE is not permitted.
grant select, insert, update on public.maintenance_state to service_role;

-- 6. pass_email_verifications: SELECT, INSERT, UPDATE are already granted in prior migrations.
--    Server retention maintenance purges expired verification records older than 24 hours.
grant delete on public.pass_email_verifications to service_role;

-- 7. passes: Server queries passes for idempotent replay (api/passes/issue), email dispatch,
--    evidence verification, and admin dashboards/records.
--    Pass creation and lifecycle transitions remain strictly RPC-only (api.issue_pass, api.scan_pass, api.decide_visit).
--    Direct INSERT, UPDATE, DELETE remain strictly forbidden.
grant select on public.passes to service_role;

-- 8. reconciliation_tasks: Server logs unhandled failure tasks (INSERT), lists tasks for superadmin (SELECT),
--    and cleans up resolved tasks during retention maintenance (DELETE).
--    UPDATE is not used directly.
grant select, insert, delete on public.reconciliation_tasks to service_role;

-- 9. staff_profiles: Server verifies staff roles in requireStaffActor and lists users in admin.
--    Staff profile creation and role changes remain strictly RPC-only (api.create_staff_profile, api.update_staff_profile).
--    Direct INSERT, UPDATE, DELETE remain strictly forbidden.
grant select on public.staff_profiles to service_role;

-- 10. upload_intents: Server validates pending photo/ID intents during pass issuance (SELECT),
--     and expires abandoned intents during retention maintenance (UPDATE).
--     Intent creation remains strictly RPC-only (api.create_upload_intent).
--     Direct INSERT and DELETE remain strictly forbidden.
grant select, update on public.upload_intents to service_role;

-- 11. visit_events: Server queries event logs in admin activity feed (SELECT).
--     Event creation remains strictly RPC-only (api.scan_pass, api.decide_visit).
--     Direct INSERT, UPDATE, DELETE remain strictly forbidden.
grant select on public.visit_events to service_role;

-- 12. visitor_evidence: Server queries evidence metadata for gate viewing, purge candidates, and retention.
--     Evidence creation occurs via api.create_upload_intent/storage; purging occurs via api.claim_evidence_for_purge
--     and api.finalize_evidence_purge. Direct INSERT, UPDATE, DELETE remain strictly forbidden.
grant select on public.visitor_evidence to service_role;

-- 13. visitors: Server queries visitor details during idempotent pass replay (SELECT),
--     and anonymizes visitor personal data during retention maintenance (UPDATE).
--     Visitor creation occurs via api.issue_pass. Direct INSERT and DELETE remain strictly forbidden.
grant select, update on public.visitors to service_role;

-- 14. rate_limit_buckets: Server does not access directly (managed solely via database functions).
--     Zero direct grants to service_role.
