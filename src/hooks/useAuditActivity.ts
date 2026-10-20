import { useCallback, useEffect, useRef, useState } from 'react';
import {
  collection,
  documentId,
  getDocs,
  limit,
  orderBy,
  query,
  startAfter,
  Timestamp,
  where,
  type DocumentData,
  type QueryDocumentSnapshot,
  type QueryConstraint,
} from 'firebase/firestore';
import { auth, db } from '@/lib/firebase';

export interface VisitorActivityItem {
  id: string;
  timestamp: Timestamp | null;
  event: string;
  passToken: string;
  visitorId: string | null;
  reason: string | null;
  deviceId: string | null;
  gate: string | null;
  guardUid: string | null;
  guardName: string | null;
  visitorName: string | null;
}

export interface AdministrativeAuditItem {
  id: string;
  timestamp: Timestamp | null;
  action: string;
  actorUid: string;
  actorRole: string;
  targetType: string;
  targetId: string;
  targetUid?: string;
  previousRole?: string | null;
  newRole?: string | null;
  previousStatus?: string | boolean | null;
  newStatus?: string | boolean | null;
  result: string;
  metadata?: Record<string, unknown>;
}

export interface ReconciliationItem {
  id: string;
  type: string;
  status: string;
  targetType: string;
  targetId: string;
  createdAt: string | null;
  summary: string;
  requiredActions: string[];
}

interface QueryState<T> {
  data: T[];
  loading: boolean;
  error: string | null;
}

export interface PaginatedQueryState<T> extends QueryState<T> {
  hasMore: boolean;
  loadingMore: boolean;
  loadMore: () => void;
}

const ACTIVITY_PAGE_SIZE = 100;
const chunks = <T,>(items: T[], size: number) =>
  Array.from({ length: Math.ceil(items.length / size) }, (_, index) => items.slice(index * size, index * size + size));

async function enrichVisitorLogs(logs: VisitorActivityItem[]): Promise<VisitorActivityItem[]> {
  const visitorIds = [...new Set(logs.map((log) => log.visitorId).filter((id): id is string => Boolean(id)))];
  const passIds = [...new Set(logs.map((log) => log.passToken).filter(Boolean))];
  const guardIds = [...new Set(logs.map((log) => log.guardUid).filter((id): id is string => Boolean(id)))];
  const [visitorSnapshots, passSnapshots, guardSnapshots] = await Promise.all([
    Promise.all(chunks(visitorIds, 30).map((part) => getDocs(query(collection(db, 'visitors'), where(documentId(), 'in', part))))),
    Promise.all(chunks(passIds, 30).map((part) => getDocs(query(collection(db, 'gatePasses'), where(documentId(), 'in', part))))),
    Promise.all(chunks(guardIds, 30).map((part) => getDocs(query(collection(db, 'users'), where(documentId(), 'in', part))))),
  ]);
  const names = new Map<string, string>();
  visitorSnapshots.flatMap((item) => item.docs).forEach((document) => {
    const name = typeof document.data().fullName === 'string' ? document.data().fullName.trim() : '';
    if (name) names.set(document.id, name);
  });
  passSnapshots.flatMap((item) => item.docs).forEach((document) => {
    const pass = document.data();
    const name = typeof pass.visitorName === 'string' ? pass.visitorName.trim() : '';
    if (name) {
      names.set(document.id, name);
      if (typeof pass.visitorId === 'string' && !names.has(pass.visitorId)) names.set(pass.visitorId, name);
    }
  });
  const guardNames = new Map<string, string>();
  guardSnapshots.flatMap((item) => item.docs).forEach((document) => {
    const name = typeof document.data().name === 'string' ? document.data().name.trim() : '';
    if (name) guardNames.set(document.id, name);
  });
  return logs.map((log) => ({
    ...log,
    visitorName: (log.visitorId && names.get(log.visitorId)) || names.get(log.passToken) || null,
    guardName: log.guardName || (log.guardUid && guardNames.get(log.guardUid)) || null,
  }));
}

export function normalizeAdministrativeAudit(
  document: QueryDocumentSnapshot<DocumentData>,
): AdministrativeAuditItem {
  const data = document.data();
  const legacyTarget = typeof data.target === 'string' ? data.target.split('/') : [];
  return {
    id: document.id,
    timestamp: data.timestamp instanceof Timestamp ? data.timestamp : null,
    action: typeof data.action === 'string' ? data.action : 'unknown_action',
    actorUid: typeof data.actorUid === 'string' ? data.actorUid : 'system',
    actorRole: typeof data.actorRole === 'string' ? data.actorRole : 'unknown',
    targetType: typeof data.targetType === 'string' ? data.targetType : legacyTarget[0] || 'resource',
    targetId: typeof data.targetId === 'string'
      ? data.targetId
      : typeof data.targetUid === 'string' ? data.targetUid : legacyTarget[1] || document.id,
    targetUid: typeof data.targetUid === 'string' ? data.targetUid : undefined,
    previousRole: typeof data.previousRole === 'string' || data.previousRole === null ? data.previousRole : undefined,
    newRole: typeof data.newRole === 'string' || data.newRole === null ? data.newRole : undefined,
    previousStatus: data.previousStatus ?? data.previousActive,
    newStatus: data.newStatus ?? data.newActive,
    result: typeof data.result === 'string' ? data.result : typeof data.status === 'string' ? data.status : 'success',
    metadata: typeof data.metadata === 'object' && data.metadata !== null ? data.metadata as Record<string, unknown> : undefined,
  };
}

function usePaginatedActivity<T>(
  enabled: boolean,
  collectionName: 'visitLogs' | 'auditLogs',
  mapPage: (documents: QueryDocumentSnapshot<DocumentData>[]) => Promise<T[]>,
  errorMessage: string,
): PaginatedQueryState<T> {
  const [state, setState] = useState<QueryState<T>>({ data: [], loading: enabled, error: null });
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const cursorRef = useRef<QueryDocumentSnapshot<DocumentData> | null>(null);
  const requestIdRef = useRef(0);

  const loadPage = useCallback(async (append: boolean) => {
    if (!enabled) return;
    const requestId = requestIdRef.current;
    append ? setLoadingMore(true) : setState({ data: [], loading: true, error: null });
    try {
      const constraints: QueryConstraint[] = [orderBy('timestamp', 'desc')];
      if (append && cursorRef.current) constraints.push(startAfter(cursorRef.current));
      constraints.push(limit(ACTIVITY_PAGE_SIZE));
      const snapshot = await getDocs(query(collection(db, collectionName), ...constraints));
      const page = await mapPage(snapshot.docs);
      if (requestId !== requestIdRef.current) return;
      cursorRef.current = snapshot.docs[snapshot.docs.length - 1] || null;
      setHasMore(snapshot.docs.length === ACTIVITY_PAGE_SIZE);
      setState((current) => ({ data: append ? [...current.data, ...page] : page, loading: false, error: null }));
    } catch {
      if (requestId === requestIdRef.current) {
        setState((current) => ({ data: append ? current.data : [], loading: false, error: errorMessage }));
      }
    } finally {
      if (requestId === requestIdRef.current) setLoadingMore(false);
    }
  }, [collectionName, enabled, errorMessage, mapPage]);

  useEffect(() => {
    if (!enabled) return;
    requestIdRef.current += 1;
    cursorRef.current = null;
    setHasMore(false);
    void loadPage(false);
    return () => { requestIdRef.current += 1; };
  }, [enabled, loadPage]);

  return { ...state, hasMore, loadingMore, loadMore: () => void loadPage(true) };
}

const mapVisitorPage = async (documents: QueryDocumentSnapshot<DocumentData>[]) => enrichVisitorLogs(
  documents.map((document) => ({ id: document.id, ...document.data() } as VisitorActivityItem)),
);
const mapAdministrativePage = async (documents: QueryDocumentSnapshot<DocumentData>[]) =>
  documents.map(normalizeAdministrativeAudit);

export function useVisitorActivity(enabled: boolean): PaginatedQueryState<VisitorActivityItem> {
  return usePaginatedActivity(enabled, 'visitLogs', mapVisitorPage, 'Visitor activity could not be loaded.');
}

export function useAdministrativeAudit(enabled: boolean): PaginatedQueryState<AdministrativeAuditItem> {
  return usePaginatedActivity(enabled, 'auditLogs', mapAdministrativePage, 'Administrative activity could not be loaded.');
}

export function useReconciliationItems(enabled: boolean): QueryState<ReconciliationItem> {
  const [state, setState] = useState<QueryState<ReconciliationItem>>({ data: [], loading: enabled, error: null });
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    setState((current) => ({ ...current, loading: true, error: null }));
    void (async () => {
      try {
        const token = await auth.currentUser?.getIdToken();
        if (!token) throw new Error('Session expired');
        const response = await fetch('/api/reconciliation-items', {
          headers: { Authorization: `Bearer ${token}` },
          signal: controller.signal,
        });
        const body = await response.json().catch(() => null) as { items?: ReconciliationItem[]; error?: string } | null;
        if (!response.ok) throw new Error(body?.error || 'Request failed');
        setState({ data: body?.items || [], loading: false, error: null });
      } catch (error) {
        if (!controller.signal.aborted) setState({
          data: [],
          loading: false,
          error: error instanceof Error ? error.message : 'Reconciliation items could not be loaded.',
        });
      }
    })();
    return () => controller.abort();
  }, [enabled]);
  return state;
}
