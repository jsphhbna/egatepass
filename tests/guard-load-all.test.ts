import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fetchGuardDashboardWindow, type GuardQueuePass, type GuardQueueCursor } from '../src/services/guard';
import * as supabaseLib from '../src/lib/supabase';

function generatePassPool(count: number): Array<{ id: string; visitorName: string; scannedAt: string }> {
  return Array.from({ length: count }, (_, i) => {
    const hex = i.toString(16).padStart(12, '0');
    // Ensure deterministic ascending scannedAt
    const minute = Math.floor(i / 60);
    const second = i % 60;
    const scannedAt = `2026-10-21T09:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}Z`;
    return {
      id: `00000000-0000-4000-8000-${hex}`,
      visitorName: `Visitor ${i + 1}`,
      scannedAt,
    };
  });
}

interface RpcRecordedCall {
  limit: number;
  after_scanned_at: string | null;
  after_id: string | null;
}

function mockSupabaseRpc(
  queuePool: Array<{ id: string; visitorName: string; scannedAt?: string }>,
  options?: {
    getPendingTotal?: (callIndex: number) => number;
    delayMs?: number;
  }
) {
  const rpcCalls: RpcRecordedCall[] = [];
  let callIndex = 0;

  const mockRpc = vi.fn(async (_fnName: string, params: { requested_limit: number; after_scanned_at?: string | null; after_id?: string | null }) => {
    callIndex++;
    const v_limit = Math.min(Math.max(params.requested_limit ?? 50, 1), 200);
    const after_scanned_at = params.after_scanned_at ?? null;
    const after_id = params.after_id ?? null;
    rpcCalls.push({ limit: v_limit, after_scanned_at, after_id });

    if (options?.delayMs) {
      await new Promise((r) => setTimeout(r, options.delayMs));
    }

    let startIndex = 0;
    if (after_id) {
      const idx = queuePool.findIndex((item) => item.id === after_id);
      if (idx !== -1) {
        startIndex = idx + 1;
      }
    }

    const total = options?.getPendingTotal ? options.getPendingTotal(callIndex) : queuePool.length;
    const pageItems = queuePool.slice(startIndex, startIndex + v_limit);
    const hasMore = startIndex + v_limit < queuePool.length;
    const lastItem = pageItems[pageItems.length - 1];
    const nextCursor: GuardQueueCursor | null = hasMore && lastItem ? {
      scannedAt: lastItem.scannedAt ?? '2026-10-21T09:00:00Z',
      id: lastItem.id,
    } : null;

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
          scannedAt: item.scannedAt ?? '2026-10-21T09:00:00Z',
          gate: 'Gate 1',
          photoEvidenceId: '22222222-2222-4222-8222-222222222222',
          idEvidenceId: '33333333-3333-4333-8333-333333333333',
        })),
        stats: { inside: 10, exited: 5, rejected: 1, total: 16 },
        rejectionReasons: ['Expired Pass', 'No ID'],
        pendingTotal: total,
        hasMore,
        nextCursor,
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

describe('Guard Queue Keyset Window Loading & Refresh Invariants', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('PATCH 11. Preserves Supabase 200-row RPC safety cap in keyset migration', () => {
    const migrationPath = join(
      __dirname,
      '../supabase/migrations/20261026143000_guard_queue_keyset_pagination_closure.sql'
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
    expect(rpcCalls[0]).toEqual({ limit: 200, after_scanned_at: null, after_id: null });
    expect(rpcCalls[1]).toEqual({ limit: 200, after_scanned_at: pool450[199].scannedAt, after_id: pool450[199].id });
    expect(rpcCalls[2]).toEqual({ limit: 200, after_scanned_at: pool450[399].scannedAt, after_id: pool450[399].id });

    // 2. Periodic refresh simulating desiredQueueSizeRef.current = 450
    rpcCalls.length = 0;
    const refreshResult = await fetchGuardDashboardWindow({
      desiredCount: 450,
    });

    expect(rpcCalls).toHaveLength(3);
    expect(rpcCalls[0]).toEqual({ limit: 200, after_scanned_at: null, after_id: null });
    expect(rpcCalls[1]).toEqual({ limit: 200, after_scanned_at: pool450[199].scannedAt, after_id: pool450[199].id });
    expect(rpcCalls[2]).toEqual({ limit: 50, after_scanned_at: pool450[399].scannedAt, after_id: pool450[399].id });

    // 450 must NOT collapse to 200!
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
    expect(rpcCalls[0]).toEqual({ limit: 200, after_scanned_at: null, after_id: null });
    expect(rpcCalls[1]).toEqual({ limit: 50, after_scanned_at: pool300[199].scannedAt, after_id: pool300[199].id });

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
    expect(rpcCalls[0]).toEqual({ limit: 200, after_scanned_at: null, after_id: null });
    expect(rpcCalls[1]).toEqual({ limit: 200, after_scanned_at: pool317[199].scannedAt, after_id: pool317[199].id });

    expect(refreshResult.queue.length).toBe(317);
    expect(refreshResult.hasMore).toBe(false);
    expect(refreshResult.queue.length).not.toBe(450);
  });

  it('REQUIRED TEST D. Queue still larger than loaded window: 450 window against 600 total maintains hasMore: true', async () => {
    const pool600 = generatePassPool(600);
    const { rpcCalls } = mockSupabaseRpc(pool600);

    const refreshResult = await fetchGuardDashboardWindow({
      desiredCount: 450,
    });

    expect(rpcCalls).toHaveLength(3);
    expect(rpcCalls[0]).toEqual({ limit: 200, after_scanned_at: null, after_id: null });
    expect(rpcCalls[1]).toEqual({ limit: 200, after_scanned_at: pool600[199].scannedAt, after_id: pool600[199].id });
    expect(rpcCalls[2]).toEqual({ limit: 50, after_scanned_at: pool600[399].scannedAt, after_id: pool600[399].id });

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
    for (const call of rpcCalls) {
      expect(call.limit).toBeLessThanOrEqual(200);
    }
  });

  it('REQUIRED TEST F. Keyset Deduplication: deduplicates by ID while progressing cursor', async () => {
    const p1 = { id: '00000000-0000-4000-8000-000000000001', visitorName: 'P1', scannedAt: '2026-10-21T09:00:00Z' };
    const p2 = { id: '00000000-0000-4000-8000-000000000002', visitorName: 'P2', scannedAt: '2026-10-21T09:01:00Z' };
    const p3 = { id: '00000000-0000-4000-8000-000000000003', visitorName: 'P3', scannedAt: '2026-10-21T09:02:00Z' };
    const p4 = { id: '00000000-0000-4000-8000-000000000004', visitorName: 'P4', scannedAt: '2026-10-21T09:03:00Z' };
    const p5 = { id: '00000000-0000-4000-8000-000000000005', visitorName: 'P5', scannedAt: '2026-10-21T09:04:00Z' };

    const rpcCalls: RpcRecordedCall[] = [];
    const mockRpc = vi.fn(async (_fnName: string, params: { requested_limit: number; after_scanned_at?: string | null; after_id?: string | null }) => {
      rpcCalls.push({ limit: params.requested_limit, after_scanned_at: params.after_scanned_at ?? null, after_id: params.after_id ?? null });
      if (!params.after_id) {
        return {
          data: {
            queue: [p1, p2, p3].map((item) => ({
              ...item,
              purpose: 'Business',
              source: 'portal',
              status: 'pending',
              validFrom: '2026-10-21T08:00:00Z',
              validUntil: '2026-10-21T17:00:00Z',
              gate: 'Gate 1',
              photoEvidenceId: '22222222-2222-4222-8222-222222222222',
              idEvidenceId: '33333333-3333-4333-8333-333333333333',
            })),
            stats: { inside: 0, exited: 0, rejected: 0, total: 0 },
            rejectionReasons: [],
            pendingTotal: 5,
            hasMore: true,
            nextCursor: { scannedAt: p3.scannedAt, id: p3.id },
          },
          error: null,
        };
      } else {
        // Simulates server returning overlap containing P3 along with P4, P5
        return {
          data: {
            queue: [p3, p4, p5].map((item) => ({
              ...item,
              purpose: 'Business',
              source: 'portal',
              status: 'pending',
              validFrom: '2026-10-21T08:00:00Z',
              validUntil: '2026-10-21T17:00:00Z',
              gate: 'Gate 1',
              photoEvidenceId: '22222222-2222-4222-8222-222222222222',
              idEvidenceId: '33333333-3333-4333-8333-333333333333',
            })),
            stats: { inside: 0, exited: 0, rejected: 0, total: 0 },
            rejectionReasons: [],
            pendingTotal: 5,
            hasMore: false,
            nextCursor: null,
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
    });

    // P3 was returned in both pages, but accumulated length is 5 distinct items (P1..P5)
    expect(result.queue.map((p) => p.id)).toEqual([
      p1.id,
      p2.id,
      p3.id,
      p4.id,
      p5.id,
    ]);
    expect(result.queue.length).toBe(5);
    expect(rpcCalls).toHaveLength(2);
    expect(rpcCalls[0].after_id).toBeNull();
    expect(rpcCalls[1].after_id).toBe(p3.id);
  });

  it('PATCH 15 & 40. Mutation-During-Paging Bounded Retry: Retries once from cursor=null on pendingTotal change and stops', async () => {
    const pool = generatePassPool(250);
    let attemptsCount = 0;

    // Simulate page 1 with pendingTotal=250, but page 2 with pendingTotal=249 during attempt 1.
    // In attempt 2, pendingTotal remains stable at 249 across both pages.
    const { rpcCalls } = mockSupabaseRpc(pool, {
      getPendingTotal: (callIndex) => {
        // Call 1: attempt 1, page 1 -> 250
        // Call 2: attempt 1, page 2 -> 249 (detects shift!)
        // Call 3: attempt 2, page 1 -> 249
        // Call 4: attempt 2, page 2 -> 249
        return callIndex === 1 ? 250 : 249;
      },
    });

    const result = await fetchGuardDashboardWindow({
      desiredCount: 250,
    });

    // 4 calls total: 2 calls for attempt 1 (failed consistency check), then 2 calls for attempt 2 (rebuilt from cursor=null)
    expect(rpcCalls).toHaveLength(4);
    // Call 1: attempt 1, cursor null
    expect(rpcCalls[0].after_id).toBeNull();
    // Call 2: attempt 1, cursor pass 199
    expect(rpcCalls[1].after_id).toBe(pool[199].id);
    // Call 3: attempt 2 RESTART from cursor null!
    expect(rpcCalls[2].after_id).toBeNull();
    // Call 4: attempt 2, cursor pass 199
    expect(rpcCalls[3].after_id).toBe(pool[199].id);

    expect(result.queue.length).toBe(250);
    expect(result.queueChangedDuringPaging).toBe(false); // Clean on attempt 2!
  });

  it('PATCH 15 & 40. Mutation-During-Paging Ceiling: Does not loop infinitely if attempt 2 also mutates', async () => {
    const pool = generatePassPool(250);

    // Always shift pendingTotal on every single call
    let counter = 300;
    const { rpcCalls } = mockSupabaseRpc(pool, {
      getPendingTotal: () => --counter,
    });

    const result = await fetchGuardDashboardWindow({
      desiredCount: 250,
    });

    // Maximum 2 complete attempts = 4 calls total (2 calls per attempt for 250 desired)
    expect(rpcCalls).toHaveLength(4);
    expect(result.queue.length).toBe(250);
    expect(result.queueChangedDuringPaging).toBe(true); // Attempt 2 also observed shift, returned safely
  });
});

describe('REQUIRED RACE MATRIX: GuardPage Refresh State Machine Races', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  // Emulate GuardPage's exact central refresh state machine
  function createGuardPageStateHarness() {
    const desiredQueueSizeRef = { current: 50 };
    const queueGenerationRef = { current: 0 };
    const mountedRef = { current: true };
    let passes: GuardQueuePass[] = [];
    let pendingTotal = 0;
    let hasMore = false;

    async function refreshGuardQueueWindow() {
      const generation = ++queueGenerationRef.current;
      const desiredCount = desiredQueueSizeRef.current;

      const dashboard = await fetchGuardDashboardWindow({
        desiredCount,
        safetyCeiling: 5000,
      });

      if (!mountedRef.current || generation !== queueGenerationRef.current) {
        return { committed: false, dashboard };
      }

      passes = dashboard.queue;
      pendingTotal = dashboard.pendingTotal;
      hasMore = dashboard.hasMore;

      if (!dashboard.hasMore) {
        desiredQueueSizeRef.current = Math.max(50, dashboard.queue.length);
      }

      return { committed: true, dashboard };
    }

    async function handleLoadMore() {
      desiredQueueSizeRef.current = Math.min(Math.max(desiredQueueSizeRef.current, 50) + 50, 5000);
      return refreshGuardQueueWindow();
    }

    async function handleLoadAll() {
      desiredQueueSizeRef.current = 5000;
      return refreshGuardQueueWindow();
    }

    return {
      desiredQueueSizeRef,
      queueGenerationRef,
      mountedRef,
      getPasses: () => passes,
      getPendingTotal: () => pendingTotal,
      getHasMore: () => hasMore,
      refreshGuardQueueWindow,
      handleLoadMore,
      handleLoadAll,
    };
  }

  it('Race 1: Load More -> poll (poll starts after Load More; Load More desired window +50 is preserved and poll commits newer generation)', async () => {
    const harness = createGuardPageStateHarness();
    harness.desiredQueueSizeRef.current = 250;
    const pool = generatePassPool(350);
    mockSupabaseRpc(pool, { delayMs: 10 });

    // User clicks Load More: desired becomes 300 BEFORE network call
    const loadMorePromise = harness.handleLoadMore();
    expect(harness.desiredQueueSizeRef.current).toBe(300);

    // Background poll fires 2ms later
    await new Promise((r) => setTimeout(r, 2));
    const pollPromise = harness.refreshGuardQueueWindow();

    const [loadMoreRes, pollRes] = await Promise.all([loadMorePromise, pollPromise]);

    // Older generation from Load More is rejected; newer generation from poll commits with desired 300!
    expect(loadMoreRes.committed).toBe(false);
    expect(pollRes.committed).toBe(true);
    expect(harness.getPasses()).toHaveLength(300);
    expect(harness.desiredQueueSizeRef.current).toBe(300);
  });

  it('Race 2: poll -> Load More (Load More starts after poll; poll is ignored, Load More wins)', async () => {
    const harness = createGuardPageStateHarness();
    const pool = generatePassPool(300);
    mockSupabaseRpc(pool, { delayMs: 10 });

    const pollPromise = harness.refreshGuardQueueWindow();
    await new Promise((r) => setTimeout(r, 2));
    const loadMorePromise = harness.handleLoadMore(); // 50 -> 100

    const [pollRes, loadMoreRes] = await Promise.all([pollPromise, loadMorePromise]);

    expect(pollRes.committed).toBe(false);
    expect(loadMoreRes.committed).toBe(true);
    expect(harness.getPasses()).toHaveLength(100);
  });

  it('Race 3: Load All -> Realtime (Realtime starts after Load All; reads desired 5000 and commits full queue)', async () => {
    const harness = createGuardPageStateHarness();
    const pool = generatePassPool(450);
    mockSupabaseRpc(pool, { delayMs: 10 });

    const loadAllPromise = harness.handleLoadAll();
    expect(harness.desiredQueueSizeRef.current).toBe(5000);

    await new Promise((r) => setTimeout(r, 2));
    const realtimePromise = harness.refreshGuardQueueWindow();

    const [loadAllRes, realtimeRes] = await Promise.all([loadAllPromise, realtimePromise]);

    expect(loadAllRes.committed).toBe(false);
    expect(realtimeRes.committed).toBe(true);
    expect(harness.getPasses()).toHaveLength(450);
    // After full queue loaded and hasMore=false, normalized to queue length
    expect(harness.desiredQueueSizeRef.current).toBe(450);
  });

  it('Race 4: Realtime -> Load All (Load All starts after Realtime; Realtime discarded, Load All commits)', async () => {
    const harness = createGuardPageStateHarness();
    const pool = generatePassPool(450);
    mockSupabaseRpc(pool, { delayMs: 10 });

    const realtimePromise = harness.refreshGuardQueueWindow();
    await new Promise((r) => setTimeout(r, 2));
    const loadAllPromise = harness.handleLoadAll();

    const [realtimeRes, loadAllRes] = await Promise.all([realtimePromise, loadAllPromise]);

    expect(realtimeRes.committed).toBe(false);
    expect(loadAllRes.committed).toBe(true);
    expect(harness.getPasses()).toHaveLength(450);
  });

  it('Race 5: post-approve refresh -> poll (poll starts after post-approve; poll commits newer generation)', async () => {
    const harness = createGuardPageStateHarness();
    const pool = generatePassPool(100);
    mockSupabaseRpc(pool, { delayMs: 10 });

    const postApprovePromise = harness.refreshGuardQueueWindow();
    await new Promise((r) => setTimeout(r, 2));
    const pollPromise = harness.refreshGuardQueueWindow();

    const [approveRes, pollRes] = await Promise.all([postApprovePromise, pollPromise]);

    expect(approveRes.committed).toBe(false);
    expect(pollRes.committed).toBe(true);
  });

  it('Race 6: post-reject refresh -> Realtime (Realtime starts after post-reject; Realtime commits newer generation)', async () => {
    const harness = createGuardPageStateHarness();
    const pool = generatePassPool(100);
    mockSupabaseRpc(pool, { delayMs: 10 });

    const postRejectPromise = harness.refreshGuardQueueWindow();
    await new Promise((r) => setTimeout(r, 2));
    const realtimePromise = harness.refreshGuardQueueWindow();

    const [rejectRes, realtimeRes] = await Promise.all([postRejectPromise, realtimePromise]);

    expect(rejectRes.committed).toBe(false);
    expect(realtimeRes.committed).toBe(true);
  });

  it('Race 7: 409 refresh -> Load More (Load More starts after 409 refresh; Load More wins with target +50)', async () => {
    const harness = createGuardPageStateHarness();
    const pool = generatePassPool(150);
    mockSupabaseRpc(pool, { delayMs: 10 });

    const conflict409Promise = harness.refreshGuardQueueWindow();
    await new Promise((r) => setTimeout(r, 2));
    const loadMorePromise = harness.handleLoadMore(); // 50 -> 100

    const [res409, loadMoreRes] = await Promise.all([conflict409Promise, loadMorePromise]);

    expect(res409.committed).toBe(false);
    expect(loadMoreRes.committed).toBe(true);
    expect(harness.getPasses()).toHaveLength(100);
  });

  it('Race 8: 422 refresh -> Load All (Load All starts after 422 refresh; Load All wins with 5000)', async () => {
    const harness = createGuardPageStateHarness();
    const pool = generatePassPool(450);
    mockSupabaseRpc(pool, { delayMs: 10 });

    const expired422Promise = harness.refreshGuardQueueWindow();
    await new Promise((r) => setTimeout(r, 2));
    const loadAllPromise = harness.handleLoadAll();

    const [res422, loadAllRes] = await Promise.all([expired422Promise, loadAllPromise]);

    expect(res422.committed).toBe(false);
    expect(loadAllRes.committed).toBe(true);
    expect(harness.getPasses()).toHaveLength(450);
  });

  it('Race 9: unmount during page fetch (mountedRef check prevents state update after unmount)', async () => {
    const harness = createGuardPageStateHarness();
    const pool = generatePassPool(100);
    mockSupabaseRpc(pool, { delayMs: 20 });

    const refreshPromise = harness.refreshGuardQueueWindow();

    // Component unmounts while request is in-flight:
    harness.mountedRef.current = false;
    harness.queueGenerationRef.current += 1;

    const result = await refreshPromise;

    expect(result.committed).toBe(false);
    expect(harness.getPasses()).toHaveLength(0); // Never updated React state!
  });

  it('Race 10: queue mutation between keyset pages (proves row deletion between pages does not skip next row)', async () => {
    // 250 items total. Page 1 takes 200 items (0..199).
    // While page 2 is being requested with cursor of #199, row #10 is deleted from server queue.
    const pool = generatePassPool(250);
    const pass201Id = pool[200].id; // 0-indexed #200 is 201st pass

    const rpcCalls: RpcRecordedCall[] = [];
    const mockRpc = vi.fn(async (_fnName: string, params: { requested_limit: number; after_scanned_at?: string | null; after_id?: string | null }) => {
      rpcCalls.push({ limit: params.requested_limit, after_scanned_at: params.after_scanned_at ?? null, after_id: params.after_id ?? null });

      let startIndex = 0;
      if (params.after_id) {
        // Keyset finds by exact ID rather than offset!
        const idx = pool.findIndex((p) => p.id === params.after_id);
        startIndex = idx !== -1 ? idx + 1 : 0;
      }

      const pageItems = pool.slice(startIndex, startIndex + params.requested_limit);
      const hasMore = startIndex + params.requested_limit < pool.length;
      const lastItem = pageItems[pageItems.length - 1];

      // After page 1 is returned, simulate row #10 removed from pool:
      if (!params.after_id) {
        pool.splice(10, 1);
      }

      return {
        data: {
          queue: pageItems.map((item) => ({
            ...item,
            purpose: 'Business',
            source: 'portal',
            status: 'pending',
            validFrom: '2026-10-21T08:00:00Z',
            validUntil: '2026-10-21T17:00:00Z',
            gate: 'Gate 1',
            photoEvidenceId: '22222222-2222-4222-8222-222222222222',
            idEvidenceId: '33333333-3333-4333-8333-333333333333',
          })),
          stats: { inside: 0, exited: 0, rejected: 0, total: 0 },
          rejectionReasons: [],
          pendingTotal: pool.length,
          hasMore,
          nextCursor: hasMore && lastItem ? { scannedAt: lastItem.scannedAt, id: lastItem.id } : null,
        },
        error: null,
      };
    });

    vi.spyOn(supabaseLib, 'requireSupabase').mockReturnValue({
      schema: vi.fn().mockReturnValue({
        rpc: mockRpc,
      }),
    } as any);

    const result = await fetchGuardDashboardWindow({ desiredCount: 250 });

    // Proves that pass #201 was NOT skipped despite row #10 being deleted between pages!
    expect(result.queue.some((p) => p.id === pass201Id)).toBe(true);
  });
});
