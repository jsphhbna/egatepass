// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../src/services/auth', () => ({
  getAccessToken: async () => 'mock-token',
}));

import {
  useAdminDashboardData,
  refreshAdminDashboardData,
} from '../src/hooks/useAdminDashboardData';

describe('Repair Group 9: Admin Dashboard Polling Liveness', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    vi.useFakeTimers();
  });

  afterEach(() => {
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
});
