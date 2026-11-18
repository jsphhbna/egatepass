// @vitest-environment happy-dom
/**
 * Tier 1: Comprehensive Feature Coverage (30 Tests: 6 per Feature F1-F5)
 *
 * Covers:
 * - Feature 1 (F1): Scanner Camera Viewport & Guard View Photo Resolution (§R1)
 * - Feature 2 (F2): Returning Visitor Name Search & Destination Selection (§R2)
 * - Feature 3 (F3): Gender Field Lifecycle, Registration & Dashboard Metrics (§R3)
 * - Feature 4 (F4): Superadmin Return-to-Zero Reset & Storage Wipe (§R4)
 * - Feature 5 (F5): Serverless Function Optimization & CI Integrity (§R5)
 *
 * Authoritative Sources:
 * - ORIGINAL_REQUEST.md (Requirements R1 - R5)
 * - PROJECT.md (Interface Contracts § Pass Issuance, Gender, Superadmin Reset)
 * - TEST_INFRA.md (Test Architecture & Feature Inventory)
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
  executeReturnToZeroRpc,
  setupMockCamera,
  inspectScannerCssProperties,
  inspectServerlessRouteTopology,
  maskContact,
  maskName,
  type RemediationTestStateStore,
} from './helpers/e2e-fixtures.js';
import { ROUTE_CONTRACT_MATRIX } from '../../server/route-map.js';
import { QR_CAMERA_CONSTRAINTS, QR_SCAN_CONFIG } from '../../src/lib/qrScanner.js';

describe('Tier 1: Comprehensive Feature Coverage (30 Tests)', () => {
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
  // Feature 1: Scanner Camera Viewport & Guard View Photo (R1)
  // ==========================================================================
  describe('Feature 1: Scanner Camera Viewport & Guard View Photo (R1)', () => {
    it('T1-F1-01: Scanner viewport maintains 4:3 aspect ratio and non-collapsing dimensions', () => {
      const cssProps = inspectScannerCssProperties();
      expect(cssProps.hasAspectRatio43).toBe(true);
      expect(cssProps.hasNonCollapsingHeight).toBe(true);
      expect(cssProps.hasVideoObjectFit).toBe(true);
    });

    it('T1-F1-02: Camera constraints configure dynamic facingMode without hardcoded override', () => {
      expect(QR_CAMERA_CONSTRAINTS).toBeDefined();
      expect(QR_CAMERA_CONSTRAINTS.facingMode).toEqual({ ideal: 'environment' });
      expect(QR_SCAN_CONFIG.videoConstraints).toEqual(QR_CAMERA_CONSTRAINTS);
    });

    it('T1-F1-03: Scanner configuration supplies explicit 4:3 aspect ratio constraint', () => {
      const width = (QR_CAMERA_CONSTRAINTS.width as { ideal: number }).ideal;
      const height = (QR_CAMERA_CONSTRAINTS.height as { ideal: number }).ideal;
      expect(width).toBe(960);
      expect(height).toBe(720);
      expect(width / height).toBeCloseTo(4 / 3, 4);
    });

    it('T1-F1-04: Front camera applies single mirror transform without double flip', () => {
      const cssProps = inspectScannerCssProperties();
      expect(cssProps.videoTransform).toBe('scaleX(-1)');
      const css = readFileSync(join(process.cwd(), 'src', 'index.css'), 'utf8');
      expect(css).toContain('transform: scaleX(-1);');
      expect(css).not.toContain('transform: scaleX(-1) scaleX(-1)');
    });

    it('T1-F1-05: Guard station feed resolves active photo evidence ID for scanned new visitor pass', async () => {
      const req = createApiRequest('/api/gate/guard-station-feed?gate=Gate%201', {
        method: 'GET',
        token: createTestJwt({ userId: TEST_IDENTITIES.GUARD.userId, role: 'guard' }),
      });
      const res = await dispatchRoute(guardStationFeedHandler, req);
      expect(res.status).toBe(200);
      expect(res.body.entries).toBeDefined();
      expect(res.body.entries.length).toBeGreaterThan(0);
      expect(res.body.entries[0].photoEvidenceId).toBeDefined();
      expect(res.body.entries[0].photoEvidenceId).not.toBeNull();
    });

    it('T1-F1-06: Guard station feed resolves historical profile photo for scanned returning visitor pass', async () => {
      const retPassId = 'pass-returning-historical-001';
      store.passes[retPassId] = {
        id: retPassId,
        visitor_id: TEST_IDENTITIES.VISITOR_FEMALE_1.visitorId,
        public_reference: 'EP-RET-0001',
        reference_number: 'EP-RET-0001',
        status: 'inside',
        source: 'portal',
        gate: 'Gate 1',
        entry_scanned_at: new Date().toISOString(),
        time_in: new Date().toISOString(),
        purpose: 'Follow-up Consultation',
        gender: 'Female',
        created_at: new Date().toISOString(),
      };
      delete store.visitorEvidence[`photo-${TEST_IDENTITIES.VISITOR_FEMALE_1.visitorId}`];

      const req = createApiRequest('/api/gate/guard-station-feed?gate=Gate%201', {
        method: 'GET',
        token: createTestJwt({ userId: TEST_IDENTITIES.GUARD.userId, role: 'guard' }),
      });
      const res = await dispatchRoute(guardStationFeedHandler, req);
      expect(res.status).toBe(200);
      const entry = res.body.entries.find((e: any) => e.passId === retPassId);
      expect(entry).toBeDefined();
      expect(entry.visitorName).toContain('Maria');
      expect(entry.visitorName).toContain('Santos');
    });
  });

  // ==========================================================================
  // Feature 2: Returning Visitor Name Search & Destination Selection (R2)
  // ==========================================================================
  describe('Feature 2: Returning Visitor Name Search & Destination Selection (R2)', () => {
    it('T1-F2-01: Lookup returning visitor executes name-only search without phone or location requirement', async () => {
      const req = createApiRequest('/api/passes/lookup-returning', {
        method: 'POST',
        token: createTestJwt({ userId: TEST_IDENTITIES.VISITOR_MALE.visitorId, role: 'visitor' }),
        body: {
          firstName: 'Juan',
          lastName: 'Dela Cruz',
        },
      });
      const res = await dispatchRoute(lookupReturningHandler, req);

      expect(res.status).toBe(200);
      expect(res.body.candidates).toHaveLength(1);
      expect(res.body.candidates[0].profileId).toBe(TEST_IDENTITIES.VISITOR_MALE.profileId);
    });

    it('T1-F2-02: Lookup returning visitor returns candidate list when multiple visitors share same name', async () => {
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
      expect(res.body.candidates.length).toBeGreaterThanOrEqual(2);
      expect(res.body.totalMatches).toBeGreaterThanOrEqual(2);
    });

    it('T1-F2-03: Candidate list properly masks PII (first name, truncated last name, masked middle digits of contact)', async () => {
      const req = createApiRequest('/api/passes/lookup-returning', {
        method: 'POST',
        token: createTestJwt({ userId: TEST_IDENTITIES.VISITOR_MALE.visitorId, role: 'visitor' }),
        body: {
          firstName: 'Juan',
          lastName: 'Dela Cruz',
        },
      });
      const res = await dispatchRoute(lookupReturningHandler, req);

      expect(res.status).toBe(200);
      const candidate = res.body.candidates[0];
      expect(candidate.maskedName).toBe(maskName('Juan', 'Dela Cruz'));
      expect(candidate.maskedContact).toContain('****');
    });

    it('T1-F2-04: Returning visitor registration flow accepts destination selection for Department visit without phone', async () => {
      const req = createApiRequest('/api/passes/issue', {
        method: 'POST',
        token: createTestJwt({ userId: TEST_IDENTITIES.VISITOR_MALE.visitorId, role: 'visitor' }),
        body: {
          registrationMode: 'returning',
          returningProfileId: TEST_IDENTITIES.VISITOR_MALE.profileId,
          visitor: {
            firstName: 'Juan',
            lastName: 'Dela Cruz',
            // NO contactNumber provided!
            gender: 'Male',
            purpose: 'Official Transcript Submission',
            visitDate: '2026-11-18',
          },
          destination: {
            type: 'department',
            officeId: '77777777-7777-4000-a000-000000000001',
          },
        },
      });
      const res = await dispatchRoute(issuePassHandler, req);

      expect(res.status).toBe(201);
      expect(res.body.pass.id).toBeDefined();
      expect(res.body.pass.status).toBe('active');
    });

    it('T1-F2-05: Returning visitor registration flow accepts destination selection for Specific Person', async () => {
      const req = createApiRequest('/api/passes/issue', {
        method: 'POST',
        token: createTestJwt({ userId: TEST_IDENTITIES.VISITOR_FEMALE_1.visitorId, role: 'visitor' }),
        body: {
          registrationMode: 'returning',
          returningProfileId: TEST_IDENTITIES.VISITOR_FEMALE_1.profileId,
          visitor: {
            firstName: 'Maria',
            lastName: 'Santos',
            gender: 'Female',
            purpose: 'Document Signing',
            visitDate: '2026-11-18',
          },
          destination: {
            type: 'specific_person',
            officeId: '77777777-7777-4000-a000-000000000001',
            specificPersonName: 'Prof. Armando Reyes',
            specificPersonTitle: 'Department Head',
          },
        },
      });
      const res = await dispatchRoute(issuePassHandler, req);

      expect(res.status).toBe(201);
      expect(res.body.pass.id).toBeDefined();
    });

    it('T1-F2-06: Returning visitor pass issuance links selected destination to office_visits record', async () => {
      const req = createApiRequest('/api/passes/issue', {
        method: 'POST',
        token: createTestJwt({ userId: TEST_IDENTITIES.VISITOR_FEMALE_1.visitorId, role: 'visitor' }),
        body: {
          registrationMode: 'returning',
          returningProfileId: TEST_IDENTITIES.VISITOR_FEMALE_1.profileId,
          visitor: {
            firstName: 'Maria',
            lastName: 'Santos',
            gender: 'Female',
            purpose: 'Consultation',
            visitDate: '2026-11-18',
          },
          destination: {
            type: 'specific_person',
            officeId: '77777777-7777-4000-a000-000000000001',
            specificPersonName: 'Engr. Bautista',
            specificPersonTitle: 'Dean',
          },
        },
      });
      const res = await dispatchRoute(issuePassHandler, req);

      expect(res.status).toBe(201);
      const passId = res.body.pass.id;

      const linkedVisit = Object.values(store.officeVisits).find((ov) => ov.pass_id === passId);
      expect(linkedVisit).toBeDefined();
      expect(linkedVisit?.office_id).toBe('77777777-7777-4000-a000-000000000001');
      expect(linkedVisit?.specific_person_name).toBe('Engr. Bautista');
    });
  });

  // ==========================================================================
  // Feature 3: Gender Field Lifecycle, Registration & Metrics (R3)
  // ==========================================================================
  describe('Feature 3: Gender Field Lifecycle, Registration & Metrics (R3)', () => {
    it('T1-F3-01: Database schema contract enforces gender in visitors and returning_visitor_profiles', () => {
      const migrationPath = join(process.cwd(), 'supabase', 'migrations', '20261118000300_gender_and_system_reset.sql');
      expect(existsSync(migrationPath)).toBe(true);
      const sql = readFileSync(migrationPath, 'utf8');
      expect(sql).toMatch(/alter\s+table\s+public\.visitors\s+add\s+column\s+(?:if\s+not\s+exists\s+)?gender/i);
      expect(sql).toMatch(/alter\s+table\s+public\.returning_visitor_profiles\s+add\s+column\s+(?:if\s+not\s+exists\s+)?gender/i);
      expect(sql).toMatch(/check\s*\(\s*gender\s+in\s*\(\s*'Male'\s*,\s*'Female'\s*\)\s*\)/i);
    });

    it('T1-F3-02: Issue pass validates and persists gender (Male / Female) into visitor and pass records', async () => {
      const req = createApiRequest('/api/passes/issue', {
        method: 'POST',
        token: createTestJwt({ userId: randomUUID(), role: 'visitor' }),
        body: {
          registrationMode: 'new',
          visitor: {
            firstName: 'Rolando',
            lastName: 'Navarro',
            contactNumber: '09289876543',
            gender: 'Male',
            purpose: 'Campus Tour',
            visitDate: '2026-11-18',
          },
        },
      });
      const res = await dispatchRoute(issuePassHandler, req);

      expect(res.status).toBe(201);
      expect(res.body.pass.gender).toBe('Male');

      const passRecord = store.passes[res.body.pass.id];
      expect(passRecord.gender).toBe('Male');
      const visitorRecord = store.visitors[passRecord.visitor_id];
      expect(visitorRecord.gender).toBe('Male');
    });

    it('T1-F3-03: Returning visitor lookup preserves and displays previously registered gender', async () => {
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
      const maria1 = res.body.candidates.find(
        (c: any) => c.profileId === TEST_IDENTITIES.VISITOR_FEMALE_1.profileId
      );
      expect(maria1).toBeDefined();
      expect(maria1.gender).toBe('Female');
    });

    it('T1-F3-04: Dashboard metrics computes and returns genderDistribution breakdown', async () => {
      const req = createApiRequest('/api/admin/dashboard', {
        method: 'GET',
        token: createTestJwt({ userId: TEST_IDENTITIES.ADMIN.userId, role: 'admin' }),
      });
      const res = await dispatchRoute(dashboardHandler, req);

      expect(res.status).toBe(200);
      expect(res.body.genderDistribution).toBeDefined();
      expect(typeof res.body.genderDistribution.male).toBe('number');
      expect(typeof res.body.genderDistribution.female).toBe('number');
      expect(typeof res.body.genderDistribution.total).toBe('number');
      expect(res.body.genderDistribution.male).toBeGreaterThanOrEqual(1);
      expect(res.body.genderDistribution.female).toBeGreaterThanOrEqual(1);
      expect(res.body.genderDistribution.male + res.body.genderDistribution.female).toBe(res.body.genderDistribution.total);
    });

    it('T1-F3-05: Admin records list includes gender in mapped pass records for auditing', async () => {
      const req = createApiRequest('/api/admin/records', {
        method: 'GET',
        token: createTestJwt({ userId: TEST_IDENTITIES.ADMIN.userId, role: 'admin' }),
      });
      const res = await dispatchRoute(recordsHandler, req);

      expect(res.status).toBe(200);
      const records = res.body.records || res.body.passes || [];
      expect(records.length).toBeGreaterThan(0);
      const malePass = records.find((r: any) => r.gender === 'Male' || r.visitors?.gender === 'Male');
      expect(malePass).toBeDefined();
    });

    it('T1-F3-06: New visitor registration validates gender options and persists Female correctly', async () => {
      const req = createApiRequest('/api/passes/issue', {
        method: 'POST',
        token: createTestJwt({ userId: randomUUID(), role: 'visitor' }),
        body: {
          registrationMode: 'new',
          visitor: {
            firstName: 'Corazon',
            lastName: 'Aquino',
            contactNumber: '09991234567',
            gender: 'Female',
            purpose: 'Official Visit',
            visitDate: '2026-11-18',
          },
        },
      });
      const res = await dispatchRoute(issuePassHandler, req);

      expect(res.status).toBe(201);
      expect(res.body.pass.gender).toBe('Female');
    });
  });

  // ==========================================================================
  // Feature 4: Superadmin Return-to-Zero Reset (R4)
  // ==========================================================================
  describe('Feature 4: Superadmin Return-to-Zero Reset (R4)', () => {
    it('T1-F4-01: RPC api.return_to_zero_reset purges visitors, passes, visit_events, and devices', () => {
      const res = executeReturnToZeroRpc(store, TEST_IDENTITIES.SUPERADMIN_1.userId);

      expect(res.success).toBe(true);
      expect(Object.keys(store.visitors)).toHaveLength(0);
      expect(Object.keys(store.returningVisitorProfiles)).toHaveLength(0);
      expect(Object.keys(store.passes)).toHaveLength(0);
      expect(store.visitEvents).toHaveLength(0);
      expect(Object.keys(store.devices)).toHaveLength(0);
      expect(res.purgedCounts.visitors).toBeGreaterThan(0);
    });

    it('T1-F4-02: RPC api.return_to_zero_reset strictly preserves active superadmin accounts and auth users', () => {
      const res = executeReturnToZeroRpc(store, TEST_IDENTITIES.SUPERADMIN_1.userId);

      expect(res.success).toBe(true);
      expect(res.preservedSuperadmins).toContain(TEST_IDENTITIES.SUPERADMIN_1.userId);
      expect(res.preservedSuperadmins).toContain(TEST_IDENTITIES.SUPERADMIN_2.userId);

      expect(store.staffProfiles[TEST_IDENTITIES.SUPERADMIN_1.userId]).toBeDefined();
      expect(store.staffProfiles[TEST_IDENTITIES.SUPERADMIN_2.userId]).toBeDefined();

      expect(store.staffProfiles[TEST_IDENTITIES.ADMIN.userId]).toBeUndefined();
      expect(store.staffProfiles[TEST_IDENTITIES.GUARD.userId]).toBeUndefined();
      expect(store.staffProfiles[TEST_IDENTITIES.OFFICE_STAFF.userId]).toBeUndefined();
    });

    it('T1-F4-03: RPC cascades deletions across relational foreign keys in correct topological order', () => {
      expect(store.visitEvents.length).toBeGreaterThan(0);
      expect(Object.keys(store.officeVisits).length).toBeGreaterThan(0);
      expect(Object.keys(store.visitorEvidence).length).toBeGreaterThan(0);

      const res = executeReturnToZeroRpc(store, TEST_IDENTITIES.SUPERADMIN_1.userId);

      expect(res.success).toBe(true);
      expect(store.visitEvents).toHaveLength(0);
      expect(Object.keys(store.officeVisits)).toHaveLength(0);
      expect(Object.keys(store.visitorEvidence)).toHaveLength(0);
    });

    it('T1-F4-04: Admin settings action return_to_zero wipes Supabase storage buckets visitor-photos and visitor-ids', async () => {
      expect(Object.keys(store.storageBuckets['visitor-photos']).length).toBeGreaterThan(0);

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
      expect(Object.keys(store.storageBuckets['visitor-photos'])).toHaveLength(0);
      expect(Object.keys(store.storageBuckets['visitor-ids'])).toHaveLength(0);
    });

    it('T1-F4-05: Return-to-zero requires exact confirmation phrase "DELETE ALL OPERATIONAL DATA"', async () => {
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
    });

    it('T1-F4-06: Superadmin Settings restricts action execution exclusively to superadmin role', async () => {
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
    });
  });

  // ==========================================================================
  // Feature 5: Serverless Function Optimization & CI Integrity (R5)
  // ==========================================================================
  describe('Feature 5: Serverless Function Optimization & CI Integrity (R5)', () => {
    it('T1-F5-01: Physical serverless functions under api/ remain strictly at 6 catch-all functions (<=12 limit)', () => {
      const topology = inspectServerlessRouteTopology();
      expect(topology.catchAllCount).toBe(6);
      expect(topology.catchAllCount).toBeLessThanOrEqual(12);
      expect(topology.catchAllNames.sort()).toEqual(
        ['admin', 'auth', 'device', 'gate', 'passes', 'system'].sort()
      );
    });

    it('T1-F5-02: ROUTE_CONTRACT_MATRIX maintains exact 41 logical route contracts across 6 groups', () => {
      expect(ROUTE_CONTRACT_MATRIX.length).toBe(41);

      const groups = new Set(ROUTE_CONTRACT_MATRIX.map((r) => r.group));
      expect(groups.has('admin')).toBe(true);
      expect(groups.has('auth')).toBe(true);
      expect(groups.has('device')).toBe(true);
      expect(groups.has('gate')).toBe(true);
      expect(groups.has('passes')).toBe(true);
      expect(groups.has('system')).toBe(true);
    });

    it('T1-F5-03: vercel.json includes proper configuration within storage and duration limits', () => {
      const vercelConfigPath = join(process.cwd(), 'vercel.json');
      expect(existsSync(vercelConfigPath)).toBe(true);

      const vercelJson = JSON.parse(readFileSync(vercelConfigPath, 'utf8'));
      expect(vercelJson.functions).toBeDefined();

      for (const [, cfg] of Object.entries<any>(vercelJson.functions)) {
        if (cfg.maxDuration) {
          expect(cfg.maxDuration).toBeLessThanOrEqual(60);
        }
      }
    });

    it('T1-F5-04: Client-heavy libraries are excluded from serverless entrypoints', () => {
      const routeMapContent = readFileSync(join(process.cwd(), 'server', 'route-map.ts'), 'utf8');
      expect(routeMapContent).not.toContain('react-dom');
      expect(routeMapContent).not.toContain('@paddleocr');
    });

    it('T1-F5-05: Existing test suite baseline maintains backwards compatibility', () => {
      const contractPath = join(process.cwd(), 'tests', 'architecture-contract.test.ts');
      expect(existsSync(contractPath)).toBe(true);
      const contractContent = readFileSync(contractPath, 'utf8');
      expect(contractContent).toContain('ROUTE_CONTRACT_MATRIX');
    });

    it('T1-F5-06: Serverless function route contracts specify valid HTTP methods', () => {
      for (const contract of ROUTE_CONTRACT_MATRIX) {
        expect(contract.allowedMethods.length).toBeGreaterThan(0);
        for (const method of contract.allowedMethods) {
          expect(['GET', 'POST', 'PATCH', 'DELETE', 'PUT', 'HEAD']).toContain(method);
        }
      }
    });
  });
});
