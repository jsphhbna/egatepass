-- ============================================================================
-- Migration 76: Grant table privileges on public.campus_calendar_closures
-- ============================================================================

grant select on public.campus_calendar_closures to anon, authenticated;
grant select, insert, update, delete on public.campus_calendar_closures to service_role;
