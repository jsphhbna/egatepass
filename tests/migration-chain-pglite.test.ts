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
      created_at timestamptz default now(),
      updated_at timestamptz default now()
    );

    create or replace function auth.uid() returns uuid as $$
      select '00000000-0000-0000-0000-000000000001'::uuid;
    $$ language sql stable;

    create or replace function auth.role() returns text as $$
      select 'service_role'::text;
    $$ language sql stable;

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

describe('Permanent PostgreSQL Migration Chain & Schema Contracts (PGlite)', () => {
  it('A. Sequential migration execution from a clean database (000100 through 001300)', async () => {
    const db = new PGlite();
    const files = await applyAllMigrations(db);
    expect(files.length).toBeGreaterThanOrEqual(13);

    // Check that core tables and views exist
    const passesCheck = await db.query(`select count(*) as count from public.passes;`);
    expect(Number(passesCheck.rows[0].count)).toBe(0);

    const appSettingsCheck = await db.query(`select count(*) as count from public.app_settings;`);
    expect(Number(appSettingsCheck.rows[0].count)).toBe(1);
  }, 30000);

  it('B. Final-schema function contract: verifies critical RPC signatures', async () => {
    const db = new PGlite();
    await applyAllMigrations(db);

    // Query pg_proc for registered api functions
    const funcs = await db.query<{ proname: string; proargnames: string[] }>(`
      select p.proname, p.proargnames
      from pg_proc p
      join pg_namespace n on p.pronamespace = n.oid
      where n.nspname = 'api';
    `);

    const funcMap = new Map<string, string[]>();
    for (const row of funcs.rows) {
      funcMap.set(row.proname, row.proargnames || []);
    }

    // 1. decide_visit signature
    expect(funcMap.has('decide_visit')).toBe(true);
    const decideArgs = funcMap.get('decide_visit')!;
    expect(decideArgs).toContain('requested_actor_id');
    expect(decideArgs).toContain('requested_pass_id');
    expect(decideArgs).toContain('requested_decision');
    expect(decideArgs).toContain('requested_reason');
    expect(decideArgs).toContain('requested_request_id');

    // 2. create_incident_hold signature
    expect(funcMap.has('create_incident_hold')).toBe(true);
    const holdArgs = funcMap.get('create_incident_hold')!;
    expect(holdArgs).toContain('requested_actor_id');
    expect(holdArgs).toContain('requested_visitor_id');
    expect(holdArgs).toContain('requested_pass_id');
    expect(holdArgs).toContain('requested_reason');
    expect(holdArgs).toContain('requested_request_id');

    // 3. guard_dashboard signature
    expect(funcMap.has('guard_dashboard')).toBe(true);
    const dashArgs = funcMap.get('guard_dashboard')!;
    expect(dashArgs).toContain('requested_limit');
    expect(dashArgs).toContain('requested_offset');

    // 4. request_email_verification_code signature
    expect(funcMap.has('request_email_verification_code')).toBe(true);

    // 5. create_upload_intent signature
    expect(funcMap.has('create_upload_intent')).toBe(true);

    // 6. acknowledge_privacy return type is timestamptz (Repair 1A)
    const ackPrivacy = await db.query<{ typname: string }>(`
      select t.typname
      from pg_proc p
      join pg_namespace n on p.pronamespace = n.oid
      join pg_type t on p.prorettype = t.oid
      where n.nspname = 'api' and p.proname = 'acknowledge_privacy';
    `);
    expect(ackPrivacy.rows[0]?.typname).toBe('timestamptz');
  }, 30000);

  it('C. Enum contract: verifies visit_event_type and pass_status values', async () => {
    const db = new PGlite();
    await applyAllMigrations(db);

    const enums = await db.query<{ typname: string; enumlabel: string }>(`
      select t.typname, e.enumlabel
      from pg_type t
      join pg_enum e on t.oid = e.enumtypid
      order by t.typname, e.enumsortorder;
    `);

    const visitEventTypes = enums.rows
      .filter((r) => r.typname === 'visit_event_type')
      .map((r) => r.enumlabel);

    // Confirm canonical visit_event_type values
    expect(visitEventTypes).toContain('invalid_scan');
    expect(visitEventTypes).toContain('scan_entry');
    expect(visitEventTypes).toContain('approved');
    expect(visitEventTypes).toContain('rejected');
    expect(visitEventTypes).toContain('scan_exit');
    // Confirm 'expired' is NOT a visit_event_type (Repair 4)
    expect(visitEventTypes).not.toContain('expired');

    const passStatuses = enums.rows
      .filter((r) => r.typname === 'pass_status')
      .map((r) => r.enumlabel);
    expect(passStatuses).toContain('expired');
    expect(passStatuses).toContain('pending');
    expect(passStatuses).toContain('inside');
  }, 30000);

  it('D. Audit schema contract: verifies canonical columns and outcome constraints', async () => {
    const db = new PGlite();
    await applyAllMigrations(db);

    const cols = await db.query<{ column_name: string }>(`
      select column_name
      from information_schema.columns
      where table_schema = 'public' and table_name = 'audit_events';
    `);

    const colNames = cols.rows.map((r) => r.column_name);

    // Canonical columns
    expect(colNames).toContain('actor_id');
    expect(colNames).toContain('actor_kind');
    expect(colNames).toContain('actor_role');
    expect(colNames).toContain('action');
    expect(colNames).toContain('target_type');
    expect(colNames).toContain('target_id');
    expect(colNames).toContain('before_state');
    expect(colNames).toContain('after_state');
    expect(colNames).toContain('request_id');
    expect(colNames).toContain('outcome');
    expect(colNames).toContain('occurred_at');

    // Invalid 'details' column must NOT exist
    expect(colNames).not.toContain('details');


    const testUserId = '00000000-0000-0000-0000-000000000001';
    await db.exec(`
      insert into auth.users (id, email)
      values ('${testUserId}'::uuid, 'admin@example.com')
      on conflict (id) do nothing;
    `);

    // Valid insert test
    await expect(
      db.exec(`
        insert into public.audit_events (
          actor_id, actor_kind, actor_role, action, target_type, target_id,
          request_id, outcome, after_state
        ) values (
          '${testUserId}'::uuid, 'staff', 'admin', 'test_action', 'test_target', '123',
          gen_random_uuid(), 'success', '{"key": "value"}'::jsonb
        );
      `)
    ).resolves.toBeDefined();

    // Invalid outcome 'partial_failure' must fail check constraint
    await expect(
      db.exec(`
        insert into public.audit_events (
          actor_id, actor_kind, actor_role, action, target_type, target_id,
          request_id, outcome, after_state
        ) values (
          '${testUserId}'::uuid, 'staff', 'admin', 'test_action', 'test_target', '123',
          gen_random_uuid(), 'partial_failure', '{"key": "value"}'::jsonb
        );
      `)
    ).rejects.toThrow();
  }, 30000);
});
