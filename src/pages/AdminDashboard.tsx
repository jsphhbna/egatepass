import { useMemo } from 'react';
import {
  eachDayOfInterval,
  endOfMonth,
  endOfWeek,
  format,
  isSameDay,
  isSameMonth,
  isToday,
  startOfMonth,
  startOfWeek,
} from 'date-fns';
import {
  AlertCircle,
  ArrowLeftCircle,
  ArrowRightCircle,
  Ban,
  Clock,
  MapPin,
  MessageSquareText,
  RefreshCw,
  Sparkles,
  Users,
} from 'lucide-react';
import { Button, Card, Skeleton, StatCard } from '@/components/ui';
import { DashboardExportActions } from '@/components/DashboardExportActions';
import {
  refreshAdminDashboardData,
  useAdminDashboardData,
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
  const metrics = useMemo(() => {
    const today = new Date();
    const todayPasses = dashboard.recentPasses.filter((pass) => isSameDay(pass.issuedAt.toDate(), today));
    const pendingToday = dashboard.decisionsTodayPasses.filter((pass) => pass.status === 'pending');
    const rejectedToday = dashboard.decisionsTodayPasses.filter((pass) => pass.status === 'rejected');

    return {
      todayTotal: todayPasses.length,
      currentlyInside: dashboard.insidePasses.length,
      exitedToday: dashboard.exitedTodayPasses.length,
      pendingToday: pendingToday.length,
      rejectedToday: rejectedToday.length,
      avgApprovalTime: averageApprovalTime(dashboard.decisionsTodayPasses),
      topPurpose: mostCommon(todayPasses.map((pass) => pass.purpose?.split(' — ')[0]?.trim())),
      topRejection: mostCommon(rejectedToday.map((pass) => pass.rejectionReason)),
      busiestGate: mostCommon(dashboard.decisionsTodayPasses.map((pass) => pass.gate)),
      calendarPasses: dashboard.recentPasses,
    };
  }, [dashboard]);

  const exportSummary = {
    visitorsToday: metrics.todayTotal,
    currentlyInside: metrics.currentlyInside,
    exitedToday: metrics.exitedToday,
    pendingApproval: metrics.pendingToday,
    rejectedToday: metrics.rejectedToday,
    insights: [
      {
        title: 'Top Visit Purpose',
        value: metrics.topPurpose.label,
        count: metrics.topPurpose.count,
        description: 'Most common reason visitors gave when requesting a pass.',
      },
      {
        title: 'Top Rejection Reason',
        value: metrics.topRejection.label,
        count: metrics.topRejection.count,
        description: 'Most common reason among visitors scanned today who were rejected.',
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
        <Button onClick={refreshAdminDashboardData} icon={<RefreshCw className="h-4 w-4" />} className="mt-5">
          Try Again
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
          <div className="flex items-center gap-2 text-xs font-medium text-[var(--color-success)]" aria-live="polite">
            <span className="h-2 w-2 rounded-full bg-[var(--color-success)]" aria-hidden="true" />
            Live updates
            {dashboard.updatedAt && (
              <span className="text-[var(--color-text-muted)]">· Updated {format(dashboard.updatedAt, 'h:mm a')}</span>
            )}
          </div>
          <DashboardExportActions passes={metrics.calendarPasses} summary={exportSummary} />
        </div>
      </header>

      <section aria-labelledby="visitor-stats-heading">
        <h2 id="visitor-stats-heading" className="sr-only">Visitor statistics</h2>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          <StatCard title="Visitors Today" value={metrics.todayTotal} icon={<Users className="h-5 w-5 text-[var(--color-brand)]" />} description="Passes created since midnight." />
          <StatCard title="Currently Inside" value={metrics.currentlyInside} icon={<ArrowRightCircle className="h-5 w-5 text-[var(--color-success)]" />} description="All approved visitors who have not exited." />
          <StatCard title="Exited Today" value={metrics.exitedToday} icon={<ArrowLeftCircle className="h-5 w-5 text-[var(--color-text-secondary)]" />} description="Visits with an exit time recorded today." />
          <StatCard title="Pending Approval" value={metrics.pendingToday} icon={<Clock className="h-5 w-5 text-[var(--color-warning)]" />} description="Visitors scanned today and waiting for a guard." />
          <StatCard title="Rejected Today" value={metrics.rejectedToday} icon={<Ban className="h-5 w-5 text-[var(--color-danger)]" />} description="Visitors scanned today whose entry was rejected." />
          <StatCard title="Avg Approval Time" value={metrics.avgApprovalTime} icon={<Sparkles className="h-5 w-5 text-[var(--color-brand)]" />} description="Average wait from scan to approval for visitors scanned today." />
        </div>
      </section>

      <section aria-labelledby="insights-heading">
        <div className="mb-3">
          <h2 id="insights-heading" className="text-lg font-bold text-[var(--color-text-primary)]">Today's Insights</h2>
          <p className="text-sm text-[var(--color-text-secondary)]">The most common activity recorded today.</p>
        </div>
        <div className="grid gap-4 md:grid-cols-3">
          <InsightCard icon={<MessageSquareText className="h-5 w-5" />} title="Top Visit Purpose" insight={metrics.topPurpose} description="Most common reason visitors gave when requesting a pass." />
          <InsightCard icon={<Ban className="h-5 w-5" />} title="Top Rejection Reason" insight={metrics.topRejection} description="Most common reason among visitors scanned today who were rejected." />
          <InsightCard icon={<MapPin className="h-5 w-5" />} title="Busiest Entry Gate" insight={metrics.busiestGate} description="Gate with the most visitor scans recorded today." />
        </div>
      </section>

      <div className="grid gap-6 lg:grid-cols-2">
        <IssuedPassesCalendar passes={metrics.calendarPasses} />
        <Card className="p-6">
          <h2 className="mb-5 text-xl font-bold text-[var(--color-text-primary)]">Operational Summary</h2>
          <div className="space-y-4">
            <SummaryRow label="Approved and currently inside" value={metrics.currentlyInside} color="text-[var(--color-success)]" />
            <SummaryRow label="Completed visits today" value={metrics.exitedToday} />
            <SummaryRow label="Waiting for approval" value={metrics.pendingToday} color="text-[var(--color-warning)]" />
            <SummaryRow label="Rejected after scanning today" value={metrics.rejectedToday} color="text-[var(--color-danger)]" last />
          </div>
        </Card>
      </div>
    </div>
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

function IssuedPassesCalendar({ passes }: { passes: GatePass[] }) {
  const month = new Date();
  const monthStart = startOfMonth(month);
  const monthEnd = endOfMonth(month);
  const calendarDays = eachDayOfInterval({
    start: startOfWeek(monthStart),
    end: endOfWeek(monthEnd),
  });
  const countsByDate = new Map<string, number>();

  passes.forEach((pass) => {
    const issuedDate = pass.issuedAt.toDate();
    if (!isSameMonth(issuedDate, month)) return;
    const key = format(issuedDate, 'yyyy-MM-dd');
    countsByDate.set(key, (countsByDate.get(key) || 0) + 1);
  });

  return (
    <Card className="p-6">
      <h2 className="text-xl font-bold text-[var(--color-text-primary)]">Passes Issued Calendar</h2>
      <p className="mt-1 text-sm text-[var(--color-text-secondary)]">
        {format(month, 'MMMM yyyy')} — each day shows the number of visitor passes created.
      </p>
      <div className="mt-5 grid grid-cols-7 gap-1" role="grid" aria-label={`Visitor passes issued in ${format(month, 'MMMM yyyy')}`}>
        {['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].map((day) => (
          <div key={day} role="columnheader" className="pb-1 text-center text-xs font-bold uppercase tracking-wide text-[var(--color-text-muted)]">
            <span className="sm:hidden">{day.charAt(0)}</span>
            <span className="hidden sm:inline">{day.slice(0, 3)}</span>
          </div>
        ))}
        {calendarDays.map((day) => {
          const key = format(day, 'yyyy-MM-dd');
          const count = countsByDate.get(key) || 0;
          const inCurrentMonth = isSameMonth(day, month);
          const currentDay = isToday(day);

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
                {format(day, 'd')}
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

function SummaryRow({ label, value, color = 'text-[var(--color-text-primary)]', last = false }: { label: string; value: number; color?: string; last?: boolean }) {
  return <div className={`flex items-center justify-between gap-4 pb-3 ${last ? '' : 'border-b border-[var(--color-border)]'}`}><span className="text-sm font-medium text-[var(--color-text-secondary)]">{label}</span><span className={`text-lg font-bold ${color}`}>{value}</span></div>;
}

function DashboardSkeleton() {
  return <div className="space-y-6" aria-label="Loading dashboard"><div><Skeleton className="h-8 w-40" /><Skeleton className="mt-2 h-4 w-72 max-w-full" /></div><div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">{Array.from({ length: 6 }, (_, index) => <Skeleton key={index} className="h-36" />)}</div><div className="grid gap-4 md:grid-cols-3">{Array.from({ length: 3 }, (_, index) => <Skeleton key={index} className="h-40" />)}</div></div>;
}
