import { useSyncExternalStore } from 'react';
import {
  collection,
  onSnapshot,
  query,
  where,
  type DocumentData,
  type Query,
} from 'firebase/firestore';
import { endOfDay, endOfMonth, startOfDay, startOfMonth } from 'date-fns';
import { db } from '@/lib/firebase';
import type { GatePass } from '@/types';

interface DashboardDataSnapshot {
  recentPasses: GatePass[];
  insidePasses: GatePass[];
  exitedTodayPasses: GatePass[];
  decisionsTodayPasses: GatePass[];
  loading: boolean;
  error: string | null;
  updatedAt: number | null;
}

type PassSource = keyof Pick<
  DashboardDataSnapshot,
  'recentPasses' | 'insidePasses' | 'exitedTodayPasses' | 'decisionsTodayPasses'
>;

const initialSnapshot: DashboardDataSnapshot = {
  recentPasses: [],
  insidePasses: [],
  exitedTodayPasses: [],
  decisionsTodayPasses: [],
  loading: true,
  error: null,
  updatedAt: null,
};

let currentSnapshot = initialSnapshot;
let pendingSources = new Set<PassSource>();
let firestoreUnsubscribes: Array<() => void> = [];
let midnightTimer: ReturnType<typeof setTimeout> | null = null;
let generation = 0;
const subscribers = new Set<() => void>();

function emitChange() {
  subscribers.forEach((subscriber) => subscriber());
}

function stopFirestoreListeners() {
  generation++;
  firestoreUnsubscribes.forEach((unsubscribe) => unsubscribe());
  firestoreUnsubscribes = [];
  if (midnightTimer) clearTimeout(midnightTimer);
  midnightTimer = null;
}

function listenToPasses(source: PassSource, passesQuery: Query<DocumentData>, activeGeneration: number) {
  const unsubscribe = onSnapshot(
    passesQuery,
    (querySnapshot) => {
      if (activeGeneration !== generation) return;
      pendingSources.delete(source);
      currentSnapshot = {
        ...currentSnapshot,
        [source]: querySnapshot.docs.map((document) => document.data() as GatePass),
        loading: pendingSources.size > 0,
        updatedAt: Date.now(),
      };
      emitChange();
    },
    (error) => {
      if (activeGeneration !== generation) return;
      console.error(`Dashboard listener failed for ${source}:`, error);
      pendingSources.delete(source);
      currentSnapshot = {
        ...currentSnapshot,
        loading: pendingSources.size > 0,
        error: 'The dashboard could not load live visitor data.',
      };
      emitChange();
    }
  );
  firestoreUnsubscribes.push(unsubscribe);
}

function startFirestoreListeners() {
  stopFirestoreListeners();
  currentSnapshot = initialSnapshot;
  pendingSources = new Set<PassSource>([
    'recentPasses',
    'insidePasses',
    'exitedTodayPasses',
    'decisionsTodayPasses',
  ]);
  emitChange();

  const activeGeneration = generation;
  const now = new Date();
  const startToday = startOfDay(now);
  const endToday = endOfDay(now);
  const monthStart = startOfMonth(now);
  const dataEnd = endOfMonth(now);
  const passes = collection(db, 'gatePasses');

  listenToPasses(
    'recentPasses',
    query(passes, where('issuedAt', '>=', monthStart), where('issuedAt', '<=', dataEnd)),
    activeGeneration
  );
  listenToPasses('insidePasses', query(passes, where('status', '==', 'inside')), activeGeneration);
  listenToPasses(
    'exitedTodayPasses',
    query(passes, where('timeOut', '>=', startToday), where('timeOut', '<=', endToday)),
    activeGeneration
  );
  listenToPasses(
    'decisionsTodayPasses',
    query(passes, where('scannedAt', '>=', startToday), where('scannedAt', '<=', endToday)),
    activeGeneration
  );

  const nextMidnight = startOfDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1));
  midnightTimer = setTimeout(refreshAdminDashboardData, nextMidnight.getTime() - now.getTime() + 1000);
}

function subscribe(callback: () => void) {
  subscribers.add(callback);
  if (subscribers.size === 1) startFirestoreListeners();

  return () => {
    subscribers.delete(callback);
    if (subscribers.size === 0) {
      stopFirestoreListeners();
      currentSnapshot = initialSnapshot;
    }
  };
}

function getSnapshot() {
  return currentSnapshot;
}

export function refreshAdminDashboardData() {
  if (subscribers.size > 0) startFirestoreListeners();
}

export function useAdminDashboardData() {
  return useSyncExternalStore(subscribe, getSnapshot, () => initialSnapshot);
}
