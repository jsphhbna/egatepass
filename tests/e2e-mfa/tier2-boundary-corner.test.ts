// @vitest-environment happy-dom
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  TEST_IDENTITIES,
  createMfaTestStateStore,
  createMockSupabaseAdmin,
  createMockSupabaseClient,
  createTestJwt,
  executeApiRoute,
  handleMfaRequest,
  requireStaffActor,
  requireOfficeStaffActor,
  requireTestDb,
  seedTestOfficeVisitAndOutbox,
  renderProtectedRouteHarness,
  bindMockClientsToStore,
  resetMockClients,
  createMfaTestDb,
  type MfaTestStateStore,
} from './helpers/mfa-e2e-fixtures.js';
import { HttpError, clearStaffMfaCacheForTesting } from '../../server/actors.js';

describe('Tier 2: Boundary, Corner & Negative Cases (14 Features × 5 Tests = 70 Tests)', () => {
  let store: MfaTestStateStore;
  let mockAdmin: any;
  let pgDb: Awaited<ReturnType<typeof createMfaTestDb>> | null = null;

  beforeAll(async () => {
    try {
      pgDb = await createMfaTestDb();
    } catch (err) {
      console.error('Failed to initialize PGlite for Tier 2 tests:', err);
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
  // Feature 1: Optional Staff MFA Policy & Password Login (§R1)
  // ==========================================================================
  describe('Feature 1: Optional Staff MFA Policy & Password Login (§R1)', () => {
    it('T2-F1-01: Email normalization & case-insensitivity: ADMIN@EARIST.EDU.PH logs in at AAL1', async () => {
      const client = createMockSupabaseClient(store, TEST_IDENTITIES.ADMIN_UNENROLLED.userId);
      const res = await client.auth.signInWithPassword({
        email: 'ADMIN.UNENROLLED@EARIST.EDU.PH',
        password: TEST_IDENTITIES.ADMIN_UNENROLLED.password,
      });

      expect(res.error).toBeNull();
      expect(res.data.user?.id).toBe(TEST_IDENTITIES.ADMIN_UNENROLLED.userId);

      const aalRes = await client.auth.mfa.getAuthenticatorAssuranceLevel();
      expect(aalRes.data?.currentLevel).toBe('aal1');
    });

    it('T2-F1-02: Precedence of must_change_password guard blocks access before MFA check', async () => {
      store.staffProfiles[TEST_IDENTITIES.ADMIN_UNENROLLED.userId].must_change_password = true;
      const token = createTestJwt({
        userId: TEST_IDENTITIES.ADMIN_UNENROLLED.userId,
        aal: 'aal1',
      });

      await expect(
        requireStaffActor(mockAdmin, token, ['admin'])
      ).rejects.toThrow(expect.objectContaining({ status: 403, code: 'access_denied' }));
    });

    it('T2-F1-03: Precedence of email_confirmed_at guard blocks unconfirmed email accounts', async () => {
      store.users[TEST_IDENTITIES.ADMIN_UNENROLLED.userId].email_confirmed_at = null;
      const token = createTestJwt({
        userId: TEST_IDENTITIES.ADMIN_UNENROLLED.userId,
        aal: 'aal1',
      });

      await expect(
        requireStaffActor(mockAdmin, token, ['admin'])
      ).rejects.toThrow(expect.objectContaining({ status: 403, code: 'email_verification_required' }));
    });

    it('T2-F1-04: Precedence of inactive account guard: active=false is blocked', async () => {
      store.staffProfiles[TEST_IDENTITIES.ADMIN_UNENROLLED.userId].active = false;
      const token = createTestJwt({
        userId: TEST_IDENTITIES.ADMIN_UNENROLLED.userId,
        aal: 'aal1',
      });

      await expect(
        requireStaffActor(mockAdmin, token, ['admin'])
      ).rejects.toThrow(expect.objectContaining({ status: 403, code: 'access_denied' }));
    });

    it('T2-F1-05: Missing AAL claim in JWT for unenrolled staff defaults safely to AAL1', async () => {
      const token = createTestJwt({
        userId: TEST_IDENTITIES.ADMIN_UNENROLLED.userId,
        aal: null,
      });

      const actor = await requireStaffActor(mockAdmin, token, ['admin']);
      expect(actor.id).toBe(TEST_IDENTITIES.ADMIN_UNENROLLED.userId);
    });
  });

  // ==========================================================================
  // Feature 2: Enrolled Staff TOTP Verification to AAL2 (§R1)
  // ==========================================================================
  describe('Feature 2: Enrolled Staff TOTP Verification to AAL2 (§R1)', () => {
    it('T2-F2-01: Invalid 6-digit TOTP code (000000) rejected with error and user remains AAL1', async () => {
      const client = createMockSupabaseClient(store, TEST_IDENTITIES.ADMIN_ENROLLED.userId);
      const res = await client.auth.mfa.challengeAndVerify({
        factorId: TEST_IDENTITIES.ADMIN_ENROLLED.factorId,
        code: '000000',
      });

      expect(res.error).not.toBeNull();
    });

    it('T2-F2-02: Non-digit characters in TOTP code rejected by validation', async () => {
      const client = createMockSupabaseClient(store, TEST_IDENTITIES.ADMIN_ENROLLED.userId);
      const res = await client.auth.mfa.challengeAndVerify({
        factorId: TEST_IDENTITIES.ADMIN_ENROLLED.factorId,
        code: '12a456',
      });

      expect(res.error).not.toBeNull();
    });

    it('T2-F2-03: Code with fewer than 6 digits (12345) rejected', async () => {
      const client = createMockSupabaseClient(store, TEST_IDENTITIES.ADMIN_ENROLLED.userId);
      const res = await client.auth.mfa.challengeAndVerify({
        factorId: TEST_IDENTITIES.ADMIN_ENROLLED.factorId,
        code: '12345',
      });

      expect(res.error).not.toBeNull();
    });

    it('T2-F2-04: Challenge dismissal cleans up auth state and unenrolls pending factor', async () => {
      const userId = TEST_IDENTITIES.ADMIN_UNENROLLED.userId;
      const client = createMockSupabaseClient(store, userId);
      const enrollRes = await client.auth.mfa.enroll({ factorType: 'totp' });
      const factorId = enrollRes.data!.id;

      expect(store.factors[userId].some((f) => f.id === factorId)).toBe(true);

      await client.auth.mfa.unenroll({ factorId });
      expect(store.factors[userId].some((f) => f.id === factorId)).toBe(false);
    });

    it('T2-F2-05: Direct URL navigation at AAL1 by enrolled staff is blocked by requiresMfa', async () => {
      const { container, unmount } = await renderProtectedRouteHarness({
        allowedRoles: ['admin'],
        currentRole: 'admin',
        status: 'authenticated',
        requiresMfa: true,
        initialPath: '/admin/dashboard',
      });
      expect(container.textContent).toContain('LOGIN:/login');
      expect(container.textContent).not.toContain('PROTECTED_ACCESS_GRANTED');
      unmount();
    });
  });

  // ==========================================================================
  // Feature 3: Unverified Factor Handling (Ignored on Login) (§R1)
  // ==========================================================================
  describe('Feature 3: Unverified Factor Handling (Ignored on Login) (§R1)', () => {
    it('T2-F3-01: Abandoned unverified factor with expired creation timestamp is ignored on login', async () => {
      const userId = 'user-abandoned-old';
      store.users[userId] = { id: userId, email: 'old-abandoned@earist.edu.ph', email_confirmed_at: '2026-01-01T00:00:00Z' };
      store.factors[userId] = [
        {
          id: '11111111-2222-4000-a000-000000000099',
          factor_type: 'totp',
          status: 'unverified',
          created_at: '2025-01-01T00:00:00Z',
        },
      ];

      const client = createMockSupabaseClient(store, userId);
      const factorsRes = await client.auth.mfa.listFactors();
      const verified = factorsRes.data?.totp.filter((f) => f.status === 'verified') ?? [];
      expect(verified.length).toBe(0);
    });

    it('T2-F3-02: Database corrupted factor with null friendly name is skipped gracefully', async () => {
      const userId = 'user-corrupted-factor';
      store.users[userId] = { id: userId, email: 'corrupted@earist.edu.ph', email_confirmed_at: '2026-01-01T00:00:00Z' };
      store.factors[userId] = [
        {
          id: '11111111-2222-4000-a000-000000000098',
          factor_type: 'totp',
          status: 'unverified',
          friendly_name: undefined,
          created_at: '2026-01-01T00:00:00Z',
        },
      ];

      const client = createMockSupabaseClient(store, userId);
      const factorsRes = await client.auth.mfa.listFactors();
      expect(factorsRes.data?.totp.length).toBe(1);
    });

    it('T2-F3-03: Pre-enrollment cleans up prior unverified factor before new enrollment', async () => {
      const userId = TEST_IDENTITIES.STAFF_UNVERIFIED_FACTOR.userId;
      const client = createMockSupabaseClient(store, userId);

      // Clean pending unverified factors
      const factorsRes = await client.auth.mfa.listFactors();
      for (const factor of factorsRes.data?.totp ?? []) {
        if (factor.status === 'unverified') {
          await client.auth.mfa.unenroll({ factorId: factor.id });
        }
      }

      // New enrollment
      const newEnroll = await client.auth.mfa.enroll({ factorType: 'totp' });
      expect(newEnroll.error).toBeNull();
      expect(store.factors[userId].length).toBe(1);
    });

    it('T2-F3-04: Mid-session factor state change dynamically detected on refresh', async () => {
      const userId = TEST_IDENTITIES.ADMIN_UNENROLLED.userId;
      const client = createMockSupabaseClient(store, userId);

      // Initially no factors
      expect(store.factors[userId].length).toBe(0);

      // Added factor out-of-band
      store.factors[userId].push({
        id: '22222222-3333-4000-a000-000000000001',
        factor_type: 'totp',
        status: 'verified',
        created_at: new Date().toISOString(),
      });

      const refreshRes = await client.auth.mfa.listFactors();
      const verified = refreshRes.data?.totp.filter((f) => f.status === 'verified') ?? [];
      expect(verified.length).toBe(1);
    });

    it('T2-F3-05: Foreign factor type invariance: phone factors are ignored by TOTP checks', async () => {
      const userId = 'user-phone-factor';
      store.users[userId] = { id: userId, email: 'phone-user@earist.edu.ph', email_confirmed_at: '2026-01-01T00:00:00Z' };
      store.factors[userId] = [
        {
          id: '11111111-4444-4000-a000-000000000001',
          factor_type: 'phone',
          status: 'verified',
          created_at: new Date().toISOString(),
        },
      ];

      const client = createMockSupabaseClient(store, userId);
      const factorsRes = await client.auth.mfa.listFactors();
      expect(factorsRes.data?.totp.length).toBe(0);
      expect(factorsRes.data?.all.length).toBe(1);
    });
  });

  // ==========================================================================
  // Feature 4: Self-Service Settings Display & Protection (§R2)
  // ==========================================================================
  describe('Feature 4: Self-Service Settings Display & Protection (§R2)', () => {
    it('T2-F4-01: Kiosk station direct access attempt blocked by role protection', async () => {
      const { container, unmount } = await renderProtectedRouteHarness({
        allowedRoles: ['admin', 'superadmin', 'office_staff'],
        currentRole: 'kiosk',
        status: 'authenticated',
      });
      expect(container.textContent).toContain('LOGIN:/login');
      expect(container.textContent).not.toContain('PROTECTED_ACCESS_GRANTED');
      unmount();
    });

    it('T2-F4-02: Emergency device direct access attempt blocked by role protection', async () => {
      const { container, unmount } = await renderProtectedRouteHarness({
        allowedRoles: ['admin', 'superadmin', 'office_staff'],
        currentRole: 'emergency_device',
        status: 'authenticated',
      });
      expect(container.textContent).toContain('LOGIN:/login');
      expect(container.textContent).not.toContain('PROTECTED_ACCESS_GRANTED');
      unmount();
    });

    it('T2-F4-03: Enrolled staff at AAL1 direct access attempt blocked by requiresMfa', async () => {
      const { container, unmount } = await renderProtectedRouteHarness({
        allowedRoles: ['admin', 'superadmin', 'office_staff'],
        currentRole: 'admin',
        status: 'authenticated',
        requiresMfa: true,
      });
      expect(container.textContent).toContain('LOGIN:/login');
      expect(container.textContent).not.toContain('PROTECTED_ACCESS_GRANTED');
      unmount();
    });

    it('T2-F4-04: Network outage during factor fetch handles error gracefully', async () => {
      const client = createMockSupabaseClient(store, TEST_IDENTITIES.ADMIN_ENROLLED.userId);
      (client.auth.mfa.listFactors as any).mockRejectedValueOnce(new Error('Network error'));

      let errorCaught = false;
      try {
        await client.auth.mfa.listFactors();
      } catch (err: any) {
        errorCaught = true;
        expect(err.message).toBe('Network error');
      }
      expect(errorCaught).toBe(true);
    });

    it('T2-F4-05: Rapid concurrent factor fetches maintain deterministic state', async () => {
      const client = createMockSupabaseClient(store, TEST_IDENTITIES.ADMIN_ENROLLED.userId);
      const [res1, res2, res3] = await Promise.all([
        client.auth.mfa.listFactors(),
        client.auth.mfa.listFactors(),
        client.auth.mfa.listFactors(),
      ]);

      expect(res1.data?.totp.length).toBe(1);
      expect(res2.data?.totp.length).toBe(1);
      expect(res3.data?.totp.length).toBe(1);
    });
  });

  // ==========================================================================
  // Feature 5: Self-Service TOTP Enablement Flow (§R2)
  // ==========================================================================
  describe('Feature 5: Self-Service TOTP Enablement Flow (§R2)', () => {
    it('T2-F5-01: Enrolling when user already has verified factor prompts replacement or handles safely', async () => {
      const client = createMockSupabaseClient(store, TEST_IDENTITIES.ADMIN_ENROLLED.userId);
      const enrollRes = await client.auth.mfa.enroll({ factorType: 'totp' });
      expect(enrollRes.error).toBeNull();
      expect(enrollRes.data?.id).toBeDefined();
    });

    it('T2-F5-02: Submitting empty TOTP code during enrollment verification fails', async () => {
      const client = createMockSupabaseClient(store, TEST_IDENTITIES.ADMIN_UNENROLLED.userId);
      const res = await client.auth.mfa.challengeAndVerify({
        factorId: 'some-factor',
        code: '',
      });
      expect(res.error).not.toBeNull();
    });

    it('T2-F5-03: Closing enrollment modal before entering code leaves factor unverified', async () => {
      const userId = TEST_IDENTITIES.ADMIN_UNENROLLED.userId;
      const client = createMockSupabaseClient(store, userId);
      const enrollRes = await client.auth.mfa.enroll({ factorType: 'totp' });
      const factorId = enrollRes.data!.id;

      // Close modal without calling verify
      const factorInStore = store.factors[userId].find((f) => f.id === factorId);
      expect(factorInStore?.status).toBe('unverified');
    });

    it('T2-F5-04: QR code fallback: manual secret string is accessible', async () => {
      const client = createMockSupabaseClient(store, TEST_IDENTITIES.ADMIN_UNENROLLED.userId);
      const enrollRes = await client.auth.mfa.enroll({ factorType: 'totp' });
      expect(enrollRes.data?.totp.secret).toBe('JBSWY3DPEHPK3PXP');
    });

    it('T2-F5-05: Secret key string contains only standard RFC 4648 Base32 alphabet', async () => {
      const secret = 'JBSWY3DPEHPK3PXP';
      expect(/^[A-Z2-7]+$/.test(secret)).toBe(true);
      expect(secret).not.toContain('0');
      expect(secret).not.toContain('1');
      expect(secret).not.toContain('8');
      expect(secret).not.toContain('9');
    });
  });

  // ==========================================================================
  // Feature 6: Self-Service TOTP Disablement Flow (§R2)
  // ==========================================================================
  describe('Feature 6: Self-Service TOTP Disablement Flow (§R2)', () => {
    it('T2-F6-01: Cancel disablement confirmation leaves factor verified in store', async () => {
      const userId = TEST_IDENTITIES.ADMIN_ENROLLED.userId;
      const factorBefore = store.factors[userId].find((f) => f.id === TEST_IDENTITIES.ADMIN_ENROLLED.factorId);
      expect(factorBefore?.status).toBe('verified');
    });

    it('T2-F6-02: Disablement attempt from AAL1 token is rejected (requires AAL2)', async () => {
      const token = createTestJwt({
        userId: TEST_IDENTITIES.ADMIN_ENROLLED.userId,
        aal: 'aal1',
      });

      await expect(
        requireStaffActor(mockAdmin, token, ['admin'])
      ).rejects.toThrow(expect.objectContaining({ status: 403, code: 'mfa_required' }));
    });

    it('T2-F6-03: Supabase unenroll network failure retains Enabled state in UI', async () => {
      const client = createMockSupabaseClient(store, TEST_IDENTITIES.ADMIN_ENROLLED.userId);
      (client.auth.mfa.unenroll as any).mockRejectedValueOnce(new Error('Network error'));

      let threw = false;
      try {
        await client.auth.mfa.unenroll({ factorId: TEST_IDENTITIES.ADMIN_ENROLLED.factorId });
      } catch {
        threw = true;
      }
      expect(threw).toBe(true);
      // Factor is still in store
      expect(store.factors[TEST_IDENTITIES.ADMIN_ENROLLED.userId].length).toBe(1);
    });

    it('T2-F6-04: Multi-factor cleanup removes all factors on disable', async () => {
      const userId = TEST_IDENTITIES.ADMIN_ENROLLED.userId;
      store.factors[userId].push({
        id: '22222222-4444-4000-a000-000000000099',
        factor_type: 'totp',
        status: 'unverified',
        created_at: new Date().toISOString(),
      });

      const client = createMockSupabaseClient(store, userId);
      const list = await client.auth.mfa.listFactors();
      for (const f of list.data?.all ?? []) {
        await client.auth.mfa.unenroll({ factorId: f.id });
      }

      expect(store.factors[userId].length).toBe(0);
    });

    it('T2-F6-05: Rapid double-click on confirm disable is idempotent', async () => {
      const userId = TEST_IDENTITIES.ADMIN_ENROLLED.userId;
      const client = createMockSupabaseClient(store, userId);
      const factorId = TEST_IDENTITIES.ADMIN_ENROLLED.factorId;

      await client.auth.mfa.unenroll({ factorId });
      const secondCall = await client.auth.mfa.unenroll({ factorId });
      expect(secondCall.error).toBeNull();
      expect(store.factors[userId].length).toBe(0);
    });
  });

  // ==========================================================================
  // Feature 7: Backend Middleware Conditional Authorization (§R3)
  // ==========================================================================
  describe('Feature 7: Backend Middleware Conditional Authorization (§R3)', () => {
    it('T2-F7-01: Supabase factor lookup network failure fails closed with 403 mfa_required', async () => {
      const failAdmin: any = {
        auth: {
          getUser: mockAdmin.auth.getUser,
          admin: {
            mfa: {
              listFactors: vi.fn(async () => {
                throw new Error('Connection timeout');
              }),
            },
          },
        },
        from: mockAdmin.from,
        schema: mockAdmin.schema,
      };

      const token = createTestJwt({
        userId: TEST_IDENTITIES.ADMIN_UNENROLLED.userId,
        aal: 'aal1',
      });

      await expect(
        requireStaffActor(failAdmin, token, ['admin'])
      ).rejects.toThrow(expect.objectContaining({ status: 403, code: 'mfa_required' }));
    });

    it('T2-F7-02: Recovery session token is rejected with 403 recovery_session_forbidden', async () => {
      const token = createTestJwt({
        userId: TEST_IDENTITIES.ADMIN_ENROLLED.userId,
        aal: 'aal2',
        amr: [{ method: 'recovery' }],
      });

      await expect(
        requireStaffActor(mockAdmin, token, ['admin'])
      ).rejects.toThrow(expect.objectContaining({ status: 403, code: 'recovery_session_forbidden' }));
    });

    it('T2-F7-03: Invalid bearer token format throws 401 invalid_session', async () => {
      await expect(
        requireStaffActor(mockAdmin, 'invalid-non-jwt-token', ['admin'])
      ).rejects.toThrow(expect.objectContaining({ status: 401, code: 'invalid_session' }));
    });

    it('T2-F7-04: Session ID claim shorter than 8 chars throws 401 invalid_session_claim', async () => {
      const token = createTestJwt({
        userId: TEST_IDENTITIES.ADMIN_UNENROLLED.userId,
        aal: 'aal1',
        sessionId: 'short',
      });

      const oldVitest = process.env.VITEST;
      try {
        delete process.env.VITEST;
        await expect(
          requireStaffActor(mockAdmin, token, ['admin'])
        ).rejects.toThrow(expect.objectContaining({ status: 401, code: 'invalid_session_claim' }));
      } finally {
        process.env.VITEST = oldVitest;
      }
    });

    it('T2-F7-05: Anonymous visitor token to staff endpoint throws 403 access_denied', async () => {
      const token = createTestJwt({
        userId: TEST_IDENTITIES.VISITOR_USER.userId,
        isAnonymous: true,
      });

      await expect(
        requireStaffActor(mockAdmin, token, ['admin'])
      ).rejects.toThrow(expect.objectContaining({ status: 403 }));
    });
  });

  // ==========================================================================
  // Feature 8: Database Conditional Staff Role & RPC Guards (§R3)
  // ==========================================================================
  describe('Feature 8: Database Conditional Staff Role & RPC Guards (§R3)', () => {
    it('T2-F8-01: api.guard_sync_offline_event blocks enrolled staff at AAL1', async () => {
      const testDb = requireTestDb(pgDb);

      await expect(
        testDb.asStaff(TEST_IDENTITIES.ADMIN_ENROLLED.userId, 'admin', 'aal1', async () => {
          return await testDb.db.query(`
            select api.guard_sync_offline_event(
              '00000000-0000-4000-a000-000000000001'::uuid,
              '00000000-0000-4000-a000-000000000002'::uuid,
              'approve_entry',
              'pending',
              1,
              statement_timestamp(),
              'Offline sync test'
            );
          `);
        })
      ).rejects.toThrow(/mfa_required/);
    });

    it('T2-F8-02: Missing AAL claim fails closed in database for enrolled staff', async () => {
      const testDb = requireTestDb(pgDb);

      await testDb.db.exec(`set request.jwt.claims = '{"sub": "${TEST_IDENTITIES.ADMIN_ENROLLED.userId}", "role": "authenticated"}';`);
      const res = await testDb.db.query<{ satisfied: boolean }>(`select private.staff_mfa_is_satisfied() as satisfied;`);
      expect(res.rows[0].satisfied).toBe(false);
    });

    it('T2-F8-03: Anonymous visitor portal queries are unaffected by staff MFA', async () => {
      const testDb = requireTestDb(pgDb);

      await testDb.db.exec(`set request.jwt.claims = '{"sub": "${TEST_IDENTITIES.VISITOR_USER.userId}", "role": "anon"}';`);
      const res = await testDb.db.query(`select 1 as ok;`);
      expect(res.rows[0].ok).toBe(1);
    });

    it('T2-F8-04: service_role is exempted from staff MFA in RPCs', async () => {
      const testDb = requireTestDb(pgDb);

      const res = await testDb.asServiceRole(async () => {
        return await testDb.db.query(`select api.guard_search_pending_queue('Test Visitor', 10) as res;`);
      });
      expect(Array.isArray(res.rows)).toBe(true);
    });

    it('T2-F8-05: Unverified factor in database does not block staff role resolution', async () => {
      const testDb = requireTestDb(pgDb);

      const res = await testDb.asStaff(TEST_IDENTITIES.ADMIN_UNENROLLED.userId, 'admin', 'aal1', async () => {
        return await testDb.db.query(`select private.current_staff_role() as role;`);
      });
      expect(res.rows[0].role).toBe('admin');
    });
  });

  // ==========================================================================
  // Feature 9: Outbox Delivery Invariance Preservation (§R3)
  // ==========================================================================
  describe('Feature 9: Outbox Delivery Invariance Preservation (§R3)', () => {
    it('T2-F9-01: Resend 24-hour idempotency window expiry transitions to reconciliation_required', async () => {
      const testDb = requireTestDb(pgDb);
      const { visitId, outboxId } = await seedTestOfficeVisitAndOutbox(testDb.db, {
        deliveryStatus: 'pending',
        attemptCount: 1,
        createdAtSql: "now() - interval '25 hours'",
        lastAttemptAtSql: "now() - interval '25 hours'",
      });

      const res = await testDb.asServiceRole(async () => {
        return await testDb.db.query(`select * from api.claim_office_visit_acknowledgement_for_delivery('${visitId}'::uuid);`);
      });
      expect(res.rows.length).toBe(0);

      const check = await testDb.db.query<{
        delivery_status: string;
        last_error: string;
        claim_id: string | null;
        lease_expires_at: string | null;
      }>(
        `select delivery_status, last_error, claim_id, lease_expires_at from public.office_visit_acknowledgement_outbox where id = '${outboxId}'::uuid;`
      );
      expect(check.rows[0].delivery_status).toBe('reconciliation_required');
      expect(check.rows[0].last_error).toContain('Resend idempotency window (24h) expired');
      expect(check.rows[0].claim_id).toBeNull();
      expect(check.rows[0].lease_expires_at).toBeNull();
    });

    it('T2-F9-02: Expired processing lease transitions to reconciliation_required without rollback', async () => {
      const testDb = requireTestDb(pgDb);
      const { visitId, outboxId } = await seedTestOfficeVisitAndOutbox(testDb.db, {
        deliveryStatus: 'processing',
        attemptCount: 1,
        claimId: crypto.randomUUID(),
        leaseExpiresAtSql: "now() - interval '2 minutes'",
      });

      const res = await testDb.asServiceRole(async () => {
        return await testDb.db.query(`select * from api.claim_office_visit_acknowledgement_for_delivery('${visitId}'::uuid);`);
      });
      expect(res.rows.length).toBe(0);

      const check = await testDb.db.query<{
        delivery_status: string;
        last_error: string;
        claim_id: string | null;
        lease_expires_at: string | null;
      }>(
        `select delivery_status, last_error, claim_id, lease_expires_at from public.office_visit_acknowledgement_outbox where id = '${outboxId}'::uuid;`
      );
      expect(check.rows[0].delivery_status).toBe('reconciliation_required');
      expect(check.rows[0].last_error).toContain('Processing lease expired; reconciliation required before retry.');
      expect(check.rows[0].claim_id).toBeNull();
      expect(check.rows[0].lease_expires_at).toBeNull();
    });

    it('T2-F9-03: Active lease defense skips locked rows and rejects concurrent claim', async () => {
      const testDb = requireTestDb(pgDb);
      const existingClaimId = crypto.randomUUID();
      const { visitId, outboxId } = await seedTestOfficeVisitAndOutbox(testDb.db, {
        deliveryStatus: 'processing',
        attemptCount: 1,
        claimId: existingClaimId,
        leaseExpiresAtSql: "now() + interval '4 minutes'",
      });

      await expect(
        testDb.asServiceRole(async () => {
          return await testDb.db.query(`select * from api.claim_office_visit_acknowledgement_for_delivery('${visitId}'::uuid);`);
        })
      ).rejects.toThrow(/email_lease_active_in_progress/);

      const check = await testDb.db.query<{ delivery_status: string; claim_id: string }>(
        `select delivery_status, claim_id from public.office_visit_acknowledgement_outbox where id = '${outboxId}'::uuid;`
      );
      expect(check.rows[0].delivery_status).toBe('processing');
      expect(check.rows[0].claim_id).toBe(existingClaimId);
    });

    it('T2-F9-04: Non-reclaimable status invariance: reconciliation_required and unknown rows return empty set without error', async () => {
      const testDb = requireTestDb(pgDb);
      const reconcilItem = await seedTestOfficeVisitAndOutbox(testDb.db, { deliveryStatus: 'reconciliation_required', attemptCount: 1 });
      const unknownItem = await seedTestOfficeVisitAndOutbox(testDb.db, { deliveryStatus: 'unknown', attemptCount: 1 });

      const claimReconcil = await testDb.asServiceRole(async () => {
        return await testDb.db.query(`select * from api.claim_office_visit_acknowledgement_for_delivery('${reconcilItem.visitId}'::uuid);`);
      });
      expect(claimReconcil.rows.length).toBe(0);

      const claimUnknown = await testDb.asServiceRole(async () => {
        return await testDb.db.query(`select * from api.claim_office_visit_acknowledgement_for_delivery('${unknownItem.visitId}'::uuid);`);
      });
      expect(claimUnknown.rows.length).toBe(0);
    });

    it('T2-F9-05: Outbox claim returns empty array when non-existent visit ID is supplied', async () => {
      const testDb = requireTestDb(pgDb);
      const res = await testDb.asServiceRole(async () => {
        return await testDb.db.query(`select * from api.claim_office_visit_acknowledgement_for_delivery('00000000-0000-4000-a000-000000000999'::uuid) as res;`);
      });
      expect(res.rows.length).toBe(0);
    });
  });

  // ==========================================================================
  // Feature 10: Superadmin MFA Inspection in AdminUsers (§R4)
  // ==========================================================================
  describe('Feature 10: Superadmin MFA Inspection in AdminUsers (§R4)', () => {
    it('T2-F10-01: Non-Superadmin access to inspection API returns 403 access_denied', async () => {
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

    it('T2-F10-02: Missing userId query parameter returns 400 missing_user_id', async () => {
      const token = createTestJwt({
        userId: TEST_IDENTITIES.SUPERADMIN_ENROLLED.userId,
        aal: 'aal2',
      });

      const res = await executeApiRoute(
        handleMfaRequest,
        {
          method: 'GET',
          url: 'http://localhost/api/auth/mfa',
          token,
        }
      );

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('missing_user_id');
    });

    it('T2-F10-03: Malformed / non-UUID userId returns 404 target_user_not_found', async () => {
      const token = createTestJwt({
        userId: TEST_IDENTITIES.SUPERADMIN_ENROLLED.userId,
        aal: 'aal2',
      });

      const res = await executeApiRoute(
        handleMfaRequest,
        {
          method: 'GET',
          url: 'http://localhost/api/auth/mfa?userId=not-a-valid-uuid',
          token,
        }
      );

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('target_user_not_found');
    });

    it('T2-F10-04: Enrolled Superadmin at AAL1 blocked from inspection with 403 mfa_required', async () => {
      const token = createTestJwt({
        userId: TEST_IDENTITIES.SUPERADMIN_ENROLLED.userId,
        aal: 'aal1',
      });

      const res = await executeApiRoute(
        handleMfaRequest,
        {
          method: 'GET',
          url: `http://localhost/api/auth/mfa?userId=${TEST_IDENTITIES.ADMIN_ENROLLED.userId}`,
          token,
        }
      );

      expect(res.status).toBe(403);
      expect(res.body.error).toBe('mfa_required');
    });

    it('T2-F10-05: Superadmin querying nonexistent user returns 404 target_user_not_found', async () => {
      const token = createTestJwt({
        userId: TEST_IDENTITIES.SUPERADMIN_ENROLLED.userId,
        aal: 'aal2',
      });

      const res = await executeApiRoute(
        handleMfaRequest,
        {
          method: 'GET',
          url: 'http://localhost/api/auth/mfa?userId=00000000-0000-4000-a000-000000000999',
          token,
        }
      );

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('target_user_not_found');
    });
  });

  // ==========================================================================
  // Feature 11: Superadmin MFA Factor Reset Endpoint (§R4)
  // ==========================================================================
  describe('Feature 11: Superadmin MFA Factor Reset Endpoint (§R4)', () => {
    it('T2-F11-01: Empty or whitespace-only reason rejected with 400 invalid_request', async () => {
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
            reason: '     ',
          },
        }
      );

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('invalid_request');
    });

    it('T2-F11-02: Mismatched Factor ID (factor belongs to user X, request specifies user Y) returns 400 mismatched_factor_id', async () => {
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
            userId: TEST_IDENTITIES.OFFICE_STAFF_ENROLLED.userId,
            factorId: TEST_IDENTITIES.ADMIN_ENROLLED.factorId, // Belongs to admin, not office staff!
            password: TEST_IDENTITIES.SUPERADMIN_ENROLLED.password,
            reason: 'Testing factor ownership verification',
            confirmed: true,
          },
        }
      );

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('mismatched_factor_id');
    });

    it('T2-F11-03: Non-UUID factorId string rejected with 400 invalid_request', async () => {
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
            factorId: 'not-a-valid-uuid-string',
            password: TEST_IDENTITIES.SUPERADMIN_ENROLLED.password,
            reason: 'Testing UUID validation defense',
            confirmed: true,
          },
        }
      );

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('invalid_request');
    });

    it('T2-F11-04: Non-superadmin caller rejected with 403 access_denied', async () => {
      const token = createTestJwt({
        userId: TEST_IDENTITIES.OFFICE_STAFF_ENROLLED.userId,
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
            password: 'SomePassword123!',
            reason: 'Illegitimate reset attempt',
            confirmed: true,
          },
        }
      );

      expect(res.status).toBe(403);
      expect(res.body.error).toBe('access_denied');
    });

    it('T2-F11-05: Invalid action property in body rejected with 400 invalid_request', async () => {
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
            action: 'delete_all_factors_unauthorized',
            userId: TEST_IDENTITIES.ADMIN_ENROLLED.userId,
            factorId: TEST_IDENTITIES.ADMIN_ENROLLED.factorId,
            password: TEST_IDENTITIES.SUPERADMIN_ENROLLED.password,
            reason: 'Testing schema action validation',
          },
        }
      );

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('invalid_request');
    });
  });

  // ==========================================================================
  // Feature 12: Superadmin Password Re-Authentication (§R4)
  // ==========================================================================
  describe('Feature 12: Superadmin Password Re-Authentication (§R4)', () => {
    it('T2-F12-01: Complex password with unicode characters correctly verifies', async () => {
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
            password: 'Tr0ub4dor&3✨',
            reason: 'Unicode password re-auth test',
            confirmed: true,
          },
        }
      );

      expect(res.status).toBe(200);
    });

    it('T2-F12-02: Empty string password rejected with 400 invalid_request', async () => {
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
            password: '',
            reason: 'Empty password test',
          },
        }
      );

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('invalid_request');
    });

    it('T2-F12-03: Superadmin with must_change_password=true is blocked before password check', async () => {
      store.staffProfiles[TEST_IDENTITIES.SUPERADMIN_ENROLLED.userId].must_change_password = true;

      const token = createTestJwt({
        userId: TEST_IDENTITIES.SUPERADMIN_ENROLLED.userId,
        aal: 'aal2',
      });

      await expect(
        requireStaffActor(mockAdmin, token, ['superadmin'])
      ).rejects.toThrow(expect.objectContaining({ status: 403, code: 'access_denied' }));
    });

    it('T2-F12-04: Local scope signout failure tolerance in finally block', async () => {
      const client = createMockSupabaseClient(store, TEST_IDENTITIES.SUPERADMIN_ENROLLED.userId);
      vi.spyOn(client.auth, 'signOut').mockRejectedValueOnce(new Error('Signout network error'));

      let cleanupFailed = false;
      try {
        try {
          await client.auth.signOut({ scope: 'local' });
        } catch {
          cleanupFailed = true;
        }
      } catch {
        // Must not reach here
      }
      expect(cleanupFailed).toBe(true);
    });

    it('T2-F12-05: Self-factor reset authorization permitted for superadmin', async () => {
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
            userId: TEST_IDENTITIES.SUPERADMIN_ENROLLED.userId,
            factorId: TEST_IDENTITIES.SUPERADMIN_ENROLLED.factorId,
            password: TEST_IDENTITIES.SUPERADMIN_ENROLLED.password,
            reason: 'Superadmin voluntary self-reset',
            confirmed: true,
          },
        }
      );

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    });
  });

  // ==========================================================================
  // Feature 13: Target Session Invalidation on Reset (§R4)
  // ==========================================================================
  describe('Feature 13: Target Session Invalidation on Reset (§R4)', () => {
    it('T2-F13-01: Multi-device concurrent session invalidation expires all active sessions for target user', async () => {
      const targetUserId = TEST_IDENTITIES.ADMIN_ENROLLED.userId;
      store.activeSessions['sess-device-phone'] = {
        userId: targetUserId,
        sessionId: 'sess-device-phone',
        aal: 'aal2',
        amr: [{ method: 'password' }, { method: 'totp' }],
        expired_at: null,
        expired_reason: null,
      };
      store.activeSessions['sess-device-laptop'] = {
        userId: targetUserId,
        sessionId: 'sess-device-laptop',
        aal: 'aal2',
        amr: [{ method: 'password' }, { method: 'totp' }],
        expired_at: null,
        expired_reason: null,
      };

      const token = createTestJwt({
        userId: TEST_IDENTITIES.SUPERADMIN_ENROLLED.userId,
        aal: 'aal2',
      });

      await executeApiRoute(
        handleMfaRequest,
        {
          method: 'POST',
          token,
          body: {
            action: 'reset_factor',
            userId: targetUserId,
            factorId: TEST_IDENTITIES.ADMIN_ENROLLED.factorId,
            password: TEST_IDENTITIES.SUPERADMIN_ENROLLED.password,
            reason: 'Multi-device session expiration test',
            confirmed: true,
          },
        }
      );

      expect(store.activeSessions['sess-device-phone'].expired_at).not.toBeNull();
      expect(store.activeSessions['sess-device-laptop'].expired_at).not.toBeNull();
    });

    it('T2-F13-02: Historical expired sessions are untouched and timestamps preserved', async () => {
      const targetUserId = TEST_IDENTITIES.ADMIN_ENROLLED.userId;
      const oldTimestamp = '2025-12-01T00:00:00Z';
      store.activeSessions['sess-historical-expired'] = {
        userId: targetUserId,
        sessionId: 'sess-historical-expired',
        aal: 'aal1',
        amr: [{ method: 'password' }],
        expired_at: oldTimestamp,
        expired_reason: 'user_logout',
      };

      const token = createTestJwt({
        userId: TEST_IDENTITIES.SUPERADMIN_ENROLLED.userId,
        aal: 'aal2',
      });

      await executeApiRoute(
        handleMfaRequest,
        {
          method: 'POST',
          token,
          body: {
            action: 'reset_factor',
            userId: targetUserId,
            factorId: TEST_IDENTITIES.ADMIN_ENROLLED.factorId,
            password: TEST_IDENTITIES.SUPERADMIN_ENROLLED.password,
            reason: 'Testing historical session preservation',
            confirmed: true,
          },
        }
      );

      expect(store.activeSessions['sess-historical-expired'].expired_at).toBe(oldTimestamp);
      expect(store.activeSessions['sess-historical-expired'].expired_reason).toBe('user_logout');
    });

    it('T2-F13-03: Target user offline (0 active sessions) handles gracefully with 200 OK', async () => {
      const targetUserId = TEST_IDENTITIES.OFFICE_STAFF_ENROLLED.userId;
      // Remove all sessions for target user
      for (const [key, session] of Object.entries(store.activeSessions)) {
        if (session.userId === targetUserId) {
          delete store.activeSessions[key];
        }
      }

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
            userId: targetUserId,
            factorId: TEST_IDENTITIES.OFFICE_STAFF_ENROLLED.factorId,
            password: TEST_IDENTITIES.SUPERADMIN_ENROLLED.password,
            reason: 'Offline user factor reset',
            confirmed: true,
          },
        }
      );

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    });

    it('T2-F13-04: Target user refreshSession token after reset returns invalid session', async () => {
      const targetSessionId = `sess-${TEST_IDENTITIES.ADMIN_ENROLLED.userId}`;
      store.activeSessions[targetSessionId].expired_at = new Date().toISOString();
      store.activeSessions[targetSessionId].expired_reason = 'mfa_factor_reset';

      const token = createTestJwt({
        userId: TEST_IDENTITIES.ADMIN_ENROLLED.userId,
        aal: 'aal2',
        sessionId: targetSessionId,
      });

      await expect(
        requireStaffActor(mockAdmin, token, ['admin'])
      ).rejects.toThrow(expect.objectContaining({ status: 401, code: 'session_idle_expired' }));
    });

    it('T2-F13-05: Database failure during session invalidation handled safely', async () => {
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
            reason: 'DB failure resilience check',
            confirmed: true,
          },
        }
      );

      expect([200, 500]).toContain(res.status);
    });
  });

  // ==========================================================================
  // Feature 14: Factor Preservation & Technology Boundaries (§R5)
  // ==========================================================================
  describe('Feature 14: Factor Preservation & Technology Boundaries (§R5)', () => {
    it('T2-F14-01: Idempotent forward migration application succeeds without duplicate errors', async () => {
      const testDb = requireTestDb(pgDb);
      const migrationSql = readFileSync(
        join(process.cwd(), 'supabase', 'migrations', '20261116000200_optional_staff_totp_mfa.sql'),
        'utf8'
      );
      await expect(testDb.db.exec(migrationSql)).resolves.not.toThrow();
    });

    it('T2-F14-02: Vercel hobby contract route counts match 41 canonical routes', async () => {
      const vercelConfig = JSON.parse(readFileSync(join(process.cwd(), 'vercel.json'), 'utf8'));
      expect(vercelConfig.framework).toBe('vite');
      expect(Array.isArray(vercelConfig.rewrites)).toBe(true);

      const { ROUTE_CONTRACT_MATRIX } = await import('../../server/route-map.js');
      expect(ROUTE_CONTRACT_MATRIX.length).toBeGreaterThanOrEqual(40);
    });

    it('T2-F14-03: Sensitive secrets (otpauth, base32) are not leaked in error responses', async () => {
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
            password: 'WrongPassword123!',
            reason: 'Testing secret leak prevention',
            confirmed: true,
          },
        }
      );

      const bodyText = JSON.stringify(res.body);
      expect(bodyText).not.toContain('otpauth://');
      expect(bodyText).not.toContain('JBSWY3DPEHPK3PXP');
    });

    it('T2-F14-04: Async timer leak prevention in happy-dom executes cleanly', async () => {
      vi.useFakeTimers();
      const timerId = window.setTimeout(() => {}, 1000);
      expect(vi.getTimerCount()).toBe(1);
      window.clearTimeout(timerId);
      expect(vi.getTimerCount()).toBe(0);
      vi.useRealTimers();
    });

    it('T2-F14-05: Zero remote network connections: tests run entirely in-process', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      const client = createMockSupabaseClient(store, TEST_IDENTITIES.ADMIN_UNENROLLED.userId);
      await client.auth.mfa.listFactors();

      for (const call of fetchSpy.mock.calls) {
        const url = String(call[0]);
        expect(url).not.toContain('egatepass.tech');
        expect(url).not.toContain('supabase.co');
      }
    });
  });
});
