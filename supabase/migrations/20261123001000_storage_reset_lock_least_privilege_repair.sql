-- =============================================================================
-- Migration: 20261123001000_storage_reset_lock_least_privilege_repair.sql
-- Description: Least-privilege repair for Supabase Storage photo/ID upload policy.
--              Grants USAGE on schema private and EXECUTE on private.is_system_reset_locked()
--              to authenticated and service_role, allowing RLS policy evaluation
--              while revoking from anon and public.
--              Preserves the system reset security boundary, unexpired pending upload
--              intent validation, private bucket constraints, and table isolation.
-- =============================================================================

-- 1. Grant schema USAGE to authenticated and service_role; revoke from anon and public
grant usage on schema private to authenticated;
grant usage on schema private to service_role;
revoke all on schema private from anon, public;

-- 2. Grant EXECUTE on private.is_system_reset_locked() to authenticated and service_role; revoke from anon and public
grant execute on function private.is_system_reset_locked() to authenticated;
grant execute on function private.is_system_reset_locked() to service_role;
revoke all on function private.is_system_reset_locked() from anon, public;

-- 3. Confirm public.maintenance_state remains strictly inaccessible to client roles (and preserves least-privilege for service_role without DELETE)
revoke all on table public.maintenance_state from public, anon, authenticated;
grant select, insert, update on table public.maintenance_state to service_role;
revoke delete on table public.maintenance_state from service_role;

-- 4. Confirm evidence bucket properties (private, 5MB limit, allowed mime types)
update storage.buckets
set public = false,
    file_size_limit = 5242880,
    allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp']
where id in ('visitor-photos', 'visitor-ids');

-- 5. Re-affirm storage.objects evidence_insert_from_live_intent policy
do $$
begin
  if exists (
    select 1 from information_schema.tables
    where table_schema = 'storage' and table_name = 'objects'
  ) then
    drop policy if exists evidence_insert_from_live_intent on storage.objects;
    create policy evidence_insert_from_live_intent on storage.objects for insert to authenticated
    with check (
      bucket_id in ('visitor-photos', 'visitor-ids')
      and owner_id = (select auth.uid())::text
      and not private.is_system_reset_locked()
      and exists (
        select 1 from public.upload_intents ui
        where ui.owner_id = (select auth.uid())
          and ui.bucket_id = storage.objects.bucket_id
          and ui.object_path = storage.objects.name
          and ui.status = 'pending'::public.upload_intent_status
          and ui.expires_at > now()
      )
    );
  end if;
end $$;
