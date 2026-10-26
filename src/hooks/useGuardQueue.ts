import { useState, useRef, useEffect, useCallback } from 'react';
import {
  fetchGuardDashboardWindow,
  type GuardQueuePass,
  type GuardDashboardWindowResult,
} from '@/services/guard';

export interface GuardRefreshResult {
  committed: boolean;
  dashboard?: GuardDashboardWindowResult;
  error?: unknown;
}

export interface UseGuardQueueOptions {
  onNewPendingPass?: () => void;
}

export function useGuardQueue(options?: UseGuardQueueOptions) {
  const [passes, setPasses] = useState<GuardQueuePass[]>([]);
  const [pendingTotal, setPendingTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [dailyStats, setDailyStats] = useState({
    inside: 0,
    exited: 0,
    rejected: 0,
    total: 0,
  });
  const [rejectionReasons, setRejectionReasons] = useState<string[]>([]);
  const [queueError, setQueueError] = useState(false);
  const [refreshError, setRefreshError] = useState(false);
  const [initialLoading, setInitialLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<Date | null>(null);

  const mountedRef = useRef(true);
  const desiredQueueSizeRef = useRef(50);
  const queueIntentEpochRef = useRef(0);
  const refreshInFlightRef = useRef<Promise<GuardRefreshResult> | null>(null);
  const refreshQueuedRef = useRef(false);
  const hasLoadedOnceRef = useRef(false);
  const previousPendingCountRef = useRef(0);

  // ============================================================
  // MOUNT / UNMOUNT LIFECYCLE FENCING (PATCH 35)
  // ============================================================
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      queueIntentEpochRef.current += 1;
      refreshQueuedRef.current = false;
    };
  }, []);

  // ============================================================
  // ONE AUTHORITATIVE QUEUE COMMIT PATH (PATCH 33 & 34)
  // ============================================================
  const commitDashboard = useCallback((dashboard: GuardDashboardWindowResult) => {
    hasLoadedOnceRef.current = true;
    setQueueError(false);
    setRefreshError(false);
    setLastUpdatedAt(new Date());

    if (dashboard.pendingTotal > previousPendingCountRef.current) {
      options?.onNewPendingPass?.();
    }
    previousPendingCountRef.current = dashboard.pendingTotal;

    setPasses(dashboard.queue);
    setPendingTotal(dashboard.pendingTotal);
    setHasMore(dashboard.hasMore);
    setDailyStats(dashboard.stats);
    setRejectionReasons(dashboard.rejectionReasons);

    // Normalize desired target when queue shrinks
    if (dashboard.hasMore === false) {
      desiredQueueSizeRef.current = Math.max(50, dashboard.queue.length);
    }
  }, [options]);

  // ============================================================
  // COALESCED SERIALIZED REFRESH LOOP (PATCH 24 & 25)
  // ============================================================
  const runRefreshLoop = useCallback(async (): Promise<GuardRefreshResult> => {
    let lastResult: GuardRefreshResult = { committed: false };

    try {
      while (mountedRef.current) {
        refreshQueuedRef.current = false;
        const epochBeforeFetch = queueIntentEpochRef.current;
        const desiredCount = desiredQueueSizeRef.current;

        try {
          const dashboard = await fetchGuardDashboardWindow({
            desiredCount,
            safetyCeiling: 5000,
          });

          if (!mountedRef.current) {
            lastResult = { committed: false };
            break;
          }

          if (epochBeforeFetch !== queueIntentEpochRef.current) {
            // Traversal became obsolete: epoch changed while request was in-flight
            lastResult = { committed: false, dashboard };
            // Ensure follow-up loop iteration runs for the newly intended state
            refreshQueuedRef.current = true;
          } else {
            // Epoch is current: commit authoritatively to state
            commitDashboard(dashboard);
            lastResult = { committed: true, dashboard };
          }
        } catch (err) {
          if (!mountedRef.current) {
            lastResult = { committed: false, error: err };
            break;
          }

          console.error('Guard dashboard error:', err);
          lastResult = { committed: false, error: err };

          // Section 49: If a newer intent was already queued, do not surface obsolete failure
          if (!refreshQueuedRef.current && epochBeforeFetch === queueIntentEpochRef.current) {
            if (!hasLoadedOnceRef.current) {
              setQueueError(true);
              setRefreshError(false);
            } else {
              setQueueError(false);
              setRefreshError(true);
            }
          }
        } finally {
          if (mountedRef.current) {
            setInitialLoading(false);
          }
        }

        if (!refreshQueuedRef.current) {
          break;
        }
      }
    } finally {
      refreshInFlightRef.current = null;
      if (mountedRef.current) {
        setRefreshing(false);
      }
    }

    return lastResult;
  }, [commitDashboard]);

  // ============================================================
  // SINGLE AUTHORITATIVE REFRESH CONTROLLER (PATCH 24)
  // ============================================================
  const requestGuardQueueRefresh = useCallback((refreshOptions?: {
    showRefreshing?: boolean;
  }): Promise<GuardRefreshResult> => {
    if (!mountedRef.current) {
      return Promise.resolve({ committed: false });
    }

    if (refreshOptions?.showRefreshing) {
      setRefreshing(true);
    }

    if (refreshInFlightRef.current !== null) {
      refreshQueuedRef.current = true;
      return refreshInFlightRef.current;
    }

    const promise = runRefreshLoop();
    refreshInFlightRef.current = promise;
    return promise;
  }, [runRefreshLoop]);

  return {
    passes,
    pendingTotal,
    hasMore,
    loadingMore,
    setLoadingMore,
    dailyStats,
    rejectionReasons,
    queueError,
    refreshError,
    initialLoading,
    refreshing,
    lastUpdatedAt,
    mountedRef,
    desiredQueueSizeRef,
    queueIntentEpochRef,
    refreshInFlightRef,
    refreshQueuedRef,
    hasLoadedOnceRef,
    previousPendingCountRef,
    requestGuardQueueRefresh,
  };
}
