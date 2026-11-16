import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import {
  requireStaffActor,
  requireEmergencyDeviceActor,
  HttpError,
  assertStaffMfaSatisfied,
  invalidateStaffMfaCache,
  clearStaffMfaCacheForTesting,
} from '../server/actors.js';
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
  const TOTP_FACTOR_ID = '88888888-8888-4000-a000-000000000008';
  const SUPERADMIN_PASSWORD = 'CorrectSuperadminPassword123!';

  let mockUsers: Record<string, any> = {};
  let mockStaffProfiles: Record<string, any> = {};
  let mockDevices: Record<string, any> = {};
  let mockAssignments: any[] = [];
  let mockAuditEvents: any[] = [];
  let deletedFactors: any[] = [];
  let mockUpdatedSessions: any[] = [];

  beforeEach(() => {
    clearStaffMfaCacheForTesting();
    mockAuditEvents = [];
    deletedFactors = [];
    mockUpdatedSessions = [];

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
                    { id: TOTP_FACTOR_ID, factor_type: 'totp', status: 'verified', friendly_name: 'TOTP App' },
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
          update: vi.fn((updateData: any) => ({
            eq: vi.fn((col: string, val: any) => ({
              is: vi.fn(async (col2: string, val2: any) => {
                mockUpdatedSessions.push({ table, updateData, col, val, col2, val2 });
                return { data: null, error: null };
              }),
            })),
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

    const mockPasswordVerifier: any = {
      auth: {
        signInWithPassword: vi.fn(async ({ email, password }: { email: string; password: string }) => {
          if (password === SUPERADMIN_PASSWORD) {
            const user = Object.values(mockUsers).find((u: any) => u.email === email);
            if (user) {
              return { data: { user }, error: null };
            }
          }
          return { data: { user: null }, error: new Error('invalid_credentials') };
        }),
        signOut: vi.fn(async () => ({ error: null })),
      },
    };

    setServerSupabaseClientsForTest({ admin: mockAdmin, passwordVerifier: mockPasswordVerifier } as any);
  });

  afterEach(() => {
    clearStaffMfaCacheForTesting();
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

    it('blocks human staff with explicit null AAL claim with HTTP 403 mfa_required', async () => {
      const { admin } = (await import('../server/supabase.js')).getServerSupabaseClients();
      const nullAalToken = createMockJwt({
        sub: ADMIN_ID,
        role: 'authenticated',
        aal: null,
        session_id: 'session-valid-1234',
      });

      await expect(requireStaffActor(admin, nullAalToken, ['admin'])).rejects.toThrow(
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

  describe('1b. Conditional Staff MFA Policy & In-Memory Factor Caching', () => {
    it('bypasses external factor lookup completely when session claims contain aal2', async () => {
      const { admin } = (await import('../server/supabase.js')).getServerSupabaseClients();
      const listFactorsSpy = vi.spyOn(admin.auth.admin.mfa, 'listFactors');
      listFactorsSpy.mockClear();

      await assertStaffMfaSatisfied(admin, ADMIN_ID, { aal: 'aal2' });
      expect(listFactorsSpy).not.toHaveBeenCalled();
    });

    it('allows AAL1 staff when user has 0 verified factors', async () => {
      const { admin } = (await import('../server/supabase.js')).getServerSupabaseClients();
      vi.spyOn(admin.auth.admin.mfa, 'listFactors').mockResolvedValueOnce({
        data: { factors: [] },
        error: null,
      } as any);

      await expect(assertStaffMfaSatisfied(admin, ADMIN_ID, { aal: 'aal1' })).resolves.toBeUndefined();
    });

    it('allows AAL1 staff when user has only unverified factors', async () => {
      const { admin } = (await import('../server/supabase.js')).getServerSupabaseClients();
      vi.spyOn(admin.auth.admin.mfa, 'listFactors').mockResolvedValueOnce({
        data: {
          factors: [
            { id: 'unverified-factor', factor_type: 'totp', status: 'unverified' },
          ],
        },
        error: null,
      } as any);

      await expect(assertStaffMfaSatisfied(admin, ADMIN_ID, { aal: 'aal1' })).resolves.toBeUndefined();
    });

    it('throws HttpError(403, mfa_required) for AAL1 staff when user has verified TOTP factor', async () => {
      const { admin } = (await import('../server/supabase.js')).getServerSupabaseClients();
      vi.spyOn(admin.auth.admin.mfa, 'listFactors').mockResolvedValueOnce({
        data: {
          factors: [
            { id: TOTP_FACTOR_ID, factor_type: 'totp', status: 'verified' },
          ],
        },
        error: null,
      } as any);

      await expect(assertStaffMfaSatisfied(admin, ADMIN_ID, { aal: 'aal1' })).rejects.toThrow(
        expect.objectContaining({ status: 403, code: 'mfa_required' })
      );
    });

    it('fails closed with HttpError(403, mfa_required) on factor lookup error or null data', async () => {
      const { admin } = (await import('../server/supabase.js')).getServerSupabaseClients();
      vi.spyOn(admin.auth.admin.mfa, 'listFactors').mockResolvedValueOnce({
        data: null,
        error: new Error('network_failure'),
      } as any);

      await expect(assertStaffMfaSatisfied(admin, ADMIN_ID, { aal: 'aal1' })).rejects.toThrow(
        expect.objectContaining({ status: 403, code: 'mfa_required' })
      );
    });

    it('caches factor verification state and avoids duplicate API calls within 15-second TTL', async () => {
      const { admin } = (await import('../server/supabase.js')).getServerSupabaseClients();
      const listFactorsSpy = vi.spyOn(admin.auth.admin.mfa, 'listFactors').mockResolvedValue({
        data: { factors: [] },
        error: null,
      } as any);
      listFactorsSpy.mockClear();

      // First call -> hits API and caches
      await assertStaffMfaSatisfied(admin, ADMIN_ID, { aal: 'aal1' });
      expect(listFactorsSpy).toHaveBeenCalledTimes(1);

      // Second call within TTL -> cache hit, zero API calls
      await assertStaffMfaSatisfied(admin, ADMIN_ID, { aal: 'aal1' });
      expect(listFactorsSpy).toHaveBeenCalledTimes(1);
    });

    it('invalidateStaffMfaCache purges cache entry and forces subsequent API lookup', async () => {
      const { admin } = (await import('../server/supabase.js')).getServerSupabaseClients();
      const listFactorsSpy = vi.spyOn(admin.auth.admin.mfa, 'listFactors').mockResolvedValue({
        data: { factors: [] },
        error: null,
      } as any);
      listFactorsSpy.mockClear();

      await assertStaffMfaSatisfied(admin, ADMIN_ID, { aal: 'aal1' });
      expect(listFactorsSpy).toHaveBeenCalledTimes(1);

      invalidateStaffMfaCache(ADMIN_ID);

      await assertStaffMfaSatisfied(admin, ADMIN_ID, { aal: 'aal1' });
      expect(listFactorsSpy).toHaveBeenCalledTimes(2);
    });

    it('clearStaffMfaCacheForTesting clears all cached entries', async () => {
      const { admin } = (await import('../server/supabase.js')).getServerSupabaseClients();
      const listFactorsSpy = vi.spyOn(admin.auth.admin.mfa, 'listFactors').mockResolvedValue({
        data: { factors: [] },
        error: null,
      } as any);
      listFactorsSpy.mockClear();

      await assertStaffMfaSatisfied(admin, ADMIN_ID, { aal: 'aal1' });
      expect(listFactorsSpy).toHaveBeenCalledTimes(1);

      clearStaffMfaCacheForTesting();

      await assertStaffMfaSatisfied(admin, ADMIN_ID, { aal: 'aal1' });
      expect(listFactorsSpy).toHaveBeenCalledTimes(2);
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
    it('rejects request missing bearer token with HTTP 401', async () => {
      const req = new Request('https://egatepass.tech/api/auth/mfa', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          action: 'reset_factor',
          userId: OFFICE_STAFF_ID,
          factorId: TOTP_FACTOR_ID,
          password: SUPERADMIN_PASSWORD,
          reason: 'Valid reset reason',
        }),
      });

      const res = await handleMfaRequest(req);
      expect(res.status).toBe(401);
      const json = await res.json();
      expect(json.error).toBe('authentication_required');
    });

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
          factorId: TOTP_FACTOR_ID,
          password: SUPERADMIN_PASSWORD,
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
          factorId: TOTP_FACTOR_ID,
          password: SUPERADMIN_PASSWORD,
          reason: 'Staff lost phone authenticator',
        }),
      });

      const res = await handleMfaRequest(req);
      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json).toEqual({ error: 'mfa_required' });
    });

    it('rejects factor reset request with invalid UUIDs in factorId or userId with HTTP 400', async () => {
      const superadminAal2 = createMockJwt({
        sub: SUPERADMIN_ID,
        role: 'authenticated',
        aal: 'aal2',
        session_id: 'session-sa-aal2',
      });

      // Invalid factorId
      const req1 = new Request('https://egatepass.tech/api/auth/mfa', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${superadminAal2}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          action: 'reset_factor',
          userId: OFFICE_STAFF_ID,
          factorId: 'not-a-valid-uuid',
          password: SUPERADMIN_PASSWORD,
          reason: 'Staff lost phone authenticator',
        }),
      });
      const res1 = await handleMfaRequest(req1);
      expect(res1.status).toBe(400);
      const json1 = await res1.json();
      expect(json1.error).toBe('invalid_request');

      // Invalid userId
      const req2 = new Request('https://egatepass.tech/api/auth/mfa', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${superadminAal2}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          action: 'reset_factor',
          userId: 'not-a-valid-uuid',
          factorId: TOTP_FACTOR_ID,
          password: SUPERADMIN_PASSWORD,
          reason: 'Staff lost phone authenticator',
        }),
      });
      const res2 = await handleMfaRequest(req2);
      expect(res2.status).toBe(400);
    });

    it('rejects factor reset request with short reason (< 5 characters) with HTTP 400', async () => {
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
          factorId: TOTP_FACTOR_ID,
          password: SUPERADMIN_PASSWORD,
          reason: 'bad',
        }),
      });

      const res = await handleMfaRequest(req);
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toBe('invalid_request');
    });

    it('rejects factor reset request with wrong superadmin password with HTTP 401', async () => {
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
          factorId: TOTP_FACTOR_ID,
          password: 'WrongPassword!',
          reason: 'Staff lost phone authenticator',
        }),
      });

      const res = await handleMfaRequest(req);
      expect(res.status).toBe(401);
      const json = await res.json();
      expect(json.error).toBe('invalid_superadmin_password');
    });

    it('rejects factor reset request when target user is not found in staff_profiles with HTTP 404', async () => {
      const superadminAal2 = createMockJwt({
        sub: SUPERADMIN_ID,
        role: 'authenticated',
        aal: 'aal2',
        session_id: 'session-sa-aal2',
      });

      const nonExistentId = '99999999-9999-4000-a000-000000000099';
      const req = new Request('https://egatepass.tech/api/auth/mfa', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${superadminAal2}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          action: 'reset_factor',
          userId: nonExistentId,
          factorId: TOTP_FACTOR_ID,
          password: SUPERADMIN_PASSWORD,
          reason: 'Staff lost phone authenticator',
        }),
      });

      const res = await handleMfaRequest(req);
      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.error).toBe('target_user_not_found');
    });

    it('rejects factor reset request when factor does not belong to target user or is not TOTP with HTTP 400', async () => {
      const superadminAal2 = createMockJwt({
        sub: SUPERADMIN_ID,
        role: 'authenticated',
        aal: 'aal2',
        session_id: 'session-sa-aal2',
      });

      const wrongFactorId = '77777777-7777-4000-a000-777777777777';
      const req = new Request('https://egatepass.tech/api/auth/mfa', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${superadminAal2}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          action: 'reset_factor',
          userId: OFFICE_STAFF_ID,
          factorId: wrongFactorId,
          password: SUPERADMIN_PASSWORD,
          reason: 'Staff lost phone authenticator',
        }),
      });

      const res = await handleMfaRequest(req);
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toBe('mismatched_factor_id');
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
          factorId: TOTP_FACTOR_ID,
          password: SUPERADMIN_PASSWORD,
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
        id: TOTP_FACTOR_ID,
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

      // Verify staff sessions update was called
      expect(mockUpdatedSessions.length).toBeGreaterThanOrEqual(1);
    });

    it('GET /api/auth/mfa rejects non-superadmin actors with HTTP 403', async () => {
      const adminToken = createMockJwt({
        sub: ADMIN_ID,
        role: 'authenticated',
        aal: 'aal2',
        session_id: 'session-admin',
      });

      const req = new Request(`https://egatepass.tech/api/auth/mfa?userId=${OFFICE_STAFF_ID}`, {
        method: 'GET',
        headers: { authorization: `Bearer ${adminToken}` },
      });

      const res = await handleMfaRequest(req);
      expect(res.status).toBe(403);
    });

    it('GET /api/auth/mfa rejects request without userId with HTTP 400', async () => {
      const superadminAal2 = createMockJwt({
        sub: SUPERADMIN_ID,
        role: 'authenticated',
        aal: 'aal2',
        session_id: 'session-sa-aal2',
      });

      const req = new Request('https://egatepass.tech/api/auth/mfa', {
        method: 'GET',
        headers: { authorization: `Bearer ${superadminAal2}` },
      });

      const res = await handleMfaRequest(req);
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toBe('missing_user_id');
    });

    it('GET /api/auth/mfa returns 404 if target user not found in staff_profiles', async () => {
      const superadminAal2 = createMockJwt({
        sub: SUPERADMIN_ID,
        role: 'authenticated',
        aal: 'aal2',
        session_id: 'session-sa-aal2',
      });

      const req = new Request('https://egatepass.tech/api/auth/mfa?userId=99999999-9999-4000-a000-000000000099', {
        method: 'GET',
        headers: { authorization: `Bearer ${superadminAal2}` },
      });

      const res = await handleMfaRequest(req);
      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.error).toBe('target_user_not_found');
    });

    it('GET /api/auth/mfa returns 200 and factors list for superadmin', async () => {
      const superadminAal2 = createMockJwt({
        sub: SUPERADMIN_ID,
        role: 'authenticated',
        aal: 'aal2',
        session_id: 'session-sa-aal2',
      });

      const req = new Request(`https://egatepass.tech/api/auth/mfa?userId=${OFFICE_STAFF_ID}`, {
        method: 'GET',
        headers: { authorization: `Bearer ${superadminAal2}` },
      });

      const res = await handleMfaRequest(req);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.factors).toBeDefined();
      expect(json.factors).toHaveLength(1);
      expect(json.factors[0].id).toBe(TOTP_FACTOR_ID);
    });

    it('rejects unsupported HTTP methods with HTTP 405', async () => {
      const superadminAal2 = createMockJwt({
        sub: SUPERADMIN_ID,
        role: 'authenticated',
        aal: 'aal2',
        session_id: 'session-sa-aal2',
      });

      const req = new Request('https://egatepass.tech/api/auth/mfa', {
        method: 'PATCH',
        headers: { authorization: `Bearer ${superadminAal2}` },
      });

      const res = await handleMfaRequest(req);
      expect(res.status).toBe(405);
      const json = await res.json();
      expect(json.error).toBe('method_not_allowed');
    });
  });

  describe('6. PostgreSQL RLS & Helper Enforcement (PGlite)', () => {
    it('proves optional staff TOTP MFA: allows unenrolled/unverified staff at AAL1, strictly enforces AAL2 for enrolled staff, and restores AAL1 on factor deletion', async () => {
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

      // Case A: Unenrolled staff at AAL1 is allowed (MFA is optional)
      await db.exec(`
        set request.jwt.claims = '{"sub": "${TEST_ADMIN_ID}", "role": "authenticated", "aal": "aal1"}';
      `);

      const aal1RoleRes = await db.query(`select private.current_staff_role() as role;`);
      expect(aal1RoleRes.rows[0].role).toBe('admin');

      const aal1HasRoleRes = await db.query(`select private.has_staff_role(array['admin', 'superadmin']::public.staff_role[]) as allowed;`);
      expect(aal1HasRoleRes.rows[0].allowed).toBe(true);

      const aal1SatisfiedRes = await db.query(`select private.staff_mfa_is_satisfied() as satisfied;`);
      expect(aal1SatisfiedRes.rows[0].satisfied).toBe(true);

      // Case A2: Unenrolled staff with missing or null AAL claim is allowed (MFA is optional)
      await db.exec(`
        set request.jwt.claims = '{"sub": "${TEST_ADMIN_ID}", "role": "authenticated"}';
      `);

      const missingAalRoleRes = await db.query(`select private.current_staff_role() as role;`);
      expect(missingAalRoleRes.rows[0].role).toBe('admin');

      const missingAalHasRoleRes = await db.query(`select private.has_staff_role(array['admin', 'superadmin']::public.staff_role[]) as allowed;`);
      expect(missingAalHasRoleRes.rows[0].allowed).toBe(true);

      // Case A3: Incomplete / unverified factor (status = 'unverified') does NOT block AAL1 login
      await db.exec(`
        insert into auth.mfa_factors (user_id, status, factor_type)
        values ('${TEST_ADMIN_ID}', 'unverified', 'totp');
      `);

      await db.exec(`
        set request.jwt.claims = '{"sub": "${TEST_ADMIN_ID}", "role": "authenticated", "aal": "aal1"}';
      `);
      const unverifiedRoleRes = await db.query(`select private.current_staff_role() as role;`);
      expect(unverifiedRoleRes.rows[0].role).toBe('admin');

      const unverifiedSatisfiedRes = await db.query(`select private.staff_mfa_is_satisfied() as satisfied;`);
      expect(unverifiedSatisfiedRes.rows[0].satisfied).toBe(true);

      // Case B: Enrolled staff with verified factor (status = 'verified')
      await db.exec(`
        update auth.mfa_factors set status = 'verified' where user_id = '${TEST_ADMIN_ID}';
      `);

      // Case B1: Enrolled staff at AAL1 is blocked
      await db.exec(`
        set request.jwt.claims = '{"sub": "${TEST_ADMIN_ID}", "role": "authenticated", "aal": "aal1"}';
      `);
      const enrolledAal1Role = await db.query(`select private.current_staff_role() as role;`);
      expect(enrolledAal1Role.rows[0].role).toBeNull();

      const enrolledAal1HasRole = await db.query(`select private.has_staff_role(array['admin', 'superadmin']::public.staff_role[]) as allowed;`);
      expect(enrolledAal1HasRole.rows[0].allowed).toBe(false);

      const enrolledAal1Satisfied = await db.query(`select private.staff_mfa_is_satisfied() as satisfied;`);
      expect(enrolledAal1Satisfied.rows[0].satisfied).toBe(false);

      // Case B2: Enrolled staff with missing AAL claim fails closed
      await db.exec(`
        set request.jwt.claims = '{"sub": "${TEST_ADMIN_ID}", "role": "authenticated"}';
      `);
      const enrolledMissingAalRole = await db.query(`select private.current_staff_role() as role;`);
      expect(enrolledMissingAalRole.rows[0].role).toBeNull();

      const enrolledMissingAalHasRole = await db.query(`select private.has_staff_role(array['admin', 'superadmin']::public.staff_role[]) as allowed;`);
      expect(enrolledMissingAalHasRole.rows[0].allowed).toBe(false);

      const enrolledMissingAalSatisfied = await db.query(`select private.staff_mfa_is_satisfied() as satisfied;`);
      expect(enrolledMissingAalSatisfied.rows[0].satisfied).toBe(false);

      // Case B2b: Enrolled staff with explicit JSON null AAL claim ("aal": null) strictly fails closed (returns boolean false, not null)
      await db.exec(`
        set request.jwt.claims = '{"sub": "${TEST_ADMIN_ID}", "role": "authenticated", "aal": null}';
      `);
      const enrolledNullAalSatisfied = await db.query<{ satisfied: any }>(
        `select private.staff_mfa_is_satisfied() as satisfied;`
      );
      expect(enrolledNullAalSatisfied.rows[0].satisfied).toBe(false);

      const enrolledNullAalRole = await db.query(`select private.current_staff_role() as role;`);
      expect(enrolledNullAalRole.rows[0].role).toBeNull();

      const enrolledNullAalHasRole = await db.query(
        `select private.has_staff_role(array['admin', 'superadmin']::public.staff_role[]) as allowed;`
      );
      expect(enrolledNullAalHasRole.rows[0].allowed).toBe(false);

      // Case B3: Enrolled staff at AAL2 is allowed
      await db.exec(`
        set request.jwt.claims = '{"sub": "${TEST_ADMIN_ID}", "role": "authenticated", "aal": "aal2"}';
      `);
      const enrolledAal2Role = await db.query(`select private.current_staff_role() as role;`);
      expect(enrolledAal2Role.rows[0].role).toBe('admin');

      const enrolledAal2HasRole = await db.query(`select private.has_staff_role(array['admin', 'superadmin']::public.staff_role[]) as allowed;`);
      expect(enrolledAal2HasRole.rows[0].allowed).toBe(true);

      const enrolledAal2Satisfied = await db.query(`select private.staff_mfa_is_satisfied() as satisfied;`);
      expect(enrolledAal2Satisfied.rows[0].satisfied).toBe(true);

      // Case B4: Factor deletion / reset immediately restores password-only access (AAL1 allowed)
      await db.exec(`
        delete from auth.mfa_factors where user_id = '${TEST_ADMIN_ID}';
      `);

      await db.exec(`
        set request.jwt.claims = '{"sub": "${TEST_ADMIN_ID}", "role": "authenticated", "aal": "aal1"}';
      `);
      const postResetRole = await db.query(`select private.current_staff_role() as role;`);
      expect(postResetRole.rows[0].role).toBe('admin');

      const postResetHasRole = await db.query(`select private.has_staff_role(array['admin', 'superadmin']::public.staff_role[]) as allowed;`);
      expect(postResetHasRole.rows[0].allowed).toBe(true);

      // Case C: Genuine anonymous visitor without AAL2 remains functional
      await db.exec(`
        set request.jwt.claims = '{"sub": "${TEST_VISITOR_ID}", "role": "authenticated"}';
      `);

      const portalActorRes = await db.query(`select private.is_portal_actor() as is_portal;`);
      expect(portalActorRes.rows[0].is_portal).toBe(true);

      // Case D: Unauthenticated caller fails closed
      await db.exec(`
        set request.jwt.claims = '{"role": "anon"}';
      `);
      const unauthSatisfied = await db.query(`select private.staff_mfa_is_satisfied() as satisfied;`);
      expect(unauthSatisfied.rows[0].satisfied).toBe(false);
    }, 60000);
  });

  describe('7. Direct SECURITY DEFINER RPC Optional Staff TOTP MFA Enforcement (PGlite)', () => {
    it('verifies guard_recover_pass_action, guard_search_pending_queue, and guard_sync_offline_event enforce optional staff TOTP MFA (AAL1 for unenrolled, AAL2 for enrolled)', async () => {
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

      // 0. Case 0: Unenrolled staff at AAL1 can execute RPCs (MFA is optional)
      await db.exec(`
        set request.jwt.claims = '{"sub": "${TEST_ADMIN_ID}", "role": "authenticated", "aal": "aal1"}';
      `);
      const unenrolledSearch = await db.query<{ res: any[] }>(
        `select api.guard_search_pending_queue('Test Visitor', 10) as res;`
      );
      expect(Array.isArray(unenrolledSearch.rows[0].res)).toBe(true);
      expect(unenrolledSearch.rows[0].res.length).toBeGreaterThan(0);
      expect(unenrolledSearch.rows[0].res[0].id).toBe(TEST_PASS_ID);

      // Incomplete / unverified factor does not block unenrolled staff at AAL1
      await db.exec(`
        insert into auth.mfa_factors (user_id, status, factor_type)
        values ('${TEST_ADMIN_ID}', 'unverified', 'totp');
      `);
      const unverifiedSearch = await db.query<{ res: any[] }>(
        `select api.guard_search_pending_queue('Test Visitor', 10) as res;`
      );
      expect(unverifiedSearch.rows[0].res.length).toBeGreaterThan(0);

      // Now enroll staff with a verified factor
      await db.exec(`
        update auth.mfa_factors set status = 'verified' where user_id = '${TEST_ADMIN_ID}';
      `);

      // 1. api.guard_recover_pass_action
      // Enrolled staff at AAL1 -> throws mfa_required
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

      // Explicit null AAL claim ("aal": null) -> throws mfa_required (fail closed, no three-valued logic bypass)
      await db.exec(`
        set request.jwt.claims = '{"sub": "${TEST_ADMIN_ID}", "role": "authenticated", "aal": null}';
      `);
      await expect(
        db.query(`select api.guard_recover_pass_action('${TEST_PASS_ID}'::uuid, 'approve_entry');`)
      ).rejects.toThrow(/mfa_required/);

      // Enrolled staff at AAL2 -> succeeds for approve_entry
      await db.exec(`
        set request.jwt.claims = '{"sub": "${TEST_ADMIN_ID}", "role": "authenticated", "aal": "aal2"}';
      `);
      const recoverRes = await db.query<{ res: any }>(
        `select api.guard_recover_pass_action('${TEST_PASS_ID}'::uuid, 'approve_entry') as res;`
      );
      expect(recoverRes.rows[0].res.success).toBe(true);
      expect(recoverRes.rows[0].res.status).toBe('inside');

      // Enrolled staff at AAL2 -> succeeds for record_exit (verifying no column crash and time_out set)
      const exitRes = await db.query<{ res: any }>(
        `select api.guard_recover_pass_action('${TEST_PASS_ID}'::uuid, 'record_exit') as res;`
      );
      expect(exitRes.rows[0].res.success).toBe(true);
      expect(exitRes.rows[0].res.status).toBe('exited');

      // Reset pass back to pending for reject_entry
      await db.exec(`update public.passes set status = 'pending', time_in = null, time_out = null, rejection_reason = null where id = '${TEST_PASS_ID}';`);
      const rejectRes = await db.query<{ res: any }>(
        `select api.guard_recover_pass_action('${TEST_PASS_ID}'::uuid, 'reject_entry', 'Denied by recovery guard') as res;`
      );
      expect(rejectRes.rows[0].res.success).toBe(true);
      expect(rejectRes.rows[0].res.status).toBe('rejected');

      // Assert that public.audit_events rows were written for each recovery action
      const auditApprove = await db.query<{ action: string; outcome: string; actor_id: string }>(
        `select action, outcome, actor_id from public.audit_events where action = 'gate.visitor_recovery_approve' and target_id = '${TEST_PASS_ID}';`
      );
      expect(auditApprove.rows.length).toBe(1);
      expect(auditApprove.rows[0].actor_id).toBe(TEST_ADMIN_ID);
      expect(auditApprove.rows[0].outcome).toBe('success');

      const auditExit = await db.query<{ action: string; outcome: string; actor_id: string }>(
        `select action, outcome, actor_id from public.audit_events where action = 'gate.visitor_recovery_exit' and target_id = '${TEST_PASS_ID}';`
      );
      expect(auditExit.rows.length).toBe(1);
      expect(auditExit.rows[0].actor_id).toBe(TEST_ADMIN_ID);
      expect(auditExit.rows[0].outcome).toBe('success');

      const auditReject = await db.query<{ action: string; outcome: string; actor_id: string }>(
        `select action, outcome, actor_id from public.audit_events where action = 'gate.visitor_recovery_reject' and target_id = '${TEST_PASS_ID}';`
      );
      expect(auditReject.rows.length).toBe(1);
      expect(auditReject.rows[0].actor_id).toBe(TEST_ADMIN_ID);
      expect(auditReject.rows[0].outcome).toBe('success');

      // 2. api.guard_search_pending_queue
      // Reset pass back to pending for queue search, clearing rejection_reason and resetting version to 2
      await db.exec(`update public.passes set status = 'pending', rejection_reason = null, time_in = null, time_out = null, version = 2 where id = '${TEST_PASS_ID}';`);

      // Enrolled staff at AAL1 -> throws mfa_required
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

      // Explicit null AAL claim -> throws mfa_required
      await db.exec(`
        set request.jwt.claims = '{"sub": "${TEST_ADMIN_ID}", "role": "authenticated", "aal": null}';
      `);
      await expect(
        db.query(`select api.guard_search_pending_queue('Test Visitor', 10);`)
      ).rejects.toThrow(/mfa_required/);

      // Enrolled staff at AAL2 -> succeeds and returns results
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
      // Enrolled staff at AAL1 -> throws mfa_required
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

      // Explicit null AAL claim -> throws mfa_required
      await db.exec(`
        set request.jwt.claims = '{"sub": "${TEST_ADMIN_ID}", "role": "authenticated", "aal": null}';
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

      // Enrolled staff at AAL2 -> succeeds past auth
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

      // 3b. Factor Reset: deleting verified factor restores AAL1 execution immediately
      await db.exec(`delete from auth.mfa_factors where user_id = '${TEST_ADMIN_ID}';`);
      await db.exec(`update public.passes set status = 'pending' where id = '${TEST_PASS_ID}';`);
      await db.exec(`
        set request.jwt.claims = '{"sub": "${TEST_ADMIN_ID}", "role": "authenticated", "aal": "aal1"}';
      `);
      const postResetSearch = await db.query<{ res: any[] }>(
        `select api.guard_search_pending_queue('Test Visitor', 10) as res;`
      );
      expect(postResetSearch.rows[0].res.length).toBeGreaterThan(0);

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
