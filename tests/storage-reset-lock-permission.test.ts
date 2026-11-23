import { describe, it, expect, beforeEach } from 'vitest';
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
      created_at timestamptz default now(),
      updated_at timestamptz default now(),
      public boolean default false,
      avif_autodetection boolean default false,
      file_size_limit bigint,
      allowed_mime_types text[]
    );

    create table if not exists storage.objects (
      id uuid primary key default gen_random_uuid(),
      bucket_id text references storage.buckets(id),
      name text,
      owner uuid,
      owner_id text,
      created_at timestamptz default now(),
      updated_at timestamptz default now(),
      last_accessed_at timestamptz default now(),
      metadata jsonb
    );

    alter table storage.objects enable row level security;
    grant usage on schema storage to anon, authenticated, service_role;
    grant select, insert on table storage.objects to authenticated, service_role;
    grant select on table storage.buckets to anon, authenticated, service_role;

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
    try {
      await db.exec(sql);
    } catch (err) {
      console.error(`Error executing migration ${file}:`, err);
      throw err;
    }
  }
  return files;
}

describe('Storage Reset Lock Permission & Upload Policy Verification', () => {
  let db: PGlite;
  const visitorId = '11111111-1111-4111-8111-111111111111';
  const otherVisitorId = '22222222-2222-4222-8222-222222222222';

  beforeEach(async () => {
    db = new PGlite();
    await applyAllMigrations(db);

    // Seed test users in auth.users
    await db.exec(`
      insert into auth.users (id, email)
      values
        ('${visitorId}'::uuid, 'visitor1@domain.test'),
        ('${otherVisitorId}'::uuid, 'visitor2@domain.test')
      on conflict (id) do nothing;
    `);
  }, 60000);

  it('1. authenticated role can execute private.is_system_reset_locked()', async () => {
    await db.exec(`
      set role authenticated;
      set request.jwt.claim.role = 'authenticated';
      set request.jwt.claim.sub = '${visitorId}';
    `);

    const result = await db.query<{ is_locked: boolean }>(`
      select private.is_system_reset_locked() as is_locked;
    `);

    expect(result.rows.length).toBe(1);
    expect(result.rows[0].is_locked).toBe(false);

    await db.exec(`reset role;`);
  });

  it('2. anon role is denied execution of private.is_system_reset_locked() (42501)', async () => {
    await db.exec(`
      set role anon;
      set request.jwt.claim.role = 'anon';
      set request.jwt.claim.sub = '';
    `);

    await expect(
      db.query(`select private.is_system_reset_locked();`)
    ).rejects.toThrow(/permission denied/i);

    await db.exec(`reset role;`);
  });

  it('3. authenticated role cannot directly select from public.maintenance_state (42501)', async () => {
    await db.exec(`
      set role authenticated;
      set request.jwt.claim.role = 'authenticated';
      set request.jwt.claim.sub = '${visitorId}';
    `);

    await expect(
      db.query(`select * from public.maintenance_state;`)
    ).rejects.toThrow(/permission denied/i);

    await db.exec(`reset role;`);
  });

  it('4. anon role cannot directly select from public.maintenance_state (42501)', async () => {
    await db.exec(`
      set role anon;
      set request.jwt.claim.role = 'anon';
      set request.jwt.claim.sub = '';
    `);

    await expect(
      db.query(`select * from public.maintenance_state;`)
    ).rejects.toThrow(/permission denied/i);

    await db.exec(`reset role;`);
  });

  it('5. storage.objects upload succeeds for authenticated user with valid unexpired intent', async () => {
    const objectPath = `portal/${visitorId}/face_photo_test.jpg`;

    // Create valid pending intent under service_role
    await db.exec(`
      insert into public.upload_intents (
        owner_id, bucket_id, object_path, kind, status, max_bytes, expires_at, source, content_type
      ) values (
        '${visitorId}'::uuid,
        'visitor-photos',
        '${objectPath}',
        'photo',
        'pending',
        5242880,
        now() + interval '15 minutes',
        'portal',
        'image/jpeg'
      );
    `);

    // Switch to authenticated visitor session
    await db.exec(`
      set role authenticated;
      set request.jwt.claim.role = 'authenticated';
      set request.jwt.claim.sub = '${visitorId}';
      set my.auth.uid = '${visitorId}';
    `);

    // Storage object insert must succeed without permission errors
    await expect(
      db.exec(`
        insert into storage.objects (bucket_id, name, owner_id)
        values ('visitor-photos', '${objectPath}', '${visitorId}');
      `)
    ).resolves.not.toThrow();

    // Verify object was inserted
    const objCheck = await db.query<{ count: string }>(`
      select count(*) as count from storage.objects where name = '${objectPath}';
    `);
    expect(Number(objCheck.rows[0].count)).toBe(1);

    await db.exec(`reset role;`);
  });

  it('6. storage.objects upload fails when no upload intent exists', async () => {
    const objectPath = `portal/${visitorId}/unauthorized_photo.jpg`;

    await db.exec(`
      set role authenticated;
      set request.jwt.claim.role = 'authenticated';
      set request.jwt.claim.sub = '${visitorId}';
      set my.auth.uid = '${visitorId}';
    `);

    // Must violate row-level security policy
    await expect(
      db.exec(`
        insert into storage.objects (bucket_id, name, owner_id)
        values ('visitor-photos', '${objectPath}', '${visitorId}');
      `)
    ).rejects.toThrow(/row-level security policy/i);

    await db.exec(`reset role;`);
  });

  it('7. storage.objects upload fails when intent is expired', async () => {
    const objectPath = `portal/${visitorId}/expired_photo.jpg`;

    // Create expired intent under service_role
    await db.exec(`
      insert into public.upload_intents (
        owner_id, bucket_id, object_path, kind, status, max_bytes, expires_at, source, content_type
      ) values (
        '${visitorId}'::uuid,
        'visitor-photos',
        '${objectPath}',
        'photo',
        'pending',
        5242880,
        now() - interval '1 minute',
        'portal',
        'image/jpeg'
      );
    `);

    await db.exec(`
      set role authenticated;
      set request.jwt.claim.role = 'authenticated';
      set request.jwt.claim.sub = '${visitorId}';
      set my.auth.uid = '${visitorId}';
    `);

    await expect(
      db.exec(`
        insert into storage.objects (bucket_id, name, owner_id)
        values ('visitor-photos', '${objectPath}', '${visitorId}');
      `)
    ).rejects.toThrow(/row-level security policy/i);

    await db.exec(`reset role;`);
  });

  it('8. storage.objects upload fails when intent belongs to a different owner', async () => {
    const objectPath = `portal/${otherVisitorId}/other_user_photo.jpg`;

    // Intent belongs to otherVisitorId
    await db.exec(`
      insert into public.upload_intents (
        owner_id, bucket_id, object_path, kind, status, max_bytes, expires_at, source, content_type
      ) values (
        '${otherVisitorId}'::uuid,
        'visitor-photos',
        '${objectPath}',
        'photo',
        'pending',
        5242880,
        now() + interval '15 minutes',
        'portal',
        'image/jpeg'
      );
    `);

    // Current actor is visitorId (different user)
    await db.exec(`
      set role authenticated;
      set request.jwt.claim.role = 'authenticated';
      set request.jwt.claim.sub = '${visitorId}';
      set my.auth.uid = '${visitorId}';
    `);

    await expect(
      db.exec(`
        insert into storage.objects (bucket_id, name, owner_id)
        values ('visitor-photos', '${objectPath}', '${visitorId}');
      `)
    ).rejects.toThrow(/row-level security policy/i);

    await db.exec(`reset role;`);
  });

  it('9. storage.objects upload fails when system reset is locked', async () => {
    const objectPath = `portal/${visitorId}/reset_locked_photo.jpg`;

    // Create valid intent under service_role
    await db.exec(`
      insert into public.upload_intents (
        owner_id, bucket_id, object_path, kind, status, max_bytes, expires_at, source, content_type
      ) values (
        '${visitorId}'::uuid,
        'visitor-photos',
        '${objectPath}',
        'photo',
        'pending',
        5242880,
        now() + interval '15 minutes',
        'portal',
        'image/jpeg'
      );
    `);

    // Lock the system reset
    await db.exec(`
      update public.maintenance_state
      set cursor_value = 'locked'
      where job_name = 'system_reset';
    `);

    await db.exec(`
      set role authenticated;
      set request.jwt.claim.role = 'authenticated';
      set request.jwt.claim.sub = '${visitorId}';
      set my.auth.uid = '${visitorId}';
    `);

    // Must be rejected (either by trigger errcode 55P03 or RLS check violation)
    await expect(
      db.exec(`
        insert into storage.objects (bucket_id, name, owner_id)
        values ('visitor-photos', '${objectPath}', '${visitorId}');
      `)
    ).rejects.toThrow();

    await db.exec(`reset role;`);
  });

  it('10. storage.objects upload is rejected for unauthenticated (anon) role', async () => {
    const objectPath = `portal/anon/unauthenticated.jpg`;

    await db.exec(`
      set role anon;
      set request.jwt.claim.role = 'anon';
      set request.jwt.claim.sub = '';
    `);

    await expect(
      db.exec(`
        insert into storage.objects (bucket_id, name, owner_id)
        values ('visitor-photos', '${objectPath}', '${visitorId}');
      `)
    ).rejects.toThrow(/row-level security policy|permission denied/i);

    await db.exec(`reset role;`);
  });

  it('11. storage buckets configuration verifies private buckets and allowed mime types', async () => {
    const buckets = await db.query<{
      id: string;
      public: boolean;
      file_size_limit: number;
      allowed_mime_types: string[];
    }>(`
      select id, public, file_size_limit, allowed_mime_types
      from storage.buckets
      where id in ('visitor-photos', 'visitor-ids')
      order by id;
    `);

    expect(buckets.rows.length).toBe(2);

    for (const b of buckets.rows) {
      expect(b.public).toBe(false);
      expect(Number(b.file_size_limit)).toBe(5242880);
      expect(b.allowed_mime_types).toContain('image/jpeg');
      expect(b.allowed_mime_types).toContain('image/png');
      expect(b.allowed_mime_types).toContain('image/webp');
    }
  });

  it('12. static inspection of migration 20261123001000 verifies least privilege rules', () => {
    const migrationSql = readFileSync(
      join(MIGRATIONS_DIR, '20261123001000_storage_reset_lock_least_privilege_repair.sql'),
      'utf8'
    );

    // USAGE granted to authenticated and service_role
    expect(migrationSql).toContain('grant usage on schema private to authenticated;');
    expect(migrationSql).toContain('grant usage on schema private to service_role;');
    expect(migrationSql).toContain('revoke all on schema private from anon, public;');

    // EXECUTE granted to authenticated and service_role
    expect(migrationSql).toContain('grant execute on function private.is_system_reset_locked() to authenticated;');
    expect(migrationSql).toContain('grant execute on function private.is_system_reset_locked() to service_role;');
    expect(migrationSql).toContain('revoke all on function private.is_system_reset_locked() from anon, public;');

    // Table maintenance_state strictly isolated
    expect(migrationSql).toContain('revoke all on table public.maintenance_state from public, anon, authenticated;');
    expect(migrationSql).toContain('grant select, insert, update on table public.maintenance_state to service_role;');
    expect(migrationSql).toContain('revoke delete on table public.maintenance_state from service_role;');

    // System reset check preserved in storage policy
    expect(migrationSql).toContain('not private.is_system_reset_locked()');
    expect(migrationSql).toContain("status = 'pending'::public.upload_intent_status");
    expect(migrationSql).toContain('expires_at > now()');
  });
});
