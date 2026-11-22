-- ============================================================================
-- Migration: 20261122000200_public_sms_rpc_wrapper.sql
-- Description: Exposes record_inbound_sms in public schema for Supabase client RPC
-- ============================================================================

create or replace function public.record_inbound_sms(
  requested_msg_id text,
  requested_sender_phone text,
  requested_report_type text,
  requested_lat double precision default null,
  requested_lon double precision default null,
  requested_reported_at timestamptz default now(),
  requested_raw_message text default ''
)
returns jsonb
language sql
security definer
set search_path = public, pg_catalog
as $$
  select api.record_inbound_sms(
    requested_msg_id,
    requested_sender_phone,
    requested_report_type,
    requested_lat,
    requested_lon,
    requested_reported_at,
    requested_raw_message
  );
$$;

grant execute on function public.record_inbound_sms(text, text, text, double precision, double precision, timestamptz, text) to service_role;
