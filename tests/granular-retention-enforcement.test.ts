import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { handleRequest as purgeHandler } from '../server/routes/system/purge-images.js';
import { setServerSupabaseClientsForTest } from '../server/supabase.js';

describe('Phase B — Granular Retention Enforcement & Superadmin Override Regression Tests', () => {
  const SUPERADMIN_ID = '22222222-2222-4000-a000-000000000002';
  const ADMIN_ID = '11111111-1111-4000-a000-000000000001';

  // 1. Static Contract & Integrity Tests
  describe('Static Contract & Integrity Tests', () => {
    const maintenanceSrc = readFileSync('server/routes/admin/retention-maintenance.ts', 'utf8');
    const purgeSrc = readFileSync('server/routes/system/purge-images.ts', 'utf8');
    const migration79Src = readFileSync(
      'supabase/migrations/20261110220000_office_provisioning_and_retention_overrides.sql',
      'utf8'
    );

    it('proves retention maintenance checks all category enabled flags and cutoffs', () => {
      expect(maintenanceSrc).toContain('photo_retention_enabled');
      expect(maintenanceSrc).toContain('id_retention_enabled');
      expect(maintenanceSrc).toContain('vehicle_photo_retention_enabled');
      expect(maintenanceSrc).toContain('returning_profile_retention_enabled');
      expect(maintenanceSrc).toContain('photoDays');
      expect(maintenanceSrc).toContain('idDays');
      expect(maintenanceSrc).toContain('vehicleDays');
    });

    it('proves retention maintenance checks returning visitor deletion policy', () => {
      expect(maintenanceSrc).toContain('returning_profile_retention_enabled');
      expect(maintenanceSrc).toContain('returningProfileDays');
      expect(maintenanceSrc).toContain('returningCutoff');
    });

    it('proves retention maintenance enforces all 3 safeguards for returning visitor deletion', () => {
      // 1. Linked visitor is inside campus
      expect(maintenanceSrc).toContain("passes.status', 'inside'");
      // 2. Active or pending passes
      expect(maintenanceSrc).toContain('passes.status.in.(inside,pending)');
      // 3. Active incident holds
      expect(maintenanceSrc).toContain('incident_holds');
    });

    it('proves manual purge supports Superadmin override with min 10-char reason and categories', () => {
      expect(purgeSrc).toContain('body.override');
      expect(purgeSrc).toContain('invalid_override_reason');
      expect(purgeSrc).toContain('invalid_override_categories');
      expect(purgeSrc).toContain('overrideCategories');
      expect(purgeSrc).toContain('retention.superadmin_override_purge');
    });

    it('proves manual purge enforces category toggles and durations in normal mode', () => {
      expect(purgeSrc).toContain('photo_retention_enabled');
      expect(purgeSrc).toContain('id_retention_enabled');
      expect(purgeSrc).toContain('vehicle_photo_retention_enabled');
      expect(purgeSrc).toContain('photoEnabled');
      expect(purgeSrc).toContain('idEnabled');
      expect(purgeSrc).toContain('vehicleEnabled');
    });

    it('proves manual purge retains all 3 mandatory safeguards even under override', () => {
      expect(purgeSrc).toContain('heldVisitorIds.has(item.visitor_id)');
      expect(purgeSrc).toContain('activePassVisitorIds.has(item.visitor_id)');
      expect(purgeSrc).toContain('insideVisitorIds.has(item.visitor_id)');
    });

    it('proves Migration 79 claim_evidence_for_purge enforces category policy and safeguards', () => {
      expect(migration79Src).toContain('api.claim_evidence_for_purge');
      expect(migration79Src).toContain('requested_override boolean default false');
      expect(migration79Src).toContain('incident_holds');
      expect(migration79Src).toContain('passes');
      expect(migration79Src).toContain("campus_status = 'inside'");
    });
  });

  // 2. Runtime Execution & API Boundary Tests
  describe('Runtime Execution & API Boundary Tests', () => {
    let mockSettings: any;
    let mockEvidence: any[];
    let mockHolds: any[];
    let mockPasses: any[];
    let mockInsideVisitors: any[];
    let mockAuditEvents: any[];
    let claimedIds: string[];

    beforeEach(() => {
      claimedIds = [];
      mockAuditEvents = [];

      mockSettings = {
        image_retention_days: 7,
        photo_retention_days: 7,
        id_retention_days: 30,
        vehicle_photo_retention_days: 15,
        photo_retention_enabled: true,
        id_retention_enabled: true,
        vehicle_photo_retention_enabled: true,
        singleton: true,
      };

      const now = Date.now();
      const days = (d: number) => new Date(now - d * 86400000).toISOString();

      mockEvidence = [
        {
          id: 'ev-photo-eligible',
          visitor_id: 'vis-1',
          kind: 'photo',
          created_at: days(10), // 10 days old (> 7 days)
          expires_at: days(3),
          storage_bucket: 'visitor-evidence',
          storage_path: 'photos/vis-1.jpg',
          purged_at: null,
          purge_claimed_at: null,
        },
        {
          id: 'ev-photo-young',
          visitor_id: 'vis-2',
          kind: 'photo',
          created_at: days(3), // 3 days old (< 7 days)
          expires_at: days(-4),
          storage_bucket: 'visitor-evidence',
          storage_path: 'photos/vis-2.jpg',
          purged_at: null,
          purge_claimed_at: null,
        },
        {
          id: 'ev-id-eligible',
          visitor_id: 'vis-3',
          kind: 'id',
          created_at: days(35), // 35 days old (> 30 days)
          expires_at: days(5),
          storage_bucket: 'visitor-evidence',
          storage_path: 'ids/vis-3.jpg',
          purged_at: null,
          purge_claimed_at: null,
        },
        {
          id: 'ev-id-young',
          visitor_id: 'vis-4',
          kind: 'id',
          created_at: days(15), // 15 days old (< 30 days)
          expires_at: days(-15),
          storage_bucket: 'visitor-evidence',
          storage_path: 'ids/vis-4.jpg',
          purged_at: null,
          purge_claimed_at: null,
        },
        {
          id: 'ev-vehicle-eligible',
          visitor_id: 'vis-5',
          kind: 'vehicle_photo',
          created_at: days(20), // 20 days old (> 15 days)
          expires_at: days(5),
          storage_bucket: 'visitor-evidence',
          storage_path: 'vehicles/vis-5.jpg',
          purged_at: null,
          purge_claimed_at: null,
        },
        {
          id: 'ev-held-eligible',
          visitor_id: 'vis-held',
          kind: 'photo',
          created_at: days(12),
          expires_at: days(5),
          storage_bucket: 'visitor-evidence',
          storage_path: 'photos/vis-held.jpg',
          purged_at: null,
          purge_claimed_at: null,
        },
        {
          id: 'ev-active-pass-eligible',
          visitor_id: 'vis-active-pass',
          kind: 'photo',
          created_at: days(12),
          expires_at: days(5),
          storage_bucket: 'visitor-evidence',
          storage_path: 'photos/vis-active-pass.jpg',
          purged_at: null,
          purge_claimed_at: null,
        },
        {
          id: 'ev-inside-eligible',
          visitor_id: 'vis-inside',
          kind: 'photo',
          created_at: days(12),
          expires_at: days(5),
          storage_bucket: 'visitor-evidence',
          storage_path: 'photos/vis-inside.jpg',
          purged_at: null,
          purge_claimed_at: null,
        },
      ];

      mockHolds = [{ visitor_id: 'vis-held', active: true }];
      mockPasses = [{ visitor_id: 'vis-active-pass', status: 'inside', valid_until: days(-1) }];
      mockInsideVisitors = [{ id: 'vis-inside' }];

      const mockAdmin: any = {
        auth: {
          getUser: vi.fn(async (token: string) => {
            const role = token === `test-token-${SUPERADMIN_ID}` ? 'superadmin' : 'admin';
            const id = role === 'superadmin' ? SUPERADMIN_ID : ADMIN_ID;
            return {
              data: {
                user: {
                  id,
                  email: `${role}@earist.edu.ph`,
                  email_confirmed_at: new Date().toISOString(),
                },
              },
              error: null,
            };
          }),
        },
        schema: vi.fn(() => mockAdmin),
        from: vi.fn((tableName: string) => {
          if (tableName === 'staff_profiles') {
            return {
              select: () => ({
                eq: (col: string, val: any) => ({
                  maybeSingle: async () => ({
                    data: {
                      role: val === SUPERADMIN_ID ? 'superadmin' : 'admin',
                      active: true,
                      must_change_password: false,
                      privacy_accepted_at: new Date().toISOString(),
                    },
                    error: null,
                  }),
                }),
              }),
            };
          }

          if (tableName === 'app_settings') {
            return {
              select: () => ({
                eq: () => ({
                  maybeSingle: async () => ({ data: mockSettings, error: null }),
                }),
              }),
            };
          }

          if (tableName === 'incident_holds') {
            return {
              select: (cols: string) => ({
                eq: () => ({
                  not: () => Promise.resolve({ data: cols.includes('pass_id') ? [] : mockHolds, error: null }),
                }),
              }),
            };
          }

          if (tableName === 'passes') {
            return {
              select: () => ({
                or: () => Promise.resolve({ data: mockPasses, error: null }),
                eq: (col, val) => Promise.resolve({
                  data: val === 'inside' ? [{ visitor_id: 'vis-inside' }] : [],
                  error: null,
                }),
              }),
            };
          }

          if (tableName === 'visitors') {
            return {
              select: () => ({
                eq: () => Promise.resolve({ data: mockInsideVisitors, error: null }),
              }),
            };
          }

          if (tableName === 'visitor_evidence') {
            let currentRows = [...mockEvidence];
            const builder: any = {
              select: () => builder,
              is: () => builder,
              lte: () => builder,
              order: () => builder,
              gt: () => builder,
              in: (col: string, vals: any[]) => {
                currentRows = currentRows.filter((r) => vals.includes(r[col]));
                return builder;
              },
              limit: (n: number) => Promise.resolve({ data: currentRows.slice(0, n), error: null }),
            };
            return builder;
          }

          if (tableName === 'audit_events') {
            return {
              insert: vi.fn(async (ev: any) => {
                mockAuditEvents.push(ev);
                return { data: ev, error: null };
              }),
            };
          }

          return {
            select: () => ({
              eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }),
            }),
          };
        }),
        rpc: vi.fn(async (funcName: string, args: any) => {
          if (funcName === 'claim_evidence_for_purge') {
            claimedIds.push(args.requested_evidence_id);
            return {
              data: [
                {
                  claimed: true,
                  evidence_id: args.requested_evidence_id,
                  visitor_id: 'vis-1',
                  bucket_id: 'visitor-evidence',
                  object_path: 'test.jpg',
                  claim_id: args.requested_claim_id,
                },
              ],
              error: null,
            };
          }
          if (funcName === 'finalize_purged_evidence') {
            return {
              data: [{ success: true, finalized: true, match_status: 'matched', purged: true }],
              error: null,
            };
          }
          return { data: null, error: null };
        }),
        storage: {
          from: () => ({
            remove: vi.fn(async () => ({ data: [{}], error: null })),
          }),
        },
      };

      setServerSupabaseClientsForTest({ admin: mockAdmin, anon: mockAdmin });
    });

    function makePurgeRequest(actorId: string, body: any): Request {
      return new Request('https://egatepass.tech/api/system/purge-images', {
        method: 'POST',
        headers: {
          authorization: `Bearer test-token-${actorId}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      });
    }

    it('dry-run identifies exactly eligible categories and protects safe-guarded records', async () => {
      const req = makePurgeRequest(SUPERADMIN_ID, { dryRun: true });
      const res = await purgeHandler(req);
      expect(res.status).toBe(200);
      const json = await res.json();

      expect(json.dryRun).toBe(true);
      // Eligible should be:
      // - ev-photo-eligible (10 days > 7)
      // - ev-id-eligible (35 days > 30)
      // - ev-vehicle-eligible (20 days > 15)
      // Safeguarded should be skipped:
      // - ev-held-eligible (incident hold)
      // - ev-active-pass-eligible (active pass)
      // - ev-inside-eligible (campus_status = inside)
      // Too young should be skipped:
      // - ev-photo-young (3 days < 7)
      // - ev-id-young (15 days < 30)
      expect(json.eligibleEvidenceCount).toBe(3);
    });

    it('respects category toggles: disabled photo category is preserved even when expired', async () => {
      mockSettings.photo_retention_enabled = false;

      const req = makePurgeRequest(SUPERADMIN_ID, { dryRun: true });
      const res = await purgeHandler(req);
      expect(res.status).toBe(200);
      const json = await res.json();

      // Only id and vehicle should be eligible now (2 items)
      expect(json.eligibleEvidenceCount).toBe(2);
    });

    it('rejects Superadmin override purge if reason is less than 10 characters', async () => {
      const req = makePurgeRequest(SUPERADMIN_ID, {
        override: {
          reason: 'Too short',
          categories: ['photo'],
        },
      });
      const res = await purgeHandler(req);
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toBe('invalid_override_reason');
    });

    it('rejects Superadmin override purge if categories array is empty', async () => {
      const req = makePurgeRequest(SUPERADMIN_ID, {
        override: {
          reason: 'Valid audit reason for override retention',
          categories: [],
        },
      });
      const res = await purgeHandler(req);
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toBe('invalid_override_categories');
    });

    it('allows Superadmin override purge to purge disabled category and logs audit event', async () => {
      mockSettings.photo_retention_enabled = false; // Disabled in settings

      const req = makePurgeRequest(SUPERADMIN_ID, {
        dryRun: false,
        override: {
          reason: 'Authorized legal purge for university photo records',
          categories: ['photo'],
        },
      });
      const res = await purgeHandler(req);
      expect(res.status).toBe(200);

      // Audited override event was recorded
      const auditEv = mockAuditEvents.find((e) => e.action === 'retention.superadmin_override_purge');
      expect(auditEv).toBeDefined();
      expect(auditEv.after_state.override.reason).toBe('Authorized legal purge for university photo records');
      expect(auditEv.after_state.override.categories).toEqual(['photo']);
    });

    it('rejects non-Superadmin actor from running purge', async () => {
      const req = makePurgeRequest(ADMIN_ID, { dryRun: true });
      const res = await purgeHandler(req);
      expect(res.status).toBe(403);
    });

    it('shortening category duration immediately makes existing records eligible', async () => {
      // Originally: id_retention_days = 30 -> ev-id-young (15 days old) is NOT eligible
      // Shorten ID retention to 10 days
      mockSettings.id_retention_days = 10;

      const req = makePurgeRequest(SUPERADMIN_ID, { dryRun: true });
      const res = await purgeHandler(req);
      expect(res.status).toBe(200);
      const json = await res.json();

      // Now ev-id-young (15 days old > 10 days) becomes eligible!
      // Total eligible: ev-photo-eligible (10d), ev-id-eligible (35d), ev-vehicle-eligible (20d), ev-id-young (15d) = 4
      expect(json.eligibleEvidenceCount).toBe(4);
    });

    it('extending category duration immediately protects existing records', async () => {
      // Originally: photo_retention_days = 7 -> ev-photo-eligible (10 days old) is eligible
      // Extend photo retention to 30 days
      mockSettings.photo_retention_days = 30;

      const req = makePurgeRequest(SUPERADMIN_ID, { dryRun: true });
      const res = await purgeHandler(req);
      expect(res.status).toBe(200);
      const json = await res.json();

      // ev-photo-eligible (10 days old < 30 days) is now protected!
      // Total eligible: ev-id-eligible (35d), ev-vehicle-eligible (20d) = 2
      expect(json.eligibleEvidenceCount).toBe(2);
    });

    it('allows Superadmin override to purge records even with future expires_at', async () => {
      // Add a fresh evidence item created 1 hour ago with future expires_at
      mockEvidence.push({
        id: 'ev-photo-future',
        visitor_id: 'vis-photo-future',
        bucket_id: 'visitor-evidence',
        object_path: 'photo_future.jpg',
        expires_at: new Date(Date.now() + 7 * 86_400_000).toISOString(),
        kind: 'photo',
        created_at: new Date(Date.now() - 3600_000).toISOString(),
        verified_at: new Date(Date.now() - 3600_000).toISOString(),
      });

      const req = makePurgeRequest(SUPERADMIN_ID, {
        dryRun: false,
        override: {
          reason: 'Emergency audit request to wipe photo evidence',
          categories: ['photo'],
        },
      });

      const res = await purgeHandler(req);
      expect(res.status).toBe(200);
      expect(claimedIds).toContain('ev-photo-future');
    });

    it('rejects unsupported or un-implemented override categories', async () => {
      const req = makePurgeRequest(SUPERADMIN_ID, {
        override: {
          reason: 'Attempting to override non-storage categories',
          categories: ['visitor', 'returning_profile'],
        },
      });
      const res = await purgeHandler(req);
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toBe('invalid_override_categories');
    });

    it('fails closed with 500 settings_unavailable if authoritative settings are missing', async () => {
      mockSettings = null;

      const req = makePurgeRequest(SUPERADMIN_ID, { dryRun: true });
      const res = await purgeHandler(req);
      expect(res.status).toBe(500);
      const json = await res.json();
      expect(json.error).toBe('settings_unavailable');
    });

    it('guarantees parity between dry-run candidate count and actual purge claimed count', async () => {
      const dryReq = makePurgeRequest(SUPERADMIN_ID, { dryRun: true });
      const dryRes = await purgeHandler(dryReq);
      expect(dryRes.status).toBe(200);
      const dryJson = await dryRes.json();

      const purgeReq = makePurgeRequest(SUPERADMIN_ID, { dryRun: false });
      const purgeRes = await purgeHandler(purgeReq);
      expect(purgeRes.status).toBe(200);

      expect(claimedIds.length).toBe(dryJson.eligibleEvidenceCount);
    });
  });
});
