import {
  getManilaDateString,
  getManilaMonthKey,
  formatManilaTime,
  formatManilaMonthYear,
  getManilaDateParts,
  type DateInput,
} from '@/lib/manilaTime';
import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  eachDayOfInterval,
  endOfWeek,
  format,
  startOfWeek,
} from 'date-fns';
import {
  AlertCircle,
  AlertTriangle,
  Loader2,
  ArrowLeftCircle,
  ArrowRightCircle,
  Calendar,
  MapPin,
  MessageSquareText,
  RefreshCw,
  ShieldAlert,
  Sparkles,
  Users,
} from 'lucide-react';
import { Button, Card, Input, Select, Skeleton, StatCard, StatusBadge } from '@/components/ui';
import {
  DashboardExportActions,
  type DashboardExportTruncationInfo,
} from '@/components/DashboardExportActions';
import {
  refreshAdminDashboardData,
  setDashboardPeriodQuery,
  useAdminDashboardData,
  type DashboardPeriodQuery,
  type DashboardPeriodType,
} from '@/hooks/useAdminDashboardData';
import type { GatePass } from '@/types';

function mostCommon(values: Array<string | null | undefined>): { label: string; count: number } {
  const counts = new Map<string, number>();
  values.forEach((value) => {
    const normalized = value?.trim();
    if (normalized) counts.set(normalized, (counts.get(normalized) || 0) + 1);
  });

  let result = { label: 'No data yet', count: 0 };
  counts.forEach((count, label) => {
    if (count > result.count) result = { label, count };
  });
  return result;
}

function averageApprovalTime(passes: GatePass[]): string {
  const durations = passes.flatMap((pass) => {
    if (!pass.scannedAt || !pass.timeIn) return [];
    const duration = pass.timeIn.toMillis() - pass.scannedAt.toMillis();
    return duration >= 0 ? [duration] : [];
  });
  if (durations.length === 0) return '—';

  const averageSeconds = Math.round(
    durations.reduce((total, duration) => total + duration, 0) / durations.length / 1000
  );
  return averageSeconds < 60 ? `${averageSeconds}s` : `${Math.round(averageSeconds / 60)}m`;
}

export function AdminDashboard() {
  const dashboard = useAdminDashboardData();
  const [retrying, setRetrying] = useState(false);
  const [searchParams] = useSearchParams();
  const currentTab = (searchParams.get('tab') as 'overview' | 'analytics' | 'reports') || 'overview';

  const initialManilaParts = getManilaDateParts();
  const [periodType, setPeriodType] = useState<DashboardPeriodType>('today');
  const [selectedDate, setSelectedDate] = useState<string>(() => getManilaDateString());
  const [selectedMonth, setSelectedMonth] = useState<string>(() => getManilaMonthKey(new Date()));
  const [selectedYear, setSelectedYear] = useState<string>(() => String(initialManilaParts.year));
  const [rangeFrom, setRangeFrom] = useState<string>(() => getManilaDateString());
  const [rangeTo, setRangeTo] = useState<string>(() => getManilaDateString());
  const [periodError, setPeriodError] = useState<string | null>(null);
  const [appliedPeriodQuery, setAppliedPeriodQuery] = useState<DashboardPeriodQuery>({ period: 'today' });
  const [reportTruncation, setReportTruncation] = useState<DashboardExportTruncationInfo | null>(null);

  async function applyPeriodFilter(nextType: DashboardPeriodType = periodType) {
    setPeriodError(null);
    let nextQuery: DashboardPeriodQuery = { period: nextType };
    if (nextType === 'date') {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(selectedDate)) {
        setPeriodError('Choose a valid calendar date.');
        return;
      }
      nextQuery = { period: 'date', date: selectedDate };
    } else if (nextType === 'month') {
      if (!/^\d{4}-\d{2}$/.test(selectedMonth)) {
        setPeriodError('Choose a valid month.');
        return;
      }
      nextQuery = { period: 'month', month: selectedMonth };
    } else if (nextType === 'year') {
      if (!/^\d{4}$/.test(selectedYear)) {
        setPeriodError('Enter a 4-digit year (e.g. 2026).');
        return;
      }
      nextQuery = { period: 'year', year: selectedYear };
    } else if (nextType === 'range') {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(rangeFrom) || !/^\d{4}-\d{2}-\d{2}$/.test(rangeTo)) {
        setPeriodError('Enter valid start and end dates.');
        return;
      }
      if (rangeFrom > rangeTo) {
        setPeriodError('Start date cannot be after end date.');
        return;
      }
      nextQuery = { period: 'range', dateFrom: rangeFrom, dateTo: rangeTo };
    }
    setReportTruncation(null);
    setAppliedPeriodQuery(nextQuery);
    await setDashboardPeriodQuery(nextQuery);
  }

  async function handleRetry() {
    if (retrying) return;
    setRetrying(true);
    try {
      await refreshAdminDashboardData();
    } finally {
      setRetrying(false);
    }
  }
  const metrics = useMemo(() => {
    const todayManila = getManilaDateString();
    const todayPasses = dashboard.recentPasses.filter((pass) => getManilaDateString(pass.issuedAt.toDate()) === todayManila);
    const counts = dashboard.counts;

    // Expected Visitors Today: online visitors with valid issued QR pass for today's date in Asia/Manila,
    // excluding unissued, pending, kiosk, or cancelled. Query database counts directly when available.
    const expectedToday = counts?.expectedVisitorsToday ?? dashboard.recentPasses.filter((pass) => {
      const passDate = pass.validFrom ? getManilaDateString(pass.validFrom.toDate()) : getManilaDateString(pass.issuedAt.toDate());
      return (
        passDate === todayManila &&
        pass.source !== 'kiosk' &&
        (pass.status === 'issued' || pass.status === 'inside' || pass.status === 'exited')
      );
    }).length;

    return {
      todayTotal: counts ? counts.todayTotal : todayPasses.length,
      expectedToday,
      monthTotal: counts?.monthTotal ?? 0,
      currentlyInside: counts ? counts.currentlyInside : dashboard.insidePasses.length,
      exitedToday: counts ? counts.exitedToday : dashboard.exitedTodayPasses.length,
      avgApprovalTime: dashboard.insights?.avgApprovalTime ?? averageApprovalTime(dashboard.decisionsTodayPasses),
      topPurpose: dashboard.insights?.topPurpose ?? mostCommon(todayPasses.map((pass) => pass.purpose?.split(' — ')[0]?.trim())),
      busiestGate: dashboard.insights?.busiestGate ?? mostCommon(dashboard.decisionsTodayPasses.map((pass) => pass.gate)),
      calendarPasses: dashboard.recentPasses,
      calendarCounts: dashboard.calendarCounts,
    };
  }, [dashboard]);

  const exportSummary = {
    visitorsToday: metrics.todayTotal,
    expectedToday: metrics.expectedToday,
    monthTotal: metrics.monthTotal,
    currentlyInside: metrics.currentlyInside,
    exitedToday: metrics.exitedToday,
    pendingApproval: 0,
    rejectedToday: 0,
    insights: [
      {
        title: 'Top Visit Purpose',
        value: metrics.topPurpose.label,
        count: metrics.topPurpose.count,
        description: 'Most common visit purpose among passes created today.',
      },
      {
        title: 'Busiest Entry Gate',
        value: metrics.busiestGate.label,
        count: metrics.busiestGate.count,
        description: 'Gate with the most visitor scans recorded today.',
      },
    ],
  };

  if (dashboard.loading) return <DashboardSkeleton />;

  if (dashboard.error) {
    return (
      <Card className="mx-auto mt-12 max-w-lg text-center">
        <AlertCircle className="mx-auto h-10 w-10 text-[var(--color-danger)]" aria-hidden="true" />
        <h1 className="mt-4 text-xl font-bold text-[var(--color-text-primary)]">Dashboard unavailable</h1>
        <p className="mt-2 text-sm text-[var(--color-text-secondary)]">{dashboard.error}</p>
        <Button onClick={handleRetry} loading={retrying} disabled={retrying} icon={!retrying ? <RefreshCw className="h-4 w-4" /> : undefined} className="mt-5">
          {retrying ? 'Retrying…' : 'Try Again'}
        </Button>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <header className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-[var(--color-text-primary)]">Dashboard</h1>
          <p className="mt-1 text-sm text-[var(--color-text-secondary)]">
            A live overview of campus visitor activity and guard decisions.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2 text-xs font-medium" role="status" aria-live="polite">
            {dashboard.refreshing ? (
              <span className="flex items-center gap-1.5 text-[var(--color-text-secondary)]">
                <Loader2 className="h-3.5 w-3.5 animate-spin text-[var(--color-brand)] shrink-0" aria-hidden="true" />
                Updating…
              </span>
            ) : dashboard.refreshError && dashboard.updatedAt ? (
              <span className="flex items-center gap-1.5 text-amber-700 font-semibold bg-amber-50 border border-amber-200 rounded px-2 py-0.5">
                <AlertCircle className="h-3.5 w-3.5 text-amber-600 shrink-0" aria-hidden="true" />
                Update delayed — showing data from {formatManilaTime(dashboard.updatedAt)}.
              </span>
            ) : (
              <>
                <span className="h-2 w-2 rounded-full bg-[var(--color-success)]" aria-hidden="true" />
                <span className="text-[var(--color-success)]">Live updates</span>
                {dashboard.updatedAt && (
                  <span className="text-[var(--color-text-muted)]">· Updated {formatManilaTime(dashboard.updatedAt)}</span>
                )}
              </>
            )}
          </div>
          <DashboardExportActions
            passes={metrics.calendarPasses}
            summary={exportSummary}
            periodQuery={appliedPeriodQuery}
            periodLabel={dashboard.periodMeta?.label}
            onReportTruncation={setReportTruncation}
          />
        </div>
      </header>

      {(reportTruncation?.truncated || dashboard.offlineModeMetrics?.truncated) && (
        <div
          role="alert"
          className="flex items-start gap-2.5 rounded-lg border border-amber-300 bg-amber-50 p-3.5 text-xs text-amber-950"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-700" aria-hidden="true" />
          <div>
            <p className="font-bold">Export / Dataset Truncation Notice</p>
            <p className="mt-0.5">
              {reportTruncation?.truncated
                ? `Complete report export returned the first ${reportTruncation.maxRows.toLocaleString()} of ${reportTruncation.totalMatchingCount.toLocaleString()} matching QR pass rows. `
                : null}
              {dashboard.offlineModeMetrics?.truncated
                ? `Offline Mode metrics exceed ${reportTruncation?.maxRows ?? 5000} rows (${dashboard.offlineModeMetrics.total.toLocaleString()} total recorded). `
                : null}
              Narrow your date, month, or range filter to inspect or export an untruncated slice.
            </p>
          </div>
        </div>
      )}

      {(currentTab === 'analytics' || currentTab === 'reports') && (
        <Card className="p-4">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
            <div className="flex flex-wrap items-end gap-3">
              <div className="w-44">
                <label htmlFor="dashboard-period-type" className="mb-1 flex items-center gap-1.5 text-xs font-semibold text-[var(--color-text-secondary)]">
                  <Calendar className="h-3.5 w-3.5 text-[var(--color-brand)]" />
                  Manila Period Scope
                </label>
                <Select
                  id="dashboard-period-type"
                  value={periodType}
                  onChange={(e) => {
                    const nextType = e.target.value as DashboardPeriodType;
                    setPeriodType(nextType);
                    if (nextType === 'today') {
                      void applyPeriodFilter('today');
                    }
                  }}
                >
                  <option value="today">Today (Live)</option>
                  <option value="date">Specific Date</option>
                  <option value="month">Calendar Month</option>
                  <option value="year">Calendar Year</option>
                  <option value="range">Custom Date Range</option>
                </Select>
              </div>

              {periodType === 'date' && (
                <div className="w-44">
                  <label htmlFor="dashboard-period-date" className="mb-1 block text-xs font-semibold text-[var(--color-text-secondary)]">Date (PH)</label>
                  <Input id="dashboard-period-date" type="date" value={selectedDate} onChange={(e) => setSelectedDate(e.target.value)} />
                </div>
              )}

              {periodType === 'month' && (
                <div className="w-44">
                  <label htmlFor="dashboard-period-month" className="mb-1 block text-xs font-semibold text-[var(--color-text-secondary)]">Month</label>
                  <Input id="dashboard-period-month" type="month" value={selectedMonth} onChange={(e) => setSelectedMonth(e.target.value)} />
                </div>
              )}

              {periodType === 'year' && (
                <div className="w-32">
                  <label htmlFor="dashboard-period-year" className="mb-1 block text-xs font-semibold text-[var(--color-text-secondary)]">Year</label>
                  <Input id="dashboard-period-year" type="number" min={2024} max={2099} value={selectedYear} onChange={(e) => setSelectedYear(e.target.value)} />
                </div>
              )}

              {periodType === 'range' && (
                <>
                  <div className="w-40">
                    <label htmlFor="dashboard-range-from" className="mb-1 block text-xs font-semibold text-[var(--color-text-secondary)]">From Date</label>
                    <Input id="dashboard-range-from" type="date" value={rangeFrom} onChange={(e) => setRangeFrom(e.target.value)} />
                  </div>
                  <div className="w-40">
                    <label htmlFor="dashboard-range-to" className="mb-1 block text-xs font-semibold text-[var(--color-text-secondary)]">To Date</label>
                    <Input id="dashboard-range-to" type="date" value={rangeTo} onChange={(e) => setRangeTo(e.target.value)} />
                  </div>
                </>
              )}

              <Button type="button" size="sm" onClick={() => void applyPeriodFilter(periodType)}>
                Apply Period
              </Button>
            </div>

            <div className="text-xs text-[var(--color-text-secondary)]">
              <span className="font-semibold text-[var(--color-text-primary)]">
                {dashboard.periodMeta?.label || 'Today'}
              </span>
              {' · '}
              <span>{dashboard.periodMeta?.timezone || 'Asia/Manila'} (+08:00)</span>
            </div>
          </div>
          {periodError && (
            <p role="alert" className="mt-2 text-xs font-medium text-[var(--color-danger)]">
              {periodError}
            </p>
          )}
        </Card>
      )}

      {currentTab === 'overview' && (
        <div className="space-y-6">
          <section aria-labelledby="visitor-stats-heading">
            <h2 id="visitor-stats-heading" className="sr-only">Visitor statistics</h2>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
              <StatCard title="Visitors Today" value={metrics.todayTotal} icon={<Users className="h-5 w-5 text-[var(--color-brand)]" />} description="Passes created since midnight." />
              <StatCard title="Expected Visitors Today" value={metrics.expectedToday} icon={<Calendar className="h-5 w-5 text-indigo-600" />} description="Online visitors with valid QR pass for today." />
              <StatCard title="Currently Inside" value={metrics.currentlyInside} icon={<ArrowRightCircle className="h-5 w-5 text-[var(--color-success)]" />} description="All approved visitors who have not exited." />
              <StatCard title="Exited Today" value={metrics.exitedToday} icon={<ArrowLeftCircle className="h-5 w-5 text-[var(--color-text-secondary)]" />} description="Visits with an exit time recorded today." />
              <StatCard title="Avg Approval Time" value={metrics.avgApprovalTime} icon={<Sparkles className="h-5 w-5 text-[var(--color-brand)]" />} description="Average wait from scan to approval." />
            </div>
          </section>

          <OfflineModeMetricsPanel metrics={dashboard.offlineModeMetrics} periodLabel={dashboard.periodMeta?.label} />
        </div>
      )}

      {currentTab === 'analytics' && (
        <div className="space-y-6">
          {dashboard.periodCounts && (
            <Card className="p-6">
              <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h2 className="text-lg font-bold text-[var(--color-text-primary)]">
                    Period QR Pass Breakdown — {dashboard.periodMeta?.label || 'Selected Period'}
                  </h2>
                  <p className="text-xs text-[var(--color-text-secondary)]">
                    Authoritative server-computed QR pass totals ({dashboard.periodMeta?.startDate} to {dashboard.periodMeta?.endDate} Manila).
                  </p>
                </div>
              </div>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-7">
                <PeriodMetricTile label="Total QR" value={dashboard.periodCounts.total} />
                <PeriodMetricTile label="Issued" value={dashboard.periodCounts.issued} />
                <PeriodMetricTile label="Inside" value={dashboard.periodCounts.inside} />
                <PeriodMetricTile label="Exited" value={dashboard.periodCounts.exited} />
                <PeriodMetricTile label="Pending" value={dashboard.periodCounts.pending} />
                <PeriodMetricTile label="Rejected" value={dashboard.periodCounts.rejected} />
                <PeriodMetricTile label="Expired" value={dashboard.periodCounts.expired} />
              </div>
            </Card>
          )}

          <section aria-labelledby="insights-heading">
            <div className="mb-3">
              <h2 id="insights-heading" className="text-lg font-bold text-[var(--color-text-primary)]">Period Insights</h2>
              <p className="text-sm text-[var(--color-text-secondary)]">The most common QR pass activity recorded in the selected scope.</p>
            </div>
            <div className="grid gap-4 md:grid-cols-2">
              <InsightCard icon={<MessageSquareText className="h-5 w-5" />} title="Top Visit Purpose" insight={metrics.topPurpose} description="Most common visit purpose among passes in this scope." />
              <InsightCard icon={<MapPin className="h-5 w-5" />} title="Busiest Entry Gate" insight={metrics.busiestGate} description="Gate with the most QR scans recorded in this scope." />
            </div>
          </section>

          <OfflineModeMetricsPanel metrics={dashboard.offlineModeMetrics} periodLabel={dashboard.periodMeta?.label} />

          <IssuedPassesCalendar passes={metrics.calendarPasses} calendarCounts={metrics.calendarCounts} />
        </div>
      )}

      {currentTab === 'reports' && (
        <div className="space-y-6">
          <Card className="p-6">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <h2 className="text-xl font-bold text-[var(--color-text-primary)]">Institutional Pass Reports & Export</h2>
                <p className="mt-1 text-sm text-[var(--color-text-secondary)]">
                  Export complete period-filtered visitor pass logs (up to 5,000 rows per batch with truncation warnings) in CSV, Excel, or PDF formats.
                </p>
              </div>
              <DashboardExportActions
                passes={metrics.calendarPasses}
                summary={exportSummary}
                periodQuery={appliedPeriodQuery}
                periodLabel={dashboard.periodMeta?.label}
                showCompleteFormats
                onReportTruncation={setReportTruncation}
              />
            </div>

            <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-subtle)] p-4">
                <p className="text-xs font-semibold text-[var(--color-text-muted)] uppercase tracking-wider">Period QR Total</p>
                <p className="mt-1 text-2xl font-bold text-[var(--color-text-primary)]">{dashboard.periodCounts?.total ?? metrics.todayTotal}</p>
                <p className="mt-1 text-xs text-[var(--color-text-secondary)]">{dashboard.periodMeta?.label || 'Today'}</p>
              </div>
              <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-subtle)] p-4">
                <p className="text-xs font-semibold text-[var(--color-text-muted)] uppercase tracking-wider">Month to Date</p>
                <p className="mt-2 text-2xl font-bold text-[var(--color-brand)]">{metrics.monthTotal}</p>
                <p className="mt-1 text-xs text-[var(--color-text-secondary)]">Total passes this calendar month</p>
              </div>
              <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-subtle)] p-4">
                <p className="text-xs font-semibold text-[var(--color-text-muted)] uppercase tracking-wider">Completed Visits</p>
                <p className="mt-2 text-2xl font-bold text-[var(--color-success)]">{dashboard.periodCounts?.exited ?? metrics.exitedToday}</p>
                <p className="mt-1 text-xs text-[var(--color-text-secondary)]">Visitors signed out in scope</p>
              </div>
              <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-subtle)] p-4">
                <p className="text-xs font-semibold text-[var(--color-text-muted)] uppercase tracking-wider">OFFLINE MODE RECORDED</p>
                <p className="mt-2 text-2xl font-bold text-amber-800">{dashboard.offlineModeMetrics?.total ?? 0}</p>
                <p className="mt-1 text-xs text-[var(--color-text-secondary)]">Separate from QR passes</p>
              </div>
            </div>
          </Card>

          <OfflineModeMetricsPanel metrics={dashboard.offlineModeMetrics} periodLabel={dashboard.periodMeta?.label} />
        </div>
      )}
    </div>
  );
}

function PeriodMetricTile({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-subtle)] p-3">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">{label}</p>
      <p className="mt-1 text-xl font-bold text-[var(--color-text-primary)]">{value}</p>
    </div>
  );
}

function OfflineModeMetricsPanel({
  metrics,
  periodLabel,
}: {
  metrics?: import('@/hooks/useAdminDashboardData').DashboardOfflineMetrics;
  periodLabel?: string;
}) {
  return (
    <Card className="border-amber-200 bg-amber-50/40 p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <ShieldAlert className="h-5 w-5 text-amber-700" aria-hidden="true" />
            <h2 className="text-lg font-bold text-[var(--color-text-primary)]">Emergency Offline Gate Records</h2>
            <StatusBadge status="warning" label="OFFLINE MODE RECORDED" />
          </div>
          <p className="mt-1 text-xs text-[var(--color-text-secondary)]">
            Emergency offline gate entries ({periodLabel || 'Selected Period'}) are classified permanently as{' '}
            <strong>OFFLINE MODE RECORDED</strong>, isolated from standard QR pass metrics, and never converted into QR passes.
          </p>
        </div>
      </div>
      <div className="mt-4 grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <PeriodMetricTile label="Total Offline" value={metrics?.total ?? 0} />
        <PeriodMetricTile label="Needs Review" value={metrics?.needsReview ?? 0} />
        <PeriodMetricTile label="Received" value={metrics?.received ?? 0} />
        <PeriodMetricTile label="Accepted" value={metrics?.accepted ?? 0} />
        <PeriodMetricTile label="Duplicate / Rejected" value={(metrics?.duplicate ?? 0) + (metrics?.rejected ?? 0)} />
        <PeriodMetricTile label="Policy Exception" value={metrics?.exceptionApplied ?? 0} />
      </div>
    </Card>
  );
}

function InsightCard({ icon, title, insight, description }: { icon: React.ReactNode; title: string; insight: { label: string; count: number }; description: string }) {
  return (
    <Card className="h-full p-5">
      <div className="flex items-center gap-2 text-[var(--color-brand)]">{icon}<h3 className="text-sm font-bold">{title}</h3></div>
      <p className="mt-3 break-words text-xl font-bold text-[var(--color-text-primary)]">{insight.label}</p>
      <p className="mt-1 text-xs font-semibold text-[var(--color-text-secondary)]">{insight.count > 0 ? `${insight.count} record${insight.count === 1 ? '' : 's'}` : 'No records today'}</p>
      <p className="mt-3 text-xs leading-relaxed text-[var(--color-text-muted)]">{description}</p>
    </Card>
  );
}

export function IssuedPassesCalendar({
  passes,
  calendarCounts,
  referenceDate,
}: {
  passes: GatePass[];
  calendarCounts?: Record<string, number>;
  referenceDate?: DateInput;
}) {
  const manilaNow = getManilaDateParts(referenceDate);
  const firstDayOfMonth = new Date(manilaNow.year, manilaNow.month - 1, 1, 12, 0, 0);
  const lastDayOfMonth = new Date(manilaNow.year, manilaNow.month, 0, 12, 0, 0);

  const calendarDays = eachDayOfInterval({
    start: startOfWeek(firstDayOfMonth),
    end: endOfWeek(lastDayOfMonth),
  });
  const countsByDate = new Map<string, number>();

  passes.forEach((pass) => {
    const issuedKey = getManilaDateString(pass.issuedAt.toDate());
    if (!issuedKey.startsWith(manilaNow.monthKey)) return;
    countsByDate.set(issuedKey, (countsByDate.get(issuedKey) || 0) + 1);
  });

  const monthLabel = formatManilaMonthYear(firstDayOfMonth);

  return (
    <Card className="p-6">
      <h2 className="text-xl font-bold text-[var(--color-text-primary)]">Passes Issued Calendar</h2>
      <p className="mt-1 text-sm text-[var(--color-text-secondary)]">
        {monthLabel} — each day shows the number of visitor passes created.
      </p>
      <div className="mt-5 grid grid-cols-7 gap-1" role="grid" aria-label={`Visitor passes issued in ${monthLabel}`}>
        {['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].map((day) => (
          <div key={day} role="columnheader" className="pb-1 text-center text-xs font-bold uppercase tracking-wide text-[var(--color-text-muted)]">
            <span className="sm:hidden">{day.charAt(0)}</span>
            <span className="hidden sm:inline">{day.slice(0, 3)}</span>
          </div>
        ))}
        {calendarDays.map((day) => {
          const year = day.getFullYear();
          const month = day.getMonth() + 1;
          const date = day.getDate();
          const key = `${year}-${String(month).padStart(2, '0')}-${String(date).padStart(2, '0')}`;
          const count = calendarCounts ? (calendarCounts[key] ?? 0) : (countsByDate.get(key) || 0);
          const inCurrentMonth = year === manilaNow.year && month === manilaNow.month;
          const currentDay = key === manilaNow.dateString;

          return (
            <div
              key={key}
              role="gridcell"
              aria-label={`${format(day, 'MMMM d, yyyy')}: ${count} ${count === 1 ? 'pass' : 'passes'} issued`}
              className={`flex h-20 min-w-0 flex-col rounded-md border p-1.5 sm:h-24 sm:p-2 ${
                inCurrentMonth ? 'border-[var(--color-border)] bg-white' : 'border-transparent bg-[var(--color-canvas)] text-[var(--color-text-muted)]'
              } ${currentDay ? 'ring-2 ring-[var(--color-brand)] ring-offset-1' : ''}`}
            >
              <span className={`text-xs font-bold sm:text-sm ${inCurrentMonth ? 'text-[var(--color-text-primary)]' : 'text-[var(--color-text-muted)]'}`}>
                {date}
              </span>
              <span className={`mt-auto rounded px-1 py-0.5 text-center text-xs font-semibold ${
                count > 0 && inCurrentMonth ? 'bg-[var(--color-brand-light)] text-[var(--color-brand)]' : 'text-[var(--color-text-muted)]'
              }`}>
                {inCurrentMonth ? `${count} ${count === 1 ? 'pass' : 'passes'}` : ''}
              </span>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

function DashboardSkeleton() {
  return <div className="space-y-6" aria-label="Loading dashboard"><div><Skeleton className="h-8 w-40" /><Skeleton className="mt-2 h-4 w-72 max-w-full" /></div><div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">{Array.from({ length: 6 }, (_, index) => <Skeleton key={index} className="h-36" />)}</div><div className="grid gap-4 md:grid-cols-3">{Array.from({ length: 3 }, (_, index) => <Skeleton key={index} className="h-40" />)}</div></div>;
}
