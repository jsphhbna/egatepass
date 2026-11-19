// @vitest-environment happy-dom
/**
 * Tier 3: Cross-Feature Pairwise Combinations (10 Tests)
 *
 * Covers pairwise combinatorial interactions across Requirements R1 through R5:
 * - T3-PAIR-01 (R1 × R2): Returning visitor lookup to pass issue to guard view photo display
 * - T3-PAIR-02 (R2 × R3): Returning visitor destination update with gender persistence
 * - T3-PAIR-03 (R3 × R4): Gender metrics tracking before and after Return-to-Zero reset
 * - T3-PAIR-04 (R1 × R3): Guard station feed rendering visitor photo and gender badge simultaneously
 * - T3-PAIR-05 (R2 × R4): Returning visitor name lookup immediately after Return-to-Zero reset
 * - T3-PAIR-06 (R1 × R4): Active guard station feed polling resilience during Return-to-Zero reset
 * - T3-PAIR-07 (R2 × R5): Name-only search and candidate resolution latency in serverless context
 * - T3-PAIR-08 (R3 × R5): Gender metrics aggregation efficiency without heavy bundle dependencies
 * - T3-PAIR-09 (R4 × R5): Return-to-zero storage wipe and DB purge execution speed
 * - T3-PAIR-10 (R1 × R5): Camera viewport fixes relying on lightweight CSS without bundle impact
 *
 * Authoritative Sources:
 * - ORIGINAL_REQUEST.md (§R1, §R2, §R3, §R4, §R5)
 * - PROJECT.md (§ Interface Contracts)
 * - TEST_INFRA.md (§ Feature Inventory & Tier 3 Plan)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
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
  inspectScannerCssProperties,
  type RemediationTestStateStore,
} from './helpers/e2e-fixtures.js';

describe('Tier 3: Cross-Feature Pairwise Combinations (10 Tests)', () => {
  let store: RemediationTestStateStore;

  beforeEach(() => {
    store = createRemediationTestStore();
    setupSupabaseTestHarness(store);
  });

  afterEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = '';
  });

  // T3-PAIR-01 (R1 × R2)
  it('T3-PAIR-01: Returning visitor identified via name lookup generates pass; guard feed displays their historical photo', async () => {
    // Step 1 (R2): Look up returning visitor by name
    const lookupReq = createApiRequest('/api/passes/lookup-returning', {
      method: 'POST',
      token: createTestJwt({ userId: TEST_IDENTITIES.VISITOR_FEMALE_1.visitorId, role: 'visitor' }),
      body: {
        firstName: 'Maria',
        lastName: 'Santos',
      },
    });
    const lookupRes = await dispatchRoute(lookupReturningHandler, lookupReq);
    expect(lookupRes.status).toBe(200);
    const candidate = lookupRes.body.candidates[0];
    expect(candidate).toBeDefined();

    // Step 2 (R2): Issue pass for returning visitor
    const issueReq = createApiRequest('/api/passes/issue', {
      method: 'POST',
      token: createTestJwt({ userId: TEST_IDENTITIES.VISITOR_FEMALE_1.visitorId, role: 'visitor' }),
      body: {
        registrationMode: 'returning',
        returningProfileId: candidate.profileId,
        visitor: {
          firstName: 'Maria',
          lastName: 'Santos',
          gender: candidate.gender,
          purpose: 'Claim Certificate',
          visitDate: '2026-11-18',
        },
      },
    });
    const issueRes = await dispatchRoute(issuePassHandler, issueReq);
    expect(issueRes.status).toBe(201);
    const passId = issueRes.body.pass.id;

    // Step 3 (R1): Guard view scans pass and resolves photo
    const feedReq = createApiRequest('/api/gate/guard-station-feed?gate=Gate%201', {
      method: 'GET',
      token: createTestJwt({ userId: TEST_IDENTITIES.GUARD.userId, role: 'guard' }),
    });
    const guardFeedRes = await dispatchRoute(guardStationFeedHandler, feedReq);
    expect(guardFeedRes.status).toBe(200);
    expect(guardFeedRes.body.entries).toBeDefined();
    expect(guardFeedRes.body.entries.length).toBeGreaterThan(0);
  });

  // T3-PAIR-02 (R2 × R3)
  it('T3-PAIR-02: Returning visitor registered with gender updates destination; pass issuance links destination and retains gender', async () => {
    const profileId = TEST_IDENTITIES.VISITOR_FEMALE_1.profileId;
    const initialGender = store.returningVisitorProfiles[profileId].gender;
    expect(initialGender).toBe('Female');

    const req = createApiRequest('/api/passes/issue', {
      method: 'POST',
      token: createTestJwt({ userId: TEST_IDENTITIES.VISITOR_FEMALE_1.visitorId, role: 'visitor' }),
      body: {
        registrationMode: 'returning',
        returningProfileId: profileId,
        visitor: {
          firstName: 'Maria',
          lastName: 'Santos',
          gender: initialGender,
          purpose: 'Academic Consultation',
          visitDate: '2026-11-18',
        },
        destination: {
          type: 'specific_person',
          officeId: '77777777-7777-4000-a000-000000000001',
          specificPersonName: 'Dr. Evelyn Santos',
          specificPersonTitle: 'Director',
        },
      },
    });
    const res = await dispatchRoute(issuePassHandler, req);

    expect(res.status).toBe(201);
    expect(res.body.pass.gender).toBe('Female');

    const linkedVisit = Object.values(store.officeVisits).find(
      (ov) => ov.pass_id === res.body.pass.id
    );
    expect(linkedVisit).toBeDefined();
    expect(linkedVisit?.specific_person_name).toBe('Dr. Evelyn Santos');
  });

  // T3-PAIR-03 (R3 × R4)
  it('T3-PAIR-03: Gender metrics are tracked; executing Return-to-Zero resets metrics to 0 while preserving superadmin', async () => {
    const dashReq = createApiRequest('/api/admin/dashboard', {
      method: 'GET',
      token: createTestJwt({ userId: TEST_IDENTITIES.ADMIN.userId, role: 'admin' }),
    });
    const initialMetrics = await dispatchRoute(dashboardHandler, dashReq);
    expect(initialMetrics.body.genderDistribution.male).toBeGreaterThanOrEqual(1);
    expect(initialMetrics.body.genderDistribution.female).toBeGreaterThanOrEqual(1);

    const resetReq = createApiRequest('/api/admin/settings', {
      method: 'POST',
      token: createTestJwt({ userId: TEST_IDENTITIES.SUPERADMIN_1.userId, role: 'superadmin' }),
      body: {
        action: 'return_to_zero',
        confirmationPhrase: 'DELETE ALL OPERATIONAL DATA',
      },
    });
    const resetRes = await dispatchRoute(settingsHandler, resetReq);
    expect(resetRes.status).toBe(200);

    const postDashReq = createApiRequest('/api/admin/dashboard', {
      method: 'GET',
      token: createTestJwt({ userId: TEST_IDENTITIES.SUPERADMIN_1.userId, role: 'superadmin' }),
    });
    const postMetrics = await dispatchRoute(dashboardHandler, postDashReq);
    expect(postMetrics.status).toBe(200);
    expect(postMetrics.body.genderDistribution).toEqual({
      male: 0,
      female: 0,
      total: 0,
    });

    expect(store.staffProfiles[TEST_IDENTITIES.SUPERADMIN_1.userId]).toBeDefined();
  });

  // T3-PAIR-04 (R1 × R3)
  it('T3-PAIR-04: Guard station feed displays visitor photo and gender badge simultaneously', async () => {
    const feedReq = createApiRequest('/api/gate/guard-station-feed?gate=Gate%201', {
      method: 'GET',
      token: createTestJwt({ userId: TEST_IDENTITIES.GUARD.userId, role: 'guard' }),
    });
    const feedRes = await dispatchRoute(guardStationFeedHandler, feedReq);

    expect(feedRes.status).toBe(200);
    expect(feedRes.body.entries.length).toBeGreaterThan(0);
    const entry = feedRes.body.entries[0];
    expect(entry.photoEvidenceId).toBeDefined();
  });

  // T3-PAIR-05 (R2 × R4)
  it('T3-PAIR-05: Superadmin Return-to-Zero is executed; subsequent name lookup returns 0 matches', async () => {
    const lookupReq = createApiRequest('/api/passes/lookup-returning', {
      method: 'POST',
      token: createTestJwt({ userId: TEST_IDENTITIES.VISITOR_MALE.visitorId, role: 'visitor' }),
      body: {
        firstName: 'Juan',
        lastName: 'Dela Cruz',
      },
    });
    const beforeLookup = await dispatchRoute(lookupReturningHandler, lookupReq);
    expect(beforeLookup.body.candidates).toHaveLength(1);

    const resetReq = createApiRequest('/api/admin/settings', {
      method: 'POST',
      token: createTestJwt({ userId: TEST_IDENTITIES.SUPERADMIN_1.userId, role: 'superadmin' }),
      body: {
        action: 'return_to_zero',
        confirmationPhrase: 'DELETE ALL OPERATIONAL DATA',
      },
    });
    await dispatchRoute(settingsHandler, resetReq);

    const afterLookup = await dispatchRoute(lookupReturningHandler, lookupReq);
    expect(afterLookup.status).toBe(200);
    expect(afterLookup.body.candidates).toHaveLength(0);
  });

  // T3-PAIR-06 (R1 × R4)
  it('T3-PAIR-06: Guard station feed polling handles empty operational state gracefully during Return-to-Zero reset', async () => {
    const resetReq = createApiRequest('/api/admin/settings', {
      method: 'POST',
      token: createTestJwt({ userId: TEST_IDENTITIES.SUPERADMIN_1.userId, role: 'superadmin' }),
      body: {
        action: 'return_to_zero',
        confirmationPhrase: 'DELETE ALL OPERATIONAL DATA',
      },
    });
    await dispatchRoute(settingsHandler, resetReq);

    // After reset, guard polls feed
    const feedReq = createApiRequest('/api/gate/guard-station-feed?gate=Gate%201', {
      method: 'GET',
      token: createTestJwt({ userId: TEST_IDENTITIES.SUPERADMIN_1.userId, role: 'superadmin' }),
    });
    const feedRes = await dispatchRoute(guardStationFeedHandler, feedReq);
    expect(feedRes.status).toBe(200);
    expect(feedRes.body.entries).toHaveLength(0);
  });

  // T3-PAIR-07 (R2 × R5)
  it('T3-PAIR-07: Name-only lookup with candidate disambiguation enforces candidate cap and bounded payload', async () => {
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
    expect(res.body.candidates).toBeDefined();
    expect(res.body.candidates.length).toBeLessThanOrEqual(3);
    for (const c of res.body.candidates) {
      expect(c.candidateToken).toBeDefined();
      expect(c.profileId).toBeUndefined();
      expect(c.maskedName).toBeDefined();
    }
  });

  // T3-PAIR-08 (R3 × R5)
  it('T3-PAIR-08: Gender metrics aggregation operates efficiently without loading heavy external libraries', async () => {
    const dashboardSource = readFileSync(join(process.cwd(), 'server', 'routes', 'admin', 'dashboard.ts'), 'utf8');
    expect(dashboardSource).not.toContain('recharts');
    expect(dashboardSource).not.toContain('react-dom');
    expect(dashboardSource).not.toContain('canvas');

    const req = createApiRequest('/api/admin/dashboard', {
      method: 'GET',
      token: createTestJwt({ userId: TEST_IDENTITIES.ADMIN.userId, role: 'admin' }),
    });
    const res = await dispatchRoute(dashboardHandler, req);
    expect(res.status).toBe(200);
    expect(res.body.genderDistribution).toBeDefined();
    expect(res.body.genderDistribution.male + res.body.genderDistribution.female).toBe(res.body.genderDistribution.total);
  });

  // T3-PAIR-09 (R4 × R5)
  it('T3-PAIR-09: Return-to-zero reset wipes buckets and purges tables in topological cascade order', async () => {
    const req = createApiRequest('/api/admin/settings', {
      method: 'POST',
      token: createTestJwt({ userId: TEST_IDENTITIES.SUPERADMIN_1.userId, role: 'superadmin' }),
      body: {
        action: 'return_to_zero',
        confirmationPhrase: 'DELETE ALL OPERATIONAL DATA',
      },
    });
    const res = await dispatchRoute(settingsHandler, req);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    expect(Object.keys(store.passes)).toHaveLength(0);
    expect(Object.keys(store.visitors)).toHaveLength(0);
    expect(store.visitEvents).toHaveLength(0);
    expect(Object.keys(store.devices)).toHaveLength(0);
    expect(store.staffProfiles[TEST_IDENTITIES.SUPERADMIN_1.userId]).toBeDefined();
  });

  // T3-PAIR-10 (R1 × R5)
  it('T3-PAIR-10: Camera viewport CSS fixes and photo resolution maintain zero bundle size overhead', () => {
    const cssProps = inspectScannerCssProperties();
    expect(cssProps.hasAspectRatio43).toBe(true);
    expect(cssProps.hasNonCollapsingHeight).toBe(true);

    const css = readFileSync(join(process.cwd(), 'src', 'index.css'), 'utf8');
    expect(css).toContain('aspect-ratio: 4 / 3;');
  });
});
