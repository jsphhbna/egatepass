import { useMemo, useState, useEffect } from 'react';
import {
  Calendar as CalendarIcon,
  ChevronLeft,
  ChevronRight,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Building2,
} from 'lucide-react';
import { getManilaDateParts } from '@/lib/manilaTime';
import { getManilaDateString } from '@/lib/scheduling';

export interface OfficeScheduleItem {
  id?: string;
  office_id?: string;
  schedule_date: string; // 'YYYY-MM-DD'
  status: 'open' | 'closed' | 'maintenance' | 'holiday' | string;
  reason?: string | null;
}

export interface CampusClosureItem {
  id?: string;
  startDate: string;
  endDate: string;
  title: string;
  description?: string | null;
  active?: boolean;
  closureType?: string;
}

export interface VisitorMonthlyCalendarProps {
  selectedOfficeId?: string;
  selectedOfficeName?: string;
  selectedDate: string; // 'YYYY-MM-DD'
  onSelectDate: (date: string) => void;
  officeSchedules?: OfficeScheduleItem[];
  campusClosures?: CampusClosureItem[];
  minDate?: string; // 'YYYY-MM-DD', defaults to Manila today
  maxDate?: string; // 'YYYY-MM-DD', defaults to 30 days ahead
}

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

export function VisitorMonthlyCalendar({
  selectedOfficeId,
  selectedOfficeName,
  selectedDate,
  onSelectDate,
  officeSchedules = [],
  campusClosures = [],
  minDate: propMinDate,
  maxDate: propMaxDate,
}: VisitorMonthlyCalendarProps) {
  const manilaToday = useMemo(() => {
    const parts = getManilaDateParts();
    const str = getManilaDateString();
    return { ...parts, str };
  }, []);

  const minDate = propMinDate || manilaToday.str;
  const maxDate = propMaxDate || getManilaDateString(new Date(Date.now() + 30 * 86400000));

  // Calendar view year and month (1-12)
  const [viewYear, setViewYear] = useState<number>(manilaToday.year);
  const [viewMonth, setViewMonth] = useState<number>(manilaToday.month);

  // When office changes, ensure we view current Manila month
  useEffect(() => {
    if (selectedOfficeId) {
      setViewYear(manilaToday.year);
      setViewMonth(manilaToday.month);
    }
  }, [selectedOfficeId, manilaToday.year, manilaToday.month]);

  // Determine bounds for month navigation
  const minYear = parseInt(minDate.split('-')[0]!, 10);
  const minMonth = parseInt(minDate.split('-')[1]!, 10);
  const maxYear = parseInt(maxDate.split('-')[0]!, 10);
  const maxMonth = parseInt(maxDate.split('-')[1]!, 10);

  const canPrevMonth = viewYear > minYear || (viewYear === minYear && viewMonth > minMonth);
  const canNextMonth = viewYear < maxYear || (viewYear === maxYear && viewMonth < maxMonth);

  const prevMonth = () => {
    if (!canPrevMonth) return;
    if (viewMonth === 1) {
      setViewYear((y) => y - 1);
      setViewMonth(12);
    } else {
      setViewMonth((m) => m - 1);
    }
  };

  const nextMonth = () => {
    if (!canNextMonth) return;
    if (viewMonth === 12) {
      setViewYear((y) => y + 1);
      setViewMonth(1);
    } else {
      setViewMonth((m) => m + 1);
    }
  };

  // Helper to check status of any date
  const getDateInfo = (dateKey: string) => {
    const isPast = dateKey < minDate;
    const isBeyondMax = dateKey > maxDate;

    // Campus closures
    const campusMatch = campusClosures.find(
      (c) => c.active !== false && dateKey >= c.startDate && dateKey <= c.endDate
    );

    // Office schedules
    const officeMatch = officeSchedules.find((s) => s.schedule_date === dateKey);

    let isOfficeClosed = false;
    let statusType: 'open' | 'closed' | 'maintenance' | 'holiday' = 'open';

    if (officeMatch) {
      if (['closed', 'maintenance', 'holiday'].includes(officeMatch.status)) {
        isOfficeClosed = true;
        statusType = officeMatch.status as 'closed' | 'maintenance' | 'holiday';
      } else {
        statusType = 'open';
      }
    }

    const isCampusClosed = !!campusMatch;
    const isClosed = isPast || isBeyondMax || isCampusClosed || isOfficeClosed;
    const isSelectable = !isClosed;

    return {
      dateKey,
      isPast,
      isBeyondMax,
      isCampusClosed,
      campusMatch,
      isOfficeClosed,
      officeMatch,
      statusType,
      isClosed,
      isSelectable,
    };
  };

  // Selected date info for the banner
  const selectedDateInfo = selectedDate ? getDateInfo(selectedDate) : null;

  if (!selectedOfficeId) {
    return (
      <div
        data-testid="visitor-monthly-calendar-placeholder"
        className="rounded-xl border border-dashed border-[var(--color-border)] bg-[var(--color-surface-subtle)] p-6 text-center"
      >
        <Building2 className="mx-auto h-8 w-8 text-[var(--color-text-muted)] opacity-60 mb-2" />
        <p className="text-sm font-semibold text-[var(--color-text-secondary)]">
          Select a destination office first
        </p>
        <p className="text-xs text-[var(--color-text-muted)] mt-1">
          The office's availability schedule and monthly calendar will appear here.
        </p>
      </div>
    );
  }

  const daysInMonth = new Date(viewYear, viewMonth, 0).getDate();
  const firstDayOfWeek = new Date(viewYear, viewMonth - 1, 1).getDay(); // 0 is Sunday

  const days = [];
  // Blank days
  for (let i = 0; i < firstDayOfWeek; i++) {
    days.push(<div key={`blank-${i}`} className="min-h-[56px] p-1" />);
  }

  // Days of month
  for (let d = 1; d <= daysInMonth; d++) {
    const dStr = String(d).padStart(2, '0');
    const mStr = String(viewMonth).padStart(2, '0');
    const dateKey = `${viewYear}-${mStr}-${dStr}`;
    const info = getDateInfo(dateKey);
    const isSelected = selectedDate === dateKey;
    const isToday = dateKey === manilaToday.str;

    let cellBadge = null;
    let cellBg = 'bg-white hover:bg-slate-50 border-slate-200 text-slate-800';

    if (info.isPast || info.isBeyondMax) {
      cellBg = 'bg-slate-50 border-slate-100 text-slate-400 cursor-not-allowed opacity-50';
    } else if (info.isCampusClosed) {
      cellBg = 'bg-rose-50/60 border-rose-200 text-rose-900 cursor-not-allowed';
      cellBadge = (
        <span className="text-[9px] font-bold text-rose-700 bg-rose-100 border border-rose-300 rounded px-1 py-0.5 truncate max-w-full">
          Campus Closed
        </span>
      );
    } else if (info.isOfficeClosed) {
      if (info.statusType === 'holiday') {
        cellBg = 'bg-purple-50/60 border-purple-200 text-purple-900 cursor-not-allowed';
        cellBadge = (
          <span className="text-[9px] font-bold text-purple-700 bg-purple-100 border border-purple-300 rounded px-1 py-0.5 truncate max-w-full">
            Holiday
          </span>
        );
      } else if (info.statusType === 'maintenance') {
        cellBg = 'bg-amber-50/60 border-amber-200 text-amber-900 cursor-not-allowed';
        cellBadge = (
          <span className="text-[9px] font-bold text-amber-700 bg-amber-100 border border-amber-300 rounded px-1 py-0.5 truncate max-w-full">
            Maint.
          </span>
        );
      } else {
        cellBg = 'bg-rose-50/60 border-rose-200 text-rose-900 cursor-not-allowed';
        cellBadge = (
          <span className="text-[9px] font-bold text-rose-700 bg-rose-100 border border-rose-300 rounded px-1 py-0.5 truncate max-w-full">
            Closed
          </span>
        );
      }
    } else {
      // Open and selectable
      if (isSelected) {
        cellBg = 'bg-[#7A0A0A]/10 border-[#7A0A0A] ring-2 ring-[#7A0A0A] text-[#7A0A0A] shadow-sm font-black';
      }
      cellBadge = (
        <span className="text-[9px] font-semibold text-emerald-700 bg-emerald-50 rounded px-1 py-0.5">
          Open
        </span>
      );
    }

    days.push(
      <button
        key={dateKey}
        type="button"
        data-testid={`calendar-day-${dateKey}`}
        disabled={!info.isSelectable}
        onClick={() => {
          if (info.isSelectable) {
            onSelectDate(dateKey);
          }
        }}
        aria-label={`${dateKey}${info.isClosed ? ' (Unavailable)' : ' (Available)'}`}
        className={`min-h-[56px] p-1.5 rounded-xl border flex flex-col justify-between text-left transition-all relative ${cellBg}`}
      >
        <div className="flex items-center justify-between w-full">
          <span className={`text-xs ${isSelected ? 'font-black text-[#7A0A0A]' : 'font-bold'}`}>
            {d}
          </span>
          {isToday && (
            <span className="text-[8px] font-black uppercase tracking-wider text-blue-600 bg-blue-50 border border-blue-200 rounded px-1 py-0.2">
              Today
            </span>
          )}
        </div>
        <div className="w-full overflow-hidden">{cellBadge}</div>
      </button>
    );
  }

  return (
    <div
      data-testid="visitor-monthly-calendar"
      className="rounded-2xl border border-[var(--color-border)] bg-white p-4 shadow-sm space-y-4"
    >
      {/* Calendar Header with Navigation */}
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2">
            <CalendarIcon className="h-4 w-4 text-[#7A0A0A]" />
            <h4 className="text-sm font-bold text-[var(--color-text-primary)]">
              {MONTH_NAMES[viewMonth - 1]} {viewYear}
            </h4>
          </div>
          <p className="text-[11px] text-[var(--color-text-muted)] mt-0.5">
            Availability for <span className="font-semibold text-[var(--color-text-secondary)]">{selectedOfficeName || 'Selected Office'}</span>
          </p>
        </div>

        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={prevMonth}
            disabled={!canPrevMonth}
            aria-label="Previous Month"
            className="p-1.5 rounded-lg border border-[var(--color-border)] text-[var(--color-text-secondary)] hover:bg-slate-100 disabled:opacity-30 disabled:cursor-not-allowed"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={nextMonth}
            disabled={!canNextMonth}
            aria-label="Next Month"
            className="p-1.5 rounded-lg border border-[var(--color-border)] text-[var(--color-text-secondary)] hover:bg-slate-100 disabled:opacity-30 disabled:cursor-not-allowed"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Days of week header */}
      <div className="grid grid-cols-7 gap-1 text-center text-[10px] font-bold uppercase tracking-wider text-[var(--color-text-muted)] pb-1 border-b border-[var(--color-border)]">
        <span>Sun</span>
        <span>Mon</span>
        <span>Tue</span>
        <span>Wed</span>
        <span>Thu</span>
        <span>Fri</span>
        <span>Sat</span>
      </div>

      {/* Interactive Grid */}
      <div className="grid grid-cols-7 gap-1">{days}</div>

      {/* Prominent Status Banner for Selected Date */}
      {selectedDateInfo && (
        <div
          data-testid="calendar-status-banner"
          className="rounded-xl border p-3.5 transition-all"
        >
          {selectedDateInfo.isCampusClosed ? (
            <div className="flex items-start gap-2.5 text-rose-900 border-rose-300 bg-rose-50 rounded-lg p-2.5">
              <XCircle className="h-5 w-5 text-rose-700 shrink-0 mt-0.5" />
              <div className="text-xs">
                <p className="font-bold">Campus is Closed on {selectedDate}</p>
                <p className="mt-0.5">
                  {selectedDateInfo.campusMatch?.title}
                  {selectedDateInfo.campusMatch?.description
                    ? ` — ${selectedDateInfo.campusMatch.description}`
                    : ''}
                  . Please choose an open date.
                </p>
              </div>
            </div>
          ) : selectedDateInfo.isOfficeClosed ? (
            <div className="flex items-start gap-2.5 text-amber-900 border-amber-300 bg-amber-50 rounded-lg p-2.5">
              <AlertTriangle className="h-5 w-5 text-amber-700 shrink-0 mt-0.5" />
              <div className="text-xs">
                <p className="font-bold">
                  {selectedOfficeName || 'Office'} is {selectedDateInfo.statusType.toUpperCase()} on {selectedDate}
                </p>
                <p className="mt-0.5">
                  {selectedDateInfo.officeMatch?.reason || 'The office has scheduled a closure on this date.'}{' '}
                  Please choose another date when the office is open.
                </p>
              </div>
            </div>
          ) : (
            <div className="flex items-start gap-2.5 text-emerald-900 border-emerald-300 bg-emerald-50 rounded-lg p-2.5">
              <CheckCircle2 className="h-5 w-5 text-emerald-700 shrink-0 mt-0.5" />
              <div className="text-xs">
                <p className="font-bold">
                  {selectedOfficeName || 'Office'} is Open on {selectedDate}
                </p>
                <p className="mt-0.5 text-emerald-800">
                  Normal operating hours apply. Your pass will be valid for entry on this date.
                </p>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Legend */}
      <div className="flex flex-wrap items-center gap-3 pt-2 border-t border-[var(--color-border)] text-[10px] text-[var(--color-text-secondary)]">
        <span className="flex items-center gap-1">
          <span className="h-2 w-2 rounded-full bg-emerald-500 inline-block" /> Open
        </span>
        <span className="flex items-center gap-1">
          <span className="h-2 w-2 rounded-full bg-rose-500 inline-block" /> Closed / Holiday
        </span>
        <span className="flex items-center gap-1">
          <span className="h-2 w-2 rounded-full bg-amber-500 inline-block" /> Maintenance
        </span>
        <span className="flex items-center gap-1">
          <span className="h-2 w-2 rounded-full bg-slate-300 inline-block" /> Past / Outside Horizon
        </span>
      </div>
    </div>
  );
}
