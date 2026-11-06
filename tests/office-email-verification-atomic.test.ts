import { describe, it, expect, beforeAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
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

describe('Office Email Verification Atomic 5-Attempt Ceiling (PGlite)', () => {
  const visitorUserId = '11111111-1111-4111-8111-111111111111';
  const otherUserId = '22222222-2222-4222-8222-222222222222';
  const secret = 'test-token-secret-must-be-at-least-32-chars-long!';
  const correctCode = '123456';
  const wrongCode = '999999';

  const correctHash = createHash('sha256').update(`${correctCode}:${secret}`).digest('hex');
  const wrongHash = createHash('sha256').update(`${wrongCode}:${secret}`).digest('hex');

  let db: PGlite;

  beforeAll(async () => {
    db = new PGlite();
    await applyAllMigrations(db);

    await db.exec(`
      insert into auth.users (id, email, is_anonymous) values
      ('${visitorUserId}', 'visitor@test.local', true),
      ('${otherUserId}', 'other@test.local', true);
    `);
  }, 120000);

  it('1. Correct code on first attempt marks challenge verified and records consumed_at', async () => {
    const email1 = 'visitor1@test.local';
    const challengeRes = await db.query<{ id: string }>(`
      insert into public.office_visit_email_verifications (
        email, code_hash, actor_id, expires_at, verified, attempts
      ) values (
        '${email1}', '${correctHash}', '${visitorUserId}', now() + interval '15 minutes', false, 0
      ) returning id;
    `);
    const challengeId = challengeRes.rows[0].id;

    const verifyRes = await db.query<{
      status: string;
      attempts_remaining: number;
      challenge_id: string;
    }>(`
      select * from api.verify_office_email_challenge(
        requested_actor_id => '${visitorUserId}'::uuid,
        requested_email => '${email1}',
        requested_code_hash => '${correctHash}'
      );
    `);

    expect(verifyRes.rows.length).toBe(1);
    expect(verifyRes.rows[0].status).toBe('ok');
    expect(verifyRes.rows[0].attempts_remaining).toBe(4);
    expect(verifyRes.rows[0].challenge_id).toBe(challengeId);

    // Verify row state in DB
    const checkDb = await db.query<{ verified: boolean; consumed_at: string; attempts: number }>(`
      select verified, consumed_at, attempts
      from public.office_visit_email_verifications
      where id = '${challengeId}';
    `);
    expect(checkDb.rows[0].verified).toBe(true);
    expect(checkDb.rows[0].consumed_at).not.toBeNull();
    expect(checkDb.rows[0].attempts).toBe(1);
  });

  it('2. Enforces atomic 5-attempt ceiling and locks out code after 5 failures', async () => {
    const email2 = 'visitor2@test.local';
    const challengeRes = await db.query<{ id: string }>(`
      insert into public.office_visit_email_verifications (
        email, code_hash, actor_id, expires_at, verified, attempts
      ) values (
        '${email2}', '${correctHash}', '${visitorUserId}', now() + interval '15 minutes', false, 0
      ) returning id;
    `);
    const challengeId = challengeRes.rows[0].id;

    // Attempts 1 to 4: invalid_code with decremented attempts_remaining
    for (let i = 1; i <= 4; i++) {
      const res = await db.query<{ status: string; attempts_remaining: number }>(`
        select * from api.verify_office_email_challenge(
          requested_actor_id => '${visitorUserId}'::uuid,
          requested_email => '${email2}',
          requested_code_hash => '${wrongHash}'
        );
      `);
      expect(res.rows[0].status).toBe('invalid_code');
      expect(res.rows[0].attempts_remaining).toBe(5 - i);
    }

    // 5th attempt: reaches ceiling, status = too_many_attempts, attempts_remaining = 0
    const fifthRes = await db.query<{ status: string; attempts_remaining: number }>(`
      select * from api.verify_office_email_challenge(
        requested_actor_id => '${visitorUserId}'::uuid,
        requested_email => '${email2}',
        requested_code_hash => '${wrongHash}'
      );
    `);
    expect(fifthRes.rows[0].status).toBe('too_many_attempts');
    expect(fifthRes.rows[0].attempts_remaining).toBe(0);

    // 6th attempt: even with the CORRECT code now, verification is permanently locked out!
    const sixthRes = await db.query<{ status: string; attempts_remaining: number }>(`
      select * from api.verify_office_email_challenge(
        requested_actor_id => '${visitorUserId}'::uuid,
        requested_email => '${email2}',
        requested_code_hash => '${correctHash}'
      );
    `);
    expect(sixthRes.rows[0].status).toBe('too_many_attempts');

    // Verify row state in DB: attempts = 5, verified = false
    const checkDb = await db.query<{ verified: boolean; attempts: number }>(`
      select verified, attempts
      from public.office_visit_email_verifications
      where id = '${challengeId}';
    `);
    expect(checkDb.rows[0].verified).toBe(false);
    expect(checkDb.rows[0].attempts).toBe(5);
  });

  it('3. Rejects verification attempt by an imposter actor', async () => {
    const email3 = 'visitor3@test.local';
    await db.query(`
      insert into public.office_visit_email_verifications (
        email, code_hash, actor_id, expires_at, verified, attempts
      ) values (
        '${email3}', '${correctHash}', '${visitorUserId}', now() + interval '15 minutes', false, 0
      );
    `);

    // Imposter otherUserId attempts to verify visitorUserId's email
    const res = await db.query<{ status: string }>(`
      select * from api.verify_office_email_challenge(
        requested_actor_id => '${otherUserId}'::uuid,
        requested_email => '${email3}',
        requested_code_hash => '${correctHash}'
      );
    `);
    // Should be expired_or_not_found because challenge belongs to visitorUserId
    expect(res.rows[0].status).toBe('expired_or_not_found');
  });

  it('4. Rejects replay attack on an already consumed verification challenge', async () => {
    const email4 = 'visitor4@test.local';
    await db.query(`
      insert into public.office_visit_email_verifications (
        email, code_hash, actor_id, expires_at, verified, attempts
      ) values (
        '${email4}', '${correctHash}', '${visitorUserId}', now() + interval '15 minutes', false, 0
      );
    `);

    // First verification succeeds
    const firstRes = await db.query<{ status: string }>(`
      select * from api.verify_office_email_challenge(
        requested_actor_id => '${visitorUserId}'::uuid,
        requested_email => '${email4}',
        requested_code_hash => '${correctHash}'
      );
    `);
    expect(firstRes.rows[0].status).toBe('ok');

    // Second verification replay attempt with the same challenge
    const replayRes = await db.query<{ status: string }>(`
      select * from api.verify_office_email_challenge(
        requested_actor_id => '${visitorUserId}'::uuid,
        requested_email => '${email4}',
        requested_code_hash => '${correctHash}'
      );
    `);
    // Must be expired_or_not_found because consumed_at is not null
    expect(replayRes.rows[0].status).toBe('expired_or_not_found');
  });
});
