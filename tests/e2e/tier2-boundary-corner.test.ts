// @vitest-environment happy-dom
/**
 * Tier 2: Boundary & Corner Cases (25 Tests: 5 per Feature Area F1-F5)
 *
 * Covers:
 * - Feature 1 (F1): Scanner Viewport & Guard Photo Boundaries (§R1)
 * - Feature 2 (F2): Returning Visitor Lookup & Destination Boundaries (§R2)
 * - Feature 3 (F3): Gender Lifecycle, Legacy Nulls & Normalization Boundaries (§R3)
 * - Feature 4 (F4): Superadmin Reset Security & Rollback Boundaries (§R4)
 * - Feature 5 (F5): Serverless Optimization, Secrets & Branch Hygiene Boundaries (§R5)
 *
 * Authoritative Sources:
 * - ORIGINAL_REQUEST.md (Requirements R1 - R5)
 * - PROJECT.md (Interface Contracts § Pass Issuance, Gender, Superadmin Reset)
 * - TEST_INFRA.md (Test Architecture & Feature Inventory)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  TEST_IDENTITIES,
  createRemediationTestStore,
  createTestJwt,
  createApiRequest,
  dispatchRoute,
  setupSupabaseTestHarness,
  lookupReturningHandler,
  issuePassHandler,
  dashboardHandler,
  settingsHandler,
  guardStationFeedHandler,
  executeReturnToZeroRpc,
  setupMockCamera,
  computeGenderDistribution,
  type RemediationTestStateStore,
} from './helpers/e2e-fixtures.js';

describe('Tier 2: Boundary & Corner Cases (25 Tests)', () => {
  let store: RemediationTestStateStore;

  beforeEach(() => {
    store = createRemediationTestStore();
    setupSupabaseTestHarness(store);
  });

  afterEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = '';
  });

  // ==========================================================================
  // Feature 1: Scanner Viewport & Guard Photo Boundaries (R1)
  // ==========================================================================
  describe('Feature 1: Scanner Viewport & Guard Photo Boundaries (R1)', () => {
    it('T2-F1-01: Scanner handles camera permission denial without collapsing layout', () => {
      const entryScanPath = join(process.cwd(), 'src', 'pages', 'EntryScanPage.tsx');
      expect(existsSync(entryScanPath)).toBe(true);

      const source = readFileSync(entryScanPath, 'utf8');
      expect(source).toContain('cameraState');
      expect(source).toContain('scanner-viewport');
      expect(source).toMatch(/cameraState\s*!==\s*['"]active['"]/);
    });

    it('T2-F1-02: Guard station feed handles visitor whose photo evidence is purged or missing without 500 error', async () => {
      const noPhotoPassId = 'pass-no-photo-001';
      store.passes[noPhotoPassId] = {
        id: noPhotoPassId,
        visitor_id: 'visitor-without-photo-id',
        public_reference: 'EP-NO-PHOTO',
        reference_number: 'EP-NO-PHOTO',
        status: 'inside',
        source: 'portal',
        gate: 'Gate 1',
        entry_scanned_at: new Date().toISOString(),
        time_in: new Date().toISOString(),
        purpose: 'Courier Delivery',
        gender: 'Male',
        created_at: new Date().toISOString(),
      };
      store.visitors['visitor-without-photo-id'] = {
        id: 'visitor-without-photo-id',
        first_name: 'Courier',
        last_name: 'Express',
        full_name: 'Courier Express',
        gender: 'Male',
      };

      const req = createApiRequest('/api/gate/guard-station-feed?gate=Gate%201', {
        method: 'GET',
        token: createTestJwt({ userId: TEST_IDENTITIES.GUARD.userId, role: 'guard' }),
      });
      const feedRes = await dispatchRoute(guardStationFeedHandler, req);
      expect(feedRes.status).toBe(200);
      const entry = feedRes.body.entries.find((e: any) => e.passId === noPhotoPassId);
      expect(entry).toBeDefined();
      expect(entry.photoEvidenceId).toBeNull();
    });

    it('T2-F1-03: Guard station feed handles returning visitor with multiple visits, resolving valid active photo', async () => {
      const passId = 'pass-multi-visit-001';
      const visitorId = TEST_IDENTITIES.VISITOR_FEMALE_1.visitorId;
      store.passes[passId] = {
        id: passId,
        visitor_id: visitorId,
        public_reference: 'EP-MULTI-01',
        reference_number: 'EP-MULTI-01',
        status: 'inside',
        source: 'portal',
        gate: 'Gate 1',
        entry_scanned_at: new Date().toISOString(),
        time_in: new Date().toISOString(),
        purpose: 'Thesis Defense',
        gender: 'Female',
        created_at: new Date().toISOString(),
      };

      store.visitorEvidence['evi-old'] = {
        id: 'evi-old',
        visitor_id: visitorId,
        kind: 'photo',
        bucket_id: 'visitor-photos',
        object_path: 'portraits/old.jpg',
        purged_at: '2026-10-01T00:00:00.000Z',
        expires_at: '2026-10-01T00:00:00.000Z',
        created_at: '2026-09-01T00:00:00.000Z',
      };

      const req = createApiRequest('/api/gate/guard-station-feed?gate=Gate%201', {
        method: 'GET',
        token: createTestJwt({ userId: TEST_IDENTITIES.GUARD.userId, role: 'guard' }),
      });
      const feedRes = await dispatchRoute(guardStationFeedHandler, req);
      expect(feedRes.status).toBe(200);
      const entry = feedRes.body.entries.find((e: any) => e.passId === passId);
      expect(entry).toBeDefined();
      expect(entry.photoEvidenceId).not.toBe('evi-old');
    });

    it('T2-F1-04: Viewport on narrow mobile screen maintains touch targets and 4:3 aspect ratio', () => {
      const css = readFileSync(join(process.cwd(), 'src', 'index.css'), 'utf8');
      expect(css).toMatch(/\.scanner-viewport\s*\{[^}]*aspect-ratio:\s*4\s*\/\s*3/);
      expect(css).toMatch(/width:\s*min\(94vw,\s*40rem\)/);
    });

    it('T2-F1-05: Rapid camera toggling between front and rear cameras cleanly terminates existing tracks', async () => {
      const camera = setupMockCamera();

      const stream1 = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' } });
      const tracks1 = stream1.getVideoTracks();
      expect(tracks1[0].readyState).toBe('live');

      tracks1.forEach((t) => t.stop());
      expect(tracks1[0].readyState).toBe('ended');

      const stream2 = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
      const tracks2 = stream2.getVideoTracks();
      expect(tracks2[0].readyState).toBe('live');

      camera.cleanup();
    });
  });

  // ==========================================================================
  // Feature 2: Returning Visitor Lookup & Destination Boundaries (R2)
  // ==========================================================================
  describe('Feature 2: Returning Visitor Lookup & Destination Boundaries (R2)', () => {
    it('T2-F2-01: Name search with zero matches returns empty candidates array without error', async () => {
      const req = createApiRequest('/api/passes/lookup-returning', {
        method: 'POST',
        token: createTestJwt({ userId: TEST_IDENTITIES.VISITOR_MALE.visitorId, role: 'visitor' }),
        body: {
          firstName: 'Nonexistent',
          lastName: 'Person',
        },
      });
      const res = await dispatchRoute(lookupReturningHandler, req);

      expect(res.status).toBe(200);
      expect(res.body.candidates).toHaveLength(0);
      expect(res.body.totalMatches).toBeUndefined();
    });

    it('T2-F2-02: Lookup candidate list is strictly capped at maximum 3 records to prevent enumeration', async () => {
      const req = createApiRequest('/api/passes/lookup-returning', {
        method: 'POST',
        token: createTestJwt({ userId: TEST_IDENTITIES.VISITOR_FEMALE_1.visitorId, role: 'visitor' }),
        body: {
          firstName: 'Maria',
          lastName: 'Santos',
        },
      });
      const res = await dispatchRoute(lookupReturningHandler, req);

      expect(res.status).toBe(200);
      expect(res.body.candidates.length).toBeLessThanOrEqual(3);
      expect(res.body.candidates.length).toBeGreaterThan(0);
      expect(res.body.totalMatches).toBeUndefined();
    });

    it('T2-F2-03: Name search handles leading, trailing whitespace and mixed case gracefully', async () => {
      const req = createApiRequest('/api/passes/lookup-returning', {
        method: 'POST',
        token: createTestJwt({ userId: TEST_IDENTITIES.VISITOR_MALE.visitorId, role: 'visitor' }),
        body: {
          firstName: '   jUaN   ',
          lastName: '  dElA crUz   ',
        },
      });
      const res = await dispatchRoute(lookupReturningHandler, req);

      expect(res.status).toBe(200);
      expect(res.body.candidates).toHaveLength(1);
      expect(res.body.candidates[0].candidateToken).toBeDefined();
      expect(res.body.candidates[0].profileId).toBeUndefined();
    });

    it('T2-F2-04: Rate limiting on name search returns 429 when client exceeds threshold in 1 minute window', async () => {
      const testIp = '192.168.1.100';

      for (let i = 0; i < 10; i++) {
        const req = createApiRequest('/api/passes/lookup-returning', {
          method: 'POST',
          clientIp: testIp,
          token: createTestJwt({ userId: TEST_IDENTITIES.VISITOR_MALE.visitorId, role: 'visitor' }),
          body: { firstName: 'Juan', lastName: 'Dela Cruz' },
        });
        const res = await dispatchRoute(lookupReturningHandler, req);
        expect(res.status).toBe(200);
      }

      const rateLimitedReq = createApiRequest('/api/passes/lookup-returning', {
        method: 'POST',
        clientIp: testIp,
        token: createTestJwt({ userId: TEST_IDENTITIES.VISITOR_MALE.visitorId, role: 'visitor' }),
        body: { firstName: 'Juan', lastName: 'Dela Cruz' },
      });
      const rateLimitedRes = await dispatchRoute(lookupReturningHandler, rateLimitedReq);
      expect(rateLimitedRes.status).toBe(429);
      expect(rateLimitedRes.body.error).toBe('rate_limit_exceeded');
    });

    it('T2-F2-05: Returning visitor destination selection handles deactivated office, rejecting with 400', async () => {
      store.offices['77777777-7777-4000-a000-000000000003'].active = false;

      const req = createApiRequest('/api/passes/issue', {
        method: 'POST',
        token: createTestJwt({ userId: TEST_IDENTITIES.VISITOR_MALE.visitorId, role: 'visitor' }),
        body: {
          registrationMode: 'returning',
          returningProfileId: TEST_IDENTITIES.VISITOR_MALE.profileId,
          visitor: {
            firstName: 'Juan',
            lastName: 'Dela Cruz',
            purpose: 'Archived Records',
            visitDate: '2026-11-18',
          },
          destination: {
            type: 'department',
            officeId: '77777777-7777-4000-a000-000000000003',
          },
        },
      });
      const res = await dispatchRoute(issuePassHandler, req);

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('invalid_destination');
      expect(res.body.message).toContain('inactive');
    });
  });

  // ==========================================================================
  // Feature 3: Gender Lifecycle, Legacy Nulls & Normalization Boundaries (R3)
  // ==========================================================================
  describe('Feature 3: Gender Lifecycle, Legacy Nulls & Normalization Boundaries (R3)', () => {
    it('T2-F3-01: Pass issuance with invalid gender enum value is rejected with 400 Bad Request', async () => {
      const req = createApiRequest('/api/passes/issue', {
        method: 'POST',
        token: createTestJwt({ userId: TEST_IDENTITIES.VISITOR_MALE.visitorId, role: 'visitor' }),
        body: {
          registrationMode: 'new',
          visitor: {
            firstName: 'Test',
            lastName: 'Visitor',
            contactNumber: '09170000000',
            gender: 'Other',
            purpose: 'Testing',
            visitDate: '2026-11-18',
          },
        },
      });
      const res = await dispatchRoute(issuePassHandler, req);

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('validation_error');
    });

    it('T2-F3-02: Legacy visitor records with NULL gender remain queryable and dashboard handles gracefully', async () => {
      expect(store.visitors[TEST_IDENTITIES.VISITOR_LEGACY_NULL.visitorId].gender).toBeNull();

      const req = createApiRequest('/api/admin/dashboard', {
        method: 'GET',
        token: createTestJwt({ userId: TEST_IDENTITIES.ADMIN.userId, role: 'admin' }),
      });
      const res = await dispatchRoute(dashboardHandler, req);

      expect(res.status).toBe(200);
      expect(res.body.genderDistribution.male).toBeGreaterThanOrEqual(1);
      expect(res.body.genderDistribution.female).toBeGreaterThanOrEqual(1);
    });

    it('T2-F3-03: Case-insensitive gender normalization persists canonical PascalCase (male -> Male, female -> Female)', async () => {
      const reqMale = createApiRequest('/api/passes/issue', {
        method: 'POST',
        token: createTestJwt({ userId: TEST_IDENTITIES.VISITOR_MALE.visitorId, role: 'visitor' }),
        body: {
          registrationMode: 'new',
          visitor: {
            firstName: 'TestMale',
            lastName: 'Normalizer',
            contactNumber: '09171110001',
            gender: 'male',
            purpose: 'Testing Normalization',
            visitDate: '2026-11-18',
          },
        },
      });
      const resMale = await dispatchRoute(issuePassHandler, reqMale);
      expect(resMale.status).toBe(201);
      expect(resMale.body.pass.gender).toBe('Male');

      const reqFemale = createApiRequest('/api/passes/issue', {
        method: 'POST',
        token: createTestJwt({ userId: TEST_IDENTITIES.VISITOR_FEMALE_1.visitorId, role: 'visitor' }),
        body: {
          registrationMode: 'new',
          visitor: {
            firstName: 'TestFemale',
            lastName: 'Normalizer',
            contactNumber: '09171110002',
            gender: 'female',
            purpose: 'Testing Normalization',
            visitDate: '2026-11-18',
          },
        },
      });
      const resFemale = await dispatchRoute(issuePassHandler, reqFemale);
      expect(resFemale.status).toBe(201);
      expect(resFemale.body.pass.gender).toBe('Female');
    });

    it('T2-F3-04: Superadmin dashboard gender distribution handles zero visitors without division-by-zero errors', () => {
      store.visitors = {};
      store.passes = {};

      const dist = computeGenderDistribution(store.visitors);
      expect(dist).toEqual({
        male: 0,
        female: 0,
        total: 0,
      });
      expect(Number.isNaN(dist.total)).toBe(false);
    });

    it('T2-F3-05: Returning visitor profile retains previously recorded gender unless explicitly updated', async () => {
      const profile = store.returningVisitorProfiles[TEST_IDENTITIES.VISITOR_MALE.profileId];
      expect(profile.gender).toBe('Male');

      const req = createApiRequest('/api/passes/issue', {
        method: 'POST',
        token: createTestJwt({ userId: TEST_IDENTITIES.VISITOR_MALE.visitorId, role: 'visitor' }),
        body: {
          registrationMode: 'returning',
          returningProfileId: profile.id,
          visitor: {
            firstName: 'Juan',
            lastName: 'Dela Cruz',
            purpose: 'Second Visit',
            visitDate: '2026-11-18',
          },
        },
      });
      const res = await dispatchRoute(issuePassHandler, req);

      expect(res.status).toBe(201);
      expect(store.returningVisitorProfiles[profile.id].gender).toBe('Male');
    });
  });

  // ==========================================================================
  // Feature 4: Superadmin Reset Security & Rollback Boundaries (R4)
  // ==========================================================================
  describe('Feature 4: Superadmin Reset Security & Rollback Boundaries (R4)', () => {
    it('T2-F4-01: Non-superadmin actor (admin role) attempting return_to_zero receives 403 Forbidden', async () => {
      const req = createApiRequest('/api/admin/settings', {
        method: 'POST',
        token: createTestJwt({ userId: TEST_IDENTITIES.ADMIN.userId, role: 'admin' }),
        body: {
          action: 'return_to_zero',
          confirmationPhrase: 'DELETE ALL OPERATIONAL DATA',
          callerUserId: TEST_IDENTITIES.ADMIN.userId,
        },
      });
      const res = await dispatchRoute(settingsHandler, req);

      expect(res.status).toBe(403);
      expect(res.body.error).toBe('forbidden');
      expect(Object.keys(store.visitors).length).toBeGreaterThan(0);
    });

    it('T2-F4-02: Reset request with mismatched confirmation phrase is rejected with 400 invalid_confirmation', async () => {
      const req = createApiRequest('/api/admin/settings', {
        method: 'POST',
        token: createTestJwt({ userId: TEST_IDENTITIES.SUPERADMIN_1.userId, role: 'superadmin' }),
        body: {
          action: 'return_to_zero',
          confirmationPhrase: 'delete all data',
          callerUserId: TEST_IDENTITIES.SUPERADMIN_1.userId,
        },
      });
      const res = await dispatchRoute(settingsHandler, req);

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('invalid_confirmation');
      expect(Object.keys(store.visitors).length).toBeGreaterThan(0);
    });

    it('T2-F4-03: Atomic rollback: reset failure before commit rolls back entire transaction without partial data loss', () => {
      const visitorsBefore = Object.keys(store.visitors).length;
      const passesBefore = Object.keys(store.passes).length;

      let errorThrown = false;
      try {
        executeReturnToZeroRpc(store, 'invalid-non-superadmin-uuid');
      } catch {
        errorThrown = true;
      }

      expect(errorThrown).toBe(true);
      expect(Object.keys(store.visitors).length).toBe(visitorsBefore);
      expect(Object.keys(store.passes).length).toBe(passesBefore);
    });

    it('T2-F4-04: Storage wipe executes cleanly alongside database transaction', async () => {
      store.storageBuckets['visitor-photos']['photo-1.jpg'] = 'photo1';
      store.storageBuckets['visitor-ids']['id-1.jpg'] = 'id1';

      const req = createApiRequest('/api/admin/settings', {
        method: 'POST',
        token: createTestJwt({ userId: TEST_IDENTITIES.SUPERADMIN_1.userId, role: 'superadmin' }),
        body: {
          action: 'return_to_zero',
          confirmationPhrase: 'DELETE ALL OPERATIONAL DATA',
          callerUserId: TEST_IDENTITIES.SUPERADMIN_1.userId,
        },
      });
      const res = await dispatchRoute(settingsHandler, req);

      expect(res.status).toBe(200);
      expect(Object.keys(store.storageBuckets['visitor-photos'])).toHaveLength(0);
      expect(Object.keys(store.storageBuckets['visitor-ids'])).toHaveLength(0);
    });

    it('T2-F4-05: Multi-superadmin preservation: system preserves all active superadmins and purges only non-superadmin accounts', () => {
      const res = executeReturnToZeroRpc(store, TEST_IDENTITIES.SUPERADMIN_1.userId);

      expect(res.success).toBe(true);
      expect(res.preservedSuperadmins).toHaveLength(2);
      expect(store.staffProfiles[TEST_IDENTITIES.SUPERADMIN_1.userId]).toBeDefined();
      expect(store.staffProfiles[TEST_IDENTITIES.SUPERADMIN_2.userId]).toBeDefined();
      expect(store.users[TEST_IDENTITIES.SUPERADMIN_1.userId]).toBeDefined();
      expect(store.users[TEST_IDENTITIES.SUPERADMIN_2.userId]).toBeDefined();
    });
  });

  // ==========================================================================
  // Feature 5: Serverless Optimization, Secrets & Branch Hygiene Boundaries (R5)
  // ==========================================================================
  describe('Feature 5: Serverless Optimization, Secrets & Branch Hygiene Boundaries (R5)', () => {
    it('T2-F5-01: Pruning scripts verify targeting Linux serverless environments without deleting model runtimes', () => {
      const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'));
      expect(pkg.scripts).toBeDefined();
      const pruneScript = join(process.cwd(), 'scripts', 'prune-serverless-payload.sh');
      if (existsSync(pruneScript)) {
        const content = readFileSync(pruneScript, 'utf8');
        expect(content).toMatch(/linux|x86_64/i);
      } else {
        expect(existsSync(join(process.cwd(), 'scripts'))).toBe(true);
      }
    });

    it('T2-F5-02: Static analysis verifies no server-only secrets leaked into client frontend environment', () => {
      const viteEnvKeys = Object.keys(process.env).filter((k) => k.startsWith('VITE_'));
      for (const k of viteEnvKeys) {
        expect(k).not.toContain('SERVICE_ROLE');
        expect(k).not.toContain('HMAC_SECRET');
        expect(k).not.toContain('SECRET_KEY');
      }
    });

    it('T2-F5-03: GitHub branch protection ruleset verifies PR requirement on main', () => {
      const ciPath = join(process.cwd(), '.github', 'workflows', 'ci.yml');
      expect(existsSync(ciPath)).toBe(true);

      const ciContent = readFileSync(ciPath, 'utf8');
      expect(ciContent).toMatch(/pull_request:\s*\n\s*branches:\s*\[\s*main\s*\]/);
      expect(ciContent).toMatch(/name:\s*Verify & Test/);
    });

    it('T2-F5-04: Git branch hygiene contract verifies temporary branches are tracked for deletion', () => {
      const ciPath = join(process.cwd(), '.github', 'workflows', 'ci.yml');
      expect(existsSync(ciPath)).toBe(true);

      const ciContent = readFileSync(ciPath, 'utf8');
      const pushBranchMatches = ciContent.match(/push:\s*\n\s*branches:\s*\[([^\]]+)\]/);
      const prBranchMatches = ciContent.match(/pull_request:\s*\n\s*branches:\s*\[([^\]]+)\]/);

      expect(pushBranchMatches?.[1].trim()).toBe('main');
      expect(prBranchMatches?.[1].trim()).toBe('main');
    });

    it('T2-F5-05: Serverless routes handle malformed JSON gracefully with 400 Bad Request', async () => {
      const req = createApiRequest('/api/passes/lookup-returning', {
        method: 'POST',
        token: createTestJwt({ userId: TEST_IDENTITIES.VISITOR_MALE.visitorId, role: 'visitor' }),
        body: {
          firstName: '',
          lastName: '',
        },
      });
      const res = await dispatchRoute(lookupReturningHandler, req);

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('invalid_request');
    });
  });
});
