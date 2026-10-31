import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

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

describe('Guided Arrival Setup, Address Provenance & Vehicle Gate Enforcement', () => {
  it('1. Rejects scan entry when vehicle is already active inside campus (vehicle_already_inside)', async () => {
    const db = new PGlite();
    await applyAllMigrations(db);

    const scannerId = '11111111-1111-1111-1111-111111111111';
    const visitor1Id = '22222222-2222-2222-2222-222222222222';
    const pass1Id = '33333333-3333-3333-3333-333333333333';
    const tokenDigest1 = '1111111111111111111111111111111111111111111111111111111111111111';

    const visitor2Id = '44444444-4444-4444-4444-444444444444';
    const pass2Id = '55555555-5555-5555-5555-555555555555';
    const tokenDigest2 = '2222222222222222222222222222222222222222222222222222222222222222';

    await db.exec(`
      insert into auth.users (id, email) values ('00000000-0000-0000-0000-000000000001', 'anon@example.com'), ('${scannerId}', 'scanner@example.com') on conflict do nothing;
      insert into public.devices (user_id, name, alias, type, gate, status)
      values ('${scannerId}', 'Main Gate Entry Scanner', 'scanner-entry-1', 'entry', 'Gate 1', 'active');

      -- Visitor 1 with plate ABC 1234
      insert into public.visitors (id, owner_id, source, full_name, contact_number, purpose, visit_date, arrival_mode, home_address, consent_accepted_at)
      values ('${visitor1Id}', '00000000-0000-0000-0000-000000000001', 'portal', 'First Driver', '+639171111111', 'Delivery', '2026-10-31', 'vehicle', '123 Manila St', now());

      insert into public.passes (id, visitor_id, source, public_reference, token_digest, status, valid_from, valid_until)
      values ('${pass1Id}', '${visitor1Id}', 'portal', gen_random_uuid(), decode('${tokenDigest1}', 'hex'), 'issued', now() - interval '1 hour', now() + interval '8 hours');

      insert into public.visit_vehicle_declarations (pass_id, visitor_id, vehicle_type, plate_number, plate_key, color, make_model)
      values ('${pass1Id}', '${visitor1Id}', 'car', 'ABC 1234', 'ABC1234', 'White', 'Toyota Vios');

      -- Visitor 2 with the SAME plate ABC 1234
      insert into public.visitors (id, owner_id, source, full_name, contact_number, purpose, visit_date, arrival_mode, home_address, consent_accepted_at)
      values ('${visitor2Id}', '00000000-0000-0000-0000-000000000001', 'portal', 'Second Driver', '+639172222222', 'Meeting', '2026-10-31', 'vehicle', '456 Sampaloc St', now());

      insert into public.passes (id, visitor_id, source, public_reference, token_digest, status, valid_from, valid_until)
      values ('${pass2Id}', '${visitor2Id}', 'portal', gen_random_uuid(), decode('${tokenDigest2}', 'hex'), 'issued', now() - interval '1 hour', now() + interval '8 hours');

      insert into public.visit_vehicle_declarations (pass_id, visitor_id, vehicle_type, plate_number, plate_key, color, make_model)
      values ('${pass2Id}', '${visitor2Id}', 'car', 'ABC 1234', 'ABC1234', 'White', 'Toyota Vios');
    `);

    // First scan: Visitor 1 enters successfully
    const scan1 = await db.query<{ ok: boolean; result_status: string }>(`
      select * from api.scan_pass(
        '${scannerId}'::uuid,
        '${tokenDigest1}',
        'entry',
        gen_random_uuid()
      );
    `);
    expect(scan1.rows[0].ok).toBe(true);
    expect(scan1.rows[0].result_status).toBe('inside');

    // Second scan: Visitor 2 with the same plate attempts entry while visitor 1 is inside
    const scan2 = await db.query<{ ok: boolean; result_status: string; code: string; message: string }>(`
      select * from api.scan_pass(
        '${scannerId}'::uuid,
        '${tokenDigest2}',
        'entry',
        gen_random_uuid()
      );
    `);
    expect(scan2.rows[0].ok).toBe(false);
    expect(scan2.rows[0].code).toBe('vehicle_already_inside');
  }, 60000);

  it('2. Allows entry of second vehicle once the first vehicle exits', async () => {
    const db = new PGlite();
    await applyAllMigrations(db);

    const entryScannerId = '11111111-1111-1111-1111-111111111111';
    const exitScannerId = '22222222-2222-2222-2222-222222222222';
    const visitor1Id = '33333333-3333-3333-3333-333333333333';
    const pass1Id = '44444444-4444-4444-4444-444444444444';
    const tokenDigest1 = '1111111111111111111111111111111111111111111111111111111111111111';

    const visitor2Id = '55555555-5555-5555-5555-555555555555';
    const pass2Id = '66666666-6666-6666-6666-666666666666';
    const tokenDigest2 = '2222222222222222222222222222222222222222222222222222222222222222';

    await db.exec(`
      insert into auth.users (id, email) values ('00000000-0000-0000-0000-000000000001', 'anon@example.com'), ('${entryScannerId}', 'entry@example.com'), ('${exitScannerId}', 'exit@example.com') on conflict do nothing;
      insert into public.devices (user_id, name, alias, type, gate, status)
      values
        ('${entryScannerId}', 'Main Gate Entry Scanner', 'scanner-entry-1', 'entry', 'Gate 1', 'active'),
        ('${exitScannerId}', 'Main Gate Exit Scanner', 'scanner-exit-1', 'exit', 'Gate 1', 'active');

      insert into public.visitors (id, owner_id, source, full_name, contact_number, purpose, visit_date, arrival_mode, home_address, consent_accepted_at)
      values
        ('${visitor1Id}', '00000000-0000-0000-0000-000000000001', 'portal', 'First Driver', '+639171111111', 'Delivery', '2026-10-31', 'vehicle', '123 Manila St', now()),
        ('${visitor2Id}', '00000000-0000-0000-0000-000000000001', 'portal', 'Second Driver', '+639172222222', 'Meeting', '2026-10-31', 'vehicle', '456 Sampaloc St', now());

      insert into public.passes (id, visitor_id, source, public_reference, token_digest, status, valid_from, valid_until)
      values
        ('${pass1Id}', '${visitor1Id}', 'portal', gen_random_uuid(), decode('${tokenDigest1}', 'hex'), 'issued', now() - interval '1 hour', now() + interval '8 hours'),
        ('${pass2Id}', '${visitor2Id}', 'portal', gen_random_uuid(), decode('${tokenDigest2}', 'hex'), 'issued', now() - interval '1 hour', now() + interval '8 hours');

      insert into public.visit_vehicle_declarations (pass_id, visitor_id, vehicle_type, plate_number, plate_key, color, make_model)
      values
        ('${pass1Id}', '${visitor1Id}', 'car', 'XYZ 9999', 'XYZ9999', 'Black', 'Toyota Fortuner'),
        ('${pass2Id}', '${visitor2Id}', 'car', 'XYZ 9999', 'XYZ9999', 'Black', 'Toyota Fortuner');
    `);

    // 1. First vehicle enters
    const enter1 = await db.query<{ ok: boolean }>(`
      select * from api.scan_pass('${entryScannerId}'::uuid, '${tokenDigest1}', 'entry', gen_random_uuid());
    `);
    expect(enter1.rows[0].ok).toBe(true);

    // 2. First vehicle exits
    const exit1 = await db.query<{ ok: boolean }>(`
      select * from api.scan_pass('${exitScannerId}'::uuid, '${tokenDigest1}', 'exit', gen_random_uuid());
    `);
    expect(exit1.rows[0].ok).toBe(true);

    // 3. Second vehicle enters now that first vehicle has exited
    const enter2 = await db.query<{ ok: boolean; result_status: string }>(`
      select * from api.scan_pass('${entryScannerId}'::uuid, '${tokenDigest2}', 'entry', gen_random_uuid());
    `);
    expect(enter2.rows[0].ok).toBe(true);
    expect(enter2.rows[0].result_status).toBe('inside');
  }, 60000);

  it('3. Rejects api.issue_online_pass_v3 when arrival mode is invalid or omitted', async () => {
    const db = new PGlite();
    await applyAllMigrations(db);

    const actorId = '00000000-0000-0000-0000-000000000001';
    await db.exec(`
      insert into auth.users (id, email, is_anonymous)
      values ('${actorId}', 'anon@example.com', true)
      on conflict (id) do nothing;
    `);

    // Attempt to call issue_online_pass_v3 with invalid arrival mode
    await expect(
      db.query(`
        select * from api.issue_online_pass_v3(
          '${actorId}'::uuid,
          'new',
          gen_random_uuid(),
          'Juan', null, 'Dela Cruz',
          '+639171234567',
          '123 Manila St',
          'Official Business',
          current_date,
          gen_random_uuid(), 1000, '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
          gen_random_uuid(), 1000, '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
          '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
          'invalid_mode', -- invalid arrival mode!
          'geoapify', 'place-123', 'street', 0.95, 14.5995, 120.9842, 'Manila', 'Metro Manila', '1008', 'PH'
        );
      `)
    ).rejects.toThrow('invalid arrival mode: explicit selection required');
  }, 60000);

  it('4. Rejects api.issue_online_pass_v3 when vehicle arrival is chosen without vehicle photo', async () => {
    const db = new PGlite();
    await applyAllMigrations(db);

    const actorId = '00000000-0000-0000-0000-000000000001';
    await db.exec(`
      insert into auth.users (id, email, is_anonymous)
      values ('${actorId}', 'anon@example.com', true)
      on conflict (id) do nothing;
    `);

    await expect(
      db.query(`
        select * from api.issue_online_pass_v3(
          '${actorId}'::uuid,
          'new',
          gen_random_uuid(),
          'Juan', null, 'Dela Cruz',
          '+639171234567',
          '123 Manila St',
          'Official Business',
          current_date,
          gen_random_uuid(), 1000, '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
          gen_random_uuid(), 1000, '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
          '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
          'vehicle',
          'geoapify', 'place-123', 'street', 0.95, 14.5995, 120.9842, 'Manila', 'Metro Manila', '1008', 'PH',
          null, -- address_detail
          'car', 'ABC 1234', 'ABC1234', 'White', 'Toyota Vios', 'catalog',
          null -- missing vehicle photo intent!
        );
      `)
    ).rejects.toThrow('vehicle photo required for vehicle arrival');
  }, 60000);

  it('5. Rejects api.issue_online_pass_v3 when vehicle make/model is missing or shorter than 2 chars', async () => {
    const db = new PGlite();
    await applyAllMigrations(db);

    const actorId = '00000000-0000-0000-0000-000000000001';
    await db.exec(`
      insert into auth.users (id, email, is_anonymous)
      values ('${actorId}', 'anon@example.com', true)
      on conflict (id) do nothing;
    `);

    // Too short make/model: "X" (1 char)
    await expect(
      db.query(`
        select * from api.issue_online_pass_v3(
          '${actorId}'::uuid,
          'new',
          gen_random_uuid(),
          'Juan', null, 'Dela Cruz',
          '+639171234567',
          '123 Manila St',
          'Official Business',
          current_date,
          gen_random_uuid(), 1000, '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
          gen_random_uuid(), 1000, '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
          '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
          'vehicle',
          'geoapify', 'place-123', 'street', 0.95, 14.5995, 120.9842, 'Manila', 'Metro Manila', '1008', 'PH',
          null,
          'car', 'ABC 1234', 'ABC1234', 'White', 'X', 'manual',
          gen_random_uuid()
        );
      `)
    ).rejects.toThrow('invalid vehicle declaration details');
  }, 60000);

  it('6. Concurrently scanning entry for two passes with identical plate traps unique_violation cleanly', async () => {
    const db = new PGlite();
    await applyAllMigrations(db);

    const scannerId = '11111111-1111-1111-1111-111111111111';
    const visitor1Id = '22222222-2222-2222-2222-222222222222';
    const pass1Id = '33333333-3333-3333-3333-333333333333';
    const tokenDigest1 = '1111111111111111111111111111111111111111111111111111111111111111';

    const visitor2Id = '44444444-4444-4444-4444-444444444444';
    const pass2Id = '55555555-5555-5555-5555-555555555555';
    const tokenDigest2 = '2222222222222222222222222222222222222222222222222222222222222222';

    await db.exec(`
      insert into auth.users (id, email) values ('00000000-0000-0000-0000-000000000001', 'anon@example.com'), ('${scannerId}', 'scanner@example.com') on conflict do nothing;
      insert into public.devices (user_id, name, alias, type, gate, status)
      values ('${scannerId}', 'Main Gate Entry Scanner', 'scanner-entry-1', 'entry', 'Gate 1', 'active');

      insert into public.visitors (id, owner_id, source, full_name, contact_number, purpose, visit_date, arrival_mode, home_address, consent_accepted_at)
      values
        ('${visitor1Id}', '00000000-0000-0000-0000-000000000001', 'portal', 'Driver A', '+639171111111', 'Delivery', '2026-10-31', 'vehicle', '123 Manila St', now()),
        ('${visitor2Id}', '00000000-0000-0000-0000-000000000001', 'portal', 'Driver B', '+639172222222', 'Meeting', '2026-10-31', 'vehicle', '456 Sampaloc St', now());

      insert into public.passes (id, visitor_id, source, public_reference, token_digest, status, valid_from, valid_until)
      values
        ('${pass1Id}', '${visitor1Id}', 'portal', gen_random_uuid(), decode('${tokenDigest1}', 'hex'), 'issued', now() - interval '1 hour', now() + interval '8 hours'),
        ('${pass2Id}', '${visitor2Id}', 'portal', gen_random_uuid(), decode('${tokenDigest2}', 'hex'), 'issued', now() - interval '1 hour', now() + interval '8 hours');

      insert into public.visit_vehicle_declarations (pass_id, visitor_id, vehicle_type, plate_number, plate_key, color, make_model)
      values
        ('${pass1Id}', '${visitor1Id}', 'car', 'DEF 5678', 'DEF5678', 'Silver', 'Honda Civic'),
        ('${pass2Id}', '${visitor2Id}', 'car', 'DEF 5678', 'DEF5678', 'Silver', 'Honda Civic');
    `);

    // Execute scans concurrently
    const [scanResult1, scanResult2] = await Promise.all([
      db.query<{ ok: boolean; result_status?: string; code?: string }>(`
        select * from api.scan_pass('${scannerId}'::uuid, '${tokenDigest1}', 'entry', gen_random_uuid());
      `),
      db.query<{ ok: boolean; result_status?: string; code?: string }>(`
        select * from api.scan_pass('${scannerId}'::uuid, '${tokenDigest2}', 'entry', gen_random_uuid());
      `),
    ]);

    const results = [scanResult1.rows[0], scanResult2.rows[0]];
    const successes = results.filter((r) => r.ok && r.result_status === 'inside');
    const failures = results.filter((r) => !r.ok && r.code === 'vehicle_already_inside');

    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);
  }, 60000);
});
