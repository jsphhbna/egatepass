import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';

const MIGRATIONS_DIR = path.resolve(process.cwd(), 'supabase', 'migrations');

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
        '00000000-0000-4000-a000-000000000001'::uuid
      );
    $$ language sql stable;

    create or replace function auth.role() returns text as $$
      select coalesce(
        nullif(current_setting('request.jwt.claim.role', true), ''),
        (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'),
        'authenticated'::text
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

async function applyAllMigrations(db: PGlite): Promise<void> {
  await setupSupabaseEmulation(db);
  const files = fs.readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    let sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    sql = sql.replace(/create extension if not exists pgcrypto[^;]*;/gi, '-- pgcrypto no-op');
    await db.exec(sql);
  }
}

const SUPERADMIN_ID = '00000000-0000-4000-a000-000000000001';

describe('Section G: Kiosk Operator PIN Security Tests', () => {
  let db: PGlite;

  beforeAll(async () => {
    db = new PGlite();
    await applyAllMigrations(db);

    // Seed Super Admin
    await db.exec(`
      insert into auth.users (id, email, email_confirmed_at)
      values ('${SUPERADMIN_ID}', 'admin@earist.edu.ph', now());

      insert into public.staff_profiles (user_id, display_name, role, active, must_change_password, privacy_accepted_at)
      values ('${SUPERADMIN_ID}', 'Super Administrator', 'superadmin', true, false, now());
    `);
  }, 60000);

  afterAll(async () => {
    if (db) {
      await db.close();
    }
  });

  const asKioskAnon = async () => {
    await db.exec(`
      set local "request.jwt.claim.role" = 'anon';
      set local role anon;
    `);
  };

  const asSuperAdmin = async () => {
    await db.exec(`
      set local "request.jwt.claim.role" = 'authenticated';
      set local "request.jwt.claim.sub" = '${SUPERADMIN_ID}';
      set local role authenticated;
    `);
  };

  it('G.1: rejects arbitrary PINs (1234, 9999, abcd, 0000, 1904, 123456) when PIN is not configured', async () => {
    const arbitraryPins = ['1234', '9999', 'abcd', '0000', '1904', '123456'];

    for (const pin of arbitraryPins) {
      await asKioskAnon();
      const res = await db.query<{ verify_kiosk_operator_pin: any }>(`
        select api.verify_kiosk_operator_pin('${pin}');
      `);
      const result = res.rows[0]?.verify_kiosk_operator_pin;
      expect(result.valid).toBe(false);
    }
  });

  it('G.2: allows Super Admin to configure a PIN and unlocks with exact matching PIN', async () => {
    // 1. Super Admin sets PIN to '847291'
    await asSuperAdmin();
    await db.exec(`
      select api.admin_set_kiosk_operator_pin('847291');
    `);

    // 2. Random/previous PINs still fail
    await asKioskAnon();
    const wrongRes = await db.query<{ verify_kiosk_operator_pin: any }>(`
      select api.verify_kiosk_operator_pin('1904');
    `);
    expect(wrongRes.rows[0].verify_kiosk_operator_pin.valid).toBe(false);

    // 3. Exact configured PIN succeeds
    await asKioskAnon();
    const correctRes = await db.query<{ verify_kiosk_operator_pin: any }>(`
      select api.verify_kiosk_operator_pin('847291');
    `);
    expect(correctRes.rows[0].verify_kiosk_operator_pin.valid).toBe(true);
  });

  it('G.3: enforces lockout after 5 consecutive failed attempts', async () => {
    // Reset config with a new PIN as Super Admin
    await asSuperAdmin();
    await db.exec(`
      select api.admin_set_kiosk_operator_pin('987654');
    `);

    // 4 failed attempts from kiosk
    for (let i = 0; i < 4; i++) {
      await asKioskAnon();
      const res = await db.query<{ verify_kiosk_operator_pin: any }>(`
        select api.verify_kiosk_operator_pin('00000${i}');
      `);
      expect(res.rows[0].verify_kiosk_operator_pin.valid).toBe(false);
      expect(res.rows[0].verify_kiosk_operator_pin.locked).toBe(false);
    }

    // 5th failed attempt triggers lockout
    await asKioskAnon();
    const lockRes = await db.query<{ verify_kiosk_operator_pin: any }>(`
      select api.verify_kiosk_operator_pin('000005');
    `);
    expect(lockRes.rows[0].verify_kiosk_operator_pin.valid).toBe(false);
    expect(lockRes.rows[0].verify_kiosk_operator_pin.locked).toBe(true);

    // Subsequent attempt (even with correct PIN) is locked out!
    await asKioskAnon();
    const blockedRes = await db.query<{ verify_kiosk_operator_pin: any }>(`
      select api.verify_kiosk_operator_pin('987654');
    `);
    expect(blockedRes.rows[0].verify_kiosk_operator_pin.valid).toBe(false);
    expect(blockedRes.rows[0].verify_kiosk_operator_pin.locked).toBe(true);
  });

  it('G.4: verifies that no hardcoded production PINs or length >= 4 bypasses exist in frontend source', () => {
    const modalPath = path.resolve(process.cwd(), 'src/components/KioskPrinterSettingsModal.tsx');
    const content = fs.readFileSync(modalPath, 'utf8');

    // Assert absence of hardcoded fallback PINs and bypasses
    expect(content).not.toContain("pin === '1904'");
    expect(content).not.toContain("pin === '0000'");
    expect(content).not.toContain('pin.length >= 4');
    expect(content).not.toContain('pin.length >= 6'); // Should not unlock simply on length
    expect(content).toContain('verify_kiosk_operator_pin');
  });
});
