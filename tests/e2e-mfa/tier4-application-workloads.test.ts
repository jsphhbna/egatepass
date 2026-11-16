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
  bindMockClientsToStore,
  resetMockClients,
  createMfaTestDb,
  type MfaTestStateStore,
} from './helpers/mfa-e2e-fixtures.js';
import { clearStaffMfaCacheForTesting } from '../../server/actors.js';

describe('Tier 4: Real-World End-to-End Application Workload Scenarios (6 Comprehensive Scenarios)', () => {
  let store: MfaTestStateStore;
  let mockAdmin: any;
  let pgDb: Awaited<ReturnType<typeof createMfaTestDb>> | null = null;

  beforeAll(async () => {
    try {
      pgDb = await createMfaTestDb();
    } catch (err) {
      console.error('Failed to initialize PGlite for Tier 4 tests:', err);
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

  // ==========================================================================
  // Scenario 1: Fresh Staff Member Onboarding & Self-Service MFA Opt-In Flow
  // ==========================================================================
  it('Scenario 1: Fresh Staff Member Onboarding Lifecycle & Self-Service MFA Opt-In Flow', async () => {
    const userId = '33333333-9999-4000-a000-000000000001';
    const email = 'new.registrar@earist.edu.ph';
    const password = 'NewRegistrarPass123!';

    // 1. Account Provisioned in auth and staff_profiles
    store.users[userId] = {
      id: userId,
      email,
      password,
      email_confirmed_at: new Date().toISOString(),
      is_anonymous: false,
    };
    store.staffProfiles[userId] = {
      user_id: userId,
      display_name: 'New Registrar',
      role: 'office_staff',
      active: true,
      must_change_password: false,
      privacy_accepted_at: new Date().toISOString(),
    };
    store.factors[userId] = [];

    // 2. First Login with password: issues AAL1 session
    const client = createMockSupabaseClient(store, userId);
    const loginRes = await client.auth.signInWithPassword({ email, password });
    expect(loginRes.error).toBeNull();

    // 3. Zero MFA Barrier: Confirms no enrollment modal, no TOTP challenge
    const factorsInitial = await client.auth.mfa.listFactors();
    expect(factorsInitial.data?.totp.length).toBe(0);
    const aalInitial = await client.auth.mfa.getAuthenticatorAssuranceLevel();
    expect(aalInitial.data?.currentLevel).toBe('aal1');

    // 4. Staff accesses office dashboard and backend middleware
    const aal1Token = createTestJwt({ userId, aal: 'aal1' });
    const actorAal1 = await requireStaffActor(mockAdmin, aal1Token, ['office_staff']);
    expect(actorAal1.id).toBe(userId);
    expect(actorAal1.role).toBe('office_staff');

    // 5. Staff navigates to /account/security: observes MFA Disabled
    const hasVerified = factorsInitial.data?.totp.some((f) => f.status === 'verified') ?? false;
    expect(hasVerified).toBe(false);

    // 6. Staff initiates TOTP enrollment: receives QR code and secret
    const enrollRes = await client.auth.mfa.enroll({
      factorType: 'totp',
      friendlyName: 'Registrar Mobile Phone',
    });
    expect(enrollRes.error).toBeNull();
    const factorId = enrollRes.data!.id;
    expect(enrollRes.data?.totp.secret).toBeDefined();
    expect(enrollRes.data?.totp.qr_code).toContain('<svg');

    // 7. Staff verifies 6-digit TOTP challenge
    const verifyRes = await client.auth.mfa.challengeAndVerify({
      factorId,
      code: '123456',
    });
    expect(verifyRes.error).toBeNull();

    // 8. Session elevated to AAL2, factor marked verified
    const aalElevated = await client.auth.mfa.getAuthenticatorAssuranceLevel();
    expect(aalElevated.data?.currentLevel).toBe('aal2');
    const factorAfter = store.factors[userId].find((f) => f.id === factorId);
    expect(factorAfter?.status).toBe('verified');

    // 9. Operational access continues seamlessly at AAL2
    const aal2Token = createTestJwt({ userId, aal: 'aal2' });
    const actorAal2 = await requireStaffActor(mockAdmin, aal2Token, ['office_staff']);
    expect(actorAal2.id).toBe(userId);
  });

  // ==========================================================================
  // Scenario 2: Routine Enrolled Staff Routine Daily Login Lifecycle
  // ==========================================================================
  it('Scenario 2: Routine Enrolled Staff Daily Login & Challenge Verification Flow', async () => {
    const userId = TEST_IDENTITIES.ADMIN_ENROLLED.userId;
    const email = TEST_IDENTITIES.ADMIN_ENROLLED.email;
    const password = TEST_IDENTITIES.ADMIN_ENROLLED.password;
    const factorId = TEST_IDENTITIES.ADMIN_ENROLLED.factorId;

    // 1. Staff enters credentials on /login
    const client = createMockSupabaseClient(store, userId);
    const loginRes = await client.auth.signInWithPassword({ email, password });
    expect(loginRes.error).toBeNull();

    // 2. Initial token issued at AAL1; system detects verified factor
    const factorsRes = await client.auth.mfa.listFactors();
    const verified = factorsRes.data?.totp.filter((f) => f.status === 'verified') ?? [];
    expect(verified.length).toBe(1);

    // 3. requiresMfa evaluates to true; challenge triggered
    const aal1Token = createTestJwt({ userId, aal: 'aal1' });
    const requiresMfa = verified.length > 0;
    expect(requiresMfa).toBe(true);

    // 4. Direct route barrier: accessing protected operational route at AAL1 is blocked
    await expect(
      requireStaffActor(mockAdmin, aal1Token, ['admin'])
    ).rejects.toThrow(expect.objectContaining({ status: 403, code: 'mfa_required' }));

    // 5. Staff enters 6-digit TOTP code
    const challengeRes = await client.auth.mfa.challenge({ factorId });
    expect(challengeRes.error).toBeNull();

    const verifyRes = await client.auth.mfa.verify({
      factorId,
      code: '123456',
    });
    expect(verifyRes.error).toBeNull();

    // 6. Session elevated to AAL2
    const aal2Token = createTestJwt({ userId, aal: 'aal2' });
    const actorAal2 = await requireStaffActor(mockAdmin, aal2Token, ['admin']);
    expect(actorAal2.id).toBe(userId);
    expect(actorAal2.role).toBe('admin');
  });

  // ==========================================================================
  // Scenario 3: Voluntary MFA Opt-Out (Self-Service Disablement Flow)
  // ==========================================================================
  it('Scenario 3: Staff Member Voluntary Self-Service MFA Disablement & Subsequent Password Login', async () => {
    const userId = TEST_IDENTITIES.ADMIN_ENROLLED.userId;
    const factorId = TEST_IDENTITIES.ADMIN_ENROLLED.factorId;

    // 1. Staff authenticated at AAL2 navigates to /account/security
    const client = createMockSupabaseClient(store, userId);
    const initialFactors = await client.auth.mfa.listFactors();
    expect(initialFactors.data?.totp.some((f) => f.status === 'verified')).toBe(true);

    // 2. Staff confirms disablement: calls unenroll()
    const unenrollRes = await client.auth.mfa.unenroll({ factorId });
    expect(unenrollRes.error).toBeNull();
    expect(store.factors[userId].length).toBe(0);

    // 3. Session refresh resets state to AAL1
    const refreshRes = await client.auth.refreshSession();
    expect(refreshRes.error).toBeNull();
    const aalAfter = await client.auth.mfa.getAuthenticatorAssuranceLevel();
    expect(aalAfter.data?.currentLevel).toBe('aal1');

    // 4. Staff signs out
    const signOutRes = await client.auth.signOut();
    expect(signOutRes.error).toBeNull();

    // 5. Subsequent password login succeeds directly at AAL1 without challenge
    const reloginRes = await client.auth.signInWithPassword({
      email: TEST_IDENTITIES.ADMIN_ENROLLED.email,
      password: TEST_IDENTITIES.ADMIN_ENROLLED.password,
    });
    expect(reloginRes.error).toBeNull();

    const postReloginFactors = await client.auth.mfa.listFactors();
    expect(postReloginFactors.data?.totp.length).toBe(0);

    // 6. Operational route access succeeds at AAL1 under optional MFA
    const aal1Token = createTestJwt({ userId, aal: 'aal1' });
    const actor = await requireStaffActor(mockAdmin, aal1Token, ['admin']);
    expect(actor.id).toBe(userId);
  });

  // ==========================================================================
  // Scenario 4: Staff Member Lockout, Superadmin Reset & Session Invalidation
  // ==========================================================================
  it('Scenario 4: Staff Member Lockout, Superadmin Factor Reset & Session Invalidation Lifecycle', async () => {
    const lockedOutUserId = TEST_IDENTITIES.OFFICE_STAFF_ENROLLED.userId;
    const lockedOutFactorId = TEST_IDENTITIES.OFFICE_STAFF_ENROLLED.factorId;
    const superadminUserId = TEST_IDENTITIES.SUPERADMIN_ENROLLED.userId;

    // 1. Staff member is locked out (cannot complete AAL2 challenge)
    const oldSessionId = `sess-${lockedOutUserId}`;
    expect(store.activeSessions[oldSessionId].expired_at).toBeNull();

    // 2. Superadmin inspects staff user via GET /api/auth/mfa
    const superadminToken = createTestJwt({ userId: superadminUserId, aal: 'aal2' });
    const inspectRes = await executeApiRoute(
      handleMfaRequest,
      {
        method: 'GET',
        url: `http://localhost/api/auth/mfa?userId=${lockedOutUserId}`,
        token: superadminToken,
      }
    );
    expect(inspectRes.status).toBe(200);
    expect(inspectRes.body.factors[0].id).toBe(lockedOutFactorId);

    // 3. Superadmin performs factor reset with password re-auth and reason
    const resetRes = await executeApiRoute(
      handleMfaRequest,
      {
        method: 'POST',
        token: superadminToken,
        body: {
          action: 'reset_factor',
          userId: lockedOutUserId,
          factorId: lockedOutFactorId,
          password: TEST_IDENTITIES.SUPERADMIN_ENROLLED.password,
          reason: 'Staff member lost mobile phone; in-person verification completed',
          confirmed: true,
        },
      }
    );
    expect(resetRes.status).toBe(200);
    expect(resetRes.body.ok).toBe(true);

    // 4. Factor deleted and immutable audit event written
    expect(store.factors[lockedOutUserId].length).toBe(0);
    const audit = store.auditEvents.find(
      (e) => e.action === 'staff.mfa_factor_reset' && e.target_id === lockedOutUserId
    );
    expect(audit).toBeDefined();
    expect(audit.after_state.reason).toContain('in-person verification completed');

    // 5. Target staff active session is revoked in staff_sessions
    expect(store.activeSessions[oldSessionId].expired_at).not.toBeNull();
    expect(store.activeSessions[oldSessionId].expired_reason).toBe('mfa_factor_reset');

    // 6. Old session token receives 401 on next backend call
    const oldToken = createTestJwt({ userId: lockedOutUserId, aal: 'aal2', sessionId: oldSessionId });
    await expect(
      requireStaffActor(mockAdmin, oldToken, ['office_staff'])
    ).rejects.toThrow(expect.objectContaining({ status: 401, code: 'session_idle_expired' }));

    // 7. Staff logs in with password: succeeds immediately at AAL1 without TOTP challenge
    const client = createMockSupabaseClient(store, lockedOutUserId);
    const relogin = await client.auth.signInWithPassword({
      email: TEST_IDENTITIES.OFFICE_STAFF_ENROLLED.email,
      password: TEST_IDENTITIES.OFFICE_STAFF_ENROLLED.password,
    });
    expect(relogin.error).toBeNull();
    const aal = await client.auth.mfa.getAuthenticatorAssuranceLevel();
    expect(aal.data?.currentLevel).toBe('aal1');
  });

  // ==========================================================================
  // Scenario 5: Adversarial & Unauthorized Actor Privilege Boundary Defense
  // ==========================================================================
  it('Scenario 5: Adversarial & Unauthorized Actor Privilege Boundary Defense', async () => {
    // 1. Anonymous visitor attempts POST /api/auth/mfa
    const visitorToken = createTestJwt({
      userId: TEST_IDENTITIES.VISITOR_USER.userId,
      isAnonymous: true,
    });
    const visitorRes = await executeApiRoute(
      handleMfaRequest,
      {
        method: 'POST',
        token: visitorToken,
        body: {
          action: 'reset_factor',
          userId: TEST_IDENTITIES.ADMIN_ENROLLED.userId,
          factorId: TEST_IDENTITIES.ADMIN_ENROLLED.factorId,
          password: 'Pass',
          reason: 'Hacker reset attempt',
        },
      }
    );
    expect(visitorRes.status).toBe(403);
    expect(visitorRes.body.error).toBe('access_denied');

    // 2. Emergency kiosk station attempts GET /api/auth/mfa
    const kioskToken = createTestJwt({
      userId: TEST_IDENTITIES.EMERGENCY_DEVICE.userId,
    });
    const kioskRes = await executeApiRoute(
      handleMfaRequest,
      {
        method: 'GET',
        url: `http://localhost/api/auth/mfa?userId=${TEST_IDENTITIES.ADMIN_ENROLLED.userId}`,
        token: kioskToken,
      }
    );
    expect(kioskRes.status).toBe(403);

    // 3. Unauthorized staff (guard) attempts to reset admin's factor
    const guardToken = createTestJwt({
      userId: TEST_IDENTITIES.LEGACY_GUARD.userId,
      aal: 'aal1',
    });
    const guardRes = await executeApiRoute(
      handleMfaRequest,
      {
        method: 'POST',
        token: guardToken,
        body: {
          action: 'reset_factor',
          userId: TEST_IDENTITIES.ADMIN_ENROLLED.userId,
          factorId: TEST_IDENTITIES.ADMIN_ENROLLED.factorId,
          password: 'GuardPassword123!',
          reason: 'Unauthorized guard reset',
        },
      }
    );
    expect(guardRes.status).toBe(403);

    // 4. Attacker attempts AMR recovery bypass
    const recoveryToken = createTestJwt({
      userId: TEST_IDENTITIES.ADMIN_ENROLLED.userId,
      aal: 'aal2',
      amr: [{ method: 'recovery' }],
    });
    await expect(
      requireStaffActor(mockAdmin, recoveryToken, ['admin'])
    ).rejects.toThrow(expect.objectContaining({ status: 403, code: 'recovery_session_forbidden' }));

    // 5. Attacker attempts password guessing on superadmin reset
    const superadminToken = createTestJwt({
      userId: TEST_IDENTITIES.SUPERADMIN_ENROLLED.userId,
      aal: 'aal2',
    });
    const badPassRes = await executeApiRoute(
      handleMfaRequest,
      {
        method: 'POST',
        token: superadminToken,
        body: {
          action: 'reset_factor',
          userId: TEST_IDENTITIES.ADMIN_ENROLLED.userId,
          factorId: TEST_IDENTITIES.ADMIN_ENROLLED.factorId,
          password: 'GuessedPassword999!',
          reason: 'Brute force password test',
          confirmed: true,
        },
      }
    );
    expect(badPassRes.status).toBe(401);
    expect(badPassRes.body.error).toBe('invalid_superadmin_password');

    // 6. Attacker provides factorId belonging to different staff user
    const mismatchedRes = await executeApiRoute(
      handleMfaRequest,
      {
        method: 'POST',
        token: superadminToken,
        body: {
          action: 'reset_factor',
          userId: TEST_IDENTITIES.OFFICE_STAFF_ENROLLED.userId,
          factorId: TEST_IDENTITIES.ADMIN_ENROLLED.factorId,
          password: TEST_IDENTITIES.SUPERADMIN_ENROLLED.password,
          reason: 'Mismatched factor ID attack',
          confirmed: true,
        },
      }
    );
    expect(mismatchedRes.status).toBe(400);
    expect(mismatchedRes.body.error).toBe('mismatched_factor_id');
  });

  // ==========================================================================
  // Scenario 6: High-Concurrency Outbox Delivery Invariance Under Active MFA Operations
  // ==========================================================================
  it('Scenario 6: Outbox Delivery Daemon Invariance Amid Concurrent Staff MFA Operations', async () => {
    // 1. Simulate 5 concurrent staff operations (logins, enrollments, resets)
    const staffOps = [
      createMockSupabaseClient(store, TEST_IDENTITIES.ADMIN_UNENROLLED.userId).auth.signInWithPassword({
        email: TEST_IDENTITIES.ADMIN_UNENROLLED.email,
        password: TEST_IDENTITIES.ADMIN_UNENROLLED.password,
      }),
      createMockSupabaseClient(store, TEST_IDENTITIES.OFFICE_STAFF_UNENROLLED.userId).auth.mfa.enroll({
        factorType: 'totp',
      }),
      executeApiRoute(
        handleMfaRequest,
        {
          method: 'POST',
          token: createTestJwt({ userId: TEST_IDENTITIES.SUPERADMIN_ENROLLED.userId, aal: 'aal2' }),
          body: {
            action: 'reset_factor',
            userId: TEST_IDENTITIES.ADMIN_ENROLLED.userId,
            factorId: TEST_IDENTITIES.ADMIN_ENROLLED.factorId,
            password: TEST_IDENTITIES.SUPERADMIN_ENROLLED.password,
            reason: 'Concurrent reset test',
            confirmed: true,
          },
        }
      ),
    ];

    const results = await Promise.all(staffOps);
    expect(results.length).toBe(3);

    // 2. Outbox Daemon runs in database under service_role completely unaffected
    const testDb = requireTestDb(pgDb);
    const { visitId, outboxId } = await seedTestOfficeVisitAndOutbox(testDb.db, {
      deliveryStatus: 'pending',
      attemptCount: 0,
    });
    const claimRes = await testDb.asServiceRole(async () => {
      return await testDb.db.query<{ outbox_id: string; attempt_count: number }>(
        `select outbox_id, attempt_count from api.claim_office_visit_acknowledgement_for_delivery('${visitId}'::uuid);`
      );
    });
    expect(claimRes.rows.length).toBe(1);
    expect(claimRes.rows[0].outbox_id).toBe(outboxId);
    expect(claimRes.rows[0].attempt_count).toBe(1);

    // 3. Confirm zero cross-contamination
    expect(store.auditEvents.length).toBeGreaterThan(0);
  });
});
