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
  error: string | null;
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
  error: null,
  updatedAt: null,
};

let currentSnapshot = initialSnapshot;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let activeFetchController: AbortController | null = null;
const subscribers = new Set<() => void>();

function deserializePass(p: SerializedPass): GatePass {
  return {
    visitorId: p.visitorId,
    visitorName: p.visitorName,
    purpose: p.purpose,
    photoPublicId: p.photoPublicId ?? '',
    idImagePublicId: p.idImagePublicId,
    source: p.source,
    status: p.status,
    validFrom: asAppTimestamp(p.validFrom)!,
    validUntil: asAppTimestamp(p.validUntil)!,
    issuedAt: asAppTimestamp(p.issuedAt)!,
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

async function fetchDashboardData() {
  if (activeFetchController) {
    activeFetchController.abort();
  }
  const controller = new AbortController();
  activeFetchController = controller;

  try {
    const token = await getAccessToken();
    const response = await fetch('/api/admin/dashboard', {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    });

    const data = await response.json().catch(() => null) as DashboardApiResponse | null;
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
      error: null,
      updatedAt: Date.now(),
    };
    emitChange();
  } catch (error) {
    if (!controller.signal.aborted) {
      console.error('Dashboard data fetch error:', error);
      currentSnapshot = {
        ...currentSnapshot,
        loading: false,
        error: error instanceof Error ? error.message : 'The dashboard could not load visitor data.',
      };
      emitChange();
    }
  } finally {
    if (activeFetchController === controller) {
      activeFetchController = null;
    }
  }
}

function startPolling() {
  stopPolling();
  void fetchDashboardData();
  pollTimer = setInterval(() => {
    void fetchDashboardData();
  }, 30_000);
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  if (activeFetchController) {
    activeFetchController.abort();
    activeFetchController = null;
  }
}

function subscribe(callback: () => void) {
  subscribers.add(callback);
  if (subscribers.size === 1) {
    startPolling();
  }

  return () => {
    subscribers.delete(callback);
    if (subscribers.size === 0) {
      stopPolling();
      currentSnapshot = initialSnapshot;
    }
  };
}

function getSnapshot() {
  return currentSnapshot;
}

export function refreshAdminDashboardData() {
  if (subscribers.size > 0) {
    void fetchDashboardData();
  }
}

export function useAdminDashboardData(): DashboardDataSnapshot {
  return useSyncExternalStore(subscribe, getSnapshot, () => initialSnapshot);
}
