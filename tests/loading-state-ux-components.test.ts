// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import {
  Skeleton,
  TableSkeleton,
  TableSkeletonRows,
  CardGridSkeleton,
  ProgressBar,
  SyncDots,
  FullPageLoadingScreen,
  TerminalBootLoader,
  LoadingState,
} from '../src/components/ui';

describe('Loading State UX Component Suite & Design Token Invariants', () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root!.unmount();
      });
    }
    container?.remove();
    root = null;
    container = null;
  });

  // --------------------------------------------------------------------------
  // 1. Skeleton Primitive
  // --------------------------------------------------------------------------
  describe('1. Skeleton Primitive', () => {
    it('renders with aria-hidden="true" and animate-shimmer by default', async () => {
      await act(async () => {
        root!.render(createElement(Skeleton, { className: 'h-6 w-32' }));
      });
      const el = container!.querySelector('div');
      expect(el).not.toBeNull();
      expect(el!.getAttribute('aria-hidden')).toBe('true');
      expect(el!.className).toContain('animate-shimmer');
      expect(el!.className).toContain('h-6');
      expect(el!.className).toContain('w-32');
    });

    it('supports circular and text variants with explicit dimensions', async () => {
      await act(async () => {
        root!.render(
          createElement('div', null, [
            createElement(Skeleton, { key: 'circle', variant: 'circular', width: 40, height: 40 }),
            createElement(Skeleton, { key: 'text', variant: 'text' }),
          ])
        );
      });
      const circle = container!.querySelector('.rounded-full');
      expect(circle).not.toBeNull();
      expect((circle as HTMLElement).style.width).toBe('40px');
      expect((circle as HTMLElement).style.height).toBe('40px');

      const text = container!.querySelector('.rounded-sm');
      expect(text).not.toBeNull();
    });
  });

  // --------------------------------------------------------------------------
  // 2. TableSkeleton & TableSkeletonRows
  // --------------------------------------------------------------------------
  describe('2. TableSkeleton & TableSkeletonRows', () => {
    it('renders TableSkeleton with accessible table structure, role="status", and aria-busy="true"', async () => {
      await act(async () => {
        root!.render(createElement(TableSkeleton, { columns: 5, rows: 4 }));
      });
      const tableWrapper = container!.querySelector('[role="status"]');
      expect(tableWrapper).not.toBeNull();
      expect(tableWrapper!.getAttribute('aria-busy')).toBe('true');

      const headers = container!.querySelectorAll('th');
      expect(headers.length).toBe(5);

      const rows = container!.querySelectorAll('tbody tr');
      expect(rows.length).toBe(4);

      const cells = container!.querySelectorAll('tbody td');
      expect(cells.length).toBe(20);
    });

    it('renders TableSkeletonRows cleanly within existing tbody with custom column widths', async () => {
      await act(async () => {
        root!.render(
          createElement(
            'table',
            null,
            createElement(
              'tbody',
              null,
              createElement(TableSkeletonRows, {
                columns: 3,
                rows: 2,
                columnWidths: ['50%', '30%', '20%'],
              })
            )
          )
        );
      });
      const rows = container!.querySelectorAll('tr');
      expect(rows.length).toBe(2);

      const firstRowSkeletons = rows[0].querySelectorAll('td div');
      expect(firstRowSkeletons.length).toBe(3);
      expect((firstRowSkeletons[0] as HTMLElement).style.width).toBe('50%');
      expect((firstRowSkeletons[1] as HTMLElement).style.width).toBe('30%');
      expect((firstRowSkeletons[2] as HTMLElement).style.width).toBe('20%');
    });

    it('renders accessible screen-reader announcement row when ariaLabel is provided', async () => {
      await act(async () => {
        root!.render(
          createElement(
            'table',
            null,
            createElement(
              'tbody',
              null,
              createElement(TableSkeletonRows, {
                columns: 4,
                rows: 2,
                ariaLabel: 'Loading evacuation list…',
              })
            )
          )
        );
      });
      const announcementCell = container!.querySelector('tr.sr-only td[role="status"]');
      expect(announcementCell).not.toBeNull();
      expect(announcementCell!.getAttribute('aria-live')).toBe('polite');
      expect(announcementCell!.getAttribute('colspan')).toBe('4');
      expect(announcementCell!.textContent).toBe('Loading evacuation list…');
    });
  });

  // --------------------------------------------------------------------------
  // 3. CardGridSkeleton
  // --------------------------------------------------------------------------
  describe('3. CardGridSkeleton', () => {
    it('renders device grid skeleton with matching card count and role="status"', async () => {
      await act(async () => {
        root!.render(
          createElement(CardGridSkeleton, {
            count: 6,
            variant: 'device',
            ariaLabel: 'Loading devices...',
          })
        );
      });
      const grid = container!.querySelector('[role="status"]');
      expect(grid).not.toBeNull();
      expect(grid!.getAttribute('aria-label')).toBe('Loading devices...');

      const cards = container!.querySelectorAll('[role="status"] > div');
      expect(cards.length).toBe(6);
    });
  });

  // --------------------------------------------------------------------------
  // 4. ProgressBar
  // --------------------------------------------------------------------------
  describe('4. ProgressBar', () => {
    it('renders determinate progress bar with role="progressbar", valuenow, and clamps out-of-range values', async () => {
      await act(async () => {
        root!.render(
          createElement(ProgressBar, {
            value: 125,
            label: 'Extracting records',
            showPercentage: true,
          })
        );
      });
      const bar = container!.querySelector('[role="progressbar"]');
      expect(bar).not.toBeNull();
      expect(bar!.getAttribute('aria-valuenow')).toBe('100');
      expect(bar!.getAttribute('aria-valuemin')).toBe('0');
      expect(bar!.getAttribute('aria-valuemax')).toBe('100');
      expect(container!.textContent).toContain('Extracting records');
      expect(container!.textContent).toContain('100%');
    });

    it('renders indeterminate progress bar with animate-progress-indeterminate and undefined valuenow', async () => {
      await act(async () => {
        root!.render(
          createElement(ProgressBar, {
            indeterminate: true,
            label: 'Reading ID Details…',
            phase: 'Extracting text & fields…',
          })
        );
      });
      const bar = container!.querySelector('[role="progressbar"]');
      expect(bar).not.toBeNull();
      expect(bar!.hasAttribute('aria-valuenow')).toBe(false);
      expect(bar!.getAttribute('aria-valuetext')).toBe('Extracting text & fields…');

      const animatedIndicator = container!.querySelector('.animate-progress-indeterminate');
      expect(animatedIndicator).not.toBeNull();
    });

    it('safely handles NaN and non-finite value props without crashing or emitting NaN attributes', async () => {
      await act(async () => {
        root!.render(
          createElement(ProgressBar, {
            value: Number.NaN,
            label: 'Calculating',
          })
        );
      });
      const bar = container!.querySelector('[role="progressbar"]');
      expect(bar).not.toBeNull();
      expect(bar!.getAttribute('aria-valuenow')).toBe('0');
    });
  });

  // --------------------------------------------------------------------------
  // 5. SyncDots
  // --------------------------------------------------------------------------
  describe('5. SyncDots', () => {
    it('renders 3 staggered pulsing dots with role="status" and aria-live="polite"', async () => {
      await act(async () => {
        root!.render(createElement(SyncDots, { label: 'Syncing live feed…', color: 'brand' }));
      });
      const statusContainer = container!.querySelector('[role="status"]');
      expect(statusContainer).not.toBeNull();
      expect(statusContainer!.getAttribute('aria-live')).toBe('polite');
      expect(container!.textContent).toContain('Syncing live feed…');

      const dots = container!.querySelectorAll('.animate-pulse-dot');
      expect(dots.length).toBe(3);
      expect((dots[0] as HTMLElement).style.animationDelay).toBe('0ms');
      expect((dots[1] as HTMLElement).style.animationDelay).toBe('200ms');
      expect((dots[2] as HTMLElement).style.animationDelay).toBe('400ms');
    });

    it('provides accessible aria-label="Syncing…" fallback when text label is omitted', async () => {
      await act(async () => {
        root!.render(createElement(SyncDots, { size: 'xs', color: 'brand' }));
      });
      const statusContainer = container!.querySelector('[role="status"]');
      expect(statusContainer).not.toBeNull();
      expect(statusContainer!.getAttribute('aria-label')).toBe('Syncing…');
    });
  });

  // --------------------------------------------------------------------------
  // 6. FullPageLoadingScreen & TerminalBootLoader
  // --------------------------------------------------------------------------
  describe('6. FullPageLoadingScreen & TerminalBootLoader', () => {
    it('renders branded boot screen with EARIST logo, title, diagnostics checklist, and progress bar', async () => {
      await act(async () => {
        root!.render(
          createElement(TerminalBootLoader, {
            terminalName: 'Kiosk Terminal 01',
            statusText: 'Initializing hardware sensors…',
            checklist: [
              { label: 'Network Connection', status: 'ready' },
              { label: 'OCR Engine', status: 'loading' },
            ],
          })
        );
      });
      const screen = container!.querySelector('main[role="status"]');
      expect(screen).not.toBeNull();
      expect(screen!.getAttribute('aria-live')).toBe('polite');

      const logo = container!.querySelector('img[src="/earist-logo.png"]');
      expect(logo).not.toBeNull();

      expect(container!.textContent).toContain('EARIST E-GatePass');
      expect(container!.textContent).toContain('Kiosk Terminal 01');
      expect(container!.textContent).toContain('Initializing hardware sensors…');
      expect(container!.textContent).toContain('Network Connection');
      expect(container!.textContent).toContain('Ready');
      expect(container!.textContent).toContain('OCR Engine');
      expect(container!.textContent).toContain('Checking');
    });

    it('renders unified LoadingState with EARIST seal, ProgressBar, and status role', async () => {
      await act(async () => {
        root!.render(createElement(LoadingState, { label: 'Checking reset link...' }));
      });
      const el = container!.querySelector('[role="status"]');
      expect(el).not.toBeNull();
      expect(el!.getAttribute('aria-live')).toBe('polite');
      expect(container!.textContent).toContain('Checking reset link...');

      const logo = container!.querySelector('img[src="/earist-logo.png"]');
      expect(logo).not.toBeNull();

      const bar = container!.querySelector('[role="progressbar"]');
      expect(bar).not.toBeNull();
    });
  });

  // --------------------------------------------------------------------------
  // 7. CSS Animation Token Integrity
  // --------------------------------------------------------------------------
  describe('7. CSS Animation Token Integrity (src/index.css)', () => {
    const css = readFileSync('src/index.css', 'utf8');

    it('defines @keyframes shimmer and .animate-shimmer gradient sweep', () => {
      expect(css).toContain('@keyframes shimmer');
      expect(css).toContain('.animate-shimmer');
      expect(css).toContain('background-size: 200% 100%');
    });

    it('defines @keyframes progress-indeterminate and .animate-progress-indeterminate', () => {
      expect(css).toContain('@keyframes progress-indeterminate');
      expect(css).toContain('.animate-progress-indeterminate');
    });

    it('defines @keyframes pulse-dot and .animate-pulse-dot', () => {
      expect(css).toContain('@keyframes pulse-dot');
      expect(css).toContain('.animate-pulse-dot');
    });

    it('defines @keyframes scan-line and .animate-scan-line', () => {
      expect(css).toContain('@keyframes scan-line');
      expect(css).toContain('.animate-scan-line');
    });

    it('defines @keyframes radar-ping and .animate-radar-ping', () => {
      expect(css).toContain('@keyframes radar-ping');
      expect(css).toContain('.animate-radar-ping');
    });

    it('enforces graceful motion reduction rules for all animation utilities under prefers-reduced-motion', () => {
      expect(css).toContain('@media (prefers-reduced-motion: reduce)');
      expect(css).toMatch(/\.animate-shimmer\s*\{[^}]*animation:\s*none\s*!important/);
      expect(css).toMatch(/\.animate-progress-indeterminate\s*\{[^}]*animation:\s*none\s*!important/);
      expect(css).toMatch(/\.animate-pulse-dot\s*\{[^}]*animation:\s*none\s*!important/);
      expect(css).toMatch(/\.animate-scan-line\s*\{[^}]*animation:\s*none\s*!important/);
      expect(css).toMatch(/\.animate-radar-ping\s*\{[^}]*animation:\s*none\s*!important/);
    });
  });
});
