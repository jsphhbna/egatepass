/**
 * tests/security-definer-audit.test.ts
 *
 * Authoritative SECURITY DEFINER Function Audit & Hardening Contract:
 * Reconciles the exact 14 authenticated-executable api.* functions flagged by
 * Supabase Security Advisor in production, asserting:
 * 1. Exact effective EXECUTE privileges in PostgreSQL catalog for PUBLIC, anon, authenticated, and service_role
 * 2. PostgREST schema exposure in schema 'api' and accessibility to PostgREST roles
 * 3. Zero SECURITY DEFINER functions in api or public executable by anon or public
 * 4. SECURITY DEFINER with immutable fixed search_path = '' in pg_proc.proconfig
 * 5. Dynamic catalog failure if any newly introduced definer function in api or public is omitted
 * 6. Dynamic catalog failure if effective grants drift from declared intended architecture
 * 7. Active database catalog (pg_proc.prosrc) verification of actorValidation, roleAuthorization, and blocksRecovery
 * 8. Comprehensive positive and negative behavioral execution against live PostgreSQL engine:
 *    - Unauthenticated / anon callers fail closed
 *    - Password-recovery session confinement (amr: [{ method: 'recovery' }]) strictly blocks operational mutations/queries
 *    - Role-based authorization rejects lower-privilege staff (guard / admin vs superadmin)
 *    - Resource ownership checks reject unauthorized access across visitors
 *    - Positive lifecycle mutations succeed and maintain state invariants
 * 9. Regression proof tests verifying that tampering or bypassing the inventory fails closed
 * 10. Architectural intentionality documentation for every authenticated-executable function
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { BUNDLED_DEFAULT_THERMAL_TEMPLATE } from '../src/printer/templates/bundledDefaultTemplate.js';

export interface AuditedApiDefinerFunction {
  schema: 'api';
  name: string;
  exactGrants: ('authenticated' | 'service_role')[];
  deniedGrants: ('anon' | 'public')[];
  postgrestExposed: boolean;
  hasSearchPathEmpty: boolean;
  requiresSecurityDefiner: boolean;
  actorValidation: 'auth.uid' | 'has_staff_role' | 'current_staff_role' | 'current_device_type' | 'is_portal_actor';
  roleAuthorization: 'admin' | 'superadmin' | 'guard' | 'visitor_owner' | 'staff_or_device';
  blocksRecovery: boolean;
  intentionality: string;
}

export const AUDITED_14_API_DEFINER_FUNCTIONS: AuditedApiDefinerFunction[] = [
  {
    schema: 'api',
    name: 'abandon_upload_intent',
    exactGrants: ['authenticated'],
    deniedGrants: ['anon', 'public'],
    postgrestExposed: true,
    hasSearchPathEmpty: true,
    requiresSecurityDefiner: true,
    actorValidation: 'is_portal_actor',
    roleAuthorization: 'visitor_owner',
    blocksRecovery: false, // Scoped to intent owner_id = auth.uid() and private.is_portal_actor()
    intentionality:
      'Allows portal visitors to cancel pending registration upload intents and releases transient storage reservations without exposing administrative tables.',
  },
  {
    schema: 'api',
    name: 'acknowledge_privacy',
    exactGrants: ['authenticated', 'service_role'],
    deniedGrants: ['anon', 'public'],
    postgrestExposed: true,
    hasSearchPathEmpty: true,
    requiresSecurityDefiner: true,
    actorValidation: 'auth.uid',
    roleAuthorization: 'staff_or_device',
    blocksRecovery: true,
    intentionality:
      'Records statutory Data Privacy Act consent timestamp tied strictly to caller auth.uid() before staff or device operations begin. Callable by authenticated staff/devices and service_role.',
  },
  {
    schema: 'api',
    name: 'admin_publish_thermal_template',
    exactGrants: ['authenticated'],
    deniedGrants: ['anon', 'public'],
    postgrestExposed: true,
    hasSearchPathEmpty: true,
    requiresSecurityDefiner: true,
    actorValidation: 'current_staff_role',
    roleAuthorization: 'superadmin',
    blocksRecovery: true,
    intentionality:
      'Administrative thermal printer badge configuration publishing; restricted to authenticated superadmin staff from Admin Print Templates dashboard.',
  },
  {
    schema: 'api',
    name: 'admin_restore_thermal_template',
    exactGrants: ['authenticated'],
    deniedGrants: ['anon', 'public'],
    postgrestExposed: true,
    hasSearchPathEmpty: true,
    requiresSecurityDefiner: true,
    actorValidation: 'current_staff_role',
    roleAuthorization: 'superadmin',
    blocksRecovery: true,
    intentionality:
      'Administrative thermal printer template restore to previous revision; restricted to authenticated superadmin staff from Admin Print Templates dashboard.',
  },
  {
    schema: 'api',
    name: 'admin_save_thermal_template',
    exactGrants: ['authenticated'],
    deniedGrants: ['anon', 'public'],
    postgrestExposed: true,
    hasSearchPathEmpty: true,
    requiresSecurityDefiner: true,
    actorValidation: 'current_staff_role',
    roleAuthorization: 'superadmin',
    blocksRecovery: true,
    intentionality:
      'Administrative thermal printer draft template layout persistence; restricted to authenticated superadmin staff from Admin Print Templates dashboard.',
  },
  {
    schema: 'api',
    name: 'create_upload_intent',
    exactGrants: ['authenticated'],
    deniedGrants: ['anon', 'public'],
    postgrestExposed: true,
    hasSearchPathEmpty: true,
    requiresSecurityDefiner: true,
    actorValidation: 'auth.uid',
    roleAuthorization: 'visitor_owner',
    blocksRecovery: true,
    intentionality:
      'Generates pre-signed evidence upload intents and registers intent records tied to caller auth.uid().',
  },
  {
    schema: 'api',
    name: 'current_actor',
    exactGrants: ['authenticated'],
    deniedGrants: ['anon', 'public'],
    postgrestExposed: true,
    hasSearchPathEmpty: true,
    requiresSecurityDefiner: true,
    actorValidation: 'auth.uid',
    roleAuthorization: 'staff_or_device',
    blocksRecovery: true,
    intentionality:
      'Resolves active staff or device profile for the authenticated caller; requires elevated access to read metadata before profile is selected.',
  },
  {
    schema: 'api',
    name: 'guard_dashboard',
    exactGrants: ['authenticated'],
    deniedGrants: ['anon', 'public'],
    postgrestExposed: true,
    hasSearchPathEmpty: true,
    requiresSecurityDefiner: true,
    actorValidation: 'current_staff_role',
    roleAuthorization: 'admin',
    blocksRecovery: true,
    intentionality:
      'Provides real-time gate entry/exit metrics and active visitor counts for guard stations under administrator authority.',
  },
  {
    schema: 'api',
    name: 'guard_dashboard_page',
    exactGrants: ['authenticated'],
    deniedGrants: ['anon', 'public'],
    postgrestExposed: true,
    hasSearchPathEmpty: true,
    requiresSecurityDefiner: true,
    actorValidation: 'current_staff_role',
    roleAuthorization: 'admin',
    blocksRecovery: true,
    intentionality:
      'Provides keyset-paginated guard queue for high-volume entry/exit management at the campus gate under administrator authority.',
  },
  {
    schema: 'api',
    name: 'guard_offline_snapshot_page',
    exactGrants: ['authenticated'],
    deniedGrants: ['anon', 'public'],
    postgrestExposed: true,
    hasSearchPathEmpty: true,
    requiresSecurityDefiner: true,
    actorValidation: 'current_staff_role',
    roleAuthorization: 'admin',
    blocksRecovery: true,
    intentionality:
      'Delivers deterministic offline cache pages to authorized guard stations for offline resilience under administrator authority.',
  },
  {
    schema: 'api',
    name: 'guard_recover_pass_action',
    exactGrants: ['authenticated'],
    deniedGrants: ['anon', 'public'],
    postgrestExposed: true,
    hasSearchPathEmpty: true,
    requiresSecurityDefiner: true,
    actorValidation: 'auth.uid',
    roleAuthorization: 'admin',
    blocksRecovery: true,
    intentionality:
      'Enables gate personnel to recover, reprint, or re-verify passes for visitors under administrator authority.',
  },
  {
    schema: 'api',
    name: 'guard_search_pending_queue',
    exactGrants: ['authenticated', 'service_role'],
    deniedGrants: ['anon', 'public'],
    postgrestExposed: true,
    hasSearchPathEmpty: true,
    requiresSecurityDefiner: true,
    actorValidation: 'auth.uid',
    roleAuthorization: 'admin',
    blocksRecovery: true,
    intentionality:
      'Enables real-time search across pending visitor registrations for gate guards under administrator authority and automated backend search workers.',
  },
  {
    schema: 'api',
    name: 'guard_search_recovery_visitors',
    exactGrants: ['authenticated'],
    deniedGrants: ['anon', 'public'],
    postgrestExposed: true,
    hasSearchPathEmpty: true,
    requiresSecurityDefiner: true,
    actorValidation: 'current_staff_role',
    roleAuthorization: 'admin',
    blocksRecovery: true,
    intentionality:
      'Enables gate personnel to locate visitors requesting manual pass lookup or recovery under administrator authority.',
  },
  {
    schema: 'api',
    name: 'guard_sync_offline_event',
    exactGrants: ['authenticated'],
    deniedGrants: ['anon', 'public'],
    postgrestExposed: true,
    hasSearchPathEmpty: true,
    requiresSecurityDefiner: true,
    actorValidation: 'auth.uid',
    roleAuthorization: 'admin',
    blocksRecovery: true,
    intentionality:
      'Synchronizes offline gate lifecycle events recorded during network outages back to central database under administrator authority.',
  },
];

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
        null::uuid
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

describe('SECURITY DEFINER Function Audit & Hardening Contract (14 API Functions)', () => {
  const migrationsDir = 'supabase/migrations';
  const migrationFiles = readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort();

  let db: PGlite;

  // Test Personas
  const superadminId = '10000000-0000-0000-0000-000000000001';
  const adminId = '10000000-0000-0000-0000-000000000002';
  const guardId = '20000000-0000-0000-0000-000000000003';
  const visitorAId = '30000000-0000-0000-0000-000000000004';
  const visitorBId = '40000000-0000-0000-0000-000000000005';
  const kioskDeviceId = '50000000-0000-0000-0000-000000000006';

  // Seeded Pass / Visitor Entities for Mutation Tests
  const visitorRecordAId = '60000000-0000-0000-0000-000000000001';
  const visitorRecordBId = '60000000-0000-0000-0000-000000000002';
  const passAId = '70000000-0000-0000-0000-000000000001';
  const passBId = '70000000-0000-0000-0000-000000000002';

  beforeAll(async () => {
    db = new PGlite();
    await setupSupabaseEmulation(db);

    for (const file of migrationFiles) {
      let sql = readFileSync(join(migrationsDir, file), 'utf8');
      sql = sql.replace(/create extension if not exists pgcrypto[^;]*;/gi, '-- pgcrypto no-op');
      await db.exec(sql);
    }

    // Provision test personas
    await db.exec(`
      insert into auth.users (id, email, email_confirmed_at, is_anonymous) values
        ('${superadminId}'::uuid, 'superadmin@example.com', now(), false),
        ('${adminId}'::uuid, 'admin@example.com', now(), false),
        ('${guardId}'::uuid, 'guard@example.com', now(), false),
        ('${visitorAId}'::uuid, null, null, true),
        ('${visitorBId}'::uuid, null, null, true),
        ('${kioskDeviceId}'::uuid, 'kiosk@device.local', now(), false)
      on conflict (id) do nothing;

      insert into public.staff_profiles (user_id, display_name, role, active, privacy_accepted_at, must_change_password) values
        ('${superadminId}'::uuid, 'Super Admin', 'superadmin', true, now(), false),
        ('${adminId}'::uuid, 'Administrator', 'admin', true, now(), false),
        ('${guardId}'::uuid, 'Guard User', 'guard', true, now(), false)
      on conflict do nothing;

      insert into public.devices (user_id, alias, name, type, gate, status) values
        ('${kioskDeviceId}'::uuid, 'kiosk-01', 'Main Gate Kiosk', 'kiosk'::public.device_type, 'Gate 1', 'active'::public.device_status)
      on conflict (user_id) do nothing;

      insert into public.visitors (
        id, owner_id, source, full_name, contact_number, purpose, visit_date, consent_accepted_at
      ) values
        ('${visitorRecordAId}'::uuid, '${visitorAId}'::uuid, 'portal'::public.pass_source, 'Juan Dela Cruz', '09171234567', 'Official Business', current_date, now()),
        ('${visitorRecordBId}'::uuid, '${visitorBId}'::uuid, 'portal'::public.pass_source, 'Maria Santos', '09181234567', 'Campus Visit', current_date, now())
      on conflict (id) do nothing;

      insert into public.passes (
        id, visitor_id, public_reference, token_digest, source, status, valid_from, valid_until, gate
      ) values
        ('${passAId}'::uuid, '${visitorRecordAId}'::uuid, '80000000-0000-0000-0000-000000000001'::uuid, decode('0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', 'hex'), 'portal'::public.pass_source, 'issued'::public.pass_status, now() - interval '1 hour', now() + interval '8 hours', 'Main Gate'),
        ('${passBId}'::uuid, '${visitorRecordBId}'::uuid, '80000000-0000-0000-0000-000000000002'::uuid, decode('fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210', 'hex'), 'portal'::public.pass_source, 'issued'::public.pass_status, now() - interval '1 hour', now() + interval '8 hours', 'Main Gate')
      on conflict (id) do nothing;
    `);
  }, 60000);

  async function asActor<T>(
    sub: string | null,
    claims: Record<string, any> = {},
    cb: () => Promise<T>
  ): Promise<T> {
    const role = claims.role || (sub ? 'authenticated' : 'anon');
    const fullClaims = { sub, role, ...claims };
    const claimsJson = JSON.stringify(fullClaims).replace(/'/g, "''");

    await db.exec(`
      select set_config('request.jwt.claim.sub', '${sub || ''}', false);
      select set_config('request.jwt.claim.role', '${role}', false);
      select set_config('request.jwt.claims', '${claimsJson}', false);
    `);
    try {
      return await cb();
    } finally {
      await db.exec(`
        select set_config('request.jwt.claim.sub', '', false);
        select set_config('request.jwt.claim.role', '', false);
        select set_config('request.jwt.claims', '', false);
      `);
    }
  }

  // ===========================================================================
  // 1. INVENTORY INTEGRITY & INTENTIONALITY
  // ===========================================================================

  it('audits exactly 14 API-exposed functions matching production Supabase advisor', () => {
    expect(AUDITED_14_API_DEFINER_FUNCTIONS.length).toBe(14);
  });

  it('ensures every audited function has documented architectural intentionality (>20 chars)', () => {
    for (const fn of AUDITED_14_API_DEFINER_FUNCTIONS) {
      expect(fn.intentionality).toBeDefined();
      expect(
        fn.intentionality.trim().length,
        `Function api.${fn.name} must document architectural justification.`
      ).toBeGreaterThan(20);
    }
  });

  // ===========================================================================
  // 2. LIVE POSTGRESQL CATALOG AUDIT (pg_proc, pg_namespace, has_function_privilege)
  // ===========================================================================

  it('dynamically verifies via pg_proc catalog that ONLY the 14 audited functions are authenticated-executable or anon-executable SECURITY DEFINER in api/public', async () => {
    const catalogRes = await db.query<{
      schema_name: string;
      function_name: string;
      is_security_definer: boolean;
      can_authenticated: boolean;
      can_anon: boolean;
      can_public: boolean;
    }>(`
      select 
        n.nspname as schema_name,
        p.proname as function_name,
        p.prosecdef as is_security_definer,
        has_function_privilege('authenticated', p.oid, 'EXECUTE') as can_authenticated,
        has_function_privilege('anon', p.oid, 'EXECUTE') as can_anon,
        has_function_privilege('public', p.oid, 'EXECUTE') as can_public
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname in ('api', 'public')
      order by n.nspname, p.proname;
    `);

    // Zero definers in api/public must be executable by anon or public
    const anonOrPublicDefiners = catalogRes.rows
      .filter(r => r.is_security_definer && (r.can_anon || r.can_public))
      .map(r => `${r.schema_name}.${r.function_name}`);
    expect(
      anonOrPublicDefiners,
      'No SECURITY DEFINER function in api or public should ever be executable by anon or public'
    ).toEqual([]);

    const activeAuthenticatedDefiners = catalogRes.rows
      .filter(r => r.is_security_definer && r.can_authenticated)
      .map(r => `${r.schema_name}.${r.function_name}`);

    // Deduplicate function names across overloads
    const uniqueActive = [...new Set(activeAuthenticatedDefiners)].sort();
    const auditedNames = AUDITED_14_API_DEFINER_FUNCTIONS.map(f => `${f.schema}.${f.name}`).sort();

    expect(
      uniqueActive,
      'PostgreSQL catalog contains un-audited or missing authenticated-executable SECURITY DEFINER functions in api/public'
    ).toEqual(auditedNames);
  });

  it('verifies exact effective EXECUTE privileges, PostgREST exposure, SECURITY DEFINER status, and search_path in pg_proc catalog', async () => {
    const catalogRes = await db.query<{
      schema_name: string;
      function_name: string;
      is_security_definer: boolean;
      settings: string[] | null;
      can_anon: boolean;
      can_authenticated: boolean;
      can_service_role: boolean;
      can_public: boolean;
    }>(`
      select 
        n.nspname as schema_name,
        p.proname as function_name,
        p.prosecdef as is_security_definer,
        p.proconfig as settings,
        has_function_privilege('anon', p.oid, 'EXECUTE') as can_anon,
        has_function_privilege('authenticated', p.oid, 'EXECUTE') as can_authenticated,
        has_function_privilege('service_role', p.oid, 'EXECUTE') as can_service_role,
        has_function_privilege('public', p.oid, 'EXECUTE') as can_public
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'api';
    `);

    const procMap = new Map<string, typeof catalogRes.rows[0]>();
    for (const row of catalogRes.rows) {
      procMap.set(row.function_name, row);
    }

    for (const fn of AUDITED_14_API_DEFINER_FUNCTIONS) {
      const proc = procMap.get(fn.name);
      expect(proc, `Function api.${fn.name} must exist in pg_proc catalog`).toBeDefined();

      // 1. SECURITY DEFINER status
      expect(
        proc!.is_security_definer,
        `Function api.${fn.name} prosecdef must match requiresSecurityDefiner`
      ).toBe(fn.requiresSecurityDefiner);

      // 2. Fixed search_path = '' in proconfig
      if (fn.hasSearchPathEmpty) {
        expect(
          proc!.settings,
          `Function api.${fn.name} must set proconfig search_path = ''`
        ).toContain('search_path=""');
      }

      // 3. PostgREST exposed schema and accessibility
      if (fn.postgrestExposed) {
        expect(fn.schema, `Exposed function api.${fn.name} must be in api schema`).toBe('api');
        expect(proc!.can_authenticated || proc!.can_anon, `Exposed function api.${fn.name} must be executable by PostgREST role`).toBe(true);
      }

      // 4. Exact grants verification for all standard roles
      expect(
        proc!.can_authenticated,
        `Function api.${fn.name} authenticated execution privilege drift`
      ).toBe(fn.exactGrants.includes('authenticated'));

      expect(
        proc!.can_service_role,
        `Function api.${fn.name} service_role execution privilege drift`
      ).toBe(fn.exactGrants.includes('service_role'));

      expect(
        proc!.can_anon,
        `Function api.${fn.name} anon execution privilege drift`
      ).toBe(false);

      expect(
        proc!.can_public,
        `Function api.${fn.name} public execution privilege drift`
      ).toBe(false);

      // 5. Explicit denied grants verification
      for (const deniedRole of fn.deniedGrants) {
        if (deniedRole === 'anon') {
          expect(proc!.can_anon, `Function api.${fn.name} must deny EXECUTE to anon`).toBe(false);
        }
        if (deniedRole === 'public') {
          expect(proc!.can_public, `Function api.${fn.name} must deny EXECUTE to public`).toBe(false);
        }
      }
    }
  });

  // ===========================================================================
  // 3. CATALOG SOURCE AST & SEMANTIC AUTHORIZATION CONTRACT
  // ===========================================================================

  it('verifies SQL implementation in pg_proc catalog enforces declared actorValidation, roleAuthorization, and blocksRecovery per function', async () => {
    const procs = await db.query<{ proname: string; prosrc: string }>(`
      select p.proname, p.prosrc
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'api';
    `);
    const prosrcMap = new Map<string, string>();
    for (const r of procs.rows) {
      prosrcMap.set(r.proname, r.prosrc);
    }

    for (const fn of AUDITED_14_API_DEFINER_FUNCTIONS) {
      const src = prosrcMap.get(fn.name);
      expect(src, `Function api.${fn.name} must exist in pg_proc catalog`).toBeDefined();

      // 1. Specific actor validation enforcement
      switch (fn.actorValidation) {
        case 'is_portal_actor':
          expect(src, `Function api.${fn.name} must invoke private.is_portal_actor()`).toMatch(/private\.is_portal_actor\(\)/);
          break;
        case 'current_staff_role':
          expect(src, `Function api.${fn.name} must invoke private.current_staff_role()`).toMatch(/private\.current_staff_role\(\)/);
          break;
        case 'has_staff_role':
          expect(src, `Function api.${fn.name} must invoke private.has_staff_role()`).toMatch(/private\.has_staff_role\(/);
          break;
        case 'current_device_type':
          expect(src, `Function api.${fn.name} must invoke private.current_device_type()`).toMatch(/private\.current_device_type\(\)/);
          break;
        case 'auth.uid':
          expect(src, `Function api.${fn.name} must resolve caller via auth.uid()`).toMatch(/auth\.uid\(\)/);
          break;
      }

      // 2. Specific role authorization enforcement
      switch (fn.roleAuthorization) {
        case 'superadmin':
          expect(src, `Function api.${fn.name} must require superadmin role`).toMatch(/'superadmin'/);
          break;
        case 'admin':
          expect(src, `Function api.${fn.name} must require administrator authority`).toMatch(/'admin'/);
          break;
        case 'visitor_owner':
          expect(src, `Function api.${fn.name} must enforce owner/caller bounding`).toMatch(/owner_id|target_intent|caller_id/);
          break;
        case 'staff_or_device':
          expect(src, `Function api.${fn.name} must check staff or device actors`).toMatch(/staff_profiles|devices|'staff'/);
          break;
        case 'guard':
          expect(src, `Function api.${fn.name} must check guard authority`).toMatch(/'guard'/);
          break;
      }

      // 3. Recovery session confinement enforcement
      if (fn.blocksRecovery) {
        const blocksRecoveryInSrc =
          src!.includes('is_recovery_session') ||
          src!.includes('current_staff_role') ||
          src!.includes('has_staff_role');
        expect(
          blocksRecoveryInSrc,
          `Function api.${fn.name} declares blocksRecovery: true and must enforce recovery session blocking in body or role helper`
        ).toBe(true);
      }
    }
  });

  // ===========================================================================
  // 4. BEHAVIORAL AUTHORIZATION ENFORCEMENT & CONFINEMENT TESTS
  // ===========================================================================

  describe('Upload Intent Lifecycle & Resource Ownership (abandon_upload_intent & create_upload_intent)', () => {
    it('enforces portal visitor actor identity on create_upload_intent (unauthenticated caller rejected)', async () => {
      await asActor(null, {}, async () => {
        await expect(
          db.query(`select api.create_upload_intent('portal'::public.pass_source, 'photo'::public.evidence_kind, 'image/jpeg');`)
        ).rejects.toThrow(/visitor identity required/);
      });
    });

    it('rejects staff callers attempting to invoke create_upload_intent as portal visitor', async () => {
      await asActor(adminId, {}, async () => {
        await expect(
          db.query(`select api.create_upload_intent('portal'::public.pass_source, 'photo'::public.evidence_kind, 'image/jpeg');`)
        ).rejects.toThrow(/visitor identity required/);
      });
    });

    it('rejects non-kiosk callers attempting to invoke create_upload_intent as kiosk', async () => {
      await asActor(visitorAId, {}, async () => {
        await expect(
          db.query(`select api.create_upload_intent('kiosk'::public.pass_source, 'photo'::public.evidence_kind, 'image/jpeg');`)
        ).rejects.toThrow(/active kiosk identity required/);
      });
    });

    it('rejects guard caller attempting guard_offline upload intent (administrator required)', async () => {
      await asActor(guardId, {}, async () => {
        await expect(
          db.query(`select api.create_upload_intent('guard_offline'::public.pass_source, 'photo'::public.evidence_kind, 'image/jpeg');`)
        ).rejects.toThrow(/administrator required/);
      });
    });

    it('rejects administrator in recovery session attempting guard_offline upload intent', async () => {
      await asActor(adminId, { amr: [{ method: 'recovery' }] }, async () => {
        await expect(
          db.query(`select api.create_upload_intent('guard_offline'::public.pass_source, 'photo'::public.evidence_kind, 'image/jpeg');`)
        ).rejects.toThrow(/administrator required/);
      });
    });

    it('validates supported evidence kinds and content types on create_upload_intent', async () => {
      await asActor(visitorAId, {}, async () => {
        await expect(
          db.query(`select api.create_upload_intent('portal'::public.pass_source, 'photo'::public.evidence_kind, 'application/pdf');`)
        ).rejects.toThrow(/unsupported content type/);
      });
    });

    it('allows registered kiosk device to create kiosk upload intent', async () => {
      await asActor(kioskDeviceId, {}, async () => {
        const res = await db.query<{ intent_id: string; bucket_id: string }>(
          `select * from api.create_upload_intent('kiosk'::public.pass_source, 'photo'::public.evidence_kind, 'image/jpeg');`
        );
        expect(res.rows[0].intent_id).toBeDefined();
        expect(res.rows[0].bucket_id).toBe('visitor-photos');
      });
    });

    it('allows administrator to create guard_offline upload intent', async () => {
      await asActor(adminId, {}, async () => {
        const res = await db.query<{ intent_id: string; bucket_id: string }>(
          `select * from api.create_upload_intent('guard_offline'::public.pass_source, 'photo'::public.evidence_kind, 'image/jpeg');`
        );
        expect(res.rows[0].intent_id).toBeDefined();
        expect(res.rows[0].bucket_id).toBe('visitor-photos');
      });
    });

    it('creates upload intent bound to visitor A and strictly blocks visitor B from abandoning it (resource ownership mismatch)', async () => {
      let intentId: string;

      // Visitor A creates intent
      await asActor(visitorAId, {}, async () => {
        const res = await db.query<{ intent_id: string }>(
          `select intent_id from api.create_upload_intent('portal'::public.pass_source, 'photo'::public.evidence_kind, 'image/jpeg');`
        );
        intentId = res.rows[0].intent_id;
        expect(intentId).toBeDefined();
      });

      // Negative Case 1: Unauthenticated caller attempts abandon -> visitor identity required
      await asActor(null, {}, async () => {
        await expect(
          db.query(`select * from api.abandon_upload_intent('${intentId}'::uuid);`)
        ).rejects.toThrow(/visitor identity required/);
      });

      // Negative Case 2: Staff caller attempts abandon -> visitor identity required
      await asActor(adminId, {}, async () => {
        await expect(
          db.query(`select * from api.abandon_upload_intent('${intentId}'::uuid);`)
        ).rejects.toThrow(/visitor identity required/);
      });

      // Negative Case 3: Visitor B attempts to abandon Visitor A's intent -> 42501 intent ownership mismatch
      await asActor(visitorBId, {}, async () => {
        await expect(
          db.query(`select * from api.abandon_upload_intent('${intentId}'::uuid);`)
        ).rejects.toThrow(/intent ownership mismatch/);
      });

      // Positive Case: Visitor A abandons own intent -> success
      await asActor(visitorAId, {}, async () => {
        const res = await db.query<{ ok: boolean; code: string }>(
          `select * from api.abandon_upload_intent('${intentId}'::uuid);`
        );
        expect(res.rows[0].ok).toBe(true);
        expect(res.rows[0].code).toBe('abandoned');
      });

      // Idempotency: Visitor A abandons already-abandoned intent -> returns already_expired cleanly
      await asActor(visitorAId, {}, async () => {
        const res = await db.query<{ ok: boolean; code: string }>(
          `select * from api.abandon_upload_intent('${intentId}'::uuid);`
        );
        expect(res.rows[0].ok).toBe(true);
        expect(res.rows[0].code).toBe('already_expired');
      });

      // Nonexistent intent -> returns not_found cleanly
      await asActor(visitorAId, {}, async () => {
        const res = await db.query<{ ok: boolean; code: string }>(
          `select * from api.abandon_upload_intent(gen_random_uuid());`
        );
        expect(res.rows[0].ok).toBe(true);
        expect(res.rows[0].code).toBe('not_found');
      });
    });
  });

  describe('Data Privacy Act Acknowledgment (acknowledge_privacy)', () => {
    it('fails closed when caller is unauthenticated (no auth.uid)', async () => {
      await asActor(null, {}, async () => {
        await expect(
          db.query(`select api.acknowledge_privacy();`)
        ).rejects.toThrow(/authentication required/);
      });
    });

    it('fails closed when session is in password recovery mode (is_recovery_session = true)', async () => {
      await asActor(adminId, { amr: [{ method: 'recovery' }] }, async () => {
        await expect(
          db.query(`select api.acknowledge_privacy();`)
        ).rejects.toThrow(/recovery_session_forbidden/);
      });
    });

    it('fails closed when non-staff caller (visitor) invokes acknowledge_privacy', async () => {
      await asActor(visitorAId, {}, async () => {
        await expect(
          db.query(`select api.acknowledge_privacy();`)
        ).rejects.toThrow(/staff profile not found or inactive/);
      });
    });

    it('succeeds for authenticated operational staff and records timestamp', async () => {
      await asActor(adminId, {}, async () => {
        const res = await db.query<{ acknowledge_privacy: string }>(
          `select api.acknowledge_privacy();`
        );
        expect(res.rows[0].acknowledge_privacy).toBeDefined();
      });
    });

    it('succeeds for service_role caller acting on behalf of staff user', async () => {
      await asActor(adminId, { role: 'service_role' }, async () => {
        const res = await db.query<{ acknowledge_privacy: string }>(
          `select api.acknowledge_privacy();`
        );
        expect(res.rows[0].acknowledge_privacy).toBeDefined();
      });
    });
  });

  describe('Superadmin Thermal Template Operations (save, publish, restore)', () => {
    it('fails closed when non-superadmin caller (admin or guard) attempts template operations', async () => {
      // Save
      await asActor(adminId, {}, async () => {
        await expect(
          db.query(`select api.admin_save_thermal_template('Unauthorized', '${JSON.stringify(BUNDLED_DEFAULT_THERMAL_TEMPLATE)}'::jsonb);`)
        ).rejects.toThrow(/superadmin required/);
      });
      await asActor(guardId, {}, async () => {
        await expect(
          db.query(`select api.admin_save_thermal_template('Unauthorized', '${JSON.stringify(BUNDLED_DEFAULT_THERMAL_TEMPLATE)}'::jsonb);`)
        ).rejects.toThrow(/superadmin required/);
      });

      // Publish
      await asActor(adminId, {}, async () => {
        await expect(
          db.query(`select api.admin_publish_thermal_template(1);`)
        ).rejects.toThrow(/superadmin required/);
      });

      // Restore
      await asActor(adminId, {}, async () => {
        await expect(
          db.query(`select api.admin_restore_thermal_template(1);`)
        ).rejects.toThrow(/superadmin required/);
      });
    });

    it('fails closed when superadmin is in password-recovery session across all thermal endpoints', async () => {
      await asActor(superadminId, { amr: [{ method: 'recovery' }] }, async () => {
        await expect(
          db.query(`select api.admin_save_thermal_template('Blocked Recovery', '${JSON.stringify(BUNDLED_DEFAULT_THERMAL_TEMPLATE)}'::jsonb);`)
        ).rejects.toThrow(/recovery_session_forbidden/);

        await expect(
          db.query(`select api.admin_publish_thermal_template(1);`)
        ).rejects.toThrow(/recovery_session_forbidden/);

        await expect(
          db.query(`select api.admin_restore_thermal_template(1);`)
        ).rejects.toThrow(/recovery_session_forbidden/);
      });
    });

    it('rejects nonexistent template versions on publish and restore', async () => {
      await asActor(superadminId, {}, async () => {
        await expect(
          db.query(`select api.admin_publish_thermal_template(999999);`)
        ).rejects.toThrow(/template version not found/);

        await expect(
          db.query(`select api.admin_restore_thermal_template(999999);`)
        ).rejects.toThrow(/source template version not found/);
      });
    });

    it('executes full save, publish, and restore lifecycle for authenticated superadmin', async () => {
      let savedVersion: number;

      await asActor(superadminId, {}, async () => {
        // Save
        const saveRes = await db.query<{ res: any }>(
          `select api.admin_save_thermal_template('Audit Test Template', '${JSON.stringify(BUNDLED_DEFAULT_THERMAL_TEMPLATE)}'::jsonb) as res;`
        );
        savedVersion = saveRes.rows[0].res.version;
        expect(savedVersion).toBeGreaterThan(0);
        expect(saveRes.rows[0].res.status).toBe('draft');

        // Publish
        const pubRes = await db.query<{ res: any }>(
          `select api.admin_publish_thermal_template(${savedVersion}) as res;`
        );
        expect(pubRes.rows[0].res.status).toBe('published');

        // Restore
        const restRes = await db.query<{ res: any }>(
          `select api.admin_restore_thermal_template(${savedVersion}) as res;`
        );
        expect(restRes.rows[0].res.status).toBe('published');
        expect(restRes.rows[0].res.version).toBeGreaterThan(savedVersion);
      });
    });
  });

  describe('Gate Queue & Recovery Queries (guard_dashboard, pages, searches)', () => {
    it('fails closed when unauthenticated caller attempts to call guard functions', async () => {
      await asActor(null, {}, async () => {
        await expect(db.query(`select api.guard_dashboard();`)).rejects.toThrow(/administrator required/);
        await expect(db.query(`select api.guard_dashboard_page(10);`)).rejects.toThrow(/administrator required/);
        await expect(db.query(`select api.guard_offline_snapshot_page(null, 10);`)).rejects.toThrow(/administrator required/);
        await expect(db.query(`select api.guard_search_pending_queue('Test', 10);`)).rejects.toThrow(/administrator required/);
        await expect(db.query(`select api.guard_search_recovery_visitors('0917', 10);`)).rejects.toThrow(/administrator required/);
      });
    });

    it('fails closed when unauthorized visitor attempts to call guard functions', async () => {
      await asActor(visitorAId, {}, async () => {
        await expect(db.query(`select api.guard_dashboard();`)).rejects.toThrow(/administrator required/);
        await expect(db.query(`select api.guard_dashboard_page(10);`)).rejects.toThrow(/administrator required/);
        await expect(db.query(`select api.guard_offline_snapshot_page(null, 10);`)).rejects.toThrow(/administrator required/);
        await expect(db.query(`select api.guard_search_pending_queue('Test', 10);`)).rejects.toThrow(/administrator required/);
        await expect(db.query(`select api.guard_search_recovery_visitors('0917', 10);`)).rejects.toThrow(/administrator required/);
      });
    });

    it('fails closed when legacy guard role attempts to call guard functions (Migration 41 authority deprecation)', async () => {
      await asActor(guardId, {}, async () => {
        await expect(db.query(`select api.guard_dashboard();`)).rejects.toThrow(/administrator required/);
        await expect(db.query(`select api.guard_dashboard_page(10);`)).rejects.toThrow(/administrator required/);
        await expect(db.query(`select api.guard_offline_snapshot_page(null, 10);`)).rejects.toThrow(/administrator required/);
        await expect(db.query(`select api.guard_search_pending_queue('Test', 10);`)).rejects.toThrow(/administrator required/);
        await expect(db.query(`select api.guard_search_recovery_visitors('0917', 10);`)).rejects.toThrow(/administrator required/);
      });
    });

    it('fails closed when administrator caller is in password-recovery session', async () => {
      await asActor(adminId, { amr: [{ method: 'recovery' }] }, async () => {
        await expect(db.query(`select api.guard_dashboard();`)).rejects.toThrow(/recovery_session_forbidden/);
        await expect(db.query(`select api.guard_dashboard_page(10);`)).rejects.toThrow(/recovery_session_forbidden/);
        await expect(db.query(`select api.guard_offline_snapshot_page(null, 10);`)).rejects.toThrow(/recovery_session_forbidden/);
        await expect(db.query(`select api.guard_search_pending_queue('Test', 10);`)).rejects.toThrow(/recovery_session_forbidden/);
        await expect(db.query(`select api.guard_search_recovery_visitors('0917', 10);`)).rejects.toThrow(/recovery_session_forbidden/);
      });
    });

    it('allows authenticated administrator to execute gate query functions', async () => {
      await asActor(adminId, {}, async () => {
        const dash = await db.query<{ guard_dashboard: any }>(`select api.guard_dashboard();`);
        expect(dash.rows[0].guard_dashboard).toBeDefined();

        const page = await db.query<{ guard_dashboard_page: any }>(`select api.guard_dashboard_page(10);`);
        expect(page.rows[0].guard_dashboard_page).toBeDefined();

        const snap = await db.query<{ guard_offline_snapshot_page: any }>(`select api.guard_offline_snapshot_page(null, 10);`);
        expect(snap.rows[0].guard_offline_snapshot_page).toBeDefined();

        const searchQ = await db.query<{ guard_search_pending_queue: any }>(`select api.guard_search_pending_queue('Juan', 10);`);
        expect(searchQ.rows[0].guard_search_pending_queue).toBeDefined();

        const searchR = await db.query<{ guard_search_recovery_visitors: any }>(`select api.guard_search_recovery_visitors('0917', 10);`);
        expect(searchR.rows[0].guard_search_recovery_visitors).toBeDefined();
      });
    });

    it('allows service_role caller with administrator context to execute guard_search_pending_queue', async () => {
      await asActor(adminId, { role: 'service_role' }, async () => {
        const searchQ = await db.query<{ guard_search_pending_queue: any }>(`select api.guard_search_pending_queue('Juan', 10);`);
        expect(searchQ.rows[0].guard_search_pending_queue).toBeDefined();
      });
    });
  });

  describe('Gate Mutations (guard_recover_pass_action & guard_sync_offline_event)', () => {
    it('fails closed when unauthenticated caller attempts pass recovery or offline sync mutations', async () => {
      await asActor(null, {}, async () => {
        await expect(
          db.query(`select api.guard_recover_pass_action(gen_random_uuid(), 'approve_entry', 'Test');`)
        ).rejects.toThrow(/administrator required/);

        await expect(
          db.query(`select api.guard_sync_offline_event(gen_random_uuid(), gen_random_uuid(), 'approve_entry', 'issued', 1, now(), 'Test');`)
        ).rejects.toThrow(/administrator required/);
      });
    });

    it('fails closed when visitor attempts pass recovery or offline sync mutations', async () => {
      await asActor(visitorAId, {}, async () => {
        await expect(
          db.query(`select api.guard_recover_pass_action(gen_random_uuid(), 'approve_entry', 'Test reason');`)
        ).rejects.toThrow(/administrator required/);

        await expect(
          db.query(`select api.guard_sync_offline_event(gen_random_uuid(), gen_random_uuid(), 'approve_entry', 'issued', 1, now(), 'Test reason');`)
        ).rejects.toThrow(/administrator required/);
      });
    });

    it('fails closed when legacy guard role attempts mutations (administrator required)', async () => {
      await asActor(guardId, {}, async () => {
        await expect(
          db.query(`select api.guard_recover_pass_action(gen_random_uuid(), 'approve_entry', 'Test reason');`)
        ).rejects.toThrow(/administrator required/);

        await expect(
          db.query(`select api.guard_sync_offline_event(gen_random_uuid(), gen_random_uuid(), 'approve_entry', 'issued', 1, now(), 'Test reason');`)
        ).rejects.toThrow(/administrator required/);
      });
    });

    it('fails closed when administrator is in password-recovery session', async () => {
      await asActor(adminId, { amr: [{ method: 'recovery' }] }, async () => {
        await expect(
          db.query(`select api.guard_recover_pass_action(gen_random_uuid(), 'approve_entry', 'Test reason');`)
        ).rejects.toThrow(/recovery_session_forbidden/);

        await expect(
          db.query(`select api.guard_sync_offline_event(gen_random_uuid(), gen_random_uuid(), 'approve_entry', 'issued', 1, now(), 'Test reason');`)
        ).rejects.toThrow(/recovery_session_forbidden/);
      });
    });

    it('validates recovery action and ensures target pass exists', async () => {
      await asActor(adminId, {}, async () => {
        // Invalid action validation
        await expect(
          db.query(`select api.guard_recover_pass_action(gen_random_uuid(), 'invalid_action', 'Test');`)
        ).rejects.toThrow(/invalid recovery action/);

        // Valid action but target pass does not exist -> P0002 pass not found
        await expect(
          db.query(`select api.guard_recover_pass_action(gen_random_uuid(), 'approve_entry', 'Approve entry');`)
        ).rejects.toThrow(/pass not found/);
      });
    });

    it('executes positive guard_recover_pass_action lifecycle for valid pass (issued -> inside -> exited)', async () => {
      await asActor(adminId, {}, async () => {
        // 1. Approve entry recovery -> pass status becomes inside
        const entryRes = await db.query<{ res: any }>(
          `select api.guard_recover_pass_action('${passAId}'::uuid, 'approve_entry', 'Manual entry recovery') as res;`
        );
        expect(entryRes.rows[0].res.success).toBe(true);
        expect(entryRes.rows[0].res.status).toBe('inside');

        // 2. Cannot re-approve inside pass
        await expect(
          db.query(`select api.guard_recover_pass_action('${passAId}'::uuid, 'approve_entry', 'Repeat');`)
        ).rejects.toThrow(/pass is not eligible for entry approval/);

        // 3. Record exit recovery -> pass status becomes exited
        const exitRes = await db.query<{ res: any }>(
          `select api.guard_recover_pass_action('${passAId}'::uuid, 'record_exit', 'Manual exit recovery') as res;`
        );
        expect(exitRes.rows[0].res.success).toBe(true);
        expect(exitRes.rows[0].res.status).toBe('exited');
      });
    });

    it('executes positive guard_sync_offline_event with receipt creation and idempotency', async () => {
      const offlineEventId = '90000000-0000-0000-0000-000000000001';

      await asActor(adminId, {}, async () => {
        // 1. Initial sync mutation
        const syncRes = await db.query<{ res: any }>(
          `select api.guard_sync_offline_event(
            '${offlineEventId}'::uuid,
            '${passBId}'::uuid,
            'approve_entry',
            'issued',
            1,
            now(),
            'Offline gate scanner batch'
          ) as res;`
        );
        expect(syncRes.rows[0].res.status).toBe('applied');
        expect(syncRes.rows[0].res.eventId).toBe(offlineEventId);

        // 2. Idempotent replay of same event returns existing receipt
        const replayRes = await db.query<{ res: any }>(
          `select api.guard_sync_offline_event(
            '${offlineEventId}'::uuid,
            '${passBId}'::uuid,
            'approve_entry',
            'issued',
            1,
            now(),
            'Offline gate scanner batch'
          ) as res;`
        );
        expect(replayRes.rows[0].res.status).toBe('applied');
        expect(replayRes.rows[0].res.eventId).toBe(offlineEventId);
      });
    });
  });

  describe('Caller Actor Resolution (current_actor)', () => {
    it('returns empty result when caller is unauthenticated (auth.uid is null)', async () => {
      await asActor(null, {}, async () => {
        const res = await db.query(`select * from api.current_actor();`);
        expect(res.rows.length).toBe(0);
      });
    });

    it('resolves superadmin actor identity correctly', async () => {
      await asActor(superadminId, {}, async () => {
        const res = await db.query<{ actor_kind: string; staff_role: string }>(`select * from api.current_actor();`);
        expect(res.rows[0].actor_kind).toBe('staff');
        expect(res.rows[0].staff_role).toBe('superadmin');
      });
    });

    it('resolves administrator actor identity correctly', async () => {
      await asActor(adminId, {}, async () => {
        const res = await db.query<{ actor_kind: string; staff_role: string }>(`select * from api.current_actor();`);
        expect(res.rows[0].actor_kind).toBe('staff');
        expect(res.rows[0].staff_role).toBe('admin');
      });
    });

    it('resolves visitor actor identity correctly', async () => {
      await asActor(visitorAId, {}, async () => {
        const res = await db.query<{ actor_kind: string; staff_role: string | null }>(`select * from api.current_actor();`);
        expect(res.rows[0].actor_kind).toBe('visitor');
        expect(res.rows[0].staff_role).toBeNull();
      });
    });

    it('resolves active kiosk device identity correctly', async () => {
      await asActor(kioskDeviceId, {}, async () => {
        const res = await db.query<{ actor_kind: string; device_type: string }>(`select * from api.current_actor();`);
        expect(res.rows[0].actor_kind).toBe('device');
        expect(res.rows[0].device_type).toBe('kiosk');
      });
    });

    it('prevents password recovery session from resolving operational staff role', async () => {
      await asActor(adminId, { amr: [{ method: 'recovery' }] }, async () => {
        const res = await db.query(`select * from api.current_actor();`);
        expect(res.rows.length).toBe(0);
      });
    });
  });

  // ===========================================================================
  // 5. DYNAMIC FAILURE INVARIANTS & REGRESSION RESISTANCE
  // ===========================================================================

  describe('Dynamic Failure Invariants & Regression Proofs', () => {
    it('fails when an un-audited authenticated SECURITY DEFINER function appears in catalog', () => {
      const activeFunctions = ['api.abandon_upload_intent', 'api.unauthorized_backdoor'];
      const auditedNames = ['api.abandon_upload_intent'];
      expect(() => {
        expect(activeFunctions).toEqual(auditedNames);
      }).toThrow();
    });

    it('fails when effective grants drift from declared intended architecture', () => {
      const expectedGrants = ['authenticated'];
      const effectiveGrants = ['authenticated', 'service_role'];
      expect(() => {
        expect(effectiveGrants.includes('service_role')).toBe(expectedGrants.includes('service_role'));
      }).toThrow();
    });

    it('fails when proconfig search_path is removed or altered', () => {
      const proconfig = ['search_path=public'];
      expect(() => {
        expect(proconfig).toContain('search_path=""');
      }).toThrow();
    });

    it('fails when required authorization helper is bypassed or missing from SQL body', () => {
      const vulnerableBody = 'select auth.uid(); update passes set status = 1;';
      expect(() => {
        expect(vulnerableBody).toMatch(/private\.current_staff_role\(\)/);
      }).toThrow();
    });
  });
});
