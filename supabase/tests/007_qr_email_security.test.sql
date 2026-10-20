begin;

create extension if not exists pgtap with schema extensions;
select extensions.plan(18);

insert into auth.users (id, aud, role, email, encrypted_password, email_confirmed_at, is_anonymous, created_at, updated_at)
values ('00000000-0000-0000-0000-000000000701', 'authenticated', 'authenticated', null, '', now(), true, now(), now());

insert into public.visitors (id, owner_id, source, full_name, contact_number, purpose, visit_date, consent_accepted_at)
values ('00000000-0000-0000-0000-000000000711', '00000000-0000-0000-0000-000000000701', 'portal',
        'QR Email Visitor', '09171234567', 'Registrar', current_date, now());

insert into public.passes (id, visitor_id, public_reference, token_digest, source, status, valid_from, valid_until)
values ('00000000-0000-0000-0000-000000000721', '00000000-0000-0000-0000-000000000711',
        '10000000-0000-4000-a000-000000000721', decode(repeat('a', 64), 'hex'), 'portal', 'issued', now() - interval '1 minute', now() + interval '1 day');

select extensions.ok(
  has_function_privilege('service_role', 'api.request_email_verification_code(uuid,uuid,text,text,uuid,uuid,timestamptz)', 'EXECUTE'),
  'service role can request a challenge'
);
select extensions.ok(
  not has_function_privilege('authenticated', 'api.request_email_verification_code(uuid,uuid,text,text,uuid,uuid,timestamptz)', 'EXECUTE'),
  'authenticated client cannot call challenge definer'
);
select extensions.ok(
  not has_function_privilege('anon', 'api.verify_and_claim_email_dispatch(uuid,uuid,uuid,text,text,uuid)', 'EXECUTE'),
  'anonymous client cannot claim a dispatch'
);
select extensions.is(
  (select count(*) from information_schema.routine_privileges
    where routine_schema = 'api' and routine_name = 'finalize_email_dispatch' and grantee = 'PUBLIC'),
  0::bigint, 'PUBLIC cannot finalize a dispatch'
);

set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);

select extensions.lives_ok($$select api.request_email_verification_code(
  '00000000-0000-0000-0000-000000000721', '00000000-0000-0000-0000-000000000701', 'visitor@example.com', repeat('1', 64),
  '00000000-0000-0000-0000-000000000731', '00000000-0000-0000-0000-000000000741', now() + interval '10 minutes')$$,
  'first challenge request succeeds');

select extensions.is(
  (select api.request_email_verification_code(
    '00000000-0000-0000-0000-000000000721', '00000000-0000-0000-0000-000000000701', 'visitor@example.com', repeat('2', 64),
    '00000000-0000-0000-0000-000000000731', '00000000-0000-0000-0000-000000000742', now() + interval '10 minutes')->>'dispatch_code'),
  'false', 'same challenge key replays without another code dispatch');

select extensions.throws_ok($$select api.request_email_verification_code(
  '00000000-0000-0000-0000-000000000721', '00000000-0000-0000-0000-000000000701', 'other@example.com', repeat('1', 64),
  '00000000-0000-0000-0000-000000000731', '00000000-0000-0000-0000-000000000743', now() + interval '10 minutes')$$,
  'P0008', 'idempotency_key_mismatch', 'challenge key is recipient-bound');

select extensions.lives_ok($$select api.request_email_verification_code(
  '00000000-0000-0000-0000-000000000721', '00000000-0000-0000-0000-000000000701', 'visitor@example.com', repeat('2', 64),
  '00000000-0000-0000-0000-000000000732', '00000000-0000-0000-0000-000000000742', now() + interval '10 minutes')$$,
  'second distinct challenge fits rate limit');
select extensions.lives_ok($$select api.request_email_verification_code(
  '00000000-0000-0000-0000-000000000721', '00000000-0000-0000-0000-000000000701', 'visitor@example.com', repeat('3', 64),
  '00000000-0000-0000-0000-000000000733', '00000000-0000-0000-0000-000000000743', now() + interval '10 minutes')$$,
  'third distinct challenge fits rate limit');
select extensions.throws_ok($$select api.request_email_verification_code(
  '00000000-0000-0000-0000-000000000721', '00000000-0000-0000-0000-000000000701', 'visitor@example.com', repeat('4', 64),
  '00000000-0000-0000-0000-000000000734', '00000000-0000-0000-0000-000000000744', now() + interval '10 minutes')$$,
  'P0003', 'too_many_requests', 'fourth challenge is rate limited');

select extensions.is(
  (select api.finalize_email_verification_code('00000000-0000-0000-0000-000000000741', '00000000-0000-0000-0000-000000000731', 'sent_to_provider', 'provider-code')->>'code_delivery_status'),
  'sent_to_provider', 'verification-code provider acceptance is finalized');

select extensions.is(
  (select api.verify_and_claim_email_dispatch(
    '00000000-0000-0000-0000-000000000741', '00000000-0000-0000-0000-000000000721', '00000000-0000-0000-0000-000000000701',
    'visitor@example.com', repeat('0', 64), '00000000-0000-0000-0000-000000000751')->>'attempts_remaining'),
  '2', 'wrong code increments attempts atomically');

update public.pass_email_verifications set code_hash = repeat('9', 64)
where id = '00000000-0000-0000-0000-000000000741';

select extensions.is(
  (select api.verify_and_claim_email_dispatch(
    '00000000-0000-0000-0000-000000000741', '00000000-0000-0000-0000-000000000721', '00000000-0000-0000-0000-000000000701',
    'visitor@example.com', repeat('9', 64), '00000000-0000-0000-0000-000000000751')->>'dispatch_authorized'),
  'true', 'correct code authorizes one dispatch claim');

select extensions.is(
  (select api.verify_and_claim_email_dispatch(
    '00000000-0000-0000-0000-000000000741', '00000000-0000-0000-0000-000000000721', '00000000-0000-0000-0000-000000000701',
    'visitor@example.com', repeat('9', 64), '00000000-0000-0000-0000-000000000751')->>'dispatch_authorized'),
  'false', 'same send key replay cannot dispatch again');

select extensions.throws_ok($$select api.verify_and_claim_email_dispatch(
  '00000000-0000-0000-0000-000000000741', '00000000-0000-0000-0000-000000000721', '00000000-0000-0000-0000-000000000701',
  'visitor@example.com', repeat('9', 64), '00000000-0000-0000-0000-000000000752')$$,
  'P0005', 'dispatch_in_progress', 'different send key cannot bypass active claim');

select extensions.is(
  (select api.finalize_email_dispatch('00000000-0000-0000-0000-000000000741', '00000000-0000-0000-0000-000000000751', 'sent_to_provider', 'provider-qr')->>'delivery_status'),
  'sent_to_provider', 'provider acceptance is finalized');

select extensions.is(
  (select api.finalize_email_dispatch('00000000-0000-0000-0000-000000000741', '00000000-0000-0000-0000-000000000751', 'delivery_failed', null)->>'delivery_status'),
  'sent_to_provider', 'stale failure cannot overwrite provider acceptance');

select extensions.throws_ok($$select api.finalize_email_dispatch(
  '00000000-0000-0000-0000-000000000741', '00000000-0000-0000-0000-000000000799', 'delivery_failed', null)$$,
  'P0002', 'claim_not_found', 'wrong claim key cannot finalize');

reset role;
select * from extensions.finish();
rollback;

-- Genuine distinct-transaction serialization still requires the disposable Postgres
-- runner: execute two sessions requesting different request IDs for the same pass,
-- hold session A after its parent-pass FOR UPDATE, and assert session B blocks before
-- the rate-limit count. This file is AUTHORED / NOT RUN in the current environment.
