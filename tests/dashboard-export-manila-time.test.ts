import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  formatManilaMonthYear,
  getManilaMonthKey,
  formatManilaDateTime,
  MANILA_TIMEZONE,
} from '../src/lib/manilaTime';

describe('PATCH 10: Dashboard Export Asia/Manila Timezone Formatting', () => {
  it('10A. formatManilaMonthYear and getManilaMonthKey format correctly in Asia/Manila', () => {
    expect(MANILA_TIMEZONE).toBe('Asia/Manila');

    // Standard date in October 2026
    const date = new Date('2026-10-15T10:00:00Z');
    expect(formatManilaMonthYear(date)).toBe('October 2026');
    expect(getManilaMonthKey(date)).toBe('2026-10');
  });

  it('10E. Month boundary fixture: 2026-10-31T17:00:00Z evaluates to November 2026 (01:00 AM Manila on Nov 1)', () => {
    // 17:00 UTC on Oct 31 is 01:00 AM on Nov 1 in UTC+8 (Asia/Manila)
    const boundaryUtc = new Date('2026-10-31T17:00:00Z');
    expect(formatManilaMonthYear(boundaryUtc)).toBe('November 2026');
    expect(getManilaMonthKey(boundaryUtc)).toBe('2026-11');

    // Also just before the boundary: 15:59 UTC on Oct 31 is 23:59 on Oct 31 in Manila
    const beforeBoundary = new Date('2026-10-31T15:59:59Z');
    expect(formatManilaMonthYear(beforeBoundary)).toBe('October 2026');
    expect(getManilaMonthKey(beforeBoundary)).toBe('2026-10');
  });

  it('10B, 10C & 10D. DashboardExportActions uses Manila helpers and eliminates date-fns local formatting', () => {
    const exportActionsPath = join(__dirname, '../src/components/DashboardExportActions.tsx');
    const content = readFileSync(exportActionsPath, 'utf-8');

    // Must not import date-fns format or isSameMonth
    expect(content).not.toContain("from 'date-fns'");
    expect(content).not.toContain('isSameMonth');

    // Must import and use Manila helpers
    expect(content).toContain('formatManilaDateTime');
    expect(content).toContain('formatManilaMonthYear');
    expect(content).toContain('getManilaMonthKey');

    // Month filter must compare getManilaMonthKey
    expect(content).toContain('getManilaMonthKey(pass.issuedAt.toDate()) === targetKey');

    // Reporting month must use formatManilaMonthYear
    expect(content).toContain('const monthLabel = formatManilaMonthYear(exportedAt);');
    expect(content).toContain('const monthLabel = formatManilaMonthYear(printedAt);');

    // Download file name must use getManilaMonthKey
    expect(content).toContain('`e-gatepass-${getManilaMonthKey(exportedAt)}-report.csv`');
  });
});
