begin;

create extension if not exists pgtap with schema extensions;
select extensions.plan(8);

insert into auth.users (id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
values ('00000000-0000-0000-0000-000000000301', 'authenticated', 'authenticated', 'identity-guard@example.test', '', now(), now(), now());

insert into public.staff_profiles (user_id, display_name, role, active, must_change_password)
values ('00000000-0000-0000-0000-000000000301', 'Identity Guard', 'guard', true, true);

select extensions.ok(
  has_function_privilege('authenticated', 'api.acknowledge_privacy()', 'EXECUTE'),
  'authenticated callers can execute privacy acknowledgement'
);

select extensions.ok(
  not has_function_privilege('anon', 'api.acknowledge_privacy()', 'EXECUTE'),
  'anonymous database role cannot acknowledge staff privacy'
);

select extensions.ok(
  not has_function_privilege('authenticated', 'api.finalize_guard_password_change(uuid)', 'EXECUTE'),
  'authenticated callers cannot directly finalize a forced password change'
);

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000301', true);

select extensions.lives_ok(
  $$select api.acknowledge_privacy()$$,
  'active Guard can acknowledge privacy for self'
);

reset role;
select extensions.ok(
  (select privacy_accepted_at is not null from public.staff_profiles where user_id = '00000000-0000-0000-0000-000000000301'),
  'privacy acknowledgement persists on the caller profile'
);

select extensions.is(
  (select count(*) from public.audit_events where actor_id = '00000000-0000-0000-0000-000000000301' and action = 'privacy.acknowledged'),
  1::bigint,
  'privacy acknowledgement appends one audit event'
);

set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select extensions.lives_ok(
  $$select api.finalize_guard_password_change('00000000-0000-0000-0000-000000000301')$$,
  'service role can finalize an eligible Guard password change'
);

reset role;
select extensions.is(
  (select must_change_password from public.staff_profiles where user_id = '00000000-0000-0000-0000-000000000301'),
  false,
  'forced password flag is cleared transactionally'
);

select * from extensions.finish();
rollback;
