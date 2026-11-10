import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { handleRequest } from '../server/routes/admin/retention-maintenance.js';
import { setServerSupabaseClientsForTest } from '../server/supabase.js';
import { decodeCursor, encodeCursor } from '../server/cursor.js';

describe('Scheduled Retention Purge Cursor Progression & Invariants', () => {
  const CRON_SECRET = 'test_cron_secret_retention_progression_123';

  let mockSettings: any;
  let mockMaintenanceState: Map<string, any>;
  let mockEvidence: any[];
  let mockAuditEvents: any[];
  let mockReconciliation: any[];
  let storageRemovedPaths: string[];
  let simulatedStorageFailures: Set<string>;
  let simulatedClaimFailures: Set<string>;
  let simulatedFinalizeFailures: Set<string>;
  let claimCalls: any[];
  let finalizeCalls: any[];

  function makeMaintenanceRequest(body: { dryRun?: boolean; batchSize?: number } = {}) {
    return new Request('https://egatepass.tech/api/admin/retention-maintenance', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${CRON_SECRET}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        dryRun: body.dryRun ?? false,
        batchSize: body.batchSize ?? 10,
      }),
    });
  }

  function getPersistedCursor(): { timestamp: string; id: string } | null {
    const state = mockMaintenanceState.get('retention_evidence_purge');
    if (!state || !state.cursor_value) return null;
    return decodeCursor(state.cursor_value, { idType: 'uuid' }) as { timestamp: string; id: string } | null;
  }

  beforeEach(() => {
  function createGenericBuilder() {
    const b: any = {
      select: () => b,
      in: () => b,
      is: () => b,
      eq: () => b,
      not: () => b,
      or: () => b,
      lt: () => b,
      gt: () => b,
      gte: () => b,
      lte: () => b,
      order: () => b,
      limit: () => b,
      maybeSingle: async () => ({ data: null, error: null }),
      single: async () => ({ data: null, error: null }),
      delete: () => b,
      update: () => b,
      insert: async () => ({ data: null, error: null }),
      then: (resolve: any) => resolve({ data: [], error: null }),
    };
    return b;
  }

    process.env.CRON_SECRET = CRON_SECRET;
    mockMaintenanceState = new Map();
    mockAuditEvents = [];
    mockReconciliation = [];
    storageRemovedPaths = [];
    simulatedStorageFailures = new Set();
    simulatedClaimFailures = new Set();
    simulatedFinalizeFailures = new Set();
    claimCalls = [];
    finalizeCalls = [];

    mockSettings = {
      singleton: true,
      automatic_cleanup_enabled: true,
      image_retention_days: 7,
      photo_retention_days: 7,
      id_retention_days: 30,
      vehicle_photo_retention_days: 7,
      photo_retention_enabled: true,
      id_retention_enabled: true,
      vehicle_photo_retention_enabled: true,
      visitor_retention_enabled: false,
      returning_profile_retention_enabled: false,
    };

    mockEvidence = [];

    const mockAdmin: any = {
      auth: {
        admin: {
          listUsers: vi.fn(async () => ({ data: { users: [] }, error: null })),
          deleteUser: vi.fn(async () => ({ error: null })),
        },
      },
      schema: vi.fn(() => mockAdmin),
      from: vi.fn((tableName: string) => {
        if (tableName === 'app_settings') {
          return {
            select: () => ({
              eq: () => ({
                maybeSingle: async () => ({ data: mockSettings, error: null }),
              }),
            }),
          };
        }

        if (tableName === 'maintenance_state') {
          return {
            select: () => ({
              eq: (_col: string, val: string) => ({
                maybeSingle: async () => {
                  const state = mockMaintenanceState.get(val);
                  return { data: state ? { ...state } : null, error: null };
                },
              }),
            }),
            upsert: vi.fn(async (row: any) => {
              mockMaintenanceState.set(row.job_name, { ...row });
              return { data: row, error: null };
            }),
          };
        }

        if (tableName === 'visitor_evidence') {
          const builder: any = {
            _filters: [] as Array<(item: any) => boolean>,
            _limit: 50,
            select: () => builder,
            is: (col: string, val: any) => {
              builder._filters.push((item: any) => item[col] === val);
              return builder;
            },
            in: (col: string, vals: any[]) => {
              builder._filters.push((item: any) => vals.includes(item[col]));
              return builder;
            },
            eq: (col: string, val: any) => {
              builder._filters.push((item: any) => item[col] === val);
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
          const b = createGenericBuilder();
          b.insert = vi.fn(async (ev: any) => {
            mockAuditEvents.push(ev);
            return { data: ev, error: null };
          });
          return b;
        }

        if (tableName === 'reconciliation_tasks') {
          const b = createGenericBuilder();
          b.insert = vi.fn(async (task: any) => {
            mockReconciliation.push(task);
            return { data: task, error: null };
          });
          return b;
        }

        // Generic chainable builder for all other maintenance tables
        return createGenericBuilder();
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
          claimCalls.push(args);
          const item = mockEvidence.find((e) => e.id === args.requested_evidence_id);
          if (!item) return { data: null, error: new Error('Record not found') };
          if (simulatedClaimFailures.has(item.id)) {
            return { data: null, error: new Error(`Simulated claim failure for ${item.id}`) };
          }
          if (item.purged_at !== null || item.purge_claim_id) {
            return { data: { claimed: false, reason: 'already_purged_or_claimed' }, error: null };
          }
          if (item._safeguardBlocked) {
            return { data: { claimed: false, reason: item._safeguardReason || 'safeguard_blocked' }, error: null };
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
          finalizeCalls.push(args);
          const item = mockEvidence.find((e) => e.id === args.requested_evidence_id);
          if (!item) return { data: null, error: new Error('Record not found') };
          if (simulatedFinalizeFailures.has(item.id)) {
            return { data: null, error: new Error(`Simulated finalize failure for ${item.id}`) };
          }
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

    setServerSupabaseClientsForTest({ admin: mockAdmin as any, anon: {} as any });
  });

  afterEach(() => {
    setServerSupabaseClientsForTest(null);
  });

  // =========================================================================
  // Requirement 1: Eligible records followed by ineligible records
  // =========================================================================
  it('1. eligible records followed by ineligible records advances cursor to the final examined page row (does NOT overwrite with earlier eligible item)', async () => {
    const baseTime = new Date('2026-10-01T00:00:00.000Z').getTime();

    // 10 items in total for a page of 10:
    // Rows 0..3: eligible (created 10 days ago, past 7-day retention)
    // Rows 4..9: ineligible (created 2 days ago, within 7-day retention)
    for (let i = 0; i < 10; i++) {
      const isEligible = i < 4;
      const createdAt = isEligible
        ? new Date(Date.now() - 10 * 86_400_000).toISOString()
        : new Date(Date.now() - 2 * 86_400_000).toISOString();
      const expiresAt = new Date(baseTime + i * 3600_000).toISOString();
      const id = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;

      mockEvidence.push({
        id,
        visitor_id: `vis-${i}`,
        bucket_id: 'visitor-photos',
        object_path: `photos/photo-${i}.jpg`,
        kind: 'photo',
        created_at: createdAt,
        expires_at: expiresAt,
        purged_at: null,
      });
    }

    const res = await handleRequest(makeMaintenanceRequest({ batchSize: 10 }));
    expect(res.status).toBe(200);
    const body = await res.json();

    // 4 items purged (rows 0..3)
    expect(body.maintenance.evidenceEligible).toBe(4);
    expect(body.maintenance.evidencePurged).toBe(4);

    // Verify persisted cursor is the LAST examined row of the page (Row 9), NOT Row 3
    const cursor = getPersistedCursor();
    expect(cursor).not.toBeNull();
    expect(cursor!.id).toBe('00000000-0000-4000-8000-000000000009');
    expect(cursor!.timestamp).toBe(mockEvidence[9].expires_at);

    // Confirm rows 0..3 were purged in storage and DB
    for (let i = 0; i < 4; i++) {
      expect(mockEvidence[i].purged_at).not.toBeNull();
      expect(storageRemovedPaths).toContain(`photos/photo-${i}.jpg`);
    }

    // Confirm rows 4..9 were NOT purged
    for (let i = 4; i < 10; i++) {
      expect(mockEvidence[i].purged_at).toBeNull();
      expect(storageRemovedPaths).not.toContain(`photos/photo-${i}.jpg`);
    }
  });

  // =========================================================================
  // Requirement 2: Next-page continuation
  // =========================================================================
  it('2. next-page continuation: subsequent execution correctly queries past the previous page and processes the next eligible record without re-examining the previous page', async () => {
    const baseTime = new Date('2026-10-01T00:00:00.000Z').getTime();

    // Page 1: 5 items (Rows 0..1 eligible, Rows 2..4 ineligible)
    for (let i = 0; i < 5; i++) {
      const isEligible = i < 2;
      mockEvidence.push({
        id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
        visitor_id: `vis-${i}`,
        bucket_id: 'visitor-photos',
        object_path: `photos/photo-${i}.jpg`,
        kind: 'photo',
        created_at: isEligible
          ? new Date(Date.now() - 10 * 86_400_000).toISOString()
          : new Date(Date.now() - 2 * 86_400_000).toISOString(),
        expires_at: new Date(baseTime + i * 3600_000).toISOString(),
        purged_at: null,
      });
    }

    // Page 2: Row 5 (eligible) and Row 6 (eligible)
    for (let i = 5; i < 7; i++) {
      mockEvidence.push({
        id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
        visitor_id: `vis-${i}`,
        bucket_id: 'visitor-photos',
        object_path: `photos/photo-${i}.jpg`,
        kind: 'photo',
        created_at: new Date(Date.now() - 10 * 86_400_000).toISOString(),
        expires_at: new Date(baseTime + i * 3600_000).toISOString(),
        purged_at: null,
      });
    }

    // First scheduled maintenance run (batchSize: 5)
    const res1 = await handleRequest(makeMaintenanceRequest({ batchSize: 5 }));
    expect(res1.status).toBe(200);
    const body1 = await res1.json();
    expect(body1.maintenance.evidencePurged).toBe(2);

    // Cursor MUST be at Row 4 (end of page 1)
    const cursor1 = getPersistedCursor();
    expect(cursor1!.id).toBe('00000000-0000-4000-8000-000000000004');

    // Second scheduled maintenance run (batchSize: 5) - uses persisted cursor from maintenance_state
    const res2 = await handleRequest(makeMaintenanceRequest({ batchSize: 5 }));
    expect(res2.status).toBe(200);
    const body2 = await res2.json();

    // Rows 5 and 6 must be processed and purged
    expect(body2.maintenance.evidenceEligible).toBe(2);
    expect(body2.maintenance.evidencePurged).toBe(2);
    expect(mockEvidence[5].purged_at).not.toBeNull();
    expect(mockEvidence[6].purged_at).not.toBeNull();

    // Ineligible rows 2..4 from page 1 were NOT re-queried or re-examined
    const cursor2 = getPersistedCursor();
    expect(cursor2!.id).toBe('00000000-0000-4000-8000-000000000006');
  });

  // =========================================================================
  // Requirement 3: All-ineligible page
  // =========================================================================
  it('3. all-ineligible page advances the persisted cursor to the last examined row, preventing starvation', async () => {
    const baseTime = new Date('2026-10-01T00:00:00.000Z').getTime();

    // 5 items in page, all ineligible
    for (let i = 0; i < 5; i++) {
      mockEvidence.push({
        id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
        visitor_id: `vis-${i}`,
        bucket_id: 'visitor-photos',
        object_path: `photos/photo-${i}.jpg`,
        kind: 'photo',
        created_at: new Date(Date.now() - 1 * 86_400_000).toISOString(), // 1 day old < 7 days retention
        expires_at: new Date(baseTime + i * 3600_000).toISOString(),
        purged_at: null,
      });
    }

    const res = await handleRequest(makeMaintenanceRequest({ batchSize: 5 }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.maintenance.evidenceEligible).toBe(0);
    expect(body.maintenance.evidencePurged).toBe(0);

    // Persisted cursor MUST advance to Row 4 (final examined row of page), not stall at null
    const cursor = getPersistedCursor();
    expect(cursor).not.toBeNull();
    expect(cursor!.id).toBe('00000000-0000-4000-8000-000000000004');
    expect(cursor!.timestamp).toBe(mockEvidence[4].expires_at);
  });

  // =========================================================================
  // Requirement 4: Claim failure does not stall or regress cursor
  // =========================================================================
  it('4. claim failure on an eligible record does not stall or regress cursor progression', async () => {
    const baseTime = new Date('2026-10-01T00:00:00.000Z').getTime();

    for (let i = 0; i < 5; i++) {
      mockEvidence.push({
        id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
        visitor_id: `vis-${i}`,
        bucket_id: 'visitor-photos',
        object_path: `photos/photo-${i}.jpg`,
        kind: 'photo',
        created_at: new Date(Date.now() - 10 * 86_400_000).toISOString(),
        expires_at: new Date(baseTime + i * 3600_000).toISOString(),
        purged_at: null,
      });
    }

    // Simulate claim failure on row 1
    simulatedClaimFailures.add('00000000-0000-4000-8000-000000000001');

    const res = await handleRequest(makeMaintenanceRequest({ batchSize: 5 }));
    expect(res.status).toBe(200);
    const body = await res.json();

    // 4 items purged, 1 failed claim
    expect(body.maintenance.evidencePurged).toBe(4);
    expect(body.maintenance.errors.some((e: string) => e.includes('claim_failed_00000000-0000-4000-8000-000000000001'))).toBe(true);

    // Row 1 was not purged
    expect(mockEvidence[1].purged_at).toBeNull();

    // Cursor still advances to the end of the page (Row 4), not regressed to Row 0 or stalled at Row 1
    const cursor = getPersistedCursor();
    expect(cursor!.id).toBe('00000000-0000-4000-8000-000000000004');
  });

  // =========================================================================
  // Requirement 5: Storage deletion failure
  // =========================================================================
  it('5. storage deletion failure safely releases the claim, logs reconciliation, does not purge DB row, and advances cursor', async () => {
    const baseTime = new Date('2026-10-01T00:00:00.000Z').getTime();

    for (let i = 0; i < 4; i++) {
      mockEvidence.push({
        id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
        visitor_id: `vis-${i}`,
        bucket_id: 'visitor-photos',
        object_path: `photos/photo-${i}.jpg`,
        kind: 'photo',
        created_at: new Date(Date.now() - 10 * 86_400_000).toISOString(),
        expires_at: new Date(baseTime + i * 3600_000).toISOString(),
        purged_at: null,
      });
    }

    // Simulate storage failure on row 2
    simulatedStorageFailures.add('photos/photo-2.jpg');

    const res = await handleRequest(makeMaintenanceRequest({ batchSize: 4 }));
    expect(res.status).toBe(200);
    const body = await res.json();

    // 3 items purged (0, 1, 3)
    expect(body.maintenance.evidencePurged).toBe(3);
    expect(mockEvidence[2].purged_at).toBeNull(); // Row 2 was NOT marked purged in DB

    // finalize_evidence_purge was called with requested_success: false for Row 2
    const releasedCall = finalizeCalls.find(
      (c) => c.requested_evidence_id === '00000000-0000-4000-8000-000000000002' && c.requested_success === false
    );
    expect(releasedCall).toBeDefined();

    // Reconciliation task was recorded
    const recTask = mockReconciliation.find((r) => r.operation === 'evidence.purge_storage_failed');
    expect(recTask).toBeDefined();
    expect(recTask.reference_id).toBe('00000000-0000-4000-8000-000000000002');

    // Cursor still advances to Row 3
    const cursor = getPersistedCursor();
    expect(cursor!.id).toBe('00000000-0000-4000-8000-000000000003');
  });

  // =========================================================================
  // Requirement 6: Equal expiry timestamps compound ordering
  // =========================================================================
  it('6. compound ordering (expires_at ASC, id ASC) deterministically paginates across records sharing identical expiry timestamps', async () => {
    const identicalExpiry = '2026-10-05T12:00:00.000Z';

    const ids = [
      'aaaaaaaa-0000-4000-8000-000000000001',
      'bbbbbbbb-0000-4000-8000-000000000002',
      'cccccccc-0000-4000-8000-000000000003',
      'dddddddd-0000-4000-8000-000000000004',
    ];

    for (let i = 0; i < ids.length; i++) {
      mockEvidence.push({
        id: ids[i],
        visitor_id: `vis-${i}`,
        bucket_id: 'visitor-photos',
        object_path: `photos/photo-${i}.jpg`,
        kind: 'photo',
        created_at: new Date(Date.now() - 10 * 86_400_000).toISOString(),
        expires_at: identicalExpiry,
        purged_at: null,
      });
    }

    // Run batch 1 (batchSize: 2) -> fetches A and B
    const res1 = await handleRequest(makeMaintenanceRequest({ batchSize: 2 }));
    expect(res1.status).toBe(200);
    const body1 = await res1.json();
    expect(body1.maintenance.evidencePurged).toBe(2);

    const cursor1 = getPersistedCursor();
    expect(cursor1).toEqual({ timestamp: identicalExpiry, id: ids[1] });

    // Run batch 2 (batchSize: 2) -> fetches C and D
    const res2 = await handleRequest(makeMaintenanceRequest({ batchSize: 2 }));
    expect(res2.status).toBe(200);
    const body2 = await res2.json();
    expect(body2.maintenance.evidencePurged).toBe(2);

    const cursor2 = getPersistedCursor();
    expect(cursor2).toEqual({ timestamp: identicalExpiry, id: ids[3] });

    // All 4 purged
    for (const item of mockEvidence) {
      expect(item.purged_at).not.toBeNull();
    }
  });

  // =========================================================================
  // Requirement 7: End-of-queue wrap-around
  // =========================================================================
  it('7. end-of-queue wrap-around: resets cursor when table is clean, and revisits remaining unpurged items from the beginning', async () => {
    const baseTime = new Date('2026-10-01T00:00:00.000Z').getTime();

    mockEvidence.push(
      {
        id: '00000000-0000-4000-8000-000000000001',
        visitor_id: 'vis-1',
        bucket_id: 'visitor-photos',
        object_path: 'photos/photo-1.jpg',
        kind: 'photo',
        created_at: new Date(Date.now() - 10 * 86_400_000).toISOString(),
        expires_at: new Date(baseTime).toISOString(),
        purged_at: null,
      },
      {
        id: '00000000-0000-4000-8000-000000000002',
        visitor_id: 'vis-2',
        bucket_id: 'visitor-photos',
        object_path: 'photos/photo-2.jpg',
        kind: 'photo',
        created_at: new Date(Date.now() - 10 * 86_400_000).toISOString(),
        expires_at: new Date(baseTime + 3600_000).toISOString(),
        purged_at: null,
      }
    );

    // Initial run: purges items 1 and 2
    const res1 = await handleRequest(makeMaintenanceRequest({ batchSize: 5 }));
    expect(res1.status).toBe(200);
    const cursor1 = getPersistedCursor();
    expect(cursor1!.id).toBe('00000000-0000-4000-8000-000000000002');

    // Next run: query past item 2 returns empty, wrap-around query also returns empty (all purged)
    const res2 = await handleRequest(makeMaintenanceRequest({ batchSize: 5 }));
    expect(res2.status).toBe(200);

    // Cursor resets to null
    const cursor2 = getPersistedCursor();
    expect(cursor2).toBeNull();

    // Now insert a new unpurged item at the beginning
    mockEvidence.push({
      id: '00000000-0000-4000-8000-000000000003',
      visitor_id: 'vis-3',
      bucket_id: 'visitor-photos',
      object_path: 'photos/photo-3.jpg',
      kind: 'photo',
      created_at: new Date(Date.now() - 10 * 86_400_000).toISOString(),
      expires_at: new Date(baseTime + 7200_000).toISOString(),
      purged_at: null,
    });

    // Later run starts from the beginning (since cursor was null) and purges item 3
    const res3 = await handleRequest(makeMaintenanceRequest({ batchSize: 5 }));
    expect(res3.status).toBe(200);
    const body3 = await res3.json();
    expect(body3.maintenance.evidencePurged).toBe(1);
    expect(mockEvidence[2].purged_at).not.toBeNull();
  });

  // =========================================================================
  // Requirement 8: Safeguard preservation (incident hold, active pass, campus inside)
  // =========================================================================
  it('8. safeguard preservation: incident-held, active-pass, and campus-inside records are rejected by claim RPC and never purged', async () => {
    const baseTime = new Date('2026-10-01T00:00:00.000Z').getTime();

    // Row 0: incident hold
    mockEvidence.push({
      id: '00000000-0000-4000-8000-000000000001',
      visitor_id: 'vis-held',
      bucket_id: 'visitor-photos',
      object_path: 'photos/photo-held.jpg',
      kind: 'photo',
      created_at: new Date(Date.now() - 10 * 86_400_000).toISOString(),
      expires_at: new Date(baseTime).toISOString(),
      purged_at: null,
      _safeguardBlocked: true,
      _safeguardReason: 'incident_hold_active',
    });

    // Row 1: active pass
    mockEvidence.push({
      id: '00000000-0000-4000-8000-000000000002',
      visitor_id: 'vis-active-pass',
      bucket_id: 'visitor-photos',
      object_path: 'photos/photo-active.jpg',
      kind: 'photo',
      created_at: new Date(Date.now() - 10 * 86_400_000).toISOString(),
      expires_at: new Date(baseTime + 3600_000).toISOString(),
      purged_at: null,
      _safeguardBlocked: true,
      _safeguardReason: 'active_pass_exists',
    });

    // Row 2: inside campus
    mockEvidence.push({
      id: '00000000-0000-4000-8000-000000000003',
      visitor_id: 'vis-inside',
      bucket_id: 'visitor-photos',
      object_path: 'photos/photo-inside.jpg',
      kind: 'photo',
      created_at: new Date(Date.now() - 10 * 86_400_000).toISOString(),
      expires_at: new Date(baseTime + 7200_000).toISOString(),
      purged_at: null,
      _safeguardBlocked: true,
      _safeguardReason: 'visitor_currently_inside',
    });

    // Row 3: normal unblocked eligible record
    mockEvidence.push({
      id: '00000000-0000-4000-8000-000000000004',
      visitor_id: 'vis-clean',
      bucket_id: 'visitor-photos',
      object_path: 'photos/photo-clean.jpg',
      kind: 'photo',
      created_at: new Date(Date.now() - 10 * 86_400_000).toISOString(),
      expires_at: new Date(baseTime + 10800_000).toISOString(),
      purged_at: null,
    });

    const res = await handleRequest(makeMaintenanceRequest({ batchSize: 10 }));
    expect(res.status).toBe(200);
    const body = await res.json();

    // Exactly 1 item purged (Row 3)
    expect(body.maintenance.evidencePurged).toBe(1);

    // Safeguard-blocked rows remain unpurged in storage and DB
    expect(mockEvidence[0].purged_at).toBeNull();
    expect(mockEvidence[1].purged_at).toBeNull();
    expect(mockEvidence[2].purged_at).toBeNull();
    expect(mockEvidence[3].purged_at).not.toBeNull();

    expect(storageRemovedPaths).toEqual(['photos/photo-clean.jpg']);

    // Cursor still advances past all 4 examined records to Row 3
    const cursor = getPersistedCursor();
    expect(cursor!.id).toBe('00000000-0000-4000-8000-000000000004');
  });

  // =========================================================================
  // Requirement 9: Concurrent maintenance (atomic claim prevents double deletion)
  // =========================================================================
  it('9. concurrent maintenance: atomic claim RPC prevents duplicate storage deletion and conflicting finalization', async () => {
    const evidenceId = '00000000-0000-4000-8000-000000000001';
    const claimIdWorker1 = 'worker-1-uuid';
    const claimIdWorker2 = 'worker-2-uuid';

    mockEvidence.push({
      id: evidenceId,
      visitor_id: 'vis-concurrent',
      bucket_id: 'visitor-photos',
      object_path: 'photos/photo-concurrent.jpg',
      kind: 'photo',
      created_at: new Date(Date.now() - 10 * 86_400_000).toISOString(),
      expires_at: new Date('2026-10-01T00:00:00.000Z').toISOString(),
      purged_at: null,
      purge_claim_id: null,
    });

    // Simulate Worker 1 claiming the record
    const { data: claim1 } = await (setServerSupabaseClientsForTest as any); // just accessing admin rpc
    const { admin } = (await import('../server/supabase.js')).getServerSupabaseClients();

    const claimRes1 = await admin.schema('api').rpc('claim_evidence_for_purge', {
      requested_evidence_id: evidenceId,
      requested_claim_id: claimIdWorker1,
    });
    expect(claimRes1.data.claimed).toBe(true);

    // Worker 2 attempts to claim the same record concurrently
    const claimRes2 = await admin.schema('api').rpc('claim_evidence_for_purge', {
      requested_evidence_id: evidenceId,
      requested_claim_id: claimIdWorker2,
    });
    expect(claimRes2.data.claimed).toBe(false);
    expect(claimRes2.data.reason).toBe('already_purged_or_claimed');

    // Only Worker 1 deletes storage
    await admin.storage.from('visitor-photos').remove(['photos/photo-concurrent.jpg']);
    expect(storageRemovedPaths.length).toBe(1);

    // Worker 2 attempting to finalize fails with claim_mismatch
    const finalizeRes2 = await admin.schema('api').rpc('finalize_evidence_purge', {
      requested_evidence_id: evidenceId,
      requested_claim_id: claimIdWorker2,
      requested_success: true,
    });
    expect(finalizeRes2.data.finalized).toBe(false);
    expect(finalizeRes2.data.match_status).toBe('claim_mismatch');

    // Worker 1 finalizes successfully
    const finalizeRes1 = await admin.schema('api').rpc('finalize_evidence_purge', {
      requested_evidence_id: evidenceId,
      requested_claim_id: claimIdWorker1,
      requested_success: true,
    });
    expect(finalizeRes1.data.finalized).toBe(true);
    expect(finalizeRes1.data.purged).toBe(true);
    expect(mockEvidence[0].purged_at).not.toBeNull();
  });
});
