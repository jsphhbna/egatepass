/**
 * Asia/Manila Institutional Presentation Invariant Helpers
 *
 * Ensures all operational date/time displays format in Asia/Manila
 * regardless of the client machine, tablet, or kiosk local timezone.
 */

export const MANILA_TIMEZONE = 'Asia/Manila';

export type DateInput = Date | string | number | null | undefined;

function toDate(input: DateInput): Date | null {
  if (input === null || input === undefined) return null;
  const d = input instanceof Date ? input : new Date(input);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Format a date in Asia/Manila: e.g. "Oct 22, 2026"
 */
export function formatManilaDate(
  input: DateInput,
  options?: Intl.DateTimeFormatOptions
): string {
  const d = toDate(input);
  if (!d) return '—';
  return new Intl.DateTimeFormat('en-US', {
    timeZone: MANILA_TIMEZONE,
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    ...options,
  }).format(d);
}

/**
 * Format a time in Asia/Manila: e.g. "8:30 AM" or "08:30:00 AM"
 */
export function formatManilaTime(
  input: DateInput,
  options?: Intl.DateTimeFormatOptions
): string {
  const d = toDate(input);
  if (!d) return '—';
  return new Intl.DateTimeFormat('en-US', {
    timeZone: MANILA_TIMEZONE,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    ...options,
  }).format(d);
}

/**
 * Format date and time in Asia/Manila: e.g. "Oct 22, 2026, 8:30 AM"
 */
export function formatManilaDateTime(
  input: DateInput,
  options?: Intl.DateTimeFormatOptions
): string {
  const d = toDate(input);
  if (!d) return '—';
  return new Intl.DateTimeFormat('en-US', {
    timeZone: MANILA_TIMEZONE,
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    ...options,
  }).format(d);
}

/**
 * Format ISO-like timestamp in Asia/Manila: "YYYY-MM-DD HH:mm:ss"
 */
export function formatManilaIso(input: DateInput): string {
  const d = toDate(input);
  if (!d) return '—';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: MANILA_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(d);

  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '00';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')}`;
}

/**
 * Returns today's calendar date in Asia/Manila as 'YYYY-MM-DD'.
 */
export function getManilaDateString(date: DateInput = new Date()): string {
  const d = toDate(date) ?? new Date();
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: MANILA_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

/**
 * Format a timestamp for file naming in Asia/Manila: "YYYYMMDD_HHmmss"
 */
export function formatManilaFileTimestamp(input: DateInput = new Date()): string {
  const d = toDate(input) ?? new Date();
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: MANILA_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(d);

  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '00';
  return get('year') + get('month') + get('day') + '_' + get('hour') + get('minute') + get('second');
}

/**
 * Format a month and year in Asia/Manila: e.g. "October 2026"
 */
export function formatManilaMonthYear(input: DateInput): string {
  const d = toDate(input);
  if (!d) return '—';
  return new Intl.DateTimeFormat('en-US', {
    timeZone: MANILA_TIMEZONE,
    month: 'long',
    year: 'numeric',
  }).format(d);
}

/**
 * Returns the month key in Asia/Manila: e.g. "2026-10"
 */
export function getManilaMonthKey(input: DateInput): string {
  const d = toDate(input);
  if (!d) return '';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: MANILA_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(d);
  const year = parts.find((p) => p.type === 'year')?.value ?? '1970';
  const month = parts.find((p) => p.type === 'month')?.value ?? '01';
  return `${year}-${month}`;
}

/**
 * Returns deconstructed date parts in Asia/Manila (year, month 1-12, day, YYYY-MM-DD string, YYYY-MM monthKey).
 */
export function getManilaDateParts(input: DateInput = new Date()): {
  year: number;
  month: number;
  day: number;
  dateString: string;
  monthKey: string;
} {
  const d = toDate(input) ?? new Date();
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: MANILA_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(d);

  const year = parseInt(parts.find((p) => p.type === 'year')?.value ?? '1970', 10);
  const month = parseInt(parts.find((p) => p.type === 'month')?.value ?? '1', 10);
  const day = parseInt(parts.find((p) => p.type === 'day')?.value ?? '1', 10);
  const dateString = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  const monthKey = `${year}-${String(month).padStart(2, '0')}`;

  return { year, month, day, dateString, monthKey };
}


export type DatePresetKey = 'today' | 'yesterday' | 'thisWeek' | 'last7' | 'thisMonth';

/**
 * Returns canonical Asia/Manila date bounds for reporting presets:
 * - 'today': current calendar day in Manila
 * - 'yesterday': prior calendar day in Manila
 * - 'thisWeek': current week start (Monday) through current day
 * - 'last7': past 7 days ending today
 * - 'thisMonth': 1st of current month through current day
 */
export function getManilaDatePresetRange(
  preset: DatePresetKey,
  referenceDate: DateInput = new Date()
): { from: string; to: string } {
  const parts = getManilaDateParts(referenceDate);
  const today = parts.dateString;
  const refNoon = new Date(`${today}T12:00:00+08:00`);

  if (preset === 'today') {
    return { from: today, to: today };
  }

  if (preset === 'yesterday') {
    const yesterdayDate = new Date(refNoon.getTime() - 24 * 60 * 60 * 1000);
    const yesterdayStr = getManilaDateString(yesterdayDate);
    return { from: yesterdayStr, to: yesterdayStr };
  }

  if (preset === 'thisWeek') {
    const dayOfWeek = refNoon.getDay(); // 0=Sun, 1=Mon, ..., 6=Sat
    const daysSinceMonday = (dayOfWeek + 6) % 7;
    const mondayDate = new Date(refNoon.getTime() - daysSinceMonday * 24 * 60 * 60 * 1000);
    return { from: getManilaDateString(mondayDate), to: today };
  }

  if (preset === 'last7') {
    const sevenDaysAgo = new Date(refNoon.getTime() - 6 * 24 * 60 * 60 * 1000);
    return { from: getManilaDateString(sevenDaysAgo), to: today };
  }

  if (preset === 'thisMonth') {
    const firstOfMonth = `${parts.year}-${String(parts.month).padStart(2, '0')}-01`;
    return { from: firstOfMonth, to: today };
  }

  return { from: today, to: today };
}
