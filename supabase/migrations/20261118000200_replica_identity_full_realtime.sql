-- Migration: 20261118000200_replica_identity_full_realtime.sql
-- Description: Set REPLICA IDENTITY FULL on core realtime publication tables to ensure
-- Supabase Realtime delivers complete payload.old record state during UPDATE and DELETE events.

alter table public.office_visits replica identity full;
alter table public.office_visit_events replica identity full;
alter table public.passes replica identity full;
alter table public.visit_events replica identity full;
alter table public.emergency_gate_records replica identity full;
