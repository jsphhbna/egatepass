begin;

create extension if not exists pgtap with schema extensions;
select extensions.plan(17);

insert into auth.users (id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000000101', 'authenticated', 'authenticated', 'owner@example.test', '', now(), now(), now()),
  ('00000000-0000-0000-0000-000000000102', 'authenticated', 'authenticated', 'other@example.test', '', now(), now(), now()),
  ('00000000-0000-0000-0000-000000000103', 'authenticated', 'authenticated', 'guard@example.test', '', now(), now(), now()),
  ('00000000-0000-0000-0000-000000000104', 'authenticated', 'authenticated', 'admin@example.test', '', now(), now(), now()),
  ('00000000-0000-0000-0000-000000000105', 'authenticated', 'authenticated', 'super@example.test', '', now(), now(), now()),
  ('00000000-0000-0000-0000-000000000106', 'authenticated', 'authenticated', 'super2@example.test', '', now(), now(), now()),
  ('00000000-0000-0000-0000-000000000107', 'authenticated', 'authenticated', 'kiosk@example.test', '', now(), now(), now()),
  ('00000000-0000-0000-0000-000000000108', 'authenticated', 'authenticated', 'revoked@example.test', '', now(), now(), now());

insert into public.staff_profiles (user_id, display_name, role, active)
values ('00000000-0000-0000-0000-000000000105', 'First Super Admin', 'superadmin', true);

select extensions.throws_ok(
  $$update public.staff_profiles set active = false where user_id = '00000000-0000-0000-0000-000000000105'$$,
  '23514',
  'last active Super Admin cannot be suspended'
);

insert into public.staff_profiles (user_id, display_name, role, active)
values
  ('00000000-0000-0000-0000-000000000103', 'Test Guard', 'guard', true),
  ('00000000-0000-0000-0000-000000000104', 'Test Admin', 'admin', true),
  ('00000000-0000-0000-0000-000000000106', 'Second Super Admin', 'superadmin', true);

insert into public.devices (user_id, alias, name, type, gate, status)
values
  ('00000000-0000-0000-0000-000000000107', 'test-kiosk', 'Test Kiosk', 'kiosk', 'Main Gate', 'active'),
  ('00000000-0000-0000-0000-000000000108', 'revoked-kiosk', 'Revoked Kiosk', 'kiosk', 'Main Gate', 'revoked');

insert into public.visitors (
  id, owner_id, source, full_name, contact_number, purpose, visit_date, consent_accepted_at
) values
  ('00000000-0000-0000-0000-000000000201', '00000000-0000-0000-0000-000000000101', 'portal', 'Owner Visitor', '09170000001', 'Meeting', current_date, now()),
  ('00000000-0000-0000-0000-000000000202', '00000000-0000-0000-0000-000000000102', 'portal', 'Other Visitor', '09170000002', 'Meeting', current_date, now());

insert into public.visitors (
  id, owner_id, source, created_by_device_id, full_name, contact_number, purpose, visit_date, consent_accepted_at
) values (
  '00000000-0000-0000-0000-000000000203', '00000000-0000-0000-0000-000000000107', 'kiosk',
  '00000000-0000-0000-0000-000000000107', 'Kiosk Visitor', '09170000003', 'Meeting', current_date, now()
);

insert into public.passes (
  id, visitor_id, token_digest, source, status, valid_from, valid_until, entry_scanned_at
) values
  ('00000000-0000-0000-0000-000000000301', '00000000-0000-0000-0000-000000000201', decode(repeat('01', 32), 'hex'), 'portal', 'pending', now() - interval '1 hour', now() + interval '1 hour', now()),
  ('00000000-0000-0000-0000-000000000302', '00000000-0000-0000-0000-000000000202', decode(repeat('02', 32), 'hex'), 'portal', 'issued', now() - interval '1 hour', now() + interval '1 hour', null),
  ('00000000-0000-0000-0000-000000000303', '00000000-0000-0000-0000-000000000203', decode(repeat('03', 32), 'hex'), 'kiosk', 'issued', now() - interval '1 hour', now() + interval '1 hour', null);

insert into public.reconciliation_tasks (id, operation, reference_type, reference_id)
values ('00000000-0000-0000-0000-000000000401', 'test.partial_operation', 'visitor', '00000000-0000-0000-0000-000000000201');

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000101', true);
select extensions.is((select count(*) from public.visitors), 1::bigint, 'visitor sees only owned visitor row');
select extensions.is((select count(*) from public.passes), 1::bigint, 'visitor sees only owned pass row');
select extensions.lives_ok(
  $$select * from api.create_upload_intent('portal', 'photo', 'image/jpeg')$$,
  'portal visitor can create an owner-bound portal upload intent'
);
select extensions.throws_ok(
  $$select * from api.create_upload_intent('kiosk', 'photo', 'image/jpeg')$$,
  '42501',
  'portal visitor cannot forge kiosk source'
);

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000102', true);
select extensions.is((select count(*) from public.visitors), 1::bigint, 'cross-owner visitor enumeration is filtered');

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000103', true);
select extensions.is((select count(*) from public.visitors), 1::bigint, 'Guard sees only visitor with pending pass');
select extensions.throws_ok(
  $$insert into public.audit_events (actor_kind, action, target_type) values ('staff', 'forged', 'audit')$$,
  '42501',
  'Guard cannot forge an audit event'
);

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000104', true);
select extensions.is((select count(*) from public.visitors), 3::bigint, 'Admin can read operational visitor rows');
select extensions.is((select count(*) from public.reconciliation_tasks), 0::bigint, 'Admin cannot enumerate reconciliation rows');

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000105', true);
select extensions.is((select count(*) from public.reconciliation_tasks), 1::bigint, 'Super Admin can review reconciliation rows');

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000107', true);
select extensions.is((select count(*) from public.visitors), 0::bigint, 'Kiosk cannot enumerate visitors created by its shared session');
select extensions.is((select count(*) from public.passes), 0::bigint, 'Kiosk cannot enumerate passes created by its shared session');
select extensions.lives_ok(
  $$select * from api.create_upload_intent('kiosk', 'id', 'image/png')$$,
  'active kiosk can create a kiosk upload intent'
);

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000108', true);
select extensions.throws_ok(
  $$select * from api.create_upload_intent('kiosk', 'id', 'image/png')$$,
  '42501',
  'revoked kiosk is denied on its next RPC'
);

reset role;
set local role anon;
select set_config('request.jwt.claim.sub', '', true);
select extensions.throws_ok(
  $$select * from api.current_actor()$$,
  '42501',
  'unauthenticated caller cannot execute actor RPC'
);
reset role;

select extensions.is(
  (select count(*) from storage.buckets where id in ('visitor-photos', 'visitor-ids') and not public),
  2::bigint,
  'both evidence buckets are private'
);

select * from extensions.finish();
rollback;
