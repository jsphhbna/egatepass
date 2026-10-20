import { describe, it, expect, vi, beforeEach } from 'vitest';
import resetPasswordHandler from '../api/auth/reset-password.js';
import updateDeviceAuthHandler from '../api/update-device-auth.js';
import completePasswordChangeHandler from '../api/auth/complete-password-change.js';
import { setServerSupabaseClientsForTest } from '../server/supabase.js';

function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.signature`;
}

describe('REPAIR GROUP A: Password Recovery Authorization & Credential Governance Test Matrix', () => {
  const STAFF_ID = '00000000-0000-4000-a000-000000000010';
  const SUPERADMIN_ID = '00000000-0000-4000-a000-000000000001';
  const DEVICE_ID = '00000000-0000-4000-a000-000000000003';
  const ANONYMOUS_ID = '00000000-0000-4000-a000-000000000005';

  let updatedPasswords: Record<string, string> = {};
  let auditLogs: any[] = [];
  let reconciliationLogs: any[] = [];
  let failAuditInsert = false;
  let guardMustChangePassword = false;
  let failGuardFinalizeRpc = false;

  function createMockSupabase() {
    return {
      auth: {
        getUser: vi.fn(async (token: string) => {
          try {
            const parts = token.split('.');
            if (parts.length < 2) return { data: { user: null }, error: new Error('invalid_token') };
            const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
            if (!payload.sub) return { data: { user: null }, error: new Error('invalid_sub') };
            return {
              data: {
                user: {
                  id: payload.sub,
                  email: payload.email ?? null,
                  is_anonymous: payload.is_anonymous ?? false,
                  email_confirmed_at: '2026-01-01T00:00:00Z',
                },
              },
              error: null,
            };
          } catch {
            return { data: { user: null }, error: new Error('parse_error') };
          }
        }),
        signInWithPassword: vi.fn(async ({ email }: any) => {
          return { data: { user: { id: STAFF_ID, email } }, error: null };
        }),
        signOut: vi.fn(async () => ({ error: null })),
        admin: {
          getUserById: vi.fn(async (uid: string) => ({
            data: { user: { id: uid, email: 'kiosk-01@devices.egatepass.invalid' } },
            error: null,
          })),
          updateUserById: vi.fn(async (uid: string, payload: any) => {
            if (payload.password) {
              updatedPasswords[uid] = payload.password;
            }
            return { data: { user: { id: uid } }, error: null };
          }),
        },
      },
      schema: (_s: string) => ({
        rpc: vi.fn(async (fn: string) => {
          if (fn === 'finalize_guard_password_change') {
            if (failGuardFinalizeRpc) {
              return { data: null, error: new Error('RPC failure on finalize') };
            }
            return { data: true, error: null };
          }
          return { data: null, error: new Error(`Unknown RPC ${fn}`) };
        }),
      }),
      from: (table: string) => {
        let selectedCol = '';
        let filterCol = '';
        let filterVal: any = null;

        const chain: any = {
          select: (cols: string) => {
            selectedCol = cols;
            return chain;
          },
          eq: (col: string, val: any) => {
            filterCol = col;
            filterVal = val;
            return chain;
          },
          maybeSingle: async () => {
            if (table === 'devices') {
              if (filterCol === 'user_id' && filterVal === DEVICE_ID) {
                return { data: { id: 'dev-1', user_id: DEVICE_ID, alias: 'kiosk-01', type: 'kiosk', status: 'active', deleted_at: null }, error: null };
              }
              return { data: null, error: null };
            }
            if (table === 'staff_profiles') {
              if (filterCol === 'user_id' && filterVal === STAFF_ID) {
                return { data: { role: 'guard', active: true, must_change_password: guardMustChangePassword }, error: null };
              }
              if (filterCol === 'user_id' && filterVal === SUPERADMIN_ID) {
                return { data: { role: 'superadmin', active: true, must_change_password: false, privacy_accepted_at: '2026-01-01T00:00:00Z' }, error: null };
              }
              return { data: null, error: null };
            }
            return { data: null, error: null };
          },
          insert: async (data: any) => {
            if (table === 'audit_events') {
              if (failAuditInsert) {
                return { data: null, error: new Error('Audit insert failure') };
              }
              auditLogs.push(data);
            }
            if (table === 'reconciliation_tasks') {
              reconciliationLogs.push(data);
            }
            return { data, error: null };
          },
          update: (data: any) => {
            return {
              eq: async (col: string, val: any) => {
                if (table === 'staff_profiles' && failStaffProfileUpdate) {
                  return { error: new Error('Staff profile update failed') };
                }
                return { error: null };
              },
            };
          },
        };
        return chain;
      },
    };
  }

  beforeEach(() => {
    vi.restoreAllMocks();
    updatedPasswords = {};
    auditLogs = [];
    reconciliationLogs = [];
    failAuditInsert = false;
    guardMustChangePassword = false;
    failGuardFinalizeRpc = false;
    const mockClient = createMockSupabase();
    setServerSupabaseClientsForTest({
      admin: mockClient as any,
      client: mockClient as any,
      passwordVerifier: mockClient as any,
    });
  });

  // 1. Forged sessionStorage / localStorage test
  it('1. Forged client storage / query params (?type=recovery) cannot authorize reset without genuine token', async () => {
    const req = new Request('http://localhost/api/auth/reset-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ newPassword: 'StrongPassword123!' }),
    });

    const res = await resetPasswordHandler.fetch(req);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe('authentication_required');
  });

  // 2. Ordinary active staff session without recovery AMR
  it('2. Ordinary active staff session without recovery AMR is DENIED from recovery flow (403 recovery_session_required)', async () => {
    const normalStaffJwt = makeJwt({
      sub: STAFF_ID,
      email: 'guard@earist.edu.ph',
      role: 'authenticated',
      amr: [{ method: 'password', timestamp: Date.now() }],
    });

    const req = new Request('http://localhost/api/auth/reset-password', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${normalStaffJwt}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ newPassword: 'NewStrongPassword123!' }),
    });

    const res = await resetPasswordHandler.fetch(req);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('recovery_session_required');
  });

  // 3. Ordinary device session attempting recovery
  it('3. Ordinary device session attempting password recovery is DENIED (403 device_password_change_forbidden)', async () => {
    const deviceJwt = makeJwt({
      sub: DEVICE_ID,
      email: 'kiosk-01@devices.egatepass.invalid',
      role: 'authenticated',
      amr: [{ method: 'recovery', timestamp: Date.now() }],
    });

    const req = new Request('http://localhost/api/auth/reset-password', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${deviceJwt}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ newPassword: 'NewDevicePassword123!' }),
    });

    const res = await resetPasswordHandler.fetch(req);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('device_password_change_forbidden');
  });

  // 4. Anonymous Portal session attempting recovery
  it('4. Anonymous Portal session attempting password recovery is DENIED (403 anonymous_recovery_not_allowed)', async () => {
    const anonJwt = makeJwt({
      sub: ANONYMOUS_ID,
      role: 'authenticated',
      is_anonymous: true,
      amr: [{ method: 'recovery', timestamp: Date.now() }],
    });

    const req = new Request('http://localhost/api/auth/reset-password', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${anonJwt}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ newPassword: 'HackedPassword123!' }),
    });

    const res = await resetPasswordHandler.fetch(req);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('anonymous_recovery_not_allowed');
  });

  // 5. Tampered or expired/used session token
  it('5. Invalid or unauthenticated session token is rejected with 401 invalid_session', async () => {
    const invalidJwt = 'garbage.invalid-token.signature';

    const req = new Request('http://localhost/api/auth/reset-password', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${invalidJwt}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ newPassword: 'ValidPassword123!' }),
    });

    const res = await resetPasswordHandler.fetch(req);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe('invalid_session');
  });

  // 6. Genuine recovery flow with recovery AMR is ALLOWED
  it('6. Genuine recovery flow with recovery AMR is ALLOWED and updates password', async () => {
    const recoveryJwt = makeJwt({
      sub: STAFF_ID,
      email: 'guard@earist.edu.ph',
      role: 'authenticated',
      amr: [{ method: 'recovery', timestamp: Date.now() }],
    });

    const req = new Request('http://localhost/api/auth/reset-password', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${recoveryJwt}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ newPassword: 'NewStrongPassword123!' }),
    });

    const res = await resetPasswordHandler.fetch(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(updatedPasswords[STAFF_ID]).toBe('NewStrongPassword123!');
    expect(auditLogs.some((a) => a.action === 'staff.password_reset')).toBe(true);
  });

  // 6b. Password reset audit failure returns truthful partial success
  it('6b. Password reset audit failure returns partial success and records reconciliation', async () => {
    failAuditInsert = true;
    const recoveryJwt = makeJwt({
      sub: STAFF_ID,
      email: 'guard@earist.edu.ph',
      role: 'authenticated',
      amr: [{ method: 'recovery', timestamp: Date.now() }],
    });

    const req = new Request('http://localhost/api/auth/reset-password', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${recoveryJwt}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ newPassword: 'NewStrongPassword123!' }),
    });

    const res = await resetPasswordHandler.fetch(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.result).toBe('partial');
    expect(body.passwordChanged).toBe(true);
    expect(body.auditPending).toBe(true);
    expect(body.reconciliationRecorded).toBe(true);
    expect(updatedPasswords[STAFF_ID]).toBe('NewStrongPassword123!');
    expect(reconciliationLogs.some((r) => r.operation === 'staff.password_reset.audit_failed')).toBe(true);
  });

  // 7. Password policy enforcement on recovery
  it('7. Password policy enforcement: weak or short password is rejected with 400', async () => {
    const recoveryJwt = makeJwt({
      sub: STAFF_ID,
      email: 'guard@earist.edu.ph',
      role: 'authenticated',
      amr: [{ method: 'recovery', timestamp: Date.now() }],
    });

    const req = new Request('http://localhost/api/auth/reset-password', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${recoveryJwt}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ newPassword: 'short' }),
    });

    const res = await resetPasswordHandler.fetch(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('invalid_request');
  });

  // 8. Super Admin device credential management is ALLOWED
  it('8. Super Admin updating device credentials via update-device-auth is ALLOWED', async () => {
    const superadminJwt = makeJwt({
      sub: SUPERADMIN_ID,
      email: 'superadmin@earist.edu.ph',
      role: 'authenticated',
      amr: [{ method: 'password', timestamp: Date.now() }],
    });

    const req = new Request('http://localhost/api/update-device-auth', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${superadminJwt}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        targetUid: DEVICE_ID,
        password: 'NewDevicePassword123!',
      }),
    });

    const res = await updateDeviceAuthHandler.fetch(req);
    expect(res.status).toBe(200);
    expect(updatedPasswords[DEVICE_ID]).toBe('NewDevicePassword123!');
  });

  // 9. Device attempting self-change via update-device-auth is DENIED
  it('9. Device attempting self-change via api/update-device-auth is DENIED with 403', async () => {
    const deviceToken = makeJwt({
      sub: DEVICE_ID,
      email: 'kiosk-01@devices.egatepass.invalid',
      role: 'authenticated',
      amr: [{ method: 'password' }],
    });

    const req = new Request('http://localhost/api/update-device-auth', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${deviceToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        targetUid: DEVICE_ID,
        password: 'AttemptedDevicePassword123!',
      }),
    });

    const res = await updateDeviceAuthHandler.fetch(req);
    expect(res.status).toBe(403);
  });

  // 10. Device attempting self-change via complete-password-change is DENIED
  it('10. Device attempting self-change via complete-password-change is DENIED with 403', async () => {
    const deviceToken = makeJwt({
      sub: DEVICE_ID,
      email: 'kiosk-01@devices.egatepass.invalid',
      role: 'authenticated',
      amr: [{ method: 'password' }],
    });

    const req = new Request('http://localhost/api/auth/complete-password-change', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${deviceToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        currentPassword: 'OldPassword123!',
        newPassword: 'NewPassword123!',
      }),
    });

    const res = await completePasswordChangeHandler.fetch(req);
    expect(res.status).toBe(403);
  });

  // 11. Staff password change finalization pending reports truthful 503
  it('11. Staff password change finalization failure returns 503 and records reconciliation', async () => {
    guardMustChangePassword = true;
    failGuardFinalizeRpc = true;
    const staffToken = makeJwt({
      sub: STAFF_ID,
      email: 'guard@earist.edu.ph',
      role: 'authenticated',
      amr: [{ method: 'password' }],
    });

    const req = new Request('http://localhost/api/auth/complete-password-change', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${staffToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        currentPassword: 'OldPassword123!',
        newPassword: 'NewStrongPassword123!',
      }),
    });

    const res = await completePasswordChangeHandler.fetch(req);
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe('password_changed_finalization_pending');
    expect(body.passwordChanged).toBe(true);
    expect(body.reconciliationRecorded).toBe(true);
    expect(reconciliationLogs.some((r) => r.operation === 'guard.password_change_finalize')).toBe(true);
  });
});
