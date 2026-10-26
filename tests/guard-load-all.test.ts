import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fetchGuardDashboardWindow, type GuardQueuePass } from '../src/services/guard';
import * as supabaseLib from '../src/lib/supabase';

function generatePassPool(count: number): Array<{ id: string; visitorName: string }> {
  return Array.from({ length: count }, (_, i) => {
    // Generate valid UUIDs for schema validation
    const hex = i.toString(16).padStart(12, '0');
    return {
      id: `00000000-0000-4000-8000-${hex}`,
      visitorName: `Visitor ${i + 1}`,
    };
  });
}

function mockSupabaseRpc(queuePool: Array<{ id: string; visitorName: string }>) {
  const rpcCalls: Array<{ limit: number; offset: number }> = [];
  const mockRpc = vi.fn(async (_fnName: string, params: { requested_limit: number; requested_offset: number }) => {
    // Enforce real PostgreSQL 200-row safety cap in test mock:
    const v_limit = Math.min(Math.max(params.requested_limit ?? 50, 1), 200);
    const v_offset = Math.max(params.requested_offset ?? 0, 0);
    rpcCalls.push({ limit: v_limit, offset: v_offset });

    const total = queuePool.length;
    const pageItems = queuePool.slice(v_offset, v_offset + v_limit);
    const v_has_more = total > (v_offset + v_limit);

    return {
      data: {
        queue: pageItems.map((item) => ({
          id: item.id,
          visitorName: item.visitorName,
          purpose: 'Official Business',
          source: 'portal',
          status: 'pending',
          validFrom: '2026-10-21T08:00:00Z',
          validUntil: '2026-10-21T17:00:00Z',
          scannedAt: '2026-10-21T09:00:00Z',
          gate: 'Gate 1',
          photoEvidenceId: '22222222-2222-4222-8222-222222222222',
          idEvidenceId: '33333333-3333-4333-8333-333333333333',
        })),
        stats: { inside: 10, exited: 5, rejected: 1, total: 16 },
        rejectionReasons: ['Expired Pass', 'No ID'],
        pendingTotal: total,
        hasMore: v_has_more,
      },
      error: null,
    };
  });

  vi.spyOn(supabaseLib, 'requireSupabase').mockReturnValue({
    schema: vi.fn().mockReturnValue({
      rpc: mockRpc,
    }),
  } as any);

  return { mockRpc, rpcCalls };
}

describe('Guard Queue Refresh Depth & Window Loading Regression', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('PATCH 11. Preserves Supabase 200-row RPC safety cap in migration without modification', () => {
    const migrationPath = join(
      __dirname,
      '../supabase/migrations/20261026040000_pass_expiration_and_operational_truth_closure.sql'
    );
    const migrationContent = readFileSync(migrationPath, 'utf-8');
    expect(migrationContent).toContain(
      'v_limit integer := least(greatest(coalesce(requested_limit, 50), 1), 200);'
    );
  });

  it('REQUIRED TEST A. 450 Load All then refresh: preserves 450 depth across refresh without collapsing to 200', async () => {
    const pool450 = generatePassPool(450);
    const { rpcCalls } = mockSupabaseRpc(pool450);

    // 1. Initial Load All
    const loadAllResult = await fetchGuardDashboardWindow({
      desiredCount: 5000,
      safetyCeiling: 5000,
    });

    expect(loadAllResult.queue.length).toBe(450);
    expect(loadAllResult.hasMore).toBe(false);
    expect(loadAllResult.reachedSafetyCeiling).toBe(false);
    expect(rpcCalls).toHaveLength(3);
    expect(rpcCalls[0]).toEqual({ limit: 200, offset: 0 });
    expect(rpcCalls[1]).toEqual({ limit: 200, offset: 200 });
    expect(rpcCalls[2]).toEqual({ limit: 200, offset: 400 });

    // 2. Periodic refresh simulating passesLengthRef.current = 450
    rpcCalls.length = 0;
    const refreshResult = await fetchGuardDashboardWindow({
      desiredCount: 450,
    });

    expect(rpcCalls).toHaveLength(3);
    expect(rpcCalls[0]).toEqual({ limit: 200, offset: 0 });
    expect(rpcCalls[1]).toEqual({ limit: 200, offset: 200 });
    expect(rpcCalls[2]).toEqual({ limit: 50, offset: 400 });

    // Explicit regression assertion: 450 must NOT collapse to 200!
    expect(refreshResult.queue.length).toBe(450);
    expect(refreshResult.queue.length).not.toBe(200);
    expect(refreshResult.hasMore).toBe(false);
  });

  it('REQUIRED TEST B. Load More above 200 then refresh: 250 loaded depth preserves 250 across refresh', async () => {
    const pool300 = generatePassPool(300);
    const { rpcCalls } = mockSupabaseRpc(pool300);

    // Refresh simulating queue expanded via Load More to 250
    const refreshResult = await fetchGuardDashboardWindow({
      desiredCount: 250,
    });

    expect(rpcCalls).toHaveLength(2);
    expect(rpcCalls[0]).toEqual({ limit: 200, offset: 0 });
    expect(rpcCalls[1]).toEqual({ limit: 50, offset: 200 });

    expect(refreshResult.queue.length).toBe(250);
    expect(refreshResult.hasMore).toBe(true); // 300 total > 250 loaded
    expect(refreshResult.queue.length).not.toBe(200);
  });

  it('REQUIRED TEST C. Queue shrinks: 450 previous depth shrinks cleanly to 317 without stale retention', async () => {
    const pool317 = generatePassPool(317);
    const { rpcCalls } = mockSupabaseRpc(pool317);

    // Refresh with desiredCount 450 when server authoritative queue has 317
    const refreshResult = await fetchGuardDashboardWindow({
      desiredCount: 450,
    });

    expect(rpcCalls).toHaveLength(2);
    expect(rpcCalls[0]).toEqual({ limit: 200, offset: 0 });
    expect(rpcCalls[1]).toEqual({ limit: 200, offset: 200 }); // requested 200, returned 117, server hasMore = false

    expect(refreshResult.queue.length).toBe(317);
    expect(refreshResult.hasMore).toBe(false);
    // Explicit assertion: exactly 317 rows returned, 133 stale rows NOT retained
    expect(refreshResult.queue.length).not.toBe(450);
  });

  it('REQUIRED TEST D. Queue still larger than loaded window: 450 window against 600 total maintains hasMore: true', async () => {
    const pool600 = generatePassPool(600);
    const { rpcCalls } = mockSupabaseRpc(pool600);

    const refreshResult = await fetchGuardDashboardWindow({
      desiredCount: 450,
    });

    expect(rpcCalls).toHaveLength(3);
    expect(rpcCalls[0]).toEqual({ limit: 200, offset: 0 });
    expect(rpcCalls[1]).toEqual({ limit: 200, offset: 200 });
    expect(rpcCalls[2]).toEqual({ limit: 50, offset: 400 });

    expect(refreshResult.queue.length).toBe(450);
    expect(refreshResult.hasMore).toBe(true);
    expect(refreshResult.pendingTotal).toBe(600);
  });

  it('REQUIRED TEST E. 5,000 Safety Ceiling: stops at 5,000 when total queue is 6,000', async () => {
    const pool6000 = generatePassPool(6000);
    const { rpcCalls } = mockSupabaseRpc(pool6000);

    const loadAllResult = await fetchGuardDashboardWindow({
      desiredCount: 5000,
      safetyCeiling: 5000,
    });

    expect(loadAllResult.queue.length).toBe(5000);
    expect(loadAllResult.reachedSafetyCeiling).toBe(true);
    expect(loadAllResult.hasMore).toBe(true);
    expect(loadAllResult.pendingTotal).toBe(6000);
    expect(rpcCalls).toHaveLength(25); // 25 * 200 = 5000
    // Verify no single call exceeded 200
    for (const call of rpcCalls) {
      expect(call.limit).toBeLessThanOrEqual(200);
    }
  });

  it('REQUIRED TEST F. Deduplication & server offset progression: duplicates are merged but offset uses batch.queue.length', async () => {
    // Custom mock where page 1 has [P1, P2, P3] and page 2 has [P3, P4, P5]
    const p1 = { id: '00000000-0000-4000-8000-000000000001', visitorName: 'P1' };
    const p2 = { id: '00000000-0000-4000-8000-000000000002', visitorName: 'P2' };
    const p3 = { id: '00000000-0000-4000-8000-000000000003', visitorName: 'P3' };
    const p4 = { id: '00000000-0000-4000-8000-000000000004', visitorName: 'P4' };
    const p5 = { id: '00000000-0000-4000-8000-000000000005', visitorName: 'P5' };

    const rpcCalls: Array<{ limit: number; offset: number }> = [];
    const mockRpc = vi.fn(async (_fnName: string, params: { requested_limit: number; requested_offset: number }) => {
      rpcCalls.push({ limit: params.requested_limit, offset: params.requested_offset });
      if (params.requested_offset === 0) {
        return {
          data: {
            queue: [p1, p2, p3].map((item) => ({
              ...item,
              purpose: 'Business',
              source: 'portal',
              status: 'pending',
              validFrom: '2026-10-21T08:00:00Z',
              validUntil: '2026-10-21T17:00:00Z',
              scannedAt: '2026-10-21T09:00:00Z',
              gate: 'Gate 1',
              photoEvidenceId: '22222222-2222-4222-8222-222222222222',
              idEvidenceId: '33333333-3333-4333-8333-333333333333',
            })),
            stats: { inside: 0, exited: 0, rejected: 0, total: 0 },
            rejectionReasons: [],
            pendingTotal: 5,
            hasMore: true,
          },
          error: null,
        };
      } else {
        return {
          data: {
            queue: [p3, p4, p5].map((item) => ({
              ...item,
              purpose: 'Business',
              source: 'portal',
              status: 'pending',
              validFrom: '2026-10-21T08:00:00Z',
              validUntil: '2026-10-21T17:00:00Z',
              scannedAt: '2026-10-21T09:00:00Z',
              gate: 'Gate 1',
              photoEvidenceId: '22222222-2222-4222-8222-222222222222',
              idEvidenceId: '33333333-3333-4333-8333-333333333333',
            })),
            stats: { inside: 0, exited: 0, rejected: 0, total: 0 },
            rejectionReasons: [],
            pendingTotal: 5,
            hasMore: false,
          },
          error: null,
        };
      }
    });

    vi.spyOn(supabaseLib, 'requireSupabase').mockReturnValue({
      schema: vi.fn().mockReturnValue({
        rpc: mockRpc,
      }),
    } as any);

    const result = await fetchGuardDashboardWindow({
      desiredCount: 50,
      pageSize: 3,
    });

    // P3 was returned in both pages, so accumulated length is 5 distinct items (P1..P5)
    expect(result.queue.map((p) => p.id)).toEqual([
      p1.id,
      p2.id,
      p3.id,
      p4.id,
      p5.id,
    ]);
    expect(result.queue.length).toBe(5);

    // Server offset for second call was 3 (length of page 1), not deduplicated count
    expect(rpcCalls).toHaveLength(2);
    expect(rpcCalls[0].offset).toBe(0);
    expect(rpcCalls[1].offset).toBe(3);
  });

  it('REQUIRED TEST G. Stale refresh race protection: older in-flight refresh cannot overwrite newer Load All state', async () => {
    // Model the refresh generation fencing used in GuardPage
    let refreshGeneration = 0;
    let currentPasses: GuardQueuePass[] = [];

    let resolveRefreshA: (val: any) => void = () => {};
    const refreshAPromise = new Promise((resolve) => {
      resolveRefreshA = resolve;
    });

    // 1. Refresh A starts (e.g. 50 passes), delayed
    const genA = ++refreshGeneration;
    const startRefreshA = async () => {
      const data = await refreshAPromise;
      if (genA !== refreshGeneration) {
        return; // Fenced out!
      }
      currentPasses = data;
    };
    const promiseA = startRefreshA();

    // 2. User clicks Load All -> loads 450 passes
    const pool450 = generatePassPool(450);
    mockSupabaseRpc(pool450);
    const dashboard = await fetchGuardDashboardWindow({ desiredCount: 5000 });
    currentPasses = dashboard.queue;
    // Advance generation after Load All to fence out any in-flight refresh
    refreshGeneration += 1;

    expect(currentPasses.length).toBe(450);

    // 3. Refresh A resolves afterward with 50 passes
    const old50Passes = generatePassPool(50) as any[];
    resolveRefreshA(old50Passes);
    await promiseA;

    // Generation fencing successfully prevented stale 50-row result from overwriting 450 passes!
    expect(currentPasses.length).toBe(450);
    expect(currentPasses.length).not.toBe(50);
  });

  it('REQUIRED TEST H. Realtime / poll refresh after Load All maintains 450 passes in queue state', async () => {
    const pool450 = generatePassPool(450);
    const { rpcCalls } = mockSupabaseRpc(pool450);

    // Emulate GuardPage lifecycle
    let passes: GuardQueuePass[] = [];
    const passesLengthRef = { current: 50 };
    const refreshGenerationRef = { current: 0 };

    // Step 1: Initial load (starts at 50)
    let gen = ++refreshGenerationRef.current;
    let initialDashboard = await fetchGuardDashboardWindow({ desiredCount: Math.max(50, passesLengthRef.current) });
    if (gen === refreshGenerationRef.current) {
      passes = initialDashboard.queue;
      passesLengthRef.current = passes.length;
    }
    expect(passes.length).toBe(50);
    expect(passesLengthRef.current).toBe(50);

    // Step 2: User clicks Load All
    const loadAllDashboard = await fetchGuardDashboardWindow({ desiredCount: 5000, safetyCeiling: 5000 });
    passes = loadAllDashboard.queue;
    passesLengthRef.current = loadAllDashboard.queue.length;
    refreshGenerationRef.current += 1;
    expect(passes.length).toBe(450);
    expect(passesLengthRef.current).toBe(450);

    // Step 3: 5-second polling or Realtime event fires
    rpcCalls.length = 0;
    gen = ++refreshGenerationRef.current;
    const pollDashboard = await fetchGuardDashboardWindow({ desiredCount: Math.max(50, passesLengthRef.current) });
    if (gen === refreshGenerationRef.current) {
      passes = pollDashboard.queue;
      passesLengthRef.current = passes.length;
    }

    // 450 rows remain! Never collapsed back to 200 or 50!
    expect(rpcCalls).toHaveLength(3);
    expect(passes.length).toBe(450);
    expect(passes.length).not.toBe(200);
    expect(passes.length).not.toBe(50);
  });
});
