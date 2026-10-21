import { describe, it, expect, vi, beforeEach } from 'vitest';
import resetPasswordHandler from '../server/routes/auth/reset-password.js';
import updateDeviceAuthHandler from '../server/routes/device/update-device-auth.js';
import completePasswordChangeHandler from '../server/routes/auth/complete-password-change.js';
import decideVisitHandler from '../server/routes/gate/decide-visit.js';
import adminSettingsHandler from '../server/routes/admin/settings.js';
import { setServerSupabaseClientsForTest } from '../server/supabase.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

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
  let failDeviceQuery = false;
  let failProfileQuery = false;
  let lastDeviceSelectedCols = '';

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
          if (fn === 'decide_visit') {
            return { data: 'approved', error: null };
          }
          return { data: null, error: new Error(`Unknown RPC ${fn}`) };
        }),
      }),
      from: (table: string) => {
        let filterCol = '';
        let filterVal: any = null;

        const chain: any = {
          select: (cols?: string) => {
            if (table === 'devices' && typeof cols === 'string') {
              lastDeviceSelectedCols = cols;
            }
            return chain;
          },
          eq: (col: string, val: any) => {
            filterCol = col;
            filterVal = val;
            return chain;
          },
          maybeSingle: async () => {
            if (table === 'devices') {
              if (failDeviceQuery) {
                return { data: null, error: new Error('Database connection failed on devices') };
              }
              if (filterCol === 'user_id' && (filterVal === DEVICE_ID || filterVal === '00000000-0000-4000-a000-000000000099')) {
                return { data: { user_id: filterVal, alias: 'kiosk-01', type: 'kiosk', status: 'active', deleted_at: null }, error: null };
              }
              return { data: null, error: null };
            }
            if (table === 'staff_profiles') {
              if (failProfileQuery) {
                return { data: null, error: new Error('Database connection failed on staff_profiles') };
              }
              if (filterCol === 'user_id' && filterVal === STAFF_ID) {
                return { data: { role: 'guard', active: true, must_change_password: guardMustChangePassword, privacy_accepted_at: '2026-01-01T00:00:00Z' }, error: null };
              }
              if (filterCol === 'user_id' && filterVal === SUPERADMIN_ID) {
                return { data: { role: 'superadmin', active: true, must_change_password: false, privacy_accepted_at: '2026-01-01T00:00:00Z' }, error: null };
              }
              return { data: null, error: null };
            }
            if (table === 'app_settings') {
              return {
                data: {
                  singleton: true,
                  working_hours_start: '07:00:00',
                  working_hours_end: '18:00:00',
                  timezone: 'Asia/Manila',
                  scheduling_days_ahead: 7,
                  peak_mode: 'off',
                  visit_purposes: ['academic'],
                  visitor_retention_days: 90,
                  audit_retention_days: 365,
                  reconciliation_retention_days: 90,
                  automatic_cleanup_enabled: true,
                },
                error: null,
              };
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
          update: () => ({
            eq: async () => ({ error: null }),
          }),
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
    failDeviceQuery = false;
    failProfileQuery = false;
    lastDeviceSelectedCols = '';
    const mockClient = createMockSupabase();
    setServerSupabaseClientsForTest({
      admin: mockClient as any,
      client: mockClient as any,
      passwordVerifier: mockClient as any,
    });
  });

  // A & B. Forged sessionStorage / localStorage and query params cannot authorize reset
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

  // C. Ordinary active staff session without recovery AMR
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
      body: JSON.stringify({ newPassword: 'HackedPassword123!' }),
    });

    const res = await resetPasswordHandler.fetch(req);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('recovery_session_required');
  });

  // D. Generic OTP / non-recovery AMR session cannot invoke recovery reset endpoint
  it('2b. Generic OTP / non-recovery session is DENIED from recovery flow (403 recovery_session_required)', async () => {
    const otpStaffJwt = makeJwt({
      sub: STAFF_ID,
      email: 'guard@earist.edu.ph',
      role: 'authenticated',
      amr: [{ method: 'otp', timestamp: Date.now() }],
    });

    const req = new Request('http://localhost/api/auth/reset-password', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${otpStaffJwt}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ newPassword: 'HackedPassword123!' }),
    });

    const res = await resetPasswordHandler.fetch(req);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('recovery_session_required');
  });

  // 3. Device session attempting recovery (email suffix)
  it('3. Device session attempting password recovery is DENIED (403 device_password_change_forbidden)', async () => {
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
      body: JSON.stringify({ newPassword: 'HackedPassword123!' }),
    });

    const res = await resetPasswordHandler.fetch(req);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('device_password_change_forbidden');
  });

  // 3b. Device without @devices.egatepass.invalid email but with matching devices row is DENIED
  it('3b. Device whose auth identity matches public.devices row without device email suffix is DENIED (403 device_password_change_forbidden)', async () => {
    const stealthDeviceUid = '00000000-0000-4000-a000-000000000099';
    const stealthJwt = makeJwt({
      sub: stealthDeviceUid,
      email: 'stealth-device@customdomain.com', // Non-standard email format
      role: 'authenticated',
      amr: [{ method: 'recovery', timestamp: Date.now() }],
    });

    const req = new Request('http://localhost/api/auth/reset-password', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${stealthJwt}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ newPassword: 'HackedPassword123!' }),
    });

    const res = await resetPasswordHandler.fetch(req);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('device_password_change_forbidden');
  });

  // 3c. Fail-closed: DB error during device lookup returns 503 and changes nothing
  it('3c. FAIL-CLOSED: Database error during authoritative device lookup returns 503 and aborts without mutating password or logging success', async () => {
    failDeviceQuery = true;
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
      body: JSON.stringify({ newPassword: 'NewValidPassword123!' }),
    });

    const res = await resetPasswordHandler.fetch(req);
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe('service_unavailable');
    expect(updatedPasswords[STAFF_ID]).toBeUndefined();
    expect(auditLogs.length).toBe(0);
  });

  // 3d. Fail-closed: DB error during staff profile lookup returns 503 and changes nothing
  it('3d. FAIL-CLOSED: Database error during authoritative staff profile lookup returns 503 and aborts without mutating password', async () => {
    failProfileQuery = true;
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
      body: JSON.stringify({ newPassword: 'NewValidPassword123!' }),
    });

    const res = await resetPasswordHandler.fetch(req);
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe('service_unavailable');
    expect(updatedPasswords[STAFF_ID]).toBeUndefined();
    expect(auditLogs.length).toBe(0);
  });

  // 3e. Device lookup queries canonical columns and does not select nonexistent id
  it('3e. Device recovery lookup queries real canonical schema columns and does not select nonexistent id', async () => {
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
      body: JSON.stringify({ newPassword: 'NewValidPassword123!' }),
    });

    await resetPasswordHandler.fetch(req);
    expect(lastDeviceSelectedCols).toContain('user_id');
    expect(lastDeviceSelectedCols).not.toMatch(/\bid\b/);
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

  // E. Genuine recovery flow with recovery AMR is ALLOWED
  it('6. MOCKED SERVER CONTRACT TEST: verified-style recovery AMR accepted and updates password', async () => {
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

  // G. Recovery session cannot call representative Guard API
  it('12. RECOVERY CONFINEMENT: Recovery session cannot call representative Guard API (403 recovery_session_forbidden)', async () => {
    const recoveryJwt = makeJwt({
      sub: STAFF_ID,
      email: 'guard@earist.edu.ph',
      role: 'authenticated',
      amr: [{ method: 'recovery', timestamp: Date.now() }],
    });

    const req = new Request('http://localhost/api/decide-visit', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${recoveryJwt}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        passId: '00000000-0000-4000-a000-000000000001',
        decision: 'approved',
        reason: null,
      }),
    });

    const res = await decideVisitHandler.fetch(req);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe('recovery_session_forbidden');
  });

  // J. Normal eligible staff session CAN call representative Guard API
  it('13. RECOVERY CONFINEMENT: Normal eligible staff session CAN call representative Guard API (200 OK)', async () => {
    const staffJwt = makeJwt({
      sub: STAFF_ID,
      email: 'guard@earist.edu.ph',
      role: 'authenticated',
      amr: [{ method: 'password', timestamp: Date.now() }],
    });

    const req = new Request('http://localhost/api/decide-visit', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${staffJwt}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        passId: '00000000-0000-4000-a000-000000000001',
        decision: 'approved',
        reason: null,
      }),
    });

    const res = await decideVisitHandler.fetch(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('approved');
  });

  // H. Recovery session cannot call representative Admin API
  it('14. RECOVERY CONFINEMENT: Recovery session cannot call representative Admin API (403 recovery_session_forbidden)', async () => {
    const recoveryAdminJwt = makeJwt({
      sub: SUPERADMIN_ID,
      email: 'superadmin@earist.edu.ph',
      role: 'authenticated',
      amr: [{ method: 'recovery', timestamp: Date.now() }],
    });

    const req = new Request('http://localhost/api/admin/settings', {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${recoveryAdminJwt}`,
      },
    });

    const res = await adminSettingsHandler(req);
    expect(res.status).toBe(403);
  });

  // J. Normal eligible Super Admin CAN call representative Admin API
  it('15. RECOVERY CONFINEMENT: Normal eligible Super Admin CAN call representative Admin API (200 OK)', async () => {
    const adminJwt = makeJwt({
      sub: SUPERADMIN_ID,
      email: 'superadmin@earist.edu.ph',
      role: 'authenticated',
      amr: [{ method: 'password', timestamp: Date.now() }],
    });

    const req = new Request('http://localhost/api/admin/settings', {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${adminJwt}`,
      },
    });

    const res = await adminSettingsHandler(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.workingHours.timezone).toBe('Asia/Manila');
  });

  // K & L. Architecture contract: separate storage namespaces & callback isolation
  it('16. CLIENT RECOVERY ISOLATION: Storage keys and URL detection isolated across clients', () => {
    const supabaseSrc = readFileSync(join(process.cwd(), 'src', 'lib', 'supabase.ts'), 'utf8');

    // K. Recovery client uses dedicated storage namespace
    expect(supabaseSrc).toContain("storageKey: 'egatepass-recovery-auth'");
    // K. Operator client uses dedicated storage namespace
    expect(supabaseSrc).toContain("storageKey: 'egatepass-operator-auth'");
    // K. Portal client uses dedicated storage namespace
    expect(supabaseSrc).toContain("storageKey: 'egatepass-portal-auth'");

    // L. Operator client does not consume recovery callback on /reset-password
    expect(supabaseSrc).toContain("!window.location.pathname.startsWith('/reset-password')");

    // E. Recovery client is configured with PKCE flowType
    expect(supabaseSrc).toContain("flowType: 'pkce'");
  });
});
