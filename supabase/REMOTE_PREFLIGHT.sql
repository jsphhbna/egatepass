-- READ-ONLY inventory for an owner-authorized non-production Supabase project.
-- Do not run against an unidentified project. This script makes no changes.

select current_database() as database_name, current_user as connected_role, version() as postgres_version;

select n.nspname as schema_name, c.relname as relation_name, c.relkind,
       c.relrowsecurity as rls_enabled, c.relforcerowsecurity as rls_forced
from pg_catalog.pg_class c
join pg_catalog.pg_namespace n on n.oid = c.relnamespace
where n.nspname in ('public', 'api', 'private')
order by n.nspname, c.relname;

select schemaname, tablename, policyname, permissive, roles, cmd, qual, with_check
from pg_catalog.pg_policies
where schemaname in ('public', 'storage')
order by schemaname, tablename, policyname;

select n.nspname as schema_name, p.proname,
       pg_catalog.pg_get_function_identity_arguments(p.oid) as identity_arguments,
       p.prosecdef as security_definer,
       p.proconfig
from pg_catalog.pg_proc p
join pg_catalog.pg_namespace n on n.oid = p.pronamespace
where n.nspname in ('public', 'api', 'private')
order by n.nspname, p.proname, identity_arguments;

select id, name, public, file_size_limit, allowed_mime_types
from storage.buckets
where id in ('visitor-photos', 'visitor-ids')
order by id;

-- Review the complete output before any migration. Unexpected target-named tables,
-- policies, overloads, or buckets require an owner-approved backup/cleanup plan.
