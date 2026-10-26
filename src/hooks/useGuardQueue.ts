import { useState, useRef, useEffect, useCallback } from 'react';
import {
  fetchGuardDashboardWindow,
  type GuardQueuePass,
  type GuardDashboardWindowResult,
} from '@/services/guard';

export type GuardRefreshReason = 'initial' | 'poll' | 'realtime' | 'intent';

export interface GuardRefreshResult {
  committed: boolean;
  skipped?: boolean;
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
  const realtimeDirtyRef = useRef(false);
  const refreshInFlightRef = useRef<Promise<GuardRefreshResult> | null>(null);
  const hasLoadedOnceRef = useRef(false);
  const previousPendingCountRef = useRef(0);

  // ============================================================
  // CALLBACK REF: PRESERVE STABLE CONTROLLER IDENTITY (PATCH 1, 3)
  // ============================================================
  const onNewPendingPassRef = useRef<UseGuardQueueOptions['onNewPendingPass']>(
    options?.onNewPendingPass
  );

  useEffect(() => {
    onNewPendingPassRef.current = options?.onNewPendingPass;
  }, [options?.onNewPendingPass]);

  // ============================================================
  // MOUNT / UNMOUNT LIFECYCLE FENCING (PATCH 35)
  // ============================================================
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      queueIntentEpochRef.current += 1;
      realtimeDirtyRef.current = false;
    };
  }, []);

  // ============================================================
  // ONE AUTHORITATIVE QUEUE COMMIT PATH (PATCH 2, 3, 5)
  // ============================================================
  const commitDashboard = useCallback((dashboard: GuardDashboardWindowResult) => {
    hasLoadedOnceRef.current = true;
    setInitialLoading(false);
    setQueueError(false);
    setRefreshError(false);
    setLastUpdatedAt(new Date());

    if (dashboard.pendingTotal > previousPendingCountRef.current) {
      onNewPendingPassRef.current?.();
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
  }, []);

  // ============================================================
  // BOUNDED SERIALIZED REFRESH CHAIN LOOP (PATCH 3, 5, 6, 54)
  // ============================================================
  const runRefreshLoop = useCallback(async (): Promise<GuardRefreshResult> => {
    let realtimeFollowupUsed = false;
    let lastResult: GuardRefreshResult = { committed: false };

    try {
      while (mountedRef.current) {
        realtimeDirtyRef.current = false;
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
            // Traversal became obsolete: explicit intent occurred while fetch was in-flight
            lastResult = { committed: false, dashboard };
            realtimeFollowupUsed = false;
            continue;
          }

          // Epoch is current: commit authoritatively to state
          commitDashboard(dashboard);
          lastResult = { committed: true, dashboard };

          const realtimeChangedDuringTraversal = realtimeDirtyRef.current;

          if (realtimeChangedDuringTraversal) {
            if (!realtimeFollowupUsed) {
              // Permit exactly one Realtime freshness follow-up per refresh chain
              realtimeFollowupUsed = true;
              continue;
            } else {
              // Realtime during follow-up is deferred to next poll or idle event; terminate chain
              realtimeDirtyRef.current = false;
              break;
            }
          } else {
            break;
          }
        } catch (err) {
          if (!mountedRef.current) {
            lastResult = { committed: false, error: err };
            break;
          }

          console.error('Guard dashboard error:', err);
          lastResult = { committed: false, error: err };

          if (epochBeforeFetch !== queueIntentEpochRef.current) {
            // Obsolete error: newer intent exists
            realtimeFollowupUsed = false;
            continue;
          }

          if (realtimeDirtyRef.current && !realtimeFollowupUsed) {
            // Allow one fresh attempt on failure if Realtime changed
            realtimeFollowupUsed = true;
            continue;
          }

          // Authoritative failure
          setInitialLoading(false);
          if (!hasLoadedOnceRef.current) {
            setQueueError(true);
            setRefreshError(false);
          } else {
            setQueueError(false);
            setRefreshError(true);
          }
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
  // SINGLE AUTHORITATIVE REFRESH CONTROLLER (PATCH 24, 53, 54)
  // ============================================================
  const requestGuardQueueRefresh = useCallback((refreshOptions?: {
    reason?: GuardRefreshReason;
    showRefreshing?: boolean;
  }): Promise<GuardRefreshResult> => {
    if (!mountedRef.current) {
      return Promise.resolve({ committed: false });
    }

    const reason = refreshOptions?.reason ?? 'intent';

    // Intent invalidation: increments epoch before in-flight checks
    if (reason === 'intent') {
      queueIntentEpochRef.current += 1;
    }

    // CLASS 1: Opportunistic Poll
    // If a traversal is already in-flight, DROP THE POLL immediately.
    if (reason === 'poll' && refreshInFlightRef.current !== null) {
      return Promise.resolve({
        committed: false,
        skipped: true,
      });
    }

    // CLASS 2: Realtime mutation during active refresh chain
    // Mark dirty flag and coalesce into current refresh promise.
    if (reason === 'realtime' && refreshInFlightRef.current !== null) {
      realtimeDirtyRef.current = true;
      if (refreshOptions?.showRefreshing) {
        setRefreshing(true);
      }
      return refreshInFlightRef.current;
    }

    if (refreshOptions?.showRefreshing) {
      setRefreshing(true);
    }

    if (refreshInFlightRef.current !== null) {
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
    realtimeDirtyRef,
    refreshInFlightRef,
    hasLoadedOnceRef,
    previousPendingCountRef,
    requestGuardQueueRefresh,
  };
}
