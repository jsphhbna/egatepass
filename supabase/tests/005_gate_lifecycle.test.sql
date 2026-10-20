begin;

create extension if not exists pgtap with schema extensions;
select extensions.plan(14);

insert into auth.users (id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000000501', 'authenticated', 'authenticated', 'visitor-501@example.test', '', now(), now(), now()),
  ('00000000-0000-0000-0000-000000000502', 'authenticated', 'authenticated', 'entry-502@devices.egatepass.invalid', '', now(), now(), now()),
  ('00000000-0000-0000-0000-000000000503', 'authenticated', 'authenticated', 'exit-503@devices.egatepass.invalid', '', now(), now(), now()),
  ('00000000-0000-0000-0000-000000000504', 'authenticated', 'authenticated', 'exit-504@devices.egatepass.invalid', '', now(), now(), now()),
  ('00000000-0000-0000-0000-000000000505', 'authenticated', 'authenticated', 'guard-505@example.test', '', now(), now(), now());

insert into public.devices(user_id, alias, name, type, gate, status) values
  ('00000000-0000-0000-0000-000000000502', 'entry-502', 'Entry Scanner 502', 'entry', 'Gate A', 'active'),
  ('00000000-0000-0000-0000-000000000503', 'exit-503', 'Exit Scanner 503', 'exit', 'Gate A', 'active'),
  ('00000000-0000-0000-0000-000000000504', 'exit-504', 'Exit Scanner 504', 'exit', 'Gate B', 'active');
insert into public.staff_profiles(user_id, display_name, role, active, must_change_password, privacy_accepted_at)
values ('00000000-0000-0000-0000-000000000505', 'Guard 505', 'guard', true, false, now());
insert into public.visitors(id, owner_id, source, full_name, contact_number, purpose, visit_date, consent_accepted_at)
values ('00000000-0000-0000-0000-000000000511', '00000000-0000-0000-0000-000000000501', 'portal', 'Test Visitor', '09170000000', 'Lifecycle test', (now() at time zone 'Asia/Manila')::date, now());
insert into public.passes(id, visitor_id, token_digest, source, status, valid_from, valid_until)
values (
  '00000000-0000-0000-0000-000000000512', '00000000-0000-0000-0000-000000000511',
  extensions.digest(convert_to('synthetic-qr-token-501', 'UTF8'), 'sha256'), 'portal', 'issued', now() - interval '1 hour', now() + interval '1 hour'
);

select extensions.ok(not has_function_privilege('authenticated', 'api.scan_pass(uuid,text,public.device_type,uuid)', 'EXECUTE'), 'browser cannot execute scan transition');
select extensions.ok(has_function_privilege('authenticated', 'api.guard_dashboard()', 'EXECUTE'), 'authenticated role can reach the reauthorizing Guard dashboard');

set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select extensions.lives_ok(
  $$select * from api.scan_pass('00000000-0000-0000-0000-000000000502', encode(extensions.digest(convert_to('synthetic-qr-token-501', 'UTF8'), 'sha256'), 'hex'), 'entry', '00000000-0000-0000-0000-000000000521')$$,
  'active entry scanner can move an issued valid pass to pending'
);
select extensions.is((select status from public.passes where id = '00000000-0000-0000-0000-000000000512'), 'pending'::public.pass_status, 'entry scan does not approve admission');
select extensions.is((select count(*) from public.visit_events where event = 'scan_entry' and pass_id = '00000000-0000-0000-0000-000000000512'), 1::bigint, 'entry event is appended once');
select extensions.is(
  (select ok from api.scan_pass('00000000-0000-0000-0000-000000000502', encode(extensions.digest(convert_to('synthetic-qr-token-501', 'UTF8'), 'sha256'), 'hex'), 'entry', '00000000-0000-0000-0000-000000000522')),
  false, 'entry replay is denied'
);

set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000505', true);
select extensions.is(jsonb_array_length(api.guard_dashboard()->'queue'), 1, 'eligible Guard sees the bounded pending queue');

reset role;
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select extensions.lives_ok(
  $$select api.decide_visit('00000000-0000-0000-0000-000000000505', '00000000-0000-0000-0000-000000000512', 'approved', null, '00000000-0000-0000-0000-000000000523')$$,
  'eligible Guard can approve a pending pass'
);
select extensions.is((select status from public.passes where id = '00000000-0000-0000-0000-000000000512'), 'inside'::public.pass_status, 'approval records the visitor inside');
select extensions.is((select count(*) from public.visit_events where event = 'approved' and pass_id = '00000000-0000-0000-0000-000000000512'), 1::bigint, 'approval event is appended once');
select extensions.is(
  (select code from api.scan_pass('00000000-0000-0000-0000-000000000504', encode(extensions.digest(convert_to('synthetic-qr-token-501', 'UTF8'), 'sha256'), 'hex'), 'exit', '00000000-0000-0000-0000-000000000524')),
  'wrong_gate', 'wrong-gate exit is denied'
);
select extensions.is((select status from public.passes where id = '00000000-0000-0000-0000-000000000512'), 'inside'::public.pass_status, 'wrong-gate denial leaves lifecycle unchanged');
select extensions.lives_ok(
  $$select * from api.scan_pass('00000000-0000-0000-0000-000000000503', encode(extensions.digest(convert_to('synthetic-qr-token-501', 'UTF8'), 'sha256'), 'hex'), 'exit', '00000000-0000-0000-0000-000000000525')$$,
  'matching active exit scanner records departure'
);
select extensions.is((select status from public.passes where id = '00000000-0000-0000-0000-000000000512'), 'exited'::public.pass_status, 'complete lifecycle ends at exited');

reset role;
select * from extensions.finish();
rollback;
