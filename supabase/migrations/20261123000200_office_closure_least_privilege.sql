-- ============================================================================
-- Migration: 20261123000200_office_closure_least_privilege.sql
-- Description: Revokes execute from public/anon/authenticated on office closure RPCs
-- ============================================================================

revoke all on function api.set_office_emergency_closure(uuid, text, text) from public, anon, authenticated;
grant execute on function api.set_office_emergency_closure(uuid, text, text) to service_role;

revoke all on function api.get_office_closure_affected_visitors(uuid) from public, anon, authenticated;
grant execute on function api.get_office_closure_affected_visitors(uuid) to service_role;
