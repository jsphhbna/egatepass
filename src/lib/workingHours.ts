import type { AppSettings } from '@/types';

export type WorkingHours = AppSettings['workingHours'];

export const DEFAULT_WORKING_HOURS: WorkingHours = {
  start: '08:00',
  end: '17:00',
  timezone: 'Asia/Manila',
};

export const MAX_VISIT_ADVANCE_DAYS = 30;

const timePattern = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function normalizeWorkingHours(value: unknown): WorkingHours {
  if (typeof value !== 'object' || value === null) return DEFAULT_WORKING_HOURS;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.start !== 'string' ||
    typeof candidate.end !== 'string' ||
    candidate.timezone !== 'Asia/Manila' ||
    !timePattern.test(candidate.start) ||
    !timePattern.test(candidate.end) ||
    candidate.start >= candidate.end
  ) return DEFAULT_WORKING_HOURS;
  return candidate as unknown as WorkingHours;
}

function formatTime(time: string): string {
  const [hoursText = '0', minutesText = '0'] = time.split(':');
  const hours = Number(hoursText);
  const minutes = Number(minutesText);
  const suffix = hours >= 12 ? 'PM' : 'AM';
  const displayHour = hours % 12 || 12;
  return `${String(displayHour).padStart(2, '0')}:${String(minutes).padStart(2, '0')} ${suffix}`;
}

export function formatWorkingHours(hours: WorkingHours): string {
  return `${formatTime(hours.start)} - ${formatTime(hours.end)}`;
}

export function formatValidityWindow(validFrom: string, validUntil: string): string {
  const formatter = new Intl.DateTimeFormat('en-PH', {
    timeZone: 'Asia/Manila',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  });
  return `${formatter.format(new Date(validFrom))} - ${formatter.format(new Date(validUntil))}`;
}
