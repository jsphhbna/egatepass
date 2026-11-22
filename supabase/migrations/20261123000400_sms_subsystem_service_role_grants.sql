-- Migration: Restrict SMS RPC functions strictly to service_role
-- Defense-in-depth: removes client PostgREST authenticated exposure while preserving backend service-role access

revoke all on function api.get_emergency_sms_recipients(uuid) from public, anon, authenticated;
grant execute on function api.get_emergency_sms_recipients(uuid) to service_role;

revoke all on function api.get_overdue_campus_visitors(uuid) from public, anon, authenticated;
grant execute on function api.get_overdue_campus_visitors(uuid) to service_role;

revoke all on function api.check_and_reserve_sms_quota(uuid, integer) from public, anon, authenticated;
grant execute on function api.check_and_reserve_sms_quota(uuid, integer) to service_role;
