begin;

create extension if not exists pgtap with schema extensions;
select extensions.plan(10);

select extensions.is(
  (select count(*) from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'r' and c.relname = any(array[
     'staff_profiles','devices','app_settings','visitors','upload_intents','visitor_evidence','passes',
     'visit_events','audit_events','reconciliation_tasks','incident_holds','rate_limit_buckets','maintenance_state'
   ])),
  13::bigint,
  'all canonical application tables exist'
);

select extensions.is(
  (select count(*) from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relrowsecurity and c.relname = any(array[
     'staff_profiles','devices','app_settings','visitors','upload_intents','visitor_evidence','passes',
     'visit_events','audit_events','reconciliation_tasks','incident_holds','rate_limit_buckets','maintenance_state'
   ])),
  13::bigint,
  'RLS is enabled on every application table'
);

select extensions.is(
  (select count(*) from information_schema.role_table_grants
   where grantee in ('anon', 'authenticated') and table_schema = 'public'
     and privilege_type in ('INSERT','UPDATE','DELETE')),
  0::bigint,
  'Data API roles have no direct mutation grants'
);

select extensions.is(
  (select count(*) from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'api' and p.proname = 'create_upload_intent'),
  1::bigint,
  'upload intent has exactly one RPC overload'
);

select extensions.is(
  (select count(*) from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'api' and p.proname = 'current_actor'),
  1::bigint,
  'current actor has exactly one RPC overload'
);

select extensions.ok(
  (select p.prosecdef and 'search_path=""' = any(p.proconfig)
   from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'api' and p.proname = 'create_upload_intent'),
  'upload intent definer has an empty search path'
);

select extensions.is(
  (select count(*) from storage.buckets where id in ('visitor-photos','visitor-ids') and not public and file_size_limit = 5242880),
  2::bigint,
  'evidence buckets are private and capped at 5 MiB'
);

select extensions.is(
  (select count(*) from pg_catalog.pg_policies
   where schemaname = 'storage' and tablename = 'objects'
     and policyname in ('evidence_insert_from_live_intent','evidence_select_authorized')),
  2::bigint,
  'expected Storage policies exist'
);

select extensions.ok(
  not has_function_privilege('anon', 'api.create_upload_intent(public.pass_source,public.evidence_kind,text)', 'EXECUTE'),
  'anonymous database role cannot execute upload intent RPC'
);

select extensions.ok(
  not has_function_privilege('authenticated', 'private.bootstrap_super_admin(uuid,text)', 'EXECUTE'),
  'authenticated callers cannot execute bootstrap'
);

select * from extensions.finish();
rollback;
