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
    for (const file of files) {
      if (file.includes('001400') || file.includes('204805')) continue;
      let sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
      sql = sql.replace(/create extension if not exists pgcrypto[^;]*;/gi, '-- pgcrypto no-op');
      await db.exec(sql);
    }

    // Now apply 001400 closure migration
    const migration14 = files.find((f) => f.includes('001400'))!;
    let sql14 = readFileSync(join(MIGRATIONS_DIR, migration14), 'utf8');
    sql14 = sql14.replace(/create extension if not exists pgcrypto[^;]*;/gi, '-- pgcrypto no-op');
    await expect(db.exec(sql14)).resolves.toBeDefined();

    // Now apply new migration on top of 001400
    const newMigration = files.find((f) => f.includes('204805'))!;
    let sqlNew = readFileSync(join(MIGRATIONS_DIR, newMigration), 'utf8');
    sqlNew = sqlNew.replace(/create extension if not exists pgcrypto[^;]*;/gi, '-- pgcrypto no-op');
    await expect(db.exec(sqlNew)).resolves.toBeDefined();
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
    const anonQuery = await db.query<{ working_hours_start: string; visit_purposes: any }>(
      'select working_hours_start, working_hours_end, timezone, scheduling_days_ahead, peak_mode, visit_purposes from public.app_settings;'
    );
    expect(anonQuery.rows.length).toBe(1);
    expect(anonQuery.rows[0].working_hours_start).toBeDefined();

    // 2. Anon retention fields -> DENIED
    await expect(
      db.query('select automatic_cleanup_enabled from public.app_settings;')
    ).rejects.toThrow(/permission denied/);

    await expect(
      db.query('select image_retention_days from public.app_settings;')
    ).rejects.toThrow(/permission denied/);

    await expect(
      db.query('select visitor_retention_days from public.app_settings;')
    ).rejects.toThrow(/permission denied/);

    await expect(
      db.query('select reconciliation_retention_days from public.app_settings;')
    ).rejects.toThrow(/permission denied/);

    await expect(
      db.query('select audit_retention_days from public.app_settings;')
    ).rejects.toThrow(/permission denied/);

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
      'select working_hours_start, working_hours_end, timezone, scheduling_days_ahead, peak_mode, visit_purposes from public.app_settings;'
    );
    expect(authSafeQuery.rows.length).toBe(1);

    // 7. Authenticated role full select / retention columns -> DENIED (leak prevented)
    await expect(
      db.query('select * from public.app_settings;')
    ).rejects.toThrow(/permission denied/);

    await expect(
      db.query('select visitor_retention_days from public.app_settings;')
    ).rejects.toThrow(/permission denied/);

    await expect(
      db.query('select automatic_cleanup_enabled from public.app_settings;')
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
    const anonSettings = await db.query('select working_hours_start from public.app_settings;');
    expect(anonSettings.rows.length).toBe(1);
    await expect(db.query('select visitor_retention_days from public.app_settings;')).rejects.toThrow(/permission denied/);
    await db.exec('reset role;');

    // 2. Real Anonymous Portal visitor: is_anonymous = true
    await setSession(ANON_VISITOR_UID, ['anonymous']);
    const portalActorRes = await db.query('select * from api.current_actor();');
    expect(portalActorRes.rows.length).toBe(1);
    expect(portalActorRes.rows[0].actor_kind).toBe('visitor');
    // Can read safe settings columns only
    const visitorSettings = await db.query('select working_hours_start from public.app_settings;');
    expect(visitorSettings.rows.length).toBe(1);
    await expect(db.query('select * from public.app_settings;')).rejects.toThrow(/permission denied/);
    await expect(db.query('select visitor_retention_days from public.app_settings;')).rejects.toThrow(/permission denied/);
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

    // 10. RECOVERY SESSION STAFF ACTOR: Guard user with recovery AMR
    await setSession(GUARD_UID, ['recovery']);
    // Current staff role must resolve to NULL: api.current_actor() returns 0 rows!
    const recoveryActorRes = await db.query('select * from api.current_actor();');
    expect(recoveryActorRes.rows.length).toBe(0); // NO operational staff authority!
    // Cannot read operational RLS tables (e.g. devices)
    const devicesRead = await db.query('select * from public.devices;');
    expect(devicesRead.rows.length).toBe(0);
    await db.exec('reset role;');

    // Direct check of is_recovery_session under service_role
    await db.exec(`set request.jwt.claims = '{"sub": "${GUARD_UID}", "amr": [{"method": "recovery"}]}';`);
    const directRecCheck = await db.query('select private.is_recovery_session() as is_rec;');
    expect(directRecCheck.rows[0].is_rec).toBe(true);
    const directRoleCheck = await db.query('select private.current_staff_role() as role;');
    expect(directRoleCheck.rows[0].role).toBeNull();
  }, 30000);
});
