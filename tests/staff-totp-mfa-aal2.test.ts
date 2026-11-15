import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { requireStaffActor, requireEmergencyDeviceActor, HttpError } from '../server/actors.js';
import { requireOfficeStaffActor } from '../server/lib/office.js';
import { adminResetMfaFactor, handleRequest as handleMfaRequest } from '../server/routes/auth/mfa.js';
import adminUsersRoute from '../server/routes/admin/users.js';
import { setServerSupabaseClientsForTest } from '../server/supabase.js';

function createMockJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = Buffer.from('mock-signature-hash').toString('base64url');
  return `${header}.${body}.${sig}`;
}

describe('Mandatory TOTP MFA (AAL2) Across Authorization Boundaries', () => {
  const SUPERADMIN_ID = '11111111-1111-4000-a000-000000000001';
  const ADMIN_ID = '22222222-2222-4000-a000-000000000002';
  const OFFICE_STAFF_ID = '33333333-3333-4000-a000-000000000003';
  const GUARD_ID = '44444444-4444-4000-a000-000000000004';
  const DEVICE_ID = '55555555-5555-4000-a000-000000000005';
  const ANONYMOUS_ID = '66666666-6666-4000-a000-000000000006';
  const OFFICE_ID = '77777777-7777-4000-a000-000000000007';

  let mockUsers: Record<string, any> = {};
  let mockStaffProfiles: Record<string, any> = {};
  let mockDevices: Record<string, any> = {};
  let mockAssignments: any[] = [];
  let mockAuditEvents: any[] = [];
  let deletedFactors: any[] = [];

  beforeEach(() => {
    mockAuditEvents = [];
    deletedFactors = [];

    mockUsers = {
      [SUPERADMIN_ID]: {
        id: SUPERADMIN_ID,
        email: 'superadmin@earist.edu.ph',
        email_confirmed_at: '2026-01-01T00:00:00Z',
        is_anonymous: false,
      },
      [ADMIN_ID]: {
        id: ADMIN_ID,
        email: 'admin@earist.edu.ph',
        email_confirmed_at: '2026-01-01T00:00:00Z',
        is_anonymous: false,
      },
      [OFFICE_STAFF_ID]: {
        id: OFFICE_STAFF_ID,
        email: 'registrar.staff@earist.edu.ph',
        email_confirmed_at: '2026-01-01T00:00:00Z',
        is_anonymous: false,
      },
      [GUARD_ID]: {
        id: GUARD_ID,
        email: 'guard@earist.edu.ph',
        email_confirmed_at: '2026-01-01T00:00:00Z',
        is_anonymous: false,
      },
      [DEVICE_ID]: {
        id: DEVICE_ID,
        email: 'em-gate-01@devices.egatepass.invalid',
        email_confirmed_at: '2026-01-01T00:00:00Z',
        is_anonymous: false,
      },
      [ANONYMOUS_ID]: {
        id: ANONYMOUS_ID,
        email: null,
        email_confirmed_at: null,
        is_anonymous: true,
      },
    };

    mockStaffProfiles = {
      [SUPERADMIN_ID]: {
        user_id: SUPERADMIN_ID,
        display_name: 'Super Admin',
        role: 'superadmin',
        active: true,
        must_change_password: false,
        privacy_accepted_at: '2026-01-01T00:00:00Z',
      },
      [ADMIN_ID]: {
        user_id: ADMIN_ID,
        display_name: 'Admin User',
        role: 'admin',
        active: true,
        must_change_password: false,
        privacy_accepted_at: '2026-01-01T00:00:00Z',
      },
      [OFFICE_STAFF_ID]: {
        user_id: OFFICE_STAFF_ID,
        display_name: 'Registrar Staff',
        role: 'office_staff',
        active: true,
        must_change_password: false,
        privacy_accepted_at: '2026-01-01T00:00:00Z',
      },
      [GUARD_ID]: {
        user_id: GUARD_ID,
        display_name: 'Campus Guard',
        role: 'guard',
        active: true,
        must_change_password: false,
        privacy_accepted_at: '2026-01-01T00:00:00Z',
      },
    };

    mockDevices = {
      [DEVICE_ID]: {
        id: 'device-record-1',
        user_id: DEVICE_ID,
        name: 'Gate 1 Emergency Station',
        type: 'emergency_device',
        gate: 'Gate 1',
        status: 'active',
        alias: 'em-gate-01',
        deleted_at: null,
      },
    };

    mockAssignments = [
      {
        user_id: OFFICE_STAFF_ID,
        office_id: OFFICE_ID,
      },
    ];

    const mockAdmin: any = {
      auth: {
        getUser: vi.fn(async (token: string) => {
          // If token contains JWT claims, extract user_id from sub
          let userId: string | null = null;
          try {
            const parts = token.split('.');
            if (parts.length >= 2) {
              const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
              userId = payload.sub || null;
            }
          } catch {
            userId = null;
          }
          if (!userId) {
            userId = token.replace('bearer-', '');
          }

          const user = mockUsers[userId];
          if (!user) return { data: { user: null }, error: new Error('invalid_token') };
          return { data: { user }, error: null };
        }),
        admin: {
          listUsers: vi.fn(async () => {
            return {
              data: {
                users: Object.values(mockUsers),
              },
              error: null,
            };
          }),
          mfa: {
            listFactors: vi.fn(async ({ userId }: { userId: string }) => {
              return {
                data: {
                  factors: [
                    { id: 'factor-totp-1', factor_type: 'totp', status: 'verified', friendly_name: 'TOTP App' },
                  ],
                },
                error: null,
              };
            }),
            deleteFactor: vi.fn(async ({ userId, id }: { userId: string; id: string }) => {
              deletedFactors.push({ userId, id });
              return { data: { id }, error: null };
            }),
          },
        },
      },
      from: vi.fn((table: string) => {
        return {
          select: vi.fn((cols: string) => ({
            in: vi.fn(() => Promise.resolve({ data: mockAssignments, error: null })),
            eq: vi.fn((col: string, val: any) => ({
              order: vi.fn(() => ({
                order: vi.fn(() => ({
                  limit: async () => ({ data: Object.values(mockStaffProfiles), error: null }),
                })),
              })),
              maybeSingle: async () => {
                if (table === 'staff_profiles') {
                  const match = mockStaffProfiles[val];
                  return { data: match || null, error: null };
                }
                if (table === 'devices') {
                  const match = mockDevices[val];
                  return { data: match || null, error: null };
                }
                return { data: null, error: null };
              },
            })),
            order: vi.fn(() => ({
              order: vi.fn(() => ({
                limit: async () => ({ data: Object.values(mockStaffProfiles), error: null }),
              })),
            })),
            maybeSingle: async () => ({ data: null, error: null }),
          })),
          insert: vi.fn(async (records: any) => {
            if (table === 'audit_events') {
              mockAuditEvents.push(records);
            }
            return { data: records, error: null };
          }),
        };
      }),
      schema: vi.fn(() => ({
        rpc: vi.fn(async () => ({ data: { valid: true, expired: false }, error: null })),
      })),
    };

    setServerSupabaseClientsForTest({ admin: mockAdmin, anon: mockAdmin });
  });

  describe('1. Server-Side requireStaffActor Boundary Guard', () => {
    it('blocks human staff with AAL1 credentials with HTTP 403 mfa_required', async () => {
      const { admin } = (await import('../server/supabase.js')).getServerSupabaseClients();
      const aal1Token = createMockJwt({
        sub: ADMIN_ID,
        role: 'authenticated',
        aal: 'aal1',
        session_id: 'session-valid-1234',
      });

      await expect(requireStaffActor(admin, aal1Token, ['admin'])).rejects.toThrow(
        expect.objectContaining({ status: 403, code: 'mfa_required' })
      );
    });

    it('allows human staff with verified AAL2 credentials to access operational APIs', async () => {
      const { admin } = (await import('../server/supabase.js')).getServerSupabaseClients();
      const aal2Token = createMockJwt({
        sub: ADMIN_ID,
        role: 'authenticated',
        aal: 'aal2',
        session_id: 'session-valid-1234',
      });

      const actor = await requireStaffActor(admin, aal2Token, ['admin']);
      expect(actor).toEqual({
        id: ADMIN_ID,
        email: 'admin@earist.edu.ph',
        role: 'admin',
      });
    });

    it('enforces AAL2 across all human staff roles (admin, superadmin, office_staff, guard)', async () => {
      const { admin } = (await import('../server/supabase.js')).getServerSupabaseClients();

      // Superadmin
      const superadminAal1 = createMockJwt({ sub: SUPERADMIN_ID, role: 'authenticated', aal: 'aal1', session_id: 'sess-1' });
      await expect(requireStaffActor(admin, superadminAal1, ['superadmin'])).rejects.toThrow(
        expect.objectContaining({ status: 403, code: 'mfa_required' })
      );
      const superadminAal2 = createMockJwt({ sub: SUPERADMIN_ID, role: 'authenticated', aal: 'aal2', session_id: 'sess-1' });
      const saActor = await requireStaffActor(admin, superadminAal2, ['superadmin']);
      expect(saActor.role).toBe('superadmin');

      // Office staff
      const officeAal1 = createMockJwt({ sub: OFFICE_STAFF_ID, role: 'authenticated', aal: 'aal1', session_id: 'sess-2' });
      await expect(requireStaffActor(admin, officeAal1, ['office_staff'])).rejects.toThrow(
        expect.objectContaining({ status: 403, code: 'mfa_required' })
      );
      const officeAal2 = createMockJwt({ sub: OFFICE_STAFF_ID, role: 'authenticated', aal: 'aal2', session_id: 'sess-2' });
      const officeActor = await requireStaffActor(admin, officeAal2, ['office_staff']);
      expect(officeActor.role).toBe('office_staff');

      // Guard
      const guardAal1 = createMockJwt({ sub: GUARD_ID, role: 'authenticated', aal: 'aal1', session_id: 'sess-3' });
      await expect(requireStaffActor(admin, guardAal1, ['guard'])).rejects.toThrow(
        expect.objectContaining({ status: 403, code: 'mfa_required' })
      );
      const guardAal2 = createMockJwt({ sub: GUARD_ID, role: 'authenticated', aal: 'aal2', session_id: 'sess-3' });
      const guardActor = await requireStaffActor(admin, guardAal2, ['guard']);
      expect(guardActor.role).toBe('guard');
    });

    it('rejects recovery sessions even if claim declares aal2', async () => {
      const { admin } = (await import('../server/supabase.js')).getServerSupabaseClients();
      const recoveryToken = createMockJwt({
        sub: ADMIN_ID,
        role: 'authenticated',
        aal: 'aal2',
        amr: [{ method: 'recovery' }],
        session_id: 'session-valid-1234',
      });

      await expect(requireStaffActor(admin, recoveryToken, ['admin'])).rejects.toThrow(
        expect.objectContaining({ status: 403, code: 'recovery_session_forbidden' })
      );
    });
  });

  describe('2. Server-Side requireOfficeStaffActor Boundary Guard', () => {
    it('blocks office staff at AAL1 from office operations with HTTP 403 mfa_required', async () => {
      const { admin } = (await import('../server/supabase.js')).getServerSupabaseClients();
      const aal1Token = createMockJwt({
        sub: OFFICE_STAFF_ID,
        role: 'authenticated',
        aal: 'aal1',
        session_id: 'session-valid-1234',
      });

      await expect(requireOfficeStaffActor(admin, aal1Token)).rejects.toThrow(
        expect.objectContaining({ status: 403, code: 'mfa_required' })
      );
    });

    it('allows office staff at AAL2 to access office operations', async () => {
      const { admin } = (await import('../server/supabase.js')).getServerSupabaseClients();
      const aal2Token = createMockJwt({
        sub: OFFICE_STAFF_ID,
        role: 'authenticated',
        aal: 'aal2',
        session_id: 'session-valid-1234',
      });

      const actor = await requireOfficeStaffActor(admin, aal2Token);
      expect(actor).toEqual(
        expect.objectContaining({
          id: OFFICE_STAFF_ID,
          role: 'office_staff',
        })
      );
    });
  });

  describe('3. Actor Isolation & Non-Blanket Exemption', () => {
    it('preserves emergency device authentication without requiring AAL2', async () => {
      const { admin } = (await import('../server/supabase.js')).getServerSupabaseClients();
      const deviceToken = createMockJwt({
        sub: DEVICE_ID,
        role: 'authenticated',
      });

      const deviceActor = await requireEmergencyDeviceActor(admin, deviceToken);
      expect(deviceActor).toEqual(
        expect.objectContaining({
          userId: DEVICE_ID,
          deviceType: 'emergency_device',
          deviceName: 'Gate 1 Emergency Station',
          gate: 'Gate 1',
          status: 'active',
        })
      );
    });

    it('denies anonymous visitor sessions with access_denied, not mfa_required', async () => {
      const { admin } = (await import('../server/supabase.js')).getServerSupabaseClients();
      const anonToken = createMockJwt({
        sub: ANONYMOUS_ID,
        role: 'authenticated',
        is_anonymous: true,
      });

      await expect(requireStaffActor(admin, anonToken, ['admin'])).rejects.toThrow(
        expect.objectContaining({ status: 403, code: 'access_denied' })
      );
    });
  });

  describe('4. Operational API HTTP Route Protection', () => {
    it('blocks AAL1 staff request to /api/admin/users with HTTP 403 mfa_required', async () => {
      const aal1Token = createMockJwt({
        sub: ADMIN_ID,
        role: 'authenticated',
        aal: 'aal1',
        session_id: 'session-valid-1234',
      });

      const req = new Request('https://egatepass.tech/api/admin/users', {
        method: 'GET',
        headers: {
          authorization: `Bearer ${aal1Token}`,
        },
      });

      const res = await adminUsersRoute.fetch(req);
      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json).toEqual({ error: 'mfa_required' });
    });

    it('allows AAL2 staff request to /api/admin/users with HTTP 200', async () => {
      const aal2Token = createMockJwt({
        sub: ADMIN_ID,
        role: 'authenticated',
        aal: 'aal2',
        session_id: 'session-valid-1234',
      });

      const req = new Request('https://egatepass.tech/api/admin/users', {
        method: 'GET',
        headers: {
          authorization: `Bearer ${aal2Token}`,
        },
      });

      const res = await adminUsersRoute.fetch(req);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.users).toBeDefined();
    });
  });

  describe('5. Superadmin MFA Recovery Endpoint & Audit Logging', () => {
    it('rejects factor reset requests from non-superadmin actors with HTTP 403', async () => {
      const adminToken = createMockJwt({
        sub: ADMIN_ID,
        role: 'authenticated',
        aal: 'aal2',
        session_id: 'session-admin',
      });

      const req = new Request('https://egatepass.tech/api/auth/mfa', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${adminToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          action: 'reset_factor',
          userId: OFFICE_STAFF_ID,
          factorId: 'factor-totp-1',
          reason: 'Staff lost phone authenticator',
        }),
      });

      const res = await handleMfaRequest(req);
      expect(res.status).toBe(403);
    });

    it('rejects factor reset requests from superadmin at AAL1 with HTTP 403 mfa_required', async () => {
      const superadminAal1 = createMockJwt({
        sub: SUPERADMIN_ID,
        role: 'authenticated',
        aal: 'aal1',
        session_id: 'session-sa-aal1',
      });

      const req = new Request('https://egatepass.tech/api/auth/mfa', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${superadminAal1}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          action: 'reset_factor',
          userId: OFFICE_STAFF_ID,
          factorId: 'factor-totp-1',
        }),
      });

      const res = await handleMfaRequest(req);
      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json).toEqual({ error: 'mfa_required' });
    });

    it('allows superadmin at AAL2 to delete factor and records immutable audit event', async () => {
      const superadminAal2 = createMockJwt({
        sub: SUPERADMIN_ID,
        role: 'authenticated',
        aal: 'aal2',
        session_id: 'session-sa-aal2',
      });

      const req = new Request('https://egatepass.tech/api/auth/mfa', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${superadminAal2}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          action: 'reset_factor',
          userId: OFFICE_STAFF_ID,
          factorId: 'factor-totp-1',
          reason: 'Staff lost authenticator device',
        }),
      });

      const res = await handleMfaRequest(req);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);

      // Verify Supabase Admin MFA deleteFactor was invoked
      expect(deletedFactors).toHaveLength(1);
      expect(deletedFactors[0]).toEqual({
        userId: OFFICE_STAFF_ID,
        id: 'factor-totp-1',
      });

      // Verify audit event was logged
      expect(mockAuditEvents).toHaveLength(1);
      expect(mockAuditEvents[0]).toEqual(
        expect.objectContaining({
          actor_id: SUPERADMIN_ID,
          actor_kind: 'staff',
          actor_role: 'superadmin',
          action: 'staff.mfa_factor_reset',
          target_type: 'staff_mfa_factor',
          target_id: OFFICE_STAFF_ID,
          outcome: 'success',
        })
      );
    });
  });

  describe('6. PostgreSQL RLS & Helper Enforcement (PGlite)', () => {
    it('proves private.current_staff_role() returns NULL for AAL1 staff and valid role for AAL2 staff', async () => {
      const db = new PGlite();
      const MIGRATIONS_DIR = join(process.cwd(), 'supabase', 'migrations');

      // Setup minimal Supabase emulation
      await db.exec(`
        create schema if not exists auth;
        create schema if not exists storage;
        create schema if not exists private;
        create schema if not exists api;

        do $$
        begin
          if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
          if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
          if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin; end if;
        end $$;

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
            (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid
          );
        $$ language sql stable;

        create or replace function auth.jwt() returns jsonb as $$
          select case
            when nullif(current_setting('request.jwt.claims', true), '') is null then '{}'::jsonb
            else current_setting('request.jwt.claims', true)::jsonb
          end
        $$ language sql stable;

        create or replace function auth.role() returns text as $$
          select coalesce(
            nullif(current_setting('request.jwt.claim.role', true), ''),
            (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'),
            'authenticated'::text
          );
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

      // Apply migrations
      const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
      for (const file of files) {
        let sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
        sql = sql.replace(/create extension if not exists pgcrypto[^;]*;/gi, '-- pgcrypto no-op');
        await db.exec(sql);
      }

      const TEST_ADMIN_ID = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
      const TEST_VISITOR_ID = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb';

      // Insert admin user into auth.users and public.staff_profiles
      await db.exec(`
        insert into auth.users (id, email, email_confirmed_at, is_anonymous)
        values ('${TEST_ADMIN_ID}', 'admin.test@earist.edu.ph', now(), false);

        insert into public.staff_profiles (user_id, display_name, role, active, must_change_password, privacy_accepted_at)
        values ('${TEST_ADMIN_ID}', 'Test Admin', 'admin', true, false, now());

        insert into auth.users (id, email, email_confirmed_at, is_anonymous)
        values ('${TEST_VISITOR_ID}', null, null, true);
      `);

      // Case A: Staff JWT at AAL1
      await db.exec(`
        set request.jwt.claims = '{"sub": "${TEST_ADMIN_ID}", "role": "authenticated", "aal": "aal1"}';
      `);

      const aal1RoleRes = await db.query(`select private.current_staff_role() as role;`);
      expect(aal1RoleRes.rows[0].role).toBeNull();

      const aal1HasRoleRes = await db.query(`select private.has_staff_role(array['admin', 'superadmin']::public.staff_role[]) as allowed;`);
      expect(aal1HasRoleRes.rows[0].allowed).toBe(false);

      // Case A2: Staff JWT with missing or null AAL claim fails closed (no fail-open)
      await db.exec(`
        set request.jwt.claims = '{"sub": "${TEST_ADMIN_ID}", "role": "authenticated"}';
      `);

      const missingAalRoleRes = await db.query(`select private.current_staff_role() as role;`);
      expect(missingAalRoleRes.rows[0].role).toBeNull();

      const missingAalHasRoleRes = await db.query(`select private.has_staff_role(array['admin', 'superadmin']::public.staff_role[]) as allowed;`);
      expect(missingAalHasRoleRes.rows[0].allowed).toBe(false);

      // Case B: Staff JWT at AAL2
      await db.exec(`
        set request.jwt.claims = '{"sub": "${TEST_ADMIN_ID}", "role": "authenticated", "aal": "aal2"}';
      `);

      const aal2RoleRes = await db.query(`select private.current_staff_role() as role;`);
      expect(aal2RoleRes.rows[0].role).toBe('admin');

      const aal2HasRoleRes = await db.query(`select private.has_staff_role(array['admin', 'superadmin']::public.staff_role[]) as allowed;`);
      expect(aal2HasRoleRes.rows[0].allowed).toBe(true);

      // Case C: Genuine anonymous visitor without AAL2 remains functional
      await db.exec(`
        set request.jwt.claims = '{"sub": "${TEST_VISITOR_ID}", "role": "authenticated"}';
      `);

      const portalActorRes = await db.query(`select private.is_portal_actor() as is_portal;`);
      expect(portalActorRes.rows[0].is_portal).toBe(true);
    }, 60000);
  });

  describe('7. Direct SECURITY DEFINER RPC Fail-Closed AAL2 Enforcement (PGlite)', () => {
    it('verifies guard_recover_pass_action, guard_search_pending_queue, and guard_sync_offline_event enforce fail-closed AAL2', async () => {
      const db = new PGlite();
      const MIGRATIONS_DIR = join(process.cwd(), 'supabase', 'migrations');

      // Setup minimal Supabase emulation
      await db.exec(`
        create schema if not exists auth;
        create schema if not exists storage;
        create schema if not exists private;
        create schema if not exists api;

        do $$
        begin
          if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
          if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
          if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin; end if;
        end $$;

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
            (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid
          );
        $$ language sql stable;

        create or replace function auth.jwt() returns jsonb as $$
          select case
            when nullif(current_setting('request.jwt.claims', true), '') is null then '{}'::jsonb
            else current_setting('request.jwt.claims', true)::jsonb
          end
        $$ language sql stable;

        create or replace function auth.role() returns text as $$
          select coalesce(
            nullif(current_setting('request.jwt.claim.role', true), ''),
            (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'),
            'authenticated'::text
          );
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

      // Apply all migrations
      const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
      for (const file of files) {
        let sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
        sql = sql.replace(/create extension if not exists pgcrypto[^;]*;/gi, '-- pgcrypto no-op');
        await db.exec(sql);
      }

      const TEST_ADMIN_ID = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
      const TEST_VISITOR_ID = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb';
      const TEST_PASS_ID = 'cccccccc-cccc-4ccc-cccc-cccccccccccc';
      const TEST_EVENT_ID = 'eeeeeeee-eeee-4eee-eeee-eeeeeeeeeeee';

      // Seed admin and visitor
      await db.exec(`
        insert into auth.users (id, email, email_confirmed_at, is_anonymous)
        values ('${TEST_ADMIN_ID}', 'admin.test@earist.edu.ph', now(), false);

        insert into public.staff_profiles (user_id, display_name, role, active, must_change_password, privacy_accepted_at)
        values ('${TEST_ADMIN_ID}', 'Test Admin', 'admin', true, false, now());

        insert into auth.users (id, email, email_confirmed_at, is_anonymous)
        values ('${TEST_VISITOR_ID}', null, null, true);

        insert into public.visitors (id, owner_id, source, full_name, contact_number, purpose, visit_date, consent_accepted_at)
        values ('${TEST_VISITOR_ID}', '${TEST_VISITOR_ID}', 'portal', 'Test Visitor Maria', '09123456789', 'Campus Query', current_date, now());

        insert into public.passes (id, visitor_id, status, source, valid_from, valid_until, gate, public_reference, token_digest, version)
        values ('${TEST_PASS_ID}', '${TEST_VISITOR_ID}', 'pending', 'portal', now(), now() + interval '8 hours', 'Gate 1', gen_random_uuid(), sha256('pass-token-123'::bytea), 1);
      `);

      // 1. api.guard_recover_pass_action
      // AAL1 -> throws mfa_required
      await db.exec(`
        set request.jwt.claims = '{"sub": "${TEST_ADMIN_ID}", "role": "authenticated", "aal": "aal1"}';
      `);
      await expect(
        db.query(`select api.guard_recover_pass_action('${TEST_PASS_ID}'::uuid, 'approve_entry');`)
      ).rejects.toThrow(/mfa_required/);

      // Missing AAL claim -> throws mfa_required
      await db.exec(`
        set request.jwt.claims = '{"sub": "${TEST_ADMIN_ID}", "role": "authenticated"}';
      `);
      await expect(
        db.query(`select api.guard_recover_pass_action('${TEST_PASS_ID}'::uuid, 'approve_entry');`)
      ).rejects.toThrow(/mfa_required/);

      // AAL2 -> succeeds
      await db.exec(`
        set request.jwt.claims = '{"sub": "${TEST_ADMIN_ID}", "role": "authenticated", "aal": "aal2"}';
      `);
      const recoverRes = await db.query<{ res: any }>(
        `select api.guard_recover_pass_action('${TEST_PASS_ID}'::uuid, 'approve_entry') as res;`
      );
      expect(recoverRes.rows[0].res.success).toBe(true);
      expect(recoverRes.rows[0].res.status).toBe('inside');

      // 2. api.guard_search_pending_queue
      // Reset pass back to pending for queue search
      await db.exec(`update public.passes set status = 'pending' where id = '${TEST_PASS_ID}';`);

      // AAL1 -> throws mfa_required
      await db.exec(`
        set request.jwt.claims = '{"sub": "${TEST_ADMIN_ID}", "role": "authenticated", "aal": "aal1"}';
      `);
      await expect(
        db.query(`select api.guard_search_pending_queue('Test Visitor', 10);`)
      ).rejects.toThrow(/mfa_required/);

      // Missing AAL claim -> throws mfa_required
      await db.exec(`
        set request.jwt.claims = '{"sub": "${TEST_ADMIN_ID}", "role": "authenticated"}';
      `);
      await expect(
        db.query(`select api.guard_search_pending_queue('Test Visitor', 10);`)
      ).rejects.toThrow(/mfa_required/);

      // AAL2 -> succeeds and returns results
      await db.exec(`
        set request.jwt.claims = '{"sub": "${TEST_ADMIN_ID}", "role": "authenticated", "aal": "aal2"}';
      `);
      const searchRes = await db.query<{ res: any[] }>(
        `select api.guard_search_pending_queue('Test Visitor', 10) as res;`
      );
      expect(Array.isArray(searchRes.rows[0].res)).toBe(true);
      expect(searchRes.rows[0].res.length).toBeGreaterThan(0);
      expect(searchRes.rows[0].res[0].id).toBe(TEST_PASS_ID);

      // service_role -> succeeds without requiring human staff AAL2
      await db.exec(`
        set request.jwt.claims = '{"role": "service_role"}';
      `);
      const svcSearchRes = await db.query<{ res: any[] }>(
        `select api.guard_search_pending_queue('Test Visitor', 10) as res;`
      );
      expect(Array.isArray(svcSearchRes.rows[0].res)).toBe(true);
      expect(svcSearchRes.rows[0].res.length).toBeGreaterThan(0);

      // 3. api.guard_sync_offline_event
      // AAL1 -> throws mfa_required
      await db.exec(`
        set request.jwt.claims = '{"sub": "${TEST_ADMIN_ID}", "role": "authenticated", "aal": "aal1"}';
      `);
      await expect(
        db.query(`
          select api.guard_sync_offline_event(
            '${TEST_EVENT_ID}'::uuid,
            '${TEST_PASS_ID}'::uuid,
            'approve_entry',
            'pending',
            2,
            statement_timestamp(),
            'Offline sync test'
          );
        `)
      ).rejects.toThrow(/mfa_required/);

      // Missing AAL claim -> throws mfa_required
      await db.exec(`
        set request.jwt.claims = '{"sub": "${TEST_ADMIN_ID}", "role": "authenticated"}';
      `);
      await expect(
        db.query(`
          select api.guard_sync_offline_event(
            '${TEST_EVENT_ID}'::uuid,
            '${TEST_PASS_ID}'::uuid,
            'approve_entry',
            'pending',
            2,
            statement_timestamp(),
            'Offline sync test'
          );
        `)
      ).rejects.toThrow(/mfa_required/);

      // AAL2 -> succeeds past auth
      await db.exec(`
        set request.jwt.claims = '{"sub": "${TEST_ADMIN_ID}", "role": "authenticated", "aal": "aal2"}';
      `);
      const syncRes = await db.query<{ res: any }>(`
        select api.guard_sync_offline_event(
          '${TEST_EVENT_ID}'::uuid,
          '${TEST_PASS_ID}'::uuid,
          'approve_entry',
          'pending',
          2,
          statement_timestamp(),
          'Offline sync test'
        ) as res;
      `);
      expect(syncRes.rows[0].res.status).toBe('applied');

      // 4. api.claim_office_visit_acknowledgement_for_delivery
      // Test that 24-hour expired idempotency window marks row reconciliation_required and commits without rollback
      const OFFICE_ID = '77777777-7777-4000-a000-000000000007';
      const VISIT_ID = '88888888-8888-4000-a000-000000000008';
      const OUTBOX_ID = '99999999-9999-4000-a000-000000000009';

      await db.exec(`
        set request.jwt.claims = '{"role": "service_role"}';

        insert into public.offices (id, name)
        values ('${OFFICE_ID}', 'Admissions Office')
        on conflict (name) do nothing;

        insert into public.office_visits (
          id, visit_type, office_id, visitor_id, visitor_actor_id, visitor_first_name, visitor_last_name,
          visitor_contact_number, visitor_email, purpose, visit_date, request_id
        ) values (
          '${VISIT_ID}', 'general', '${OFFICE_ID}', '${TEST_VISITOR_ID}', '${TEST_VISITOR_ID}', 'Juan', 'Dela Cruz',
          '09123456789', 'juan@test.local', 'Admissions Inquiries', current_date, gen_random_uuid()
        );

        insert into public.office_visit_acknowledgement_outbox (
          id, office_visit_id, recipient_email, encrypted_tracking_token, idempotency_key,
          delivery_status, attempt_count, created_at, last_attempt_at
        ) values (
          '${OUTBOX_ID}', '${VISIT_ID}', 'juan@test.local', 'enc_token_123', 'idemp_key_123',
          'pending', 1, now() - interval '25 hours', now() - interval '25 hours'
        );
      `);

      // Claiming as service_role must return 0 rows (no active claim granted)
      const claimRes = await db.query(`select * from api.claim_office_visit_acknowledgement_for_delivery('${VISIT_ID}'::uuid);`);
      expect(claimRes.rows.length).toBe(0);

      // Verify that the table row is committed with reconciliation_required (PROVING NO ROLLBACK)
      const outboxCheck = await db.query<{ delivery_status: string; last_error: string }>(
        `select delivery_status, last_error from public.office_visit_acknowledgement_outbox where id = '${OUTBOX_ID}'::uuid;`
      );
      expect(outboxCheck.rows[0].delivery_status).toBe('reconciliation_required');
      expect(outboxCheck.rows[0].last_error).toContain('Resend idempotency window (24h) expired');

      // Subsequent claim call still returns 0 rows safely without exception
      const subsequentClaim = await db.query(`select * from api.claim_office_visit_acknowledgement_for_delivery('${VISIT_ID}'::uuid);`);
      expect(subsequentClaim.rows.length).toBe(0);
    }, 90000);
  });
});
