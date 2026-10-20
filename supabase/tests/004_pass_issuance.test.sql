begin;

create extension if not exists pgtap with schema extensions;
select extensions.plan(10);

insert into auth.users (
  id, aud, role, email, encrypted_password, email_confirmed_at, is_anonymous, created_at, updated_at
) values (
  '00000000-0000-0000-0000-000000000401', 'authenticated', 'authenticated', null, '', now(), true, now(), now()
);

insert into public.upload_intents (
  id, owner_id, source, kind, bucket_id, object_path, content_type, expires_at
) values
  ('00000000-0000-0000-0000-000000000411', '00000000-0000-0000-0000-000000000401', 'portal', 'photo', 'visitor-photos', '00000000-0000-0000-0000-000000000401/photo.webp', 'image/webp', now() + interval '10 minutes'),
  ('00000000-0000-0000-0000-000000000412', '00000000-0000-0000-0000-000000000401', 'portal', 'id', 'visitor-ids', '00000000-0000-0000-0000-000000000401/id.webp', 'image/webp', now() + interval '10 minutes');

select extensions.ok(
  has_function_privilege('service_role', 'api.issue_pass(uuid,public.pass_source,uuid,text,text,text,date,uuid,integer,text,uuid,integer,text,text)', 'EXECUTE'),
  'service role can execute pass issuance'
);

select extensions.ok(
  not has_function_privilege('authenticated', 'api.issue_pass(uuid,public.pass_source,uuid,text,text,text,date,uuid,integer,text,uuid,integer,text,text)', 'EXECUTE'),
  'ordinary authenticated callers cannot execute pass issuance'
);

set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);

select extensions.lives_ok(
  $$select * from api.issue_pass(
    '00000000-0000-0000-0000-000000000401', 'portal',
    '00000000-0000-0000-0000-000000000421', 'Juan Dela Cruz', '09171234567',
    'Campus appointment', (now() at time zone 'Asia/Manila')::date,
    '00000000-0000-0000-0000-000000000411', 100, repeat('a', 64),
    '00000000-0000-0000-0000-000000000412', 100, repeat('b', 64), repeat('c', 64)
  )$$,
  'service validates and atomically issues a portal pass'
);

select extensions.is((select count(*) from public.passes where issue_request_id = '00000000-0000-0000-0000-000000000421'), 1::bigint, 'one pass is issued');
select extensions.is((select count(*) from public.visitor_evidence), 2::bigint, 'both evidence records are claimed');
select extensions.is((select count(*) from public.upload_intents where status = 'claimed'), 2::bigint, 'both intents become claimed');
select extensions.is((select encode(token_digest, 'hex') from public.passes where issue_request_id = '00000000-0000-0000-0000-000000000421'), repeat('c', 64), 'only the QR digest is stored');

select extensions.lives_ok(
  $$select * from api.issue_pass(
    '00000000-0000-0000-0000-000000000401', 'portal',
    '00000000-0000-0000-0000-000000000421', 'Juan Dela Cruz', '09171234567',
    'Campus appointment', (now() at time zone 'Asia/Manila')::date,
    '00000000-0000-0000-0000-000000000411', 100, repeat('a', 64),
    '00000000-0000-0000-0000-000000000412', 100, repeat('b', 64), repeat('c', 64)
  )$$,
  'the same request id is idempotent'
);

select extensions.is((select count(*) from public.passes where issue_request_id = '00000000-0000-0000-0000-000000000421'), 1::bigint, 'idempotency does not duplicate a pass');

select extensions.throws_ok(
  $$select * from api.issue_pass(
    '00000000-0000-0000-0000-000000000401', 'kiosk',
    '00000000-0000-0000-0000-000000000422', 'Juan Dela Cruz', '09171234567',
    'Campus appointment', (now() at time zone 'Asia/Manila')::date,
    '00000000-0000-0000-0000-000000000411', 100, repeat('a', 64),
    '00000000-0000-0000-0000-000000000412', 100, repeat('b', 64), repeat('d', 64)
  )$$,
  '42501', 'active kiosk identity required',
  'a portal identity cannot forge kiosk issuance'
);

reset role;
select * from extensions.finish();
rollback;
