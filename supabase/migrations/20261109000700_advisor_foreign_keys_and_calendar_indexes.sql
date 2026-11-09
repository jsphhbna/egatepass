-- Migration 77: Advisor Foreign Key Indexes & Security Tightening
-- Description: Indexes unindexed foreign key columns to eliminate table lock risks
-- during parent updates/deletions, optimizes RLS evaluation, and ensures least-privilege
-- function execution boundaries.

-- 1. Covering indexes for foreign keys
create index if not exists idx_campus_calendar_closures_created_by
  on public.campus_calendar_closures(created_by)
  where created_by is not null;

create index if not exists idx_campus_calendar_closures_updated_by
  on public.campus_calendar_closures(updated_by)
  where updated_by is not null;

create index if not exists idx_offices_verified_by
  on public.offices(verified_by)
  where verified_by is not null;

create index if not exists idx_office_staff_assignments_created_by
  on public.office_staff_assignments(created_by)
  where created_by is not null;

-- 2. Revoke execute on api.confirm_office_arrival from public, anon, authenticated
revoke execute on function api.confirm_office_arrival(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function api.confirm_office_arrival(uuid, uuid, uuid) to service_role;
