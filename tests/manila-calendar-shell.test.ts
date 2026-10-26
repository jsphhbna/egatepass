// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { IssuedPassesCalendar } from '../src/pages/AdminDashboard';
import { getManilaDateParts } from '../src/lib/manilaTime';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe('Repair Group 11: Manila-Authoritative Dashboard Calendar Shell', () => {
  let container: HTMLDivElement;
  let root: any;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('UTC October 31 20:00:00Z -> Manila November 1 04:00:00: displays November, rings Nov 1, buckets Nov 1', async () => {
    // 2026-10-31T20:00:00Z is 2026-11-01T04:00:00 in Asia/Manila (+08:00)
    const instantUtc = '2026-10-31T20:00:00Z';

    const manilaParts = getManilaDateParts(instantUtc);
    expect(manilaParts.year).toBe(2026);
    expect(manilaParts.month).toBe(11);
    expect(manilaParts.day).toBe(1);
    expect(manilaParts.dateString).toBe('2026-11-01');
    expect(manilaParts.monthKey).toBe('2026-11');

    const calendarCounts = {
      '2026-10-31': 5,
      '2026-11-01': 12,
    };

    await act(async () => {
      root.render(
        React.createElement(IssuedPassesCalendar, {
          passes: [],
          calendarCounts,
          referenceDate: instantUtc,
        })
      );
    });

    const textContent = container.textContent || '';
    // Displays November 2026
    expect(textContent).toContain('November 2026');

    // Find the cell for 2026-11-01
    const nov1Cell = container.querySelector('[aria-label*="November 1, 2026"]');
    expect(nov1Cell).not.toBeNull();
    // Invariant: November 1 is marked as today with the active ring
    expect(nov1Cell?.className).toContain('ring-2');
    expect(nov1Cell?.textContent).toContain('12 passes');

    // Find the cell for 2026-11-02
    const nov2Cell = container.querySelector('[aria-label*="November 2, 2026"]');
    expect(nov2Cell).not.toBeNull();
    // Invariant: November 2 is NOT marked as today
    expect(nov2Cell?.className).not.toContain('ring-2');
  });

  it('Opposite boundary: UTC April 30 23:30:00Z -> Manila May 1 07:30:00: displays May, rings May 1', async () => {
    const instantUtc = '2026-04-30T23:30:00Z';

    const manilaParts = getManilaDateParts(instantUtc);
    expect(manilaParts.month).toBe(5);
    expect(manilaParts.day).toBe(1);
    expect(manilaParts.dateString).toBe('2026-05-01');

    await act(async () => {
      root.render(
        React.createElement(IssuedPassesCalendar, {
          passes: [],
          calendarCounts: { '2026-05-01': 8 },
          referenceDate: instantUtc,
        })
      );
    });

    const textContent = container.textContent || '';
    expect(textContent).toContain('May 2026');

    const may1Cell = container.querySelector('[aria-label*="May 1, 2026"]');
    expect(may1Cell).not.toBeNull();
    expect(may1Cell?.className).toContain('ring-2');
    expect(may1Cell?.textContent).toContain('8 passes');
  });
});
