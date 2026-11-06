import { describe, it, expect, beforeAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';

const MIGRATIONS_DIR = join(process.cwd(), 'supabase', 'migrations');

async function setupSupabaseEmulation(db: PGlite) {
  await db.exec(`
    create schema if not exists auth;
    create schema if not exists storage;
    create schema if not exists private;
    create schema if not exists api;

    do $$
    begin
      if not exists (select 1 from pg_roles where rolname = 'anon') then
        create role anon nologin;
      end if;
      if not exists (select 1 from pg_roles where rolname = 'authenticated') then
        create role authenticated nologin;
      end if;
      if not exists (select 1 from pg_roles where rolname = 'service_role') then
        create role service_role nologin;
      end if;
    end
    $$;

    create table if not exists auth.users (
      id uuid primary key,
      email text,
      email_confirmed_at timestamptz,
      encrypted_password text,
      is_anonymous boolean default false,
      raw_app_meta_data jsonb default '{}'::jsonb,
      raw_user_meta_data jsonb default '{}'::jsonb,
      created_at timestamptz default now(),
      updated_at timestamptz default now()
    );

    create or replace function auth.uid() returns uuid as $$
      select coalesce(
        nullif(current_setting('request.jwt.claim.sub', true), '')::uuid,
        (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid,
        nullif(current_setting('my.auth.uid', true), '')::uuid,
        '00000000-0000-0000-0000-000000000001'::uuid
      );
    $$ language sql stable;

    create or replace function auth.role() returns text as $$
      select coalesce(
        nullif(current_setting('request.jwt.claim.role', true), ''),
        (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'),
        'service_role'::text
      );
    $$ language sql stable;

    grant usage on schema auth to anon, authenticated, service_role;
    grant execute on function auth.uid() to anon, authenticated, service_role;
    grant execute on function auth.role() to anon, authenticated, service_role;

    create table if not exists storage.buckets (
      id text primary key,
      name text,
      owner uuid,
      owner_id text,
      created_at timestamptz,
      updated_at timestamptz,
      public boolean default false,
      avif_autodetection boolean default false,
      file_size_limit bigint,
      allowed_mime_types text[]
    );

    create table if not exists storage.objects (
      id uuid primary key default gen_random_uuid(),
      bucket_id text,
      name text,
      owner uuid,
      owner_id text,
      created_at timestamptz,
      updated_at timestamptz,
      last_accessed_at timestamptz,
      metadata jsonb
    );

    do $$
    begin
      if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
        create publication supabase_realtime;
      end if;
    end
    $$;
  `);
}

async function applyAllMigrations(db: PGlite) {
  await setupSupabaseEmulation(db);
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    let sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    sql = sql.replace(/create extension if not exists pgcrypto[^;]*;/gi, '-- pgcrypto no-op');
    sql = sql.replace(/create extension if not exists "uuid-ossp"[^;]*;/gi, '-- uuid-ossp no-op');
    await db.exec(sql);
  }
}

describe('Office Visit Upload Hold Revalidation and Scheduling Invariants (PGlite)', () => {
  const visitorUserId = '11111111-1111-4111-8111-111111111111';
  const otherVisitorId = '33333333-3333-4333-8333-333333333333';
  const staffUserId = '22222222-2222-4222-8222-222222222222';
  const returningProfileId = '44444444-4444-4444-8444-444444444444';

  let db: PGlite;
  let officeId: string;
  let personnelId: string;

  beforeAll(async () => {
    db = new PGlite();
    await applyAllMigrations(db);

    await db.exec(`
      insert into auth.users (id, email, is_anonymous) values
      ('${visitorUserId}', 'visitor@test.local', true),
      ('${otherVisitorId}', 'imposter@test.local', true),
      ('${staffUserId}', 'staff@earist.edu.ph', false);

      insert into public.staff_profiles (user_id, display_name, role)
      values ('${staffUserId}', 'Admin Staff', 'superadmin');
    `);

    const officeRes = await db.query<{ id: string }>(`select id from public.offices limit 1;`);
    officeId = officeRes.rows[0].id;

    const persRes = await db.query<{ id: string }>(`
      insert into public.office_personnel (office_id, name, title)
      values ('${officeId}', 'Dr. John Registrar', 'Registrar')
      returning id;
    `);
    personnelId = persRes.rows[0].id;

    // Create a returning visitor profile for tests
    await db.exec(`
      insert into public.returning_visitor_profiles (
        id, first_name, last_name, contact_number_e164, home_address
      ) values (
        '${returningProfileId}', 'Returning', 'Visitor', '+639171234567', 'Manila, Philippines'
      );
    `);
  }, 120000);

  it('1. Rejects request with visit date in the past', async () => {
    await expect(
      db.query(`
        select * from api.create_specific_person_visit_request(
          requested_actor_id => '${visitorUserId}'::uuid,
          requested_request_id => gen_random_uuid(),
          requested_office_id => '${officeId}'::uuid,
          requested_personnel_id => '${personnelId}'::uuid,
          requested_first_name => 'Juan',
          requested_middle_name => null,
          requested_last_name => 'Dela Cruz',
          requested_contact_number => '09171234567',
          requested_email => 'visitor@test.local',
          requested_purpose => 'Consultation',
          requested_visit_date => current_date - 1,
          requested_arrival_mode => 'no_vehicle',
          requested_vehicle_details => null::jsonb,
          requested_address_details => null::jsonb,
          requested_registration_mode => 'new'
        );
      `)
    ).rejects.toThrow(/visit_date_in_past/);
  });

  it('2. Rejects request with visit date beyond the advance scheduling horizon', async () => {
    await expect(
      db.query(`
        select * from api.create_specific_person_visit_request(
          requested_actor_id => '${visitorUserId}'::uuid,
          requested_request_id => gen_random_uuid(),
          requested_office_id => '${officeId}'::uuid,
          requested_personnel_id => '${personnelId}'::uuid,
          requested_first_name => 'Juan',
          requested_middle_name => null,
          requested_last_name => 'Dela Cruz',
          requested_contact_number => '09171234567',
          requested_email => 'visitor@test.local',
          requested_purpose => 'Consultation',
          requested_visit_date => current_date + 60,
          requested_arrival_mode => 'no_vehicle',
          requested_vehicle_details => null::jsonb,
          requested_address_details => null::jsonb,
          requested_registration_mode => 'new'
        );
      `)
    ).rejects.toThrow(/visit_date_beyond_horizon/);
  });

  it('3. Rejects idempotent re-submission when caller actor does not match original actor', async () => {
    const fixedRequestId = '55555555-5555-4555-8555-555555555555';
    const photoId = '66666666-6666-4666-8666-666666666666';
    const idId = '77777777-7777-4777-8777-777777777777';

    // Insert valid upload intents
    await db.exec(`
      insert into public.upload_intents (id, owner_id, source, kind, bucket_id, object_path, content_type, max_bytes, status, expires_at) values
      ('${photoId}', '${visitorUserId}', 'portal', 'photo', 'visitor-photos', 'photo-3.jpg', 'image/jpeg', 5000000, 'uploaded', now() + interval '1 hour'),
      ('${idId}', '${visitorUserId}', 'portal', 'id', 'visitor-ids', 'id-3.jpg', 'image/jpeg', 5000000, 'uploaded', now() + interval '1 hour');

      insert into public.portal_identity_verification_attempts (
        owner_id, request_id, photo_intent_id, id_intent_id, outcome, expires_at, model_name, model_version
      ) values (
        '${visitorUserId}', '${fixedRequestId}', '${photoId}', '${idId}', 'matched', now() + interval '10 minutes', 'face-api', '1.0'
      );
    `);

    // First request by visitorUserId
    await db.query(`
      select * from api.create_specific_person_visit_request(
        requested_actor_id => '${visitorUserId}'::uuid,
        requested_request_id => '${fixedRequestId}'::uuid,
        requested_office_id => '${officeId}'::uuid,
        requested_personnel_id => '${personnelId}'::uuid,
        requested_first_name => 'Juan',
        requested_middle_name => null,
        requested_last_name => 'Dela Cruz',
        requested_contact_number => '09171234567',
        requested_email => 'visitor@test.local',
        requested_purpose => 'Consultation',
        requested_visit_date => current_date,
        requested_arrival_mode => 'no_vehicle',
        requested_vehicle_details => null::jsonb,
        requested_address_details => null::jsonb,
        requested_photo_intent_id => '${photoId}'::uuid,
        requested_photo_bytes => 1024,
        requested_photo_sha256 => '${'a'.repeat(64)}',
        requested_id_intent_id => '${idId}'::uuid,
        requested_id_bytes => 2048,
        requested_id_sha256 => '${'b'.repeat(64)}',
        requested_registration_mode => 'new'
      );
    `);

    // Second request with same fixedRequestId by imposter otherVisitorId
    await expect(
      db.query(`
        select * from api.create_specific_person_visit_request(
          requested_actor_id => '${otherVisitorId}'::uuid,
          requested_request_id => '${fixedRequestId}'::uuid,
          requested_office_id => '${officeId}'::uuid,
          requested_personnel_id => '${personnelId}'::uuid,
          requested_first_name => 'Imposter',
          requested_middle_name => null,
          requested_last_name => 'Visitor',
          requested_contact_number => '09179999999',
          requested_email => 'imposter@test.local',
          requested_purpose => 'Consultation',
          requested_visit_date => current_date,
          requested_arrival_mode => 'no_vehicle',
          requested_vehicle_details => null::jsonb,
          requested_address_details => null::jsonb,
          requested_registration_mode => 'new'
        );
      `)
    ).rejects.toThrow(/request_id_actor_mismatch/);
  });

  it('4. Rejects approval if photo upload hold has expired or storage was cleaned', async () => {
    const photoId = '88888888-8888-4888-8888-888888888888';
    const idId = '99999999-9999-4999-8999-999999999999';
    const reqId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

    await db.exec(`
      insert into public.upload_intents (id, owner_id, source, kind, bucket_id, object_path, content_type, max_bytes, status, expires_at) values
      ('${photoId}', '${visitorUserId}', 'portal', 'photo', 'visitor-photos', 'photo-4.jpg', 'image/jpeg', 5000000, 'uploaded', now() + interval '1 hour'),
      ('${idId}', '${visitorUserId}', 'portal', 'id', 'visitor-ids', 'id-4.jpg', 'image/jpeg', 5000000, 'uploaded', now() + interval '1 hour');

      insert into public.portal_identity_verification_attempts (
        owner_id, request_id, photo_intent_id, id_intent_id, outcome, expires_at, model_name, model_version
      ) values (
        '${visitorUserId}', '${reqId}', '${photoId}', '${idId}', 'matched', now() + interval '10 minutes', 'face-api', '1.0'
      );
    `);

    const createRes = await db.query<{ visit_id: string }>(`
      select * from api.create_specific_person_visit_request(
        requested_actor_id => '${visitorUserId}'::uuid,
        requested_request_id => '${reqId}'::uuid,
        requested_office_id => '${officeId}'::uuid,
        requested_personnel_id => '${personnelId}'::uuid,
        requested_first_name => 'Juan',
        requested_middle_name => null,
        requested_last_name => 'Dela Cruz',
        requested_contact_number => '09171234567',
        requested_email => 'visitor@test.local',
        requested_purpose => 'Consultation',
        requested_visit_date => current_date,
        requested_arrival_mode => 'no_vehicle',
        requested_vehicle_details => null::jsonb,
        requested_address_details => null::jsonb,
        requested_photo_intent_id => '${photoId}'::uuid,
        requested_photo_bytes => 1024,
        requested_photo_sha256 => '${'a'.repeat(64)}',
        requested_id_intent_id => '${idId}'::uuid,
        requested_id_bytes => 2048,
        requested_id_sha256 => '${'b'.repeat(64)}',
        requested_registration_mode => 'new'
      );
    `);
    const visitId = createRes.rows[0].visit_id;

    // Simulate storage cleanup on photo intent
    await db.exec(`
      update public.upload_intents set storage_cleaned_at = now() where id = '${photoId}';
    `);

    await expect(
      db.query(`
        select * from api.decide_office_visit(
          requested_actor_id => '${staffUserId}'::uuid,
          requested_visit_id => '${visitId}'::uuid,
          requested_decision => 'approved',
          requested_rejection_reason => null,
          requested_token_digest => '${'c'.repeat(64)}',
          requested_encrypted_payload => 'c2VjdXJlX2VuY3J5cHRlZF9xcl9wYXlsb2Fk'
        );
      `)
    ).rejects.toThrow(/invalid_or_expired_photo_evidence/);
  });

  it('5. Successfully approves genuine returning visitor visit without requiring new photo upload intents', async () => {
    const reqId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const matchDigest = 'digest1234567890abcdef1234567890abcdef';
    const returningAttemptId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

    await db.exec(`
      insert into public.returning_identity_attempts (
        id, owner_id, request_id, matched_profile_id, match_token_digest, outcome, expires_at
      ) values (
        '${returningAttemptId}', '${visitorUserId}', '${reqId}', '${returningProfileId}',
        '${matchDigest}', 'matched', now() + interval '10 minutes'
      );
    `);

    const createRes = await db.query<{ visit_id: string }>(`
      select * from api.create_specific_person_visit_request(
        requested_actor_id => '${visitorUserId}'::uuid,
        requested_request_id => '${reqId}'::uuid,
        requested_office_id => '${officeId}'::uuid,
        requested_personnel_id => '${personnelId}'::uuid,
        requested_first_name => 'Returning',
        requested_middle_name => null,
        requested_last_name => 'Visitor',
        requested_contact_number => '09171234567',
        requested_email => 'returning@test.local',
        requested_purpose => 'Dean Consultation',
        requested_visit_date => current_date,
        requested_arrival_mode => 'no_vehicle',
        requested_vehicle_details => null::jsonb,
        requested_address_details => null::jsonb,
        requested_registration_mode => 'returning',
        requested_returning_profile_id => '${returningProfileId}'::uuid,
        requested_returning_match_token_digest => '${matchDigest}'
      );
    `);
    const visitId = createRes.rows[0].visit_id;

    const decideRes = await db.query<{ ok: boolean; qr_token: string; pass_id: string }>(`
      select * from api.decide_office_visit(
        requested_actor_id => '${staffUserId}'::uuid,
        requested_visit_id => '${visitId}'::uuid,
        requested_decision => 'approved',
        requested_rejection_reason => null,
        requested_token_digest => '${'d'.repeat(64)}',
        requested_encrypted_payload => 'c2VjdXJlX2VuY3J5cHRlZF9xcl9wYXlsb2Fk'
      );
    `);

    expect(decideRes.rows.length).toBe(1);
    expect(decideRes.rows[0].ok).toBe(true);

    // Verify outbox entry was created with idempotency_key
    const outboxRes = await db.query<{ office_visit_id: string; delivery_status: string; idempotency_key: string }>(`
      select office_visit_id, delivery_status, idempotency_key
      from public.office_visit_email_outbox
      where office_visit_id = '${visitId}';
    `);
    expect(outboxRes.rows.length).toBe(1);
    expect(outboxRes.rows[0].delivery_status).toBe('pending');
    expect(outboxRes.rows[0].idempotency_key).toContain(visitId);
  });
});
