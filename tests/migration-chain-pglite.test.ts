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

    // 6. update_app_settings exactly one signature without overload
    const updateSettingsProcs = await db.query<{ regproc: string }>(`
      select p.oid::regprocedure::text as regproc
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'api'
        and p.proname = 'update_app_settings';
    `);
    expect(updateSettingsProcs.rows.length).toBe(1);
    expect(updateSettingsProcs.rows[0].regproc).toMatch(/api\.update_app_settings\(uuid,(public\.)?peak_mode_scope,jsonb,jsonb,time( without time zone)?,time( without time zone)?,smallint,smallint,smallint,smallint,smallint,boolean,uuid,smallint,smallint\)/);

    // 6. acknowledge_privacy return type is timestamptz (Repair 1A)
    const ackPrivacy = await db.query<{ typname: string }>(`
      select t.typname
      from pg_proc p
      join pg_namespace n on p.pronamespace = n.oid
      join pg_type t on p.prorettype = t.oid
      where n.nspname = 'api' and p.proname = 'acknowledge_privacy';
    `);
    expect(ackPrivacy.rows[0]?.typname).toBe('timestamptz');

    // 7. dashboard aggregates RPCs (Repair Group N)
    expect(funcMap.has('dashboard_calendar_counts')).toBe(true);
    expect(funcMap.has('dashboard_today_insights')).toBe(true);
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

  it('E. Incident hold cross-target invariant: rejects mismatched visitor and pass', async () => {
    const db = new PGlite();
    await applyAllMigrations(db);

    const testStaffId = '00000000-0000-0000-0000-000000000001';
    const testVisitorOwnerId = '00000000-0000-0000-0000-000000000002';
    await db.exec(`
      insert into auth.users (id, email)
      values ('${testStaffId}'::uuid, 'admin@example.com'),
             ('${testVisitorOwnerId}'::uuid, 'visitor-owner@example.com')
      on conflict (id) do nothing;

      insert into public.staff_profiles (user_id, display_name, role, active, must_change_password, privacy_accepted_at)
      values ('${testStaffId}'::uuid, 'Test Superadmin', 'superadmin', true, false, now())
      on conflict (user_id) do nothing;
    `);

    // Insert visitor 1 and visitor 2
    const visitor1Id = '11111111-1111-1111-1111-111111111111';
    const visitor2Id = '22222222-2222-2222-2222-222222222222';
    await db.exec(`
      insert into public.visitors (id, owner_id, source, full_name, contact_number, purpose, visit_date, consent_accepted_at)
      values ('${visitor1Id}'::uuid, '${testVisitorOwnerId}'::uuid, 'portal', 'Visitor 1', '09123456789', 'Meeting', current_date, now()),
             ('${visitor2Id}'::uuid, '${testVisitorOwnerId}'::uuid, 'portal', 'Visitor 2', '09123456780', 'Interview', current_date, now());
    `);

    // Insert pass for visitor 2
    const pass2Id = '33333333-3333-3333-3333-333333333333';
    await db.exec(`
      insert into public.passes (
        id, visitor_id, public_reference, token_digest, source, status,
        valid_from, valid_until
      ) values (
        '${pass2Id}'::uuid,
        '${visitor2Id}'::uuid,
        gen_random_uuid(),
        decode('0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', 'hex'),
        'portal',
        'pending',
        now(),
        now() + interval '8 hours'
      );
    `);

    // Attempting to create hold with visitor 1 and pass 2 (mismatch!) must throw pass_visitor_mismatch
    await expect(
      db.query(`
        select api.create_incident_hold(
          '${testStaffId}'::uuid,
          '${visitor1Id}'::uuid,
          '${pass2Id}'::uuid,
          'Investigation into incident',
          gen_random_uuid()
        );
      `)
    ).rejects.toThrow(/pass_visitor_mismatch/);

    // Matching visitor 2 and pass 2 succeeds
    const successRes = await db.query(`
      select api.create_incident_hold(
        '${testStaffId}'::uuid,
        '${visitor2Id}'::uuid,
        '${pass2Id}'::uuid,
        'Investigation into incident',
        gen_random_uuid()
      );
    `);
    expect(successRes.rows.length).toBe(1);
  }, 30000);

  it('F. Upgrade execution: applying migration 001400 and new hardening migration on top of 001300 cleanly succeeds', async () => {
    const db = new PGlite();
    await setupSupabaseEmulation(db);
    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    // Apply up to 001300
    const earlyFiles = files.filter((f) => f <= '20261020001300_cross_layer_root_cause_hardening.sql');
    for (const file of earlyFiles) {
      let sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
      sql = sql.replace(/create extension if not exists pgcrypto[^;]*;/gi, '-- pgcrypto no-op');
      await db.exec(sql);
    }

    // Now apply subsequent upgrade migrations sequentially in timestamp order
    const upgradeFiles = files.filter((f) => f > '20261020001300_cross_layer_root_cause_hardening.sql');
    for (const file of upgradeFiles) {
      let sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
      sql = sql.replace(/create extension if not exists pgcrypto[^;]*;/gi, '-- pgcrypto no-op');
      await expect(db.exec(sql)).resolves.toBeDefined();
    }

    // Verify upgrade path also leaves exactly ONE update_app_settings procedure
    const upgradeProcs = await db.query<{ regproc: string }>(`
      select p.oid::regprocedure::text as regproc
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'api'
        and p.proname = 'update_app_settings';
    `);
    expect(upgradeProcs.rows.length).toBe(1);
    expect(upgradeProcs.rows[0].regproc).toMatch(/api\.update_app_settings\(uuid,(public\.)?peak_mode_scope,jsonb,jsonb,time( without time zone)?,time( without time zone)?,smallint,smallint,smallint,smallint,smallint,boolean,uuid,smallint,smallint\)/);
  }, 30000);

  it('G. PGLITE/POSTGRES CONTRACT TEST: Device and anonymous credential mutation protection trigger (D1-D10)', async () => {
    const db = new PGlite();
    const files = await applyAllMigrations(db);
    expect(files.some((f) => f.includes('204805'))).toBe(true);

    const deviceUid = '11111111-2222-3333-4444-555555555555';
    const anonUid = '66666666-7777-8888-9999-000000000000';
    const staffUid = '77777777-8888-9999-aaaa-bbbbbbbbbbbb';

    await db.exec(`
      insert into auth.users (id, email, encrypted_password, is_anonymous, raw_app_meta_data)
      values ('${deviceUid}'::uuid, 'kiosk-01@devices.egatepass.invalid', 'old_hash', false, '{"egatepass_device_credential_change_id":"marker-initial"}'::jsonb),
             ('${anonUid}'::uuid, null, null, true, '{}'::jsonb),
             ('${staffUid}'::uuid, 'staff.member@earist.edu.ph', 'initial_staff_hash', false, '{}'::jsonb);

      insert into public.devices (user_id, alias, name, type, gate, status)
      values ('${deviceUid}'::uuid, 'kiosk-01', 'Kiosk 1', 'kiosk', 'Main Gate', 'active');
    `);

    // D1 device password + no marker change -> DENIED
    await expect(
      db.exec(`
        update auth.users
        set encrypted_password = 'new_stolen_hash'
        where id = '${deviceUid}'::uuid;
      `)
    ).rejects.toThrow(/device credentials are super admin managed/);

    // D2 device email + no marker change -> DENIED
    await expect(
      db.exec(`
        update auth.users
        set email = 'kiosk-hijacked@devices.egatepass.invalid'
        where id = '${deviceUid}'::uuid;
      `)
    ).rejects.toThrow(/device credentials are super admin managed/);

    // D3 device password + fresh marker -> ALLOWED
    await expect(
      db.exec(`
        update auth.users
        set encrypted_password = 'fresh_password_hash',
            raw_app_meta_data = '{"egatepass_device_credential_change_id":"marker-fresh-1"}'::jsonb
        where id = '${deviceUid}'::uuid;
      `)
    ).resolves.toBeDefined();

    // D4 device email + fresh marker -> ALLOWED
    await expect(
      db.exec(`
        update auth.users
        set email = 'kiosk-01-renamed@devices.egatepass.invalid',
            raw_app_meta_data = '{"egatepass_device_credential_change_id":"marker-fresh-2"}'::jsonb
        where id = '${deviceUid}'::uuid;
      `)
    ).resolves.toBeDefined();

    // D5 marker reused for second password/email mutation -> DENIED
    await expect(
      db.exec(`
        update auth.users
        set encrypted_password = 'reused_marker_hash',
            raw_app_meta_data = '{"egatepass_device_credential_change_id":"marker-fresh-2"}'::jsonb
        where id = '${deviceUid}'::uuid;
      `)
    ).rejects.toThrow(/device credentials are super admin managed/);

    // D6 compensating email rollback + second fresh marker -> ALLOWED
    await expect(
      db.exec(`
        update auth.users
        set email = 'kiosk-01@devices.egatepass.invalid',
            raw_app_meta_data = '{"egatepass_device_credential_change_id":"marker-rollback-3"}'::jsonb
        where id = '${deviceUid}'::uuid;
      `)
    ).resolves.toBeDefined();

    // D7 regular staff password mutation -> trigger does not block
    await expect(
      db.exec(`
        update auth.users
        set encrypted_password = 'new_regular_staff_hash'
        where id = '${staffUid}'::uuid;
      `)
    ).resolves.toBeDefined();

    // D8 anonymous password mutation -> DENIED
    await expect(
      db.exec(`
        update auth.users
        set encrypted_password = 'attacker_password_hash'
        where id = '${anonUid}'::uuid;
      `)
    ).rejects.toThrow(/anonymous accounts cannot set passwords/);

    // D9 housekeeping-only auth.users update -> ALLOWED
    await expect(
      db.exec(`
        update auth.users
        set updated_at = now()
        where id = '${deviceUid}'::uuid;
      `)
    ).resolves.toBeDefined();

    // D10 trigger function direct execute privileges revoked
    await db.exec('set role anon;');
    await expect(
      db.query('select public.protect_managed_credentials();')
    ).rejects.toThrow(/permission denied/);
    await db.exec('reset role;');

    await db.exec('set role authenticated;');
    await expect(
      db.query('select public.protect_managed_credentials();')
    ).rejects.toThrow(/permission denied/);
    await db.exec('reset role;');
  }, 30000);

  it('H. PGLITE/POSTGRES CONTRACT TEST: Public registration settings safe column RLS and grants', async () => {
    const db = new PGlite();
    await applyAllMigrations(db);

    // 1. Anon safe columns -> ALLOWED
    await db.exec('set role anon;');
    const anonQuery = await db.query<{ working_hours_start: string; visit_purposes: any; visitor_instructions: any; image_retention_days: number; visitor_retention_days: number }>(
      'select working_hours_start, working_hours_end, timezone, scheduling_days_ahead, peak_mode, visit_purposes, visitor_instructions, image_retention_days, visitor_retention_days from public.app_settings;'
    );
    expect(anonQuery.rows.length).toBe(1);
    expect(anonQuery.rows[0].working_hours_start).toBeDefined();
    expect(anonQuery.rows[0].visitor_instructions).toBeDefined();
    expect(anonQuery.rows[0].image_retention_days).toBeDefined();
    expect(anonQuery.rows[0].visitor_retention_days).toBeDefined();

    // 2. Sensitive / unapproved fields -> STILL DENIED for anon
    await expect(
      db.query('select automatic_cleanup_enabled from public.app_settings;')
    ).rejects.toThrow(/permission denied/);

    await expect(
      db.query('select reconciliation_retention_days from public.app_settings;')
    ).rejects.toThrow(/permission denied/);

    await expect(
      db.query('select audit_retention_days from public.app_settings;')
    ).rejects.toThrow(/permission denied/);

    // 3. Authenticated safe columns -> ALLOWED, sensitive columns -> DENIED
    await db.exec('set role authenticated;');
    const authQuery = await db.query<{ visitor_instructions: any; image_retention_days: number; visitor_retention_days: number }>(
      'select visitor_instructions, image_retention_days, visitor_retention_days from public.app_settings;'
    );
    expect(authQuery.rows.length).toBe(1);
    expect(authQuery.rows[0].visitor_instructions).toBeDefined();
    expect(authQuery.rows[0].image_retention_days).toBeDefined();
    expect(authQuery.rows[0].visitor_retention_days).toBeDefined();

    await expect(
      db.query('select automatic_cleanup_enabled from public.app_settings;')
    ).rejects.toThrow(/permission denied/);

    await expect(
      db.query('select reconciliation_retention_days from public.app_settings;')
    ).rejects.toThrow(/permission denied/);

    await expect(
      db.query('select audit_retention_days from public.app_settings;')
    ).rejects.toThrow(/permission denied/);

    await db.exec('set role anon;');

    // 3. Anon UPDATE -> DENIED
    await expect(
      db.query("update public.app_settings set working_hours_start = '09:00';")
    ).rejects.toThrow(/permission denied/);

    // 4. Anon INSERT -> DENIED
    await expect(
      db.query("insert into public.app_settings (singleton) values (true);")
    ).rejects.toThrow(/permission denied/);

    // 5. Anon DELETE -> DENIED
    await expect(
      db.query('delete from public.app_settings;')
    ).rejects.toThrow(/permission denied/);

    await db.exec('reset role;');

                // 6. Authenticated role safe columns -> ALLOWED
    await db.exec('set role authenticated;');
    const authSafeQuery = await db.query(
      'select working_hours_start, working_hours_end, timezone, scheduling_days_ahead, peak_mode, visit_purposes, visitor_instructions, image_retention_days, visitor_retention_days from public.app_settings;'
    );
    expect(authSafeQuery.rows.length).toBe(1);

    // 7. Authenticated role full select / sensitive columns -> DENIED (leak prevented)
    await expect(
      db.query('select * from public.app_settings;')
    ).rejects.toThrow(/permission denied/);

    await expect(
      db.query('select automatic_cleanup_enabled from public.app_settings;')
    ).rejects.toThrow(/permission denied/);

    await expect(
      db.query('select audit_retention_days from public.app_settings;')
    ).rejects.toThrow(/permission denied/);

    await db.exec('reset role;');
  }, 30000);

  it('I. PGLITE/POSTGRES CONTRACT TEST: Supabase 10-actor identity matrix and recovery confinement', async () => {
    const db = new PGlite();
    await applyAllMigrations(db);

    const ANON_VISITOR_UID = '00000000-0000-4000-b000-000000000001';
    const PERM_NON_STAFF_UID = '00000000-0000-4000-b000-000000000002';
    const GUARD_UID = '00000000-0000-4000-b000-000000000003';
    const ADMIN_UID = '00000000-0000-4000-b000-000000000004';
    const SUPERADMIN_UID = '00000000-0000-4000-b000-000000000005';
    const KIOSK_DEVICE_UID = '00000000-0000-4000-b000-000000000006';
    const ENTRY_DEVICE_UID = '00000000-0000-4000-b000-000000000007';
    const EXIT_DEVICE_UID = '00000000-0000-4000-b000-000000000008';

    // Seed Auth users and profiles
    await db.exec(`
      -- 1. Anonymous visitor
      insert into auth.users (id, email, is_anonymous)
      values ('${ANON_VISITOR_UID}', null, true);

      -- 2. Permanent non-staff account
      insert into auth.users (id, email, is_anonymous, email_confirmed_at)
      values ('${PERM_NON_STAFF_UID}', 'perm-user@example.com', false, now());

      -- 3. Guard
      insert into auth.users (id, email, is_anonymous, email_confirmed_at)
      values ('${GUARD_UID}', 'guard@earist.edu.ph', false, now());
      insert into public.staff_profiles (user_id, display_name, role, active, must_change_password, privacy_accepted_at)
      values ('${GUARD_UID}', 'Guard User', 'guard', true, false, now());

      -- 4. Admin
      insert into auth.users (id, email, is_anonymous, email_confirmed_at)
      values ('${ADMIN_UID}', 'admin@earist.edu.ph', false, now());
      insert into public.staff_profiles (user_id, display_name, role, active, must_change_password, privacy_accepted_at)
      values ('${ADMIN_UID}', 'Admin User', 'admin', true, false, now());

      -- 5. Super Admin
      insert into auth.users (id, email, is_anonymous, email_confirmed_at)
      values ('${SUPERADMIN_UID}', 'superadmin@earist.edu.ph', false, now());
      insert into public.staff_profiles (user_id, display_name, role, active, must_change_password, privacy_accepted_at)
      values ('${SUPERADMIN_UID}', 'Super Admin User', 'superadmin', true, false, now());

      -- 6. Kiosk Device
      insert into auth.users (id, email, is_anonymous, email_confirmed_at)
      values ('${KIOSK_DEVICE_UID}', 'kiosk-01@devices.egatepass.invalid', false, now());
      insert into public.devices (user_id, alias, name, type, gate, status)
      values ('${KIOSK_DEVICE_UID}', 'kiosk-01', 'Kiosk 1', 'kiosk', 'Main Gate', 'active');

      -- 7. Entry Device
      insert into auth.users (id, email, is_anonymous, email_confirmed_at)
      values ('${ENTRY_DEVICE_UID}', 'entry-01@devices.egatepass.invalid', false, now());
      insert into public.devices (user_id, alias, name, type, gate, status)
      values ('${ENTRY_DEVICE_UID}', 'entry-01', 'Entry 1', 'entry', 'Gate 1', 'active');

      -- 8. Exit Device
      insert into auth.users (id, email, is_anonymous, email_confirmed_at)
      values ('${EXIT_DEVICE_UID}', 'exit-01@devices.egatepass.invalid', false, now());
      insert into public.devices (user_id, alias, name, type, gate, status)
      values ('${EXIT_DEVICE_UID}', 'exit-01', 'Exit 1', 'exit', 'Gate 1', 'active');
    `);

    async function setSession(sub, amr, role = 'authenticated') {
      await db.exec(`set role ${role};`);
      const claims = JSON.stringify({
        sub,
        role,
        amr: amr.map((method) => ({ method, timestamp: Math.floor(Date.now() / 1000) })),
      });
      await db.exec(`set request.jwt.claims = '${claims}';`);
    }

    // 1. Pre-auth anon role
    await db.exec(`set role anon; set request.jwt.claims = '';`);
    const anonSettings = await db.query('select working_hours_start, visitor_retention_days, visitor_instructions from public.app_settings;');
    expect(anonSettings.rows.length).toBe(1);
    await expect(db.query('select automatic_cleanup_enabled from public.app_settings;')).rejects.toThrow(/permission denied/);
    await db.exec('reset role;');

    // 2. Real Anonymous Portal visitor: is_anonymous = true
    await setSession(ANON_VISITOR_UID, ['anonymous']);
    const portalActorRes = await db.query('select * from api.current_actor();');
    expect(portalActorRes.rows.length).toBe(1);
    expect(portalActorRes.rows[0].actor_kind).toBe('visitor');
    // Can read safe settings columns only
    const visitorSettings = await db.query('select working_hours_start, visitor_retention_days, visitor_instructions from public.app_settings;');
    expect(visitorSettings.rows.length).toBe(1);
    await expect(db.query('select * from public.app_settings;')).rejects.toThrow(/permission denied/);
    await expect(db.query('select automatic_cleanup_enabled from public.app_settings;')).rejects.toThrow(/permission denied/);
    // CAN create valid portal upload intent
    const uploadRes = await db.query(
      "select * from api.create_upload_intent('portal'::public.pass_source, 'photo'::public.evidence_kind, 'image/jpeg');"
    );
    expect(uploadRes.rows.length).toBe(1);
    await db.exec('reset role;');

    // Verify private.is_portal_actor() under service_role
    await db.exec(`set request.jwt.claims = '{"sub": "${ANON_VISITOR_UID}"}';`);
    const directPortalCheck = await db.query('select private.is_portal_actor() as is_portal;');
    expect(directPortalCheck.rows[0].is_portal).toBe(true);

    // 3. Permanent non-staff Auth user: is_anonymous = false
    await setSession(PERM_NON_STAFF_UID, ['password']);
    const nonStaffActorRes = await db.query('select * from api.current_actor();');
    expect(nonStaffActorRes.rows.length).toBe(0); // Not a portal actor, staff, or device
    // Cannot create portal upload intent
    await expect(
      db.query("select * from api.create_upload_intent('portal'::public.pass_source, 'photo'::public.evidence_kind, 'image/jpeg');")
    ).rejects.toThrow(/visitor identity required/);
    await db.exec('reset role;');

    // Direct check of private.is_portal_actor() under service_role
    await db.exec(`set request.jwt.claims = '{"sub": "${PERM_NON_STAFF_UID}"}';`);
    const directPermCheck = await db.query('select private.is_portal_actor() as is_portal;');
    expect(directPermCheck.rows[0].is_portal).toBe(false);

    // 4. Guard: normal password login
    await setSession(GUARD_UID, ['password']);
    const guardActorRes = await db.query('select * from api.current_actor();');
    expect(guardActorRes.rows.length).toBe(1);
    expect(guardActorRes.rows[0].actor_kind).toBe('staff');
    expect(guardActorRes.rows[0].staff_role).toBe('guard');
    // Cannot forge portal source
    await expect(
      db.query("select * from api.create_upload_intent('portal'::public.pass_source, 'photo'::public.evidence_kind, 'image/jpeg');")
    ).rejects.toThrow(/visitor identity required/);
    await db.exec('reset role;');

    // 5. Admin: normal password login
    await setSession(ADMIN_UID, ['password']);
    const adminActorRes = await db.query('select * from api.current_actor();');
    expect(adminActorRes.rows.length).toBe(1);
    expect(adminActorRes.rows[0].staff_role).toBe('admin');
    await db.exec('reset role;');

    // 6. Super Admin: normal password login
    await setSession(SUPERADMIN_UID, ['password']);
    const superActorRes = await db.query('select * from api.current_actor();');
    expect(superActorRes.rows.length).toBe(1);
    expect(superActorRes.rows[0].staff_role).toBe('superadmin');
    await db.exec('reset role;');

    // 7. Kiosk Device: authenticated device
    await setSession(KIOSK_DEVICE_UID, ['password']);
    const kioskActorRes = await db.query('select * from api.current_actor();');
    expect(kioskActorRes.rows.length).toBe(1);
    expect(kioskActorRes.rows[0].actor_kind).toBe('device');
    expect(kioskActorRes.rows[0].device_type).toBe('kiosk');
    // Can create kiosk upload intent
    const kioskUploadRes = await db.query(
      "select * from api.create_upload_intent('kiosk'::public.pass_source, 'photo'::public.evidence_kind, 'image/jpeg');"
    );
    expect(kioskUploadRes.rows.length).toBe(1);
    // Cannot forge portal upload intent
    await expect(
      db.query("select * from api.create_upload_intent('portal'::public.pass_source, 'photo'::public.evidence_kind, 'image/jpeg');")
    ).rejects.toThrow(/visitor identity required/);
    await db.exec('reset role;');

    // 8. Entry Device: authenticated entry scanner
    await setSession(ENTRY_DEVICE_UID, ['password']);
    const entryActorRes = await db.query('select * from api.current_actor();');
    expect(entryActorRes.rows.length).toBe(1);
    expect(entryActorRes.rows[0].device_type).toBe('entry');
    await db.exec('reset role;');

    // 9. Exit Device: authenticated exit scanner
    await setSession(EXIT_DEVICE_UID, ['password']);
    const exitActorRes = await db.query('select * from api.current_actor();');
    expect(exitActorRes.rows.length).toBe(1);
    expect(exitActorRes.rows[0].device_type).toBe('exit');
    await db.exec('reset role;');

    // 10. RECOVERY SESSION STAFF ACTOR & CONFINEMENT CONTRACT
    // Seed an onboarding guard who has not yet accepted privacy
    const GUARD_ONBOARDING_UID = '00000000-0000-4000-b000-000000000011';
    await db.exec(`
      insert into auth.users (id, email, is_anonymous, email_confirmed_at)
      values ('${GUARD_ONBOARDING_UID}', 'guard-onboarding@earist.edu.ph', false, now());
      insert into public.staff_profiles (user_id, display_name, role, active, must_change_password, privacy_accepted_at)
      values ('${GUARD_ONBOARDING_UID}', 'New Guard', 'guard', true, true, null);
    `);

    // A. Normal Guard session CAN read its own staff profile
    await setSession(GUARD_UID, ['password']);
    const guardProfileNormal = await db.query('select * from public.staff_profiles;');
    expect(guardProfileNormal.rows.length).toBe(1);
    expect(guardProfileNormal.rows[0].user_id).toBe(GUARD_UID);
    // Normal Guard session CAN execute guard_dashboard
    const dashboardNormal = await db.query('select * from api.guard_dashboard();');
    expect(dashboardNormal.rows.length).toBe(1);
    await db.exec('reset role;');

    // B. Guard RECOVERY session CANNOT read its own staff profile through RLS
    await setSession(GUARD_UID, ['recovery']);
    const guardProfileRecovery = await db.query('select * from public.staff_profiles;');
    expect(guardProfileRecovery.rows.length).toBe(0); // DENIED by hardened staff_profiles_select!

    // C. Guard RECOVERY session CANNOT call api.guard_dashboard()
    await expect(db.query('select * from api.guard_dashboard();')).rejects.toThrow(/recovery_session_forbidden/);

    // D. Guard RECOVERY session CANNOT call api.acknowledge_privacy()
    await expect(db.query('select api.acknowledge_privacy();')).rejects.toThrow(/recovery_session_forbidden/);

    // E. Guard RECOVERY session CANNOT read devices
    const devicesRead = await db.query('select * from public.devices;');
    expect(devicesRead.rows.length).toBe(0);

    // F. Current staff role must resolve to NULL: api.current_actor() returns 0 rows!
    const recoveryActorRes = await db.query('select * from api.current_actor();');
    expect(recoveryActorRes.rows.length).toBe(0);
    await db.exec('reset role;');

    // G. Normal onboarding Guard CAN read own profile and acknowledge privacy
    await setSession(GUARD_ONBOARDING_UID, ['password']);
    const onboardingProfile = await db.query('select * from public.staff_profiles;');
    expect(onboardingProfile.rows.length).toBe(1);
    expect(onboardingProfile.rows[0].privacy_accepted_at).toBeNull();
    const ackRes = await db.query('select api.acknowledge_privacy() as accepted_at;');
    expect(ackRes.rows[0].accepted_at).not.toBeNull();
    // Verify privacy_accepted_at was updated
    const updatedProfile = await db.query('select privacy_accepted_at from public.staff_profiles;');
    expect(updatedProfile.rows[0].privacy_accepted_at).not.toBeNull();
    await db.exec('reset role;');

    // H. Admin RECOVERY session CANNOT read staff profiles or call guard_dashboard
    await setSession(ADMIN_UID, ['recovery']);
    const adminRecProfiles = await db.query('select * from public.staff_profiles;');
    expect(adminRecProfiles.rows.length).toBe(0); // DENIED by RLS!
    await expect(db.query('select * from api.guard_dashboard();')).rejects.toThrow(/recovery_session_forbidden/);
    await db.exec('reset role;');

    // I. Direct check of is_recovery_session under service_role
    await db.exec(`set request.jwt.claims = '{"sub": "${GUARD_UID}", "amr": [{"method": "recovery"}]}';`);
    const directRecCheck = await db.query('select private.is_recovery_session() as is_rec;');
    expect(directRecCheck.rows[0].is_rec).toBe(true);
    const directRoleCheck = await db.query('select private.current_staff_role() as role;');
    expect(directRoleCheck.rows[0].role).toBeNull();
  }, 30000);

  it('J. PGLITE/POSTGRES CONTRACT TEST: api.guard_dashboard response contract, deterministic ordering, and Asia/Manila daily statistics', async () => {
    const db = new PGlite();
    await applyAllMigrations(db);

    // 1. Seed Guard actor
    const GUARD_UID = '00000000-0000-4000-b000-000000000021';
    await db.exec(`
      insert into auth.users (id, email, is_anonymous, email_confirmed_at)
      values ('${GUARD_UID}', 'guard-duty@earist.edu.ph', false, now());
      insert into public.staff_profiles (user_id, display_name, role, active, must_change_password, privacy_accepted_at)
      values ('${GUARD_UID}', 'Officer Ramos', 'guard', true, false, now());
    `);

    // 2. Seed visitors with valid auth.users owners and explicit Manila day dates
    const OWNER_1 = '00000000-0000-4000-e000-000000000001';
    const OWNER_2 = '00000000-0000-4000-e000-000000000002';
    const OWNER_3 = '00000000-0000-4000-e000-000000000003';
    const OWNER_4 = '00000000-0000-4000-e000-000000000004';
    const OWNER_5 = '00000000-0000-4000-e000-000000000005';
    const OWNER_6 = '00000000-0000-4000-e000-000000000006';
    const OWNER_7 = '00000000-0000-4000-e000-000000000007';
    const OWNER_8 = '00000000-0000-4000-e000-000000000008';
    const OWNER_9 = '00000000-0000-4000-e000-000000000009';

    await db.exec(`
      insert into auth.users (id, email, is_anonymous, email_confirmed_at)
      values
        ('${OWNER_1}', 'v1@example.com', true, now()),
        ('${OWNER_2}', 'v2@example.com', true, now()),
        ('${OWNER_3}', 'v3@example.com', true, now()),
        ('${OWNER_4}', 'v4@example.com', true, now()),
        ('${OWNER_5}', 'v5@example.com', true, now()),
        ('${OWNER_6}', 'v6@example.com', true, now()),
        ('${OWNER_7}', 'v7@example.com', true, now()),
        ('${OWNER_8}', 'v8@example.com', true, now()),
        ('${OWNER_9}', 'v9@example.com', true, now());
    `);

    const VISITOR_1 = '00000000-0000-4000-a000-000000000001';
    const VISITOR_2 = '00000000-0000-4000-a000-000000000002';
    const VISITOR_3 = '00000000-0000-4000-a000-000000000003';
    const VISITOR_4 = '00000000-0000-4000-a000-000000000004';
    const VISITOR_5 = '00000000-0000-4000-a000-000000000005';
    const VISITOR_6 = '00000000-0000-4000-a000-000000000006';
    const VISITOR_7 = '00000000-0000-4000-a000-000000000007';
    const VISITOR_8 = '00000000-0000-4000-a000-000000000008';
    const VISITOR_9 = '00000000-0000-4000-a000-000000000009';

    // Seed visitors using explicit Manila dates (avoiding session-dependent current_date)
    await db.exec(`
      do $$
      declare
        v_manila_today date := (statement_timestamp() at time zone 'Asia/Manila')::date;
      begin
        insert into public.visitors (id, owner_id, source, full_name, contact_number, email, purpose, visit_date, consent_accepted_at)
        values
          ('${VISITOR_1}', '${OWNER_1}', 'portal', 'Alice Santos', '09123456781', 'alice@example.com', 'Meeting', v_manila_today, now()),
          ('${VISITOR_2}', '${OWNER_2}', 'portal', 'Bob Cruz', '09123456782', 'bob@example.com', 'Delivery', v_manila_today, now()),
          ('${VISITOR_3}', '${OWNER_3}', 'portal', 'Charlie Diaz', '09123456783', 'charlie@example.com', 'Interview', v_manila_today, now()),
          ('${VISITOR_4}', '${OWNER_4}', 'portal', 'David Tie', '09123456784', 'david@example.com', 'Inquiry', v_manila_today, now()),
          ('${VISITOR_5}', '${OWNER_5}', 'portal', 'Dan Inside', '09123456785', 'dan@example.com', 'Meeting', v_manila_today, now()),
          ('${VISITOR_6}', '${OWNER_6}', 'portal', 'Eva Exited', '09123456786', 'eva@example.com', 'Meeting', v_manila_today, now()),
          ('${VISITOR_7}', '${OWNER_7}', 'portal', 'Frank Rejected', '09123456787', 'frank@example.com', 'Meeting', v_manila_today, now()),
          ('${VISITOR_8}', '${OWNER_8}', 'portal', 'Grace Yesterday', '09123456788', 'grace@example.com', 'Meeting', v_manila_today - 1, now() - interval '1 day'),
          ('${VISITOR_9}', '${OWNER_9}', 'portal', 'Heidi Tomorrow', '09123456789', 'heidi@example.com', 'Meeting', v_manila_today + 1, now());
      end $$;
    `);

    // 3. Seed visitor evidence and upload intents
    const INTENT_1 = '00000000-0000-4000-f000-000000000001';
    const INTENT_2 = '00000000-0000-4000-f000-000000000002';
    const INTENT_3 = '00000000-0000-4000-f000-000000000003';

    const PHOTO_EVID_1 = '00000000-0000-4000-c000-000000000001';
    const ID_EVID_1 = '00000000-0000-4000-c000-000000000002';
    const PHOTO_EVID_2 = '00000000-0000-4000-c000-000000000003';

    await db.exec(`
      insert into public.upload_intents (id, owner_id, source, kind, bucket_id, object_path, content_type, max_bytes, expires_at, status, claimed_at, visitor_id)
      values
        ('${INTENT_1}', '${OWNER_1}', 'portal', 'photo', 'visitor-photos', 'alice/photo.jpg', 'image/jpeg', 5242880, now() + interval '1 day', 'claimed', now(), '${VISITOR_1}'),
        ('${INTENT_2}', '${OWNER_1}', 'portal', 'id', 'visitor-ids', 'alice/id.jpg', 'image/jpeg', 5242880, now() + interval '1 day', 'claimed', now(), '${VISITOR_1}'),
        ('${INTENT_3}', '${OWNER_2}', 'portal', 'photo', 'visitor-photos', 'bob/photo.jpg', 'image/jpeg', 5242880, now() + interval '1 day', 'claimed', now(), '${VISITOR_2}');

      insert into public.visitor_evidence (id, visitor_id, upload_intent_id, kind, bucket_id, object_path, content_type, byte_size, sha256_hex, verified_at, expires_at)
      values
        ('${PHOTO_EVID_1}', '${VISITOR_1}', '${INTENT_1}', 'photo', 'visitor-photos', 'alice/photo.jpg', 'image/jpeg', 1024, repeat('a', 64), now(), now() + interval '30 days'),
        ('${ID_EVID_1}', '${VISITOR_1}', '${INTENT_2}', 'id', 'visitor-ids', 'alice/id.jpg', 'image/jpeg', 2048, repeat('b', 64), now(), now() + interval '30 days'),
        ('${PHOTO_EVID_2}', '${VISITOR_2}', '${INTENT_3}', 'photo', 'visitor-photos', 'bob/photo.jpg', 'image/jpeg', 1024, repeat('c', 64), now(), now() + interval '30 days');
    `);

    // 4. Seed passes using explicit Asia/Manila day bounds (v_day_start offsets)
    // Eliminates midnight flakiness (never uses now() - 1 hour)
    const PASS_1 = '00000000-0000-4000-d000-000000000001';
    const PASS_2 = '00000000-0000-4000-d000-000000000002';
    const PASS_3 = '00000000-0000-4000-d000-000000000003';
    const PASS_4_TIE = '00000000-0000-4000-d000-000000000004';

    await db.exec(`
      do $$
      declare
        v_day_start timestamptz := date_trunc('day', statement_timestamp() at time zone 'Asia/Manila') at time zone 'Asia/Manila';
        v_day_end timestamptz := (date_trunc('day', statement_timestamp() at time zone 'Asia/Manila') + interval '1 day') at time zone 'Asia/Manila';
      begin
        -- Pending 1: scanned earliest (v_day_start + 1h)
        insert into public.passes (
          id, visitor_id, token_digest, source, status, valid_from, valid_until, entry_scanned_at, gate, issued_at
        ) values (
          '${PASS_1}', '${VISITOR_1}', decode('0101010101010101010101010101010101010101010101010101010101010101', 'hex'), 'portal', 'pending',
          v_day_start + interval '1 hour', v_day_end - interval '1 minute', v_day_start + interval '1 hour 10 minutes', 'Gate 1', v_day_start + interval '1 hour'
        );

        -- Pending 2: scanned second (v_day_start + 2h)
        insert into public.passes (
          id, visitor_id, token_digest, source, status, valid_from, valid_until, entry_scanned_at, gate, issued_at
        ) values (
          '${PASS_2}', '${VISITOR_2}', decode('0202020202020202020202020202020202020202020202020202020202020202', 'hex'), 'portal', 'pending',
          v_day_start + interval '2 hours', v_day_end - interval '1 minute', v_day_start + interval '2 hours 20 minutes', 'Gate 2', v_day_start + interval '2 hours'
        );

        -- Pending 3 & Pending 4: EXACT SAME entry_scanned_at (v_day_start + 3h 30m) to test deterministic UUID tie-breaker
        insert into public.passes (
          id, visitor_id, token_digest, source, status, valid_from, valid_until, entry_scanned_at, gate, issued_at
        ) values (
          '${PASS_3}', '${VISITOR_3}', decode('0303030303030303030303030303030303030303030303030303030303030303', 'hex'), 'portal', 'pending',
          v_day_start + interval '3 hours', v_day_end - interval '1 minute', v_day_start + interval '3 hours 30 minutes', 'Gate 1', v_day_start + interval '3 hours'
        );

        insert into public.passes (
          id, visitor_id, token_digest, source, status, valid_from, valid_until, entry_scanned_at, gate, issued_at
        ) values (
          '${PASS_4_TIE}', '${VISITOR_4}', decode('0404040404040404040404040404040404040404040404040404040404040404', 'hex'), 'portal', 'pending',
          v_day_start + interval '3 hours 15 minutes', v_day_end - interval '1 minute', v_day_start + interval '3 hours 30 minutes', 'Gate 2', v_day_start + interval '3 hours 15 minutes'
        );

        -- Today Manila: status inside
        insert into public.passes (id, visitor_id, token_digest, source, status, valid_from, valid_until, issued_at)
        values (gen_random_uuid(), '${VISITOR_5}', decode('0505050505050505050505050505050505050505050505050505050505050505', 'hex'), 'portal', 'inside', v_day_start + interval '4 hours', v_day_end - interval '1 minute', v_day_start + interval '4 hours');

        -- Today Manila: status exited
        insert into public.passes (id, visitor_id, token_digest, source, status, valid_from, valid_until, issued_at, time_out)
        values (gen_random_uuid(), '${VISITOR_6}', decode('0606060606060606060606060606060606060606060606060606060606060606', 'hex'), 'portal', 'exited', v_day_start + interval '5 hours', v_day_end - interval '1 minute', v_day_start + interval '5 hours', v_day_start + interval '7 hours');

        -- Today Manila: status rejected
        insert into public.passes (id, visitor_id, token_digest, source, status, valid_from, valid_until, issued_at, decided_at, rejection_reason)
        values (gen_random_uuid(), '${VISITOR_7}', decode('0707070707070707070707070707070707070707070707070707070707070707', 'hex'), 'portal', 'rejected', v_day_start + interval '6 hours', v_day_end - interval '1 minute', v_day_start + interval '6 hours', v_day_start + interval '6 hours', 'Security Hold');

        -- Yesterday (outside Manila today boundary: BEFORE v_day_start)
        insert into public.passes (id, visitor_id, token_digest, source, status, valid_from, valid_until, issued_at)
        values (gen_random_uuid(), '${VISITOR_8}', decode('0808080808080808080808080808080808080808080808080808080808080808', 'hex'), 'portal', 'inside', v_day_start - interval '5 hours', v_day_start - interval '1 hour', v_day_start - interval '2 hours');

        -- Tomorrow (outside Manila today boundary: AT OR AFTER v_day_end)
        insert into public.passes (id, visitor_id, token_digest, source, status, valid_from, valid_until, issued_at)
        values (gen_random_uuid(), '${VISITOR_9}', decode('0909090909090909090909090909090909090909090909090909090909090909', 'hex'), 'portal', 'inside', v_day_end + interval '2 hours', v_day_end + interval '8 hours', v_day_end + interval '2 hours');
      end $$;
    `);

    // Helper to switch session to Guard actor
    async function asGuard() {
      await db.exec(`
        set role authenticated;
        set request.jwt.claims = '{"sub": "${GUARD_UID}", "role": "authenticated", "amr": [{"method": "password"}]}';
      `);
    }

    await asGuard();

    // 5. Test Deterministic Ordering & Full Queue: All 4 pending passes
    const resFull = await db.query<{ guard_dashboard: any }>('select api.guard_dashboard(10, 0) as guard_dashboard;');
    const dFull = resFull.rows[0].guard_dashboard;

    // Verify root contract keys
    expect(dFull).toHaveProperty('queue');
    expect(dFull).toHaveProperty('stats');
    expect(dFull).toHaveProperty('rejectionReasons');
    expect(dFull).toHaveProperty('pendingTotal');
    expect(dFull).toHaveProperty('hasMore');
    expect(dFull).not.toHaveProperty('totalPending'); // Canonical key is pendingTotal

    expect(dFull.queue).toHaveLength(4);
    expect(dFull.pendingTotal).toBe(4);
    expect(dFull.hasMore).toBe(false);

    // Verify DETERMINISTIC ORDERING:
    // PASS_1 (1h 10m) < PASS_2 (2h 20m) < PASS_3 (3h 30m, UUID ending 0003) < PASS_4_TIE (3h 30m, UUID ending 0004)
    expect(dFull.queue[0].id).toBe(PASS_1);
    expect(dFull.queue[1].id).toBe(PASS_2);
    expect(dFull.queue[2].id).toBe(PASS_3);
    expect(dFull.queue[3].id).toBe(PASS_4_TIE);

    // Verify evidence contract on item 0 (Alice has both photo and ID evidence)
    const item1 = dFull.queue[0];
    expect(item1.visitorName).toBe('Alice Santos');
    expect(item1.photoEvidenceId).toBe(PHOTO_EVID_1);
    expect(item1.idEvidenceId).toBe(ID_EVID_1);
    expect(item1).not.toHaveProperty('evidence'); // Canonical keys, not generic array

    // Item 1 (Bob has photo evidence, but null ID evidence)
    const item2 = dFull.queue[1];
    expect(item2.id).toBe(PASS_2);
    expect(item2.photoEvidenceId).toBe(PHOTO_EVID_2);
    expect(item2.idEvidenceId).toBeNull();

    // 6. Test Pagination & Authoritative Backlog Count (limit = 2, offset = 0)
    const resPage1 = await db.query<{ guard_dashboard: any }>('select api.guard_dashboard(2, 0) as guard_dashboard;');
    const dPage1 = resPage1.rows[0].guard_dashboard;
    expect(dPage1.queue.length).toBe(2);
    expect(dPage1.pendingTotal).toBe(4); // Backlog total remains authoritative
    expect(dPage1.hasMore).toBe(true);
    expect(dPage1.queue[0].id).toBe(PASS_1);
    expect(dPage1.queue[1].id).toBe(PASS_2);

    // Page 2 (limit = 2, offset = 2)
    const resPage2 = await db.query<{ guard_dashboard: any }>('select api.guard_dashboard(2, 2) as guard_dashboard;');
    const dPage2 = resPage2.rows[0].guard_dashboard;
    expect(dPage2.queue.length).toBe(2);
    expect(dPage2.pendingTotal).toBe(4);
    expect(dPage2.hasMore).toBe(false);
    expect(dPage2.queue[0].id).toBe(PASS_3);
    expect(dPage2.queue[1].id).toBe(PASS_4_TIE);

    // 7. Test Daily Stats contract and Asia/Manila boundary enforcement
    // Truthful metric semantics:
    // inside: 3 (all passes currently with status 'inside', regardless of issue date)
    // exited: 1 (exited today Manila)
    // rejected: 1 (rejected today Manila)
    // total: 4 (entry scans recorded today Manila: PASS_1, PASS_2, PASS_3, PASS_4_TIE)
    expect(dFull.stats).toHaveProperty('inside');
    expect(dFull.stats).toHaveProperty('exited');
    expect(dFull.stats).toHaveProperty('rejected');
    expect(dFull.stats).toHaveProperty('total');
    expect(dFull.stats).not.toHaveProperty('pending');

    expect(dFull.stats.inside).toBe(3);
    expect(dFull.stats.exited).toBe(1);
    expect(dFull.stats.rejected).toBe(1);
    expect(dFull.stats.total).toBe(4);

    // 8. TIMEZONE INVARIANCE TEST: Session time zone changed to UTC
    await db.exec("SET TIME ZONE 'UTC';");
    const resUtc = await db.query<{ guard_dashboard: any }>('select api.guard_dashboard(10, 0) as guard_dashboard;');
    const dUtc = resUtc.rows[0].guard_dashboard;

    expect(dUtc.stats.inside).toBe(3);
    expect(dUtc.stats.exited).toBe(1);
    expect(dUtc.stats.rejected).toBe(1);
    expect(dUtc.stats.total).toBe(4);
    expect(dUtc.pendingTotal).toBe(4);
    expect(dUtc.queue[0].id).toBe(PASS_1);
    expect(dUtc.queue[1].id).toBe(PASS_2);
    expect(dUtc.queue[2].id).toBe(PASS_3);
    expect(dUtc.queue[3].id).toBe(PASS_4_TIE);

    // Session time zone changed to America/New_York
    await db.exec("SET TIME ZONE 'America/New_York';");
    const resNy = await db.query<{ guard_dashboard: any }>('select api.guard_dashboard(10, 0) as guard_dashboard;');
    const dNy = resNy.rows[0].guard_dashboard;

    expect(dNy.stats.inside).toBe(3);
    expect(dNy.stats.exited).toBe(1);
    expect(dNy.stats.rejected).toBe(1);
    expect(dNy.stats.total).toBe(4);
    expect(dNy.pendingTotal).toBe(4);
    expect(dNy.queue[0].id).toBe(PASS_1);
    expect(dNy.queue[1].id).toBe(PASS_2);
    expect(dNy.queue[2].id).toBe(PASS_3);
    expect(dNy.queue[3].id).toBe(PASS_4_TIE);

    await db.exec('reset role;');
  }, 30000);

  it('K. PGLITE/POSTGRES CONTRACT TEST: service_role least-privilege backend table grants matrix', async () => {
    const db = new PGlite();
    await applyAllMigrations(db);

    const tables = [
      'app_settings',
      'audit_events',
      'devices',
      'incident_holds',
      'maintenance_state',
      'pass_email_verifications',
      'passes',
      'rate_limit_buckets',
      'reconciliation_tasks',
      'staff_profiles',
      'upload_intents',
      'visit_events',
      'visitor_evidence',
      'visitors',
    ];

    // 1. Verify RLS is enabled on all 14 tables
    const rlsRes = await db.query<{ relname: string; relrowsecurity: boolean }>(`
      select c.relname, c.relrowsecurity
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = any($1);
    `, [tables]);
    expect(rlsRes.rows.length).toBe(14);
    for (const r of rlsRes.rows) {
      expect(r.relrowsecurity, `Table ${r.relname} must have RLS enabled`).toBe(true);
    }

    // 2. Verify exact service_role table privileges
    const expectedGrants: Record<string, { allowed: string[]; forbidden: string[] }> = {
      app_settings: { allowed: ['SELECT'], forbidden: ['INSERT', 'UPDATE', 'DELETE'] },
      audit_events: { allowed: ['SELECT', 'INSERT', 'DELETE'], forbidden: ['UPDATE'] },
      devices: { allowed: ['SELECT'], forbidden: ['INSERT', 'UPDATE', 'DELETE'] },
      incident_holds: { allowed: ['SELECT'], forbidden: ['INSERT', 'UPDATE', 'DELETE'] },
      maintenance_state: { allowed: ['SELECT', 'INSERT', 'UPDATE'], forbidden: ['DELETE'] },
      pass_email_verifications: { allowed: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'], forbidden: [] },
      passes: { allowed: ['SELECT'], forbidden: ['INSERT', 'UPDATE', 'DELETE'] },
      rate_limit_buckets: { allowed: [], forbidden: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'] },
      reconciliation_tasks: { allowed: ['SELECT', 'INSERT', 'DELETE'], forbidden: ['UPDATE'] },
      staff_profiles: { allowed: ['SELECT'], forbidden: ['INSERT', 'UPDATE', 'DELETE'] },
      upload_intents: { allowed: ['SELECT', 'UPDATE'], forbidden: ['INSERT', 'DELETE'] },
      visit_events: { allowed: ['SELECT'], forbidden: ['INSERT', 'UPDATE', 'DELETE'] },
      visitor_evidence: { allowed: ['SELECT'], forbidden: ['INSERT', 'UPDATE', 'DELETE'] },
      visitors: { allowed: ['SELECT', 'UPDATE'], forbidden: ['INSERT', 'DELETE'] },
    };

    for (const [table, matrix] of Object.entries(expectedGrants)) {
      for (const priv of matrix.allowed) {
        const res = await db.query<{ has_priv: boolean }>(
          `select has_table_privilege('service_role', $1, $2) as has_priv;`,
          [`public.${table}`, priv]
        );
        expect(res.rows[0].has_priv, `service_role must have ${priv} on public.${table}`).toBe(true);
      }
      for (const priv of matrix.forbidden) {
        const res = await db.query<{ has_priv: boolean }>(
          `select has_table_privilege('service_role', $1, $2) as has_priv;`,
          [`public.${table}`, priv]
        );
        expect(res.rows[0].has_priv, `service_role must NOT have ${priv} on public.${table}`).toBe(false);
      }
    }

    // 3. Verify sequence privilege on audit_events_id_seq
    const seqRes = await db.query<{ has_usage: boolean; has_select: boolean }>(`
      select
        has_sequence_privilege('service_role', 'public.audit_events_id_seq', 'USAGE') as has_usage,
        has_sequence_privilege('service_role', 'public.audit_events_id_seq', 'SELECT') as has_select;
    `);
    expect(seqRes.rows[0].has_usage).toBe(true);
    expect(seqRes.rows[0].has_select).toBe(true);

    // 4. Verify negative assertions for anon and authenticated (least privilege)
    for (const table of ['passes', 'visitors', 'staff_profiles', 'audit_events', 'reconciliation_tasks']) {
      const anonRes = await db.query<{ has_priv: boolean }>(
        `select has_table_privilege('anon', $1, 'SELECT') as has_priv;`,
        [`public.${table}`]
      );
      expect(anonRes.rows[0].has_priv, `anon must NOT have SELECT on public.${table}`).toBe(false);

      const authInsert = await db.query<{ has_priv: boolean }>(
        `select has_table_privilege('authenticated', $1, 'INSERT') as has_priv;`,
        [`public.${table}`]
      );
      expect(authInsert.rows[0].has_priv, `authenticated must NOT have direct INSERT on public.${table}`).toBe(false);
    }
  }, 30000);
  it('L. PGLITE/POSTGRES CONTRACT TEST: api.record_resend_delivery_event transactional atomicity & retry rollback', async () => {
    const db = new PGlite();
    await applyAllMigrations(db);

    // 1. Verify EXECUTE privileges: service_role only, revoked from anon & authenticated
    const fnSig = 'api.record_resend_delivery_event(text, text, text, text, text, text, timestamptz)';
    const srPriv = await db.query<{ has_priv: boolean }>(
      `select has_function_privilege('service_role', $1, 'EXECUTE') as has_priv;`,
      [fnSig]
    );
    expect(srPriv.rows[0].has_priv).toBe(true);

    const anonPriv = await db.query<{ has_priv: boolean }>(
      `select has_function_privilege('anon', $1, 'EXECUTE') as has_priv;`,
      [fnSig]
    );
    expect(anonPriv.rows[0].has_priv).toBe(false);

    const authPriv = await db.query<{ has_priv: boolean }>(
      `select has_function_privilege('authenticated', $1, 'EXECUTE') as has_priv;`,
      [fnSig]
    );
    expect(authPriv.rows[0].has_priv).toBe(false);

    // 2. Successful event processing: claim + audit both persist
    const res1 = await db.query<{ result: any }>(`
      select api.record_resend_delivery_event(
        'msg_pglite_test_1',
        'email.delivered',
        'email_pglite_100',
        'success',
        'v***r@earist.edu.ph',
        'Test Gate Pass Confirmation'
      ) as result;
    `);
    const r1 = res1.rows[0].result;
    expect(r1.ok).toBe(true);
    expect(r1.status).toBe('processed');
    expect(r1.duplicate).toBe(false);
    expect(r1.provider_event_id).toBe('msg_pglite_test_1');

    const claimCount1 = await db.query<{ count: string }>(
      `select count(*)::text from public.resend_webhook_events where provider_event_id = 'msg_pglite_test_1';`
    );
    expect(claimCount1.rows[0].count).toBe('1');

    const auditCount1 = await db.query<{ count: string }>(
      `select count(*)::text from public.audit_events where action = 'resend.delivery_event' and target_id = 'email_pglite_100';`
    );
    expect(auditCount1.rows[0].count).toBe('1');

    // 3. Duplicate event replay: returns already_processed, no duplicate audit
    const res2 = await db.query<{ result: any }>(`
      select api.record_resend_delivery_event(
        'msg_pglite_test_1',
        'email.delivered',
        'email_pglite_100',
        'success',
        'v***r@earist.edu.ph',
        'Test Gate Pass Confirmation'
      ) as result;
    `);
    const r2 = res2.rows[0].result;
    expect(r2.ok).toBe(true);
    expect(r2.status).toBe('already_processed');
    expect(r2.duplicate).toBe(true);

    const auditCount2 = await db.query<{ count: string }>(
      `select count(*)::text from public.audit_events where action = 'resend.delivery_event' and target_id = 'email_pglite_100';`
    );
    expect(auditCount2.rows[0].count).toBe('1'); // Still exactly 1

    // 4. Transactional rollback test:
    // If a temporary trigger on audit_events aborts the audit insertion,
    // the provider_event_id insert must roll back completely, allowing retry to succeed.
    await db.exec(`
      create or replace function fail_resend_audit() returns trigger as $$
      begin
        if new.target_id = 'email_fail_rollback' then
          raise exception 'simulated_audit_failure';
        end if;
        return new;
      end;
      $$ language plpgsql;

      create trigger trg_fail_resend_audit
      before insert on public.audit_events
      for each row execute function fail_resend_audit();
    `);

    // Attempt processing when audit fails
    let threw = false;
    try {
      await db.query(`
        select api.record_resend_delivery_event(
          'msg_rollback_test',
          'email.sent',
          'email_fail_rollback',
          'success',
          'u***r@earist.edu.ph',
          'Will Fail Audit'
        );
      `);
    } catch (err: any) {
      threw = true;
      expect(err.message).toContain('simulated_audit_failure');
    }
    expect(threw).toBe(true);

    // Verify atomic rollback: provider_event_id was NOT committed!
    const claimAfterFail = await db.query<{ count: string }>(
      `select count(*)::text from public.resend_webhook_events where provider_event_id = 'msg_rollback_test';`
    );
    expect(claimAfterFail.rows[0].count).toBe('0');

    // Remove the temporary failure trigger to simulate transient failure resolving
    await db.exec(`
      drop trigger trg_fail_resend_audit on public.audit_events;
      drop function fail_resend_audit();
    `);

    // Retry with the EXACT same provider event ID: it must now succeed completely!
    const resRetry = await db.query<{ result: any }>(`
      select api.record_resend_delivery_event(
        'msg_rollback_test',
        'email.sent',
        'email_fail_rollback',
        'success',
        'u***r@earist.edu.ph',
        'Will Fail Audit'
      ) as result;
    `);
    const rRetry = resRetry.rows[0].result;
    expect(rRetry.ok).toBe(true);
    expect(rRetry.status).toBe('processed');

    const claimAfterRetry = await db.query<{ count: string }>(
      `select count(*)::text from public.resend_webhook_events where provider_event_id = 'msg_rollback_test';`
    );
    expect(claimAfterRetry.rows[0].count).toBe('1');

    const auditAfterRetry = await db.query<{ count: string }>(
      `select count(*)::text from public.audit_events where action = 'resend.delivery_event' and target_id = 'email_fail_rollback';`
    );
    expect(auditAfterRetry.rows[0].count).toBe('1');
  }, 30000);

  it('M. PGLITE/POSTGRES CONTRACT TEST: private.bootstrap_super_admin hardening and security invariants', async () => {
    const db = new PGlite();
    await applyAllMigrations(db);

    const fnSig = 'private.bootstrap_super_admin(uuid, text)';

    // 1. Verify EXECUTE privileges: revoked from public, anon, and authenticated
    const anonPriv = await db.query<{ has_priv: boolean }>(
      `select has_function_privilege('anon', $1, 'EXECUTE') as has_priv;`,
      [fnSig]
    );
    expect(anonPriv.rows[0].has_priv).toBe(false);

    const authPriv = await db.query<{ has_priv: boolean }>(
      `select has_function_privilege('authenticated', $1, 'EXECUTE') as has_priv;`,
      [fnSig]
    );
    expect(authPriv.rows[0].has_priv).toBe(false);

    // 2. Setup test identities in auth.users
    const validHumanId = '11111111-1111-1111-1111-111111111111';
    const anonUserId = '22222222-2222-2222-2222-222222222222';
    const unconfirmedUserId = '33333333-3333-3333-3333-333333333333';
    const deviceUserId = '44444444-4444-4444-4444-444444444444';
    const missingUserId = '55555555-5555-5555-5555-555555555555';
    const secondValidId = '66666666-6666-6666-6666-666666666666';

    await db.exec(`
      insert into auth.users (id, email, email_confirmed_at, is_anonymous) values
        ('${validHumanId}', 'superadmin@earist.edu.ph', now(), false),
        ('${anonUserId}', 'anon@earist.edu.ph', now(), true),
        ('${unconfirmedUserId}', 'unconfirmed@earist.edu.ph', null, false),
        ('${deviceUserId}', 'kiosk-01@devices.egatepass.invalid', now(), false),
        ('${secondValidId}', 'owner2@earist.edu.ph', now(), false);
    `);

    // Denial Test 1: missing Auth user -> denied
    await expect(
      db.query(`select private.bootstrap_super_admin('${missingUserId}'::uuid, 'Valid Name');`)
    ).rejects.toThrow('Auth user does not exist');

    // Denial Test 2: anonymous Auth user -> denied
    await expect(
      db.query(`select private.bootstrap_super_admin('${anonUserId}'::uuid, 'Valid Name');`)
    ).rejects.toThrow('anonymous users cannot be bootstrapped as super admin');

    // Denial Test 3: unconfirmed Auth user -> denied
    await expect(
      db.query(`select private.bootstrap_super_admin('${unconfirmedUserId}'::uuid, 'Valid Name');`)
    ).rejects.toThrow('bootstrap target email must be confirmed');

    // Denial Test 4: managed device identity -> denied
    await expect(
      db.query(`select private.bootstrap_super_admin('${deviceUserId}'::uuid, 'Valid Name');`)
    ).rejects.toThrow('managed device identities cannot be bootstrapped as super admin');

    // Denial Test 5: blank / invalid display name -> denied
    await expect(
      db.query(`select private.bootstrap_super_admin('${validHumanId}'::uuid, ' ');`)
    ).rejects.toThrow('display name must be between 2 and 120 characters');

    await expect(
      db.query(`select private.bootstrap_super_admin('${validHumanId}'::uuid, 'A');`)
    ).rejects.toThrow('display name must be between 2 and 120 characters');

    // Denial Test 6: operator check (simulate non-operator role)
    await db.exec(`
      create role some_unprivileged_role;
      grant usage on schema private to some_unprivileged_role;
      grant execute on function private.bootstrap_super_admin(uuid, text) to some_unprivileged_role;
      set role some_unprivileged_role;
    `);
    await expect(
      db.query(`select private.bootstrap_super_admin('${validHumanId}'::uuid, 'Valid Name');`)
    ).rejects.toThrow('bootstrap requires an authorized database operator');
    await db.exec(`reset role;`);

    // Denial Test 7: one existing Guard profile -> denied
    await db.exec(`begin;`);
    await db.exec(`
      insert into public.staff_profiles (user_id, display_name, role, active, must_change_password)
      values ('${validHumanId}', 'Existing Guard', 'guard', true, false);
    `);
    await expect(
      db.query(`select private.bootstrap_super_admin('${secondValidId}'::uuid, 'Second Operator');`)
    ).rejects.toThrow('bootstrap is allowed only before the first staff profile');
    await db.exec(`rollback;`);

    // Denial Test 8: one existing Admin profile -> denied
    await db.exec(`begin;`);
    await db.exec(`
      insert into public.staff_profiles (user_id, display_name, role, active, must_change_password)
      values ('${validHumanId}', 'Existing Admin', 'admin', true, false);
    `);
    await expect(
      db.query(`select private.bootstrap_super_admin('${secondValidId}'::uuid, 'Second Operator');`)
    ).rejects.toThrow('bootstrap is allowed only before the first staff profile');
    await db.exec(`rollback;`);

    // Success Test: authorized database operator + confirmed human Auth identity + zero staff profiles -> SUCCEEDS
    await db.query(`select private.bootstrap_super_admin('${validHumanId}'::uuid, ' Institutional Super Admin ');`);

    // Verify created staff profile state
    const staffRow = await db.query<{
      user_id: string;
      display_name: string;
      role: string;
      active: boolean;
      must_change_password: boolean;
      created_by: string;
    }>(
      `select user_id, display_name, role, active, must_change_password, created_by from public.staff_profiles where user_id = '${validHumanId}';`
    );
    expect(staffRow.rows).toHaveLength(1);
    expect(staffRow.rows[0].role).toBe('superadmin');
    expect(staffRow.rows[0].active).toBe(true);
    expect(staffRow.rows[0].must_change_password).toBe(true);
    expect(staffRow.rows[0].display_name).toBe('Institutional Super Admin');
    expect(staffRow.rows[0].created_by).toBe(validHumanId);

    // Verify audit event
    const auditRow = await db.query<{
      actor_id: string;
      action: string;
      actor_kind: string;
      actor_role: string;
      target_type: string;
      target_id: string;
    }>(
      `select actor_id, action, actor_kind, actor_role, target_type, target_id from public.audit_events where action = 'superadmin.bootstrap' and target_id = '${validHumanId}';`
    );
    expect(auditRow.rows).toHaveLength(1);
    expect(auditRow.rows[0].action).toBe('superadmin.bootstrap');
    expect(auditRow.rows[0].actor_kind).toBe('system');
    expect(auditRow.rows[0].actor_role).toBe('bootstrap');

    // Denial Test 9: second bootstrap attempt (with existing Super Admin profile) -> denied
    await expect(
      db.query(`select private.bootstrap_super_admin('${secondValidId}'::uuid, 'Second Super Admin');`)
    ).rejects.toThrow('bootstrap is allowed only before the first staff profile');
  }, 30000);

  it('Migration 37: enforces server-only execution boundaries on guard offline sync and thermal template RPCs', async () => {
    const db = new PGlite();
    await applyAllMigrations(db);

    // Verify guard_sync_offline_registration privileges
    const regAuthPriv = await db.query<{ allowed: boolean }>(`
      select has_function_privilege('authenticated', 'api.guard_sync_offline_registration(uuid, uuid, jsonb, text, timestamptz, uuid, integer, text, uuid, integer, text, text)', 'execute') as allowed;
    `);
    expect(regAuthPriv.rows[0]?.allowed).toBe(false);

    const regServicePriv = await db.query<{ allowed: boolean }>(`
      select has_function_privilege('service_role', 'api.guard_sync_offline_registration(uuid, uuid, jsonb, text, timestamptz, uuid, integer, text, uuid, integer, text, text)', 'execute') as allowed;
    `);
    expect(regServicePriv.rows[0]?.allowed).toBe(true);

    // Verify get_published_thermal_template privileges
    const templateAuthPriv = await db.query<{ allowed: boolean }>(`
      select has_function_privilege('authenticated', 'api.get_published_thermal_template()', 'execute') as allowed;
    `);
    expect(templateAuthPriv.rows[0]?.allowed).toBe(false);

    const templateServicePriv = await db.query<{ allowed: boolean }>(`
      select has_function_privilege('service_role', 'api.get_published_thermal_template()', 'execute') as allowed;
    `);
    expect(templateServicePriv.rows[0]?.allowed).toBe(true);
  }, 60000);

  it('Migration 38 & 39: verifies device_type guard_station enum, identity verification table, and visitor provenance columns', async () => {
    const db = new PGlite();
    await applyAllMigrations(db);

    // 1. Verify guard_station is in device_type enum
    const enumQuery = await db.query<{ enumlabel: string }>(`
      select enumlabel from pg_enum
      join pg_type on pg_enum.enumtypid = pg_type.oid
      where pg_type.typname = 'device_type';
    `);
    const labels = enumQuery.rows.map((r) => r.enumlabel);
    expect(labels).toContain('guard_station');
    expect(labels).toContain('kiosk');
    expect(labels).toContain('entry');
    expect(labels).toContain('exit');

    // 2. Verify portal_identity_verification_attempts table and RLS
    const tableCheck = await db.query<{ table_name: string }>(`
      select table_name from information_schema.tables
      where table_schema = 'public' and table_name = 'portal_identity_verification_attempts';
    `);
    expect(tableCheck.rows).toHaveLength(1);

    const rlsCheck = await db.query<{ rowsecurity: boolean }>(`
      select rowsecurity from pg_tables
      where schemaname = 'public' and tablename = 'portal_identity_verification_attempts';
    `);
    expect(rlsCheck.rows[0]?.rowsecurity).toBe(true);

    // Privileges: anon/authenticated cannot access, service_role can
    const anonPriv = await db.query<{ allowed: boolean }>(`
      select has_table_privilege('anon', 'public.portal_identity_verification_attempts', 'select') as allowed;
    `);
    expect(anonPriv.rows[0]?.allowed).toBe(false);

    const authPriv = await db.query<{ allowed: boolean }>(`
      select has_table_privilege('authenticated', 'public.portal_identity_verification_attempts', 'select') as allowed;
    `);
    expect(authPriv.rows[0]?.allowed).toBe(false);

    const servicePriv = await db.query<{ allowed: boolean }>(`
      select has_table_privilege('service_role', 'public.portal_identity_verification_attempts', 'select') as allowed;
    `);
    expect(servicePriv.rows[0]?.allowed).toBe(true);

    // 3. Verify visitors provenance columns
    const columns = await db.query<{ column_name: string }>(`
      select column_name from information_schema.columns
      where table_schema = 'public' and table_name = 'visitors'
      and column_name in ('identity_verification_id', 'identity_verified_at');
    `);
    expect(columns.rows).toHaveLength(2);
  }, 60000);
});
