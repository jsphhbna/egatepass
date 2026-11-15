-- Migration: 20261115000400_narrow_office_calendar_service_role.sql
-- Description: Narrow office_calendar_schedules RLS policies to service_role while preserving public SELECT

drop policy if exists office_calendar_all_service on public.office_calendar_schedules;

drop policy if exists office_calendar_service_role on public.office_calendar_schedules;
create policy office_calendar_service_role on public.office_calendar_schedules
  for all to service_role using (true) with check (true);

-- Ensure public select policy exists and is preserved
do $$
begin
  if not exists (
    select 1 from pg_policies 
    where schemaname = 'public' 
      and tablename = 'office_calendar_schedules' 
      and policyname = 'office_calendar_select'
  ) then
    create policy office_calendar_select on public.office_calendar_schedules
      for select using (true);
  end if;
end $$;

grant select on public.office_calendar_schedules to anon, authenticated;
grant select, insert, update, delete on public.office_calendar_schedules to service_role;
