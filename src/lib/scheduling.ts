export const MANILA_TIMEZONE = 'Asia/Manila';
export const DEFAULT_SCHEDULING_DAYS_AHEAD = 30;

/**
 * Returns today's calendar date in Asia/Manila as 'YYYY-MM-DD'.
 */
export function getManilaDateString(date: Date = new Date()): string {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: MANILA_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return formatter.format(date);
}

/**
 * Given a Manila base date string 'YYYY-MM-DD' and days ahead,
 * calculates the maximum allowed visit date string 'YYYY-MM-DD'.
 */
export function getLatestVisitDateString(
  baseManilaDateStr: string,
  schedulingDaysAhead: number = DEFAULT_SCHEDULING_DAYS_AHEAD
): string {
  const [yearStr, monthStr, dayStr] = baseManilaDateStr.split('-');
  const year = Number(yearStr);
  const month = Number(monthStr);
  const day = Number(dayStr);
  const base = new Date(Date.UTC(year, month - 1, day));
  base.setUTCDate(base.getUTCDate() + schedulingDaysAhead);
  const y = base.getUTCFullYear();
  const m = String(base.getUTCMonth() + 1).padStart(2, '0');
  const d = String(base.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Validates whether visitDate is within the allowed Manila date window.
 */
export function validateVisitDate(
  visitDate: string,
  now: Date = new Date(),
  schedulingDaysAhead: number = DEFAULT_SCHEDULING_DAYS_AHEAD
): { valid: boolean; error?: string } {
  if (!visitDate || !/^\d{4}-\d{2}-\d{2}$/.test(visitDate)) {
    return { valid: false, error: 'Please select a visit date' };
  }
  const todayManila = getManilaDateString(now);
  if (visitDate < todayManila) {
    return { valid: false, error: 'Visit date cannot be earlier than today.' };
  }
  const maxDateManila = getLatestVisitDateString(todayManila, schedulingDaysAhead);
  if (visitDate > maxDateManila) {
    return {
      valid: false,
      error: `Visit date must be within the allowed ${schedulingDaysAhead}-day scheduling window.`,
    };
  }
  return { valid: true };
}

/**
 * Returns the Manila calendar-day validity window for a given occurrence timestamp.
 * Invariant (Migration 33 SQL):
 * validFrom: start of occurrence's Manila calendar day (00:00:00+08:00)
 * validUntil: start of following Manila calendar day (00:00:00+08:00)
 */
export function getManilaDayValidityWindow(occurredAt: Date | string = new Date()): {
  manilaDate: string;
  validFrom: string;
  validUntil: string;
} {
  const date = typeof occurredAt === 'string' ? new Date(occurredAt) : occurredAt;
  const manilaDate = getManilaDateString(date);
  const [yearStr, monthStr, dayStr] = manilaDate.split('-');
  const year = Number(yearStr);
  const month = Number(monthStr);
  const day = Number(dayStr);
  const nextDate = new Date(Date.UTC(year, month - 1, day + 1));
  const ny = nextDate.getUTCFullYear();
  const nm = String(nextDate.getUTCMonth() + 1).padStart(2, '0');
  const nd = String(nextDate.getUTCDate()).padStart(2, '0');
  const nextManilaDate = `${ny}-${nm}-${nd}`;
  const validFrom = `${manilaDate}T00:00:00+08:00`;
  const validUntil = `${nextManilaDate}T00:00:00+08:00`;
  return { manilaDate, validFrom, validUntil };
}
