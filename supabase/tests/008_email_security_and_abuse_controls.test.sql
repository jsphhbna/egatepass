begin;

create extension if not exists pgtap with schema extensions;
select extensions.plan(12);

-- Check privileges for newly added purge RPCs
select extensions.ok(
  has_function_privilege('service_role', 'api.claim_evidence_for_purge(uuid,uuid)', 'EXECUTE'),
  'service role can claim evidence for purge'
);
select extensions.ok(
  not has_function_privilege('authenticated', 'api.claim_evidence_for_purge(uuid,uuid)', 'EXECUTE'),
  'authenticated client cannot claim evidence for purge'
);
select extensions.ok(
  has_function_privilege('service_role', 'api.finalize_evidence_purge(uuid,uuid,boolean)', 'EXECUTE'),
  'service role can finalize evidence purge'
);
select extensions.ok(
  not has_function_privilege('anon', 'api.finalize_evidence_purge(uuid,uuid,boolean)', 'EXECUTE'),
  'anonymous client cannot finalize evidence purge'
);

-- Check privilege for updated finalizers
select extensions.ok(
  has_function_privilege('service_role', 'api.finalize_email_verification_code(uuid,uuid,text,text)', 'EXECUTE'),
  'service role can call finalize_email_verification_code'
);
select extensions.ok(
  not has_function_privilege('authenticated', 'api.finalize_email_verification_code(uuid,uuid,text,text)', 'EXECUTE'),
  'authenticated cannot call finalize_email_verification_code'
);
select extensions.ok(
  has_function_privilege('service_role', 'api.finalize_email_dispatch(uuid,uuid,text,text)', 'EXECUTE'),
  'service role can call finalize_email_dispatch'
);
select extensions.ok(
  not has_function_privilege('anon', 'api.finalize_email_dispatch(uuid,uuid,text,text)', 'EXECUTE'),
  'anon cannot call finalize_email_dispatch'
);

-- Seed device and visitor for behavioral tests
insert into auth.users (id, aud, role, email, encrypted_password, email_confirmed_at, is_anonymous, created_at, updated_at)
values ('00000000-0000-0000-0000-000000000801', 'authenticated', 'authenticated', 'kiosk@devices.egatepass.invalid', '', now(), false, now(), now());

insert into public.devices (user_id, alias, name, type, gate, status)
values ('00000000-0000-0000-0000-000000000801', 'kiosk-unit-1', 'Main Lobby Kiosk', 'kiosk', 'Main Gate', 'active');

insert into public.visitors (id, owner_id, source, created_by_device_id, full_name, contact_number, purpose, visit_date, consent_accepted_at)
values ('00000000-0000-0000-0000-000000000811', '00000000-0000-0000-0000-000000000801', 'kiosk', '00000000-0000-0000-0000-000000000801',
        'Kiosk Visitor', '09170000001', 'Registrar', current_date, now());

insert into public.passes (id, visitor_id, public_reference, token_digest, source, status, valid_from, valid_until)
values ('00000000-0000-0000-0000-000000000821', '00000000-0000-0000-0000-000000000811',
        '10000000-0000-4000-a000-000000000821', decode(repeat('b', 64), 'hex'), 'kiosk', 'issued', now() - interval '1 minute', now() + interval '1 day');

set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);

-- EMAIL-M02: Active kiosk device can request code
select extensions.lives_ok($$select api.request_email_verification_code(
  '00000000-0000-0000-0000-000000000821', '00000000-0000-0000-0000-000000000801', 'kiosk.vis@example.com', repeat('5', 64),
  '00000000-0000-0000-0000-000000000831', '00000000-0000-0000-0000-000000000841', now() + interval '10 minutes')$$,
  'active kiosk device can request verification code');

-- Revoking kiosk device
update public.devices set status = 'revoked', deleted_at = now() where user_id = '00000000-0000-0000-0000-000000000801';

-- EMAIL-M02: Revoked kiosk device is denied
select extensions.throws_ok($$select api.request_email_verification_code(
  '00000000-0000-0000-0000-000000000821', '00000000-0000-0000-0000-000000000801', 'kiosk.vis2@example.com', repeat('6', 64),
  '00000000-0000-0000-0000-000000000832', '00000000-0000-0000-0000-000000000842', now() + interval '10 minutes')$$,
  '42501', 'kiosk_device_revoked', 'revoked kiosk device cannot request verification code');

-- Finalize with terminal status
select api.finalize_email_verification_code(
  '00000000-0000-0000-0000-000000000841', '00000000-0000-0000-0000-000000000831', 'sent_to_provider', 'resend_123');

-- EMAIL-H02: Conflict when trying to finalize with delivery_failed when already sent_to_provider
select extensions.is(
  (select api.finalize_email_verification_code(
    '00000000-0000-0000-0000-000000000841', '00000000-0000-0000-0000-000000000831', 'delivery_failed', null)->>'match_status'),
  'terminal_conflict', 'conflicting terminal status returns terminal_conflict');

select extensions.is(
  (select api.finalize_email_verification_code(
    '00000000-0000-0000-0000-000000000841', '00000000-0000-0000-0000-000000000831', 'delivery_failed', null)->>'success'),
  'false', 'conflicting terminal status returns success: false');

reset role;
select * from extensions.finish();
rollback;
-- This file is AUTHORED / NOT RUN in the current environment.
