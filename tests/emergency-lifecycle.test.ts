// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/services/auth', () => ({
  getAccessToken: vi.fn(async () => 'fake-token'),
}));

import { AdminEmergency } from '../src/pages/AdminEmergency';

describe('Repair Groups 3, 4, 5: Emergency UI Lifecycle, Stale Response Fencing & Print Consistency', () => {
  let container: HTMLDivElement;
  let root: any;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    vi.useFakeTimers();
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('ADVERSARIAL CASE D: Stale closure eliminated: background poll failure preserves roster and shows stale warning', async () => {
    const initialPasses = [
      { id: 'p1', visitorName: 'Alice Santos', timeIn: '2026-10-26T08:00:00Z', gate: 'Gate 1', status: 'inside' },
      { id: 'p2', visitorName: 'Bob Reyes', timeIn: '2026-10-26T08:05:00Z', gate: 'Gate 2', status: 'inside' },
    ];

    let fetchCount = 0;
    const fetchMock = vi.fn(async () => {
      fetchCount++;
      if (fetchCount === 1) {
        // Initial load succeeds
        return {
          ok: true,
          json: async () => ({
            passes: initialPasses,
            total: 2,
            snapshotTotal: 2,
            snapshotAt: '2026-10-26T08:10:00Z',
            truncated: false,
          }),
        };
      }
      // Background poll failure
      return {
        ok: false,
        status: 503,
        json: async () => ({ error: 'Database network timeout' }),
      };
    });

    vi.stubGlobal('fetch', fetchMock);

    // Initial mount and render
    await act(async () => {
      root.render(React.createElement(AdminEmergency, null));
    });
    // Wait for initial fetch promise to resolve
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toContain('Currently Inside: 2 Visitors');
    expect(container.textContent).toContain('Alice Santos');
    expect(container.textContent).toContain('Bob Reyes');
    expect(container.textContent).not.toContain('Refresh delayed');
    expect(container.textContent).not.toContain('Evacuation list unavailable');

    // Fast-forward 15 seconds to trigger background poll
    await act(async () => {
      vi.advanceTimersByTime(15_000);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    // Invariant checks:
    // 1. Old roster is preserved (passes not blanked)
    expect(container.textContent).toContain('Currently Inside: 2 Visitors');
    expect(container.textContent).toContain('Alice Santos');
    expect(container.textContent).toContain('Bob Reyes');

    // 2. Initial error screen is ABSENT (no "Evacuation list unavailable" screen)
    expect(container.textContent).not.toContain('Evacuation list unavailable');

    // 3. Truthful stale warning banner is visible
    expect(container.textContent).toContain('Failed to refresh live evacuation list: Database network timeout');
    expect(container.textContent).toContain('Refresh delayed — showing data from');
  });

  it('ADVERSARIAL CASE E: Screen has filter, Print Roll Call outputs full snapshot instead of filtered subset', async () => {
    const fullRoster = [
      { id: 'p1', visitorName: 'Alice Santos', timeIn: '2026-10-26T08:00:00Z', gate: 'Gate 1', status: 'inside' },
      { id: 'p2', visitorName: 'Bob Reyes', timeIn: '2026-10-26T08:05:00Z', gate: 'Gate 2', status: 'inside' },
      { id: 'p3', visitorName: 'Charlie Santos', timeIn: '2026-10-26T08:10:00Z', gate: 'Gate 1', status: 'inside' },
    ];

    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        passes: fullRoster,
        total: 3,
        snapshotTotal: 3,
        snapshotAt: '2026-10-26T08:15:00Z',
        truncated: false,
      }),
    })));

    await act(async () => {
      root.render(React.createElement(AdminEmergency, null));
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    // Screen table initially shows all 3
    const screenTable = container.querySelector('.print\\:hidden table');
    expect(screenTable?.textContent).toContain('Alice Santos');
    expect(screenTable?.textContent).toContain('Bob Reyes');
    expect(screenTable?.textContent).toContain('Charlie Santos');

    // Filter by "Santos"
    const searchInput = container.querySelector('#emergency-visitor-search') as HTMLInputElement;
    await act(async () => {
      const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
      nativeSetter?.call(searchInput, 'Santos');
      searchInput.dispatchEvent(new Event('input', { bubbles: true }));
    });

    // Screen table now shows only Santos
    expect(screenTable?.textContent).toContain('Alice Santos');
    expect(screenTable?.textContent).toContain('Charlie Santos');
    expect(screenTable?.textContent).not.toContain('Bob Reyes');

    // Dedicated Print Table MUST contain all 3 visitors!
    const printTable = container.querySelector('.hidden.print\\:block table');
    expect(printTable?.textContent).toContain('Alice Santos');
    expect(printTable?.textContent).toContain('Bob Reyes');
    expect(printTable?.textContent).toContain('Charlie Santos');

    // Print Header shows full snapshot total
    const printHeader = container.querySelector('.hidden.print\\:block');
    expect(printHeader?.textContent).toContain('Total Visitors Listed Inside: 3 / 3 snapshot total');
  });

  it('Concurrent request serialization: background poll does not spawn concurrent fetches when busy', async () => {
    let activeFetches = 0;
    let maxSimultaneousFetches = 0;
    let resolveFirstFetch: () => void;

    const firstFetchPromise = new Promise<void>((resolve) => {
      resolveFirstFetch = resolve;
    });

    vi.stubGlobal('fetch', vi.fn(async () => {
      activeFetches++;
      maxSimultaneousFetches = Math.max(maxSimultaneousFetches, activeFetches);

      if (activeFetches === 1) {
        await firstFetchPromise;
      }

      activeFetches--;
      return {
        ok: true,
        json: async () => ({
          passes: [],
          total: 0,
          snapshotTotal: 0,
          snapshotAt: new Date().toISOString(),
          truncated: false,
        }),
      };
    }));

    await act(async () => {
      root.render(React.createElement(AdminEmergency, null));
    });

    // First fetch is in flight
    expect(activeFetches).toBe(1);

    // Fast forward timer across multiple poll intervals
    await act(async () => {
      vi.advanceTimersByTime(15_000);
      vi.advanceTimersByTime(15_000);
      vi.advanceTimersByTime(15_000);
    });

    // Simultaneous requests must remain capped at 1 (polls coalesced/skipped)
    expect(maxSimultaneousFetches).toBe(1);

    // Finish first fetch
    await act(async () => {
      resolveFirstFetch();
      await Promise.resolve();
    });

    expect(activeFetches).toBe(0);
  });
});
