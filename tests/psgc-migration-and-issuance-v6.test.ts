import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
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

async function applyAllMigrations(db: PGlite): Promise<string[]> {
  await setupSupabaseEmulation(db);
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    let sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    sql = sql.replace(/create extension if not exists pgcrypto[^;]*;/gi, '-- pgcrypto no-op');
    await db.exec(sql);
  }
  return files;
}

describe('Migration 50: PSGC Reference System and api.issue_online_pass_v6', () => {
  it('A. Clean sequential migration and reference dataset counts', async () => {
    const db = new PGlite();
    const files = await applyAllMigrations(db);
    expect(files).toContain('20261103000100_psgc_reference_and_issuance_v6.sql');

    // 1. Check version table
    const verRes = await db.query<{ id: string; is_active: boolean }>(
      `select id, is_active from public.psgc_reference_versions where is_active = true;`
    );
    expect(verRes.rows.length).toBe(1);
    expect(verRes.rows[0].id).toBe('2026-q3');

    // 2. Check region count
    const regRes = await db.query<{ count: string }>(
      `select count(*) as count from public.psgc_locations where level = 'region';`
    );
    expect(Number(regRes.rows[0].count)).toBe(18);

    // 3. Check province count
    const provRes = await db.query<{ count: string }>(
      `select count(*) as count from public.psgc_locations where level = 'province';`
    );
    expect(Number(provRes.rows[0].count)).toBe(82);

    // 4. Check NCR has no provinces
    const ncrProvRes = await db.query<{ count: string }>(
      `select count(*) as count from public.psgc_locations where parent_psgc_code = '1300000000' and level = 'province';`
    );
    expect(Number(ncrProvRes.rows[0].count)).toBe(0);

    // 5. Check City of Manila is under NCR
    const manilaRes = await db.query<{ psgc_code: string; parent_psgc_code: string; name: string }>(
      `select psgc_code, parent_psgc_code, name from public.psgc_locations where psgc_code = '1380600000';`
    );
    expect(manilaRes.rows.length).toBe(1);
    expect(manilaRes.rows[0].parent_psgc_code).toBe('1300000000');
    expect(manilaRes.rows[0].name).toBe('City of Manila');

    // 6. Check Barangay 408 (Sampaloc / EARIST) is under City of Manila
    const bgy408Res = await db.query<{ psgc_code: string; parent_psgc_code: string; name: string }>(
      `select psgc_code, parent_psgc_code, name from public.psgc_locations where psgc_code = '1380600408';`
    );
    expect(bgy408Res.rows.length).toBe(1);
    expect(bgy408Res.rows[0].parent_psgc_code).toBe('1380600000');
    expect(bgy408Res.rows[0].name).toContain('EARIST');

    // 7. Check postal code mappings
    const postalRes = await db.query<{ count: string }>(
      `select count(*) as count from public.postal_code_reference;`
    );
    expect(Number(postalRes.rows[0].count)).toBeGreaterThanOrEqual(100);

    // 8. Check exact barangay postal mapping for EARIST (1008)
    const earistZip = await db.query<{ postal_code: string; mapping_type: string }>(
      `select postal_code, mapping_type from public.postal_code_reference where barangay_psgc_code = '1380600408';`
    );
    expect(earistZip.rows.length).toBe(1);
    expect(earistZip.rows[0].postal_code).toBe('1008');
    expect(earistZip.rows[0].mapping_type).toBe('exact_barangay');
  }, 60000);

  it('B. api.issue_online_pass_v6: server-side PSGC hierarchy validation and pass issuance', async () => {
    const db = new PGlite();
    await applyAllMigrations(db);

    const testUserId = '11111111-1111-1111-1111-111111111111';
    await db.exec(`insert into auth.users (id, is_anonymous) values ('${testUserId}', true);`);

    const photoIntentId = '22222222-2222-2222-2222-222222222222';
    const idIntentId = '33333333-3333-3333-3333-333333333333';
    const reqId = '44444444-4444-4444-4444-444444444444';

    await db.exec(`
      insert into public.upload_intents (id, owner_id, source, kind, bucket_id, object_path, content_type, max_bytes, status, expires_at)
      values
        ('${photoIntentId}', '${testUserId}', 'portal', 'photo', 'visitor-photos', 'portal/${testUserId}/photo.jpg', 'image/jpeg', 5242880, 'pending', now() + interval '10 minutes'),
        ('${idIntentId}', '${testUserId}', 'portal', 'id', 'visitor-ids', 'portal/${testUserId}/id.jpg', 'image/jpeg', 5242880, 'pending', now() + interval '10 minutes');

      insert into public.portal_identity_verification_attempts (
        id, owner_id, request_id, photo_intent_id, id_intent_id, outcome, model_name, model_version, verified_at, expires_at
      ) values (
        gen_random_uuid(), '${testUserId}', '${reqId}', '${photoIntentId}', '${idIntentId}', 'matched', 'opencv_zoo_yunet_sface', 'yunet_2023mar_sface_2021dec', now(), now() + interval '15 minutes'
      );
    `);

    // 1. Negative test: Invalid region
    await expect(
      db.query(`
        select * from api.issue_online_pass_v6(
          '${testUserId}'::uuid, 'new', '${reqId}'::uuid,
          'Juan', null, 'Dela Cruz', '+639171234567', 'Official Visit', (current_date + interval '1 day')::date,
          '${photoIntentId}'::uuid, 1024, repeat('a', 64),
          '${idIntentId}'::uuid, 2048, repeat('b', 64),
          repeat('c', 64), 'no_vehicle',
          '2026-q3', '9900000000', null, '1380600000', '1380600408'
        );
      `)
    ).rejects.toThrow(/invalid psgc region/);

    // 2. Negative test: Fabricated province for NCR (NCR has no provinces!)
    await expect(
      db.query(`
        select * from api.issue_online_pass_v6(
          '${testUserId}'::uuid, 'new', '${reqId}'::uuid,
          'Juan', null, 'Dela Cruz', '+639171234567', 'Official Visit', (current_date + interval '1 day')::date,
          '${photoIntentId}'::uuid, 1024, repeat('a', 64),
          '${idIntentId}'::uuid, 2048, repeat('b', 64),
          repeat('c', 64), 'no_vehicle',
          '2026-q3', '1300000000', '0314000000', '1380600000', '1380600408'
        );
      `)
    ).rejects.toThrow(/psgc province not permitted for region with no provinces/);

    // 3. Negative test: Mismatched barangay
    await expect(
      db.query(`
        select * from api.issue_online_pass_v6(
          '${testUserId}'::uuid, 'new', '${reqId}'::uuid,
          'Juan', null, 'Dela Cruz', '+639171234567', 'Official Visit', (current_date + interval '1 day')::date,
          '${photoIntentId}'::uuid, 1024, repeat('a', 64),
          '${idIntentId}'::uuid, 2048, repeat('b', 64),
          repeat('c', 64), 'no_vehicle',
          '2026-q3', '1300000000', null, '1380600000', '1381200001'
        );
      `)
    ).rejects.toThrow(/psgc barangay does not belong to selected city/);

    // 4. Positive test: Valid NCR hierarchy (Region 13 -> Manila -> Bgy 408)
    const passRes = await db.query<{ pass_id: string; public_reference: string }>(`
      select * from api.issue_online_pass_v6(
        '${testUserId}'::uuid, 'new', '${reqId}'::uuid,
        'Juan', 'Santos', 'Dela Cruz', '+639171234567', 'Campus Inquiry', (current_date + interval '1 day')::date,
        '${photoIntentId}'::uuid, 1024, repeat('a', 64),
        '${idIntentId}'::uuid, 2048, repeat('b', 64),
        repeat('c', 64), 'no_vehicle',
        '2026-q3', '1300000000', null, '1380600000', '1380600408',
        'Unit 401', 'Nagtahan St.', '1008', 'PHLPost'
      );
    `);

    expect(passRes.rows.length).toBe(1);
    expect(passRes.rows[0].pass_id).toBeDefined();

    // 5. Verify snapshot on visitors table
    const visCheck = await db.query<{
      psgc_region_name: string;
      psgc_province_name: string | null;
      psgc_city_municipality_name: string;
      psgc_barangay_name: string;
      home_building: string;
      home_street: string;
      postal_code: string;
      home_address: string;
    }>(`
      select
        psgc_region_name, psgc_province_name, psgc_city_municipality_name, psgc_barangay_name,
        home_building, home_street, postal_code, home_address
      from public.visitors
      where owner_id = '${testUserId}';
    `);

    expect(visCheck.rows.length).toBe(1);
    expect(visCheck.rows[0].psgc_region_name).toBe('National Capital Region (NCR)');
    expect(visCheck.rows[0].psgc_province_name).toBeNull();
    expect(visCheck.rows[0].psgc_city_municipality_name).toBe('City of Manila');
    expect(visCheck.rows[0].psgc_barangay_name).toMatch(/Barangay 408/);
    expect(visCheck.rows[0].home_building).toBe('Unit 401');
    expect(visCheck.rows[0].home_street).toBe('Nagtahan St.');
    expect(visCheck.rows[0].postal_code).toBe('1008');
    expect(visCheck.rows[0].home_address).toContain('Unit 401, Nagtahan St.');
    expect(visCheck.rows[0].home_address).toContain('City of Manila');

    // 6. Idempotency test: calling again with same request_id returns existing pass
    const idemRes = await db.query<{ pass_id: string }>(`
      select * from api.issue_online_pass_v6(
        '${testUserId}'::uuid, 'new', '${reqId}'::uuid,
        'Juan', 'Santos', 'Dela Cruz', '+639171234567', 'Campus Inquiry', (current_date + interval '1 day')::date,
        '${photoIntentId}'::uuid, 1024, repeat('a', 64),
        '${idIntentId}'::uuid, 2048, repeat('b', 64),
        repeat('c', 64), 'no_vehicle',
        '2026-q3', '1300000000', null, '1380600000', '1380600408',
        'Unit 401', 'Nagtahan St.', '1008', 'PHLPost'
      );
    `);
    expect(idemRes.rows[0].pass_id).toBe(passRes.rows[0].pass_id);
  }, 60000);
});
