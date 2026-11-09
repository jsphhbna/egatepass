export type CalendarClosureType = 'holiday' | 'campus_closure';

export interface CampusCalendarClosure {
  id: string;
  title: string;
  closureType: CalendarClosureType;
  startDate: string;
  endDate: string;
  description: string | null;
  active: boolean;
  published: boolean;
  createdBy?: string | null;
  updatedBy?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export function isDateInClosure(date: string, closure: { startDate: string; endDate: string; active?: boolean }): boolean {
  if (closure.active === false) return false;
  return date >= closure.startDate && date <= closure.endDate;
}
