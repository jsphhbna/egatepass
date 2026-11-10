import { describe, it, expect, beforeEach, vi } from 'vitest';
import { handleRequest as purgeHandler } from '../server/routes/system/purge-images.js';
import { setServerSupabaseClientsForTest } from '../server/supabase.js';
import { encodeCursor } from '../server/cursor.js';

describe('Retention Purge Pagination & Boundary Invariants', () => {
  const SUPERADMIN_ID = '22222222-2222-4000-a000-000000000002';
  const ADMIN_ID = '11111111-1111-4000-a000-000000000001';

  let mockSettings: any;
  let mockEvidence: any[];
  let mockHolds: any[];
  let mockPasses: any[];
  let mockInsidePasses: any[];
  let mockAuditEvents: any[];
  let mockReconciliation: any[];
  let storageRemovedPaths: string[];
  let simulatedStorageFailures: Set<string>;
  let simulatedClaimFailures: Set<string>;

  function makePurgeRequest(actorId: string, body: any) {
    return new Request('https://egatepass.tech/api/system/purge-images', {
      method: 'POST',
      headers: {
        authorization: `Bearer test-token-${actorId}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  }

  beforeEach(() => {
    mockAuditEvents = [];
    mockReconciliation = [];
    storageRemovedPaths = [];
    simulatedStorageFailures = new Set();
    simulatedClaimFailures = new Set();

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

    mockHolds = [];
    mockPasses = [];
    mockInsidePasses = [];
    mockEvidence = [];

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
              eq: (_col: string, val: any) => ({
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
              eq: (_col: string, val: any) => Promise.resolve({
                data: val === 'inside' ? mockInsidePasses : [],
                error: null,
              }),
            }),
          };
        }

        if (tableName === 'visitor_evidence') {
          const builder: any = {
            _filters: [] as Array<(item: any) => boolean>,
            _limit: 200,
            select: () => builder,
            is: (col: string, val: any) => {
              builder._filters.push((item: any) => item[col] === val);
              return builder;
            },
            in: (col: string, vals: any[]) => {
              builder._filters.push((item: any) => vals.includes(item[col]));
              return builder;
            },
            or: (expr: string) => {
              if (expr.includes('expires_at.gt.') && expr.includes('id.gt.')) {
                const matchGt = expr.match(/expires_at\.gt\.([^,]+)/);
                const matchEq = expr.match(/expires_at\.eq\.([^,]+)/);
                const matchId = expr.match(/id\.gt\.([^)]+)/);
                const tsGt = matchGt ? matchGt[1] : '';
                const tsEq = matchEq ? matchEq[1] : '';
                const idGt = matchId ? matchId[1] : '';
                if (tsGt && idGt) {
                  builder._filters.push((item: any) => {
                    const itemExp = item.expires_at;
                    if (!itemExp) return false;
                    if (itemExp > tsGt) return true;
                    if (itemExp === tsEq && item.id > idGt) return true;
                    return false;
                  });
                }
              }
              return builder;
            },
            order: () => builder,
            limit: (n: number) => {
              builder._limit = n;
              return builder;
            },
            then: (resolve: any) => {
              let rows = mockEvidence.filter((r) => builder._filters.every((f: any) => f(r)));
              rows.sort((a, b) => {
                if (a.expires_at < b.expires_at) return -1;
                if (a.expires_at > b.expires_at) return 1;
                return a.id.localeCompare(b.id);
              });
              const sliced = rows.slice(0, builder._limit);
              resolve({ data: sliced, error: null });
            },
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

        if (tableName === 'reconciliation_tasks') {
          return {
            insert: vi.fn(async (task: any) => {
              mockReconciliation.push(task);
              return { data: task, error: null };
            }),
          };
        }

        return {
          select: () => ({ eq: () => Promise.resolve({ data: [], error: null }) }),
        };
      }),
      storage: {
        from: (bucket: string) => ({
          remove: vi.fn(async (paths: string[]) => {
            for (const p of paths) {
              if (simulatedStorageFailures.has(p)) {
                return { data: null, error: new Error(`Simulated storage failure on ${p}`) };
              }
              storageRemovedPaths.push(p);
            }
            return { data: paths, error: null };
          }),
        }),
      },
      rpc: vi.fn(async (fnName: string, args: any) => {
        if (fnName === 'claim_evidence_for_purge') {
          const item = mockEvidence.find((e) => e.id === args.requested_evidence_id);
          if (!item) return { data: null, error: new Error('Record not found') };
          if (simulatedClaimFailures.has(item.id)) {
            return { data: null, error: new Error(`Simulated claim failure for ${item.id}`) };
          }
          if (item.purged_at !== null || item.purge_claim_id) {
            return { data: { claimed: false, reason: 'already_purged_or_claimed' }, error: null };
          }
          item.purge_claim_id = args.requested_claim_id;
          item.purge_claimed_at = new Date().toISOString();
          return {
            data: {
              claimed: true,
              evidence_id: item.id,
              visitor_id: item.visitor_id,
              bucket_id: item.bucket_id,
              object_path: item.object_path,
              claim_id: args.requested_claim_id,
            },
            error: null,
          };
        }

        if (fnName === 'finalize_evidence_purge') {
          const item = mockEvidence.find((e) => e.id === args.requested_evidence_id);
          if (!item) return { data: null, error: new Error('Record not found') };
          if (item.purge_claim_id !== args.requested_claim_id) {
            return { data: { finalized: false, match_status: 'claim_mismatch' }, error: null };
          }
          if (args.requested_success) {
            item.purged_at = new Date().toISOString();
            item.purge_claim_id = null;
            return {
              data: {
                success: true,
                finalized: true,
                match_status: 'matched',
                purged: true,
                purged_at: item.purged_at,
              },
              error: null,
            };
          } else {
            item.purge_claim_id = null;
            item.purge_claimed_at = null;
            return {
              data: {
                success: true,
                finalized: true,
                match_status: 'claim_released',
                claim_released: true,
              },
              error: null,
            };
          }
        }

        return { data: null, error: null };
      }),
    };

    setServerSupabaseClientsForTest({
      admin: mockAdmin,
      serviceRole: mockAdmin,
      anon: mockAdmin,
    });
  });

  // Helper to generate deterministic UUIDs
  function makeUuid(n: number): string {
    const hex = n.toString(16).padStart(12, '0');
    return `00000000-0000-4000-8000-${hex}`;
  }

  // 1. More than 1,000 candidates with distinct expiry dates
  it('1. scans > 1,000 candidates with distinct expiry dates across multiple pages', async () => {
    const baseTime = Date.now() - 30 * 86_400_000;
    for (let i = 1; i <= 1200; i++) {
      const exp = new Date(baseTime + i * 1000).toISOString();
      mockEvidence.push({
        id: makeUuid(i),
        visitor_id: `vis-${i}`,
        kind: 'photo',
        bucket_id: 'visitor-evidence',
        object_path: `photos/vis-${i}.jpg`,
        created_at: exp,
        expires_at: exp,
        purged_at: null,
      });
    }

    // First batch: processes 50 records
    const res1 = await purgeHandler(makePurgeRequest(SUPERADMIN_ID, { dryRun: false }));
    expect(res1.status).toBe(200);
    const json1 = await res1.json();
    expect(json1.successCount).toBe(50);
    expect(json1.hasMore).toBe(true);
    expect(json1.nextCursor).toBeDefined();

    // Verify first 50 were purged
    expect(mockEvidence.filter((e) => e.purged_at !== null).length).toBe(50);
  });

  // 2. More than 1,000 candidates with many identical expiry timestamps
  it('2. correctly keyset paginates > 1,000 candidates with identical expiry timestamps', async () => {
    const identicalExp = new Date(Date.now() - 20 * 86_400_000).toISOString();
    for (let i = 1; i <= 1100; i++) {
      mockEvidence.push({
        id: makeUuid(i),
        visitor_id: `vis-${i}`,
        kind: 'photo',
        bucket_id: 'visitor-evidence',
        object_path: `photos/vis-${i}.jpg`,
        created_at: identicalExp,
        expires_at: identicalExp,
        purged_at: null,
      });
    }

    // Call batch 1
    const res1 = await purgeHandler(makePurgeRequest(SUPERADMIN_ID, { dryRun: false }));
    const json1 = await res1.json();
    expect(json1.successCount).toBe(50);
    expect(json1.hasMore).toBe(true);
    expect(json1.nextCursor).toBeDefined();

    // Call batch 2 with cursor
    const res2 = await purgeHandler(makePurgeRequest(SUPERADMIN_ID, {
      dryRun: false,
      cursor: json1.nextCursor,
      snapshotAt: json1.snapshotAt,
    }));
    const json2 = await res2.json();
    expect(json2.successCount).toBe(50);
    expect(json2.hasMore).toBe(true);

    // Total 100 distinct items purged
    expect(mockEvidence.filter((e) => e.purged_at !== null).length).toBe(100);
  });

  // 3. Protected/held records appearing before eligible records
  it('3. skips protected incident-held records appearing before eligible records without starvation', async () => {
    const exp = new Date(Date.now() - 20 * 86_400_000).toISOString();
    // 300 held records
    for (let i = 1; i <= 300; i++) {
      const vId = `vis-held-${i}`;
      mockHolds.push({ visitor_id: vId, active: true });
      mockEvidence.push({
        id: makeUuid(i),
        visitor_id: vId,
        kind: 'photo',
        bucket_id: 'visitor-evidence',
        object_path: `photos/${vId}.jpg`,
        created_at: exp,
        expires_at: exp,
        purged_at: null,
      });
    }

    // 50 eligible records
    for (let i = 301; i <= 350; i++) {
      const vId = `vis-eligible-${i}`;
      mockEvidence.push({
        id: makeUuid(i),
        visitor_id: vId,
        kind: 'photo',
        bucket_id: 'visitor-evidence',
        object_path: `photos/${vId}.jpg`,
        created_at: exp,
        expires_at: exp,
        purged_at: null,
      });
    }

    const res = await purgeHandler(makePurgeRequest(SUPERADMIN_ID, { dryRun: false }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.successCount).toBe(50);
    expect(json.scannedCount).toBe(350);

    // Verify all 50 eligible were purged, while 300 held records remained unpurged
    const purged = mockEvidence.filter((e) => e.purged_at !== null);
    expect(purged.length).toBe(50);
    expect(purged.every((e) => e.visitor_id.startsWith('vis-eligible'))).toBe(true);
  });

  // 4. Active-pass and campus-inside records appearing before eligible records
  it('4. preserves active-pass and campus-inside records appearing before eligible records', async () => {
    const exp = new Date(Date.now() - 20 * 86_400_000).toISOString();
    // 150 inside visitors
    for (let i = 1; i <= 150; i++) {
      const vId = `vis-inside-${i}`;
      mockInsidePasses.push({ visitor_id: vId });
      mockEvidence.push({
        id: makeUuid(i),
        visitor_id: vId,
        kind: 'photo',
        bucket_id: 'visitor-evidence',
        object_path: `photos/${vId}.jpg`,
        created_at: exp,
        expires_at: exp,
        purged_at: null,
      });
    }

    // 50 eligible
    for (let i = 151; i <= 200; i++) {
      const vId = `vis-eligible-${i}`;
      mockEvidence.push({
        id: makeUuid(i),
        visitor_id: vId,
        kind: 'photo',
        bucket_id: 'visitor-evidence',
        object_path: `photos/${vId}.jpg`,
        created_at: exp,
        expires_at: exp,
        purged_at: null,
      });
    }

    const res = await purgeHandler(makePurgeRequest(SUPERADMIN_ID, { dryRun: false }));
    const json = await res.json();
    expect(json.successCount).toBe(50);
    expect(mockEvidence.filter((e) => e.purged_at !== null).length).toBe(50);
    expect(mockEvidence.slice(0, 150).every((e) => e.purged_at === null)).toBe(true);
  });

  // 5. Failed claims between eligible candidates
  it('5. handles claim RPC failures without stalling cursor progression', async () => {
    const exp = new Date(Date.now() - 20 * 86_400_000).toISOString();
    for (let i = 1; i <= 60; i++) {
      mockEvidence.push({
        id: makeUuid(i),
        visitor_id: `vis-${i}`,
        kind: 'photo',
        bucket_id: 'visitor-evidence',
        object_path: `photos/vis-${i}.jpg`,
        created_at: exp,
        expires_at: exp,
        purged_at: null,
      });
    }

    // Simulate claim failure on record 10
    simulatedClaimFailures.add(makeUuid(10));

    const res = await purgeHandler(makePurgeRequest(SUPERADMIN_ID, { dryRun: false }));
    const json = await res.json();
    expect(json.successCount).toBe(49);
    expect(json.failedCount).toBe(1);
    expect(mockReconciliation.some((r) => r.operation === 'image_purge_claim_rpc_failed')).toBe(true);
  });

  // 6. Storage deletion failures and retry behavior
  it('6. handles storage deletion failure by safely releasing the claim and continuing', async () => {
    const exp = new Date(Date.now() - 20 * 86_400_000).toISOString();
    for (let i = 1; i <= 50; i++) {
      mockEvidence.push({
        id: makeUuid(i),
        visitor_id: `vis-${i}`,
        kind: 'photo',
        bucket_id: 'visitor-evidence',
        object_path: `photos/vis-${i}.jpg`,
        created_at: exp,
        expires_at: exp,
        purged_at: null,
      });
    }

    // Fail storage removal for record 5
    simulatedStorageFailures.add('photos/vis-5.jpg');

    const res = await purgeHandler(makePurgeRequest(SUPERADMIN_ID, { dryRun: false }));
    const json = await res.json();
    expect(json.successCount).toBe(49);
    expect(json.failedCount).toBe(1);

    // Verify claim was released for record 5 (not left in purgatory)
    const rec5 = mockEvidence.find((e) => e.id === makeUuid(5));
    expect(rec5.purged_at).toBeNull();
    expect(rec5.purge_claim_id).toBeNull();
  });

  // 7. Multiple consecutive requests using returned cursors
  it('7. chains multiple consecutive requests deterministically with nextCursor and snapshotAt', async () => {
    const exp = new Date(Date.now() - 20 * 86_400_000).toISOString();
    for (let i = 1; i <= 150; i++) {
      mockEvidence.push({
        id: makeUuid(i),
        visitor_id: `vis-${i}`,
        kind: 'photo',
        bucket_id: 'visitor-evidence',
        object_path: `photos/vis-${i}.jpg`,
        created_at: exp,
        expires_at: exp,
        purged_at: null,
      });
    }

    // Batch 1
    const res1 = await purgeHandler(makePurgeRequest(SUPERADMIN_ID, { dryRun: false }));
    const json1 = await res1.json();
    expect(json1.successCount).toBe(50);
    expect(json1.hasMore).toBe(true);

    // Batch 2
    const res2 = await purgeHandler(makePurgeRequest(SUPERADMIN_ID, {
      dryRun: false,
      cursor: json1.nextCursor,
      snapshotAt: json1.snapshotAt,
    }));
    const json2 = await res2.json();
    expect(json2.successCount).toBe(50);
    expect(json2.hasMore).toBe(true);

    // Batch 3
    const res3 = await purgeHandler(makePurgeRequest(SUPERADMIN_ID, {
      dryRun: false,
      cursor: json2.nextCursor,
      snapshotAt: json2.snapshotAt,
    }));
    const json3 = await res3.json();
    expect(json3.successCount).toBe(50);
    expect(json3.hasMore).toBe(false);

    expect(mockEvidence.every((e) => e.purged_at !== null)).toBe(true);
  });

  // 8. Repeated requests eventually exhausting all eligible candidates
  it('8. exhausts all eligible records and reports hasMore: false cleanly', async () => {
    const exp = new Date(Date.now() - 20 * 86_400_000).toISOString();
    for (let i = 1; i <= 75; i++) {
      mockEvidence.push({
        id: makeUuid(i),
        visitor_id: `vis-${i}`,
        kind: 'photo',
        bucket_id: 'visitor-evidence',
        object_path: `photos/vis-${i}.jpg`,
        created_at: exp,
        expires_at: exp,
        purged_at: null,
      });
    }

    let currentCursor: string | null = null;
    let snapshotAt: string | null = null;
    let totalPurged = 0;
    let hasMore = true;

    while (hasMore) {
      const payload: any = { dryRun: false };
      if (currentCursor) payload.cursor = currentCursor;
      if (snapshotAt) payload.snapshotAt = snapshotAt;

      const res = await purgeHandler(makePurgeRequest(SUPERADMIN_ID, payload));
      const json = await res.json();
      totalPurged += json.successCount;
      hasMore = json.hasMore;
      currentCursor = json.nextCursor;
      snapshotAt = json.snapshotAt;
    }

    expect(totalPurged).toBe(75);
    expect(mockEvidence.every((e) => e.purged_at !== null)).toBe(true);

    // One more call returns 0 deleted and hasMore: false
    const finalRes = await purgeHandler(makePurgeRequest(SUPERADMIN_ID, { dryRun: false }));
    const finalJson = await finalRes.json();
    expect(finalJson.successCount).toBe(0);
    expect(finalJson.hasMore).toBe(false);
  });

  // 9. No duplicate deletion or double finalization
  it('9. guarantees every purged record is claimed and finalized exactly once', async () => {
    const exp = new Date(Date.now() - 20 * 86_400_000).toISOString();
    for (let i = 1; i <= 60; i++) {
      mockEvidence.push({
        id: makeUuid(i),
        visitor_id: `vis-${i}`,
        kind: 'photo',
        bucket_id: 'visitor-evidence',
        object_path: `photos/vis-${i}.jpg`,
        created_at: exp,
        expires_at: exp,
        purged_at: null,
      });
    }

    const res1 = await purgeHandler(makePurgeRequest(SUPERADMIN_ID, { dryRun: false }));
    const json1 = await res1.json();
    expect(json1.successCount).toBe(50);

    const res2 = await purgeHandler(makePurgeRequest(SUPERADMIN_ID, {
      dryRun: false,
      cursor: json1.nextCursor,
      snapshotAt: json1.snapshotAt,
    }));
    const json2 = await res2.json();
    expect(json2.successCount).toBe(10);

    // Check storage removed paths: no duplicate paths
    const uniquePaths = new Set(storageRemovedPaths);
    expect(storageRemovedPaths.length).toBe(uniquePaths.size);
    expect(storageRemovedPaths.length).toBe(60);
  });

  // 10. Normal purge respecting category toggles and configured durations
  it('10. respects category toggles and retention durations in normal mode', async () => {
    mockSettings.photo_retention_enabled = false;
    mockSettings.id_retention_days = 30;

    const days = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();

    mockEvidence.push({
      id: makeUuid(1),
      visitor_id: 'vis-photo-disabled',
      kind: 'photo',
      bucket_id: 'visitor-evidence',
      object_path: 'photo1.jpg',
      created_at: days(40), // 40 days old but photo is disabled
      expires_at: days(33),
      purged_at: null,
    });

    mockEvidence.push({
      id: makeUuid(2),
      visitor_id: 'vis-id-young',
      kind: 'id',
      bucket_id: 'visitor-evidence',
      object_path: 'id2.jpg',
      created_at: days(15), // 15 days old (< 30 days)
      expires_at: days(-15),
      purged_at: null,
    });

    mockEvidence.push({
      id: makeUuid(3),
      visitor_id: 'vis-id-expired',
      kind: 'id',
      bucket_id: 'visitor-evidence',
      object_path: 'id3.jpg',
      created_at: days(35), // 35 days old (> 30 days)
      expires_at: days(5),
      purged_at: null,
    });

    const res = await purgeHandler(makePurgeRequest(SUPERADMIN_ID, { dryRun: false }));
    const json = await res.json();
    expect(json.successCount).toBe(1);
    expect(mockEvidence.find((e) => e.id === makeUuid(1)).purged_at).toBeNull();
    expect(mockEvidence.find((e) => e.id === makeUuid(2)).purged_at).toBeNull();
    expect(mockEvidence.find((e) => e.id === makeUuid(3)).purged_at).not.toBeNull();
  });

  // 11. Superadmin override reaching records with future expiry dates
  it('11. allows Superadmin override to reach future expiry records in selected categories', async () => {
    const futureDate = new Date(Date.now() + 10 * 86_400_000).toISOString();
    mockEvidence.push({
      id: makeUuid(1),
      visitor_id: 'vis-future',
      kind: 'photo',
      bucket_id: 'visitor-evidence',
      object_path: 'future-photo.jpg',
      created_at: new Date(Date.now() - 3600000).toISOString(),
      expires_at: futureDate,
      purged_at: null,
    });

    const res = await purgeHandler(makePurgeRequest(SUPERADMIN_ID, {
      dryRun: false,
      override: {
        reason: 'Authorized compliance override by legal office',
        categories: ['photo'],
      },
    }));
    const json = await res.json();
    expect(json.successCount).toBe(1);
    expect(mockEvidence[0].purged_at).not.toBeNull();
  });

  // 12. Override never bypassing active-pass, campus-inside, or incident-hold safeguards
  it('12. strictly preserves incident hold, active pass, and campus inside safeguards even under Superadmin override', async () => {
    const past = new Date(Date.now() - 20 * 86_400_000).toISOString();

    mockHolds.push({ visitor_id: 'vis-held-override', active: true });
    mockInsidePasses.push({ visitor_id: 'vis-inside-override' });
    mockPasses.push({ visitor_id: 'vis-pass-override', status: 'inside', valid_until: past });

    mockEvidence.push(
      {
        id: makeUuid(1),
        visitor_id: 'vis-held-override',
        kind: 'photo',
        bucket_id: 'visitor-evidence',
        object_path: 'held.jpg',
        created_at: past,
        expires_at: past,
        purged_at: null,
      },
      {
        id: makeUuid(2),
        visitor_id: 'vis-inside-override',
        kind: 'photo',
        bucket_id: 'visitor-evidence',
        object_path: 'inside.jpg',
        created_at: past,
        expires_at: past,
        purged_at: null,
      },
      {
        id: makeUuid(3),
        visitor_id: 'vis-pass-override',
        kind: 'photo',
        bucket_id: 'visitor-evidence',
        object_path: 'pass.jpg',
        created_at: past,
        expires_at: past,
        purged_at: null,
      }
    );

    const res = await purgeHandler(makePurgeRequest(SUPERADMIN_ID, {
      dryRun: false,
      override: {
        reason: 'Legal compliance override request across campus',
        categories: ['photo'],
      },
    }));
    const json = await res.json();
    expect(json.successCount).toBe(0);
    expect(mockEvidence.every((e) => e.purged_at === null)).toBe(true);
  });

  // 13. Malformed, tampered, expired, or mismatched cursors being rejected safely
  it('13. rejects malformed or tampered cursors with 400 invalid_cursor', async () => {
    const invalidCursors = [
      '',
      '   ',
      'not-base64!',
      Buffer.from(JSON.stringify({ t: 'not-a-date', i: '123' })).toString('base64url'),
      Buffer.from(JSON.stringify({ t: new Date().toISOString(), i: 'not-a-uuid' })).toString('base64url'),
      Buffer.from(JSON.stringify({ only: 'garbage' })).toString('base64url'),
    ];

    for (const badCursor of invalidCursors) {
      const res = await purgeHandler(makePurgeRequest(SUPERADMIN_ID, {
        dryRun: true,
        cursor: badCursor,
      }));
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toBe('invalid_cursor');
    }

    // Invalid snapshotAt is rejected
    const resSnap = await purgeHandler(makePurgeRequest(SUPERADMIN_ID, {
      dryRun: true,
      snapshotAt: 'invalid-iso-date',
    }));
    expect(resSnap.status).toBe(400);
    const jsonSnap = await resSnap.json();
    expect(jsonSnap.error).toBe('invalid_snapshot_at');
  });

  // 14. Concurrent workers processing overlapping candidate sets
  it('14. handles concurrent workers safely where atomic claim avoids double-purge', async () => {
    const exp = new Date(Date.now() - 20 * 86_400_000).toISOString();
    for (let i = 1; i <= 50; i++) {
      mockEvidence.push({
        id: makeUuid(i),
        visitor_id: `vis-${i}`,
        kind: 'photo',
        bucket_id: 'visitor-evidence',
        object_path: `photos/vis-${i}.jpg`,
        created_at: exp,
        expires_at: exp,
        purged_at: null,
      });
    }

    // Worker 1 and Worker 2 fire concurrently on the same dataset
    const [res1, res2] = await Promise.all([
      purgeHandler(makePurgeRequest(SUPERADMIN_ID, { dryRun: false })),
      purgeHandler(makePurgeRequest(SUPERADMIN_ID, { dryRun: false })),
    ]);

    const json1 = await res1.json();
    const json2 = await res2.json();

    // Exactly 50 items were purged between the two workers (no double counting or error)
    expect(json1.successCount + json2.successCount).toBe(50);
    expect(mockEvidence.filter((e) => e.purged_at !== null).length).toBe(50);
  });

  // =========================================================================
  // CRITICAL ACCEPTANCE TEST: 2,500 Evidence Records Deterministic Fixture
  // =========================================================================
  it('CRITICAL ACCEPTANCE TEST: processes 2,500 records across multiple batches without skipping or double-purging', async () => {
    const TOTAL_RECORDS = 2500;
    const baseTime = Date.now() - 30 * 86_400_000;
    const sharedExp = new Date(baseTime).toISOString();

    let expectedEligible = 0;
    let expectedProtected = 0;

    for (let i = 1; i <= TOTAL_RECORDS; i++) {
      const vId = `vis-2500-${i}`;
      const evId = makeUuid(i);

      let isProtected = false;

      // 1. First 200 records: protected by incident holds
      if (i <= 200) {
        mockHolds.push({ visitor_id: vId, active: true });
        isProtected = true;
      }
      // 2. Records 601-750: protected by campus 'inside' status
      else if (i >= 601 && i <= 750) {
        mockInsidePasses.push({ visitor_id: vId });
        isProtected = true;
      }
      // 3. Records 1201-1350: protected by incident hold in the middle
      else if (i >= 1201 && i <= 1350) {
        mockHolds.push({ visitor_id: vId, active: true });
        isProtected = true;
      }
      // 4. Records 1801-1900: too young (created 1 day ago)
      else if (i >= 1801 && i <= 1900) {
        isProtected = true; // Young
      }
      // 5. Records 2401-2500: protected by incident hold at the end
      else if (i >= 2401 && i <= 2500) {
        mockHolds.push({ visitor_id: vId, active: true });
        isProtected = true;
      }

      if (isProtected) {
        expectedProtected++;
      } else {
        expectedEligible++;
      }

      // Mix of identical expiry timestamps and varying timestamps
      const exp = i % 5 === 0 ? sharedExp : new Date(baseTime + i * 2000).toISOString();
      const createdAt = i >= 1801 && i <= 1900
        ? new Date(Date.now() - 1 * 86_400_000).toISOString() // Young
        : exp;

      mockEvidence.push({
        id: evId,
        visitor_id: vId,
        kind: 'photo',
        bucket_id: 'visitor-evidence',
        object_path: `photos/${vId}.jpg`,
        created_at: createdAt,
        expires_at: exp,
        purged_at: null,
      });
    }

    expect(mockEvidence.length).toBe(TOTAL_RECORDS);
    expect(expectedEligible + expectedProtected).toBe(TOTAL_RECORDS);

    // Multi-batch execution loop simulating frontend / client pagination
    let currentCursor: string | null = null;
    let snapshotAt: string | null = null;
    let totalPurged = 0;
    let totalFailed = 0;
    let hasMore = true;
    let batchCount = 0;
    const MAX_ALLOWED_BATCHES = 60; // 2,500 / 50 = 50 batches max

    while (hasMore && batchCount < MAX_ALLOWED_BATCHES) {
      batchCount++;
      const payload: any = { dryRun: false };
      if (currentCursor) payload.cursor = currentCursor;
      if (snapshotAt) payload.snapshotAt = snapshotAt;

      const res = await purgeHandler(makePurgeRequest(SUPERADMIN_ID, payload));
      expect(res.status).toBe(200);
      const json = await res.json();

      totalPurged += json.successCount;
      totalFailed += json.failedCount;
      hasMore = json.hasMore;
      currentCursor = json.nextCursor;
      if (!snapshotAt && json.snapshotAt) {
        snapshotAt = json.snapshotAt;
      }

      // Break if no items were purged and no cursor was returned to prevent spinning
      if (json.successCount === 0 && !json.nextCursor) {
        break;
      }
    }

    // PROOFS:
    // 1. Every single eligible record was purged exactly once
    expect(totalPurged).toBe(expectedEligible);
    expect(totalFailed).toBe(0);

    // 2. Exactly expectedEligible records have purged_at set
    const actualPurgedRecords = mockEvidence.filter((e) => e.purged_at !== null);
    expect(actualPurgedRecords.length).toBe(expectedEligible);

    // 3. Zero protected records were purged
    const actualProtectedRecords = mockEvidence.filter((e) => e.purged_at === null);
    expect(actualProtectedRecords.length).toBe(expectedProtected);

    // 4. No candidate was silently skipped
    expect(actualPurgedRecords.length + actualProtectedRecords.length).toBe(TOTAL_RECORDS);

    // 5. All storage objects for purged records were removed
    expect(storageRemovedPaths.length).toBe(expectedEligible);
  });
});
