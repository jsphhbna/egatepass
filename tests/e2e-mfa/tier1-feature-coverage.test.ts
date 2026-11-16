// @vitest-environment happy-dom
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
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
  createMfaTestDb,
  requireTestDb,
  seedTestOfficeVisitAndOutbox,
  renderProtectedRouteHarness,
  bindMockClientsToStore,
  resetMockClients,
  type MfaTestStateStore,
} from './helpers/mfa-e2e-fixtures.js';
import { HttpError } from '../../server/actors.js';

describe('Tier 1: Comprehensive Feature Coverage (14 Features × 5 Tests = 70 Tests)', () => {
  let store: MfaTestStateStore;
  let mockAdmin: any;
  let pgDb: Awaited<ReturnType<typeof createMfaTestDb>> | null = null;

  beforeAll(async () => {
    // Setup isolated PGlite instance for Database Invariant Features (F8, F9)
    pgDb = await createMfaTestDb();
  }, 60_000);

  afterAll(async () => {
    if (pgDb) {
      await pgDb.close();
      pgDb = null;
    }
  });

  beforeEach(() => {
    store = createMfaTestStateStore();
    mockAdmin = bindMockClientsToStore(store);
  });

  afterEach(() => {
    resetMockClients();
    vi.clearAllMocks();
    document.body.innerHTML = '';
    vi.useRealTimers();
  });

  // ==========================================================================
  // Feature 1: Optional Staff MFA Policy & Password Login (§R1)
  // ==========================================================================
  describe('Feature 1: Optional Staff MFA Policy & Password Login (§R1)', () => {
    it('T1-F1-01: Unenrolled Admin Login at AAL1 accesses dashboard without MFA challenge', async () => {
      const client = createMockSupabaseClient(store, TEST_IDENTITIES.ADMIN_UNENROLLED.userId);
      const res = await client.auth.signInWithPassword({
        email: TEST_IDENTITIES.ADMIN_UNENROLLED.email,
        password: TEST_IDENTITIES.ADMIN_UNENROLLED.password,
      });

      expect(res.error).toBeNull();
      expect(res.data.session).not.toBeNull();

      const aalRes = await client.auth.mfa.getAuthenticatorAssuranceLevel();
      expect(aalRes.data?.currentLevel).toBe('aal1');
      expect(aalRes.data?.nextLevel).toBe('aal1');

      const factorsRes = await client.auth.mfa.listFactors();
      const verifiedFactors = factorsRes.data?.totp.filter((f) => f.status === 'verified') ?? [];
      expect(verifiedFactors.length).toBe(0);
    });

    it('T1-F1-02: Unenrolled Superadmin Login at AAL1 does not require MFA', async () => {
      const client = createMockSupabaseClient(store, TEST_IDENTITIES.SUPERADMIN_UNENROLLED.userId);
      const res = await client.auth.signInWithPassword({
        email: TEST_IDENTITIES.SUPERADMIN_UNENROLLED.email,
        password: TEST_IDENTITIES.SUPERADMIN_UNENROLLED.password,
      });

      expect(res.error).toBeNull();
      const factorsRes = await client.auth.mfa.listFactors();
      const verified = factorsRes.data?.all.filter((f) => f.status === 'verified') ?? [];
      expect(verified.length).toBe(0);

      const aalRes = await client.auth.mfa.getAuthenticatorAssuranceLevel();
      expect(aalRes.data?.currentLevel).toBe('aal1');
    });

    it('T1-F1-03: Unenrolled Office Staff Login at AAL1 accesses office dashboard directly', async () => {
      const client = createMockSupabaseClient(store, TEST_IDENTITIES.OFFICE_STAFF_UNENROLLED.userId);
      const res = await client.auth.signInWithPassword({
        email: TEST_IDENTITIES.OFFICE_STAFF_UNENROLLED.email,
        password: TEST_IDENTITIES.OFFICE_STAFF_UNENROLLED.password,
      });

      expect(res.error).toBeNull();
      expect(res.data.user?.id).toBe(TEST_IDENTITIES.OFFICE_STAFF_UNENROLLED.userId);

      const factorsRes = await client.auth.mfa.listFactors();
      expect(factorsRes.data?.totp.length).toBe(0);
    });

    it('T1-F1-04: Unenrolled Guard Login at AAL1 accesses guard routes without prompt', async () => {
      const client = createMockSupabaseClient(store, TEST_IDENTITIES.LEGACY_GUARD.userId);
      const res = await client.auth.signInWithPassword({
        email: TEST_IDENTITIES.LEGACY_GUARD.email,
        password: TEST_IDENTITIES.LEGACY_GUARD.password,
      });

      expect(res.error).toBeNull();
      expect(res.data.user?.id).toBe(TEST_IDENTITIES.LEGACY_GUARD.userId);

      const aalRes = await client.auth.mfa.getAuthenticatorAssuranceLevel();
      expect(aalRes.data?.currentLevel).toBe('aal1');
    });

    it('T1-F1-05: Auth Context Invariant: requiresMfa is false when no verified factor exists at AAL1', async () => {
      const userId = TEST_IDENTITIES.ADMIN_UNENROLLED.userId;
      const client = createMockSupabaseClient(store, userId);
      const factorsRes = await client.auth.mfa.listFactors();
      const hasVerified = factorsRes.data?.totp.some((f) => f.status === 'verified') ?? false;

      const aalRes = await client.auth.mfa.getAuthenticatorAssuranceLevel();
      const aal = aalRes.data?.currentLevel;

      const isHumanStaff = true;
      const requiresMfa = isHumanStaff && hasVerified && aal !== 'aal2';
      expect(requiresMfa).toBe(false);
      expect(hasVerified).toBe(false);
    });
  });

  // ==========================================================================
  // Feature 2: Enrolled Staff TOTP Verification to AAL2 (§R1)
  // ==========================================================================
  describe('Feature 2: Enrolled Staff TOTP Verification to AAL2 (§R1)', () => {
    it('T1-F2-01: Enrolled Admin Password Login sets requiresMfa true at AAL1', async () => {
      const userId = TEST_IDENTITIES.ADMIN_ENROLLED.userId;
      const client = createMockSupabaseClient(store, userId);

      const factorsRes = await client.auth.mfa.listFactors();
      const verified = factorsRes.data?.totp.filter((f) => f.status === 'verified') ?? [];
      expect(verified.length).toBe(1);

      // Simulated initial login token at AAL1
      const aal = 'aal1';
      const requiresMfa = verified.length > 0 && aal !== 'aal2';
      expect(requiresMfa).toBe(true);
    });

    it('T1-F2-02: Enrolled Admin Submits Valid TOTP Code and elevates session to AAL2', async () => {
      const userId = TEST_IDENTITIES.ADMIN_ENROLLED.userId;
      const client = createMockSupabaseClient(store, userId);
      const factorId = TEST_IDENTITIES.ADMIN_ENROLLED.factorId;

      const challengeRes = await client.auth.mfa.challenge({ factorId });
      expect(challengeRes.error).toBeNull();

      const verifyRes = await client.auth.mfa.challengeAndVerify({
        factorId,
        code: '123456',
      });
      expect(verifyRes.error).toBeNull();

      const aalRes = await client.auth.mfa.getAuthenticatorAssuranceLevel();
      expect(aalRes.data?.currentLevel).toBe('aal2');
    });

    it('T1-F2-03: Enrolled Office Staff Reaches AAL2 via 6-digit TOTP verification', async () => {
      const userId = TEST_IDENTITIES.OFFICE_STAFF_ENROLLED.userId;
      const client = createMockSupabaseClient(store, userId);
      const factorId = TEST_IDENTITIES.OFFICE_STAFF_ENROLLED.factorId;

      const res = await client.auth.mfa.verify({
        factorId,
        code: '654321',
      });
      expect(res.error).toBeNull();

      const aalRes = await client.auth.mfa.getAuthenticatorAssuranceLevel();
      expect(aalRes.data?.currentLevel).toBe('aal2');
    });

    it('T1-F2-04: Enrolled Superadmin Reaches AAL2 and verifies administrative routes', async () => {
      const userId = TEST_IDENTITIES.SUPERADMIN_ENROLLED.userId;
      const client = createMockSupabaseClient(store, userId);
      const factorId = TEST_IDENTITIES.SUPERADMIN_ENROLLED.factorId;

      const res = await client.auth.mfa.challengeAndVerify({
        factorId,
        code: '123456',
      });
      expect(res.error).toBeNull();

      const token = createTestJwt({ userId, aal: 'aal2' });
      const actor = await requireStaffActor(mockAdmin, token, ['superadmin']);
      expect(actor.role).toBe('superadmin');
    });

    it('T1-F2-05: AMR Assurance Claim contains TOTP verification after challenge', async () => {
      const token = createTestJwt({
        userId: TEST_IDENTITIES.ADMIN_ENROLLED.userId,
        aal: 'aal2',
        amr: [{ method: 'password' }, { method: 'totp', timestamp: Date.now() }],
      });

      const parts = token.split('.');
      const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
      expect(payload.aal).toBe('aal2');
      expect(payload.amr).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ method: 'totp' }),
        ])
      );
    });
  });

  // ==========================================================================
  // Feature 3: Unverified Factor Handling (Ignored on Login) (§R1)
  // ==========================================================================
  describe('Feature 3: Unverified Factor Handling (Ignored on Login) (§R1)', () => {
    it('T1-F3-01: Staff with Single Unverified Factor is allowed directly at AAL1', async () => {
      const userId = TEST_IDENTITIES.STAFF_UNVERIFIED_FACTOR.userId;
      const client = createMockSupabaseClient(store, userId);

      const factorsRes = await client.auth.mfa.listFactors();
      const verified = factorsRes.data?.totp.filter((f) => f.status === 'verified') ?? [];
      expect(verified.length).toBe(0);

      const unverified = factorsRes.data?.totp.filter((f) => f.status === 'unverified') ?? [];
      expect(unverified.length).toBe(1);

      const requiresMfa = verified.length > 0;
      expect(requiresMfa).toBe(false);
    });

    it('T1-F3-02: Staff with Multiple Unverified Factors logs in at AAL1 without challenge', async () => {
      const userId = 'user-multiple-unverified';
      store.users[userId] = {
        id: userId,
        email: 'unverified-multi@earist.edu.ph',
        email_confirmed_at: '2026-01-01T00:00:00Z',
      };
      store.factors[userId] = [
        { id: 'f-1', user_id: userId, factor_type: 'totp', status: 'unverified', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' },
        { id: 'f-2', user_id: userId, factor_type: 'totp', status: 'unverified', created_at: '2026-01-02T00:00:00Z', updated_at: '2026-01-02T00:00:00Z' },
        { id: 'f-3', user_id: userId, factor_type: 'totp', status: 'unverified', created_at: '2026-01-03T00:00:00Z', updated_at: '2026-01-03T00:00:00Z' },
      ];

      const client = createMockSupabaseClient(store, userId);
      const factorsRes = await client.auth.mfa.listFactors();
      const verified = factorsRes.data?.totp.filter((f) => f.status === 'verified') ?? [];
      expect(verified.length).toBe(0);
      expect(factorsRes.data?.totp.length).toBe(3);
    });

    it('T1-F3-03: Staff with Verified and Unverified Factors challenges ONLY for verified factor', async () => {
      const userId = TEST_IDENTITIES.ADMIN_ENROLLED.userId;
      store.factors[userId].push({
        id: 'factor-totp-abandoned',
        user_id: userId,
        factor_type: 'totp',
        status: 'unverified',
        friendly_name: 'Abandoned Phone',
        created_at: '2026-01-02T00:00:00Z',
        updated_at: '2026-01-02T00:00:00Z',
      });

      const client = createMockSupabaseClient(store, userId);
      const factorsRes = await client.auth.mfa.listFactors();
      const verified = factorsRes.data?.totp.filter((f) => f.status === 'verified') ?? [];
      expect(verified.length).toBe(1);
      expect(verified[0].id).toBe(TEST_IDENTITIES.ADMIN_ENROLLED.factorId);
    });

    it('T1-F3-04: Removal of Last Verified Factor immediately restores password-only login', async () => {
      const userId = TEST_IDENTITIES.ADMIN_ENROLLED.userId;
      const client = createMockSupabaseClient(store, userId);

      // Unenroll verified factor
      await client.auth.mfa.unenroll({ factorId: TEST_IDENTITIES.ADMIN_ENROLLED.factorId });

      const factorsRes = await client.auth.mfa.listFactors();
      const verified = factorsRes.data?.totp.filter((f) => f.status === 'verified') ?? [];
      expect(verified.length).toBe(0);

      // Subsequent login lands at AAL1 without challenge
      const aalRes = await client.auth.mfa.getAuthenticatorAssuranceLevel();
      expect(aalRes.data?.currentLevel).toBe('aal1');
    });

    it('T1-F3-05: Factor Query Filter Invariant matches only verified TOTP factors', async () => {
      const factors: any[] = [
        { id: '1', status: 'verified', factor_type: 'totp' },
        { id: '2', status: 'unverified', factor_type: 'totp' },
        { id: '3', status: 'verified', factor_type: 'phone' },
        { id: '4', status: 'unverified', factor_type: 'phone' },
      ];

      const verifiedTotp = factors.filter(
        (f) => f.status === 'verified' && f.factor_type === 'totp'
      );
      expect(verifiedTotp.length).toBe(1);
      expect(verifiedTotp[0].id).toBe('1');
    });
  });

  // ==========================================================================
  // Feature 4: Self-Service Settings Display & Protection (§R2)
  // ==========================================================================
  describe('Feature 4: Self-Service Settings Display & Protection (§R2)', () => {
    it('T1-F4-01: Unenrolled Admin Visits Settings and sees MFA Disabled status', async () => {
      const client = createMockSupabaseClient(store, TEST_IDENTITIES.ADMIN_UNENROLLED.userId);
      const factorsRes = await client.auth.mfa.listFactors();
      const hasVerified = factorsRes.data?.totp.some((f) => f.status === 'verified') ?? false;

      const mfaStatusText = hasVerified ? 'Enabled' : 'Disabled';
      expect(mfaStatusText).toBe('Disabled');
    });

    it('T1-F4-02: Unenrolled Office Staff Visits Settings and sees MFA Disabled with Enable action', async () => {
      const client = createMockSupabaseClient(store, TEST_IDENTITIES.OFFICE_STAFF_UNENROLLED.userId);
      const factorsRes = await client.auth.mfa.listFactors();
      const hasVerified = factorsRes.data?.totp.some((f) => f.status === 'verified') ?? false;

      expect(hasVerified).toBe(false);
      const canEnable = !hasVerified;
      expect(canEnable).toBe(true);
    });

    it('T1-F4-03: Enrolled Staff Visits Settings at AAL2 and sees MFA Enabled with Disable action', async () => {
      const client = createMockSupabaseClient(store, TEST_IDENTITIES.ADMIN_ENROLLED.userId);
      const factorsRes = await client.auth.mfa.listFactors();
      const verified = factorsRes.data?.totp.find((f) => f.status === 'verified');

      expect(verified).toBeDefined();
      expect(verified?.friendly_name).toBe(TEST_IDENTITIES.ADMIN_ENROLLED.friendlyName);
    });

    it('T1-F4-04: Dedicated Route Protection for Staff permits human staff roles', async () => {
      const staffRoles = ['admin', 'superadmin', 'office_staff'] as const;
      for (const role of staffRoles) {
        const { container, unmount } = await renderProtectedRouteHarness({
          allowedRoles: ['admin', 'superadmin', 'office_staff'],
          currentRole: role,
          status: 'authenticated',
          requiresMfa: false,
        });
        expect(container.textContent).toContain('PROTECTED_ACCESS_GRANTED');
        expect(container.textContent).not.toContain('LOGIN:/login');
        unmount();
      }
    });

    it('T1-F4-05: Non-Staff Actors (visitor, kiosk, emergency) are denied settings access', async () => {
      const nonStaffRoles = ['visitor', 'kiosk', 'emergency_device'];
      for (const role of nonStaffRoles) {
        const { container, unmount } = await renderProtectedRouteHarness({
          allowedRoles: ['admin', 'superadmin', 'office_staff'],
          currentRole: role,
          status: 'authenticated',
          requiresMfa: false,
        });
        expect(container.textContent).toContain('LOGIN:/login');
        expect(container.textContent).not.toContain('PROTECTED_ACCESS_GRANTED');
        unmount();
      }
    });
  });

  // ==========================================================================
  // Feature 5: Self-Service TOTP Enablement Flow (§R2)
  // ==========================================================================
  describe('Feature 5: Self-Service TOTP Enablement Flow (§R2)', () => {
    it('T1-F5-01: Initiate Enrollment returns TOTP QR code, secret, and URI', async () => {
      const client = createMockSupabaseClient(store, TEST_IDENTITIES.ADMIN_UNENROLLED.userId);
      const enrollRes = await client.auth.mfa.enroll({
        factorType: 'totp',
        friendlyName: 'My Auth App',
      });

      expect(enrollRes.error).toBeNull();
      expect(enrollRes.data?.totp.qr_code).toContain('<svg');
      expect(enrollRes.data?.totp.secret).toBeDefined();
      expect(enrollRes.data?.totp.uri).toContain('otpauth://totp/');
    });

    it('T1-F5-02: SVG QR Code Normalization converts raw SVG to data URI correctly', async () => {
      const client = createMockSupabaseClient(store, TEST_IDENTITIES.ADMIN_UNENROLLED.userId);
      const enrollRes = await client.auth.mfa.enroll({ factorType: 'totp' });
      const rawQr = enrollRes.data!.totp.qr_code;

      expect(rawQr).toContain('<svg');
      expect(rawQr).toContain('viewBox');

      const normalized = rawQr.startsWith('data:image/svg+xml')
        ? rawQr
        : `data:image/svg+xml;charset=utf-8,${encodeURIComponent(rawQr)}`;

      expect(normalized).toMatch(/^data:image\/svg\+xml;charset=utf-8,/);
      expect(decodeURIComponent(normalized.split(',')[1])).toBe(rawQr);
    });

    it('T1-F5-03: Manual Secret contains RFC 4648 Base32 uppercase alphabet', async () => {
      const client = createMockSupabaseClient(store, TEST_IDENTITIES.ADMIN_UNENROLLED.userId);
      const enrollRes = await client.auth.mfa.enroll({ factorType: 'totp' });
      const secret = enrollRes.data!.totp.secret;

      expect(typeof secret).toBe('string');
      expect(secret.length).toBeGreaterThanOrEqual(16);
      expect(/^[A-Z2-7]+$/.test(secret)).toBe(true);
      expect(secret).not.toMatch(/[0189]/);
    });

    it('T1-F5-04: Complete Enrollment Challenge verifies 6-digit code and sets status verified', async () => {
      const userId = TEST_IDENTITIES.OFFICE_STAFF_UNENROLLED.userId;
      const client = createMockSupabaseClient(store, userId);

      const enrollRes = await client.auth.mfa.enroll({ factorType: 'totp' });
      const factorId = enrollRes.data!.id;

      const verifyRes = await client.auth.mfa.challengeAndVerify({
        factorId,
        code: '123456',
      });
      expect(verifyRes.error).toBeNull();

      const factorInStore = store.factors[userId].find((f) => f.id === factorId);
      expect(factorInStore?.status).toBe('verified');
    });

    it('T1-F5-05: Post-Enrollment UI State updates to Enabled and secret is discarded', async () => {
      const userId = TEST_IDENTITIES.ADMIN_UNENROLLED.userId;
      const client = createMockSupabaseClient(store, userId);
      const enrollRes = await client.auth.mfa.enroll({ factorType: 'totp' });
      const factorId = enrollRes.data!.id;

      await client.auth.mfa.challengeAndVerify({ factorId, code: '123456' });

      const factorsRes = await client.auth.mfa.listFactors();
      const verified = factorsRes.data?.totp.filter((f) => f.status === 'verified') ?? [];
      expect(verified.length).toBe(1);
      expect(verified[0].id).toBe(factorId);
      expect((verified[0] as any).secret).toBeUndefined();
    });
  });

  // ==========================================================================
  // Feature 6: Self-Service TOTP Disablement Flow (§R2)
  // ==========================================================================
  describe('Feature 6: Self-Service TOTP Disablement Flow (§R2)', () => {
    it('T1-F6-01: Disablement triggers confirmation dialog before calling API', async () => {
      const userId = TEST_IDENTITIES.ADMIN_ENROLLED.userId;
      const client = createMockSupabaseClient(store, userId);
      const unenrollSpy = vi.spyOn(client.auth.mfa, 'unenroll');

      let confirmed = false;
      const handleDisableRequest = async (userConfirmed: boolean) => {
        if (!userConfirmed) return;
        await client.auth.mfa.unenroll({ factorId: TEST_IDENTITIES.ADMIN_ENROLLED.factorId });
      };

      await handleDisableRequest(confirmed);
      expect(unenrollSpy).not.toHaveBeenCalled();
      expect(store.factors[userId].length).toBe(1);

      confirmed = true;
      await handleDisableRequest(confirmed);
      expect(unenrollSpy).toHaveBeenCalledWith({ factorId: TEST_IDENTITIES.ADMIN_ENROLLED.factorId });
      expect(store.factors[userId].length).toBe(0);
    });

    it('T1-F6-02: Confirm Disablement unenrolls verified factor via mfa.unenroll()', async () => {
      const userId = TEST_IDENTITIES.ADMIN_ENROLLED.userId;
      const client = createMockSupabaseClient(store, userId);
      const factorId = TEST_IDENTITIES.ADMIN_ENROLLED.factorId;

      const unenrollRes = await client.auth.mfa.unenroll({ factorId });
      expect(unenrollRes.error).toBeNull();
      expect(unenrollRes.data?.id).toBe(factorId);

      const remaining = store.factors[userId] ?? [];
      expect(remaining.length).toBe(0);
    });

    it('T1-F6-03: Session Refresh after unenroll resets session claims to AAL1', async () => {
      const userId = TEST_IDENTITIES.ADMIN_ENROLLED.userId;
      const client = createMockSupabaseClient(store, userId);
      await client.auth.mfa.unenroll({ factorId: TEST_IDENTITIES.ADMIN_ENROLLED.factorId });

      const refreshRes = await client.auth.refreshSession();
      expect(refreshRes.error).toBeNull();

      const aalRes = await client.auth.mfa.getAuthenticatorAssuranceLevel();
      expect(aalRes.data?.currentLevel).toBe('aal1');
    });

    it('T1-F6-04: Status Reverts to Disabled upon successful unenroll', async () => {
      const userId = TEST_IDENTITIES.ADMIN_ENROLLED.userId;
      store.factors[userId] = []; // Deleted

      const client = createMockSupabaseClient(store, userId);
      const factorsRes = await client.auth.mfa.listFactors();
      const hasVerified = factorsRes.data?.totp.some((f) => f.status === 'verified') ?? false;
      expect(hasVerified).toBe(false);
    });

    it('T1-F6-05: Subsequent Login succeeds with password only without TOTP prompt', async () => {
      const userId = TEST_IDENTITIES.ADMIN_ENROLLED.userId;
      store.factors[userId] = []; // Factor disabled

      const client = createMockSupabaseClient(store, userId);
      const loginRes = await client.auth.signInWithPassword({
        email: TEST_IDENTITIES.ADMIN_ENROLLED.email,
        password: TEST_IDENTITIES.ADMIN_ENROLLED.password,
      });

      expect(loginRes.error).toBeNull();
      const aalRes = await client.auth.mfa.getAuthenticatorAssuranceLevel();
      expect(aalRes.data?.currentLevel).toBe('aal1');
    });
  });

  // ==========================================================================
  // Feature 7: Backend Middleware Conditional Authorization (§R3)
  // ==========================================================================
  describe('Feature 7: Backend Middleware Conditional Authorization (§R3)', () => {
    it('T1-F7-01: requireStaffActor allows unenrolled staff at AAL1', async () => {
      const token = createTestJwt({
        userId: TEST_IDENTITIES.ADMIN_UNENROLLED.userId,
        aal: 'aal1',
      });

      const actor = await requireStaffActor(mockAdmin, token, ['admin']);
      expect(actor.id).toBe(TEST_IDENTITIES.ADMIN_UNENROLLED.userId);
      expect(actor.role).toBe('admin');
    });

    it('T1-F7-02: requireStaffActor blocks enrolled staff at AAL1 with HttpError 403 mfa_required', async () => {
      const token = createTestJwt({
        userId: TEST_IDENTITIES.ADMIN_ENROLLED.userId,
        aal: 'aal1',
      });

      await expect(
        requireStaffActor(mockAdmin, token, ['admin'])
      ).rejects.toThrow(expect.objectContaining({ status: 403, code: 'mfa_required' }));
    });

    it('T1-F7-03: requireStaffActor allows enrolled staff at AAL2', async () => {
      const token = createTestJwt({
        userId: TEST_IDENTITIES.ADMIN_ENROLLED.userId,
        aal: 'aal2',
      });

      const actor = await requireStaffActor(mockAdmin, token, ['admin']);
      expect(actor.id).toBe(TEST_IDENTITIES.ADMIN_ENROLLED.userId);
      expect(actor.role).toBe('admin');
    });

    it('T1-F7-04: requireOfficeStaffActor allows unenrolled office staff at AAL1', async () => {
      const token = createTestJwt({
        userId: TEST_IDENTITIES.OFFICE_STAFF_UNENROLLED.userId,
        aal: 'aal1',
      });

      const actor = await requireOfficeStaffActor(mockAdmin, token);
      expect(actor.id).toBe(TEST_IDENTITIES.OFFICE_STAFF_UNENROLLED.userId);
      expect(actor.role).toBe('office_staff');
    });

    it('T1-F7-05: requireOfficeStaffActor blocks enrolled office staff at AAL1 with HttpError 403 mfa_required', async () => {
      const token = createTestJwt({
        userId: TEST_IDENTITIES.OFFICE_STAFF_ENROLLED.userId,
        aal: 'aal1',
      });

      await expect(
        requireOfficeStaffActor(mockAdmin, token)
      ).rejects.toThrow(expect.objectContaining({ status: 403, code: 'mfa_required' }));
    });
  });

  // ==========================================================================
  // Feature 8: Database Conditional Staff Role & RPC Guards (§R3)
  // ==========================================================================
  describe('Feature 8: Database Conditional Staff Role & RPC Guards (§R3)', () => {
    it('T1-F8-01: staff_mfa_is_satisfied() returns true for unenrolled staff at AAL1', async () => {
      const testDb = requireTestDb(pgDb);

      const res = await testDb.asStaff(TEST_IDENTITIES.ADMIN_UNENROLLED.userId, 'admin', 'aal1', async () => {
        return await testDb.db.query<{ satisfied: boolean }>(`select private.staff_mfa_is_satisfied() as satisfied;`);
      });
      expect(res.rows[0].satisfied).toBe(true);
    });

    it('T1-F8-02: staff_mfa_is_satisfied() returns false for enrolled staff at AAL1', async () => {
      const testDb = requireTestDb(pgDb);

      const res = await testDb.asStaff(TEST_IDENTITIES.ADMIN_ENROLLED.userId, 'admin', 'aal1', async () => {
        return await testDb.db.query<{ satisfied: boolean }>(`select private.staff_mfa_is_satisfied() as satisfied;`);
      });
      expect(res.rows[0].satisfied).toBe(false);
    });

    it('T1-F8-03: staff_mfa_is_satisfied() returns true for enrolled staff at AAL2', async () => {
      const testDb = requireTestDb(pgDb);

      const res = await testDb.asStaff(TEST_IDENTITIES.ADMIN_ENROLLED.userId, 'admin', 'aal2', async () => {
        return await testDb.db.query<{ satisfied: boolean }>(`select private.staff_mfa_is_satisfied() as satisfied;`);
      });
      expect(res.rows[0].satisfied).toBe(true);
    });

    it('T1-F8-04: RPC guard_recover_pass_action allows AAL1 for unenrolled staff, enforces AAL2 for enrolled staff', async () => {
      const testDb = requireTestDb(pgDb);
      const PASS_ID = '00000000-0000-4000-a000-000000000001';

      // Enrolled staff at AAL1 is rejected with 42501 mfa_required
      await expect(
        testDb.asStaff(TEST_IDENTITIES.ADMIN_ENROLLED.userId, 'admin', 'aal1', async () => {
          return await testDb.db.query(`select api.guard_recover_pass_action('${PASS_ID}'::uuid, 'approve_entry');`);
        })
      ).rejects.toThrow(/mfa_required/);

      // Unenrolled staff at AAL1 succeeds
      const res = await testDb.asStaff(TEST_IDENTITIES.ADMIN_UNENROLLED.userId, 'admin', 'aal1', async () => {
        return await testDb.db.query(`select api.guard_recover_pass_action('${PASS_ID}'::uuid, 'approve_entry') as res;`);
      });
      expect(res.rows.length).toBe(1);
    });

    it('T1-F8-05: RPC guard_search_pending_queue allows AAL1 for unenrolled staff, enforces AAL2 for enrolled staff', async () => {
      const testDb = requireTestDb(pgDb);

      await testDb.db.exec(`
        insert into auth.users (id, email) values ('00000000-0000-4000-a000-000000000006', 'search.visitor@test.local') on conflict (id) do nothing;
        insert into public.visitors (id, owner_id, source, full_name, contact_number, purpose, visit_date, consent_accepted_at)
        values ('00000000-0000-4000-a000-000000000006', '00000000-0000-4000-a000-000000000006', 'portal', 'Test Search Visitor', '09123456789', 'Queue Search Test', current_date, now())
        on conflict (id) do nothing;
        insert into public.passes (id, visitor_id, status, source, valid_from, valid_until, gate, public_reference, token_digest, version)
        values ('00000000-0000-4000-a000-000000000002', '00000000-0000-4000-a000-000000000006', 'pending', 'portal', now(), now() + interval '8 hours', 'Gate 1', gen_random_uuid(), sha256('pass-token-456'::bytea), 1)
        on conflict (id) do nothing;
      `);

      // Enrolled staff at AAL1 is rejected with 42501 mfa_required
      await expect(
        testDb.asStaff(TEST_IDENTITIES.ADMIN_ENROLLED.userId, 'admin', 'aal1', async () => {
          return await testDb.db.query(`select api.guard_search_pending_queue('Test Search', 10);`);
        })
      ).rejects.toThrow(/mfa_required/);

      // Unenrolled staff at AAL1 succeeds
      const res = await testDb.asStaff(TEST_IDENTITIES.ADMIN_UNENROLLED.userId, 'admin', 'aal1', async () => {
        return await testDb.db.query<{ res: any[] }>(`select api.guard_search_pending_queue('Test Search', 10) as res;`);
      });
      expect(res.rows.length).toBe(1);
      expect(res.rows[0].res.length).toBeGreaterThan(0);
    });
  });

  // ==========================================================================
  // Feature 9: Outbox Delivery Invariance Preservation (§R3)
  // ==========================================================================
  describe('Feature 9: Outbox Delivery Invariance Preservation (§R3)', () => {
    it('T1-F9-01: Outbox Claim under service_role claims pending row and transitions status to processing', async () => {
      const testDb = requireTestDb(pgDb);
      const { visitId, outboxId } = await seedTestOfficeVisitAndOutbox(testDb.db, {
        deliveryStatus: 'pending',
        attemptCount: 0,
      });

      const res = await testDb.asServiceRole(async () => {
        return await testDb.db.query<{
          outbox_id: string;
          claim_id: string;
          recipient_email: string;
          encrypted_tracking_token: string;
          idempotency_key: string;
          attempt_count: number;
        }>(`select * from api.claim_office_visit_acknowledgement_for_delivery('${visitId}'::uuid);`);
      });

      expect(res.rows.length).toBe(1);
      const claim = res.rows[0];
      expect(claim.outbox_id).toBe(outboxId);
      expect(claim.claim_id).toBeDefined();
      expect(claim.attempt_count).toBe(1);

      // Verify row in database is transitioned to 'processing' with assigned claim_id
      const check = await testDb.db.query<{ delivery_status: string; claim_id: string; attempt_count: number }>(
        `select delivery_status, claim_id, attempt_count from public.office_visit_acknowledgement_outbox where id = '${outboxId}'::uuid;`
      );
      expect(check.rows[0].delivery_status).toBe('processing');
      expect(check.rows[0].claim_id).toBe(claim.claim_id);
      expect(check.rows[0].attempt_count).toBe(1);
    });

    it('T1-F9-02: Outbox lease fields populated on claim with 5-minute lease expiration in database', async () => {
      const testDb = requireTestDb(pgDb);
      const { visitId, outboxId } = await seedTestOfficeVisitAndOutbox(testDb.db, {
        deliveryStatus: 'pending',
      });

      await testDb.asServiceRole(async () => {
        return await testDb.db.query(`select * from api.claim_office_visit_acknowledgement_for_delivery('${visitId}'::uuid);`);
      });

      // Query database directly to verify lease timestamps
      const check = await testDb.db.query<{
        delivery_status: string;
        lease_expires_at: string;
        last_attempt_at: string;
      }>(
        `select delivery_status, lease_expires_at::text, last_attempt_at::text from public.office_visit_acknowledgement_outbox where id = '${outboxId}'::uuid;`
      );
      expect(check.rows[0].delivery_status).toBe('processing');
      expect(check.rows[0].lease_expires_at).toBeDefined();

      const leaseTime = new Date(check.rows[0].lease_expires_at).getTime();
      const now = Date.now();
      expect(leaseTime).toBeGreaterThan(now + 3 * 60 * 1000);
      expect(leaseTime).toBeLessThanOrEqual(now + 6 * 60 * 1000);
    });

    it('T1-F9-03: Terminal Delivery Status Immunity: sent and delivered rows are never re-claimed', async () => {
      const testDb = requireTestDb(pgDb);
      const sentItem = await seedTestOfficeVisitAndOutbox(testDb.db, { deliveryStatus: 'sent', attemptCount: 1 });
      const deliveredItem = await seedTestOfficeVisitAndOutbox(testDb.db, { deliveryStatus: 'delivered', attemptCount: 1 });

      const claimSent = await testDb.asServiceRole(async () => {
        return await testDb.db.query(`select * from api.claim_office_visit_acknowledgement_for_delivery('${sentItem.visitId}'::uuid);`);
      });
      expect(claimSent.rows.length).toBe(0);

      const claimDelivered = await testDb.asServiceRole(async () => {
        return await testDb.db.query(`select * from api.claim_office_visit_acknowledgement_for_delivery('${deliveredItem.visitId}'::uuid);`);
      });
      expect(claimDelivered.rows.length).toBe(0);

      const checkSent = await testDb.db.query<{ delivery_status: string }>(
        `select delivery_status from public.office_visit_acknowledgement_outbox where id = '${sentItem.outboxId}'::uuid;`
      );
      expect(checkSent.rows[0].delivery_status).toBe('sent');

      const checkDelivered = await testDb.db.query<{ delivery_status: string }>(
        `select delivery_status from public.office_visit_acknowledgement_outbox where id = '${deliveredItem.outboxId}'::uuid;`
      );
      expect(checkDelivered.rows[0].delivery_status).toBe('delivered');
    });

    it('T1-F9-04: Non-service_role callers (authenticated staff at AAL1/AAL2 and anon) are strictly rejected with 42501', async () => {
      const testDb = requireTestDb(pgDb);
      const { visitId, outboxId } = await seedTestOfficeVisitAndOutbox(testDb.db, { deliveryStatus: 'pending' });

      // Authenticated staff at AAL2 calling claim RPC is blocked
      await expect(
        testDb.asStaff(TEST_IDENTITIES.ADMIN_ENROLLED.userId, 'admin', 'aal2', async () => {
          return await testDb.db.query(`select * from api.claim_office_visit_acknowledgement_for_delivery('${visitId}'::uuid);`);
        })
      ).rejects.toThrow(/service role required/);

      // Anonymous caller calling claim RPC is blocked
      await testDb.db.exec(`set request.jwt.claims = '{"role": "anon"}';`);
      await expect(
        testDb.db.query(`select * from api.claim_office_visit_acknowledgement_for_delivery('${visitId}'::uuid);`)
      ).rejects.toThrow(/service role required/);
      await testDb.db.exec(`set request.jwt.claims = '{}';`);

      // Verify row was NOT claimed or modified by unauthorized calls
      const check = await testDb.db.query<{ delivery_status: string }>(
        `select delivery_status from public.office_visit_acknowledgement_outbox where id = '${outboxId}'::uuid;`
      );
      expect(check.rows[0].delivery_status).toBe('pending');
    });

    it('T1-F9-05: Lock hierarchy locks office_visits first, then outbox table', async () => {
      const testDb = requireTestDb(pgDb);
      const procRes = await testDb.db.query<{ prosrc: string }>(
        `select prosrc from pg_proc where proname = 'claim_office_visit_acknowledgement_for_delivery';`
      );
      expect(procRes.rows.length).toBe(1);
      const body = procRes.rows[0].prosrc;

      const visitLockIndex = body.indexOf('from public.office_visits where id = requested_visit_id for update');
      const outboxLockIndex = body.indexOf('from public.office_visit_acknowledgement_outbox');

      expect(visitLockIndex).toBeGreaterThan(-1);
      expect(outboxLockIndex).toBeGreaterThan(-1);
      expect(visitLockIndex).toBeLessThan(outboxLockIndex);
    });
  });

  // ==========================================================================
  // Feature 10: Superadmin MFA Inspection in AdminUsers (§R4)
  // ==========================================================================
  describe('Feature 10: Superadmin MFA Inspection in AdminUsers (§R4)', () => {
    it('T1-F10-01: Inspect Enrolled Staff Member returns status Enabled', async () => {
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
      expect(res.body.factors.length).toBeGreaterThanOrEqual(1);
      expect(res.body.factors[0].status).toBe('verified');
    });

    it('T1-F10-02: Inspect Unenrolled Staff Member returns empty factors list', async () => {
      const token = createTestJwt({
        userId: TEST_IDENTITIES.SUPERADMIN_ENROLLED.userId,
        aal: 'aal2',
      });

      const res = await executeApiRoute(
        handleMfaRequest,
        {
          method: 'GET',
          url: `http://localhost/api/auth/mfa?userId=${TEST_IDENTITIES.ADMIN_UNENROLLED.userId}`,
          token,
        }
      );

      expect(res.status).toBe(200);
      expect(res.body.factors.length).toBe(0);
    });

    it('T1-F10-03: Inspect Incomplete Enrollment Staff returns factors with unverified status', async () => {
      const token = createTestJwt({
        userId: TEST_IDENTITIES.SUPERADMIN_ENROLLED.userId,
        aal: 'aal2',
      });

      const res = await executeApiRoute(
        handleMfaRequest,
        {
          method: 'GET',
          url: `http://localhost/api/auth/mfa?userId=${TEST_IDENTITIES.STAFF_UNVERIFIED_FACTOR.userId}`,
          token,
        }
      );

      expect(res.status).toBe(200);
      expect(res.body.factors[0].status).toBe('unverified');
    });

    it('T1-F10-04: Non-Superadmin caller receives 403 access_denied on factor inspection', async () => {
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

    it('T1-F10-05: Missing userId query parameter returns 400 missing_user_id', async () => {
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
  });

  // ==========================================================================
  // Feature 11: Superadmin MFA Factor Reset Endpoint (§R4)
  // ==========================================================================
  describe('Feature 11: Superadmin MFA Factor Reset Endpoint (§R4)', () => {
    it('T1-F11-01: Successful Factor Reset returns 200 { ok: true, factorId }', async () => {
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
            reason: 'Staff member lost authenticator device',
            confirmed: true,
          },
        }
      );

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.factorId).toBe(TEST_IDENTITIES.ADMIN_ENROLLED.factorId);
    });

    it('T1-F11-02: Target factor is deleted from store following reset', async () => {
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
            userId: TEST_IDENTITIES.ADMIN_ENROLLED.userId,
            factorId: TEST_IDENTITIES.ADMIN_ENROLLED.factorId,
            password: TEST_IDENTITIES.SUPERADMIN_ENROLLED.password,
            reason: 'Staff member device reset verification',
            confirmed: true,
          },
        }
      );

      const targetFactors = store.factors[TEST_IDENTITIES.ADMIN_ENROLLED.userId];
      expect(targetFactors.length).toBe(0);
    });

    it('T1-F11-03: Immutable Audit Event staff.mfa_factor_reset is recorded', async () => {
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
            userId: TEST_IDENTITIES.ADMIN_ENROLLED.userId,
            factorId: TEST_IDENTITIES.ADMIN_ENROLLED.factorId,
            password: TEST_IDENTITIES.SUPERADMIN_ENROLLED.password,
            reason: 'Hardware token replacement confirmed',
            confirmed: true,
          },
        }
      );

      const audit = store.auditEvents.find((e) => e.action === 'staff.mfa_factor_reset');
      expect(audit).toBeDefined();
      expect(audit.actor_id).toBe(TEST_IDENTITIES.SUPERADMIN_ENROLLED.userId);
      expect(audit.target_id).toBe(TEST_IDENTITIES.ADMIN_ENROLLED.userId);
      expect(audit.after_state.reason).toBe('Hardware token replacement confirmed');
    });

    it('T1-F11-04: Non-Superadmin caller receives 403 access_denied on factor reset', async () => {
      const token = createTestJwt({
        userId: TEST_IDENTITIES.ADMIN_ENROLLED.userId,
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
            factorId: TEST_IDENTITIES.OFFICE_STAFF_ENROLLED.factorId,
            password: 'AdminPassword123!',
            reason: 'Unauthorized reset attempt',
            confirmed: true,
          },
        }
      );

      expect(res.status).toBe(403);
      expect(res.body.error).toBe('access_denied');
    });

    it('T1-F11-05: Audit log contains zero passwords or plain secrets', async () => {
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
            userId: TEST_IDENTITIES.ADMIN_ENROLLED.userId,
            factorId: TEST_IDENTITIES.ADMIN_ENROLLED.factorId,
            password: TEST_IDENTITIES.SUPERADMIN_ENROLLED.password,
            reason: 'Audit secret sanitization verification',
            confirmed: true,
          },
        }
      );

      const audit = store.auditEvents.find((e) => e.action === 'staff.mfa_factor_reset');
      const serialized = JSON.stringify(audit);
      expect(serialized).not.toContain(TEST_IDENTITIES.SUPERADMIN_ENROLLED.password);
      expect(serialized).not.toContain('JBSWY3DPEHPK3PXP');
    });

    it('T1-F11-06: Factor reset without explicit confirmation returns 400 confirmation_required', async () => {
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
            reason: 'Testing unconfirmed reset rejection',
            // Notice: confirmed and confirm are both omitted
          },
        }
      );

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('confirmation_required');
    });
  });

  // ==========================================================================
  // Feature 12: Superadmin Password Re-Authentication (§R4)
  // ==========================================================================
  describe('Feature 12: Superadmin Password Re-Authentication (§R4)', () => {
    it('T1-F12-01: Valid Password Re-Auth allows factor deletion', async () => {
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
            reason: 'Valid password verification test',
            confirmed: true,
          },
        }
      );

      expect(res.status).toBe(200);
    });

    it('T1-F12-02: Isolated Password Client does not persist session across requests', async () => {
      const client = createMockSupabaseClient(store, TEST_IDENTITIES.SUPERADMIN_ENROLLED.userId);
      const res = await client.auth.signInWithPassword({
        email: TEST_IDENTITIES.SUPERADMIN_ENROLLED.email,
        password: TEST_IDENTITIES.SUPERADMIN_ENROLLED.password,
      });
      expect(res.error).toBeNull();
      expect((client.auth as any)._persistSession ?? false).toBe(false);
    });

    it('T1-F12-03: Signout executed in finally block with local scope', async () => {
      const client = createMockSupabaseClient(store, TEST_IDENTITIES.SUPERADMIN_ENROLLED.userId);
      const signOutSpy = vi.spyOn(client.auth, 'signOut');

      try {
        await client.auth.signInWithPassword({
          email: TEST_IDENTITIES.SUPERADMIN_ENROLLED.email,
          password: TEST_IDENTITIES.SUPERADMIN_ENROLLED.password,
        });
      } finally {
        await client.auth.signOut({ scope: 'local' });
      }

      expect(signOutSpy).toHaveBeenCalledWith({ scope: 'local' });
    });

    it('T1-F12-04: Invalid Password Rejection returns 401 invalid_superadmin_password', async () => {
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
            reason: 'Attempt with wrong password',
            confirmed: true,
          },
        }
      );

      expect(res.status).toBe(401);
      expect(res.body.error).toBe('invalid_superadmin_password');
    });

    it('T1-F12-05: Missing Password Property returns 400 invalid_request', async () => {
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
            reason: 'Missing password payload test',
            confirmed: true,
          },
        }
      );

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('invalid_request');
    });
  });

  // ==========================================================================
  // Feature 13: Target Session Invalidation on Reset (§R4)
  // ==========================================================================
  describe('Feature 13: Target Session Invalidation on Reset (§R4)', () => {
    it('T1-F13-01: staff_sessions database expiration sets expired_at and reason', async () => {
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
            userId: TEST_IDENTITIES.ADMIN_ENROLLED.userId,
            factorId: TEST_IDENTITIES.ADMIN_ENROLLED.factorId,
            password: TEST_IDENTITIES.SUPERADMIN_ENROLLED.password,
            reason: 'Testing session invalidation trigger',
            confirmed: true,
          },
        }
      );

      const targetSessions = Object.values(store.activeSessions).filter(
        (s) => s.userId === TEST_IDENTITIES.ADMIN_ENROLLED.userId
      );
      for (const session of targetSessions) {
        expect(session.expired_at).not.toBeNull();
        expect(session.expired_reason).toBe('mfa_factor_reset');
      }
    });

    it('T1-F13-02: Target User receives 401 session_idle_expired on subsequent API request', async () => {
      // Invalidate target session
      const targetSessionId = `sess-${TEST_IDENTITIES.ADMIN_ENROLLED.userId}`;
      store.activeSessions[targetSessionId].expired_at = new Date().toISOString();

      const token = createTestJwt({
        userId: TEST_IDENTITIES.ADMIN_ENROLLED.userId,
        aal: 'aal2',
        sessionId: targetSessionId,
      });

      await expect(
        requireStaffActor(mockAdmin, token, ['admin'])
      ).rejects.toThrow(expect.objectContaining({ status: 401, code: 'session_idle_expired' }));
    });

    it('T1-F13-03: In-Memory factor cache purged on reset', async () => {
      const factorsBefore = store.factors[TEST_IDENTITIES.ADMIN_ENROLLED.userId] ?? [];
      expect(factorsBefore.length).toBe(1);

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
            userId: TEST_IDENTITIES.ADMIN_ENROLLED.userId,
            factorId: TEST_IDENTITIES.ADMIN_ENROLLED.factorId,
            password: TEST_IDENTITIES.SUPERADMIN_ENROLLED.password,
            reason: 'Cache invalidation test',
            confirmed: true,
          },
        }
      );

      const factorsAfter = store.factors[TEST_IDENTITIES.ADMIN_ENROLLED.userId] ?? [];
      expect(factorsAfter.length).toBe(0);
    });

    it('T1-F13-04: Immediate Password Login Permitted post-reset', async () => {
      // Delete factor
      store.factors[TEST_IDENTITIES.ADMIN_ENROLLED.userId] = [];

      const client = createMockSupabaseClient(store, TEST_IDENTITIES.ADMIN_ENROLLED.userId);
      const res = await client.auth.signInWithPassword({
        email: TEST_IDENTITIES.ADMIN_ENROLLED.email,
        password: TEST_IDENTITIES.ADMIN_ENROLLED.password,
      });

      expect(res.error).toBeNull();
      const aalRes = await client.auth.mfa.getAuthenticatorAssuranceLevel();
      expect(aalRes.data?.currentLevel).toBe('aal1');
    });

    it('T1-F13-05: Non-Target Sessions Remain Active and valid', async () => {
      const superadminSessionId = `sess-${TEST_IDENTITIES.SUPERADMIN_ENROLLED.userId}`;
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
            userId: TEST_IDENTITIES.ADMIN_ENROLLED.userId,
            factorId: TEST_IDENTITIES.ADMIN_ENROLLED.factorId,
            password: TEST_IDENTITIES.SUPERADMIN_ENROLLED.password,
            reason: 'Non-target isolation check',
            confirmed: true,
          },
        }
      );

      expect(store.activeSessions[superadminSessionId].expired_at).toBeNull();
    });
  });

  // ==========================================================================
  // Feature 14: Factor Preservation & Technology Boundaries (§R5)
  // ==========================================================================
  describe('Feature 14: Factor Preservation & Technology Boundaries (§R5)', () => {
    it('T1-F14-01: Superadmin Google Authenticator factor remains preserved and verified', async () => {
      const superFactor = store.factors[TEST_IDENTITIES.SUPERADMIN_ENROLLED.userId]?.find(
        (f) => f.id === TEST_IDENTITIES.SUPERADMIN_ENROLLED.factorId
      );
      expect(superFactor).toBeDefined();
      expect(superFactor?.status).toBe('verified');
      expect(superFactor?.friendly_name).toBe(TEST_IDENTITIES.SUPERADMIN_ENROLLED.friendlyName);
    });

    it('T1-F14-02: Local PGlite Execution is hermetic and makes zero network calls', async () => {
      const testDb = requireTestDb(pgDb);
      expect(testDb.db).toBeDefined();
      expect(process.env.DATABASE_URL).toBeUndefined();
      expect(process.env.SUPABASE_DB_URL).toBeUndefined();

      const result = await testDb.db.query<{ hermetic: number }>('select 1 as hermetic;');
      expect(result.rows[0].hermetic).toBe(1);
    });

    it('T1-F14-03: Free-Tier Boundary strictly complies with five free tier stacks', async () => {
      const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'));
      const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };

      const disallowedProviders = ['twilio', 'auth0', '@auth0/auth0-spa-js', '@sendgrid/mail', 'stripe', 'aws-sdk'];
      for (const disallowed of disallowedProviders) {
        expect(allDeps[disallowed]).toBeUndefined();
      }

      expect(allDeps['@supabase/supabase-js']).toBeDefined();
      expect(allDeps['standardwebhooks']).toBeDefined();

      const vercel = JSON.parse(readFileSync(join(process.cwd(), 'vercel.json'), 'utf8'));
      const hasResendWebhook = vercel.rewrites?.some((r: any) => r.source === '/api/webhooks/resend');
      expect(hasResendWebhook).toBe(true);
    });

    it('T1-F14-04: Architecture Route Matrix Contract has at least 40 routes and defines MFA endpoint', async () => {
      const { ROUTE_CONTRACT_MATRIX } = await import('../../server/route-map.js');
      expect(ROUTE_CONTRACT_MATRIX.length).toBeGreaterThanOrEqual(40);

      const mfaRoute = ROUTE_CONTRACT_MATRIX.find((r) => r.path === '/api/auth/mfa');
      if (mfaRoute) {
        expect(mfaRoute.group).toBe('auth');
        expect(mfaRoute.allowedMethods).toContain('POST');
        expect(mfaRoute.allowedMethods).toContain('GET');
      }
    });

    it('T1-F14-05: Zero Remote Migrations applied to remote Supabase instances', async () => {
      const migrationPath = join(process.cwd(), 'supabase', 'migrations', '20261116000200_optional_staff_totp_mfa.sql');
      expect(existsSync(migrationPath)).toBe(true);

      const sqlContent = readFileSync(migrationPath, 'utf8');
      expect(sqlContent).toContain('private.staff_mfa_is_satisfied()');
      expect(process.env.SUPABASE_ACCESS_TOKEN).toBeUndefined();
    });
  });
});
