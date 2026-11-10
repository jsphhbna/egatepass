import { describe, it, expect } from 'vitest';
import {
  getManilaDatePresetRange,
  getManilaDateParts,
  getManilaDateString,
  type DatePresetKey,
} from '../src/lib/manilaTime';
import { sanitizeSpreadsheetText } from '../src/lib/reportExport';
import { escapeCsvCell } from '../src/lib/completeExport';

describe('Reporting Daily Presets & Date Bounds (Phase E)', () => {
  it('computes exact single-day bounds for "today" preset in Asia/Manila', () => {
    const fixedNow = new Date('2026-11-10T14:30:00+08:00');
    const range = getManilaDatePresetRange('today', fixedNow);
    expect(range.from).toBe('2026-11-10');
    expect(range.to).toBe('2026-11-10');
  });

  it('computes exact single-day bounds for "yesterday" preset in Asia/Manila', () => {
    const fixedNow = new Date('2026-11-10T02:30:00+08:00'); // Early morning Manila
    const range = getManilaDatePresetRange('yesterday', fixedNow);
    expect(range.from).toBe('2026-11-09');
    expect(range.to).toBe('2026-11-09');
  });

  it('computes "thisWeek" starting on Monday in Asia/Manila', () => {
    // 2026-11-10 is Tuesday. Monday was 2026-11-09.
    const fixedNow = new Date('2026-11-10T12:00:00+08:00');
    const range = getManilaDatePresetRange('thisWeek', fixedNow);
    expect(range.from).toBe('2026-11-09');
    expect(range.to).toBe('2026-11-10');
  });

  it('computes "last7" rolling 7 days including today', () => {
    const fixedNow = new Date('2026-11-10T12:00:00+08:00');
    const range = getManilaDatePresetRange('last7', fixedNow);
    expect(range.from).toBe('2026-11-04');
    expect(range.to).toBe('2026-11-10');
  });

  it('computes "thisMonth" from 1st of month to current day', () => {
    const fixedNow = new Date('2026-11-10T12:00:00+08:00');
    const range = getManilaDatePresetRange('thisMonth', fixedNow);
    expect(range.from).toBe('2026-11-01');
    expect(range.to).toBe('2026-11-10');
  });

  it('sanitizes formula injection in CSV text cells', () => {
    expect(sanitizeSpreadsheetText('=SUM(A1:A10)')).toBe("'=SUM(A1:A10)");
    expect(sanitizeSpreadsheetText('+12345')).toBe("'+12345");
    expect(sanitizeSpreadsheetText('-calc')).toBe("'-calc");
    expect(sanitizeSpreadsheetText('@dangerous')).toBe("'@dangerous");
    expect(sanitizeSpreadsheetText('Normal Visitor Name')).toBe('Normal Visitor Name');
  });

  it('escapes cells safely in completeExport', () => {
    expect(escapeCsvCell('=1+1')).toBe('"\'=1+1"');
    expect(escapeCsvCell('Hello, World')).toBe('"Hello, World"');
    expect(escapeCsvCell('Name with "quotes"')).toBe('"Name with ""quotes"""');
  });
});
