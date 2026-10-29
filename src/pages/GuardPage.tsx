import { formatManilaTime } from '@/lib/manilaTime';
import { useEffect, useState, useRef, useMemo } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { signOutCurrentActor } from '@/services/auth';
import { AuthenticatedImage } from '@/components/AuthenticatedImage';
import { subscribeToPassChanges, recordDecision, GuardApiError, type GuardQueuePass, searchGuardPendingQueue } from '@/services/guard';
import { useGuardQueue } from '@/hooks/useGuardQueue';
import {
  CheckCircle2,
  XCircle,
  Clock,
  WifiOff,
  MapPin,
  User,
  BarChart2,
  UserCheck,
  X,
  ZoomIn,
  LogOut,
  Loader2,
  RotateCcw,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import { Button, Card, EmptyState, Input, Select, StatCard, Modal, ConfirmModal } from '@/components/ui';
import { BrandMark } from '@/components/BrandMark';
import { toast } from 'sonner';
import { GuardAccountMenu } from '@/components/GuardAccountMenu';
import { GuardPasswordResetModal } from '@/components/GuardPasswordResetModal';
import { GuardVisitorRecoveryTab } from '@/components/guard/GuardVisitorRecoveryTab';
import { GuardOfflineRegistrationTab } from '@/components/guard/GuardOfflineRegistrationTab';
import {
  getPendingSyncCount,
  getOfflineRegistrations,
  getOfflineEvents,
  purgeStaleLocalData,
  transitionGuardOfflineStore,
  type OfflineRegistrationRecord,
  type OfflineEventRecord,
} from '@/lib/offline/guardIndexedDb';
import { runOfflineMaintenance } from '@/lib/offline/guardSyncManager';
import { getManilaDateString } from '@/lib/scheduling';
import { computeBackendAvailability } from '@/lib/offline/backendAvailability';
import { RequestTimeoutError } from '@/lib/fetchWithTimeout';

type PassWithId = GuardQueuePass;
type GuardTab = 'queue' | 'recovery' | 'offline_reg' | 'outbox';

export function GuardPage() {
  const { userData, uid } = useAuth();
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const {
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
    requestGuardQueueRefresh,
  } = useGuardQueue({
    onNewPendingPass: () => {
      if (audioRef.current) {
        audioRef.current.play().catch(() => undefined);
      }
    },
  });

  const [searchTerm, setSearchTerm] = useState('');
  const [authoritativeResults, setAuthoritativeResults] = useState<GuardQueuePass[]>([]);
  const [isSearchingAuthoritative, setIsSearchingAuthoritative] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [searchRevalidationVersion, setSearchRevalidationVersion] = useState(0);
  const searchGenerationRef = useRef(0);
  const [rejectingPass, setRejectingPass] = useState<GuardQueuePass | null>(null);
  const [processingPassIds, setProcessingPassIds] = useState<Set<string>>(new Set());
  const [rejectReason, setRejectReason] = useState('');
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  const [zoomImage, setZoomImage] = useState<string | null>(null);
  const [isRejecting, setIsRejecting] = useState(false);

  const [showPasswordReset, setShowPasswordReset] = useState(false);
  const [showSignOutModal, setShowSignOutModal] = useState(false);
  const [isSigningOut, setIsSigningOut] = useState(false);

  // Tab navigation & offline synchronization state
  const [activeTab, setActiveTab] = useState<GuardTab>('queue');
  const [pendingSyncCount, setPendingSyncCount] = useState({ registrations: 0, events: 0, total: 0 });
  const [isSyncing, setIsSyncing] = useState(false);
  const [outboxRegistrations, setOutboxRegistrations] = useState<OfflineRegistrationRecord[]>([]);
  const [outboxEvents, setOutboxEvents] = useState<OfflineEventRecord[]>([]);
  const [storePrepared, setStorePrepared] = useState(false);
  const [storeError, setStoreError] = useState<string | null>(null);

  // Function to refresh local IndexedDB outbox counts (Requirement 22)
  const refreshPendingCounts = async () => {
    if (!uid || !storePrepared) {
      setPendingSyncCount({ registrations: 0, events: 0, total: 0 });
      setOutboxRegistrations([]);
      setOutboxEvents([]);
      return;
    }
    try {
      const counts = await getPendingSyncCount(uid);
      setPendingSyncCount(counts);
      const [regs, evts] = await Promise.all([
        getOfflineRegistrations(uid),
        getOfflineEvents(uid),
      ]);
      setOutboxRegistrations(regs);
      setOutboxEvents(evts);
    } catch (e) {
      console.warn('Could not read offline outbox count:', e);
    }
  };

  useEffect(() => {
    let active = true;
    setStorePrepared(false);

    transitionGuardOfflineStore(uid ?? null)
      .then(() => {
        if (active) {
          if (uid) {
            setStorePrepared(true);
            setStoreError(null);
            void refreshPendingCounts();
          } else {
            setStorePrepared(false);
            setStoreError(null);
          }
        }
      })
      .catch((err) => {
        if (active) {
          console.error('Failed to transition local Guard store for actor:', err);
          setStoreError('Unable to initialize secure local offline storage for this account. Please refresh or contact support.');
          setStorePrepared(false);
        }
      });

    return () => {
      active = false;
    };
  }, [uid]);

  const isBackendOnline = computeBackendAvailability({
    isBrowserOnline: isOnline,
    queueError,
    refreshError,
    lastRequestFailed: false,
  });

  const prevBackendOnlineRef = useRef(isBackendOnline);
  const initialSyncAttemptedRef = useRef(false);

  useEffect(() => {
    void refreshPendingCounts();
    const becameAvailable = !prevBackendOnlineRef.current && isBackendOnline;
    prevBackendOnlineRef.current = isBackendOnline;

    if (becameAvailable || (!initialSyncAttemptedRef.current && isBackendOnline)) {
      initialSyncAttemptedRef.current = true;
      void runOfflineMaintenance()
        .then(() => refreshPendingCounts())
        .catch((err) => {
          console.warn('Initial offline maintenance failed:', err);
        });
    }
  }, [isBackendOnline]);

  const handleSyncNow = async () => {
    setIsSyncing(true);
    try {
      const { summary } = await runOfflineMaintenance();
      if (summary.errors > 0) {
        toast.error(`Sync completed with ${summary.errors} error(s). Review outbox.`);
      } else if (summary.conflicts > 0) {
        toast.warning(`Sync completed. ${summary.conflicts} record(s) flagged for reconciliation.`);
      } else if (summary.registrationsSynced + summary.eventsSynced > 0) {
        toast.success(`Synced ${summary.registrationsSynced} registration(s) and ${summary.eventsSynced} event(s)!`);
      } else {
        toast.info('All offline records are already synchronized.');
      }
      await refreshPendingCounts();
      void refreshQueue();
    } catch (err: any) {
      toast.error(err.message || 'Synchronization failed');
    } finally {
      setIsSyncing(false);
    }
  };

  const handlePurgeSynced = async () => {
    try {
      const today = getManilaDateString();
      const res = await purgeStaleLocalData(today);
      toast.success(`Purged ${res.purgedVisitors} stale visitor(s) and ${res.purgedEvents} synced event(s).`);
      await refreshPendingCounts();
    } catch (err: any) {
      toast.error('Failed to purge stale local data');
    }
  };

  // ============================================================
  // INITIAL LOAD, REALTIME & 5-SECOND POLLING (PATCH 4, 53, 54)
  // ============================================================
  useEffect(() => {
    void requestGuardQueueRefresh({ reason: 'initial' });
    const stopRealtime = subscribeToPassChanges(() => {
      void requestGuardQueueRefresh({
        reason: 'realtime',
        showRefreshing: true,
      });
      setSearchRevalidationVersion((v) => v + 1);
    });
    const poll = window.setInterval(() => {
      void requestGuardQueueRefresh({
        reason: 'poll',
        showRefreshing: true,
      });
    }, 5000);
    return () => {
      stopRealtime();
      window.clearInterval(poll);
    };
  }, [requestGuardQueueRefresh]);

  // ============================================================
  // LOAD MORE: TARGET INCREASE VIA CENTRAL WRITER (PATCH 29, 31, 53, 54)
  // ============================================================
  async function handleLoadMore() {
    if (loadingMore || !hasMore) return;
    setLoadingMore(true);

    desiredQueueSizeRef.current = Math.min(
      Math.max(desiredQueueSizeRef.current, 50) + 50,
      5000
    );

    try {
      const result = await requestGuardQueueRefresh({ reason: 'intent' });
      if (!result.committed && result.error) {
        toast.error('Failed to load more passes.');
      }
    } finally {
      if (mountedRef.current) {
        setLoadingMore(false);
      }
    }
  }

  // ============================================================
  // LOAD ALL: TARGET EXPANSION VIA CENTRAL WRITER (PATCH 30, 31, 53, 54)
  // ============================================================
  async function handleLoadAll() {
    if (loadingMore || !hasMore) return;
    setLoadingMore(true);

    desiredQueueSizeRef.current = 5000;

    try {
      const result = await requestGuardQueueRefresh({ reason: 'intent' });
      if (result.committed && result.dashboard) {
        if (result.dashboard.reachedSafetyCeiling) {
          toast.info(
            'Loaded the first 5,000 pending passes. Narrow the search or continue using paginated queue controls.'
          );
        } else {
          toast.success(`Loaded all ${result.dashboard.queue.length} pending passes.`);
        }
      } else if (!result.committed && result.error) {
        toast.error('Failed to load all passes.');
      }
    } finally {
      if (mountedRef.current) {
        setLoadingMore(false);
      }
    }
  }

  // ============================================================
  // ONLINE/OFFLINE DETECTION
  // ============================================================
  useEffect(() => {
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  // Central refresh alias for decision post-processing (PATCH 26, 32, 53, 54)
  const refreshQueue = async () => {
    await requestGuardQueueRefresh({ reason: 'intent' });
  };

  // ============================================================
  // APPROVE
  // ============================================================
  async function handleApprove(pass: PassWithId) {
    if (processingPassIds.has(pass.id)) return;
    setProcessingPassIds((prev) => new Set(prev).add(pass.id));

    try {
      await recordDecision(pass.id, 'approved');
      toast.success(`${pass.visitorName} approved`);
      setAuthoritativeResults((prev) => prev.filter((p) => p.id !== pass.id));
      void refreshQueue();
    } catch (err: unknown) {
      if (err instanceof RequestTimeoutError) {
        toast.error('Approval request timed out. Outcome may be ambiguous; refreshing queue.');
        void refreshQueue();
        return;
      }
      if (err instanceof GuardApiError) {
        if (err.status === 409) {
          toast.info('This visitor was already processed by another guard.');
          setAuthoritativeResults((prev) => prev.filter((p) => p.id !== pass.id));
          void refreshQueue();
          return;
        }
        if (err.status === 422) {
          toast.info('This pass has expired and can no longer be approved.');
          setAuthoritativeResults((prev) => prev.filter((p) => p.id !== pass.id));
          void refreshQueue();
          return;
        }
        if (err.status === 401 || err.status === 403) {
          toast.error(err.message || 'Authentication or permissions error');
          return;
        }
      }
      toast.error('Failed to approve. Try again.');
    } finally {
      setProcessingPassIds((prev) => {
        const next = new Set(prev);
        next.delete(pass.id);
        return next;
      });
    }
  }

  // ============================================================
  // REJECT
  // ============================================================
  async function handleReject(pass: PassWithId) {
    if (!rejectReason.trim()) {
      toast.error('Select or type a rejection reason.');
      return;
    }
    if (processingPassIds.has(pass.id)) return;
    setProcessingPassIds((prev) => new Set(prev).add(pass.id));

    try {
      await recordDecision(pass.id, 'rejected', rejectReason);
      toast.success(`${pass.visitorName} rejected`);
      setAuthoritativeResults((prev) => prev.filter((p) => p.id !== pass.id));
      setRejectingPass(null);
      setRejectReason('');
      setIsRejecting(false);
      void refreshQueue();
    } catch (err: unknown) {
      setRejectingPass(null);
      setRejectReason('');
      setIsRejecting(false);
      if (err instanceof RequestTimeoutError) {
        toast.error('Rejection request timed out. Outcome may be ambiguous; refreshing queue.');
        void refreshQueue();
        return;
      }
      if (err instanceof GuardApiError) {
        if (err.status === 409) {
          toast.info('This visitor was already processed by another guard.');
          setAuthoritativeResults((prev) => prev.filter((p) => p.id !== pass.id));
          void refreshQueue();
          return;
        }
        if (err.status === 422) {
          toast.info('This pass has expired and can no longer be approved.');
          setAuthoritativeResults((prev) => prev.filter((p) => p.id !== pass.id));
          void refreshQueue();
          return;
        }
        if (err.status === 401 || err.status === 403) {
          toast.error(err.message || 'Authentication or permissions error');
          return;
        }
      }
      console.error('Reject error:', err);
      toast.error('Failed to reject. Try again.');
    } finally {
      setProcessingPassIds((prev) => {
        const next = new Set(prev);
        next.delete(pass.id);
        return next;
      });
    }
  }

  // ============================================================
  // AUTHORITATIVE SEARCH CONTROLLER & DEDUPLICATION (PATCH 55)
  // ============================================================
  useEffect(() => {
    const trimmed = searchTerm.trim();
    if (trimmed.length < 2) {
      searchGenerationRef.current += 1;
      setAuthoritativeResults([]);
      setIsSearchingAuthoritative(false);
      setSearchError(null);
      return;
    }

    const generation = ++searchGenerationRef.current;
    setIsSearchingAuthoritative(true);
    setSearchError(null);

    const timer = setTimeout(async () => {
      try {
        const results = await searchGuardPendingQueue(trimmed);
        if (generation === searchGenerationRef.current) {
          setAuthoritativeResults(results);
          setIsSearchingAuthoritative(false);
        }
      } catch (err) {
        if (generation === searchGenerationRef.current) {
          setSearchError('Search unavailable. The live queue remains available.');
          setIsSearchingAuthoritative(false);
        }
      }
    }, 280);

    return () => {
      clearTimeout(timer);
    };
  }, [searchTerm, searchRevalidationVersion]);

  const handleClearSearch = () => {
    searchGenerationRef.current += 1;
    setSearchTerm('');
    setAuthoritativeResults([]);
    setIsSearchingAuthoritative(false);
    setSearchError(null);
  };

  // Immediate local filter combined with authoritative server results
  const filteredPasses = useMemo(() => {
    const trimmed = searchTerm.trim();
    if (!trimmed) {
      return passes;
    }

    const q = trimmed.toLowerCase();
    const localMatches = passes.filter((p) =>
      (p.visitorName ?? '').toLowerCase().includes(q) ||
      (p.purpose ?? '').toLowerCase().includes(q) ||
      (p.publicReference ?? '').toLowerCase().includes(q) ||
      (p.contactNumber ?? '').toLowerCase().includes(q)
    );

    if (trimmed.length < 2) {
      return localMatches;
    }

    // Authoritative results win when duplicate IDs exist
    const passMap = new Map<string, GuardQueuePass>();
    for (const p of localMatches) {
      passMap.set(p.id, p);
    }
    for (const p of authoritativeResults) {
      passMap.set(p.id, p);
    }

    return Array.from(passMap.values()).sort((a, b) => {
      if (a.scannedAt && b.scannedAt) {
        const diff = new Date(a.scannedAt).getTime() - new Date(b.scannedAt).getTime();
        if (diff !== 0) return diff;
      } else if (a.scannedAt && !b.scannedAt) {
        return -1;
      } else if (!a.scannedAt && b.scannedAt) {
        return 1;
      }
      return a.id.localeCompare(b.id);
    });
  }, [searchTerm, passes, authoritativeResults]);

  const searchStatusMessage = useMemo(() => {
    const trimmed = searchTerm.trim();
    if (!trimmed) return null;
    if (isSearchingAuthoritative) {
      return 'Searching all pending visitors…';
    }
    if (searchError) {
      return searchError;
    }
    if (filteredPasses.length > 0) {
      return `${filteredPasses.length} matching pending ${filteredPasses.length === 1 ? 'visitor' : 'visitors'}`;
    }
    return 'No pending visitors match this search.';
  }, [searchTerm, isSearchingAuthoritative, searchError, filteredPasses.length]);

  // ============================================================
  // PENDING AGE & WAITING-TIME VISIBILITY (0-5m normal, 5-10m attention, 10m+ long)
  // ============================================================

  function getWaitingTimeInfo(scannedAt: string | null): { text: string; tone: 'normal' | 'attention' | 'long' } | null {
    if (!scannedAt) return null;
    const scannedMs = new Date(scannedAt).getTime();
    const diffMs = Date.now() - scannedMs;
    if (isNaN(diffMs) || diffMs < 0) return null;
    const minutes = Math.floor(diffMs / 60000);
    const text = minutes < 1 ? 'Waiting < 1 min' : `Waiting ${minutes} min`;
    let tone: 'normal' | 'attention' | 'long' = 'normal';
    if (minutes >= 10) {
      tone = 'long';
    } else if (minutes >= 5) {
      tone = 'attention';
    }
    return { text, tone };
  }

  // ============================================================
  // ============================================================
  // AUTH ACTIONS
  // ============================================================
  async function handleSignOut() {
    setIsSigningOut(true);
    try {
      if (uid) {
        let counts = await getPendingSyncCount(uid);
        if (counts.total > 0) {
          if (isBackendOnline) {
            toast.info('Synchronizing pending records before sign-out…');
            await runOfflineMaintenance();
            counts = await getPendingSyncCount(uid);
          }
          if (counts.total > 0) {
            toast.error(
              'This device still has unsynchronized visitor records. Synchronize them before signing out so visitor evidence and audit attribution are not lost.',
              { duration: 8000 }
            );
            setIsSigningOut(false);
            setShowSignOutModal(false);
            return;
          }
        }
        await transitionGuardOfflineStore(null);
      }
      await signOutCurrentActor();
    } catch (err) {
      toast.error('Failed to sign out');
    } finally {
      setIsSigningOut(false);
      setShowSignOutModal(false);
    }
  }

  // ============================================================
  // RENDER
  // ============================================================
  return (
    <main id="main-content" className="mx-auto min-h-dvh max-w-screen-2xl bg-[var(--color-canvas)] p-4 sm:p-6 lg:p-8">
      {/* Simple beep audio — we generate it programmatically to avoid external files */}
      <audio ref={audioRef} preload="auto">
        <source
          src="data:audio/wav;base64,UklGRnoGAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YVoGAACAgICAgICAgICAgICAgICAgICAgICAgICAf3+AgYGCgoODhISFhYaGhoaGhoWFhISEg4OCgoGBgICAgIB/f39+fn59fX19fX19fX1+fn5/f3+AgIGBgoKDg4ODhISEhISEhISDg4OCgoGBgIB/f39+fn59fX19fX19fn5+f39/gICBgYKCg4ODg4OEhISEhISDg4OCgoGBgIB/f39+fn59fX19fX19fn5+f3+AgIGBgoKDg4OEhISEhISDg4OCgoGBgH9/f35+fn19fX19fX1+fn5/gICBgYKCg4ODhIWFhYWFhISEg4OCgoGBgICAf39/fn5+fX19fX19fX5+fn9/f4CAgYGCgoODg4SEhISDg4ODgoKBgYCAf39/fn5+fX19fX19fn5+fn9/f4CAgYGCgoODg4SEhISEhISDg4KCgYGAf39/fn5+fX19fX19fn5+fn9/gICBgYKCg4ODhISEhISEhIODgoKBgYB/f39+fn59fX19fn5+fn5/f3+AgIGBgoKCg4OEhISEhISDg4OCgoGBgIB/f39+fn59fX19fn5+fn9/f4CAgICBgoKDg4SEhISEhISDg4OCgoGBgIB/f39+fn5+fX1+fn5+fn9/gICAgYGCgoODg4SEhISEg4ODgoKBgYGAf39/fn5+fn19fn5+fn5/f4CAgIGBgoKDg4OEhISEhIODgoKBgYGAf39+fn5+fn19fn5+fn9/f4CAgIGBgoKDg4OEhISEg4ODgoKBgYGAf39/fn5+fn5+fn5+fn9/gICAgYGCgoODg4OEhISDg4OCgoGBgIB/f39+fn5+fn5+fn5/f3+AgIGBgYKCg4ODhISDg4ODgoKBgYCAf39/fn5+fn5+fn5+f39/gICBgYGCgoODg4OEg4ODg4KCgYGAgH9/f35+fn5+fn5+fn9/gICAgYGBgoKDg4ODg4ODg4KCgYGBgH9/f35+fn5+fn5+f39/gICBgYGCgoKDg4ODg4ODgoKBgYGAf39/fn5+fn5+fn5/f39/gICBgYGCgoKDg4ODg4OCgoKBgYGAf39/fn5+fn5+fn5/f3+AgICBgYGCgoKDg4ODg4OCgoGBgYCAf39/fn5+fn5+fn9/f3+AgICBgYGCgoKDg4ODgoKCgoGBgICAf39/fn5+fn5+fn9/f3+AgICBgYGCgoKDg4OCgoKCgYGBgIB/f39+fn5+fn5+f39/f4CAgICBgYGCgoKDg4OCgoKBgYGBgH9/f35+fn5+fn9/f39/gICAgIGBgYKCgoODg4KCgoGBgYGAf39/fn5+fn5+f39/f3+AgICAgYGBgoKCg4KCgoKBgYGAgH9/f35+fn5+fn9/f39/gICAgIGBgYKCgoKCgoKCgYGBgICAf39/fn5+fn5/f39/f4CAgICBgYGBgoKCgoKCgoGBgYCAgH9/f39+fn5+f39/f3+AgICAgICBgYGCgoKCgoKBgYGBgICAf39/fn5+fn9/f39/f4CAgICBgYGBgoKCgoKCgYGBgYCAgH9/f39+fn5/f39/f3+AgICAgIGBgYKCgoKCgoGBgYGAgIB/f39/fn5+f39/f39/gICAgICBgYGBgoKCgoKBgYGBgICAf39/f39+f39/f39/f4CAgICAgYGBgYKCgoKCgYGBgYCAgH9/f39/fn9/f39/f3+AgICAgICBgYGBgoKCgYGBgYGAgIB/f39/f39/f39/f39/gICAgICAgYGBgYKCgoGBgYGBgICAf39/f39/f39/f39/f4CAgICAgIGBgYGCgoGBgYGBgICAf39/f39/f39/f39/gICAgICAgIGBgYGBgoGBgYGBgICAf39/f39/f39/f39/gICAgICAgICBgYGBgYGBgYGBgICAf39/f39/f39/f39/gICAgICAgICBgYGBgYGBgYGAgICAf39/f39/f39/f39/f4CAgICAgICBgYGBgYGBgYCAgICAgH9/f39/f39/f39/f4CAgICAgICBgYGBgYGBgYCAgICAf39/f39/f39/f39/f4CAgICAgICBgYGBgYGBgICAgIB/f39/f39/f39/f3+AgICAgICAgIGBgYGBgYGAgICAgH9/f39/f39/f39/f4CAgICAgICAgYGBgYGBgICAgICAf39/f39/f39/f3+AgICAgICAgICBgYGBgYCAgICAgH9/f39/f39/f39/gICAgICAgICAgYGBgYCAgICAgIB/f39/f39/f39/f4CAgICAgICA"
          type="audio/wav"
        />
      </audio>

      {/* Phase 5.6 Offline Banner */}
      {!isBackendOnline && (
        <div className="mb-4 rounded-xl border border-amber-500/50 bg-amber-50 dark:bg-amber-950/30 p-4 text-amber-900 dark:text-amber-200 shadow-sm" role="status">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div className="flex items-start gap-3">
              <WifiOff className="h-5 w-5 mt-0.5 shrink-0 text-amber-600 dark:text-amber-400" />
              <div>
                <h2 className="text-sm font-bold uppercase tracking-wide flex items-center gap-2">
                  <span>⚠ OFFLINE OPERATIONS</span>
                  {!isOnline && (
                    <span className="text-xs font-normal opacity-80">(Connection lost — data may be stale)</span>
                  )}
                </h2>
                <p className="text-sm font-medium mt-0.5">
                  Cloud services are unavailable. Visitor actions are being stored on this device pending synchronization.
                </p>
                {pendingSyncCount.total > 0 && (
                  <p className="text-xs font-bold mt-1 text-[#800000] dark:text-amber-300">
                    {pendingSyncCount.total} {pendingSyncCount.total === 1 ? 'record' : 'records'} awaiting synchronization
                  </p>
                )}
              </div>
            </div>
            {isOnline && (
              <Button
                variant="secondary"
                size="sm"
                onClick={handleSyncNow}
                disabled={isSyncing || !isBackendOnline}
                icon={isSyncing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />}
              >
                {isSyncing ? 'Syncing…' : 'Sync Now'}
              </Button>
            )}
          </div>
        </div>
      )}

      {/* Header */}
      <div className="mb-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <p className="mb-1 text-xs font-bold uppercase tracking-widest text-[var(--color-brand)]">Campus security</p>
          <h1 className="text-2xl font-bold text-[var(--color-text-primary)]">
            Guard Operations
          </h1>
          <p className="mt-1 text-sm text-[var(--color-text-secondary)]">
            {pendingTotal} pending verification{pendingTotal !== 1 ? 's' : ''}
            {passes.length < pendingTotal ? ` (showing ${passes.length} of ${pendingTotal})` : ''}
          </p>
          <div className="mt-1 flex items-center gap-2 text-xs">
            {refreshing ? (
              <span className="inline-flex items-center gap-1.5 text-[var(--color-brand)] font-medium" role="status" aria-live="polite">
                <Loader2 className="h-3.5 w-3.5 animate-spin shrink-0" aria-hidden="true" />
                Updating…
              </span>
            ) : refreshError && lastUpdatedAt ? (
              <span className="text-[var(--color-warning-dark)] font-medium" role="status">
                Connection delayed — showing queue from {formatManilaTime(lastUpdatedAt)}.
              </span>
            ) : lastUpdatedAt ? (
              <span className="text-[var(--color-text-secondary)]">Updated {formatManilaTime(lastUpdatedAt)}</span>
            ) : null}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <GuardAccountMenu
            name={userData && 'name' in userData ? userData.name : 'Guard'}
            onResetPassword={() => setShowPasswordReset(true)}
          />
          <Button variant="destructive-outline" size="sm" onClick={() => setShowSignOutModal(true)} icon={<LogOut className="w-4 h-4" />}>
            Sign Out
          </Button>
        </div>
      </div>

      {/* Navigation Tabs (Phases 4, 5, 6, 7) */}
      <div className="mb-6 flex flex-wrap items-center gap-2 border-b border-[var(--color-border)] pb-3">
        <button
          type="button"
          onClick={() => setActiveTab('queue')}
          className={`flex items-center gap-2 rounded-lg px-3.5 py-2 text-sm font-semibold transition-all ${
            activeTab === 'queue'
              ? 'bg-[#800000] text-white shadow-sm'
              : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)]'
          }`}
        >
          <Clock className="h-4 w-4" />
          <span>Pending Queue</span>
          {pendingTotal > 0 && (
            <span
              className={`rounded-full px-2 py-0.5 text-xs font-bold ${
                activeTab === 'queue'
                  ? 'bg-white text-[#800000]'
                  : 'bg-[var(--color-brand)] text-white'
              }`}
            >
              {pendingTotal}
            </span>
          )}
        </button>

        <button
          type="button"
          onClick={() => setActiveTab('recovery')}
          className={`flex items-center gap-2 rounded-lg px-3.5 py-2 text-sm font-semibold transition-all ${
            activeTab === 'recovery'
              ? 'bg-[#800000] text-white shadow-sm'
              : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)]'
          }`}
        >
          <UserCheck className="h-4 w-4" />
          <span>Visitor Recovery</span>
        </button>

        <button
          type="button"
          onClick={() => setActiveTab('offline_reg')}
          className={`flex items-center gap-2 rounded-lg px-3.5 py-2 text-sm font-semibold transition-all ${
            activeTab === 'offline_reg'
              ? 'bg-[#800000] text-white shadow-sm'
              : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)]'
          }`}
        >
          <User className="h-4 w-4" />
          <span>Offline Registration</span>
        </button>

        <button
          type="button"
          onClick={() => setActiveTab('outbox')}
          className={`flex items-center gap-2 rounded-lg px-3.5 py-2 text-sm font-semibold transition-all ${
            activeTab === 'outbox'
              ? 'bg-[#800000] text-white shadow-sm'
              : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)]'
          }`}
        >
          <RotateCcw className="h-4 w-4" />
          <span>Offline Outbox</span>
          {pendingSyncCount.total > 0 && (
            <span className="rounded-full bg-amber-500 text-white px-2 py-0.5 text-xs font-bold">
              {pendingSyncCount.total}
            </span>
          )}
        </button>
      </div>

      {storeError && (
        <Card className="p-6 border-red-300 bg-red-50 dark:bg-red-950/20 text-center mb-6">
          <p className="text-sm font-semibold text-red-800 dark:text-red-300">{storeError}</p>
        </Card>
      )}

      {!storePrepared && !storeError && (
        <div className="p-4 text-center text-sm text-[var(--color-text-secondary)]">
          Initializing offline store…
        </div>
      )}

      {activeTab === 'recovery' && storePrepared && uid && !storeError && (
        <GuardVisitorRecoveryTab
          isBackendOnline={isBackendOnline}
          actorId={uid}
          onActionComplete={refreshPendingCounts}
        />
      )}

      {activeTab === 'offline_reg' && storePrepared && uid && !storeError && (
        <GuardOfflineRegistrationTab
          isBackendOnline={isBackendOnline}
          actorId={uid}
          onRegistered={refreshPendingCounts}
        />
      )}

      {activeTab === 'outbox' && (
        <div className="space-y-6">
          <Card className="p-6">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-[var(--color-border)] pb-4">
              <div>
                <h2 className="text-lg font-bold text-[var(--color-text-primary)] flex items-center gap-2">
                  <RotateCcw className="h-5 w-5 text-[#800000]" />
                  <span>Offline Synchronization Outbox</span>
                </h2>
                <p className="mt-1 text-xs text-[var(--color-text-secondary)]">
                  Actions and registrations created while disconnected are queued here and safely synced using idempotent row-locking when online.
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <Button
                  onClick={handleSyncNow}
                  disabled={isSyncing || !isOnline}
                  loading={isSyncing}
                  size="sm"
                  className="bg-[#800000] hover:bg-[#660000]"
                  icon={<RefreshCw className="h-4 w-4" />}
                >
                  Sync All Pending ({pendingSyncCount.total})
                </Button>
                <Button
                  onClick={handlePurgeSynced}
                  variant="secondary"
                  size="sm"
                  icon={<Trash2 className="h-4 w-4" />}
                >
                  Purge Synced
                </Button>
              </div>
            </div>

            {/* Offline Registrations */}
            <div className="mt-6">
              <h3 className="text-sm font-bold text-[var(--color-text-primary)] mb-3 uppercase tracking-wide">
                Offline New Visitor Registrations ({outboxRegistrations.length})
              </h3>
              {outboxRegistrations.length === 0 ? (
                <p className="text-xs text-[var(--color-text-muted)] italic py-2">
                  No offline registrations currently queued.
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs">
                    <thead className="border-b border-[var(--color-border)] text-[var(--color-text-secondary)] uppercase">
                      <tr>
                        <th className="py-2 px-3">Visitor Name</th>
                        <th className="py-2 px-3">Purpose</th>
                        <th className="py-2 px-3">Decision</th>
                        <th className="py-2 px-3">Time</th>
                        <th className="py-2 px-3">Sync Status</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[var(--color-border)]">
                      {outboxRegistrations.map((reg) => (
                        <tr key={reg.offlineRegistrationId} className="hover:bg-[var(--color-surface-hover)]">
                          <td className="py-2.5 px-3 font-semibold text-[var(--color-text-primary)]">
                            {reg.visitor.firstName} {reg.visitor.lastName}
                          </td>
                          <td className="py-2.5 px-3 text-[var(--color-text-secondary)]">{reg.visitor.purpose}</td>
                          <td className="py-2.5 px-3">
                            <span
                              className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${
                                reg.action === 'approved'
                                  ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300'
                                  : 'bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-300'
                              }`}
                            >
                              {reg.action.toUpperCase()}
                            </span>
                          </td>
                          <td className="py-2.5 px-3 text-[var(--color-text-muted)]">
                            {new Date(reg.occurredAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                          </td>
                          <td className="py-2.5 px-3">
                            <span
                              className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${
                                reg.syncStatus === 'synced'
                                  ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300'
                                  : reg.syncStatus === 'conflict'
                                  ? 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300'
                                  : 'bg-zinc-100 text-zinc-800 dark:bg-zinc-800 dark:text-zinc-300'
                              }`}
                            >
                              {reg.syncStatus.toUpperCase()}
                            </span>
                            {reg.conflictReason && (
                              <p className="mt-0.5 text-[10px] text-amber-600">{reg.conflictReason}</p>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {/* Offline Gate Events */}
            <div className="mt-8 border-t border-[var(--color-border)] pt-6">
              <h3 className="text-sm font-bold text-[var(--color-text-primary)] mb-3 uppercase tracking-wide">
                Offline Gate Decisions & Exits ({outboxEvents.length})
              </h3>
              {outboxEvents.length === 0 ? (
                <p className="text-xs text-[var(--color-text-muted)] italic py-2">
                  No offline gate events queued.
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs">
                    <thead className="border-b border-[var(--color-border)] text-[var(--color-text-secondary)] uppercase">
                      <tr>
                        <th className="py-2 px-3">Pass ID</th>
                        <th className="py-2 px-3">Action</th>
                        <th className="py-2 px-3">Expected Prior Status</th>
                        <th className="py-2 px-3">Occurred At</th>
                        <th className="py-2 px-3">Sync Status</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[var(--color-border)]">
                      {outboxEvents.map((evt) => (
                        <tr key={evt.eventId} className="hover:bg-[var(--color-surface-hover)]">
                          <td className="py-2.5 px-3 font-mono text-[var(--color-text-primary)]">
                            {evt.passId.slice(0, 8)}…
                          </td>
                          <td className="py-2.5 px-3 font-semibold text-[var(--color-text-primary)]">
                            {evt.action.replace('_', ' ').toUpperCase()}
                          </td>
                          <td className="py-2.5 px-3 text-[var(--color-text-muted)]">{evt.expectedStatus}</td>
                          <td className="py-2.5 px-3 text-[var(--color-text-muted)]">
                            {new Date(evt.occurredAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                          </td>
                          <td className="py-2.5 px-3">
                            <span
                              className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${
                                evt.syncStatus === 'synced'
                                  ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300'
                                  : evt.syncStatus === 'conflict'
                                  ? 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300'
                                  : 'bg-zinc-100 text-zinc-800 dark:bg-zinc-800 dark:text-zinc-300'
                              }`}
                            >
                              {evt.syncStatus.toUpperCase()}
                            </span>
                            {evt.conflictReason && (
                              <p className="mt-0.5 text-[10px] text-amber-600">{evt.conflictReason}</p>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </Card>
        </div>
      )}

      {activeTab === 'queue' && (
        <>
          <div className="mb-6 flex flex-col gap-2 sm:items-end">
            <div className="flex w-full sm:w-96 items-center gap-2">
              <div className="relative flex-1">
                <Input
                  type="search"
                  aria-label="Search pending visitors"
                  placeholder="Search pending visitors…"
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                />
                {isSearchingAuthoritative && (
                  <div className="absolute right-3 top-1/2 -translate-y-1/2" role="status" aria-label="Searching">
                    <Loader2 className="h-4 w-4 animate-spin text-[var(--color-brand)]" />
                  </div>
                )}
              </div>
              {searchTerm && (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={handleClearSearch}
                  className="shrink-0"
                >
                  Clear Search
                </Button>
              )}
            </div>
            {searchTerm.trim().length > 0 && (
              <div className="text-xs font-medium text-[var(--color-text-secondary)]">
                {searchStatusMessage}
              </div>
            )}
          </div>

      {/* Daily Report Summary */}
      <div className="mb-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          title="Currently Inside"
          value={dailyStats.inside}
          icon={<UserCheck className="h-5 w-5 text-[var(--color-success)]" />}
          trend={`${dailyStats.inside} visitors on campus`}
          trendUp={true}
        />
        <StatCard
          title="Scanned Today"
          value={dailyStats.total}
          icon={<BarChart2 className="h-5 w-5 text-[var(--color-text-secondary)]" />}
        />
        <StatCard
          title="Exited Today"
          value={dailyStats.exited}
          icon={<UserCheck className="h-5 w-5 text-[var(--color-text-secondary)]" />}
          trend={`${dailyStats.exited} left campus`}
          trendUp={false}
        />
        <StatCard
          title="Rejected Today"
          value={dailyStats.rejected}
          icon={<X className="h-5 w-5 text-[var(--color-danger)]" />}
        />
      </div>

      {/* Pass Cards */}
      {initialLoading ? (
        <Card className="min-h-64 flex flex-col items-center justify-center p-8 text-center">
          <div className="h-10 w-10 animate-spin rounded-full border-4 border-[var(--color-brand)] border-t-transparent" />
          <p className="mt-4 text-sm font-semibold text-[var(--color-text-secondary)]">Loading pending passes…</p>
        </Card>
      ) : queueError ? (
        <EmptyState
          icon={<WifiOff className="h-8 w-8" />}
          title="Queue unavailable"
          description="The visitor queue could not be loaded. Check the connection and try again."
          className="min-h-64"
        />
      ) : filteredPasses.length === 0 ? (
        <EmptyState
          icon={<BrandMark size="sm" />}
          title={searchTerm ? 'No matching pending visitors' : 'No pending passes'}
          description={
            searchTerm
              ? 'No pending visitors match this search.'
              : 'New requests appear here after visitors scan at the entry gate.'
          }
          action={
            searchTerm ? (
              <Button variant="secondary" size="sm" onClick={handleClearSearch}>
                Clear Search
              </Button>
            ) : undefined
          }
          className="min-h-64"
        />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {filteredPasses.map((pass, index) => {
            const isActive = index === 0;

            if (isActive) {
              return (
                <Card
                  key={pass.id}
                  className="col-span-full overflow-hidden transition-all motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-2 motion-safe:duration-200"
                >
                  <div className="p-6">
                    <div className="mb-6 grid gap-6 md:grid-cols-3">
                      {/* Panel 1: Info */}
                      <div className="flex flex-col justify-center border-b pb-6 md:border-b-0 md:border-r md:pb-0 md:pr-6 border-[var(--color-border)]">
                        <div className="flex flex-wrap items-center gap-2">
                          <h3 className="text-2xl font-bold text-[var(--color-text-primary)]">
                            {pass.visitorName}
                          </h3>
                          {(() => {
                            const waitInfo = getWaitingTimeInfo(pass.scannedAt);
                            if (!waitInfo) return null;
                            const toneClasses =
                              waitInfo.tone === 'long'
                                ? 'bg-rose-100 text-rose-800 dark:bg-rose-950/80 dark:text-rose-300 border border-rose-300 dark:border-rose-800'
                                : waitInfo.tone === 'attention'
                                ? 'bg-amber-100 text-amber-800 dark:bg-amber-950/80 dark:text-amber-300 border border-amber-300 dark:border-amber-800'
                                : 'bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300 border border-zinc-200 dark:border-zinc-700';
                            return (
                              <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-semibold ${toneClasses}`}>
                                <Clock className="h-3 w-3" />
                                {waitInfo.text}
                              </span>
                            );
                          })()}
                        </div>
                        <p className="mt-2 text-base text-[var(--color-text-secondary)]">
                          {pass.purpose}
                        </p>
                        <div className="mt-6 space-y-2">
                          <div className="flex items-center gap-2 text-sm text-[var(--color-text-muted)]">
                            <Clock className="h-4 w-4" />
                            <span>
                              Scanned: {pass.scannedAt ? formatManilaTime(pass.scannedAt) : '—'}
                            </span>
                          </div>
                          {pass.gate && (
                            <div className="flex items-center gap-2 text-sm text-[var(--color-text-muted)]">
                              <MapPin className="h-4 w-4" />
                              <span>Gate: {pass.gate}</span>
                            </div>
                          )}
                          <div className="flex items-center gap-2 text-sm text-[var(--color-text-muted)]">
                            <CheckCircle2 className="h-4 w-4" />
                            <span>
                              Valid: {formatManilaTime(pass.validFrom)} - {formatManilaTime(pass.validUntil)}
                            </span>
                          </div>
                        </div>
                      </div>

                      {/* Panel 2: Face Photo */}
                      <div className="flex flex-col items-center border-b pb-6 md:border-b-0 md:border-r md:pb-0 md:pr-6 border-[var(--color-border)]">
                        <span className="mb-3 text-xs font-bold uppercase tracking-wider text-[var(--color-text-muted)]">Live Photo</span>
                        <div 
                          className="group relative cursor-pointer rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-brand)]"
                          onClick={() => setZoomImage(pass.photoPublicId)}
                          role="button"
                          aria-label="Enlarge live photo"
                          tabIndex={0}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter' || event.key === ' ') setZoomImage(pass.photoPublicId);
                          }}
                        >
                          <AuthenticatedImage
                            publicId={pass.photoPublicId}
                            alt="Face Photo"
                            className="h-56 w-48 rounded-xl bg-[var(--color-overlay)] object-cover shadow-sm"
                          />
                          <div className="absolute inset-0 bg-black/0 group-hover:bg-black/10 transition-colors rounded-xl flex items-center justify-center">
                            <ZoomIn className="text-white opacity-0 group-hover:opacity-100 transition-opacity drop-shadow-md h-8 w-8" />
                          </div>
                        </div>
                      </div>

                      {/* Panel 3: ID Photo */}
                      <div className="flex flex-col items-center">
                        <span className="mb-3 text-xs font-bold uppercase tracking-wider text-[var(--color-text-muted)]">Valid ID</span>
                        {pass.idImagePublicId ? (
                          <div 
                            className="group relative w-full max-w-xs cursor-pointer rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-brand)]"
                            onClick={() => setZoomImage(pass.idImagePublicId!)}
                            role="button"
                            aria-label="Enlarge ID photo"
                            tabIndex={0}
                            onKeyDown={(event) => {
                              if ((event.key === 'Enter' || event.key === ' ') && pass.idImagePublicId) setZoomImage(pass.idImagePublicId);
                            }}
                          >
                            <AuthenticatedImage
                              publicId={pass.idImagePublicId}
                              alt="ID Photo"
                              className="h-56 w-full rounded-xl bg-[var(--color-overlay)] object-contain shadow-sm"
                            />
                            <div className="absolute inset-0 bg-black/0 group-hover:bg-black/10 transition-colors rounded-xl flex items-center justify-center">
                              <ZoomIn className="text-white opacity-0 group-hover:opacity-100 transition-opacity drop-shadow-md h-8 w-8" />
                            </div>
                          </div>
                        ) : (
                          <div className="flex h-56 w-full max-w-xs items-center justify-center rounded-xl border-2 border-dashed border-[var(--color-border)] bg-[var(--color-canvas)] text-sm font-medium text-[var(--color-text-muted)]">
                            No ID (Walk-in)
                          </div>
                        )}
                      </div>
                    </div>

                    {/* Actions */}
                      <div className="mx-auto flex max-w-md flex-col gap-3 sm:flex-row md:max-w-none">
                        <Button
                          variant="success"
                          disabled={processingPassIds.has(pass.id)} onClick={() => handleApprove(pass)}
                          className="flex-1"
                          size="lg"
                          icon={<CheckCircle2 className="h-5 w-5" />}
                        >
                          Approve Visitor
                        </Button>
                        <Button
                          variant="destructive"
                          disabled={processingPassIds.has(pass.id)}
                          onClick={() => {
                            setRejectingPass(pass);
                            setIsRejecting(true);
                          }}
                          className="flex-1"
                          size="lg"
                          icon={<XCircle className="h-5 w-5" />}
                        >
                          Reject
                        </Button>
                      </div>
                  </div>
                </Card>
              );
            }

            // ==========================================
            // COMPACT CARD (Queued Passes)
            // ==========================================
            return (
              <Card
                key={pass.id}
                className="overflow-hidden opacity-75 transition-opacity hover:opacity-100"
              >
                <div className="p-4">
                  <div className="flex items-center gap-3">
                    <div className="flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-full bg-[var(--color-neutral-light)]">
                      <User className="h-5 w-5 text-[var(--color-text-muted)]" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between gap-1">
                        <h3 className="truncate text-sm font-bold text-[var(--color-text-primary)]">
                          {pass.visitorName}
                        </h3>
                        {(() => {
                          const waitInfo = getWaitingTimeInfo(pass.scannedAt);
                          if (!waitInfo) return null;
                          const toneClasses =
                            waitInfo.tone === 'long'
                              ? 'bg-rose-100 text-rose-800 dark:bg-rose-950/80 dark:text-rose-300 border border-rose-300 dark:border-rose-800'
                              : waitInfo.tone === 'attention'
                              ? 'bg-amber-100 text-amber-800 dark:bg-amber-950/80 dark:text-amber-300 border border-amber-300 dark:border-amber-800'
                              : 'bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300 border border-zinc-200 dark:border-zinc-700';
                          return (
                            <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold ${toneClasses}`}>
                              {waitInfo.text}
                            </span>
                          );
                        })()}
                      </div>
                      <p className="truncate text-xs text-[var(--color-text-secondary)] mt-0.5">
                        {pass.purpose}
                      </p>
                      <div className="mt-2 flex items-center gap-1.5 text-xs font-medium text-[var(--color-text-muted)]">
                        <Clock className="h-3 w-3" />
                        {pass.scannedAt ? formatManilaTime(pass.scannedAt) : '—'}
                        {pass.gate && ` • ${pass.gate}`}
                      </div>
                    </div>
                  </div>
                  <div className="mt-4 flex gap-2">
                    <Button
                      variant="success"
                      disabled={processingPassIds.has(pass.id)} onClick={() => handleApprove(pass)}
                      className="flex-1"
                      size="sm"
                      icon={<CheckCircle2 className="h-4 w-4" />}
                    >
                      Approve
                    </Button>
                    <Button
                      variant="destructive"
                      onClick={() => {
                        setRejectingPass(pass);
                        setIsRejecting(true);
                      }}
                      className="flex-1"
                      size="sm"
                      icon={<XCircle className="h-4 w-4" />}
                    >
                      Reject
                    </Button>
                  </div>
                </div>
              </Card>
            );
          })}
          {hasMore && !searchTerm && (
            <div className="col-span-full mt-4 flex flex-wrap justify-center gap-3">
              <Button
                variant="secondary"
                size="md"
                onClick={handleLoadMore}
                loading={loadingMore}
              >
                Load More Pending Passes ({passes.length} of {pendingTotal})
              </Button>
              <Button
                variant="ghost"
                size="md"
                onClick={handleLoadAll}
                loading={loadingMore}
              >
                Load All Pending Passes ({pendingTotal})
              </Button>
            </div>
          )}
        </div>
      )}
      </>
      )}
      {/* Reject Modal */}
      <Modal
        isOpen={isRejecting}
        onClose={() => {
          setIsRejecting(false);
          setRejectReason('');
        }}
        title="Reject Visitor"
        size="sm"
      >
        <div className="space-y-4">
          <p className="text-sm text-[var(--color-text-secondary)]">
            Please provide a reason for rejection. This will be recorded in the audit logs.
          </p>
          <Select
            value={rejectReason}
            onChange={(e) => setRejectReason(e.target.value)}
            aria-label="Rejection reason"
          >
            <option value="">Select reason…</option>
            {rejectionReasons.map((reason) => (
              <option key={reason} value={reason}>
                {reason}
              </option>
            ))}
          </Select>
          <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
            <Button
              variant="secondary"
              onClick={() => {
                setIsRejecting(false);
                setRejectReason('');
                setRejectingPass(null);
              }}
              className="w-full sm:w-auto"
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (rejectingPass) handleReject(rejectingPass);
              }}
              disabled={!rejectReason || (rejectingPass ? processingPassIds.has(rejectingPass.id) : false)}
              className="w-full sm:w-auto"
            >
              {rejectingPass && processingPassIds.has(rejectingPass.id) ? 'Rejecting...' : 'Confirm Reject'}
            </Button>
          </div>
        </div>
      </Modal>

      {/* Image Zoom Modal */}
      <Modal
        isOpen={!!zoomImage}
        onClose={() => setZoomImage(null)}
        hideTitleRow
        size="lg"
      >
        {zoomImage && (
          <div className="flex items-center justify-center">
            <AuthenticatedImage
              publicId={zoomImage}
              alt="Zoomed"
              className="w-full h-auto max-h-[85vh] object-contain rounded-xl"
            />
          </div>
        )}
      </Modal>

      <GuardPasswordResetModal
        isOpen={showPasswordReset}
        email={userData?.kind === 'staff' ? userData.email : ''}
        onClose={() => setShowPasswordReset(false)}
      />

      <ConfirmModal
        isOpen={showSignOutModal}
        onClose={() => setShowSignOutModal(false)}
        title="Confirm Sign Out"
        description="Are you sure you want to log out of your account?"
        onConfirm={handleSignOut}
        confirmText={isSigningOut ? "Signing Out..." : "Sign Out"}
        cancelText="Cancel"
        isDestructive={true}
        loading={isSigningOut}
      />
    </main>
  );
}
