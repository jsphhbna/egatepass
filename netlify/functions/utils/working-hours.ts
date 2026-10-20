import { Timestamp } from 'firebase-admin/firestore';

export interface WorkingHours {
  start: string;
  end: string;
  timezone: 'Asia/Manila';
}

export const DEFAULT_WORKING_HOURS: WorkingHours = {
  start: '08:00',
  end: '17:00',
  timezone: 'Asia/Manila',
};

const timePattern = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function isValidWorkingHours(value: unknown): value is WorkingHours {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.start === 'string' &&
    typeof candidate.end === 'string' &&
    candidate.timezone === 'Asia/Manila' &&
    timePattern.test(candidate.start) &&
    timePattern.test(candidate.end) &&
    candidate.start < candidate.end
  );
}

export function normalizeWorkingHours(value: unknown): WorkingHours {
  return isValidWorkingHours(value) ? value : DEFAULT_WORKING_HOURS;
}

export function parseVisitWindow(
  visitDate: string,
  configuredHours: unknown,
): { validFrom: Timestamp; validUntil: Timestamp; workingHours: WorkingHours } {
  const workingHours = normalizeWorkingHours(configuredHours);
  const validFromDate = new Date(`${visitDate}T${workingHours.start}:00+08:00`);
  const validUntilDate = new Date(`${visitDate}T${workingHours.end}:00+08:00`);
  const dateIsValid = /^\d{4}-\d{2}-\d{2}$/.test(visitDate)
    && !Number.isNaN(validFromDate.getTime())
    && !Number.isNaN(validUntilDate.getTime())
    && validFromDate.toLocaleDateString('en-CA', { timeZone: workingHours.timezone }) === visitDate
    && validUntilDate > validFromDate;
  if (!dateIsValid) throw new Error('Invalid visit date');
  return {
    validFrom: Timestamp.fromDate(validFromDate),
    validUntil: Timestamp.fromDate(validUntilDate),
    workingHours,
  };
}
