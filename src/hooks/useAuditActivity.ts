import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppTimestamp } from '@/lib/timestamp';
import { asAppTimestamp } from '@/lib/timestamp';
import { getAccessToken } from '@/services/auth';

export interface VisitorActivityItem {
  id: string;
  timestamp: AppTimestamp | null;
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
  timestamp: AppTimestamp | null;
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

function mapRawVisitorItem(raw: any): VisitorActivityItem {
  return {
    id: String(raw.id),
    timestamp: asAppTimestamp(raw.timestamp),
    event: raw.event,
    passToken: raw.passToken,
    visitorId: raw.visitorId ?? null,
    reason: raw.reason ?? null,
    deviceId: raw.deviceId ?? null,
    gate: raw.gate ?? null,
    guardUid: raw.guardUid ?? null,
    guardName: raw.guardName ?? null,
    visitorName: raw.visitorName ?? null,
  };
}

function mapRawAdministrativeItem(raw: any): AdministrativeAuditItem {
  return {
    id: String(raw.id),
    timestamp: asAppTimestamp(raw.timestamp),
    action: raw.action,
    actorUid: raw.actorUid,
    actorRole: raw.actorRole,
    targetType: raw.targetType,
    targetId: raw.targetId,
    targetUid: raw.targetUid,
    previousRole: raw.previousRole,
    newRole: raw.newRole,
    previousStatus: raw.previousStatus,
    newStatus: raw.newStatus,
    result: raw.result,
    metadata: raw.metadata,
  };
}

export function normalizeAdministrativeAudit(item: any): AdministrativeAuditItem {
  return mapRawAdministrativeItem(item);
}

export interface VisitorActivityFilters {
  event?: string;
  dateFrom?: string;
  dateTo?: string;
}

export interface AdministrativeAuditFilters {
  role?: string;
  action?: string;
  dateFrom?: string;
  dateTo?: string;
}

function usePaginatedActivity<T>(
  enabled: boolean,
  type: 'visitor' | 'administrative',
  mapper: (raw: any) => T,
  errorMessage: string,
  filters?: Record<string, string | undefined>,
): PaginatedQueryState<T> {
  const [state, setState] = useState<QueryState<T>>({ data: [], loading: enabled, error: null });
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const cursorRef = useRef<string | null>(null);
  const requestIdRef = useRef(0);
  const filtersKey = JSON.stringify(filters ?? {});

  const loadPage = useCallback(async (append: boolean) => {
    if (!enabled) return;
    const requestId = requestIdRef.current;
    append ? setLoadingMore(true) : setState({ data: [], loading: true, error: null });
    try {
      const token = await getAccessToken();
      const params = new URLSearchParams({
        type,
        pageSize: String(ACTIVITY_PAGE_SIZE),
      });
      if (filters) {
        Object.entries(filters).forEach(([key, val]) => {
          if (val && val.trim()) params.set(key, val.trim());
        });
      }
      if (append && cursorRef.current) {
        params.set('cursor', cursorRef.current);
      }
      const response = await fetch(`/api/admin/activity?${params.toString()}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await response.json().catch(() => null) as {
        items?: any[];
        nextCursor?: string | null;
        hasMore?: boolean;
        error?: string;
      } | null;
      if (!response.ok) throw new Error(data?.error || errorMessage);
      if (requestId !== requestIdRef.current) return;

      const page: T[] = (data?.items ?? []).map(mapper);
      cursorRef.current = data?.nextCursor ?? null;
      setHasMore(data?.hasMore ?? false);
      setState((current) => ({ data: append ? [...current.data, ...page] : page, loading: false, error: null }));
    } catch {
      if (requestId === requestIdRef.current) {
        setState((current) => ({ data: append ? current.data : [], loading: false, error: errorMessage }));
      }
    } finally {
      if (requestId === requestIdRef.current) setLoadingMore(false);
    }
  }, [enabled, errorMessage, mapper, type, filtersKey]);

  useEffect(() => {
    if (!enabled) return;
    requestIdRef.current += 1;
    cursorRef.current = null;
    setHasMore(false);
    void loadPage(false);
    return () => { requestIdRef.current += 1; };
  }, [enabled, loadPage, filtersKey]);

  return { ...state, hasMore, loadingMore, loadMore: () => void loadPage(true) };
}

export function useVisitorActivity(
  enabled: boolean,
  filters?: VisitorActivityFilters,
): PaginatedQueryState<VisitorActivityItem> {
  return usePaginatedActivity(enabled, 'visitor', mapRawVisitorItem, 'Visitor activity could not be loaded.', filters as Record<string, string | undefined>);
}

export function useAdministrativeAudit(
  enabled: boolean,
  filters?: AdministrativeAuditFilters,
): PaginatedQueryState<AdministrativeAuditItem> {
  return usePaginatedActivity(enabled, 'administrative', mapRawAdministrativeItem, 'Administrative activity could not be loaded.', filters as Record<string, string | undefined>);
}

export interface PaginatedReconciliationState extends PaginatedQueryState<ReconciliationItem> {
  total: number;
  refresh: () => void;
}

export function useReconciliationItems(enabled: boolean): PaginatedReconciliationState {
  const [state, setState] = useState<QueryState<ReconciliationItem>>({ data: [], loading: enabled, error: null });
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const cursorRef = useRef<string | null>(null);

  const loadPage = useCallback(async (append: boolean) => {
    if (!enabled) return;
    append ? setLoadingMore(true) : setState({ data: [], loading: true, error: null });
    try {
      const token = await getAccessToken();
      const params = new URLSearchParams({ pageSize: '50' });
      if (append && cursorRef.current) {
        params.set('cursor', cursorRef.current);
      }
      const response = await fetch(`/api/reconciliation-items?${params.toString()}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const body = await response.json().catch(() => null) as {
        items?: ReconciliationItem[];
        total?: number;
        hasMore?: boolean;
        nextCursor?: string | null;
        error?: string;
      } | null;
      if (!response.ok) throw new Error(body?.error || 'Reconciliation items could not be loaded.');
      const items = body?.items || [];
      cursorRef.current = body?.nextCursor ?? null;
      setHasMore(Boolean(body?.hasMore));
      setTotal(body?.total ?? items.length);
      setState((current) => ({
        data: append ? [...current.data, ...items] : items,
        loading: false,
        error: null,
      }));
    } catch (error) {
      setState((current) => ({
        data: append ? current.data : [],
        loading: false,
        error: error instanceof Error ? error.message : 'Reconciliation items could not be loaded.',
      }));
    } finally {
      setLoadingMore(false);
    }
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;
    cursorRef.current = null;
    void loadPage(false);
  }, [enabled, loadPage]);

  return { ...state, total, hasMore, loadingMore, loadMore: () => void loadPage(true), refresh: () => void loadPage(false) };
}
