// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../src/services/auth', () => ({
  getAccessToken: async () => 'mock-token',
}));

import {
  useAdminDashboardData,
  refreshAdminDashboardData,
  _resetDashboardStoreForTesting,
} from '../src/hooks/useAdminDashboardData';

describe('Repair Group 9: Admin Dashboard Polling Liveness', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    _resetDashboardStoreForTesting();
    originalFetch = globalThis.fetch;
    vi.useFakeTimers();
  });

  afterEach(() => {
    _resetDashboardStoreForTesting();
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('ADVERSARIAL CASE I: Dashboard request lasting >15s is not aborted by background poll and eventually commits', async () => {
    let fetchCount = 0;
    let finishFirstFetch!: (val: any) => void;
    const fetchDeferred = new Promise<Response>((resolve) => {
      finishFirstFetch = resolve;
    });

    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      fetchCount++;
      return fetchDeferred;
    });

    // Subscribe to start polling
    const listener = vi.fn();
    // Simulate useSyncExternalStore subscribe
    // In node/happy-dom we can subscribe using a component or manually calling subscribe
    let unsubscribe: () => void = () => {};
    const testSub = () => {
      // simulate component mounting useAdminDashboardData
      // @ts-expect-error testing internal
      const store = useAdminDashboardData;
      // We can trigger subscription by rendering or using React
    };

    // To test the store directly with subscribe/unsubscribe:
    // Let's render a test component with React
    const React = await import('react');
    const { createRoot } = await import('react-dom/client');
    const { act } = React;

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    let latestSnapshot: any = null;
    function Probe() {
      const data = useAdminDashboardData();
      latestSnapshot = data;
      return React.createElement('div', null, data.loading ? 'loading' : 'ready');
    }

    await act(async () => {
      root.render(React.createElement(Probe));
    });

    // 1st fetch was initiated on mount
    expect(fetchCount).toBe(1);
    expect(latestSnapshot.initialLoading).toBe(true);

    // Fast-forward 15 seconds (background poll interval)
    await act(async () => {
      vi.advanceTimersByTime(15000);
    });

    // Invariant: The active slow fetch was NOT aborted, and no duplicate concurrent fetch was spawned
    expect(fetchCount).toBe(1);

    // Fast-forward another 15 seconds (total 30s)
    await act(async () => {
      vi.advanceTimersByTime(15000);
    });
    expect(fetchCount).toBe(1);

    // Now complete the slow fetch
    await act(async () => {
      finishFirstFetch(
        new Response(
          JSON.stringify({
            counts: { todayTotal: 42, currentlyInside: 5, exitedToday: 37, pendingToday: 0, rejectedToday: 0 },
            recentPasses: [],
            insidePasses: [],
            exitedTodayPasses: [],
            decisionsTodayPasses: [],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      );
      await Promise.resolve();
    });

    // Invariant: Slow request commits successfully
    expect(latestSnapshot.loading).toBe(false);
    expect(latestSnapshot.initialLoading).toBe(false);
    expect(latestSnapshot.counts?.todayTotal).toBe(42);
    expect(latestSnapshot.updatedAt).not.toBeNull();

    // Cleanup
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it('Background refresh failure preserves previous snapshot and sets refreshError without wiping data', async () => {
    const React = await import('react');
    const { createRoot } = await import('react-dom/client');
    const { act } = React;

    let responseMode: 'success' | 'error' = 'success';

    globalThis.fetch = vi.fn().mockImplementation(async () => {
      if (responseMode === 'success') {
        return new Response(
          JSON.stringify({
            counts: { todayTotal: 100, currentlyInside: 10, exitedToday: 90, pendingToday: 0, rejectedToday: 0 },
            recentPasses: [],
            insidePasses: [],
            exitedTodayPasses: [],
            decisionsTodayPasses: [],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      } else {
        return new Response(
          JSON.stringify({ error: 'Gateway Timeout' }),
          { status: 504, headers: { 'Content-Type': 'application/json' } }
        );
      }
    });

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    let latestSnapshot: any = null;
    function Probe() {
      const data = useAdminDashboardData();
      latestSnapshot = data;
      return React.createElement('div', null, data.counts?.todayTotal ?? 'none');
    }

    await act(async () => {
      root.render(React.createElement(Probe));
    });
    await act(async () => {
      await Promise.resolve();
    });

    // Initial load succeeded
    expect(latestSnapshot.counts?.todayTotal).toBe(100);
    const initialUpdatedAt = latestSnapshot.updatedAt;
    expect(initialUpdatedAt).not.toBeNull();
    expect(latestSnapshot.refreshError).toBeNull();

    // Now switch response mode to error for the background poll
    responseMode = 'error';

    // Advance 15s for background poll
    await act(async () => {
      vi.advanceTimersByTime(15000);
      await Promise.resolve();
    });

    // Invariant: Snapshot data is retained, refreshError is set, error does NOT blank the screen
    expect(latestSnapshot.counts?.todayTotal).toBe(100);
    expect(latestSnapshot.updatedAt).toBe(initialUpdatedAt);
    expect(latestSnapshot.refreshError).toBe('Gateway Timeout');
    expect(latestSnapshot.error).toBeNull();

    // Now recover on next poll
    responseMode = 'success';
    await act(async () => {
      vi.advanceTimersByTime(15000);
      await Promise.resolve();
    });

    // Invariant: refreshError cleared, updatedAt advanced
    expect(latestSnapshot.refreshError).toBeNull();
    expect(latestSnapshot.updatedAt).toBeGreaterThanOrEqual(initialUpdatedAt);

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it('Dashboard A — remount ownership race: aborted request A cannot clear lock or allow overlapping request C', async () => {
    const React = await import('react');
    const { createRoot } = await import('react-dom/client');
    const { act } = React;

    let activeFetchCount = 0;
    let maxSimultaneousFetches = 0;
    let finishFetchA!: (val: any) => void;
    let finishFetchB!: (val: any) => void;

    const fetchDeferredA = new Promise<Response>((resolve) => { finishFetchA = resolve; });
    const fetchDeferredB = new Promise<Response>((resolve) => { finishFetchB = resolve; });

    let callIndex = 0;
    globalThis.fetch = vi.fn().mockImplementation((url: string, init?: any) => {
      callIndex++;
      activeFetchCount++;
      if (activeFetchCount > maxSimultaneousFetches) {
        maxSimultaneousFetches = activeFetchCount;
      }
      const myIndex = callIndex;
      const basePromise = myIndex === 1 ? fetchDeferredA : fetchDeferredB;
      const signal = init?.signal as AbortSignal | undefined;

      const promiseWithAbort = new Promise<Response>((resolve, reject) => {
        if (signal?.aborted) {
          reject(new DOMException('The user aborted a request.', 'AbortError'));
          return;
        }
        signal?.addEventListener('abort', () => {
          reject(new DOMException('The user aborted a request.', 'AbortError'));
        });
        basePromise.then(resolve, reject);
      });

      return promiseWithAbort.finally(() => {
        activeFetchCount--;
      });
    });

    const container = document.createElement('div');
    document.body.appendChild(container);

    let latestSnapshot: any = null;
    function Probe() {
      const data = useAdminDashboardData();
      latestSnapshot = data;
      return React.createElement('div', null, data.loading ? 'loading' : 'ready');
    }

    // 1. Mount first instance (initiates request A)
    let root = createRoot(container);
    await act(async () => {
      root.render(React.createElement(Probe));
    });
    expect(callIndex).toBe(1);

    // 2. Unmount (aborts request A)
    await act(async () => {
      root.unmount();
    });

    // 3. Immediate remount (initiates request B)
    root = createRoot(container);
    await act(async () => {
      root.render(React.createElement(Probe));
    });
    expect(callIndex).toBe(2);

    // 4. Request A finally resolves/rejects while B is active
    await act(async () => {
      finishFetchA(new Response(JSON.stringify({ error: 'aborted' }), { status: 500 }));
      await Promise.resolve();
    });

    // Request A's finally ran, but Request B is still active.
    // Advance timers by 15s: poll should NOT initiate request C while B is in flight!
    await act(async () => {
      vi.advanceTimersByTime(15000);
      await Promise.resolve();
    });
    expect(callIndex).toBe(2); // Still only request A and B, NO request C!

    // 5. Complete Request B
    await act(async () => {
      finishFetchB(
        new Response(
          JSON.stringify({
            counts: { todayTotal: 77, currentlyInside: 7, exitedToday: 70, pendingToday: 0, rejectedToday: 0 },
            recentPasses: [],
            insidePasses: [],
            exitedTodayPasses: [],
            decisionsTodayPasses: [],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      );
      await Promise.resolve();
    });

    expect(latestSnapshot.loading).toBe(false);
    expect(latestSnapshot.counts?.todayTotal).toBe(77);
    expect(maxSimultaneousFetches).toBe(1);

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it('Dashboard B — stale finally cannot clear new controller, isFetching, snapshot, or error state', async () => {
    const React = await import('react');
    const { createRoot } = await import('react-dom/client');
    const { act } = React;

    let finishFetchA!: (val: any) => void;
    let finishFetchB!: (val: any) => void;
    const fetchA = new Promise<Response>((resolve) => { finishFetchA = resolve; });
    const fetchB = new Promise<Response>((resolve) => { finishFetchB = resolve; });

    let fetchCount = 0;
    globalThis.fetch = vi.fn().mockImplementation(() => {
      fetchCount++;
      return fetchCount === 1 ? fetchA : fetchB;
    });

    const container = document.createElement('div');
    document.body.appendChild(container);

    let latestSnapshot: any = null;
    function Probe() {
      const data = useAdminDashboardData();
      latestSnapshot = data;
      return React.createElement('div', null, data.loading ? 'loading' : 'ready');
    }

    let root = createRoot(container);
    await act(async () => {
      root.render(React.createElement(Probe));
    });
    expect(fetchCount).toBe(1);

    // Unmount and remount
    await act(async () => { root.unmount(); });
    root = createRoot(container);
    await act(async () => {
      root.render(React.createElement(Probe));
    });
    expect(fetchCount).toBe(2);

    // Stale request A resolves with error
    await act(async () => {
      finishFetchA(new Response(JSON.stringify({ error: 'Stale A Error' }), { status: 500 }));
      await Promise.resolve();
    });

    // Invariant: Stale A error did not overwrite state for request B
    expect(latestSnapshot.error).toBeNull();
    expect(latestSnapshot.initialLoading).toBe(true);

    // Finish request B successfully
    await act(async () => {
      finishFetchB(
        new Response(
          JSON.stringify({
            counts: { todayTotal: 88, currentlyInside: 8, exitedToday: 80, pendingToday: 0, rejectedToday: 0 },
            recentPasses: [],
            insidePasses: [],
            exitedTodayPasses: [],
            decisionsTodayPasses: [],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      );
      await Promise.resolve();
    });

    expect(latestSnapshot.counts?.todayTotal).toBe(88);
    expect(latestSnapshot.error).toBeNull();

    await act(async () => { root.unmount(); });
    container.remove();
  });

  it('Dashboard C — manual retry while busy waits for actual follow-up refresh to settle', async () => {
    const React = await import('react');
    const { createRoot } = await import('react-dom/client');
    const { act } = React;

    let finishFetch1!: (val: any) => void;
    let finishFetch2!: (val: any) => void;
    const p1 = new Promise<Response>((res) => { finishFetch1 = res; });
    const p2 = new Promise<Response>((res) => { finishFetch2 = res; });

    let callCount = 0;
    globalThis.fetch = vi.fn().mockImplementation(() => {
      callCount++;
      return callCount === 1 ? p1 : p2;
    });

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    let latestSnapshot: any = null;
    function Probe() {
      const data = useAdminDashboardData();
      latestSnapshot = data;
      return React.createElement('div', null, data.loading ? 'loading' : 'ready');
    }

    await act(async () => {
      root.render(React.createElement(Probe));
    });
    expect(callCount).toBe(1);

    // While fetch 1 is active, user clicks manual retry
    let retrySettled = false;
    let retryPromise: Promise<void>;
    await act(async () => {
      retryPromise = refreshAdminDashboardData().then(() => {
        retrySettled = true;
      });
    });

    // Invariant: manual retry was queued, but promise remains pending
    expect(retrySettled).toBe(false);
    expect(callCount).toBe(1);

    // Complete fetch 1 (e.g. gateway error or initial data)
    await act(async () => {
      finishFetch1(
        new Response(
          JSON.stringify({ error: 'Initial slow failure' }),
          { status: 504, headers: { 'Content-Type': 'application/json' } }
        )
      );
      await Promise.resolve();
    });

    // Queued follow-up fetch 2 is now launched!
    expect(callCount).toBe(2);
    // Invariant: retry promise STILL remains pending while follow-up is in flight!
    expect(retrySettled).toBe(false);

    // Now complete fetch 2 (the manual retry follow-up)
    await act(async () => {
      finishFetch2(
        new Response(
          JSON.stringify({
            counts: { todayTotal: 99, currentlyInside: 9, exitedToday: 90, pendingToday: 0, rejectedToday: 0 },
            recentPasses: [],
            insidePasses: [],
            exitedTodayPasses: [],
            decisionsTodayPasses: [],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      );
      await Promise.resolve();
    });

    // Invariant: retry promise has now truthfully settled!
    expect(retrySettled).toBe(true);
    expect(latestSnapshot.counts?.todayTotal).toBe(99);

    await act(async () => { root.unmount(); });
    container.remove();
  });

  it('Dashboard D & E — background polls while busy do not queue unbounded requests; idle poll executes exactly once', async () => {
    const React = await import('react');
    const { createRoot } = await import('react-dom/client');
    const { act } = React;

    let finishFetch1!: (val: any) => void;
    let finishFetch2!: (val: any) => void;
    const p1 = new Promise<Response>((res) => { finishFetch1 = res; });
    const p2 = new Promise<Response>((res) => { finishFetch2 = res; });

    let callCount = 0;
    globalThis.fetch = vi.fn().mockImplementation(() => {
      callCount++;
      return callCount === 1 ? p1 : p2;
    });

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    let latestSnapshot: any = null;
    function Probe() {
      const data = useAdminDashboardData();
      latestSnapshot = data;
      return React.createElement('div', null, data.loading ? 'loading' : 'ready');
    }

    await act(async () => {
      root.render(React.createElement(Probe));
    });
    expect(callCount).toBe(1);

    // Fire 3 background polls (15s, 30s, 45s) while fetch 1 is active
    await act(async () => {
      vi.advanceTimersByTime(45000);
      await Promise.resolve();
    });

    // Invariant (D): Background polls do NOT start overlapping requests
    expect(callCount).toBe(1);

    // Finish fetch 1
    await act(async () => {
      finishFetch1(
        new Response(
          JSON.stringify({
            counts: { todayTotal: 50, currentlyInside: 5, exitedToday: 45, pendingToday: 0, rejectedToday: 0 },
            recentPasses: [],
            insidePasses: [],
            exitedTodayPasses: [],
            decisionsTodayPasses: [],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      );
      await Promise.resolve();
    });

    // Background polls did NOT build an unbounded queue of fetches
    expect(callCount).toBe(1);

    // Invariant (E): Once system is idle, the next 15s background poll executes exactly once
    await act(async () => {
      vi.advanceTimersByTime(15000);
      await Promise.resolve();
    });
    expect(callCount).toBe(2);

    await act(async () => {
      finishFetch2(
        new Response(
          JSON.stringify({
            counts: { todayTotal: 51, currentlyInside: 5, exitedToday: 46, pendingToday: 0, rejectedToday: 0 },
            recentPasses: [],
            insidePasses: [],
            exitedTodayPasses: [],
            decisionsTodayPasses: [],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      );
      await Promise.resolve();
    });
    expect(latestSnapshot.counts?.todayTotal).toBe(51);

    await act(async () => { root.unmount(); });
    container.remove();
  });

  it('React StrictMode mount/cleanup/remount lifecycle test with in-flight request', async () => {
    const React = await import('react');
    const { createRoot } = await import('react-dom/client');
    const { act } = React;

    let finishFetch1!: (val: any) => void;
    let finishFetch2!: (val: any) => void;
    const p1 = new Promise<Response>((res) => { finishFetch1 = res; });
    const p2 = new Promise<Response>((res) => { finishFetch2 = res; });

    let callCount = 0;
    globalThis.fetch = vi.fn().mockImplementation(() => {
      callCount++;
      return callCount === 1 ? p1 : p2;
    });

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    let latestSnapshot: any = null;
    function Probe() {
      const data = useAdminDashboardData();
      latestSnapshot = data;
      return React.createElement('div', null, data.loading ? 'loading' : 'ready');
    }

    // In React StrictMode, rendering <StrictMode><Probe /></StrictMode> executes:
    // mount -> unmount (cleanup) -> mount
    await act(async () => {
      root.render(
        React.createElement(
          React.StrictMode,
          null,
          React.createElement(Probe)
        )
      );
    });

    // Even if StrictMode caused mount -> cleanup -> mount, request 2 was spawned cleanly
    expect(callCount).toBeGreaterThanOrEqual(1);

    // Resolve in-flight request(s)
    await act(async () => {
      if (finishFetch1) finishFetch1(new Response(JSON.stringify({ error: 'aborted' }), { status: 500 }));
      if (finishFetch2) {
        finishFetch2(
          new Response(
            JSON.stringify({
              counts: { todayTotal: 60, currentlyInside: 6, exitedToday: 54, pendingToday: 0, rejectedToday: 0 },
              recentPasses: [],
              insidePasses: [],
              exitedTodayPasses: [],
              decisionsTodayPasses: [],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          )
        );
      }
      await Promise.resolve();
    });

    expect(latestSnapshot.counts?.todayTotal).toBe(60);

    await act(async () => { root.unmount(); });
    container.remove();
  });
});
