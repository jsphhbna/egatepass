import { useSyncExternalStore } from 'react';
import type { GatePass, PassSource, PassStatus } from '@/types';
import { asAppTimestamp } from '@/lib/timestamp';
import { getAccessToken } from '@/services/auth';

interface SerializedPass {
  id: string;
  visitorId: string;
  visitorName: string;
  purpose: string;
  photoPublicId: string | null;
  idImagePublicId: string | null;
  source: PassSource;
  status: PassStatus;
  validFrom: string;
  validUntil: string;
  issuedAt: string;
  scannedAt: string | null;
  timeIn: string | null;
  timeOut: string | null;
  entryDeviceId: string | null;
  exitDeviceId: string | null;
  decidedByUid: string | null;
  rejectionReason: string | null;
  gate: string | null;
}

export type DashboardPeriodType = 'today' | 'date' | 'month' | 'year' | 'range';

export interface DashboardPeriodQuery {
  period: DashboardPeriodType;
  date?: string;
  month?: string;
  year?: string;
  dateFrom?: string;
  dateTo?: string;
}

export interface DashboardPeriodMeta {
  period: DashboardPeriodType;
  startDate: string;
  endDate: string;
  periodStart: string;
  periodEnd: string;
  timezone: string;
  label: string;
}

export interface DashboardPeriodCounts {
  total: number;
  issued: number;
  inside: number;
  exited: number;
  pending: number;
  rejected: number;
  expired: number;
}

export interface DashboardOfflineMetrics {
  classification: 'OFFLINE MODE RECORDED';
  total: number;
  pendingSync: number;
  received: number;
  accepted: number;
  needsReview: number;
  duplicate: number;
  rejected: number;
  exceptionApplied: number;
  truncated: boolean;
}

export interface SerializedOfflineDashboardRecord {
  id: string;
  gate: string;
  visitorName: string;
  declaredAddress: string | null;
  addressStatus: string | null;
  purpose: string;
  officeName: string | null;
  officeResolutionStatus: string | null;
  idPhysicallyInspected: boolean;
  classification: string;
  localRecordedAt: string;
  serverReceivedAt: string;
  localSequence: number;
  snapshotVersion: string | null;
  emergencyExceptionApplied: boolean;
  reconciliationStatus: string;
  reconciliationNotes: string | null;
  reconciledAt: string | null;
}

export interface DashboardReportPayload {
  periodMeta?: DashboardPeriodMeta;
  periodCounts?: DashboardPeriodCounts;
  offlineModeMetrics?: DashboardOfflineMetrics;
  passes: GatePass[];
  offlineRecords: SerializedOfflineDashboardRecord[];
  totalMatchingCount: number;
  offlineTotalCount: number;
  truncated: boolean;
  maxRows: number;
}

export interface DashboardCounts {
  todayTotal: number;
  monthTotal?: number;
  currentlyInside: number;
  exitedToday: number;
  pendingToday: number;
  allPending?: number;
  rejectedToday: number;
}

export interface DashboardInsights {
  topPurpose: { label: string; count: number };
  busiestGate: { label: string; count: number };
  topRejection: { label: string; count: number };
  avgApprovalTime: string;
}

interface DashboardApiResponse {
  counts?: DashboardCounts;
  periodMeta?: DashboardPeriodMeta;
  periodCounts?: DashboardPeriodCounts;
  offlineModeMetrics?: DashboardOfflineMetrics;
  insights?: DashboardInsights;
  calendarCounts?: Record<string, number>;
  recentPasses: SerializedPass[];
  insidePasses: SerializedPass[];
  exitedTodayPasses: SerializedPass[];
  decisionsTodayPasses: SerializedPass[];
  reportRows?: {
    passes: SerializedPass[];
    offlineRecords: SerializedOfflineDashboardRecord[];
    totalMatchingCount: number;
    offlineTotalCount: number;
    truncated: boolean;
    maxRows: number;
  };
  error?: string;
  message?: string;
}

export interface DashboardDataSnapshot {
  counts?: DashboardCounts;
  periodMeta?: DashboardPeriodMeta;
  periodCounts?: DashboardPeriodCounts;
  offlineModeMetrics?: DashboardOfflineMetrics;
  insights?: DashboardInsights;
  calendarCounts?: Record<string, number>;
  recentPasses: GatePass[];
  insidePasses: GatePass[];
  exitedTodayPasses: GatePass[];
  decisionsTodayPasses: GatePass[];
  loading: boolean;
  initialLoading: boolean;
  refreshing: boolean;
  error: string | null;
  initialError: string | null;
  refreshError: string | null;
  updatedAt: number | null;
}

const initialSnapshot: DashboardDataSnapshot = {
  counts: undefined,
  periodMeta: undefined,
  periodCounts: undefined,
  offlineModeMetrics: undefined,
  insights: undefined,
  calendarCounts: undefined,
  recentPasses: [],
  insidePasses: [],
  exitedTodayPasses: [],
  decisionsTodayPasses: [],
  loading: true,
  initialLoading: true,
  refreshing: false,
  error: null,
  initialError: null,
  refreshError: null,
  updatedAt: null,
};

const DEFAULT_PERIOD_QUERY: DashboardPeriodQuery = { period: 'today' };
let activeQuery: DashboardPeriodQuery = { ...DEFAULT_PERIOD_QUERY };
let currentSnapshot = initialSnapshot;
let pollTimeout: ReturnType<typeof setTimeout> | null = null;
let consecutiveDashboardFailures = 0;
const BASE_POLL_INTERVAL_MS = 15000;
const MAX_POLL_INTERVAL_MS = 120000;

function scheduleNextDashboardPoll() {
  if (pollTimeout) {
    clearTimeout(pollTimeout);
    pollTimeout = null;
  }
  if (subscribers.size === 0) return;

  const delay = consecutiveDashboardFailures > 1
    ? Math.min(BASE_POLL_INTERVAL_MS * Math.pow(1.5, consecutiveDashboardFailures - 1), MAX_POLL_INTERVAL_MS)
    : BASE_POLL_INTERVAL_MS;

  pollTimeout = setTimeout(async () => {
    if (typeof document !== 'undefined' && document.hidden) {
      // Paused while tab is backgrounded
      return;
    }
    await fetchDashboardData();
    scheduleNextDashboardPoll();
  }, delay);
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && subscribers.size > 0) {
      void fetchDashboardData();
      scheduleNextDashboardPoll();
    }
  });
}
let activeRequest: {
  id: number;
  epoch: number;
  controller: AbortController;
} | null = null;
let isFetching = false;
let queuedFollowUp = false;
let latestIntent = 0;
let storeEpoch = 0;
const subscribers = new Set<() => void>();

export function buildDashboardApiUrl(query: DashboardPeriodQuery, includeReportRows = false): string {
  if (query.period === 'today' && !includeReportRows) {
    return '/api/admin/dashboard';
  }
  const params = new URLSearchParams();
  params.set('period', query.period);
  if (query.period === 'date' && query.date) params.set('date', query.date);
  if (query.period === 'month' && query.month) params.set('month', query.month);
  if (query.period === 'year' && query.year) params.set('year', query.year);
  if (query.period === 'range') {
    if (query.dateFrom) params.set('dateFrom', query.dateFrom);
    if (query.dateTo) params.set('dateTo', query.dateTo);
  }
  if (includeReportRows) params.set('includeReportRows', 'true');
  return `/api/admin/dashboard?${params.toString()}`;
}

interface QueuedRetryDeferred {
  resolve: () => void;
  reject: (err: unknown) => void;
}
let pendingManualResolvers: QueuedRetryDeferred[] = [];

export function deserializePass(p: SerializedPass): GatePass {
  const validFrom = asAppTimestamp(p.validFrom);
  const validUntil = asAppTimestamp(p.validUntil);
  const issuedAt = asAppTimestamp(p.issuedAt);

  if (!validFrom || !validUntil || !issuedAt) {
    throw new Error('invalid_dashboard_pass_timestamp');
  }

  return {
    visitorId: p.visitorId,
    visitorName: p.visitorName,
    purpose: p.purpose,
    photoPublicId: p.photoPublicId ?? '',
    idImagePublicId: p.idImagePublicId,
    source: p.source,
    status: p.status,
    validFrom,
    validUntil,
    issuedAt,
    scannedAt: asAppTimestamp(p.scannedAt),
    timeIn: asAppTimestamp(p.timeIn),
    timeOut: asAppTimestamp(p.timeOut),
    entryDeviceId: p.entryDeviceId,
    exitDeviceId: p.exitDeviceId,
    decidedByUid: p.decidedByUid,
    rejectionReason: p.rejectionReason,
    gate: p.gate,
  };
}

function emitChange() {
  subscribers.forEach((subscriber) => subscriber());
}

function fetchDashboardData(isManualRetry = false): Promise<void> {
  if (isFetching || activeRequest !== null) {
    if (isManualRetry) {
      queuedFollowUp = true;
      return new Promise<void>((resolve, reject) => {
        pendingManualResolvers.push({ resolve, reject });
      });
    }
    return Promise.resolve();
  }

  isFetching = true;
  const currentIntent = ++latestIntent;
  const requestEpoch = storeEpoch;
  const controller = new AbortController();
  activeRequest = {
    id: currentIntent,
    epoch: requestEpoch,
    controller,
  };

  const hasExistingData = currentSnapshot.updatedAt !== null || currentSnapshot.counts !== undefined;

  currentSnapshot = {
    ...currentSnapshot,
    refreshing: hasExistingData,
    initialLoading: !hasExistingData,
    loading: !hasExistingData,
    initialError: isManualRetry && !hasExistingData ? null : currentSnapshot.initialError,
    refreshError: null,
  };
  emitChange();

  const queryForRequest = { ...activeQuery };
  return (async () => {
    try {
      const token = await getAccessToken();
      const response = await fetch(buildDashboardApiUrl(queryForRequest, false), {
        headers: { Authorization: `Bearer ${token}` },
        signal: controller.signal,
      });

      const data = await response.json().catch(() => null) as DashboardApiResponse | null;
      if (controller.signal.aborted || currentIntent !== latestIntent || requestEpoch !== storeEpoch) {
        return;
      }
      if (!response.ok) {
        throw new Error(data?.message || data?.error || 'Failed to load dashboard data');
      }

      currentSnapshot = {
        counts: data?.counts,
        periodMeta: data?.periodMeta,
        periodCounts: data?.periodCounts,
        offlineModeMetrics: data?.offlineModeMetrics,
        insights: data?.insights,
        calendarCounts: data?.calendarCounts,
        recentPasses: (data?.recentPasses ?? []).map(deserializePass),
        insidePasses: (data?.insidePasses ?? []).map(deserializePass),
        exitedTodayPasses: (data?.exitedTodayPasses ?? []).map(deserializePass),
        decisionsTodayPasses: (data?.decisionsTodayPasses ?? []).map(deserializePass),
        loading: false,
        initialLoading: false,
        refreshing: false,
        error: null,
        initialError: null,
        refreshError: null,
        updatedAt: Date.now(),
      };
      consecutiveDashboardFailures = 0;
      emitChange();
    } catch (error) {
      if (!controller.signal.aborted && currentIntent === latestIntent && requestEpoch === storeEpoch) {
        console.error('Dashboard data fetch error:', error);
        consecutiveDashboardFailures++;
        const errorMessage = error instanceof Error ? error.message : 'The dashboard could not load visitor data.';

        if (hasExistingData) {
          // Preserve existing data on background refresh failure
          currentSnapshot = {
            ...currentSnapshot,
            loading: false,
            initialLoading: false,
            refreshing: false,
            error: null, // do not block screen with error
            initialError: null,
            refreshError: errorMessage,
          };
        } else {
          // Initial failure without existing data
          currentSnapshot = {
            ...currentSnapshot,
            loading: false,
            initialLoading: false,
            refreshing: false,
            error: errorMessage,
            initialError: errorMessage,
            refreshError: null,
          };
        }
        emitChange();
      }
    } finally {
      // Authoritative request ownership check: only the active request owner for this epoch may release the slot
      if (activeRequest && activeRequest.id === currentIntent && activeRequest.epoch === requestEpoch) {
        activeRequest = null;
        isFetching = false;

        if (queuedFollowUp && subscribers.size > 0 && storeEpoch === requestEpoch) {
          queuedFollowUp = false;
          const currentResolvers = pendingManualResolvers;
          pendingManualResolvers = [];

          void fetchDashboardData(true).then(
            () => {
              currentResolvers.forEach((r) => r.resolve());
            },
            (err) => {
              currentResolvers.forEach((r) => r.reject(err));
            }
          );
        } else {
          queuedFollowUp = false;
          const currentResolvers = pendingManualResolvers;
          pendingManualResolvers = [];
          currentResolvers.forEach((r) => r.resolve());
        }
      }
    }
  })();
}

function subscribe(callback: () => void) {
  subscribers.add(callback);
  if (subscribers.size === 1) {
    storeEpoch++;
    void fetchDashboardData();
    scheduleNextDashboardPoll();
  }

  return () => {
    subscribers.delete(callback);
    if (subscribers.size === 0) {
      storeEpoch++;
      if (pollTimeout) {
        clearTimeout(pollTimeout);
        pollTimeout = null;
      }
      if (activeRequest) {
        activeRequest.controller.abort();
        activeRequest = null;
      }
      isFetching = false;
      queuedFollowUp = false;
      const resolvers = pendingManualResolvers;
      pendingManualResolvers = [];
      resolvers.forEach((r) => r.resolve());
      currentSnapshot = initialSnapshot;
    }
  };
}

export function getDashboardPeriodQuery(): DashboardPeriodQuery {
  return { ...activeQuery };
}

export function setDashboardPeriodQuery(nextQuery: DashboardPeriodQuery): Promise<void> {
  activeQuery = { ...nextQuery };
  storeEpoch++;
  if (activeRequest) {
    activeRequest.controller.abort();
    activeRequest = null;
  }
  isFetching = false;
  queuedFollowUp = false;
  const resolvers = pendingManualResolvers;
  pendingManualResolvers = [];
  resolvers.forEach((r) => r.resolve());
  return fetchDashboardData(true);
}

export async function fetchDashboardReportData(query?: DashboardPeriodQuery): Promise<DashboardReportPayload> {
  const token = await getAccessToken();
  const effectiveQuery = query ?? activeQuery;
  const response = await fetch(buildDashboardApiUrl(effectiveQuery, true), {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await response.json().catch(() => null) as DashboardApiResponse | null;
  if (!response.ok || !data) {
    throw new Error(data?.message || data?.error || 'Failed to load complete dashboard report data');
  }
  return {
    periodMeta: data.periodMeta,
    periodCounts: data.periodCounts,
    offlineModeMetrics: data.offlineModeMetrics,
    passes: (data.reportRows?.passes ?? data.recentPasses ?? []).map(deserializePass),
    offlineRecords: data.reportRows?.offlineRecords ?? [],
    totalMatchingCount: data.reportRows?.totalMatchingCount ?? data.recentPasses?.length ?? 0,
    offlineTotalCount: data.reportRows?.offlineTotalCount ?? 0,
    truncated: Boolean(data.reportRows?.truncated),
    maxRows: data.reportRows?.maxRows ?? 5000,
  };
}

export function refreshAdminDashboardData(): Promise<void> {
  return fetchDashboardData(true);
}

export function useAdminDashboardData() {
  return useSyncExternalStore(subscribe, () => currentSnapshot, () => initialSnapshot);
}

export function _resetDashboardStoreForTesting() {
  if (pollTimeout) {
    clearTimeout(pollTimeout);
    pollTimeout = null;
  }
  consecutiveDashboardFailures = 0;
  if (activeRequest) {
    activeRequest.controller.abort();
    activeRequest = null;
  }
  isFetching = false;
  queuedFollowUp = false;
  activeQuery = { ...DEFAULT_PERIOD_QUERY };
  const resolvers = pendingManualResolvers;
  pendingManualResolvers = [];
  resolvers.forEach((r) => r.resolve());
  subscribers.clear();
  currentSnapshot = initialSnapshot;
  latestIntent = 0;
  storeEpoch = 0;
}
