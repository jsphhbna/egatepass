begin;

create extension if not exists pgtap with schema extensions;
select extensions.plan(10);

insert into auth.users (id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000000601', 'authenticated', 'authenticated', 'superadmin-601@example.test', '', now(), now(), now()),
  ('00000000-0000-0000-0000-000000000602', 'authenticated', 'authenticated', 'admin-602@example.test', '', now(), now(), now()),
  ('00000000-0000-0000-0000-000000000603', 'authenticated', 'authenticated', 'guard-603@example.test', '', now(), now(), now()),
  ('00000000-0000-0000-0000-000000000604', 'authenticated', 'authenticated', 'kiosk-604@devices.egatepass.invalid', '', now(), now(), now());

insert into public.staff_profiles(user_id, display_name, role, active, must_change_password, privacy_accepted_at)
values
  ('00000000-0000-0000-0000-000000000601', 'Super Admin 601', 'superadmin', true, false, now()),
  ('00000000-0000-0000-0000-000000000602', 'Admin 602', 'admin', true, false, now());

select extensions.ok(not has_function_privilege('authenticated', 'api.create_staff_profile(uuid,uuid,text,public.staff_role,uuid)', 'EXECUTE'), 'browser cannot execute create_staff_profile');
select extensions.ok(not has_function_privilege('authenticated', 'api.create_device_profile(uuid,uuid,text,text,public.device_type,text,uuid)', 'EXECUTE'), 'browser cannot execute create_device_profile');
select extensions.ok(not has_function_privilege('authenticated', 'api.retire_device(uuid,uuid,uuid)', 'EXECUTE'), 'browser cannot execute retire_device');

set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);

select extensions.lives_ok(
  $$select api.create_staff_profile('00000000-0000-0000-0000-000000000601', '00000000-0000-0000-0000-000000000603', 'Guard 603', 'guard', '00000000-0000-0000-0000-000000000611')$$,
  'Super Admin can create a new staff profile via service_role RPC'
);

select extensions.is(
  (select count(*) from public.staff_profiles where user_id = '00000000-0000-0000-0000-000000000603' and role = 'guard'),
  1::bigint,
  'Guard profile is successfully created in staff_profiles'
);

select extensions.lives_ok(
  $$select api.create_device_profile('00000000-0000-0000-0000-000000000601', '00000000-0000-0000-0000-000000000604', 'kiosk-604', 'Lobby Kiosk 604', 'kiosk', 'Main Lobby', '00000000-0000-0000-0000-000000000612')$$,
  'Super Admin can create a device profile via service_role RPC'
);

select extensions.is(
  (select status from public.devices where user_id = '00000000-0000-0000-0000-000000000604'),
  'active'::public.device_status,
  'Device status is active'
);

select extensions.lives_ok(
  $$select api.retire_device('00000000-0000-0000-0000-000000000601', '00000000-0000-0000-0000-000000000604', '00000000-0000-0000-0000-000000000613')$$,
  'Super Admin can retire an active device'
);

select extensions.is(
  (select status from public.devices where user_id = '00000000-0000-0000-0000-000000000604'),
  'revoked'::public.device_status,
  'Retired device status is revoked'
);

select extensions.throws_ok(
  $$select api.update_staff_profile('00000000-0000-0000-0000-000000000601', '00000000-0000-0000-0000-000000000601', 'guard', false, '00000000-0000-0000-0000-000000000614')$$,
  '42501',
  null,
  'Deactivating or demoting the last Super Admin is rejected'
);

select * from extensions.finish();
rollback;
