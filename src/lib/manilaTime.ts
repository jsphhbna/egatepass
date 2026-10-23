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
