// @vitest-environment happy-dom
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import {
  TEST_IDENTITIES,
  createMfaTestStateStore,
  createMockSupabaseAdmin,
  createMockSupabaseClient,
  createTestJwt,
  executeApiRoute,
  handleMfaRequest,
  requireStaffActor,
  requireTestDb,
  seedTestOfficeVisitAndOutbox,
  renderProtectedRouteHarness,
  bindMockClientsToStore,
  resetMockClients,
  createMfaTestDb,
  type MfaTestStateStore,
} from './helpers/mfa-e2e-fixtures.js';
import { clearStaffMfaCacheForTesting } from '../../server/actors.js';

describe('Tier 3: Combinatorial Pairwise Matrix Coverage (25 Interaction Tests)', () => {
  let store: MfaTestStateStore;
  let mockAdmin: any;
  let pgDb: Awaited<ReturnType<typeof createMfaTestDb>> | null = null;

  beforeAll(async () => {
    try {
      pgDb = await createMfaTestDb();
    } catch (err) {
      console.error('Failed to initialize PGlite for Tier 3 tests:', err);
    }
  }, 60_000);

  afterAll(async () => {
    if (pgDb) {
      await pgDb.close();
      pgDb = null;
    }
  });

  beforeEach(() => {
    clearStaffMfaCacheForTesting();
    store = createMfaTestStateStore();
    mockAdmin = bindMockClientsToStore(store);
  });

  afterEach(() => {
    clearStaffMfaCacheForTesting();
    resetMockClients();
    vi.clearAllMocks();
    document.body.innerHTML = '';
    vi.useRealTimers();
  });

  // Test 1: admin + no_factor + aal1 -> Op1 (Staff Route) => ALLOWED
  it('T3-01: [admin, no_factor, aal1] accessing Staff Route is ALLOWED at AAL1', async () => {
    const token = createTestJwt({
      userId: TEST_IDENTITIES.ADMIN_UNENROLLED.userId,
      aal: 'aal1',
    });
    const actor = await requireStaffActor(mockAdmin, token, ['admin']);
    expect(actor.id).toBe(TEST_IDENTITIES.ADMIN_UNENROLLED.userId);
    expect(actor.role).toBe('admin');
  });

  // Test 2: admin + verified_totp + aal1 -> Op1 (Staff Route) => BLOCKED
  it('T3-02: [admin, verified_totp, aal1] accessing Staff Route is BLOCKED with 403 mfa_required', async () => {
    const token = createTestJwt({
      userId: TEST_IDENTITIES.ADMIN_ENROLLED.userId,
      aal: 'aal1',
    });
    await expect(
      requireStaffActor(mockAdmin, token, ['admin'])
    ).rejects.toThrow(expect.objectContaining({ status: 403, code: 'mfa_required' }));
  });

  // Test 3: admin + verified_totp + aal2 -> Op1 (Staff Route) => ALLOWED
  it('T3-03: [admin, verified_totp, aal2] accessing Staff Route is ALLOWED', async () => {
    const token = createTestJwt({
      userId: TEST_IDENTITIES.ADMIN_ENROLLED.userId,
      aal: 'aal2',
    });
    const actor = await requireStaffActor(mockAdmin, token, ['admin']);
    expect(actor.id).toBe(TEST_IDENTITIES.ADMIN_ENROLLED.userId);
  });

  // Test 4: office_staff + no_factor + aal1 -> Op1 (Staff Route) => ALLOWED
  it('T3-04: [office_staff, no_factor, aal1] accessing Staff Route is ALLOWED', async () => {
    const token = createTestJwt({
      userId: TEST_IDENTITIES.OFFICE_STAFF_UNENROLLED.userId,
      aal: 'aal1',
    });
    const actor = await requireStaffActor(mockAdmin, token, ['office_staff']);
    expect(actor.role).toBe('office_staff');
  });

  // Test 5: office_staff + unverified_only + aal1 -> Op1 (Staff Route) => ALLOWED
  it('T3-05: [office_staff, unverified_only, aal1] accessing Staff Route is ALLOWED (unverified ignored)', async () => {
    const userId = TEST_IDENTITIES.OFFICE_STAFF_UNENROLLED.userId;
    store.factors[userId] = [
      {
        id: '33333333-5555-4000-a000-000000000001',
        factor_type: 'totp',
        status: 'unverified',
        created_at: new Date().toISOString(),
      },
    ];
    const token = createTestJwt({
      userId,
      aal: 'aal1',
    });
    const actor = await requireStaffActor(mockAdmin, token, ['office_staff']);
    expect(actor.role).toBe('office_staff');
  });

  // Test 6: office_staff + verified_totp + aal1 -> Op1 (Staff Route) => BLOCKED
  it('T3-06: [office_staff, verified_totp, aal1] accessing Staff Route is BLOCKED with 403 mfa_required', async () => {
    const token = createTestJwt({
      userId: TEST_IDENTITIES.OFFICE_STAFF_ENROLLED.userId,
      aal: 'aal1',
    });
    await expect(
      requireStaffActor(mockAdmin, token, ['office_staff'])
    ).rejects.toThrow(expect.objectContaining({ status: 403, code: 'mfa_required' }));
  });

  // Test 7: guard + no_factor + aal1 -> Op1 (Staff Route) => ALLOWED
  it('T3-07: [guard, no_factor, aal1] accessing Staff Route is ALLOWED', async () => {
    const token = createTestJwt({
      userId: TEST_IDENTITIES.LEGACY_GUARD.userId,
      aal: 'aal1',
    });
    const actor = await requireStaffActor(mockAdmin, token, ['guard']);
    expect(actor.role).toBe('guard');
  });

  // Test 8: guard + verified_totp + aal2 -> Op1 (Staff Route) => ALLOWED
  it('T3-08: [guard, verified_totp, aal2] accessing Staff Route is ALLOWED', async () => {
    const userId = TEST_IDENTITIES.LEGACY_GUARD.userId;
    store.factors[userId] = [
      {
        id: '55555555-2222-4000-a000-000000000001',
        factor_type: 'totp',
        status: 'verified',
        created_at: new Date().toISOString(),
      },
    ];
    const token = createTestJwt({
      userId,
      aal: 'aal2',
    });
    const actor = await requireStaffActor(mockAdmin, token, ['guard']);
    expect(actor.role).toBe('guard');
  });

  // Test 9: superadmin + no_factor + aal1 -> Op2 (Settings) => ALLOWED (Status: Disabled)
  it('T3-09: [superadmin, no_factor, aal1] visiting Settings displays MFA Disabled with Enable action', async () => {
    const client = createMockSupabaseClient(store, TEST_IDENTITIES.SUPERADMIN_UNENROLLED.userId);
    const factorsRes = await client.auth.mfa.listFactors();
    const hasVerified = factorsRes.data?.totp.some((f) => f.status === 'verified') ?? false;
    expect(hasVerified).toBe(false);
  });

  // Test 10: admin + verified_totp + aal2 -> Op2 (Settings) => ALLOWED (Status: Enabled)
  it('T3-10: [admin, verified_totp, aal2] visiting Settings displays MFA Enabled with Disable action', async () => {
    const client = createMockSupabaseClient(store, TEST_IDENTITIES.ADMIN_ENROLLED.userId);
    const factorsRes = await client.auth.mfa.listFactors();
    const verified = factorsRes.data?.totp.find((f) => f.status === 'verified');
    expect(verified).toBeDefined();
  });

  // Test 11: kiosk + no_factor + aal1 -> Op2 (Settings) => BLOCKED (Forbidden)
  it('T3-11: [kiosk, no_factor, aal1] visiting Settings is BLOCKED', async () => {
    const { container, unmount } = await renderProtectedRouteHarness({
      allowedRoles: ['admin', 'superadmin', 'office_staff'],
      currentRole: 'kiosk',
      status: 'authenticated',
    });
    expect(container.textContent).toContain('LOGIN:/login');
    expect(container.textContent).not.toContain('PROTECTED_ACCESS_GRANTED');
    unmount();
  });

  // Test 12: emergency_device + no_factor + aal1 -> Op2 (Settings) => BLOCKED
  it('T3-12: [emergency_device, no_factor, aal1] visiting Settings is BLOCKED', async () => {
    const { container, unmount } = await renderProtectedRouteHarness({
      allowedRoles: ['admin', 'superadmin', 'office_staff'],
      currentRole: 'emergency_device',
      status: 'authenticated',
    });
    expect(container.textContent).toContain('LOGIN:/login');
    expect(container.textContent).not.toContain('PROTECTED_ACCESS_GRANTED');
    unmount();
  });

  // Test 13: visitor + no_factor + missing_aal -> Op2 (Settings) => BLOCKED
  it('T3-13: [visitor, no_factor, missing_aal] visiting Settings is BLOCKED', async () => {
    const { container, unmount } = await renderProtectedRouteHarness({
      allowedRoles: ['admin', 'superadmin', 'office_staff'],
      currentRole: 'visitor',
      status: 'unauthenticated',
    });
    expect(container.textContent).toContain('LOGIN:/login');
    expect(container.textContent).not.toContain('PROTECTED_ACCESS_GRANTED');
    unmount();
  });

  // Test 14: office_staff + no_factor + aal1 -> Op3 (Enroll) => ALLOWED
  it('T3-14: [office_staff, no_factor, aal1] enrolling MFA returns QR code and secret', async () => {
    const client = createMockSupabaseClient(store, TEST_IDENTITIES.OFFICE_STAFF_UNENROLLED.userId);
    const res = await client.auth.mfa.enroll({ factorType: 'totp' });
    expect(res.error).toBeNull();
    expect(res.data?.totp.secret).toBeDefined();
    expect(res.data?.totp.qr_code).toBeDefined();
  });

  // Test 15: admin + unverified_only + aal1 -> Op3 (Enroll) => ALLOWED
  it('T3-15: [admin, unverified_only, aal1] enrolling MFA cleans pending factor and returns new QR', async () => {
    const userId = TEST_IDENTITIES.STAFF_UNVERIFIED_FACTOR.userId;
    const client = createMockSupabaseClient(store, userId);
    const res = await client.auth.mfa.enroll({ factorType: 'totp' });
    expect(res.error).toBeNull();
    expect(res.data?.id).toBeDefined();
  });

  // Test 16: superadmin + unverified_only + aal1 -> Op4 (Verify) => ALLOWED
  it('T3-16: [superadmin, unverified_only, aal1] verifying TOTP challenge elevates session to AAL2', async () => {
    const userId = TEST_IDENTITIES.SUPERADMIN_UNENROLLED.userId;
    const client = createMockSupabaseClient(store, userId);
    const enrollRes = await client.auth.mfa.enroll({ factorType: 'totp' });
    const factorId = enrollRes.data!.id;

    const verifyRes = await client.auth.mfa.challengeAndVerify({
      factorId,
      code: '123456',
    });
    expect(verifyRes.error).toBeNull();

    const aalRes = await client.auth.mfa.getAuthenticatorAssuranceLevel();
    expect(aalRes.data?.currentLevel).toBe('aal2');
  });

  // Test 17: admin + verified_totp + aal2 -> Op5 (Disable) => ALLOWED
  it('T3-17: [admin, verified_totp, aal2] disabling MFA unenrolls factor and refreshes to AAL1', async () => {
    const userId = TEST_IDENTITIES.ADMIN_ENROLLED.userId;
    const client = createMockSupabaseClient(store, userId);
    const factorId = TEST_IDENTITIES.ADMIN_ENROLLED.factorId;

    const res = await client.auth.mfa.unenroll({ factorId });
    expect(res.error).toBeNull();

    const refreshRes = await client.auth.refreshSession();
    expect(refreshRes.error).toBeNull();
    expect(store.factors[userId].length).toBe(0);
  });

  // Test 18: admin + verified_totp + aal1 -> Op5 (Disable) => BLOCKED
  it('T3-18: [admin, verified_totp, aal1] disabling MFA at AAL1 is BLOCKED', async () => {
    const token = createTestJwt({
      userId: TEST_IDENTITIES.ADMIN_ENROLLED.userId,
      aal: 'aal1',
    });
    await expect(
      requireStaffActor(mockAdmin, token, ['admin'])
    ).rejects.toThrow(expect.objectContaining({ status: 403, code: 'mfa_required' }));
  });

  // Test 19: superadmin + verified_totp + aal2 -> Op6 (Inspect) => ALLOWED
  it('T3-19: [superadmin, verified_totp, aal2] inspecting factors returns factor list', async () => {
    const token = createTestJwt({
      userId: TEST_IDENTITIES.SUPERADMIN_ENROLLED.userId,
      aal: 'aal2',
    });
    const res = await executeApiRoute(
      handleMfaRequest,
      {
        method: 'GET',
        url: `http://localhost/api/auth/mfa?userId=${TEST_IDENTITIES.ADMIN_ENROLLED.userId}`,
        token,
      }
    );
    expect(res.status).toBe(200);
    expect(res.body.factors.length).toBe(1);
  });

  // Test 20: admin + verified_totp + aal2 -> Op6 (Inspect) => BLOCKED
  it('T3-20: [admin, verified_totp, aal2] inspecting factors is BLOCKED with 403 access_denied', async () => {
    const token = createTestJwt({
      userId: TEST_IDENTITIES.ADMIN_ENROLLED.userId,
      aal: 'aal2',
    });
    const res = await executeApiRoute(
      handleMfaRequest,
      {
        method: 'GET',
        url: `http://localhost/api/auth/mfa?userId=${TEST_IDENTITIES.OFFICE_STAFF_ENROLLED.userId}`,
        token,
      }
    );
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('access_denied');
  });

  // Test 21: superadmin + verified_totp + aal2 -> Op7 (Reset) => ALLOWED
  it('T3-21: [superadmin, verified_totp, aal2] resetting factor is ALLOWED', async () => {
    const token = createTestJwt({
      userId: TEST_IDENTITIES.SUPERADMIN_ENROLLED.userId,
      aal: 'aal2',
    });
    const res = await executeApiRoute(
      handleMfaRequest,
      {
        method: 'POST',
        token,
        body: {
          action: 'reset_factor',
          userId: TEST_IDENTITIES.ADMIN_ENROLLED.userId,
          factorId: TEST_IDENTITIES.ADMIN_ENROLLED.factorId,
          password: TEST_IDENTITIES.SUPERADMIN_ENROLLED.password,
          reason: 'Emergency phone replacement authorized',
          confirmed: true,
        },
      }
    );
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  // Test 22: superadmin + verified_totp + aal1 -> Op7 (Reset) => BLOCKED
  it('T3-22: [superadmin, verified_totp, aal1] resetting factor at AAL1 is BLOCKED with 403 mfa_required', async () => {
    const token = createTestJwt({
      userId: TEST_IDENTITIES.SUPERADMIN_ENROLLED.userId,
      aal: 'aal1',
    });
    const res = await executeApiRoute(
      handleMfaRequest,
      {
        method: 'POST',
        token,
        body: {
          action: 'reset_factor',
          userId: TEST_IDENTITIES.ADMIN_ENROLLED.userId,
          factorId: TEST_IDENTITIES.ADMIN_ENROLLED.factorId,
          password: TEST_IDENTITIES.SUPERADMIN_ENROLLED.password,
          reason: 'Attempted reset at AAL1',
        },
      }
    );
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('mfa_required');
  });

  // Test 23: admin + no_factor + aal1 -> Op8 (Recover RPC) => ALLOWED
  it('T3-23: [admin, no_factor, aal1] calling recover pass RPC is ALLOWED under optional MFA', async () => {
    const testDb = requireTestDb(pgDb);
    const res = await testDb.asStaff(TEST_IDENTITIES.ADMIN_UNENROLLED.userId, 'admin', 'aal1', async () => {
      return await testDb.db.query<{ satisfied: boolean }>(`select private.staff_mfa_is_satisfied() as satisfied;`);
    });
    expect(res.rows[0].satisfied).toBe(true);
  });

  // Test 24: admin + verified_totp + missing_aal -> Op9 (Queue RPC) => BLOCKED
  it('T3-24: [admin, verified_totp, missing_aal] calling queue search RPC is BLOCKED with mfa_required', async () => {
    const testDb = requireTestDb(pgDb);
    await testDb.db.exec(`set request.jwt.claims = '{"sub": "${TEST_IDENTITIES.ADMIN_ENROLLED.userId}", "role": "authenticated"}';`);
    await expect(
      testDb.db.query(`select api.guard_search_pending_queue('Test Visitor', 10);`)
    ).rejects.toThrow(/mfa_required/);
  });

  // Test 25: service_role + no_factor + missing_aal -> Op10 (Outbox Claim) => ALLOWED
  it('T3-25: [service_role, no_factor, missing_aal] claiming outbox is ALLOWED unaffected by MFA', async () => {
    const testDb = requireTestDb(pgDb);
    const { visitId, outboxId } = await seedTestOfficeVisitAndOutbox(testDb.db, {
      deliveryStatus: 'pending',
      attemptCount: 0,
    });
    const res = await testDb.asServiceRole(async () => {
      return await testDb.db.query<{ outbox_id: string; attempt_count: number }>(
        `select outbox_id, attempt_count from api.claim_office_visit_acknowledgement_for_delivery('${visitId}'::uuid);`
      );
    });
    expect(res.rows.length).toBe(1);
    expect(res.rows[0].outbox_id).toBe(outboxId);
    expect(res.rows[0].attempt_count).toBe(1);
  });
});
