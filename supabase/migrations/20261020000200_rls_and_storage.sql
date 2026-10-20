-- Default-deny grants, RLS policies, authorization helpers, and private buckets.

create or replace function private.current_staff_role()
returns public.staff_role
language sql
stable
security definer
set search_path = ''
as $$
  select sp.role
  from public.staff_profiles sp
  join auth.users u on u.id = sp.user_id
  where sp.user_id = (select auth.uid())
    and sp.active
    and u.email_confirmed_at is not null
  limit 1
$$;

create or replace function private.has_staff_role(allowed public.staff_role[])
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select private.current_staff_role()) = any(allowed), false)
$$;

create or replace function private.current_device_type()
returns public.device_type
language sql
stable
security definer
set search_path = ''
as $$
  select d.type
  from public.devices d
  where d.user_id = (select auth.uid()) and d.status = 'active'::public.device_status
  limit 1
$$;

create or replace function private.is_portal_actor()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select (select auth.uid()) is not null
    and not exists (select 1 from public.staff_profiles sp where sp.user_id = (select auth.uid()))
    and not exists (select 1 from public.devices d where d.user_id = (select auth.uid()))
$$;

create or replace function private.can_read_visitor(target_visitor_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.visitors v
    where v.id = target_visitor_id
      and (
        (
          v.owner_id = (select auth.uid())
          and v.source = 'portal'::public.pass_source
          and (select private.is_portal_actor())
        )
        or (select private.has_staff_role(array['admin','superadmin']::public.staff_role[]))
        or (
          (select private.has_staff_role(array['guard']::public.staff_role[]))
          and exists (
            select 1 from public.passes p
            where p.visitor_id = v.id and p.status = 'pending'::public.pass_status
          )
        )
      )
  )
$$;

create or replace function private.can_read_storage_object(target_bucket text, target_path text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.upload_intents ui
    where ui.bucket_id = target_bucket
      and ui.object_path = target_path
      and (
        (
          ui.owner_id = (select auth.uid())
          and ui.status in ('pending'::public.upload_intent_status, 'uploaded'::public.upload_intent_status)
          and ui.expires_at > now()
        )
        or (
          ui.visitor_id is not null
          and (select private.can_read_visitor(ui.visitor_id))
        )
      )
  )
$$;

revoke all on function private.current_staff_role() from public, anon;
revoke all on function private.has_staff_role(public.staff_role[]) from public, anon;
revoke all on function private.current_device_type() from public, anon;
revoke all on function private.is_portal_actor() from public, anon;
revoke all on function private.can_read_visitor(uuid) from public, anon;
revoke all on function private.can_read_storage_object(text, text) from public, anon;
grant usage on schema private to authenticated;
grant execute on function private.current_staff_role() to authenticated;
grant execute on function private.has_staff_role(public.staff_role[]) to authenticated;
grant execute on function private.current_device_type() to authenticated;
grant execute on function private.is_portal_actor() to authenticated;
grant execute on function private.can_read_visitor(uuid) to authenticated;
grant execute on function private.can_read_storage_object(text, text) to authenticated;

alter table public.staff_profiles enable row level security;
alter table public.devices enable row level security;
alter table public.app_settings enable row level security;
alter table public.visitors enable row level security;
alter table public.upload_intents enable row level security;
alter table public.visitor_evidence enable row level security;
alter table public.passes enable row level security;
alter table public.visit_events enable row level security;
alter table public.audit_events enable row level security;
alter table public.reconciliation_tasks enable row level security;
alter table public.incident_holds enable row level security;
alter table public.rate_limit_buckets enable row level security;
alter table public.maintenance_state enable row level security;

revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;

grant select on public.staff_profiles, public.devices, public.app_settings,
  public.visitors, public.upload_intents, public.visitor_evidence, public.passes,
  public.visit_events, public.audit_events, public.reconciliation_tasks,
  public.incident_holds to authenticated;

drop policy if exists staff_profiles_select on public.staff_profiles;
create policy staff_profiles_select on public.staff_profiles for select to authenticated
using (
  user_id = (select auth.uid())
  or (select private.has_staff_role(array['admin','superadmin']::public.staff_role[]))
);

drop policy if exists devices_select on public.devices;
create policy devices_select on public.devices for select to authenticated
using (
  user_id = (select auth.uid())
  or (select private.has_staff_role(array['admin','superadmin']::public.staff_role[]))
);

drop policy if exists app_settings_select on public.app_settings;
create policy app_settings_select on public.app_settings for select to authenticated
using ((select auth.uid()) is not null);

drop policy if exists visitors_select on public.visitors;
create policy visitors_select on public.visitors for select to authenticated
using ((select private.can_read_visitor(id)));

drop policy if exists upload_intents_select on public.upload_intents;
create policy upload_intents_select on public.upload_intents for select to authenticated
using (
  owner_id = (select auth.uid())
  and status in ('pending'::public.upload_intent_status, 'uploaded'::public.upload_intent_status)
  and expires_at > now()
);

drop policy if exists visitor_evidence_select on public.visitor_evidence;
create policy visitor_evidence_select on public.visitor_evidence for select to authenticated
using ((select private.can_read_visitor(visitor_id)));

drop policy if exists passes_select on public.passes;
create policy passes_select on public.passes for select to authenticated
using (
  exists (
    select 1 from public.visitors v
    where v.id = passes.visitor_id
      and v.owner_id = (select auth.uid())
      and v.source = 'portal'::public.pass_source
      and (select private.is_portal_actor())
  )
  or (select private.has_staff_role(array['admin','superadmin']::public.staff_role[]))
  or (
    status = 'pending'::public.pass_status
    and (select private.has_staff_role(array['guard']::public.staff_role[]))
  )
);

drop policy if exists visit_events_select on public.visit_events;
create policy visit_events_select on public.visit_events for select to authenticated
using ((select private.has_staff_role(array['admin','superadmin']::public.staff_role[])));

drop policy if exists audit_events_select on public.audit_events;
create policy audit_events_select on public.audit_events for select to authenticated
using ((select private.has_staff_role(array['admin','superadmin']::public.staff_role[])));

drop policy if exists reconciliation_tasks_select on public.reconciliation_tasks;
create policy reconciliation_tasks_select on public.reconciliation_tasks for select to authenticated
using ((select private.has_staff_role(array['superadmin']::public.staff_role[])));

drop policy if exists incident_holds_select on public.incident_holds;
create policy incident_holds_select on public.incident_holds for select to authenticated
using ((select private.has_staff_role(array['superadmin']::public.staff_role[])));

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('visitor-photos', 'visitor-photos', false, 5242880, array['image/jpeg','image/png','image/webp']),
  ('visitor-ids', 'visitor-ids', false, 5242880, array['image/jpeg','image/png','image/webp'])
on conflict (id) do update
set public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists evidence_insert_from_live_intent on storage.objects;
create policy evidence_insert_from_live_intent on storage.objects for insert to authenticated
with check (
  bucket_id in ('visitor-photos', 'visitor-ids')
  and owner_id = (select auth.uid())::text
  and exists (
    select 1 from public.upload_intents ui
    where ui.owner_id = (select auth.uid())
      and ui.bucket_id = storage.objects.bucket_id
      and ui.object_path = storage.objects.name
      and ui.status = 'pending'::public.upload_intent_status
      and ui.expires_at > now()
  )
);

drop policy if exists evidence_select_authorized on storage.objects;
create policy evidence_select_authorized on storage.objects for select to authenticated
using (
  bucket_id in ('visitor-photos', 'visitor-ids')
  and (select private.can_read_storage_object(bucket_id, name))
);

-- No client UPDATE or DELETE policy is defined. Physical deletion is a server-side
-- Storage API operation after hold/active-pass checks and reconciliation handling.
