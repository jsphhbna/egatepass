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

export interface DashboardCounts {
  todayTotal: number;
  monthTotal?: number;
  currentlyInside: number;
  exitedToday: number;
  pendingToday: number;
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
  insights?: DashboardInsights;
  calendarCounts?: Record<string, number>;
  recentPasses: SerializedPass[];
  insidePasses: SerializedPass[];
  exitedTodayPasses: SerializedPass[];
  decisionsTodayPasses: SerializedPass[];
  error?: string;
}

export interface DashboardDataSnapshot {
  counts?: DashboardCounts;
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

let currentSnapshot = initialSnapshot;
let pollTimer: ReturnType<typeof setInterval> | null = null;
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

  return (async () => {
    try {
      const token = await getAccessToken();
      const response = await fetch('/api/admin/dashboard', {
        headers: { Authorization: `Bearer ${token}` },
        signal: controller.signal,
      });

      const data = await response.json().catch(() => null) as DashboardApiResponse | null;
      if (controller.signal.aborted || currentIntent !== latestIntent || requestEpoch !== storeEpoch) {
        return;
      }
      if (!response.ok) {
        throw new Error(data?.error || 'Failed to load dashboard data');
      }

      currentSnapshot = {
        counts: data?.counts,
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
      emitChange();
    } catch (error) {
      if (!controller.signal.aborted && currentIntent === latestIntent && requestEpoch === storeEpoch) {
        console.error('Dashboard data fetch error:', error);
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
    pollTimer = setInterval(() => {
      void fetchDashboardData();
    }, 15000);
  }

  return () => {
    subscribers.delete(callback);
    if (subscribers.size === 0) {
      storeEpoch++;
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
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

export function refreshAdminDashboardData(): Promise<void> {
  return fetchDashboardData(true);
}

export function useAdminDashboardData() {
  return useSyncExternalStore(subscribe, () => currentSnapshot, () => initialSnapshot);
}

export function _resetDashboardStoreForTesting() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
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
  subscribers.clear();
  currentSnapshot = initialSnapshot;
  latestIntent = 0;
  storeEpoch = 0;
}
