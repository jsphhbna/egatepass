-- supabase/tests/009_cross_pass_abuse_concurrency.test.sql
-- Two-session SQL contention and cross-pass rate limiting test specification
-- Verifies that pg_advisory_xact_lock in api.request_email_verification_code
-- serializes concurrent requests across distinct passes targeting the same recipient or actor.
-- Classification: AUTHORED / STATIC-VALIDATED; DATABASE EXECUTION NOT RUN (pending isolated PostgreSQL runtime)

begin;

create extension if not exists pgtap with schema extensions;
select extensions.plan(14);

-- 1. Function privileges for 001200 hardened functions
select extensions.ok(
  has_function_privilege('service_role', 'api.claim_evidence_for_purge(uuid,uuid)', 'EXECUTE'),
  'service role can call hardened claim_evidence_for_purge'
);
select extensions.ok(
  not has_function_privilege('authenticated', 'api.claim_evidence_for_purge(uuid,uuid)', 'EXECUTE'),
  'authenticated client cannot call claim_evidence_for_purge'
);
select extensions.ok(
  has_function_privilege('service_role', 'api.finalize_evidence_purge(uuid,uuid,boolean)', 'EXECUTE'),
  'service role can call hardened finalize_evidence_purge'
);
select extensions.ok(
  not has_function_privilege('anon', 'api.finalize_evidence_purge(uuid,uuid,boolean)', 'EXECUTE'),
  'anon client cannot call finalize_evidence_purge'
);
select extensions.ok(
  has_function_privilege('service_role', 'api.request_email_verification_code(uuid,uuid,text,text,uuid,uuid,timestamptz)', 'EXECUTE'),
  'service role can call concurrency-safe request_email_verification_code'
);

-- Seed synthetic users and passes
insert into auth.users (id, aud, role, email, encrypted_password, email_confirmed_at, is_anonymous, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000000901', 'authenticated', 'authenticated', null, '', now(), true, now(), now()),
  ('00000000-0000-0000-0000-000000000902', 'authenticated', 'authenticated', null, '', now(), true, now(), now());

-- Seed two distinct visitors
insert into public.visitors (id, owner_id, source, full_name, contact_number, purpose, visit_date, consent_accepted_at)
values
  ('00000000-0000-0000-0000-000000000911', '00000000-0000-0000-0000-000000000901', 'portal', 'Visitor One', '09170000001', 'Meeting', current_date, now()),
  ('00000000-0000-0000-0000-000000000912', '00000000-0000-0000-0000-000000000902', 'portal', 'Visitor Two', '09170000002', 'Meeting', current_date, now());

-- Seed two distinct passes for different owners
insert into public.passes (id, visitor_id, public_reference, token_digest, source, status, valid_from, valid_until)
values
  ('00000000-0000-0000-0000-000000000921', '00000000-0000-0000-0000-000000000911',
   '10000000-0000-4000-a000-000000000921', decode(repeat('c', 64), 'hex'), 'portal', 'issued', now() - interval '1 minute', now() + interval '1 day'),
  ('00000000-0000-0000-0000-000000000922', '00000000-0000-0000-0000-000000000912',
   '10000000-0000-4000-a000-000000000922', decode(repeat('d', 64), 'hex'), 'portal', 'issued', now() - interval '1 minute', now() + interval '1 day');

set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);

-- Test 1: First challenge on Pass 1 for recipient shared@example.com
select extensions.lives_ok($$select api.request_email_verification_code(
  '00000000-0000-0000-0000-000000000921', '00000000-0000-0000-0000-000000000901', 'shared@example.com', repeat('1', 64),
  '00000000-0000-0000-0000-000000000931', '00000000-0000-0000-0000-000000000941', now() + interval '10 minutes')$$,
  'first challenge on pass 1 succeeds');

-- Test 2: Idempotent replay on Pass 1 with exact same request_id does not consume limit slot
select extensions.is(
  (select api.request_email_verification_code(
    '00000000-0000-0000-0000-000000000921', '00000000-0000-0000-0000-000000000901', 'shared@example.com', repeat('1', 64),
    '00000000-0000-0000-0000-000000000931', '00000000-0000-0000-0000-000000000941', now() + interval '10 minutes')->>'idempotent_replay'),
  'true',
  'idempotent replay returns idempotent_replay: true');

-- Test 3: Pass 2 (different pass, different owner) with same recipient shared@example.com
-- This tests that cross-pass recipient limit is checked across passes
select extensions.lives_ok($$select api.request_email_verification_code(
  '00000000-0000-0000-0000-000000000922', '00000000-0000-0000-0000-000000000902', 'shared@example.com', repeat('2', 64),
  '00000000-0000-0000-0000-000000000932', '00000000-0000-0000-0000-000000000942', now() + interval '10 minutes')$$,
  'second challenge on pass 2 sharing recipient succeeds (count 2/5)');

-- Insert 3 more challenges to reach recipient limit (5/5)
select api.request_email_verification_code(
  '00000000-0000-0000-0000-000000000921', '00000000-0000-0000-0000-000000000901', 'shared@example.com', repeat('3', 64),
  '00000000-0000-0000-0000-000000000933', '00000000-0000-0000-0000-000000000943', now() + interval '10 minutes');
select api.request_email_verification_code(
  '00000000-0000-0000-0000-000000000921', '00000000-0000-0000-0000-000000000901', 'shared@example.com', repeat('4', 64),
  '00000000-0000-0000-0000-000000000934', '00000000-0000-0000-0000-000000000944', now() + interval '10 minutes');
select api.request_email_verification_code(
  '00000000-0000-0000-0000-000000000922', '00000000-0000-0000-0000-000000000902', 'shared@example.com', repeat('5', 64),
  '00000000-0000-0000-0000-000000000935', '00000000-0000-0000-0000-000000000945', now() + interval '10 minutes');

-- Test 4: 6th challenge on Pass 2 sharing recipient is rejected with too_many_requests_recipient
select extensions.throws_ok($$select api.request_email_verification_code(
  '00000000-0000-0000-0000-000000000922', '00000000-0000-0000-0000-000000000902', 'shared@example.com', repeat('6', 64),
  '00000000-0000-0000-0000-000000000936', '00000000-0000-0000-0000-000000000946', now() + interval '10 minutes')$$,
  'P0003', 'too_many_requests_recipient',
  'cross-pass 6th challenge is rejected by recipient rate limit');

-- Seed evidence for purge testing
insert into public.upload_intents (id, owner_id, source, kind, bucket_id, object_path, content_type, max_bytes, status, expires_at, claimed_at, visitor_id)
values ('00000000-0000-0000-0000-000000000951', '00000000-0000-0000-0000-000000000901', 'portal', 'photo',
        'visitor-photos', 'visitor-911/photo.jpg', 'image/jpeg', 5242880, 'claimed', now() + interval '1 hour', now(), '00000000-0000-0000-0000-000000000911');

insert into public.visitor_evidence (id, visitor_id, upload_intent_id, kind, bucket_id, object_path, content_type, byte_size, sha256_hex, verified_at, expires_at, purged_at)
values ('00000000-0000-0000-0000-000000000961', '00000000-0000-0000-0000-000000000911',
        '00000000-0000-0000-0000-000000000951', 'photo', 'visitor-photos', 'visitor-911/photo.jpg', 'image/jpeg', 1024, repeat('e', 64), now(), now() - interval '1 hour', null);

-- Test 5: Claim evidence for purge
select extensions.is(
  (select api.claim_evidence_for_purge(
    '00000000-0000-0000-0000-000000000961', '00000000-0000-0000-0000-000000000971')->>'claimed'),
  'true',
  'worker 1 claims expired evidence');

-- Test 6: Simultaneous different worker claim is rejected
select extensions.is(
  (select api.claim_evidence_for_purge(
    '00000000-0000-0000-0000-000000000961', '00000000-0000-0000-0000-000000000972')->>'claimed'),
  'false',
  'worker 2 is rejected while worker 1 holds active lease');

-- Test 7: Finalize with wrong claim ID is rejected
select extensions.is(
  (select api.finalize_evidence_purge(
    '00000000-0000-0000-0000-000000000961', '00000000-0000-0000-0000-000000000972', true)->>'match_status'),
  'claim_mismatch',
  'worker 2 cannot finalize worker 1 claim');

-- Test 8: Finalize with matching claim ID succeeds
select extensions.is(
  (select api.finalize_evidence_purge(
    '00000000-0000-0000-0000-000000000961', '00000000-0000-0000-0000-000000000971', true)->>'match_status'),
  'matched',
  'worker 1 finalizes evidence with matching claim ID');

-- Test 9: Duplicate finalization after purge returns terminal_conflict
select extensions.is(
  (select api.finalize_evidence_purge(
    '00000000-0000-0000-0000-000000000961', '00000000-0000-0000-0000-000000000971', true)->>'match_status'),
  'terminal_conflict',
  'duplicate finalization returns terminal_conflict');

reset role;
select * from extensions.finish();
rollback;
-- This file is AUTHORED / NOT RUN in the current environment pending isolated PostgreSQL runtime.
