// @vitest-environment happy-dom
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React, { act, useState, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as guardService from '../src/services/guard';
import { fetchGuardDashboardWindow, type GuardQueuePass, type GuardQueueCursor } from '../src/services/guard';
import { useGuardQueue } from '../src/hooks/useGuardQueue';
import * as supabaseLib from '../src/lib/supabase';

function generatePassPool(count: number): Array<{ id: string; visitorName: string; scannedAt: string }> {
  return Array.from({ length: count }, (_, i) => {
    const hex = i.toString(16).padStart(12, '0');
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
  queue_snapshot_at: string | null;
}

function mockSupabaseRpc(
  queuePool: Array<{ id: string; visitorName: string; scannedAt?: string | null }>,
  options?: {
    getPendingTotal?: (callIndex: number) => number;
    getSnapshotPendingTotal?: (callIndex: number) => number;
    getSnapshotAt?: (callIndex: number, currentSnapshot: string | null) => string;
    delayMs?: number;
    customPayload?: (params: any, callIndex: number) => any;
  }
) {
  const rpcCalls: RpcRecordedCall[] = [];
  let callIndex = 0;

  const mockRpc = vi.fn(async (_fnName: string, params: {
    requested_limit: number;
    after_scanned_at?: string | null;
    after_id?: string | null;
    queue_snapshot_at?: string | null;
  }) => {
    callIndex++;
    const v_limit = Math.min(Math.max(params.requested_limit ?? 50, 1), 200);
    const after_scanned_at = params.after_scanned_at ?? null;
    const after_id = params.after_id ?? null;
    const queue_snapshot_at = params.queue_snapshot_at ?? null;
    rpcCalls.push({ limit: v_limit, after_scanned_at, after_id, queue_snapshot_at });

    if (options?.delayMs) {
      await new Promise((r) => setTimeout(r, options.delayMs));
    }

    if (options?.customPayload) {
      const custom = options.customPayload(params, callIndex);
      if (custom) return custom;
    }

    let startIndex = 0;
    if (after_id) {
      const idx = queuePool.findIndex((item) => item.id === after_id);
      if (idx !== -1) {
        startIndex = idx + 1;
      }
    }

    const total = options?.getPendingTotal ? options.getPendingTotal(callIndex) : queuePool.length;
    const snapshotPendingTotal = options?.getSnapshotPendingTotal
      ? options.getSnapshotPendingTotal(callIndex)
      : total;
    const snapshotAt = options?.getSnapshotAt
      ? options.getSnapshotAt(callIndex, queue_snapshot_at)
      : (queue_snapshot_at ?? '2026-10-21T09:00:00.000000Z');

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
        snapshotPendingTotal,
        snapshotAt,
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

function renderGuardQueueHook(options?: { onNewPendingPass?: () => void }) {
  let result = { current: undefined as unknown as ReturnType<typeof useGuardQueue> };
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  function TestComponent() {
    // Deliberately construct a brand-new options object and callback on every render to ensure
    // production hook is immune to inline object recreations:
    const inlineOptions = {
      onNewPendingPass: options?.onNewPendingPass ?? (() => {}),
    };
    result.current = useGuardQueue(inlineOptions);
    return null;
  }

  act(() => {
    root.render(React.createElement(TestComponent));
  });

  return {
    result,
    unmount: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

describe('Guard Queue Keyset Window Loading & Refresh Invariants', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('PATCH 11. Preserves Supabase 200-row RPC safety cap in keyset migration', () => {
    const migrationPath = join(
      __dirname,
      '../supabase/migrations/20261026153000_guard_queue_snapshot_consistency_closure.sql'
    );
    const migrationContent = readFileSync(migrationPath, 'utf-8');
    expect(migrationContent).toContain(
      'v_limit integer := least(greatest(coalesce(requested_limit, 50), 1), 200);'
    );
  });

  it('REQUIRED TEST A. 450 Load All then refresh: preserves 450 depth across refresh without collapsing to 200', async () => {
    const pool450 = generatePassPool(450);
    const { rpcCalls } = mockSupabaseRpc(pool450);

    const loadAllResult = await fetchGuardDashboardWindow({
      desiredCount: 5000,
      safetyCeiling: 5000,
    });

    expect(loadAllResult.queue.length).toBe(450);
    expect(loadAllResult.hasMore).toBe(false);
    expect(loadAllResult.reachedSafetyCeiling).toBe(false);
    expect(rpcCalls).toHaveLength(3);
    expect(rpcCalls[0]).toEqual({ limit: 200, after_scanned_at: null, after_id: null, queue_snapshot_at: null });
    expect(rpcCalls[1]).toEqual({ limit: 200, after_scanned_at: pool450[199].scannedAt, after_id: pool450[199].id, queue_snapshot_at: '2026-10-21T09:00:00.000000Z' });
    expect(rpcCalls[2]).toEqual({ limit: 200, after_scanned_at: pool450[399].scannedAt, after_id: pool450[399].id, queue_snapshot_at: '2026-10-21T09:00:00.000000Z' });

    rpcCalls.length = 0;
    const refreshResult = await fetchGuardDashboardWindow({
      desiredCount: 450,
    });

    expect(rpcCalls).toHaveLength(3);
    expect(refreshResult.queue.length).toBe(450);
    expect(refreshResult.queue.length).not.toBe(200);
    expect(refreshResult.hasMore).toBe(false);
  });

  it('REQUIRED TEST B. Shrink behavior: when queue shrinks below previous target, normalizes target', async () => {
    const pool317 = generatePassPool(317);
    const { rpcCalls } = mockSupabaseRpc(pool317);

    const result = await fetchGuardDashboardWindow({
      desiredCount: 450,
    });

    expect(result.queue.length).toBe(317);
    expect(result.hasMore).toBe(false);
    expect(rpcCalls).toHaveLength(2);
  });

  it('REQUIRED TEST C. Growth behavior: when queue grows beyond 250, preserves target 250 with hasMore=true', async () => {
    const pool600 = generatePassPool(600);
    const { rpcCalls } = mockSupabaseRpc(pool600);

    const result = await fetchGuardDashboardWindow({
      desiredCount: 250,
    });

    expect(result.queue.length).toBe(250);
    expect(result.hasMore).toBe(true);
    expect(rpcCalls).toHaveLength(2);
    expect(rpcCalls[0].limit).toBe(200);
    expect(rpcCalls[1].limit).toBe(50);
  });

  it('REQUIRED TEST D. 5,000 Safety Ceiling: 6,000 pending items capped at 5,000 with reachedSafetyCeiling=true', async () => {
    const pool6000 = generatePassPool(5100);
    const { rpcCalls } = mockSupabaseRpc(pool6000);

    const result = await fetchGuardDashboardWindow({
      desiredCount: 6000,
      safetyCeiling: 5000,
    });

    expect(result.queue.length).toBe(5000);
    expect(result.reachedSafetyCeiling).toBe(true);
    expect(result.hasMore).toBe(true);
    expect(rpcCalls).toHaveLength(25);
  });

  it('REQUIRED TEST E. Exact boundary: 200 items loads in exactly 1 call with hasMore=false', async () => {
    const pool200 = generatePassPool(200);
    const { rpcCalls } = mockSupabaseRpc(pool200);

    const result = await fetchGuardDashboardWindow({
      desiredCount: 200,
    });

    expect(result.queue.length).toBe(200);
    expect(result.hasMore).toBe(false);
    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0].limit).toBe(200);
  });

  it('PATCH 14. pageSize is honored: pageSize=3 queries RPC in 3-row pages', async () => {
    const pool = generatePassPool(6);
    const { rpcCalls } = mockSupabaseRpc(pool);

    const result = await fetchGuardDashboardWindow({
      desiredCount: 50,
      pageSize: 3,
    });

    expect(result.queue.length).toBe(6);
    expect(rpcCalls).toHaveLength(2);
    expect(rpcCalls[0].limit).toBe(3);
    expect(rpcCalls[1].limit).toBe(3);
  });

  it('PATCH 15. Snapshot pinning contract: throws if snapshotAt changes across pages in one traversal', async () => {
    const pool = generatePassPool(300);
    mockSupabaseRpc(pool, {
      getSnapshotAt: (callIndex) => callIndex === 1 ? '2026-10-21T09:00:00.000000Z' : '2026-10-21T09:01:00.000000Z',
    });

    await expect(fetchGuardDashboardWindow({ desiredCount: 250 })).rejects.toThrow(
      /guard_dashboard_page contract violation: snapshotAt mismatch during traversal/
    );
  });

  it('PATCH 16 & 39. Equal-Count Mutation Bounded Retry: Retries once from cursor=null on snapshotPendingTotal shift', async () => {
    // 250 items initially. During attempt 1, row deleted so 249 items.
    const pool = generatePassPool(249);
    const { rpcCalls } = mockSupabaseRpc(pool, {
      getSnapshotPendingTotal: (callIndex) => {
        // Call 1: attempt 1, page 1 -> 250
        // Call 2: attempt 1, page 2 -> 249 (mutation detected!)
        // Call 3: attempt 2, page 1 -> 249
        // Call 4: attempt 2, page 2 -> 249
        return callIndex === 1 ? 250 : 249;
      },
    });

    const result = await fetchGuardDashboardWindow({
      desiredCount: 250,
    });

    expect(rpcCalls).toHaveLength(4);
    expect(rpcCalls[0].after_id).toBeNull();
    expect(rpcCalls[1].after_id).toBe(pool[199].id);
    expect(rpcCalls[2].after_id).toBeNull(); // Restart attempt 2 from null cursor!
    expect(rpcCalls[3].after_id).toBe(pool[199].id);
    expect(result.queueChangedDuringPaging).toBe(false);
  });

  it('PATCH 17. Final snapshot count mismatch triggers bounded retry when hasMore=false', async () => {
    const pool = generatePassPool(150);
    let attempt = 0;
    const { rpcCalls } = mockSupabaseRpc(pool, {
      getSnapshotPendingTotal: () => {
        attempt++;
        // Attempt 1 says snapshotPendingTotal is 151, but only 150 items returned
        return attempt === 1 ? 151 : 150;
      },
    });

    const result = await fetchGuardDashboardWindow({ desiredCount: 200 });

    expect(rpcCalls).toHaveLength(2); // 1 call for attempt 1, restarted for attempt 2
    expect(result.queue.length).toBe(150);
  });

  it('PATCH 18. Mutation-During-Paging Ceiling: Does not loop infinitely if attempt 2 also mutates', async () => {
    const pool = generatePassPool(250);
    let counter = 300;
    const { rpcCalls } = mockSupabaseRpc(pool, {
      getSnapshotPendingTotal: () => --counter,
    });

    const result = await fetchGuardDashboardWindow({
      desiredCount: 250,
    });

    expect(rpcCalls).toHaveLength(4); // Capped at exactly 2 complete attempts
    expect(result.queueChangedDuringPaging).toBe(true);
  });

  it('PATCH 19 & 50. Progress guards: throws on non-progressing nextCursor', async () => {
    const pool = generatePassPool(20);
    mockSupabaseRpc(pool, {
      customPayload: () => ({
        data: {
          queue: [{
            id: '11111111-1111-4111-8111-111111111111',
            visitorName: 'V1',
            purpose: 'Test',
            source: 'portal',
            status: 'pending',
            validFrom: '2026-10-21T08:00:00Z',
            validUntil: '2026-10-21T17:00:00Z',
            scannedAt: '2026-10-21T09:00:00Z',
            gate: 'Gate 1',
            photoEvidenceId: '22222222-2222-4222-8222-222222222222',
            idEvidenceId: null,
          }],
          stats: { inside: 0, exited: 0, rejected: 0, total: 0 },
          rejectionReasons: [],
          pendingTotal: 10,
          snapshotPendingTotal: 10,
          snapshotAt: '2026-10-21T09:00:00.000000Z',
          hasMore: true,
          nextCursor: {
            scannedAt: '2026-10-21T09:00:00Z',
            id: '11111111-1111-4111-8111-111111111111',
          },
        },
        error: null,
      }),
    });

    await expect(fetchGuardDashboardWindow({ desiredCount: 10, pageSize: 1 })).rejects.toThrow(
      /guard_dashboard_page contract violation: nextCursor did not progress/
    );
  });

  it('PATCH 19 & 50. Progress guards: throws on hasMore=true with empty queue', async () => {
    const pool = generatePassPool(20);
    mockSupabaseRpc(pool, {
      customPayload: () => ({
        data: {
          queue: [],
          stats: { inside: 0, exited: 0, rejected: 0, total: 0 },
          rejectionReasons: [],
          pendingTotal: 10,
          snapshotPendingTotal: 10,
          snapshotAt: '2026-10-21T09:00:00.000000Z',
          hasMore: true,
          nextCursor: { scannedAt: '2026-10-21T09:00:00Z', id: '11111111-1111-4111-8111-111111111111' },
        },
        error: null,
      }),
    });

    await expect(fetchGuardDashboardWindow({ desiredCount: 10 })).rejects.toThrow(
      /guard_dashboard_page contract violation: hasMore with empty queue/
    );
  });
});

describe('useGuardQueue Hook: Stale-Closure, Controller Identity & Lifecycle Tests', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('REQUIRED TEST 1. Inline options must not change controller identity across renders', () => {
    let capturedController1: any = null;
    let capturedController2: any = null;
    let forceRerender: (() => void) | null = null;

    function TestComponent() {
      const [, setTick] = useState(0);
      forceRerender = () => setTick((t) => t + 1);

      // Deliberately inline new callback every render!
      const controller = useGuardQueue({
        onNewPendingPass: () => {},
      });

      if (!capturedController1) {
        capturedController1 = controller.requestGuardQueueRefresh;
      } else {
        capturedController2 = controller.requestGuardQueueRefresh;
      }
      return null;
    }

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    act(() => {
      root.render(React.createElement(TestComponent));
    });

    expect(capturedController1).not.toBeNull();

    // Force unrelated render with newly instantiated options object
    act(() => {
      forceRerender?.();
    });

    expect(capturedController2).not.toBeNull();
    // Invariant: Controller identity must remain strictly identical
    expect(Object.is(capturedController1, capturedController2)).toBe(true);

    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('REQUIRED TEST 2. GuardPage effect does not loop: exactly 1 initial refresh, and exactly 1 poll after 5s', async () => {
    vi.useFakeTimers();
    const pool = generatePassPool(5);
    const mockState = mockSupabaseRpc(pool);

    let subscribeCallCount = 0;
    vi.spyOn(guardService, 'subscribeToPassChanges').mockImplementation(() => {
      subscribeCallCount++;
      return () => {};
    });

    // Harness matching GuardPage effect and inline options
    function GuardHarness() {
      const { requestGuardQueueRefresh, queueIntentEpochRef, refreshQueuedRef } = useGuardQueue({
        onNewPendingPass: () => {},
      });

      useEffect(() => {
        void requestGuardQueueRefresh();
        const stopRealtime = guardService.subscribeToPassChanges(() => {
          queueIntentEpochRef.current += 1;
          refreshQueuedRef.current = true;
          void requestGuardQueueRefresh({ showRefreshing: true });
        });
        const poll = window.setInterval(() => {
          refreshQueuedRef.current = true;
          void requestGuardQueueRefresh({ showRefreshing: true });
        }, 5000);
        return () => {
          stopRealtime();
          window.clearInterval(poll);
        };
      }, [requestGuardQueueRefresh]);

      return null;
    }

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(React.createElement(GuardHarness));
    });

    // Wait beyond React commit & microtasks, but < 5000ms
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });

    // Invariant: exactly 1 RPC call on initial load! (NO render-loop extra refreshes)
    expect(mockState.rpcCalls).toHaveLength(1);

    // Now advance timer by 5000ms to trigger scheduled poll
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });

    // Exactly 2 total RPC calls (1 initial + 1 scheduled poll)!
    expect(mockState.rpcCalls).toHaveLength(2);

    act(() => {
      root.unmount();
    });
    container.remove();
    vi.useRealTimers();
  });

  it('REQUIRED TEST 3. Unrelated component render does not trigger extra queue refreshes or subscription churn', async () => {
    const pool = generatePassPool(5);
    const mockState = mockSupabaseRpc(pool);

    let subscribeCallCount = 0;
    vi.spyOn(guardService, 'subscribeToPassChanges').mockImplementation(() => {
      subscribeCallCount++;
      return () => {};
    });

    let setSearch: ((v: string) => void) | null = null;

    function SearchHarness() {
      const [search, setLocalSearch] = useState('');
      setSearch = setLocalSearch;

      const { requestGuardQueueRefresh, queueIntentEpochRef, refreshQueuedRef } = useGuardQueue({
        onNewPendingPass: () => {},
      });

      useEffect(() => {
        void requestGuardQueueRefresh();
        const stopRealtime = guardService.subscribeToPassChanges(() => {
          queueIntentEpochRef.current += 1;
          refreshQueuedRef.current = true;
          void requestGuardQueueRefresh({ showRefreshing: true });
        });
        const poll = window.setInterval(() => {
          refreshQueuedRef.current = true;
          void requestGuardQueueRefresh({ showRefreshing: true });
        }, 5000);
        return () => {
          stopRealtime();
          window.clearInterval(poll);
        };
      }, [requestGuardQueueRefresh]);

      return null;
    }

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(React.createElement(SearchHarness));
    });

    expect(mockState.rpcCalls).toHaveLength(1);
    expect(subscribeCallCount).toBe(1);

    // User types search term triggering re-render
    await act(async () => {
      setSearch?.('visitor');
    });

    // Zero extra queue refreshes or subscription churn!
    expect(mockState.rpcCalls).toHaveLength(1);
    expect(subscribeCallCount).toBe(1);

    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('REQUIRED TEST 4. Latest callback ref is invoked when pendingTotal increases without changing controller identity', async () => {
    const pool5 = generatePassPool(5);
    const pool10 = generatePassPool(10);
    let activePool = pool5;

    mockSupabaseRpc(pool5, {
      customPayload: () => {
        return {
          data: {
            queue: activePool.map((p) => ({
              id: p.id,
              visitorName: p.visitorName,
              purpose: 'Official Business',
              source: 'portal',
              status: 'pending',
              validFrom: '2026-10-21T08:00:00Z',
              validUntil: '2026-10-21T17:00:00Z',
              scannedAt: p.scannedAt,
              gate: 'Gate 1',
              photoEvidenceId: '22222222-2222-4222-8222-222222222222',
              idEvidenceId: null,
            })),
            stats: { inside: 0, exited: 0, rejected: 0, total: 0 },
            rejectionReasons: [],
            pendingTotal: activePool.length,
            snapshotPendingTotal: activePool.length,
            snapshotAt: '2026-10-21T09:00:00.000000Z',
            hasMore: false,
            nextCursor: null,
          },
          error: null,
        };
      },
    });

    const callback1 = vi.fn();
    const callback2 = vi.fn();
    let setCb: ((cb: () => void) => void) | null = null;
    let hookResult: any = null;

    function CallbackHarness() {
      const [currentCb, setCurrentCb] = useState<() => void>(() => callback1);
      setCb = (cb) => setCurrentCb(() => cb);

      hookResult = useGuardQueue({
        onNewPendingPass: currentCb,
      });
      return null;
    }

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(React.createElement(CallbackHarness));
    });

    const controllerBefore = hookResult.requestGuardQueueRefresh;

    // Initial load: 5 passes
    await act(async () => {
      await hookResult.requestGuardQueueRefresh();
    });

    expect(callback1).toHaveBeenCalledTimes(1);
    expect(callback2).not.toHaveBeenCalled();

    // Update to callback2
    act(() => {
      setCb?.(callback2);
    });

    // Controller identity MUST remain identical
    expect(Object.is(controllerBefore, hookResult.requestGuardQueueRefresh)).toBe(true);

    // New pending passes arrive: pendingTotal increases from 5 to 10
    activePool = pool10;

    await act(async () => {
      await hookResult.requestGuardQueueRefresh();
    });

    // Latest callback was executed! Old callback was NOT called again.
    expect(callback1).toHaveBeenCalledTimes(1);
    expect(callback2).toHaveBeenCalledTimes(1);

    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('REQUIRED TEST 5. Initial load invalidated by Realtime: initialLoading remains true while replacement runs, no false empty-state', async () => {
    let rpcCallCount = 0;
    let resolveRpc1: ((value: any) => void) | null = null;
    let resolveRpc2: ((value: any) => void) | null = null;
    const pool = generatePassPool(5);

    vi.spyOn(supabaseLib, 'requireSupabase').mockReturnValue({
      schema: vi.fn().mockReturnValue({
        rpc: vi.fn(async () => {
          rpcCallCount++;
          if (rpcCallCount === 1) {
            // Pause RPC 1
            return new Promise((resolve) => {
              resolveRpc1 = () =>
                resolve({
                  data: {
                    queue: pool.map((p) => ({
                      ...p,
                      status: 'pending',
                      purpose: 'Official Business',
                      source: 'portal',
                      validFrom: '2026-10-21T08:00:00Z',
                      validUntil: '2026-10-21T17:00:00Z',
                      gate: 'Gate 1',
                      photoEvidenceId: '22222222-2222-4222-8222-222222222222',
                      idEvidenceId: null,
                    })),
                    stats: { inside: 0, exited: 0, rejected: 0, total: 0 },
                    rejectionReasons: [],
                    pendingTotal: pool.length,
                    snapshotPendingTotal: pool.length,
                    snapshotAt: '2026-10-21T09:00:00.000000Z',
                    hasMore: false,
                    nextCursor: null,
                  },
                  error: null,
                });
            });
          }
          // RPC 2 (replacement) - also paused so we can assert intermediate in-flight state
          return new Promise((resolve) => {
            resolveRpc2 = () =>
              resolve({
                data: {
                  queue: pool.map((p) => ({
                    ...p,
                    status: 'pending',
                    purpose: 'Official Business',
                    source: 'portal',
                    validFrom: '2026-10-21T08:00:00Z',
                    validUntil: '2026-10-21T17:00:00Z',
                    gate: 'Gate 1',
                    photoEvidenceId: '22222222-2222-4222-8222-222222222222',
                    idEvidenceId: null,
                  })),
                  stats: { inside: 0, exited: 0, rejected: 0, total: 0 },
                  rejectionReasons: [],
                  pendingTotal: pool.length,
                  snapshotPendingTotal: pool.length,
                  snapshotAt: '2026-10-21T09:00:00.000000Z',
                  hasMore: false,
                  nextCursor: null,
                },
                error: null,
              });
          });
        }),
      }),
    } as any);

    let hookResult: any = null;
    function TestHarness() {
      hookResult = useGuardQueue({ onNewPendingPass: () => {} });
      return null;
    }

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    act(() => {
      root.render(React.createElement(TestHarness));
    });

    expect(hookResult.initialLoading).toBe(true);

    // 1. Initial traversal begins
    let p1: Promise<any>;
    act(() => {
      p1 = hookResult.requestGuardQueueRefresh();
    });

    // 2. Realtime event occurs while traversal 1 is in-flight: epoch increments
    act(() => {
      hookResult.queueIntentEpochRef.current += 1;
      hookResult.refreshQueuedRef.current = true;
      hookResult.requestGuardQueueRefresh();
    });

    // 3. Resolve traversal 1 (it is now obsolete)
    await act(async () => {
      resolveRpc1?.(null);
      await Promise.resolve();
    });

    // While replacement traversal is in-flight: initialLoading MUST REMAIN TRUE!
    expect(hookResult.initialLoading).toBe(true);
    expect(hookResult.queueError).toBe(false);

    // 4. Resolve replacement traversal
    await act(async () => {
      resolveRpc2?.(null);
      await Promise.resolve();
    });

    // 5. Await complete resolution of refresh
    await act(async () => {
      await p1;
    });

    // Replacement traversal completed and committed!
    expect(hookResult.initialLoading).toBe(false);
    expect(hookResult.queueError).toBe(false);
    expect(hookResult.passes).toHaveLength(5);

    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('REQUIRED TEST 6. Obsolete initial failure: obsolete failure does not show Queue unavailable if newer refresh queued', async () => {
    let rpcCallCount = 0;
    let rejectRpc1: ((err: any) => void) | null = null;
    let resolveRpc2: ((value: any) => void) | null = null;
    const pool = generatePassPool(5);

    vi.spyOn(supabaseLib, 'requireSupabase').mockReturnValue({
      schema: vi.fn().mockReturnValue({
        rpc: vi.fn(async () => {
          rpcCallCount++;
          if (rpcCallCount === 1) {
            // Traversal 1 fails after delay
            return new Promise((_, reject) => {
              rejectRpc1 = () => reject(new Error('Flaky initial connection'));
            });
          }
          // Traversal 2 (replacement) succeeds
          return new Promise((resolve) => {
            resolveRpc2 = () =>
              resolve({
                data: {
                  queue: pool.map((p) => ({
                    ...p,
                    status: 'pending',
                    purpose: 'Official Business',
                    source: 'portal',
                    validFrom: '2026-10-21T08:00:00Z',
                    validUntil: '2026-10-21T17:00:00Z',
                    gate: 'Gate 1',
                    photoEvidenceId: '22222222-2222-4222-8222-222222222222',
                    idEvidenceId: null,
                  })),
                  stats: { inside: 0, exited: 0, rejected: 0, total: 0 },
                  rejectionReasons: [],
                  pendingTotal: pool.length,
                  snapshotPendingTotal: pool.length,
                  snapshotAt: '2026-10-21T09:00:00.000000Z',
                  hasMore: false,
                  nextCursor: null,
                },
                error: null,
              });
          });
        }),
      }),
    } as any);

    let hookResult: any = null;
    function TestHarness() {
      hookResult = useGuardQueue({ onNewPendingPass: () => {} });
      return null;
    }

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    act(() => {
      root.render(React.createElement(TestHarness));
    });

    // 1. Initial traversal begins
    let p1: Promise<any>;
    act(() => {
      p1 = hookResult.requestGuardQueueRefresh();
    });

    // 2. Realtime queues newer intent before traversal 1 rejects
    act(() => {
      hookResult.queueIntentEpochRef.current += 1;
      hookResult.refreshQueuedRef.current = true;
      hookResult.requestGuardQueueRefresh();
    });

    // 3. Traversal 1 rejects
    await act(async () => {
      rejectRpc1?.(null);
      await Promise.resolve();
    });

    // Obsolete failure does NOT surface Queue unavailable while replacement is in flight!
    expect(hookResult.queueError).toBe(false);
    expect(hookResult.initialLoading).toBe(true);

    // 4. Resolve replacement traversal
    await act(async () => {
      resolveRpc2?.(null);
      await Promise.resolve();
    });

    // 5. Await replacement
    await act(async () => {
      await p1;
    });

    expect(hookResult.initialLoading).toBe(false);
    expect(hookResult.queueError).toBe(false);
    expect(hookResult.refreshError).toBe(false);
    expect(hookResult.passes).toHaveLength(5);

    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('REQUIRED TEST 7 & PATCH 37. True initial failure: first queue request fails with no replacement -> initialLoading=false, queueError=true, refreshError=false', async () => {
    vi.spyOn(supabaseLib, 'requireSupabase').mockReturnValue({
      schema: vi.fn().mockReturnValue({
        rpc: vi.fn().mockResolvedValue({
          data: null,
          error: new Error('Network error on initial load'),
        }),
      }),
    } as any);

    const { result, unmount } = renderGuardQueueHook();

    await act(async () => {
      await result.current.requestGuardQueueRefresh();
    });

    expect(result.current.initialLoading).toBe(false);
    expect(result.current.queueError).toBe(true);
    expect(result.current.refreshError).toBe(false);
    expect(result.current.passes).toHaveLength(0);

    unmount();
  });

  it('REQUIRED TEST 8 & PATCH 36. Background failure: initial load succeeds, subsequent refresh fails -> preserves queue, queueError=false, refreshError=true', async () => {
    const pool = generatePassPool(5);
    const mockState = mockSupabaseRpc(pool);

    const { result, unmount } = renderGuardQueueHook();

    // 1. Initial load succeeds
    await act(async () => {
      await result.current.requestGuardQueueRefresh();
    });

    expect(result.current.initialLoading).toBe(false);
    expect(result.current.queueError).toBe(false);
    expect(result.current.refreshError).toBe(false);
    expect(result.current.passes).toHaveLength(5);

    // 2. Later refresh fails (e.g. background poll or connection delayed)
    mockState.mockRpc.mockRejectedValueOnce(new Error('Connection delayed'));

    await act(async () => {
      await result.current.requestGuardQueueRefresh({ showRefreshing: true });
    });

    // Existing queue remains intact!
    expect(result.current.passes).toHaveLength(5);
    expect(result.current.queueError).toBe(false);
    expect(result.current.refreshError).toBe(true);
    expect(result.current.initialLoading).toBe(false);

    unmount();
  });

  it('REQUIRED TEST 9 & PATCH 44. Coalescing still works: bursts coalesce to exactly 1 in-flight and 1 queued follow-up', async () => {
    let simultaneousCalls = 0;
    let maxSimultaneousCalls = 0;
    let totalCalls = 0;

    const pool = generatePassPool(10);
    vi.spyOn(supabaseLib, 'requireSupabase').mockReturnValue({
      schema: vi.fn().mockReturnValue({
        rpc: vi.fn(async () => {
          simultaneousCalls++;
          totalCalls++;
          maxSimultaneousCalls = Math.max(maxSimultaneousCalls, simultaneousCalls);
          await new Promise((r) => setTimeout(r, 20));
          simultaneousCalls--;

          return {
            data: {
              queue: pool.map((p) => ({
                id: p.id,
                visitorName: p.visitorName,
                purpose: 'Official Business',
                source: 'portal',
                status: 'pending',
                validFrom: '2026-10-21T08:00:00Z',
                validUntil: '2026-10-21T17:00:00Z',
                scannedAt: p.scannedAt,
                gate: 'Gate 1',
                photoEvidenceId: '22222222-2222-4222-8222-222222222222',
                idEvidenceId: null,
              })),
              stats: { inside: 0, exited: 0, rejected: 0, total: 0 },
              rejectionReasons: [],
              pendingTotal: pool.length,
              snapshotPendingTotal: pool.length,
              snapshotAt: '2026-10-21T09:00:00.000000Z',
              hasMore: false,
              nextCursor: null,
            },
            error: null,
          };
        }),
      }),
    } as any);

    const { result, unmount } = renderGuardQueueHook();

    await act(async () => {
      // Launch initial refresh
      const p1 = result.current.requestGuardQueueRefresh();

      // While p1 is in-flight, burst poll and Realtime requests
      result.current.refreshQueuedRef.current = true;
      const p2 = result.current.requestGuardQueueRefresh();
      result.current.refreshQueuedRef.current = true;
      const p3 = result.current.requestGuardQueueRefresh();
      result.current.queueIntentEpochRef.current += 1;
      result.current.refreshQueuedRef.current = true;
      const p4 = result.current.requestGuardQueueRefresh();

      await Promise.all([p1, p2, p3, p4]);
    });

    // Invariant: Maximum concurrent fetchGuardDashboardWindow calls = 1!
    expect(maxSimultaneousCalls).toBe(1);
    // Total calls was exactly 2 (initial traversal + 1 coalesced follow-up)
    expect(totalCalls).toBe(2);

    unmount();
  });

  it('REQUIRED TEST 10. Subscription count: exactly 1 Realtime subscription and 1 poll interval active across multiple commits/rerenders', async () => {
    let subscribeCount = 0;
    let unsubscribeCount = 0;
    vi.spyOn(guardService, 'subscribeToPassChanges').mockImplementation(() => {
      subscribeCount++;
      return () => {
        unsubscribeCount++;
      };
    });

    const originalSetInterval = window.setInterval;
    const originalClearInterval = window.clearInterval;
    let intervalsStarted = 0;
    let intervalsCleared = 0;

    window.setInterval = vi.fn((fn, ms) => {
      intervalsStarted++;
      return originalSetInterval(fn, ms);
    }) as any;

    window.clearInterval = vi.fn((id) => {
      intervalsCleared++;
      return originalClearInterval(id);
    }) as any;

    const pool = generatePassPool(5);
    mockSupabaseRpc(pool);

    function FullGuardHarness() {
      const [, setTick] = useState(0);
      const { requestGuardQueueRefresh, queueIntentEpochRef, refreshQueuedRef } = useGuardQueue({
        onNewPendingPass: () => {},
      });

      useEffect(() => {
        void requestGuardQueueRefresh();
        const stopRealtime = guardService.subscribeToPassChanges(() => {
          queueIntentEpochRef.current += 1;
          refreshQueuedRef.current = true;
          void requestGuardQueueRefresh({ showRefreshing: true });
        });
        const poll = window.setInterval(() => {
          refreshQueuedRef.current = true;
          void requestGuardQueueRefresh({ showRefreshing: true });
        }, 5000);
        return () => {
          stopRealtime();
          window.clearInterval(poll);
        };
      }, [requestGuardQueueRefresh]);

      return React.createElement(
        'button',
        { onClick: () => setTick((t) => t + 1) },
        'Rerender'
      );
    }

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(React.createElement(FullGuardHarness));
    });

    // Trigger multiple parent / state re-renders
    const button = container.querySelector('button');
    await act(async () => {
      button?.click();
      button?.click();
      button?.click();
    });

    // Invariant: active subscriptions = 1, active intervals = 1
    expect(subscribeCount - unsubscribeCount).toBe(1);
    expect(intervalsStarted - intervalsCleared).toBe(1);

    act(() => {
      root.unmount();
    });
    container.remove();

    expect(subscribeCount - unsubscribeCount).toBe(0);
    expect(intervalsStarted - intervalsCleared).toBe(0);

    window.setInterval = originalSetInterval;
    window.clearInterval = originalClearInterval;
  });

  it('PATCH 45. Realtime burst test: 20 rapid pass changes coalesce into 1 current + 1 queued follow-up', async () => {
    let simultaneousCalls = 0;
    let maxSimultaneousCalls = 0;
    let totalCalls = 0;

    const pool = generatePassPool(10);
    vi.spyOn(supabaseLib, 'requireSupabase').mockReturnValue({
      schema: vi.fn().mockReturnValue({
        rpc: vi.fn(async () => {
          simultaneousCalls++;
          totalCalls++;
          maxSimultaneousCalls = Math.max(maxSimultaneousCalls, simultaneousCalls);
          await new Promise((r) => setTimeout(r, 15));
          simultaneousCalls--;

          return {
            data: {
              queue: [],
              stats: { inside: 0, exited: 0, rejected: 0, total: 0 },
              rejectionReasons: [],
              pendingTotal: 0,
              snapshotPendingTotal: 0,
              snapshotAt: '2026-10-21T09:00:00.000000Z',
              hasMore: false,
              nextCursor: null,
            },
            error: null,
          };
        }),
      }),
    } as any);

    const { result, unmount } = renderGuardQueueHook();

    await act(async () => {
      const initial = result.current.requestGuardQueueRefresh();

      // Simulate 20 rapid Realtime pass changes arriving during fetch
      for (let i = 0; i < 20; i++) {
        result.current.queueIntentEpochRef.current += 1;
        result.current.refreshQueuedRef.current = true;
        void result.current.requestGuardQueueRefresh();
      }

      await initial;
    });

    expect(maxSimultaneousCalls).toBe(1);
    expect(totalCalls).toBe(2); // 1 in-flight + 1 queued follow-up

    unmount();
  });

  it('PATCH 46. Expiration feedback test: expiry updates causing Realtime event does not trigger a refresh storm', async () => {
    let callCount = 0;
    const pool = generatePassPool(5);

    vi.spyOn(supabaseLib, 'requireSupabase').mockReturnValue({
      schema: vi.fn().mockReturnValue({
        rpc: vi.fn(async () => {
          callCount++;
          await new Promise((r) => setTimeout(r, 10));
          return {
            data: {
              queue: [],
              stats: { inside: 0, exited: 0, rejected: 0, total: 0 },
              rejectionReasons: [],
              pendingTotal: 0,
              snapshotPendingTotal: 0,
              snapshotAt: '2026-10-21T09:00:00.000000Z',
              hasMore: false,
              nextCursor: null,
            },
            error: null,
          };
        }),
      }),
    } as any);

    const { result, unmount } = renderGuardQueueHook();

    await act(async () => {
      const p = result.current.requestGuardQueueRefresh();
      // Simulate Realtime feedback from pass expiration during first traversal
      result.current.queueIntentEpochRef.current += 1;
      result.current.refreshQueuedRef.current = true;
      await p;
    });

    // Exactly 2 calls: first traversal + single coalesced follow-up. No storm!
    expect(callCount).toBe(2);

    unmount();
  });

  it('PATCH 47. Load More during refresh: user increases target during refresh; in-flight becomes obsolete, queued traversal commits new target', async () => {
    const pool = generatePassPool(150);
    mockSupabaseRpc(pool, { delayMs: 15 });

    const { result, unmount } = renderGuardQueueHook();

    await act(async () => {
      // Start background refresh (desired 50)
      const refreshP = result.current.requestGuardQueueRefresh();

      await new Promise((r) => setTimeout(r, 2));

      // User triggers Load More: target becomes 100, epoch increments
      result.current.desiredQueueSizeRef.current = 100;
      result.current.queueIntentEpochRef.current += 1;
      result.current.refreshQueuedRef.current = true;
      const loadMoreP = result.current.requestGuardQueueRefresh();

      await Promise.all([refreshP, loadMoreP]);
    });

    // Authoritative committed queue has length 100
    expect(result.current.passes).toHaveLength(100);
    expect(result.current.desiredQueueSizeRef.current).toBe(100);

    unmount();
  });

  it('PATCH 48. Load All during refresh: Load All intent survives concurrent refresh', async () => {
    const pool = generatePassPool(450);
    mockSupabaseRpc(pool, { delayMs: 15 });

    const { result, unmount } = renderGuardQueueHook();

    await act(async () => {
      const refreshP = result.current.requestGuardQueueRefresh();

      await new Promise((r) => setTimeout(r, 2));

      // User presses Load All: desired becomes 5000, epoch increments
      result.current.desiredQueueSizeRef.current = 5000;
      result.current.queueIntentEpochRef.current += 1;
      result.current.refreshQueuedRef.current = true;
      const loadAllP = result.current.requestGuardQueueRefresh();

      await Promise.all([refreshP, loadAllP]);
    });

    expect(result.current.passes).toHaveLength(450);

    unmount();
  });

  it('PATCH 49. Error + queued success test: obsolete error is not surfaced, queued success commits cleanly', async () => {
    let callIndex = 0;
    const pool = generatePassPool(10);

    vi.spyOn(supabaseLib, 'requireSupabase').mockReturnValue({
      schema: vi.fn().mockReturnValue({
        rpc: vi.fn(async () => {
          callIndex++;
          await new Promise((r) => setTimeout(r, 10));
          if (callIndex === 1) {
            // First traversal fails
            throw new Error('Transient network glitch');
          }
          // Follow-up succeeds
          return {
            data: {
              queue: pool.map((p) => ({
                id: p.id,
                visitorName: p.visitorName,
                purpose: 'Official Business',
                source: 'portal',
                status: 'pending',
                validFrom: '2026-10-21T08:00:00Z',
                validUntil: '2026-10-21T17:00:00Z',
                scannedAt: p.scannedAt,
                gate: 'Gate 1',
                photoEvidenceId: '22222222-2222-4222-8222-222222222222',
                idEvidenceId: null,
              })),
              stats: { inside: 0, exited: 0, rejected: 0, total: 0 },
              rejectionReasons: [],
              pendingTotal: pool.length,
              snapshotPendingTotal: pool.length,
              snapshotAt: '2026-10-21T09:00:00.000000Z',
              hasMore: false,
              nextCursor: null,
            },
            error: null,
          };
        }),
      }),
    } as any);

    const { result, unmount } = renderGuardQueueHook();

    await act(async () => {
      const p1 = result.current.requestGuardQueueRefresh();

      // Realtime or user queues newer refresh while p1 is failing
      result.current.queueIntentEpochRef.current += 1;
      result.current.refreshQueuedRef.current = true;
      const p2 = result.current.requestGuardQueueRefresh();

      await Promise.all([p1, p2]);
    });

    // The transient glitch was discarded because a newer request was queued!
    expect(result.current.refreshError).toBe(false);
    expect(result.current.queueError).toBe(false);
    expect(result.current.passes).toHaveLength(10);

    unmount();
  });

  it('PATCH 35. Unmount fencing: unmounting during fetch does not commit to React state', async () => {
    const pool = generatePassPool(10);
    mockSupabaseRpc(pool, { delayMs: 25 });

    const { result, unmount } = renderGuardQueueHook();

    let refreshPromise: Promise<any>;
    act(() => {
      refreshPromise = result.current.requestGuardQueueRefresh();
    });

    // Unmount while fetch is in-flight
    unmount();

    await act(async () => {
      const res = await refreshPromise;
      expect(res.committed).toBe(false);
    });
  });
});
