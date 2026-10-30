import { describe, it, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { normalizePlateNumber } from '../src/lib/vehiclePlate.js';
import { createPassPresentation } from '../src/lib/passPresentation.js';
import { generateCanonicalDigitalPassSvg } from '../src/lib/digitalPassArtifact.js';

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

describe('Vehicle Declaration & Gate Lifecycle Behavioral Contract', () => {
  it('1. Plate Number Normalization & Validation', () => {
    // Standard PH formats
    const standard = normalizePlateNumber('abc-1234');
    expect(standard.valid).toBe(true);
    expect(standard.displayPlate).toBe('ABC 1234');
    expect(standard.plateKey).toBe('ABC1234');

    const motorcycle = normalizePlateNumber('123-abc');
    expect(motorcycle.valid).toBe(true);
    expect(motorcycle.displayPlate).toBe('123 ABC');
    expect(motorcycle.plateKey).toBe('123ABC');

    // Rejects invalid formats
    expect(normalizePlateNumber('').valid).toBe(false);
    expect(normalizePlateNumber('AB').valid).toBe(false);
    expect(normalizePlateNumber('TOOLONGPLATE123').valid).toBe(false);
    expect(normalizePlateNumber('!@#$%').valid).toBe(false);
  });

  it('2. Pass Presentation & Artifact: displays vehicle plate and preserves privacy boundaries', () => {
    const presentationWithVehicle = createPassPresentation({
      visitorName: 'JUAN DELA CRUZ',
      visitDate: '2026-10-31',
      passReference: 'EG-12345678',
      qrToken: 'test-qr-token',
      plateNumber: 'ABC 1234',
      purpose: 'Official Campus Business',
    });

    expect(presentationWithVehicle.plateNumber).toBe('ABC 1234');

    const svg = generateCanonicalDigitalPassSvg(presentationWithVehicle, 'data:image/png;base64,fake');
    // Vehicle plate must be visible on the canonical digital pass
    expect(svg).toContain('Vehicle: ABC 1234');
    expect(svg).toContain('data-testid="canonical-pass-vehicle-plate"');

    // Privacy invariant: Digital pass must NEVER render visitor home address or phone number
    expect(svg).not.toContain('123 Private Street');
    expect(svg).not.toContain('09171234567');
    expect(svg).not.toContain('+639171234567');
  });

  it('3. Pass Presentation without vehicle omits vehicle element cleanly', () => {
    const presentationNoVehicle = createPassPresentation({
      visitorName: 'MARIA SANTOS',
      visitDate: '2026-10-31',
      passReference: 'EG-87654321',
      qrToken: 'test-qr-token-2',
      plateNumber: null,
      purpose: 'Meeting',
    });

    expect(presentationNoVehicle.plateNumber).toBeNull();

    const svg = generateCanonicalDigitalPassSvg(presentationNoVehicle, 'data:image/png;base64,fake');
    expect(svg).not.toContain('data-testid="canonical-pass-vehicle-plate"');
    expect(svg).not.toContain('Vehicle:');
  });

  it('4. Migration 43 Database Schema: Atomic Scan Updates vehicle entry and exit timestamps', async () => {
    const db = new PGlite();
    await applyAllMigrations(db);

    // Insert mock visitor and pass with vehicle declaration
    const visitorId = '44444444-4444-4444-4444-444444444444';
    const passId = '55555555-5555-5555-5555-555555555555';
    const tokenDigest = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    const entryScannerId = '66666666-6666-6666-6666-666666666666';
    const exitScannerId = '77777777-7777-7777-7777-777777777777';

    await db.exec(`
      insert into auth.users (id, email, is_anonymous)
      values
        ('00000000-0000-0000-0000-000000000001', 'anon@example.com', true),
        ('${entryScannerId}', 'scanner1@example.com', false),
        ('${exitScannerId}', 'scanner2@example.com', false)
      on conflict (id) do nothing;

      insert into public.devices (user_id, name, alias, type, gate, status)
      values
        ('${entryScannerId}', 'Main Gate Entry Scanner', 'scanner-entry-1', 'entry', 'Gate 1', 'active'),
        ('${exitScannerId}', 'Main Gate Exit Scanner', 'scanner-exit-1', 'exit', 'Gate 1', 'active');

      insert into public.visitors (id, owner_id, source, full_name, contact_number, purpose, visit_date, arrival_mode, home_address, consent_accepted_at)
      values ('${visitorId}', '00000000-0000-0000-0000-000000000001', 'portal', 'Juan Driver', '+639171234567', 'Official Visit', '2026-10-31', 'vehicle', '123 Manila St', now());

      insert into public.passes (id, visitor_id, source, public_reference, token_digest, status, valid_from, valid_until)
      values ('${passId}', '${visitorId}', 'portal', gen_random_uuid(), decode('${tokenDigest}', 'hex'), 'issued', now() - interval '1 hour', now() + interval '8 hours');

      insert into public.visit_vehicle_declarations (pass_id, visitor_id, vehicle_type, plate_number, plate_key, color, make_model)
      values ('${passId}', '${visitorId}', 'car', 'ABC 1234', 'ABC1234', 'White', 'Toyota Vios');
    `);

    // Verify initial vehicle declaration
    const initialDecl = await db.query<{ entry_recorded_at: string | null; exit_recorded_at: string | null }>(
      `select entry_recorded_at, exit_recorded_at from public.visit_vehicle_declarations where pass_id = '${passId}'`
    );
    expect(initialDecl.rows[0].entry_recorded_at).toBeNull();
    expect(initialDecl.rows[0].exit_recorded_at).toBeNull();

    // Scan entry at Gate 1
    const entryScanResult = await db.query<{ ok: boolean; result_status: string }>(`
      select * from api.scan_pass(
        '${entryScannerId}'::uuid,
        '${tokenDigest}',
        'entry',
        gen_random_uuid()
      );
    `);
    expect(entryScanResult.rows[0].ok).toBe(true);
    expect(entryScanResult.rows[0].result_status).toBe('inside');

    // Assert entry_recorded_at was atomically set on visit_vehicle_declarations
    const afterEntry = await db.query<{ entry_recorded_at: string | null; exit_recorded_at: string | null }>(
      `select entry_recorded_at, exit_recorded_at from public.visit_vehicle_declarations where pass_id = '${passId}'`
    );
    expect(afterEntry.rows[0].entry_recorded_at).not.toBeNull();
    expect(afterEntry.rows[0].exit_recorded_at).toBeNull();

    // Scan exit at Gate 1
    const exitScanResult = await db.query<{ ok: boolean; result_status: string }>(`
      select * from api.scan_pass(
        '${exitScannerId}'::uuid,
        '${tokenDigest}',
        'exit',
        gen_random_uuid()
      );
    `);
    expect(exitScanResult.rows[0].ok).toBe(true);
    expect(exitScanResult.rows[0].result_status).toBe('exited');

    // Assert exit_recorded_at was atomically set on visit_vehicle_declarations
    const afterExit = await db.query<{ entry_recorded_at: string | null; exit_recorded_at: string | null }>(
      `select entry_recorded_at, exit_recorded_at from public.visit_vehicle_declarations where pass_id = '${passId}'`
    );
    expect(afterExit.rows[0].entry_recorded_at).not.toBeNull();
    expect(afterExit.rows[0].exit_recorded_at).not.toBeNull();
  }, 60000);
});
