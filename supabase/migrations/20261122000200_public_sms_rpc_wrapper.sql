-- ============================================================================
-- Migration: 20261122000200_public_sms_rpc_wrapper.sql
-- Description: Revokes execute from public/anon on SMS RPCs and removes redundant public wrapper
-- ============================================================================

drop function if exists public.record_inbound_sms(text, text, text, double precision, double precision, timestamptz, text);

revoke all on function api.get_emergency_sms_recipients() from public, anon;
grant execute on function api.get_emergency_sms_recipients() to authenticated, service_role;

revoke all on function api.get_overdue_campus_visitors() from public, anon;
grant execute on function api.get_overdue_campus_visitors() to authenticated, service_role;

revoke all on function api.record_inbound_sms(text, text, text, double precision, double precision, timestamptz, text) from public, anon, authenticated;
grant execute on function api.record_inbound_sms(text, text, text, double precision, double precision, timestamptz, text) to service_role;
