import { describe, it, expect, vi } from 'vitest';
import updateUserHandler from '../server/routes/system/update-user.js';
import { setServerSupabaseClientsForTest } from '../server/supabase.js';
import { readFileSync } from 'node:fs';

function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.signature`;
}

describe('PATCH 4: Admin User Partial-Success Contract Tests', () => {
  const SUPERADMIN_ID = '00000000-0000-4000-a000-000000000001';
  const TARGET_GUARD_ID = '00000000-0000-4000-a000-000000000088';
  const VALID_BEARER = `Bearer ${makeJwt({ sub: SUPERADMIN_ID, role: 'authenticated' })}`;

  const adminUsersSrc = readFileSync('src/pages/AdminUsers.tsx', 'utf8');

  it('4A. Deactivate: DB success + Auth ban failure returns 503 partial success body and records reconciliation', async () => {
    let reconciliationRecorded = false;
    let recordedPayload: any = null;

    const mockAdmin = {
      from: vi.fn((table: string) => ({
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            maybeSingle: vi.fn(async () => {
              if (table === 'staff_profiles') {
                return {
                  data: { role: 'superadmin', active: true, must_change_password: false, privacy_accepted_at: '2026-01-01T00:00:00Z' },
                  error: null,
                };
              }
              return { data: null, error: null };
            }),
          })),
        })),
        insert: vi.fn(async (payload: any) => {
          if (table === 'reconciliation_tasks') {
            reconciliationRecorded = true;
            recordedPayload = payload;
            return { error: null };
          }
          return { error: null };
        }),
      })),
      schema: vi.fn(() => ({
        rpc: vi.fn(async (fn: string) => {
          if (fn === 'update_staff_profile') {
            return { data: true, error: null };
          }
          return { data: null, error: null };
        }),
      })),
      auth: {
        getUser: vi.fn(async () => ({
          data: {
            user: { id: SUPERADMIN_ID, email: 'super@earist.edu.ph', is_anonymous: false, email_confirmed_at: '2026-01-01T00:00:00Z' },
          },
          error: null,
        })),
        admin: {
          updateUserById: vi.fn(async () => ({
            data: null,
            error: { code: 'auth_provider_timeout', message: 'Auth service timeout' },
          })),
        },
      },
    };

    setServerSupabaseClientsForTest({
      admin: mockAdmin as any,
      anon: {} as any,
      passwordVerifier: {} as any,
    });

    const req = new Request('http://localhost/api/update-user', {
      method: 'POST',
      headers: {
        authorization: VALID_BEARER,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        targetUid: TARGET_GUARD_ID,
        active: false,
      }),
    });

    const res = await updateUserHandler.fetch(req);
    expect(res.status).toBe(503);

    const body = await res.json();
    expect(body).toEqual({
      error: 'profile_updated_auth_reconciliation_required',
      result: 'partial',
      profileUpdated: true,
      authSynchronized: false,
      reconciliationRequired: true,
      message: 'The staff profile was updated, but authentication synchronization requires reconciliation.',
    });

    expect(reconciliationRecorded).toBe(true);
    expect(recordedPayload.operation).toBe('staff.auth_status');
    expect(recordedPayload.reference_id).toBe(TARGET_GUARD_ID);
  });

  it('4A. Reactivate: DB success + Auth unban failure returns 503 partial success body and records reconciliation', async () => {
    let reconciliationRecorded = false;

    const mockAdmin = {
      from: vi.fn((table: string) => ({
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            maybeSingle: vi.fn(async () => {
              if (table === 'staff_profiles') {
                return {
                  data: {
                    role: 'superadmin',
                    active: true,
                    must_change_password: false,
                    privacy_accepted_at: '2026-01-01T00:00:00Z',
                  },
                  error: null,
                };
              }
              return { data: null, error: null };
            }),
          })),
        })),
        insert: vi.fn(async (payload: any) => {
          if (table === 'reconciliation_tasks') {
            reconciliationRecorded = true;
            return { error: null };
          }
          return { error: null };
        }),
      })),
      schema: vi.fn(() => ({
        rpc: vi.fn(async (fn: string) => {
          if (fn === 'update_staff_profile') {
            return { data: true, error: null };
          }
          return { data: null, error: null };
        }),
      })),
      auth: {
        getUser: vi.fn(async () => ({
          data: {
            user: {
              id: SUPERADMIN_ID,
              email: 'super@earist.edu.ph',
              is_anonymous: false,
              email_confirmed_at: '2026-01-01T00:00:00Z',
            },
          },
          error: null,
        })),
        admin: {
          updateUserById: vi.fn(async () => ({
            data: null,
            error: { code: 'auth_down', message: 'Auth service down' },
          })),
        },
      },
    };

    setServerSupabaseClientsForTest({
      admin: mockAdmin as any,
      anon: {} as any,
      passwordVerifier: {} as any,
    });

    const req = new Request('http://localhost/api/update-user', {
      method: 'POST',
      headers: {
        authorization: VALID_BEARER,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        targetUid: TARGET_GUARD_ID,
        active: true,
      }),
    });

    const res = await updateUserHandler.fetch(req);
    expect(res.status).toBe(503);

    const body = await res.json();
    expect(body.result).toBe('partial');
    expect(body.profileUpdated).toBe(true);
    expect(body.authSynchronized).toBe(false);
    expect(body.reconciliationRequired).toBe(true);
    expect(reconciliationRecorded).toBe(true);
  });

  it('4B. AdminUsers.tsx inspects result === "partial" before throwing, refreshes staff list, and shows warning toast', () => {
    // updateUserAccount must inspect body.result === 'partial' and return body
    expect(adminUsersSrc).toContain("body?.result === 'partial'");
    expect(adminUsersSrc).toContain("body.profileUpdated === true");
    expect(adminUsersSrc).toContain("body.reconciliationRequired === true");

    // handleDeactivate, toggleStatus, handleRoleChange must handle partial result with warning toast and reload
    expect(adminUsersSrc).toContain("res?.result === 'partial' && res.profileUpdated && res.reconciliationRequired");
    expect(adminUsersSrc).toContain("toast.warning");
    expect(adminUsersSrc).toContain("authentication synchronization needs reconciliation");
    expect(adminUsersSrc).toContain("loadUsers()");
  });

  it('4C. Decommission immutability: target_decommissioned RPC error maps to HTTP 409 and does not call auth updateUserById', async () => {
    const mockUpdateUserById = vi.fn();

    const mockAdmin = {
      from: vi.fn((table: string) => ({
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            maybeSingle: vi.fn(async () => {
              if (table === 'staff_profiles') {
                return {
                  data: { role: 'superadmin', active: true, must_change_password: false, privacy_accepted_at: '2026-01-01T00:00:00Z' },
                  error: null,
                };
              }
              return { data: null, error: null };
            }),
          })),
        })),
      })),
      schema: vi.fn(() => ({
        rpc: vi.fn(async (fn: string) => {
          if (fn === 'update_staff_profile') {
            return { data: null, error: { code: 'P0004', message: 'target_decommissioned' } };
          }
          return { data: null, error: null };
        }),
      })),
      auth: {
        getUser: vi.fn(async () => ({
          data: {
            user: { id: SUPERADMIN_ID, email: 'super@earist.edu.ph', is_anonymous: false, email_confirmed_at: '2026-01-01T00:00:00Z' },
          },
          error: null,
        })),
        admin: {
          updateUserById: mockUpdateUserById,
        },
      },
    };

    setServerSupabaseClientsForTest({
      admin: mockAdmin as any,
      anon: {} as any,
      passwordVerifier: {} as any,
    });

    const req = new Request('http://localhost/api/update-user', {
      method: 'POST',
      headers: {
        authorization: VALID_BEARER,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        targetUid: TARGET_GUARD_ID,
        active: true,
      }),
    });

    const res = await updateUserHandler.fetch(req);
    expect(res.status).toBe(409);

    const body = await res.json();
    expect(body).toEqual({ error: 'target_decommissioned' });

    // CRITICAL INVARIANT: Auth updateUserById must never be called for a decommissioned target
    expect(mockUpdateUserById).not.toHaveBeenCalled();
  });

  it('4D. Preserves last Super Admin 23514 mapping to HTTP 409 cannot_remove_last_superadmin without calling auth updateUserById', async () => {
    const mockUpdateUserById = vi.fn();

    const mockAdmin = {
      from: vi.fn((table: string) => ({
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            maybeSingle: vi.fn(async () => {
              if (table === 'staff_profiles') {
                return {
                  data: { role: 'superadmin', active: true, must_change_password: false, privacy_accepted_at: '2026-01-01T00:00:00Z' },
                  error: null,
                };
              }
              return { data: null, error: null };
            }),
          })),
        })),
      })),
      schema: vi.fn(() => ({
        rpc: vi.fn(async (fn: string) => {
          if (fn === 'update_staff_profile') {
            return { data: null, error: { code: '23514', message: 'cannot remove last superadmin' } };
          }
          return { data: null, error: null };
        }),
      })),
      auth: {
        getUser: vi.fn(async () => ({
          data: {
            user: { id: SUPERADMIN_ID, email: 'super@earist.edu.ph', is_anonymous: false, email_confirmed_at: '2026-01-01T00:00:00Z' },
          },
          error: null,
        })),
        admin: {
          updateUserById: mockUpdateUserById,
        },
      },
    };

    setServerSupabaseClientsForTest({
      admin: mockAdmin as any,
      anon: {} as any,
      passwordVerifier: {} as any,
    });

    const req = new Request('http://localhost/api/update-user', {
      method: 'POST',
      headers: {
        authorization: VALID_BEARER,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        targetUid: TARGET_GUARD_ID,
        active: false,
      }),
    });

    const res = await updateUserHandler.fetch(req);
    expect(res.status).toBe(409);

    const body = await res.json();
    expect(body).toEqual({ error: 'cannot_remove_last_superadmin' });
    expect(mockUpdateUserById).not.toHaveBeenCalled();
  });

  it('4E. AdminUsers.tsx displays decommission reason and target_decommissioned user message', () => {
    const adminUsersSrcLatest = readFileSync('src/pages/AdminUsers.tsx', 'utf8');
    expect(adminUsersSrcLatest).toContain("body?.error === 'target_decommissioned'");
    expect(adminUsersSrcLatest).toContain('This staff account has been permanently decommissioned and can no longer be modified.');
    expect(adminUsersSrcLatest).toContain('Reason: {user.decommissionReason}');
  });
});
