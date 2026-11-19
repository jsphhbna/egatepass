import { describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const MIGRATIONS_DIR = join(process.cwd(), 'supabase', 'migrations');

async function setupSupabaseEmulation(db: PGlite): Promise<void> {
  await db.exec(`
    create schema if not exists auth;
    create schema if not exists storage;
    create schema if not exists private;
    create schema if not exists api;

    do $$ begin
      if not exists (select 1 from pg_roles where rolname = 'anon') then
        create role anon nologin;
      end if;
      if not exists (select 1 from pg_roles where rolname = 'authenticated') then
        create role authenticated nologin;
      end if;
      if not exists (select 1 from pg_roles where rolname = 'service_role') then
        create role service_role nologin;
      end if;
    end $$;

    grant usage on schema public to anon, authenticated, service_role;
    grant usage on schema api to anon, authenticated, service_role;
    grant usage on schema auth to anon, authenticated, service_role;
    grant usage on schema storage to anon, authenticated, service_role;

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

    create or replace function auth.jwt() returns jsonb as $$
      select case
        when nullif(current_setting('request.jwt.claims', true), '') is null then '{}'::jsonb
        else current_setting('request.jwt.claims', true)::jsonb
      end
    $$ language sql stable;

    grant usage on schema auth to anon, authenticated, service_role;
    grant execute on function auth.uid() to anon, authenticated, service_role;
    grant execute on function auth.role() to anon, authenticated, service_role;
    grant execute on function auth.jwt() to anon, authenticated, service_role;

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

    do $$ begin
      if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
        create publication supabase_realtime;
      end if;
    end $$;
  `);
}

async function applyAllMigrations(db: PGlite): Promise<string[]> {
  await setupSupabaseEmulation(db);
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    const rawSql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    const sql = rawSql.replace(
      /create extension if not exists pgcrypto[^;]*;/gi,
      '-- pgcrypto no-op'
    );
    try {
      await db.exec(sql);
    } catch (err: unknown) {
      console.error(`Migration failed in ${file}:`, err);
      throw err;
    }
  }
  return files;
}

describe('Milestone 1: Gender Tracking and Return-to-Zero Reset Migration Tests', () => {
  it('verifies gender schema additions and check constraints on visitors and returning_visitor_profiles', async () => {
    const db = new PGlite();
    await applyAllMigrations(db);

    // Verify columns exist
    const colCheck = await db.query<{ table_name: string; column_name: string }>(`
      select table_name, column_name
      from information_schema.columns
      where table_schema = 'public'
        and table_name in ('visitors', 'returning_visitor_profiles')
        and column_name = 'gender';
    `);
    expect(colCheck.rows.length).toBe(2);

    // Verify check constraints reject invalid gender
    await expect(
      db.exec(`
        insert into public.returning_visitor_profiles (
          first_name, last_name, contact_number_e164, home_address, gender
        ) values (
          'Test', 'User', '+639171234567', 'Manila', 'InvalidGender'
        );
      `)
    ).rejects.toThrow();

    // Verify valid gender ('Male', 'Female', NULL) succeeds
    await db.exec(`
      insert into public.returning_visitor_profiles (
        first_name, last_name, contact_number_e164, home_address, gender
      ) values
        ('Male', 'User', '+639171234561', 'Manila', 'Male'),
        ('Female', 'User', '+639171234562', 'Manila', 'Female'),
        ('Null', 'User', '+639171234563', 'Manila', null);
    `);

    const inserted = await db.query<{ count: string }>(`
      select count(*) as count from public.returning_visitor_profiles;
    `);
    expect(Number(inserted.rows[0].count)).toBe(3);
  }, 120_000);

  it('verifies api.issue_online_pass_v6 normalizes, persists, and enforces idempotency for gender', async () => {
    const db = new PGlite();
    await applyAllMigrations(db);

    const testActorId = '00000000-0000-0000-0000-000000000010';
    const reqId = '00000000-0000-0000-0000-000000000020';
    const photoIntentId = '00000000-0000-0000-0000-000000000030';
    const idIntentId = '00000000-0000-0000-0000-000000000040';

    await db.exec(`
      insert into auth.users (id, is_anonymous)
      values ('${testActorId}'::uuid, true)
      on conflict (id) do nothing;

      insert into storage.buckets (id, name, public) values
        ('visitor-photos', 'visitor-photos', false),
        ('visitor-ids', 'visitor-ids', false)
      on conflict (id) do nothing;

      insert into public.upload_intents (
        id, owner_id, bucket_id, object_path, kind, status,
        max_bytes, expires_at, source, content_type
      ) values
        ('${photoIntentId}'::uuid, '${testActorId}'::uuid, 'visitor-photos', 'test-photo.jpg', 'photo', 'pending', 5242880, now() + interval '1 hour', 'portal', 'image/jpeg'),
        ('${idIntentId}'::uuid, '${testActorId}'::uuid, 'visitor-ids', 'test-id.jpg', 'id', 'pending', 5242880, now() + interval '1 hour', 'portal', 'image/jpeg');

      insert into public.portal_identity_verification_attempts (
        id, owner_id, request_id, photo_intent_id, id_intent_id,
        outcome, model_name, model_version, verified_at, expires_at
      ) values (
        gen_random_uuid(), '${testActorId}'::uuid, '${reqId}', '${photoIntentId}'::uuid, '${idIntentId}'::uuid,
        'matched', 'opencv_zoo_yunet_sface', 'yunet_2023mar_sface_2021dec', now(), now() + interval '1 hour'
      );
    `);

    // 1. Negative test: Invalid gender rejected
    await expect(
      db.query(`
        select * from api.issue_online_pass_v6(
          '${testActorId}'::uuid, 'new', '${reqId}'::uuid,
          'Juan', null, 'Dela Cruz', '+639171234567', 'Campus Visit', (current_date + interval '1 day')::date,
          '${photoIntentId}'::uuid, 1024, repeat('a', 64),
          '${idIntentId}'::uuid, 2048, repeat('b', 64),
          repeat('c', 64), 'no_vehicle',
          '2026-q3', '1300000000', null, '1380600000', '1380600408',
          'Unit 1', 'Main St', '1008', 'PHLPost',
          null, null, null, null, null, null, null, 'catalog',
          null, null, null, null, null, null, false, false,
          null, null, 'InvalidGender'
        );
      `)
    ).rejects.toThrow(/invalid gender: must be Male or Female/);

    // 2. Positive test: Normalizes lowercase 'male' to 'Male' and persists
    const issueRes = await db.query<{ pass_id: string; public_reference: string }>(`
      select * from api.issue_online_pass_v6(
        '${testActorId}'::uuid, 'new', '${reqId}'::uuid,
        'Juan', null, 'Dela Cruz', '+639171234567', 'Campus Visit', (current_date + interval '1 day')::date,
        '${photoIntentId}'::uuid, 1024, repeat('a', 64),
        '${idIntentId}'::uuid, 2048, repeat('b', 64),
        repeat('c', 64), 'no_vehicle',
        '2026-q3', '1300000000', null, '1380600000', '1380600408',
        'Unit 1', 'Main St', '1008', 'PHLPost',
        null, null, null, null, null, null, null, 'catalog',
        null, null, null, null, null, null, false, false,
        null, null, 'male'
      );
    `);
    expect(issueRes.rows.length).toBe(1);

    // Verify persisted into visitors and returning_visitor_profiles
    const visCheck = await db.query<{ gender: string }>(`
      select gender from public.visitors where owner_id = '${testActorId}';
    `);
    expect(visCheck.rows[0].gender).toBe('Male');

    const profCheck = await db.query<{ gender: string }>(`
      select gender from public.returning_visitor_profiles
      where contact_number_e164 = '+639171234567';
    `);
    expect(profCheck.rows[0].gender).toBe('Male');

    // 3. Idempotent call with matching gender succeeds and returns identical pass_id
    const repeatRes = await db.query<{ pass_id: string }>(`
      select * from api.issue_online_pass_v6(
        '${testActorId}'::uuid, 'new', '${reqId}'::uuid,
        'Juan', null, 'Dela Cruz', '+639171234567', 'Campus Visit', (current_date + interval '1 day')::date,
        '${photoIntentId}'::uuid, 1024, repeat('a', 64),
        '${idIntentId}'::uuid, 2048, repeat('b', 64),
        repeat('c', 64), 'no_vehicle',
        '2026-q3', '1300000000', null, '1380600000', '1380600408',
        'Unit 1', 'Main St', '1008', 'PHLPost',
        null, null, null, null, null, null, null, 'catalog',
        null, null, null, null, null, null, false, false,
        null, null, 'Male'
      );
    `);
    expect(repeatRes.rows[0].pass_id).toBe(issueRes.rows[0].pass_id);

    // 4. Idempotency parameter mismatch: Different gender on same request_id throws 22023
    await expect(
      db.query(`
        select * from api.issue_online_pass_v6(
          '${testActorId}'::uuid, 'new', '${reqId}'::uuid,
          'Juan', null, 'Dela Cruz', '+639171234567', 'Campus Visit', (current_date + interval '1 day')::date,
          '${photoIntentId}'::uuid, 1024, repeat('a', 64),
          '${idIntentId}'::uuid, 2048, repeat('b', 64),
          repeat('c', 64), 'no_vehicle',
          '2026-q3', '1300000000', null, '1380600000', '1380600408',
          'Unit 1', 'Main St', '1008', 'PHLPost',
          null, null, null, null, null, null, null, 'catalog',
          null, null, null, null, null, null, false, false,
          null, null, 'Female'
        );
      `)
    ).rejects.toThrow(/idempotency parameter mismatch/);
  }, 120_000);

  it('verifies api.return_to_zero_reset wipes operational tables while preserving active superadmin and configuration', async () => {
    const db = new PGlite();
    await applyAllMigrations(db);

    const superadmin1Id = '00000000-0000-0000-0000-000000000001';
    const superadmin2Id = '00000000-0000-0000-0000-000000000009';
    const guardId = '00000000-0000-0000-0000-000000000002';
    const visitorId = '00000000-0000-0000-0000-000000000003';
    const deviceId = '00000000-0000-0000-0000-000000000004';
    const passId = '00000000-0000-0000-0000-000000000005';
    const photoIntentId = '00000000-0000-0000-0000-000000000006';
    const internalVisitorId = '00000000-0000-0000-0000-000000000007';

    // Seed test users & staff (including 2 active superadmins to verify preservation of all active superadmins)
    await db.exec(`
      insert into auth.users (id, email) values
        ('${superadmin1Id}'::uuid, 'superadmin1@institution.edu'),
        ('${superadmin2Id}'::uuid, 'superadmin2@institution.edu'),
        ('${guardId}'::uuid, 'guard@institution.edu'),
        ('${visitorId}'::uuid, 'visitor@example.com'),
        ('${deviceId}'::uuid, 'device@station.local')
      on conflict (id) do nothing;

      insert into public.staff_profiles (user_id, display_name, role, active) values
        ('${superadmin1Id}'::uuid, 'Super Admin One', 'superadmin', true),
        ('${superadmin2Id}'::uuid, 'Super Admin Two', 'superadmin', true),
        ('${guardId}'::uuid, 'Main Guard', 'guard', true)
      on conflict (user_id) do nothing;

      insert into public.devices (user_id, alias, name, type, gate, status) values
        ('${deviceId}'::uuid, 'kiosk-gate-1', 'Gate 1 Scanner', 'kiosk', 'Gate 1', 'active')
      on conflict (user_id) do nothing;

      insert into public.upload_intents (
        id, owner_id, bucket_id, object_path, kind, status, max_bytes, expires_at, source, content_type
      ) values (
        '${photoIntentId}'::uuid, '${visitorId}'::uuid, 'visitor-photos', 'photo.jpg', 'photo', 'pending', 5242880, now() + interval '1 hour', 'portal', 'image/jpeg'
      );

      insert into public.visitors (
        id, owner_id, source, full_name, contact_number, purpose, visit_date, consent_accepted_at, gender
      ) values (
        '${internalVisitorId}'::uuid, '${visitorId}'::uuid, 'portal', 'Sample Visitor', '+639170000000', 'Meeting', current_date, now(), 'Female'
      );

      insert into public.passes (
        id, visitor_id, token_digest, source, status, valid_from, valid_until
      ) values (
        '${passId}'::uuid, '${internalVisitorId}'::uuid, decode(repeat('a', 64), 'hex'), 'portal', 'issued', now(), now() + interval '8 hours'
      );

      insert into public.visit_events (
        pass_id, visitor_id, device_id, guard_id, event, request_id
      ) values (
        '${passId}'::uuid, '${internalVisitorId}'::uuid, '${deviceId}'::uuid, '${guardId}'::uuid, 'approved', gen_random_uuid()
      );

      insert into public.incident_holds (
        visitor_id, pass_id, reason, created_by
      ) values (
        '${internalVisitorId}'::uuid, '${passId}'::uuid, 'Security inspection hold', '${guardId}'::uuid
      );
    `);

    // 1. Negative test: Non-superadmin cannot execute reset
    await expect(
      db.query(`select api.return_to_zero_reset('${guardId}'::uuid);`)
    ).rejects.toThrow(/superadmin_required/);

    // 1b. Direct reset invocation without an active operation ID / idle system is rejected
    await expect(
      db.query(`select api.return_to_zero_reset('${superadmin1Id}'::uuid);`)
    ).rejects.toThrow(/fencing_token_revoked: operation ID required/);

    // 2. Positive test: Active superadmin acquires reset lock and executes return to zero reset with valid fencing tokens
    const lockRes = await db.query<{ acquire_system_reset_lock: any }>(`
      select api.acquire_system_reset_lock('${superadmin1Id}'::uuid);
    `);
    const { operation_id: opId, worker_generation: workerGen, worker_id: workerId } = lockRes.rows[0].acquire_system_reset_lock;

    const resetRes = await db.query<{ return_to_zero_reset: { success: boolean; actor_id: string; preserved_superadmins: string[] } }>(`
      select api.return_to_zero_reset('${superadmin1Id}'::uuid, '${opId}'::uuid, ${workerGen}, '${workerId}'::uuid);
    `);
    expect(resetRes.rows.length).toBe(1);
    expect(resetRes.rows[0].return_to_zero_reset.success).toBe(true);
    expect(resetRes.rows[0].return_to_zero_reset.actor_id).toBe(superadmin1Id);
    expect(resetRes.rows[0].return_to_zero_reset.preserved_superadmins).toContain(superadmin1Id);
    expect(resetRes.rows[0].return_to_zero_reset.preserved_superadmins).toContain(superadmin2Id);

    // 3. Invariant assertions: Operational tables wiped completely
    const visitorsCount = await db.query(`select count(*) as count from public.visitors;`);
    expect(Number(visitorsCount.rows[0].count)).toBe(0);

    const passesCount = await db.query(`select count(*) as count from public.passes;`);
    expect(Number(passesCount.rows[0].count)).toBe(0);

    const eventsCount = await db.query(`select count(*) as count from public.visit_events;`);
    expect(Number(eventsCount.rows[0].count)).toBe(0);

    const holdsCount = await db.query(`select count(*) as count from public.incident_holds;`);
    expect(Number(holdsCount.rows[0].count)).toBe(0);

    const devicesCount = await db.query(`select count(*) as count from public.devices;`);
    expect(Number(devicesCount.rows[0].count)).toBe(0);

    // 4. Invariant assertions: Active superadmins preserved, non-superadmin staff removed
    const staffCheck = await db.query<{ user_id: string; role: string }>(`
      select user_id, role from public.staff_profiles order by user_id;
    `);
    expect(staffCheck.rows.length).toBe(2);
    expect(staffCheck.rows.map(r => r.user_id)).toEqual([superadmin1Id, superadmin2Id].sort());

    const usersCheck = await db.query<{ id: string }>(`
      select id from auth.users order by id;
    `);
    expect(usersCheck.rows.length).toBe(2);
    expect(usersCheck.rows.map(r => r.id)).toEqual([superadmin1Id, superadmin2Id].sort());

    // 5. Invariant assertions: Institutional configuration tables preserved intact
    const settingsCheck = await db.query(`select count(*) as count from public.app_settings;`);
    expect(Number(settingsCheck.rows[0].count)).toBe(1);

    const officesCheck = await db.query(`select count(*) as count from public.offices;`);
    expect(Number(officesCheck.rows[0].count)).toBeGreaterThanOrEqual(1);

    const psgcCheck = await db.query(`select count(*) as count from public.psgc_locations;`);
    expect(Number(psgcCheck.rows[0].count)).toBeGreaterThanOrEqual(1);

    // 6. Invariant assertions: Exactly 1 authoritative audit event logged
    const auditRes = await db.query<{ action: string; outcome: string; actor_id: string; after_state: unknown }>(`
      select action, outcome, actor_id, after_state from public.audit_events;
    `);
    expect(auditRes.rows.length).toBe(1);
    expect(auditRes.rows[0].action).toBe('superadmin.return_to_zero');
    expect(auditRes.rows[0].outcome).toBe('success');
    expect(auditRes.rows[0].actor_id).toBe(superadmin1Id);
    expect(auditRes.rows[0].after_state).toBeDefined();

    // 7. Invariant assertions: Lock release and idempotent re-run on empty database succeeds
    await db.query(`
      select api.release_system_reset_lock('${superadmin1Id}'::uuid, '${opId}'::uuid, ${workerGen}, '${workerId}'::uuid);
    `);
    const rerunLock = await db.query<{ acquire_system_reset_lock: any }>(`
      select api.acquire_system_reset_lock('${superadmin1Id}'::uuid);
    `);
    const { operation_id: rerunOpId, worker_generation: rerunGen, worker_id: rerunWorkerId } = rerunLock.rows[0].acquire_system_reset_lock;
    const rerunRes = await db.query<{ return_to_zero_reset: { success: boolean } }>(`
      select api.return_to_zero_reset('${superadmin1Id}'::uuid, '${rerunOpId}'::uuid, ${rerunGen}, '${rerunWorkerId}'::uuid);
    `);
    expect(rerunRes.rows[0].return_to_zero_reset.success).toBe(true);
    await db.query(`
      select api.release_system_reset_lock('${superadmin1Id}'::uuid, '${rerunOpId}'::uuid, ${rerunGen}, '${rerunWorkerId}'::uuid);
    `);
  }, 120_000);
});
