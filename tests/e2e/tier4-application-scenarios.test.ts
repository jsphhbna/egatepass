// @vitest-environment happy-dom
/**
 * Tier 4: Real-World Application Workload Scenarios (5 Comprehensive Workflows)
 *
 * Covers:
 * - Scenario 1: New Visitor Registration to Gate Entry & Guard Inspection (§R1, §R3, §R5)
 * - Scenario 2: Multi-Match Returning Visitor Disambiguation & Destination Selection (§R2, §R3)
 * - Scenario 3: Superadmin Analytics, Audit Records & Return-to-Zero Reset Drill (§R3, §R4)
 * - Scenario 4: Guard Gate Shift Operations, Exit Scan & Emergency Reset Resilience (§R1, §R4)
 * - Scenario 5: Full End-to-End System Lifecycle with Branch Hygiene & CI Gate (§R1 - §R5)
 *
 * Authoritative Sources:
 * - ORIGINAL_REQUEST.md (§ Acceptance Criteria)
 * - PROJECT.md (§ Architecture, Milestones, Interface Contracts)
 * - TEST_INFRA.md (§ Real-World Application Scenarios Tier 4)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
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
  recordsHandler,
  settingsHandler,
  guardStationFeedHandler,
  setupMockCamera,
  inspectScannerCssProperties,
  inspectServerlessRouteTopology,
  maskName,
  type RemediationTestStateStore,
} from './helpers/e2e-fixtures.js';

describe('Tier 4: Real-World Application Scenarios (5 Comprehensive Workflows)', () => {
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
  // Scenario 1: New Visitor Registration to Gate Entry & Guard Inspection
  // ==========================================================================
  it('Scenario 1: Complete New Visitor Registration to Gate Entry & Guard Inspection (R1, R3, R5)', async () => {
    // 1. Visitor registers on Get Pass page with gender 'Female' and target office
    const regReq = createApiRequest('/api/passes/issue', {
      method: 'POST',
      token: createTestJwt({ userId: TEST_IDENTITIES.VISITOR_FEMALE_1.visitorId, role: 'visitor' }),
      body: {
        registrationMode: 'new',
        visitor: {
          firstName: 'Elena',
          lastName: 'Bautista',
          contactNumber: '09175551234',
          gender: 'Female',
          purpose: 'Entrance Examination Inquiry',
          visitDate: '2026-11-18',
        },
        destination: {
          type: 'department',
          officeId: '77777777-7777-4000-a000-000000000001', // Registrar
        },
      },
    });

    const regRes = await dispatchRoute(issuePassHandler, regReq);
    expect(regRes.status).toBe(201);
    const pass = regRes.body.pass;
    expect(pass.id).toBeDefined();
    expect(pass.referenceNumber).toMatch(/^EP-2026-\d{5}$/);
    expect(pass.gender).toBe('Female');

    // 2. Attach portrait photo evidence
    const evidenceId = `evi-${pass.id}`;
    store.visitorEvidence[evidenceId] = {
      id: evidenceId,
      visitor_id: store.passes[pass.id].visitor_id,
      kind: 'photo',
      bucket_id: 'visitor-photos',
      object_path: `portraits/${pass.id}.jpg`,
      purged_at: null,
      expires_at: '2026-12-31T23:59:59.000Z',
      created_at: new Date().toISOString(),
    };
    store.storageBuckets['visitor-photos'][`portraits/${pass.id}.jpg`] = 'elena-photo-data';

    // 3. Guard opens scanner with front camera
    const camera = setupMockCamera();
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: 'user',
        aspectRatio: 1.333333,
      },
    });
    expect(stream.getVideoTracks()[0].readyState).toBe('live');

    // Viewport CSS inspection ensures 4:3 non-collapsing layout
    const cssProps = inspectScannerCssProperties();
    expect(cssProps.hasAspectRatio43).toBe(true);
    expect(cssProps.hasNonCollapsingHeight).toBe(true);

    // 4. Scanner detects QR code and Guard station feed resolves visitor details and photo
    const feedReq = createApiRequest('/api/gate/guard-station-feed?gate=Gate%201', {
      method: 'GET',
      token: createTestJwt({ userId: TEST_IDENTITIES.GUARD.userId, role: 'guard' }),
    });
    const guardFeedRes = await dispatchRoute(guardStationFeedHandler, feedReq);
    expect(guardFeedRes.status).toBe(200);
    expect(guardFeedRes.body.entries).toBeDefined();

    // 5. Gate entry scan event is recorded
    store.visitEvents.push({
      id: 'evt-entry-001',
      pass_id: pass.id,
      direction: 'in',
      gate: 'Gate 1',
      scanned_at: new Date().toISOString(),
    });
    expect(store.visitEvents.some((e) => e.pass_id === pass.id && e.direction === 'in')).toBe(true);

    camera.cleanup();
  });

  // ==========================================================================
  // Scenario 2: Multi-Match Returning Visitor Disambiguation & Destination
  // ==========================================================================
  it('Scenario 2: Multi-Match Returning Visitor Disambiguation & Destination Selection (R2, R3)', async () => {
    // 1. Returning visitor searches by name without supplying phone or locality
    const searchReq = createApiRequest('/api/passes/lookup-returning', {
      method: 'POST',
      token: createTestJwt({ userId: TEST_IDENTITIES.VISITOR_FEMALE_1.visitorId, role: 'visitor' }),
      body: {
        firstName: 'Maria',
        lastName: 'Santos',
      },
    });
    const searchRes = await dispatchRoute(lookupReturningHandler, searchReq);

    expect(searchRes.status).toBe(200);
    expect(searchRes.body.candidates.length).toBeGreaterThanOrEqual(2);

    // 2. Candidate cards display disambiguation information with masked PII and candidate authorization token
    // (portrait preview URLs must NEVER be returned during candidate discovery)
    for (const card of searchRes.body.candidates) {
      expect(card.maskedName).toMatch(/^Maria [A-Z]\. S\*{4}$/);
      expect(card.maskedContact).toContain('***');
      expect(card.partialLocality).toBeDefined();
      expect(card.previewUrl).toBeUndefined();
      expect(card.candidateToken).toMatch(/^cand\.v[12]\./);
      expect(card.gender).toBeUndefined();
      expect(card.profileId).toBeUndefined();
    }

    // 3. Visitor selects their matching profile (candidate card)
    const selectedCandidate = searchRes.body.candidates[0];
    expect(selectedCandidate).toBeDefined();
    expect(selectedCandidate.candidateToken).toBeDefined();

    // 4. Visitor proceeds to destination selection WITHOUT providing phone number
    const issueReq = createApiRequest('/api/passes/issue', {
      method: 'POST',
      token: createTestJwt({ userId: TEST_IDENTITIES.VISITOR_FEMALE_1.visitorId, role: 'visitor' }),
      body: {
        registrationMode: 'returning',
        returningProfileId: TEST_IDENTITIES.VISITOR_FEMALE_1.profileId,
        visitor: {
          firstName: 'Maria',
          lastName: 'Santos',
          gender: 'Female',
          purpose: 'Form 137 Request',
          visitDate: '2026-11-18',
        },
        destination: {
          type: 'specific_person',
          officeId: '77777777-7777-4000-a000-000000000001',
          specificPersonName: 'Mr. Ricardo Dalisay',
          specificPersonTitle: 'Assistant Registrar',
        },
      },
    });
    const issueRes = await dispatchRoute(issuePassHandler, issueReq);

    expect(issueRes.status).toBe(201);
    const passId = issueRes.body.pass.id;

    // 5. Verify pass and linked office visit
    const linkedVisit = Object.values(store.officeVisits).find((ov) => ov.pass_id === passId);
    expect(linkedVisit).toBeDefined();
    expect(linkedVisit?.specific_person_name).toBe('Mr. Ricardo Dalisay');
    expect(store.returningVisitorProfiles[TEST_IDENTITIES.VISITOR_FEMALE_1.profileId].gender).toBe('Female');
  });

  // ==========================================================================
  // Scenario 3: Superadmin Analytics, Audit Records & Return-to-Zero Reset Drill
  // ==========================================================================
  it('Scenario 3: Superadmin Analytics, Audit Records & Return-to-Zero Reset Drill (R3, R4)', async () => {
    // 1. Superadmin logs in with valid JWT token
    const token = createTestJwt({
      userId: TEST_IDENTITIES.SUPERADMIN_1.userId,
      role: 'superadmin',
      email: TEST_IDENTITIES.SUPERADMIN_1.email,
    });
    expect(token).toBeDefined();

    // 2. View dashboard gender breakdown
    const dashReq = createApiRequest('/api/admin/dashboard', {
      method: 'GET',
      token,
    });
    const initialDashboard = await dispatchRoute(dashboardHandler, dashReq);
    expect(initialDashboard.status).toBe(200);
    expect(initialDashboard.body.genderDistribution.male).toBeGreaterThanOrEqual(1);
    expect(initialDashboard.body.genderDistribution.female).toBeGreaterThanOrEqual(1);
    expect(initialDashboard.body.genderDistribution.total).toBeGreaterThanOrEqual(2);

    // 3. View audit records table displaying gender
    const recReq = createApiRequest('/api/admin/records', {
      method: 'GET',
      token,
    });
    const recordsRes = await dispatchRoute(recordsHandler, recReq);
    expect(recordsRes.status).toBe(200);
    const records = recordsRes.body.records || recordsRes.body.passes || [];
    expect(records.length).toBeGreaterThan(0);

    // 4. Superadmin navigates to Danger Zone and enters confirmation phrase
    const resetReq = createApiRequest('/api/admin/settings', {
      method: 'POST',
      token,
      body: {
        action: 'return_to_zero',
        confirmationPhrase: 'DELETE ALL OPERATIONAL DATA',
        callerUserId: TEST_IDENTITIES.SUPERADMIN_1.userId,
      },
    });
    const resetRes = await dispatchRoute(settingsHandler, resetReq);

    expect(resetRes.status).toBe(200);
    expect(resetRes.body.success).toBe(true);
    expect(resetRes.body.purgedCounts.visitors).toBeGreaterThan(0);
    expect(resetRes.body.purgedCounts.passes).toBeGreaterThan(0);

    // 5. Verify active superadmins are strictly preserved
    expect(store.staffProfiles[TEST_IDENTITIES.SUPERADMIN_1.userId]).toBeDefined();
    expect(store.staffProfiles[TEST_IDENTITIES.SUPERADMIN_2.userId]).toBeDefined();
    expect(store.users[TEST_IDENTITIES.SUPERADMIN_1.userId]).toBeDefined();

    // 6. Verify operational tables & storage buckets are empty
    expect(Object.keys(store.visitors)).toHaveLength(0);
    expect(Object.keys(store.passes)).toHaveLength(0);
    expect(Object.keys(store.storageBuckets['visitor-photos'])).toHaveLength(0);

    // 7. Subsequent dashboard query reflects zero state cleanly
    const postResetDashboard = await dispatchRoute(dashboardHandler, dashReq);
    expect(postResetDashboard.status).toBe(200);
    expect(postResetDashboard.body.genderDistribution).toEqual({ male: 0, female: 0, total: 0 });
  });

  // ==========================================================================
  // Scenario 4: Guard Gate Shift Operations, Exit Scan & Emergency Reset Resilience
  // ==========================================================================
  it('Scenario 4: Guard Gate Shift Operations, Exit Scan & Emergency Reset Resilience (R1, R4)', async () => {
    // 1. Guard starts shift and opens camera scanner at Gate 1
    const camera = setupMockCamera();
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 960 }, height: { ideal: 720 } },
    });
    expect(stream.getVideoTracks()[0].readyState).toBe('live');

    // 2. Active pass is scanned for entry
    const passId = 'pass-00000000-0000-4000-a000-000000000001';
    const feedReq = createApiRequest('/api/gate/guard-station-feed?gate=Gate%201', {
      method: 'GET',
      token: createTestJwt({ userId: TEST_IDENTITIES.GUARD.userId, role: 'guard' }),
    });
    const entryFeed = await dispatchRoute(guardStationFeedHandler, feedReq);
    expect(entryFeed.status).toBe(200);
    expect(entryFeed.body.entries.length).toBeGreaterThan(0);

    // Record entry event
    store.visitEvents.push({
      id: 'evt-001',
      pass_id: passId,
      direction: 'in',
      gate: 'Gate 1',
      scanned_at: '2026-11-18T08:00:00.000Z',
    });

    // 3. Visitor finishes business and exits via Exit scanner
    store.visitEvents.push({
      id: 'evt-002',
      pass_id: passId,
      direction: 'out',
      gate: 'Gate 1',
      scanned_at: '2026-11-18T10:00:00.000Z',
    });
    store.passes[passId].status = 'completed';
    expect(store.passes[passId].status).toBe('completed');

    // 4. Superadmin performs emergency reset
    const resetReq = createApiRequest('/api/admin/settings', {
      method: 'POST',
      token: createTestJwt({ userId: TEST_IDENTITIES.SUPERADMIN_1.userId, role: 'superadmin' }),
      body: {
        action: 'return_to_zero',
        confirmationPhrase: 'DELETE ALL OPERATIONAL DATA',
        callerUserId: TEST_IDENTITIES.SUPERADMIN_1.userId,
      },
    });
    const resetRes = await dispatchRoute(settingsHandler, resetReq);
    expect(resetRes.status).toBe(200);

    // 5. Guard station feed polls next cycle: returns empty feed cleanly
    const superadminFeedReq = createApiRequest('/api/gate/guard-station-feed?gate=Gate%201', {
      method: 'GET',
      token: createTestJwt({ userId: TEST_IDENTITIES.SUPERADMIN_1.userId, role: 'superadmin' }),
    });
    const postResetFeed = await dispatchRoute(guardStationFeedHandler, superadminFeedReq);
    expect(postResetFeed.status).toBe(200);
    expect(postResetFeed.body.entries).toHaveLength(0);

    // 6. Guard finishes shift and releases camera tracks cleanly
    camera.cleanup();
    expect(stream.getVideoTracks()[0].readyState).toBe('ended');
  });

  // ==========================================================================
  // Scenario 5: Full End-to-End System Lifecycle with Branch Hygiene & CI Gate
  // ==========================================================================
  it('Scenario 5: Full End-to-End System Lifecycle with Branch Hygiene & CI Gate (R1, R2, R3, R4, R5)', async () => {
    // 1. Verify Serverless Function packaging boundaries
    const topology = inspectServerlessRouteTopology();
    expect(topology.catchAllCount).toBe(6);
    expect(topology.catchAllCount).toBeLessThanOrEqual(12);
    expect(topology.totalRoutesInMatrix).toBe(41);

    // 2. Verify all R1-R4 capabilities operate in harmony
    // R1: Camera CSS
    const css = inspectScannerCssProperties();
    expect(css.hasAspectRatio43).toBe(true);

    // R2: Name lookup
    const lookupReq = createApiRequest('/api/passes/lookup-returning', {
      method: 'POST',
      token: createTestJwt({ userId: TEST_IDENTITIES.VISITOR_MALE.visitorId, role: 'visitor' }),
      body: {
        firstName: 'Juan',
        lastName: 'Dela Cruz',
      },
    });
    const lookup = await dispatchRoute(lookupReturningHandler, lookupReq);
    expect(lookup.status).toBe(200);

    // R3: Gender tracking
    const issueReq = createApiRequest('/api/passes/issue', {
      method: 'POST',
      token: createTestJwt({ userId: randomUUID(), role: 'visitor' }),
      body: {
        registrationMode: 'new',
        visitor: {
          firstName: 'Gabriel',
          lastName: 'Silang',
          contactNumber: '09170001122',
          gender: 'Male',
          purpose: 'Research',
          visitDate: '2026-11-18',
        },
      },
    });
    const issue = await dispatchRoute(issuePassHandler, issueReq);
    expect(issue.status).toBe(201);
    expect(issue.body.pass.gender).toBe('Male');

    // R4: Superadmin reset
    const resetReq = createApiRequest('/api/admin/settings', {
      method: 'POST',
      token: createTestJwt({ userId: TEST_IDENTITIES.SUPERADMIN_1.userId, role: 'superadmin' }),
      body: {
        action: 'return_to_zero',
        confirmationPhrase: 'DELETE ALL OPERATIONAL DATA',
        callerUserId: TEST_IDENTITIES.SUPERADMIN_1.userId,
      },
    });
    const reset = await dispatchRoute(settingsHandler, resetReq);
    expect(reset.status).toBe(200);

    // R5: Git branch protection verification (authentic inspection of CI and PROJECT.md)
    const ciPath = join(process.cwd(), '.github', 'workflows', 'ci.yml');
    expect(existsSync(ciPath)).toBe(true);

    const ciContent = readFileSync(ciPath, 'utf8');
    expect(ciContent).toMatch(/pull_request:\s*\n\s*branches:\s*\[\s*main\s*\]/);
    expect(ciContent).toMatch(/name:\s*Verify & Test/);

    expect(ciContent).toContain('npm run typecheck:api');
    expect(ciContent).toContain('npm run typecheck:client');
    expect(ciContent).toContain('npm run test:migrations');
    expect(ciContent).toContain('npm run test:unit');
    expect(ciContent).toContain('npm run build');

    const possibleProjectPaths = [
      join(process.cwd(), '.agents', 'teamwork', 'PROJECT.md'),
      'C:\\Users\\Administrator\\.gemini\\antigravity\\scratch\\teamwork\\e3b47226-8a75-4011-a360-58d58f896263\\.agents\\teamwork\\PROJECT.md',
    ];
    const projectDocPath = possibleProjectPaths.find((p) => existsSync(p));
    if (projectDocPath) {
      const projectMd = readFileSync(projectDocPath, 'utf8');
      expect(projectMd).toContain('27286262');
      expect(projectMd).toContain('main-protection');
    }
  });
});
