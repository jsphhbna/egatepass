import { useAuth } from '@/hooks/useAuth';
import { formatManilaDateTime, formatManilaTime, formatManilaIso, formatManilaFileTimestamp, getManilaDatePresetRange, getManilaDateString, type DatePresetKey } from '@/lib/manilaTime';
import { getActiveIncidentHoldsForRecord, createIncidentHold, releaseIncidentHold, type IncidentHold } from '@/services/incidentHold';
import { AlertTriangle, ClipboardCheck, Download, Eye, MapPin, Printer, ShieldAlert, ShieldCheck, RefreshCw, Clock, Check } from 'lucide-react';
import { useState, useEffect, useRef, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Card, Input, Select, Button, DataTable, DataTableHead, DataTableRow, DataTableCell, Modal, StatusBadge, TableSkeletonRows } from '@/components/ui';
import { AuthenticatedImage } from '@/components/AuthenticatedImage';
import type { GatePass, PassSource, PassStatus } from '@/types';
import { toast } from 'sonner';
import { collectCursorPages, EXPORT_MAX_ROWS } from '@/lib/completeExport';
import { exportReportToCsv, exportReportToExcel, exportReportToPdf } from '@/lib/reportExport';
import { asAppTimestamp } from '@/lib/timestamp';
import { getAccessToken } from '@/services/auth';

export type HoldLookupState =
  | { status: 'loading'; passId?: string; visitorId?: string }
  | { status: 'protected'; holds: IncidentHold[]; passId: string; visitorId: string }
  | { status: 'unprotected'; passId?: string; visitorId?: string }
  | { status: 'error'; passId?: string; visitorId?: string };

interface GatePassWithId extends GatePass {
  id: string;
  contactNumber?: string | null;
  email?: string | null;
  homeAddress?: string | null;
  homeStreet?: string | null;
  homeBuilding?: string | null;
  barangayName?: string | null;
  cityName?: string | null;
  provinceName?: string | null;
  regionName?: string | null;
  destinationOffice?: string | null;
  destinationOfficeId?: string | null;
  attendanceStatus?: string | null;
  visitType?: string | null;
  approvalStatus?: string | null;
  gender?: string | null;
  visitDate?: string | null;
  arrivalMode?: string | null;
  accountabilityStatus?: 'pending' | 'resolved' | 'reviewed' | 'exception' | string;
  accountabilityNotes?: string | null;
  accountabilityResolvedAt?: string | null;
  accountabilityResolvedBy?: string | null;
  exitVerificationType?: string | null;
  attendanceVerificationType?: string | null;
  officeAccountabilityNotes?: string | null;
  officeVisitId?: string | null;
  hasEntered?: boolean;
  hasExited?: boolean;
  isPastClosing?: boolean;
  missingExit?: boolean;
  missingOffice?: boolean;
  bothMissing?: boolean;
  isCompleted?: boolean;
  overdueMinutes?: number;
  expectedClosingTime?: string | null;
  resolutions?: Array<{
    id: string;
    resolutionType: string;
    exceptionType?: string | null;
    reason: string;
    verifiedEventTime?: string | null;
    gate?: string | null;
    createdAt: string;
    actorId?: string | null;
  }>;
}

interface SerializedRecordPass {
  id: string;
  visitorId: string;
  visitorName: string;
  purpose: string;
  gender?: string | null;
  visitDate?: string | null;
  contactNumber?: string | null;
  email?: string | null;
  homeAddress?: string | null;
  homeStreet?: string | null;
  homeBuilding?: string | null;
  barangayName?: string | null;
  cityName?: string | null;
  provinceName?: string | null;
  regionName?: string | null;
  arrivalMode?: string | null;
  destinationOffice?: string | null;
  destinationOfficeId?: string | null;
  attendanceStatus?: string | null;
  visitType?: string | null;
  approvalStatus?: string | null;
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
  expectedGate?: string | null;
  accountabilityStatus?: string;
  accountabilityNotes?: string | null;
  accountabilityResolvedAt?: string | null;
  accountabilityResolvedBy?: string | null;
  exitVerificationType?: string | null;
  attendanceVerificationType?: string | null;
  officeAccountabilityNotes?: string | null;
  officeVisitId?: string | null;
  hasEntered?: boolean;
  hasExited?: boolean;
  isPastClosing?: boolean;
  missingExit?: boolean;
  missingOffice?: boolean;
  bothMissing?: boolean;
  isCompleted?: boolean;
  overdueMinutes?: number;
  expectedClosingTime?: string | null;
  resolutions?: Array<{
    id: string;
    resolutionType: string;
    exceptionType?: string | null;
    reason: string;
    verifiedEventTime?: string | null;
    gate?: string | null;
    createdAt: string;
    actorId?: string | null;
  }>;
}

interface EmergencyOfflineRecord {
  id: string;
  gate: string;
  visitor_full_name: string;
  declared_address: string | null;
  address_status: string | null;
  purpose: string;
  destination_office_name_snapshot: string | null;
  office_resolution_status: string | null;
  id_physically_inspected: boolean;
  record_classification: string | null;
  local_recorded_at: string;
  server_received_at: string;
  local_sequence: number;
  snapshot_version: string | null;
  emergency_exception_applied: boolean;
  reconciliation_status: 'received' | 'needs_review' | 'accepted' | 'duplicate' | 'rejected' | string;
  reconciliation_notes: string | null;
  reconciled_at: string | null;
  device_name?: string | null;
  device_alias?: string | null;
}

interface OfflineSummaryCounts {
  totalCount: number;
  needsReviewCount: number;
  receivedCount: number;
  acceptedCount: number;
  duplicateCount: number;
  rejectedCount: number;
}

const RECORDS_PAGE_SIZE = 50;

export function deserializeRecordPass(p: SerializedRecordPass): GatePassWithId {
  const validFrom = asAppTimestamp(p.validFrom);
  const validUntil = asAppTimestamp(p.validUntil);
  const issuedAt = asAppTimestamp(p.issuedAt);

  if (!validFrom || !validUntil || !issuedAt) {
    throw new Error('invalid_record_pass_timestamp');
  }

  return {
    id: p.id,
    visitorId: p.visitorId,
    visitorName: p.visitorName,
    purpose: p.purpose,
    gender: p.gender ?? null,
    visitDate: p.visitDate ?? null,
    contactNumber: p.contactNumber ?? null,
    email: p.email ?? null,
    homeAddress: p.homeAddress ?? null,
    homeStreet: p.homeStreet ?? null,
    homeBuilding: p.homeBuilding ?? null,
    barangayName: p.barangayName ?? null,
    cityName: p.cityName ?? null,
    provinceName: p.provinceName ?? null,
    regionName: p.regionName ?? null,
    arrivalMode: p.arrivalMode ?? null,
    destinationOffice: p.destinationOffice ?? null,
    attendanceStatus: p.attendanceStatus ?? null,
    visitType: p.visitType ?? null,
    approvalStatus: p.approvalStatus ?? null,
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
    expectedGate: p.expectedGate ?? null,
    accountabilityStatus: p.accountabilityStatus ?? 'pending',
    accountabilityNotes: p.accountabilityNotes ?? null,
    accountabilityResolvedAt: p.accountabilityResolvedAt ?? null,
    accountabilityResolvedBy: p.accountabilityResolvedBy ?? null,
    exitVerificationType: p.exitVerificationType ?? null,
    attendanceVerificationType: p.attendanceVerificationType ?? null,
    officeAccountabilityNotes: p.officeAccountabilityNotes ?? null,
    officeVisitId: p.officeVisitId ?? null,
    hasEntered: Boolean(p.hasEntered),
    hasExited: Boolean(p.hasExited),
    isPastClosing: Boolean(p.isPastClosing),
    missingExit: Boolean(p.missingExit),
    missingOffice: Boolean(p.missingOffice),
    bothMissing: Boolean(p.bothMissing),
    isCompleted: Boolean(p.isCompleted),
    overdueMinutes: p.overdueMinutes ?? 0,
    expectedClosingTime: p.expectedClosingTime ?? null,
    resolutions: p.resolutions ?? [],
  };
}

export function AdminRecords() {
  const { role } = useAuth();
  const [searchParams] = useSearchParams();
  const currentTab = (searchParams.get('tab') as 'current' | 'history' | 'search' | 'offline' | 'reports') || 'search';
  const isOfflineTab = currentTab === 'offline';
  const isReportsTab = currentTab === 'reports';
  const [passes, setPasses] = useState<GatePassWithId[]>([]);
  const [exportTruncatedNotice, setExportTruncatedNotice] = useState<string | null>(null);
  const [expectedGateDraft, setExpectedGateDraft] = useState('');
  const [savingExpectedGate, setSavingExpectedGate] = useState(false);

  // Offline Mode Recorded state
  const [offlineRecords, setOfflineRecords] = useState<EmergencyOfflineRecord[]>([]);
  const [offlineSummary, setOfflineSummary] = useState<OfflineSummaryCounts | null>(null);
  const [offlineLoading, setOfflineLoading] = useState(false);
  const [offlineError, setOfflineError] = useState<string | null>(null);
  const [offlineStatusFilter, setOfflineStatusFilter] = useState<string>('all');
  const [offlineGateFilter, setOfflineGateFilter] = useState<string>('');
  const [reconcilingRecord, setReconcilingRecord] = useState<EmergencyOfflineRecord | null>(null);
  const [reconcileDecision, setReconcileDecision] = useState<'accepted' | 'needs_review' | 'duplicate' | 'rejected'>('accepted');
  const [reconcileNotes, setReconcileNotes] = useState('');
  const [submittingReconcile, setSubmittingReconcile] = useState(false);
  const [loading, setLoading] = useState(true);
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [datePreset, setDatePreset] = useState<DatePresetKey | 'custom' | ''>('');
  const [statusFilter, setStatusFilter] = useState('');
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [selectedPass, setSelectedPass] = useState<GatePassWithId | null>(null);
  const [holdLookupState, setHoldLookupState] = useState<HoldLookupState>({ status: 'unprotected' });
  const [showHoldModal, setShowHoldModal] = useState(false);
  const [holdReason, setHoldReason] = useState('');
  const [submittingHold, setSubmittingHold] = useState(false);
  const [showReleaseModal, setShowReleaseModal] = useState(false);
  const [releaseReason, setReleaseReason] = useState('');
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportFormat, setExportFormat] = useState<'csv' | 'xlsx' | 'pdf' | null>(null);
  const [recordsError, setRecordsError] = useState<string | null>(null);
  const prevTabRef = useRef<string | null>(null);

  useEffect(() => {
    if (prevTabRef.current === currentTab) return;
    prevTabRef.current = currentTab;
    if (currentTab === 'current') {
      setStatusFilter('inside');
      setDateFrom('');
      setDateTo('');
      setDatePreset('');
    } else if (currentTab === 'history') {
      setStatusFilter('exited,expired,rejected');
      setDateFrom('');
      setDateTo('');
      setDatePreset('');
    } else if (currentTab === 'offline') {
      setStatusFilter('');
      setDateFrom('');
      setDateTo('');
      setDatePreset('');
    } else {
      setStatusFilter('');
      setDateFrom('');
      setDateTo('');
      setDatePreset('');
    }
  }, [currentTab]);

  async function loadOfflineRecords() {
    setOfflineLoading(true);
    setOfflineError(null);
    try {
      const token = await getAccessToken();
      const params = new URLSearchParams();
      if (offlineStatusFilter && offlineStatusFilter !== 'all') params.set('status', offlineStatusFilter);
      if (offlineGateFilter.trim()) params.set('gate', offlineGateFilter.trim());
      if (dateFrom) params.set('dateFrom', dateFrom);
      if (dateTo) params.set('dateTo', dateTo);
      const res = await fetch(`/api/admin/emergency-records?${params.toString()}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json().catch(() => null) as {
        records?: EmergencyOfflineRecord[];
        summary?: OfflineSummaryCounts;
        error?: string;
        message?: string;
      } | null;
      if (!res.ok) throw new Error(data?.message || data?.error || 'Failed to load offline gate records');
      setOfflineRecords(data?.records ?? []);
      setOfflineSummary(data?.summary ?? null);
    } catch (err: any) {
      const msg = err?.message || 'Unable to load offline gate records';
      setOfflineRecords([]);
      setOfflineError(msg);
      toast.error(msg);
    } finally {
      setOfflineLoading(false);
    }
  }

  async function handleSaveExpectedGate() {
    if (!selectedPass) return;
    const trimmedGate = expectedGateDraft.trim();
    if (!trimmedGate) {
      toast.error('Enter an expected gate name before saving.');
      return;
    }
    setSavingExpectedGate(true);
    try {
      const token = await getAccessToken();
      const res = await fetch('/api/admin/records', {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          passId: selectedPass.id,
          expectedGate: trimmedGate,
        }),
      });
      const data = await res.json().catch(() => null) as { error?: string; message?: string; expectedGate?: string } | null;
      if (!res.ok) throw new Error(data?.message || data?.error || 'Failed to assign expected gate');
      const nextGate = data?.expectedGate ?? trimmedGate;
      setPasses((prev) => prev.map((p) => (p.id === selectedPass.id ? { ...p, expectedGate: nextGate } : p)));
      setSelectedPass((prev) => (prev && prev.id === selectedPass.id ? { ...prev, expectedGate: nextGate } : prev));
      selectedPassRef.current = selectedPassRef.current ? { ...selectedPassRef.current, expectedGate: nextGate } : null;
      toast.success(`Expected gate updated to "${nextGate}".`);
    } catch (err: any) {
      toast.error(err?.message || 'Failed to update expected gate');
    } finally {
      setSavingExpectedGate(false);
    }
  }

  async function handleSubmitReconcile() {
    if (!reconcilingRecord) return;
    if (reconcileNotes.trim().length < 5) {
      toast.error('Reconciliation notes must be at least 5 characters.');
      return;
    }
    setSubmittingReconcile(true);
    try {
      const token = await getAccessToken();
      const res = await fetch('/api/admin/emergency-records', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          recordId: reconcilingRecord.id,
          decision: reconcileDecision,
          notes: reconcileNotes.trim(),
        }),
      });
      const data = await res.json().catch(() => null) as { error?: string; message?: string } | null;
      if (!res.ok) throw new Error(data?.message || data?.error || 'Failed to reconcile offline record');
      toast.success(`Offline record marked as "${reconcileDecision}".`);
      setReconcilingRecord(null);
      setReconcileNotes('');
      await loadOfflineRecords();
    } catch (err: any) {
      toast.error(err?.message || 'Reconciliation failed');
    } finally {
      setSubmittingReconcile(false);
    }
  }

  const recordsQueryGenerationRef = useRef(0);
  const recordsAbortControllerRef = useRef<AbortController | null>(null);
  const recordsLoadMoreAbortControllerRef = useRef<AbortController | null>(null);
  const lastCommittedRecordsQueryRef = useRef<{ dateFrom: string; dateTo: string; statusFilter: string; search: string } | null>(null);
  const recordsLoadMoreInFlightRef = useRef(false);
  const holdLookupGenerationRef = useRef(0);
  const selectedPassRef = useRef<GatePassWithId | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(search);
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    return () => {
      recordsAbortControllerRef.current?.abort();
      recordsLoadMoreAbortControllerRef.current?.abort();
    };
  }, []);

  function applyPreset(preset: DatePresetKey) {
    const { from, to } = getManilaDatePresetRange(preset);
    setDatePreset(preset);
    setDateFrom(from);
    setDateTo(to);
  }

  function handleResetFilters() {
    setDateFrom('');
    setDateTo('');
    setDatePreset('');
    setStatusFilter('');
    setSearch('');
    setDebouncedSearch('');
  }

  const activeFilterCount = (dateFrom || dateTo ? 1 : 0) + (statusFilter ? 1 : 0) + (search.trim() ? 1 : 0);

  async function fetchRecordsPage(options: {
    cursor: string | null;
    pageSize: number;
    search: string;
    dateFrom?: string;
    dateTo?: string;
    status: string;
    signal?: AbortSignal;
  }) {
    const token = await getAccessToken();
    const params = new URLSearchParams();
    if (options.status) params.set('status', options.status);
    if (options.dateFrom) params.set('dateFrom', options.dateFrom);
    if (options.dateTo) params.set('dateTo', options.dateTo);
    if (options.search.trim()) params.set('search', options.search.trim());
    if (options.cursor) params.set('cursor', options.cursor);
    params.set('pageSize', String(options.pageSize));

    const response = await fetch(`/api/admin/records?${params.toString()}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: options.signal,
    });
    const data = await response.json().catch(() => null) as {
      passes?: SerializedRecordPass[];
      nextCursor?: string | null;
      hasMore?: boolean;
      error?: string;
    } | null;

    if (!response.ok) throw new Error(data?.error || 'Failed to load records');

    const mapped: GatePassWithId[] = (data?.passes ?? []).map(deserializeRecordPass);

    return {
      items: mapped,
      nextCursor: data?.nextCursor ?? null,
      hasMore: data?.hasMore ?? false,
    };
  }

  async function loadRootRecords(override?: {
    search?: string;
    dateFrom?: string;
    dateTo?: string;
    status?: string;
  }) {
    const currentQuery = {
      dateFrom: override?.dateFrom !== undefined ? override.dateFrom : dateFrom,
      dateTo: override?.dateTo !== undefined ? override.dateTo : dateTo,
      statusFilter: override?.status !== undefined ? override.status : statusFilter,
      search: override?.search !== undefined ? override.search : debouncedSearch,
    };

    const currentGen = ++recordsQueryGenerationRef.current;
    recordsAbortControllerRef.current?.abort();
    const controller = new AbortController();
    recordsAbortControllerRef.current = controller;

    // Invalidate obsolete Load More operation and abort in-flight append
    recordsLoadMoreAbortControllerRef.current?.abort();
    recordsLoadMoreAbortControllerRef.current = null;
    recordsLoadMoreInFlightRef.current = false;
    setLoadingMore(false);

    setNextCursor(null);
    setHasMore(false);
    setRecordsError(null);
    setLoading(true);

    try {
      const res = await fetchRecordsPage({
        cursor: null,
        pageSize: RECORDS_PAGE_SIZE,
        search: currentQuery.search,
        dateFrom: currentQuery.dateFrom,
        dateTo: currentQuery.dateTo,
        status: currentQuery.statusFilter,
        signal: controller.signal,
      });

      if (controller.signal.aborted || currentGen !== recordsQueryGenerationRef.current) {
        return;
      }

      setPasses(res.items);
      setNextCursor(res.nextCursor);
      setHasMore(res.hasMore);
      setRecordsError(null);
      lastCommittedRecordsQueryRef.current = currentQuery;
    } catch (err: any) {
      if (controller.signal.aborted || currentGen !== recordsQueryGenerationRef.current) {
        return;
      }
      console.error('Visitor records load error:', err);
      // Section 15: Never show previous query rows under new filters after failure
      setPasses([]);
      setRecordsError(err.message || 'Visitor records could not be loaded');
      toast.error('Visitor records could not be loaded');
    } finally {
      if (currentGen === recordsQueryGenerationRef.current) {
        setLoading(false);
      }
    }
  }

  async function loadMoreRecords() {
    if (recordsLoadMoreInFlightRef.current || !hasMore || !nextCursor) return;
    recordsLoadMoreInFlightRef.current = true;
    setLoadingMore(true);

    const currentGen = recordsQueryGenerationRef.current;
    const committedQuery = lastCommittedRecordsQueryRef.current;
    if (!committedQuery) {
      recordsLoadMoreInFlightRef.current = false;
      setLoadingMore(false);
      return;
    }

    recordsLoadMoreAbortControllerRef.current?.abort();
    const loadMoreController = new AbortController();
    recordsLoadMoreAbortControllerRef.current = loadMoreController;

    try {
      const res = await fetchRecordsPage({
        cursor: nextCursor,
        pageSize: RECORDS_PAGE_SIZE,
        search: committedQuery.search,
        dateFrom: committedQuery.dateFrom,
        dateTo: committedQuery.dateTo,
        status: committedQuery.statusFilter,
        signal: loadMoreController.signal,
      });

      if (loadMoreController.signal.aborted || currentGen !== recordsQueryGenerationRef.current) {
        return;
      }

      setPasses((prev) => [...prev, ...res.items]);
      setNextCursor(res.nextCursor);
      setHasMore(res.hasMore);
    } catch (err: any) {
      if (loadMoreController.signal.aborted || currentGen !== recordsQueryGenerationRef.current) {
        return;
      }
      console.error('Load more records error:', err);
      toast.error('Failed to load more records');
    } finally {
      if (currentGen === recordsQueryGenerationRef.current) {
        recordsLoadMoreInFlightRef.current = false;
        setLoadingMore(false);
      }
    }
  }

  useEffect(() => {
    if (isOfflineTab) {
      void loadOfflineRecords();
    } else {
      void loadRootRecords();
    }
  }, [isOfflineTab, dateFrom, dateTo, statusFilter, debouncedSearch, offlineStatusFilter, offlineGateFilter]);

  const filteredPasses = passes;

  async function handleSelectPass(pass: GatePassWithId) {
    const currentGen = ++holdLookupGenerationRef.current;
    setSelectedPass(pass);
    selectedPassRef.current = pass;
    setExpectedGateDraft(pass.expectedGate || '');
    setHoldLookupState({ status: 'loading', passId: pass.id, visitorId: pass.visitorId });
    try {
      const holds = await getActiveIncidentHoldsForRecord({
        passId: pass.id,
        visitorId: pass.visitorId,
      });
      if (
        currentGen !== holdLookupGenerationRef.current ||
        !selectedPassRef.current ||
        selectedPassRef.current.id !== pass.id
      ) {
        return;
      }
      if (holds.length > 0) {
        setHoldLookupState({ status: 'protected', holds, passId: pass.id, visitorId: pass.visitorId });
      } else {
        setHoldLookupState({ status: 'unprotected', passId: pass.id, visitorId: pass.visitorId });
      }
    } catch {
      if (
        currentGen === holdLookupGenerationRef.current &&
        selectedPassRef.current &&
        selectedPassRef.current.id === pass.id
      ) {
        setHoldLookupState({ status: 'error', passId: pass.id, visitorId: pass.visitorId });
      }
    }
  }

  function handleClosePassModal() {
    holdLookupGenerationRef.current++;
    selectedPassRef.current = null;
    setSelectedPass(null);
    setHoldLookupState({ status: 'unprotected' });
  }

  async function handleCreateHold() {
    if (!selectedPass || !holdReason.trim()) return;
    if (holdLookupState.status === 'loading' || holdLookupState.status === 'error') {
      toast.error('Retention protection status unavailable. Authoritative lookup required before placing hold.');
      void handleSelectPass(selectedPass);
      return;
    }
    if (
      holdLookupState.passId !== selectedPass.id ||
      (holdLookupState.visitorId && holdLookupState.visitorId !== selectedPass.visitorId)
    ) {
      toast.error('Retention protection status unavailable. Authoritative lookup required before placing hold.');
      void handleSelectPass(selectedPass);
      return;
    }
    setSubmittingHold(true);
    try {
      await createIncidentHold({
        passId: selectedPass.id,
        visitorId: selectedPass.visitorId || undefined,
        reason: holdReason.trim(),
      });
      toast.success('Incident hold placed. Evidence is protected from retention deletion.');
      setShowHoldModal(false);
      setHoldReason('');
      void handleSelectPass(selectedPass);
    } catch (err: any) {
      toast.error(err.message || 'Failed to place incident hold');
    } finally {
      setSubmittingHold(false);
    }
  }

  async function handleReleaseHold() {
    if (
      holdLookupState.status !== 'protected' ||
      holdLookupState.holds.length === 0 ||
      !selectedPass ||
      holdLookupState.passId !== selectedPass.id ||
      holdLookupState.visitorId !== selectedPass.visitorId
    ) {
      toast.error('Retention protection status mismatch. Refreshing incident hold state.');
      if (selectedPass) void handleSelectPass(selectedPass);
      return;
    }
    const holdToRelease = holdLookupState.holds[0];
    if (!holdToRelease) return;
    setSubmittingHold(true);
    try {
      await releaseIncidentHold(holdToRelease.id, releaseReason.trim() || undefined);
      toast.success('Incident hold released. Normal retention policy restored.');
      setShowReleaseModal(false);
      setReleaseReason('');
      if (selectedPass) {
        void handleSelectPass(selectedPass);
      }
    } catch (err: any) {
      toast.error(err.message || 'Failed to release incident hold');
    } finally {
      setSubmittingHold(false);
    }
  }

  async function exportRecords(format: 'csv' | 'xlsx' | 'pdf') {
    setExporting(true);
    setExportFormat(format);
    setExportTruncatedNotice(null);
    const exportSearch = search.trim();
    const exportDateFrom = dateFrom;
    const exportDateTo = dateTo;
    const exportStatus = statusFilter;

    try {
      if (isOfflineTab) {
        const token = await getAccessToken();
        const params = new URLSearchParams();
        params.set('mode', 'offline');
        params.set('export', 'all');
        if (offlineStatusFilter && offlineStatusFilter !== 'all') params.set('status', offlineStatusFilter);
        if (exportDateFrom) params.set('dateFrom', exportDateFrom);
        if (exportDateTo) params.set('dateTo', exportDateTo);
        const res = await fetch(`/api/admin/records?${params.toString()}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const payload = await res.json().catch(() => null) as {
          offlineRecords?: Array<{
            classification: string;
            gate: string;
            localSequence: number;
            visitorName: string;
            declaredAddress: string | null;
            purpose: string;
            officeName: string | null;
            idPhysicallyInspected: boolean;
            emergencyExceptionApplied: boolean;
            reconciliationStatus: string;
            localRecordedAt: string;
            serverReceivedAt: string;
          }>;
          offlineTotalCount?: number;
          truncated?: boolean;
          error?: string;
        } | null;
        if (!res.ok) throw new Error(payload?.error || 'Failed to export offline records');
        const rows = (payload?.offlineRecords ?? []).map((r) => ({
          classification: r.classification || 'OFFLINE MODE RECORDED',
          gate: r.gate,
          localSequence: r.localSequence,
          visitorName: r.visitorName,
          declaredAddress: r.declaredAddress || '',
          purpose: r.purpose,
          officeName: r.officeName || '',
          idPhysicallyInspected: r.idPhysicallyInspected ? 'Yes' : 'No',
          emergencyExceptionApplied: r.emergencyExceptionApplied ? 'Yes' : 'No',
          reconciliationStatus: r.reconciliationStatus,
          localRecordedAt: formatManilaIso(new Date(r.localRecordedAt).getTime()),
          serverReceivedAt: formatManilaIso(new Date(r.serverReceivedAt).getTime()),
        }));
        const fileBase = `egatepass-offline-mode-recorded-${formatManilaFileTimestamp(new Date())}`;
        const reportOpts = {
          title: 'EARIST E-GatePass — OFFLINE MODE RECORDED Log',
          filename: fileBase,
          columns: [
            { header: 'Classification', key: 'classification', width: 22 },
            { header: 'Gate', key: 'gate', width: 14 },
            { header: 'Seq', key: 'localSequence', width: 8 },
            { header: 'Visitor Name', key: 'visitorName', width: 22 },
            { header: 'Declared Address', key: 'declaredAddress', width: 30 },
            { header: 'Purpose', key: 'purpose', width: 26 },
            { header: 'Destination Office', key: 'officeName', width: 22 },
            { header: 'ID Inspected', key: 'idPhysicallyInspected', width: 12 },
            { header: 'Exception Applied', key: 'emergencyExceptionApplied', width: 14 },
            { header: 'Reconciliation', key: 'reconciliationStatus', width: 16 },
            { header: 'Recorded (Manila)', key: 'localRecordedAt', width: 20 },
            { header: 'Synced (Manila)', key: 'serverReceivedAt', width: 20 },
          ],
          rows,
          generatedAt: formatManilaDateTime(new Date()),
          generatedBy: 'Authorized Admin',
          filterMetadata: {
            Classification: 'OFFLINE MODE RECORDED',
            Status: offlineStatusFilter || 'all',
            DateRange: exportDateFrom || exportDateTo ? `${exportDateFrom || '...'} to ${exportDateTo || '...'}` : 'All Dates',
            Timezone: 'Asia/Manila (UTC+8)',
          },
          totalRecords: payload?.offlineTotalCount ?? rows.length,
        };
        if (format === 'csv') await exportReportToCsv(reportOpts);
        else if (format === 'xlsx') await exportReportToExcel(reportOpts);
        else await exportReportToPdf(reportOpts);

        if (payload?.truncated) {
          const notice = `Offline export capped at ${EXPORT_MAX_ROWS.toLocaleString()} of ${(payload.offlineTotalCount ?? rows.length).toLocaleString()} records. Narrow your filters for an untruncated export.`;
          setExportTruncatedNotice(notice);
          toast.warning(notice);
        } else {
          toast.success(`Exported ${rows.length.toLocaleString()} OFFLINE MODE RECORDED record${rows.length === 1 ? '' : 's'}.`);
        }
        return;
      }
      const exportResult = await collectCursorPages<GatePassWithId, string>(
        async (cursor, pageSize) => {
          const res = await fetchRecordsPage({
            cursor,
            pageSize,
            search: exportSearch,
            dateFrom: exportDateFrom,
            dateTo: exportDateTo,
            status: exportStatus,
          });
          return {
            items: res.items,
            nextCursor: res.nextCursor,
          };
        },
        { pageSize: 250 },
      );
      const exportPasses = exportResult.items;
      const columns = [
        { header: 'Visitor Name', key: 'visitorName', width: 22 },
        { header: 'Sex', key: 'gender', width: 10 },
        { header: 'Contact Number', key: 'contactNumber', width: 16 },
        { header: 'Email', key: 'email', width: 24 },
        { header: 'Residential Address', key: 'address', width: 32 },
        { header: 'Destination Office', key: 'destinationOffice', width: 22 },
        { header: 'Purpose of Visit', key: 'purpose', width: 26 },
        { header: 'Visit Type', key: 'visitType', width: 16 },
        { header: 'Scheduled Date', key: 'visitDate', width: 14 },
        { header: 'Arrival Mode', key: 'arrivalMode', width: 14 },
        { header: 'Pass Status', key: 'status', width: 14 },
        { header: 'Office Attendance', key: 'attendanceStatus', width: 18 },
        { header: 'Registration Source', key: 'source', width: 14 },
        { header: 'Issued At', key: 'issuedAt', width: 20 },
        { header: 'Time In', key: 'timeIn', width: 20 },
        { header: 'Time Out', key: 'timeOut', width: 20 },
        { header: 'Gate', key: 'gate', width: 14 },
      ];
      const rows = exportPasses.map((p) => {
        const fullAddress = [
          p.homeBuilding,
          p.homeStreet,
          p.barangayName,
          p.cityName,
          p.provinceName,
          p.regionName,
        ].filter(Boolean).join(', ') || p.homeAddress || '—';

        return {
          visitorName: p.visitorName,
          gender: p.gender ? p.gender.charAt(0).toUpperCase() + p.gender.slice(1) : '—',
          contactNumber: p.contactNumber || '—',
          email: p.email || '—',
          address: fullAddress,
          destinationOffice: p.destinationOffice || 'General Campus',
          purpose: p.purpose,
          visitType: p.visitType ? p.visitType.replace(/_/g, ' ') : 'General',
          visitDate: p.visitDate || '—',
          arrivalMode: p.arrivalMode === 'vehicle' ? 'Vehicle' : 'No Vehicle (Walk-in)',
          status: p.status,
          attendanceStatus: p.attendanceStatus ? p.attendanceStatus.replace(/_/g, ' ') : '—',
          source: p.source ? p.source.toUpperCase() : '—',
          issuedAt: p.issuedAt ? formatManilaIso(p.issuedAt.toMillis()) : '',
          timeIn: p.timeIn ? formatManilaIso(p.timeIn.toMillis()) : '',
          timeOut: p.timeOut ? formatManilaIso(p.timeOut.toMillis()) : '',
          gate: p.gate || '',
        };
      });

      const filterMetadata: Record<string, string> = {};
      if (exportSearch) filterMetadata['Search'] = exportSearch;
      if (exportStatus) filterMetadata['Status'] = exportStatus;
      if (exportDateFrom && exportDateTo && exportDateFrom === exportDateTo) {
        filterMetadata['Report Date'] = `${exportDateFrom} (Single Day)`;
      } else {
        if (exportDateFrom) filterMetadata['Date From'] = exportDateFrom;
        if (exportDateTo) filterMetadata['Date To'] = exportDateTo;
      }

      const baseFilename = `visitor_records_${formatManilaFileTimestamp(new Date())}`;
      const generatedAt = formatManilaIso(Date.now());
      const generatedBy = role ?? undefined;

      if (format === 'csv') {
        exportReportToCsv({
          reportTitle: 'Visitor Records',
          columns,
          rows,
          filterMetadata,
          generatedAt,
          generatedBy,
          filename: `${baseFilename}.csv`,
        });
      } else if (format === 'xlsx') {
        await exportReportToExcel({
          reportTitle: 'Visitor Records',
          sheetName: 'Visitor Records',
          columns,
          rows,
          filterMetadata,
          generatedAt,
          generatedBy,
          filename: `${baseFilename}.xlsx`,
        });
      } else if (format === 'pdf') {
        await exportReportToPdf({
          reportTitle: 'Visitor Records',
          columns,
          rows,
          filterMetadata,
          generatedAt,
          generatedBy,
          filename: `${baseFilename}.pdf`,
          orientation: 'landscape',
        });
      }

      if (exportResult.truncated) {
        const notice = `Export reached the ${EXPORT_MAX_ROWS.toLocaleString()} record safety limit. Narrow the filters for a complete file.`;
        setExportTruncatedNotice(notice);
        toast.warning(notice);
      } else {
        toast.success(`Exported ${exportPasses.length.toLocaleString()} filtered record${exportPasses.length === 1 ? '' : 's'}.`);
      }
    } catch (error) {
      console.error(error);
      toast.error('The complete filtered export could not be generated');
    } finally {
      setExporting(false);
      setExportFormat(null);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-[var(--color-text-primary)]">
            {isReportsTab ? 'Visitor Reports' : isOfflineTab ? 'Emergency Offline Gate Records' : 'Visitor Records'}
          </h1>
          <p className="text-sm text-[var(--color-text-secondary)] mt-1">
            {isReportsTab
              ? 'Detailed institutional visitor compliance and operational exception reports'
              : isOfflineTab
              ? 'Review, reconcile, and audit emergency offline entries recorded during connectivity loss'
              : 'View and export gate pass history'}
          </p>
        </div>
        {!isReportsTab && (
          <div className="flex flex-wrap items-center gap-2 print:hidden">
            <Button
              onClick={() => window.print()}
              variant="secondary"
              icon={<Printer className="h-4 w-4" />}
            >
              Print loaded view
            </Button>
            <div className="flex items-center gap-1.5">
              <Button
                onClick={() => void exportRecords('csv')}
                disabled={exporting}
                loading={exporting && exportFormat === 'csv'}
                icon={<Download className="h-4 w-4" />}
                variant="secondary"
              >
                CSV
              </Button>
              <Button
                onClick={() => void exportRecords('xlsx')}
                disabled={exporting}
                loading={exporting && exportFormat === 'xlsx'}
                icon={<Download className="h-4 w-4" />}
                variant="secondary"
              >
                Excel
              </Button>
              <Button
                onClick={() => void exportRecords('pdf')}
                disabled={exporting}
                loading={exporting && exportFormat === 'pdf'}
                icon={<Download className="h-4 w-4" />}
                variant="secondary"
              >
                PDF
              </Button>
            </div>
          </div>
        )}
      </div>

      {isReportsTab ? (
        <VisitorReportsView onSelectPass={handleSelectPass} userRole={role} />
      ) : (
        <>
          {exportTruncatedNotice && (
            <div role="alert" className="flex items-start gap-2.5 rounded-lg border border-amber-300 bg-amber-50 p-3.5 text-xs text-amber-950 print:hidden">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-700" aria-hidden="true" />
              <div>
                <p className="font-bold">Export Limit Notice</p>
                <p className="mt-0.5">{exportTruncatedNotice}</p>
              </div>
            </div>
          )}

      {/* Print Header */}
      <div className="hidden print:block mb-4">
        <h2 className="text-xl font-bold text-black">Visitor Records Report</h2>
        <p className="text-sm text-black">
          Generated: {formatManilaDateTime(new Date(), { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true })} (Asia/Manila)
        </p>
      </div>

      {/* Filters */}
      <Card className="flex flex-col gap-4 p-5 print:hidden">
        {/* Presets and Active Filter count */}
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--color-border)] pb-3">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-xs font-semibold text-[var(--color-text-secondary)] mr-1">Presets:</span>
            <Button
              type="button"
              size="sm"
              variant={datePreset === 'today' ? 'primary' : 'secondary'}
              onClick={() => applyPreset('today')}
            >
              Today
            </Button>
            <Button
              type="button"
              size="sm"
              variant={datePreset === 'yesterday' ? 'primary' : 'secondary'}
              onClick={() => applyPreset('yesterday')}
            >
              Yesterday
            </Button>
            <Button
              type="button"
              size="sm"
              variant={datePreset === 'thisWeek' ? 'primary' : 'secondary'}
              onClick={() => applyPreset('thisWeek')}
            >
              This Week
            </Button>
            <Button
              type="button"
              size="sm"
              variant={datePreset === 'last7' ? 'primary' : 'secondary'}
              onClick={() => applyPreset('last7')}
            >
              Last 7 Days
            </Button>
            <Button
              type="button"
              size="sm"
              variant={datePreset === 'thisMonth' ? 'primary' : 'secondary'}
              onClick={() => applyPreset('thisMonth')}
            >
              This Month
            </Button>
            {datePreset === 'custom' && (
              <span className="rounded bg-[var(--color-surface-hover)] px-2 py-0.5 text-xs text-[var(--color-text-muted)]">
                Custom range
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {activeFilterCount > 0 && (
              <span className="rounded-full bg-[var(--color-brand)]/10 px-2.5 py-0.5 text-xs font-semibold text-[var(--color-brand)]">
                Filters ({activeFilterCount})
              </span>
            )}
            {activeFilterCount > 0 && (
              <Button
                type="button"
                size="sm"
                variant="secondary"
                onClick={handleResetFilters}
              >
                Reset Filters
              </Button>
            )}
          </div>
        </div>

        <div className="flex flex-wrap gap-4">
          {!isOfflineTab ? (
            <div className="min-w-0 flex-1 sm:min-w-52">
              <label htmlFor="visitor-search" className="mb-2 block text-sm font-medium text-[var(--color-text-secondary)]">Search Name</label>
              <Input
                id="visitor-search"
                type="text"
                placeholder="Search visitors..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
          ) : (
            <div className="min-w-0 flex-1 sm:min-w-52">
              <label htmlFor="offline-gate-filter" className="mb-2 block text-sm font-medium text-[var(--color-text-secondary)]">Filter by Gate</label>
              <Input
                id="offline-gate-filter"
                type="text"
                placeholder="e.g. Main Gate"
                value={offlineGateFilter}
                onChange={(e) => setOfflineGateFilter(e.target.value)}
              />
            </div>
          )}
          
          <div className="w-full sm:w-44">
            <label htmlFor="visitor-date-from" className="mb-2 block text-sm font-medium text-[var(--color-text-secondary)]">From Date</label>
            <Input
              id="visitor-date-from"
              type="date"
              value={dateFrom}
              onChange={(e) => {
                setDateFrom(e.target.value);
                setDatePreset('custom');
              }}
            />
          </div>

          <div className="w-full sm:w-44">
            <label htmlFor="visitor-date-to" className="mb-2 block text-sm font-medium text-[var(--color-text-secondary)]">To Date</label>
            <Input
              id="visitor-date-to"
              type="date"
              value={dateTo}
              onChange={(e) => {
                setDateTo(e.target.value);
                setDatePreset('custom');
              }}
            />
          </div>

          {!isOfflineTab ? (
            <div className="w-full sm:w-48">
              <label className="mb-2 block text-sm font-medium text-[var(--color-text-secondary)]">Status</label>
              <Select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
                aria-label="Filter by status"
              >
                <option value="">All Statuses</option>
                <option value="inside">Currently Inside</option>
                <option value="exited,expired,rejected">Closed / Historical</option>
                <option value="issued">Issued (Not Entered)</option>
                <option value="pending">Pending Approval</option>
                <option value="exited">Exited</option>
                <option value="rejected">Rejected</option>
                <option value="expired">Expired</option>
              </Select>
            </div>
          ) : (
            <div className="w-full sm:w-48">
              <label className="mb-2 block text-sm font-medium text-[var(--color-text-secondary)]">Reconciliation</label>
              <Select
                value={offlineStatusFilter}
                onChange={(e) => setOfflineStatusFilter(e.target.value)}
                aria-label="Filter offline reconciliation status"
              >
                <option value="all">All Statuses</option>
                <option value="needs_review">Needs Review</option>
                <option value="received">Received</option>
                <option value="accepted">Accepted</option>
                <option value="duplicate">Duplicate</option>
                <option value="rejected">Rejected</option>
              </Select>
            </div>
          )}
        </div>
      </Card>

      {isOfflineTab ? (
        <div className="space-y-4">
          <Card className="border-amber-200 bg-amber-50/50 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <ShieldAlert className="h-5 w-5 text-amber-700" aria-hidden="true" />
                <div>
                  <div className="flex items-center gap-2">
                    <h2 className="text-base font-bold text-[var(--color-text-primary)]">Emergency Offline Mode Gate Records</h2>
                    <StatusBadge status="warning" label="OFFLINE MODE RECORDED" />
                  </div>
                  <p className="mt-0.5 text-xs text-[var(--color-text-secondary)]">
                    Synced from authorized Emergency Devices after physical ID inspection. These entries remain permanently classified as OFFLINE MODE RECORDED and never auto-convert into QR passes.
                  </p>
                </div>
              </div>
              {offlineSummary && (
                <div className="flex flex-wrap gap-2 text-xs font-semibold">
                  <span className="rounded bg-white px-2.5 py-1 border border-[var(--color-border)]">Total: {offlineSummary.totalCount}</span>
                  <span className="rounded bg-amber-100 text-amber-900 px-2.5 py-1">Needs Review: {offlineSummary.needsReviewCount}</span>
                  <span className="rounded bg-emerald-100 text-emerald-900 px-2.5 py-1">Accepted: {offlineSummary.acceptedCount}</span>
                </div>
              )}
            </div>
          </Card>

          <DataTable>
            <DataTableHead>
              <DataTableRow>
                <DataTableCell isHeader>Visitor / Destination</DataTableCell>
                <DataTableCell isHeader>Classification</DataTableCell>
                <DataTableCell isHeader>Gate & Seq</DataTableCell>
                <DataTableCell isHeader>Recorded (Manila)</DataTableCell>
                <DataTableCell isHeader>Reconciliation</DataTableCell>
                <DataTableCell isHeader className="text-right">Action</DataTableCell>
              </DataTableRow>
            </DataTableHead>
            <tbody className="divide-y divide-[var(--color-border)] bg-[var(--color-surface)]">
              {offlineLoading ? (
                <TableSkeletonRows columns={6} rows={6} columnWidths={['30%', '15%', '15%', '20%', '10%', '10%']} ariaLabel="Loading offline gate records…" />
              ) : offlineError ? (
                <tr>
                  <td colSpan={6} className="py-8 text-center">
                    <p className="text-sm font-medium text-[var(--color-danger)]">{offlineError}</p>
                    <Button className="mt-2" size="sm" variant="secondary" onClick={() => void loadOfflineRecords()}>
                      Retry
                    </Button>
                  </td>
                </tr>
              ) : offlineRecords.length === 0 ? (
                <tr>
                  <td colSpan={6} className="py-8 text-center text-[var(--color-text-muted)]">
                    No offline gate records found for the selected filters.
                  </td>
                </tr>
              ) : (
                offlineRecords.map((rec) => (
                  <DataTableRow key={rec.id}>
                    <DataTableCell>
                      <p className="font-bold text-[var(--color-text-primary)]">{rec.visitor_full_name}</p>
                      <p className="text-xs text-[var(--color-text-secondary)]">
                        {rec.destination_office_name_snapshot || 'Campus Visit'} — {rec.purpose}
                      </p>
                      {rec.declared_address && (
                        <p className="text-[11px] text-[var(--color-text-muted)]">Address: {rec.declared_address}</p>
                      )}
                    </DataTableCell>
                    <DataTableCell>
                      <StatusBadge status="warning" label="OFFLINE MODE RECORDED" />
                      <div className="mt-1 flex flex-wrap gap-1 text-[10px] text-[var(--color-text-muted)]">
                        <span>{rec.id_physically_inspected ? 'ID Inspected' : 'No ID Flag'}</span>
                        {rec.emergency_exception_applied && (
                          <span className="rounded bg-red-50 px-1 text-red-700 font-semibold">Policy Exception</span>
                        )}
                      </div>
                    </DataTableCell>
                    <DataTableCell className="whitespace-nowrap text-xs">
                      <span className="font-semibold text-[var(--color-text-primary)]">{rec.gate}</span>
                      <span className="block font-mono text-[11px] text-[var(--color-text-muted)]">
                        Seq #{rec.local_sequence}{rec.device_alias ? ` (${rec.device_alias})` : ''}
                      </span>
                    </DataTableCell>
                    <DataTableCell className="whitespace-nowrap text-xs text-[var(--color-text-secondary)]">
                      {formatManilaDateTime(new Date(rec.local_recorded_at).getTime())}
                    </DataTableCell>
                    <DataTableCell>
                      <StatusBadge
                        status={
                          rec.reconciliation_status === 'accepted'
                            ? 'approved'
                            : rec.reconciliation_status === 'rejected'
                            ? 'rejected'
                            : rec.reconciliation_status === 'needs_review'
                            ? 'warning'
                            : 'pending'
                        }
                        label={rec.reconciliation_status.replace(/_/g, ' ')}
                      />
                      {rec.reconciliation_notes && (
                        <p className="mt-1 max-w-44 truncate text-[11px] text-[var(--color-text-muted)]" title={rec.reconciliation_notes || undefined}>
                          {rec.reconciliation_notes}
                        </p>
                      )}
                    </DataTableCell>
                    <DataTableCell className="text-right">
                      <Button
                        variant="secondary"
                        size="sm"
                        icon={<ClipboardCheck className="h-3.5 w-3.5" />}
                        onClick={() => {
                          setReconcilingRecord(rec);
                          setReconcileDecision(
                            rec.reconciliation_status === 'needs_review' || rec.reconciliation_status === 'duplicate' || rec.reconciliation_status === 'rejected'
                              ? rec.reconciliation_status
                              : 'accepted',
                          );
                          setReconcileNotes(rec.reconciliation_notes || '');
                        }}
                      >
                        Reconcile
                      </Button>
                    </DataTableCell>
                  </DataTableRow>
                ))
              )}
            </tbody>
          </DataTable>
        </div>
      ) : (
      <>
      {/* Table */}
      <div className="print:border-none print:shadow-none print:m-0 print:p-0">
        <DataTable>
          <DataTableHead>
            <DataTableRow>
              <DataTableCell isHeader className="print:px-2">Name / Purpose</DataTableCell>
              <DataTableCell isHeader className="print:px-2">Status</DataTableCell>
              <DataTableCell isHeader className="print:px-2">Issued</DataTableCell>
              <DataTableCell isHeader className="print:px-2">Time In</DataTableCell>
              <DataTableCell isHeader className="print:px-2">Time Out</DataTableCell>
              <DataTableCell isHeader className="text-right print:hidden">Details</DataTableCell>
            </DataTableRow>
          </DataTableHead>
          <tbody className="divide-y border-[var(--color-border)] print:divide-black/20">
            {loading ? (
              <TableSkeletonRows columns={6} rows={8} columnWidths={['30%', '15%', '15%', '15%', '15%', '10%']} ariaLabel="Loading visitor records…" />
            ) : recordsError ? (
              <tr>
                <td colSpan={6} className="py-8 text-center">
                  <div className="flex flex-col items-center justify-center gap-3">
                    <p className="text-sm font-medium text-[var(--color-danger)]">{recordsError}</p>
                    <Button size="sm" variant="secondary" onClick={() => void loadRootRecords()}>
                      Retry
                    </Button>
                  </div>
                </td>
              </tr>
            ) : filteredPasses.length === 0 ? (
              <tr>
                <td colSpan={6} className="py-8 text-center text-[var(--color-text-muted)]">
                  No records found for the selected filters.
                </td>
              </tr>
            ) : (
              filteredPasses.map((pass) => (
                <DataTableRow key={pass.id} className="print:hover:bg-transparent">
                  <DataTableCell className="print:px-2">
                    <p className="font-bold text-[var(--color-text-primary)]">{pass.visitorName}</p>
                    <p className="text-sm font-medium text-[var(--color-text-secondary)] line-clamp-1">{pass.purpose}</p>
                  </DataTableCell>
                  <DataTableCell className="print:px-2">
                    {pass.status === 'inside' && pass.validUntil && pass.validUntil.toMillis() < Date.now() ? (
                      <StatusBadge status="error" label="Missing exit" />
                    ) : (
                      <StatusBadge status={pass.status} />
                    )}
                  </DataTableCell>
                  <DataTableCell className="whitespace-nowrap text-[var(--color-text-secondary)] print:px-2">
                    {pass.issuedAt ? formatManilaDateTime(pass.issuedAt.toMillis(), { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true }) : '—'}
                  </DataTableCell>
                  <DataTableCell className="whitespace-nowrap text-[var(--color-text-secondary)] print:px-2">
                    {pass.timeIn ? (
                      <>
                        <span>{formatManilaTime(pass.timeIn.toMillis())}</span>
                        {pass.gate && <span className="block text-[11px] text-[var(--color-text-muted)] font-mono">Gate: {pass.gate}</span>}
                      </>
                    ) : '—'}
                    {pass.expectedGate && (
                      <span className="block text-[11px] text-[var(--color-brand)] font-medium">
                        Expected: {pass.expectedGate}
                      </span>
                    )}
                  </DataTableCell>
                  <DataTableCell className="whitespace-nowrap text-[var(--color-text-secondary)] print:px-2">
                    {pass.timeOut ? formatManilaTime(pass.timeOut.toMillis()) : '—'}
                  </DataTableCell>
                  <DataTableCell className="text-right print:hidden">
                    <Button variant="ghost" size="sm" onClick={() => void handleSelectPass(pass)} icon={<Eye className="h-4 w-4" aria-hidden="true" />}>
                      View
                    </Button>
                  </DataTableCell>
                </DataTableRow>
              ))
            )}
          </tbody>
        </DataTable>
        {hasMore && (
          <div className="mt-4 flex justify-center print:hidden">
            <Button variant="secondary" loading={loadingMore} disabled={loadingMore} onClick={() => void loadMoreRecords()}>
              {loadingMore ? 'Loading...' : 'Load more records'}
            </Button>
          </div>
        )}
      </div>
      </>
      )}
      </>
      )}

      <Modal
        isOpen={!!selectedPass}
        onClose={handleClosePassModal}
        title="Visitor Pass Details"
        description="Read-only visitor information and verification images"
        size="lg"
      >
        {selectedPass && (
          <div className="space-y-6">
            <div className="flex flex-col gap-3 border-b border-[var(--color-border)] pb-5 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0">
                <h3 className="break-words text-xl font-bold text-[var(--color-text-primary)]">{selectedPass.visitorName}</h3>
                <p className="mt-1 break-words text-sm leading-relaxed text-[var(--color-text-secondary)]">{selectedPass.purpose}</p>
              </div>
              <StatusBadge status={selectedPass.status} />
            </div>

            <dl className="grid gap-4 rounded-xl border border-[var(--color-border)] bg-[var(--color-canvas)] p-4 sm:grid-cols-2">
              <PassDetail label="Sex" value={(selectedPass as any).gender || 'Not recorded'} />
              <PassDetail label="Contact Number" value={selectedPass.contactNumber || 'Not recorded'} />
              <PassDetail label="Purpose of Visit" value={selectedPass.purpose || 'Not recorded'} />
              <PassDetail label="Destination Office" value={selectedPass.destinationOffice || 'General Campus'} />
              <PassDetail label="Office Attendance" value={selectedPass.attendanceStatus ? selectedPass.attendanceStatus.replace(/_/g, ' ') : 'Not recorded'} />
              <PassDetail
                label="Full Residential Address"
                value={
                  [
                    selectedPass.homeBuilding,
                    selectedPass.homeStreet,
                    selectedPass.barangayName,
                    selectedPass.cityName,
                    selectedPass.provinceName,
                    selectedPass.regionName,
                  ].filter(Boolean).join(', ') || selectedPass.homeAddress || 'Not recorded'
                }
                className="sm:col-span-2"
              />
              <PassDetail label="Expected gate" value={selectedPass.expectedGate || 'Not assigned'} />
              <PassDetail label="Actual entry gate" value={selectedPass.gate || 'Not recorded'} />
              <PassDetail label="Issued" value={selectedPass.issuedAt ? formatManilaDateTime(selectedPass.issuedAt.toMillis()) : 'Not recorded'} />
              <PassDetail label="Time in" value={selectedPass.timeIn ? formatManilaDateTime(selectedPass.timeIn.toMillis()) : 'Not recorded'} />
              <PassDetail label="Time out" value={selectedPass.timeOut ? formatManilaDateTime(selectedPass.timeOut.toMillis()) : 'Not recorded'} />
            </dl>

            {(role === 'admin' || role === 'superadmin') && (
              <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-subtle)] p-4">
                <label htmlFor="expected-gate-input" className="mb-1.5 flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-[var(--color-text-primary)]">
                  <MapPin className="h-3.5 w-3.5 text-[var(--color-brand)]" />
                  Assign Expected Entry Gate
                </label>
                <div className="flex flex-wrap gap-2">
                  <Input
                    id="expected-gate-input"
                    type="text"
                    value={expectedGateDraft}
                    onChange={(e) => setExpectedGateDraft(e.target.value)}
                    placeholder="e.g. Main Gate / Gate 1"
                    maxLength={80}
                    className="flex-1 min-w-44"
                  />
                  <Button
                    type="button"
                    size="sm"
                    onClick={() => void handleSaveExpectedGate()}
                    loading={savingExpectedGate}
                    disabled={savingExpectedGate || !expectedGateDraft.trim()}
                  >
                    Save Expected Gate
                  </Button>
                </div>
              </div>
            )}

            <div className="grid gap-5 sm:grid-cols-2">
              <VerificationImage title="Visitor photo" publicId={selectedPass.photoPublicId} />
              <VerificationImage title="Valid ID" publicId={selectedPass.idImagePublicId} emptyText="No ID image was required for this pass." />
            </div>

            {/* Incident Hold Section */}
            <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-canvas-subtle)] p-4 space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  {holdLookupState.status === 'protected' ? (
                    <ShieldAlert className="h-5 w-5 text-[var(--color-danger)]" />
                  ) : holdLookupState.status === 'error' ? (
                    <AlertTriangle className="h-5 w-5 text-[var(--color-warning)]" />
                  ) : (
                    <ShieldCheck className="h-5 w-5 text-[var(--color-success)]" />
                  )}
                  <h4 className="font-semibold text-sm text-[var(--color-text-primary)]">
                    Evidence Retention Status:{' '}
                    {holdLookupState.status === 'loading'
                      ? 'Checking retention protection…'
                      : holdLookupState.status === 'protected'
                        ? 'Active Incident Hold'
                        : holdLookupState.status === 'error'
                          ? 'Retention Protection Status Unavailable'
                          : 'Normal Retention'}
                  </h4>
                </div>
                {role === 'superadmin' && (
                  holdLookupState.status === 'protected' ? (
                    <Button size="sm" variant="destructive" onClick={() => setShowReleaseModal(true)}>
                      Release Hold
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={holdLookupState.status === 'loading' || holdLookupState.status === 'error'}
                      onClick={() => setShowHoldModal(true)}
                    >
                      Place Incident Hold
                    </Button>
                  )
                )}
              </div>
              {holdLookupState.status === 'loading' ? (
                <p className="text-xs text-[var(--color-text-secondary)]">Checking retention protection…</p>
              ) : holdLookupState.status === 'protected' && holdLookupState.holds[0] ? (
                <div className="text-xs text-[var(--color-text-secondary)] space-y-1">
                  <p><strong className="text-[var(--color-text-primary)]">Hold Reason:</strong> {holdLookupState.holds[0].reason}</p>
                  <p><strong className="text-[var(--color-text-primary)]">Placed:</strong> {formatManilaDateTime(holdLookupState.holds[0].createdAt)}</p>
                  {holdLookupState.holds.length > 1 && (
                    <p className="text-xs font-medium text-[var(--color-text-secondary)]">
                      ({holdLookupState.holds.length} active holds protecting this record)
                    </p>
                  )}
                  <p className="text-[var(--color-danger)] font-medium">Automatic and manual evidence deletion is paused for this pass while hold is active.</p>
                </div>
              ) : holdLookupState.status === 'error' ? (
                <div className="text-xs text-[var(--color-danger)] space-y-1">
                  <p className="font-medium">Retention protection status unavailable.</p>
                  <p>Do not assume this record is unprotected.</p>
                </div>
              ) : (
                <p className="text-xs text-[var(--color-text-secondary)]">
                  Evidence will be cleaned up according to standard retention policy.
                </p>
              )}
            </div>
          </div>
        )}
      </Modal>

      {/* Place Incident Hold Modal */}
      <Modal
        isOpen={showHoldModal}
        onClose={() => setShowHoldModal(false)}
        title="Place Incident Hold"
      >
        <div className="space-y-4">
          <p className="text-sm text-[var(--color-text-secondary)]">
            An incident hold protects this pass and visitor evidence (face photo, valid ID) from being purged by scheduled or manual retention cleanup.
          </p>
          <div>
            <label htmlFor="hold-reason-input" className="block text-xs font-semibold text-[var(--color-text-primary)] mb-1">
              Hold Reason (Required, min 5 chars)
            </label>
            <textarea
              id="hold-reason-input"
              rows={3}
              value={holdReason}
              onChange={(e) => setHoldReason(e.target.value)}
              className="w-full rounded-lg border border-[var(--color-border)] p-2.5 text-sm"
              placeholder="e.g. Investigation regarding unauthorized entry attempt at Gate 2"
            />
          </div>
          <div className="flex justify-end gap-3 pt-2">
            <Button variant="secondary" onClick={() => setShowHoldModal(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={submittingHold || holdReason.trim().length < 5}
              loading={submittingHold}
              onClick={handleCreateHold}
            >
              Confirm Place Hold
            </Button>
          </div>
        </div>
      </Modal>

      {/* Release Incident Hold Modal */}
      <Modal
        isOpen={showReleaseModal}
        onClose={() => setShowReleaseModal(false)}
        title="Release Incident Hold"
      >
        <div className="space-y-4">
          <p className="text-sm text-[var(--color-text-secondary)]">
            Releasing this hold will restore normal data retention rules for this visitor and pass.
          </p>
          <div>
            <label htmlFor="release-reason-input" className="block text-xs font-semibold text-[var(--color-text-primary)] mb-1">
              Release Note (Optional)
            </label>
            <textarea
              id="release-reason-input"
              rows={2}
              value={releaseReason}
              onChange={(e) => setReleaseReason(e.target.value)}
              className="w-full rounded-lg border border-[var(--color-border)] p-2.5 text-sm"
              placeholder="e.g. Investigation concluded; no violation found."
            />
          </div>
          <div className="flex justify-end gap-3 pt-2">
            <Button variant="secondary" onClick={() => setShowReleaseModal(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={submittingHold}
              loading={submittingHold}
              onClick={handleReleaseHold}
            >
              Confirm Release
            </Button>
          </div>
        </div>
      </Modal>

      {/* Offline Record Reconciliation Modal */}
      <Modal
        isOpen={!!reconcilingRecord}
        onClose={() => {
          if (!submittingReconcile) {
            setReconcilingRecord(null);
            setReconcileNotes('');
          }
        }}
        title="Reconcile OFFLINE MODE RECORDED Entry"
        preventClose={submittingReconcile}
      >
        {reconcilingRecord && (
          <div className="space-y-4">
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs">
              <div className="flex items-center justify-between gap-2">
                <span className="font-bold text-[var(--color-text-primary)]">{reconcilingRecord.visitor_full_name}</span>
                <StatusBadge status="warning" label="OFFLINE MODE RECORDED" />
              </div>
              <p className="mt-1 text-[var(--color-text-secondary)]">
                Gate: {reconcilingRecord.gate} · Seq #{reconcilingRecord.local_sequence} · Office: {reconcilingRecord.destination_office_name_snapshot || 'Campus'}
              </p>
            </div>
            <div>
              <label htmlFor="reconcile-decision-select" className="mb-1 block text-xs font-semibold text-[var(--color-text-primary)]">
                Reconciliation Decision
              </label>
              <Select
                id="reconcile-decision-select"
                value={reconcileDecision}
                onChange={(e) => setReconcileDecision(e.target.value as 'accepted' | 'needs_review' | 'duplicate' | 'rejected')}
              >
                <option value="accepted">Accepted (Verified Offline Entry)</option>
                <option value="needs_review">Needs Review</option>
                <option value="duplicate">Duplicate Offline Submission</option>
                <option value="rejected">Rejected / Invalid Record</option>
              </Select>
            </div>
            <div>
              <label htmlFor="reconcile-notes-input" className="mb-1 block text-xs font-semibold text-[var(--color-text-primary)]">
                Reconciliation Notes (Required, min 5 chars)
              </label>
              <textarea
                id="reconcile-notes-input"
                rows={3}
                value={reconcileNotes}
                onChange={(e) => setReconcileNotes(e.target.value)}
                className="w-full rounded-lg border border-[var(--color-border)] p-2.5 text-sm"
                placeholder="Document physical log verification or discrepancy resolution..."
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button
                variant="secondary"
                onClick={() => {
                  setReconcilingRecord(null);
                  setReconcileNotes('');
                }}
                disabled={submittingReconcile}
              >
                Cancel
              </Button>
              <Button
                onClick={() => void handleSubmitReconcile()}
                loading={submittingReconcile}
                disabled={reconcileNotes.trim().length < 5}
              >
                Save Reconciliation
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}

function PassDetail({ label, value, className = '' }: { label: string; value: string; className?: string }) {
  return (
    <div className={className}>
      <dt className="text-xs font-bold uppercase tracking-wide text-[var(--color-text-muted)]">{label}</dt>
      <dd className="mt-1 break-words text-sm font-semibold text-[var(--color-text-primary)]">{value}</dd>
    </div>
  );
}

function VerificationImage({ title, publicId, emptyText = 'Image unavailable' }: { title: string; publicId?: string | null; emptyText?: string }) {
  return (
    <section aria-label={title}>
      <h4 className="mb-2 text-sm font-bold text-[var(--color-text-primary)]">{title}</h4>
      {publicId ? (
        <AuthenticatedImage publicId={publicId} alt={title} fallbackText={emptyText} className="h-64 w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-overlay)] object-contain" />
      ) : (
        <div className="flex h-64 items-center justify-center rounded-xl border border-dashed border-[var(--color-border-strong)] bg-[var(--color-canvas)] p-4 text-center text-sm text-[var(--color-text-muted)]">{emptyText}</div>
      )}
    </section>
  );
}

type ReportCategory =
  | 'all'
  | 'campus_exit'
  | 'office_visit'
  | 'completed'
  | 'requiring_review'
  | 'missing_timeout'
  | 'currently_inside'
  | 'exited_unconfirmed'
  | 'specific_unconfirmed'
  | 'approved_no_arrival';

interface VisitorReportsViewProps {
  onSelectPass: (pass: GatePassWithId) => void;
  userRole?: string | null;
}

interface AccountabilitySummaryData {
  totalVisitors: number;
  completedVisits: number;
  missingExitCount: number;
  missingOfficeCount: number;
  requiringReviewCount: number;
  reviewedCount: number;
  schoolClosingTime: string;
  schoolOpeningTime: string;
  timezone: string;
}

function formatDatetimeLocal(d: Date = new Date()): string {
  const pad = (n: number) => n.toString().padStart(2, '0');
  const year = d.getFullYear();
  const month = pad(d.getMonth() + 1);
  const day = pad(d.getDate());
  const hours = pad(d.getHours());
  const minutes = pad(d.getMinutes());
  return `${year}-${month}-${day}T${hours}:${minutes}`;
}

function VisitorReportsView({ onSelectPass, userRole }: VisitorReportsViewProps) {
  const [reportCategory, setReportCategory] = useState<ReportCategory>('all');
  const [reportDateFrom, setReportDateFrom] = useState<string>(() => getManilaDateString());
  const [reportDateTo, setReportDateTo] = useState<string>(() => getManilaDateString());
  const [datePreset, setDatePreset] = useState<DatePresetKey | 'custom' | ''>('today');
  const [officeFilter, setOfficeFilter] = useState<string>('all');
  const [reviewStatusFilter, setReviewStatusFilter] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [debouncedSearchQuery, setDebouncedSearchQuery] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [reportPasses, setReportPasses] = useState<GatePassWithId[]>([]);
  const [accountabilitySummary, setAccountabilitySummary] = useState<AccountabilitySummaryData | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportFormat, setExportFormat] = useState<'csv' | 'xlsx' | 'pdf' | null>(null);

  // Pagination state
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [totalReportCount, setTotalReportCount] = useState<number>(0);
  const [loadingMore, setLoadingMore] = useState(false);

  // Request counter & abort controller for search cancellation & race prevention
  const abortControllerRef = useRef<AbortController | null>(null);
  const requestCounterRef = useRef<number>(0);

  // Stable requestId for accountability resolution idempotency
  const resolutionRequestIdRef = useRef<string>('');

  // Review & Resolution Modal State
  const [selectedPassForResolution, setSelectedPassForResolution] = useState<GatePassWithId | null>(null);
  const [resolutionModalOpen, setResolutionModalOpen] = useState(false);
  const [resolutionTab, setResolutionTab] = useState<'record_verified_exit' | 'confirm_office_visit' | 'mark_reviewed' | 'record_exception'>('record_verified_exit');
  const [verifiedExitTime, setVerifiedExitTime] = useState('');
  const [verifiedExitGate, setVerifiedExitGate] = useState('');
  const [verifiedOfficeTime, setVerifiedOfficeTime] = useState('');
  const [resolutionReason, setResolutionReason] = useState('');
  const [exceptionType, setExceptionType] = useState<'redirected' | 'office_closed' | 'cancelled_after_entry' | 'cctv_verified' | 'emergency_evacuation' | 'other'>('redirected');
  const [submittingResolution, setSubmittingResolution] = useState(false);

  const isSuperAdmin = userRole === 'superadmin';

  // Debounce search input by 300ms
  useEffect(() => {
    const handler = setTimeout(() => {
      setDebouncedSearchQuery(searchQuery);
    }, 300);
    return () => clearTimeout(handler);
  }, [searchQuery]);

  const reportDescriptions: Record<ReportCategory, { title: string; desc: string }> = {
    all: {
      title: 'All Visitor Records (Everything)',
      desc: 'All visitor passes and registration records within the selected date range.',
    },
    campus_exit: {
      title: 'Campus Exit Report (No Recorded Exit)',
      desc: 'Visitors who entered campus but have no recorded exit after school operating hours.',
    },
    office_visit: {
      title: 'Office Visit Report (Office Visit Not Recorded)',
      desc: 'Visitors who entered campus and selected an office, but arrival was not recorded by operating hours.',
    },
    completed: {
      title: 'Completed Visits',
      desc: 'Visitors who entered, completed their office attendance (or general visit), and exited properly.',
    },
    requiring_review: {
      title: 'Requiring Review',
      desc: 'Visitors with missing exit or missing office arrival records awaiting review or resolution.',
    },
    missing_timeout: {
      title: 'Missing Time-Out Report',
      desc: 'Visitors who entered campus (time-in recorded) but have no time-out exit recorded.',
    },
    currently_inside: {
      title: 'Currently Inside Campus Report',
      desc: 'Active visitors currently verified inside campus premises.',
    },
    exited_unconfirmed: {
      title: 'Exited Without Office Confirmation',
      desc: 'Visitors who clocked out at gate exits without office arrival confirmation recorded.',
    },
    specific_unconfirmed: {
      title: 'Specific-Person Visits Not Confirmed by Office',
      desc: 'Visitors with approved specific-person visits whose office arrival was never confirmed by the host office.',
    },
    approved_no_arrival: {
      title: 'Approved Requests Who Never Arrived at Gate',
      desc: 'Visitors with issued/approved QR passes who never recorded a gate entry scan.',
    },
  };

  const loadReportData = useCallback(async () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    const abortController = new AbortController();
    abortControllerRef.current = abortController;
    const currentRequestId = ++requestCounterRef.current;

    setLoading(true);
    try {
      const token = await getAccessToken();
      const params = new URLSearchParams();
      params.set('pageSize', '50');
      if (reportDateFrom) params.set('dateFrom', reportDateFrom);
      if (reportDateTo) params.set('dateTo', reportDateTo);
      if (['campus_exit', 'office_visit', 'completed', 'requiring_review', 'missing_timeout', 'currently_inside', 'exited_unconfirmed', 'specific_unconfirmed', 'approved_no_arrival'].includes(reportCategory)) {
        params.set('category', reportCategory);
      }
      if (officeFilter && officeFilter !== 'all') {
        params.set('office', officeFilter);
      }
      if (reviewStatusFilter && reviewStatusFilter !== 'all') {
        params.set('reviewStatus', reviewStatusFilter);
      }
      if (debouncedSearchQuery.trim()) {
        params.set('search', debouncedSearchQuery.trim());
      }

      const res = await fetch(`/api/admin/records?${params.toString()}`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: abortController.signal,
      });
      if (currentRequestId !== requestCounterRef.current) return;
      if (!res.ok) throw new Error('Failed to load report records');
      const data = await res.json();
      if (currentRequestId !== requestCounterRef.current) return;

      const items: GatePassWithId[] = (data?.passes || []).map(deserializeRecordPass);

      if (data?.accountabilitySummary) {
        setAccountabilitySummary(data.accountabilitySummary);
      }

      let filtered = items;
      if (reportCategory === 'office_visit') {
        filtered = items.filter((p) => p.missingOffice);
      } else if (reportCategory === 'missing_timeout') {
        filtered = items.filter((p) => p.timeIn != null && p.timeOut == null);
      } else if (reportCategory === 'currently_inside') {
        filtered = items.filter((p) => p.status === 'inside' || (p.timeIn != null && p.timeOut == null));
      } else if (reportCategory === 'exited_unconfirmed') {
        filtered = items.filter(
          (p) =>
            Boolean(p.destinationOffice && p.destinationOffice.trim() !== '' && p.destinationOffice.toLowerCase() !== 'general campus') &&
            (p.timeOut != null || p.status === 'exited') &&
            p.attendanceStatus !== 'confirmed' &&
            p.attendanceStatus !== 'completed'
        );
      } else if (reportCategory === 'specific_unconfirmed') {
        filtered = items.filter(
          (p) =>
            p.visitType === 'specific_person' &&
            (p.timeIn != null || p.status === 'inside' || p.status === 'exited') &&
            p.attendanceStatus !== 'confirmed' &&
            p.attendanceStatus !== 'completed'
        );
      } else if (reportCategory === 'approved_no_arrival') {
        filtered = items.filter((p) => (p.status === 'issued' || p.approvalStatus === 'approved') && p.timeIn == null && !p.scannedAt);
      }

      setReportPasses(filtered);
      setNextCursor(data?.nextCursor || null);
      setHasMore(Boolean(data?.hasMore));
      setTotalReportCount(typeof data?.totalCount === 'number' ? data.totalCount : filtered.length);
    } catch (err: any) {
      if (err?.name === 'AbortError') return;
      toast.error(err?.message || 'Failed to generate report.');
      setReportPasses([]);
      setNextCursor(null);
      setHasMore(false);
      setTotalReportCount(0);
    } finally {
      if (currentRequestId === requestCounterRef.current) {
        setLoading(false);
      }
    }
  }, [reportCategory, reportDateFrom, reportDateTo, officeFilter, reviewStatusFilter, debouncedSearchQuery]);

  const loadMoreReportData = async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const token = await getAccessToken();
      const params = new URLSearchParams();
      params.set('pageSize', '50');
      params.set('cursor', nextCursor);
      if (reportDateFrom) params.set('dateFrom', reportDateFrom);
      if (reportDateTo) params.set('dateTo', reportDateTo);
      if (['campus_exit', 'office_visit', 'completed', 'requiring_review', 'missing_timeout', 'currently_inside', 'exited_unconfirmed', 'specific_unconfirmed', 'approved_no_arrival'].includes(reportCategory)) {
        params.set('category', reportCategory);
      }
      if (officeFilter && officeFilter !== 'all') {
        params.set('office', officeFilter);
      }
      if (reviewStatusFilter && reviewStatusFilter !== 'all') {
        params.set('reviewStatus', reviewStatusFilter);
      }
      if (debouncedSearchQuery.trim()) {
        params.set('search', debouncedSearchQuery.trim());
      }

      const res = await fetch(`/api/admin/records?${params.toString()}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error('Failed to load more records');
      const data = await res.json();
      const newItems: GatePassWithId[] = (data?.passes || []).map(deserializeRecordPass);

      let filtered = newItems;
      if (reportCategory === 'office_visit') {
        filtered = newItems.filter((p) => p.missingOffice);
      } else if (reportCategory === 'missing_timeout') {
        filtered = newItems.filter((p) => p.timeIn != null && p.timeOut == null);
      } else if (reportCategory === 'currently_inside') {
        filtered = newItems.filter((p) => p.status === 'inside' || (p.timeIn != null && p.timeOut == null));
      } else if (reportCategory === 'exited_unconfirmed') {
        filtered = newItems.filter(
          (p) =>
            Boolean(p.destinationOffice && p.destinationOffice.trim() !== '' && p.destinationOffice.toLowerCase() !== 'general campus') &&
            (p.timeOut != null || p.status === 'exited') &&
            p.attendanceStatus !== 'confirmed' &&
            p.attendanceStatus !== 'completed'
        );
      } else if (reportCategory === 'specific_unconfirmed') {
        filtered = newItems.filter(
          (p) =>
            p.visitType === 'specific_person' &&
            (p.timeIn != null || p.status === 'inside' || p.status === 'exited') &&
            p.attendanceStatus !== 'confirmed' &&
            p.attendanceStatus !== 'completed'
        );
      } else if (reportCategory === 'approved_no_arrival') {
        filtered = newItems.filter((p) => (p.status === 'issued' || p.approvalStatus === 'approved') && p.timeIn == null && !p.scannedAt);
      }

      setReportPasses((prev) => [...prev, ...filtered]);
      setNextCursor(data?.nextCursor || null);
      setHasMore(Boolean(data?.hasMore));
    } catch (err: any) {
      toast.error(err?.message || 'Failed to load more records.');
    } finally {
      setLoadingMore(false);
    }
  };

  useEffect(() => {
    void loadReportData();
  }, [loadReportData]);

  function applyPreset(presetKey: DatePresetKey) {
    const { from, to } = getManilaDatePresetRange(presetKey);
    setDatePreset(presetKey);
    setReportDateFrom(from);
    setReportDateTo(to);
  }

  // Extract unique offices from passes for filtering
  const availableOffices = Array.from(
    new Set(
      reportPasses
        .map((p) => p.destinationOffice)
        .filter((o): o is string => Boolean(o && o.trim() !== '' && o.toLowerCase() !== 'general campus'))
    )
  ).sort();

  function openResolutionModal(pass: GatePassWithId) {
    setSelectedPassForResolution(pass);
    resolutionRequestIdRef.current = crypto.randomUUID();
    if (pass.missingOffice && !pass.missingExit) {
      setResolutionTab('confirm_office_visit');
    } else if (pass.missingExit) {
      setResolutionTab('record_verified_exit');
    } else {
      setResolutionTab('mark_reviewed');
    }
    setVerifiedExitTime(formatDatetimeLocal(new Date()));
    setVerifiedExitGate(pass.gate || pass.expectedGate || 'Gate 1');
    setVerifiedOfficeTime(formatDatetimeLocal(new Date()));
    setResolutionReason('');
    setExceptionType('redirected');
    setResolutionModalOpen(true);
  }

  async function handleRecordResolution(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedPassForResolution) return;
    if (resolutionReason.trim().length < 5) {
      toast.error('Please provide a reason / explanation of at least 5 characters.');
      return;
    }
    setSubmittingResolution(true);
    try {
      const token = await getAccessToken();
      const body: any = {
        action: resolutionTab,
        passId: selectedPassForResolution.id,
        reason: resolutionReason.trim(),
        requestId: resolutionRequestIdRef.current,
      };
      if (resolutionTab === 'record_verified_exit') {
        body.exitTime = verifiedExitTime ? new Date(verifiedExitTime).toISOString() : new Date().toISOString();
        body.gate = verifiedExitGate.trim() || 'Gate 1';
      } else if (resolutionTab === 'confirm_office_visit') {
        body.verifiedTime = verifiedOfficeTime ? new Date(verifiedOfficeTime).toISOString() : new Date().toISOString();
      } else if (resolutionTab === 'mark_reviewed') {
        body.notes = resolutionReason.trim();
      } else if (resolutionTab === 'record_exception') {
        body.exceptionType = exceptionType;
      }

      const res = await fetch('/api/admin/records', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(data?.message || data?.error || 'Failed to record resolution');
      }

      toast.success('Accountability resolution recorded successfully.');
      setResolutionModalOpen(false);
      setSelectedPassForResolution(null);
      setResolutionReason('');
      await loadReportData();
    } catch (err: any) {
      toast.error(err?.message || 'Failed to record resolution.');
    } finally {
      setSubmittingResolution(false);
    }
  }

  async function handleExportReport(format: 'csv' | 'xlsx' | 'pdf') {
    setExporting(true);
    setExportFormat(format);
    try {
      const exportResult = await collectCursorPages<GatePassWithId, string>(
        async (cursor, pageSize) => {
          const token = await getAccessToken();
          const params = new URLSearchParams();
          params.set('pageSize', String(pageSize));
          if (cursor) params.set('cursor', cursor);
          if (reportDateFrom) params.set('dateFrom', reportDateFrom);
          if (reportDateTo) params.set('dateTo', reportDateTo);
          if (['campus_exit', 'office_visit', 'completed', 'requiring_review', 'missing_timeout', 'currently_inside', 'exited_unconfirmed', 'specific_unconfirmed', 'approved_no_arrival'].includes(reportCategory)) {
            params.set('category', reportCategory);
          }
          if (officeFilter && officeFilter !== 'all') {
            params.set('office', officeFilter);
          }
          if (reviewStatusFilter && reviewStatusFilter !== 'all') {
            params.set('reviewStatus', reviewStatusFilter);
          }
          if (debouncedSearchQuery.trim()) {
            params.set('search', debouncedSearchQuery.trim());
          }

          const res = await fetch(`/api/admin/records?${params.toString()}`, {
            headers: { Authorization: `Bearer ${token}` },
          });
          if (!res.ok) throw new Error('Failed to fetch records for export');
          const data = await res.json();
          let items: GatePassWithId[] = (data?.passes || []).map(deserializeRecordPass);

          if (reportCategory === 'office_visit') {
            items = items.filter((p) => p.missingOffice);
          } else if (reportCategory === 'missing_timeout') {
            items = items.filter((p) => p.timeIn != null && p.timeOut == null);
          } else if (reportCategory === 'currently_inside') {
            items = items.filter((p) => p.status === 'inside' || (p.timeIn != null && p.timeOut == null));
          } else if (reportCategory === 'exited_unconfirmed') {
            items = items.filter(
              (p) =>
                Boolean(p.destinationOffice && p.destinationOffice.trim() !== '' && p.destinationOffice.toLowerCase() !== 'general campus') &&
                (p.timeOut != null || p.status === 'exited') &&
                p.attendanceStatus !== 'confirmed' &&
                p.attendanceStatus !== 'completed'
            );
          } else if (reportCategory === 'specific_unconfirmed') {
            items = items.filter(
              (p) =>
                p.visitType === 'specific_person' &&
                (p.timeIn != null || p.status === 'inside' || p.status === 'exited') &&
                p.attendanceStatus !== 'confirmed' &&
                p.attendanceStatus !== 'completed'
            );
          } else if (reportCategory === 'approved_no_arrival') {
            items = items.filter((p) => (p.status === 'issued' || p.approvalStatus === 'approved') && p.timeIn == null && !p.scannedAt);
          }

          return {
            items,
            nextCursor: data?.nextCursor || undefined,
          };
        },
        { pageSize: 250 },
      );

      const passesToExport = exportResult.items;
      if (passesToExport.length === 0) {
        toast.error('No matching records to export.');
        return;
      }

      if (exportResult.truncated) {
        toast.warning(`Export capped at ${EXPORT_MAX_ROWS.toLocaleString()} records. Narrow your filters for an untruncated export.`);
      }

      const info = reportDescriptions[reportCategory];
      const filename = `visitor_accountability_report_${reportCategory}_${formatManilaFileTimestamp(new Date())}`;
      const columns = [
        { header: 'Visitor Name', key: 'visitorName', width: 22 },
        { header: 'Sex', key: 'gender', width: 10 },
        { header: 'Contact Number', key: 'contactNumber', width: 16 },
        { header: 'Email', key: 'email', width: 24 },
        { header: 'Residential Address', key: 'address', width: 32 },
        { header: 'Destination Office', key: 'destinationOffice', width: 22 },
        { header: 'Purpose of Visit', key: 'purpose', width: 26 },
        { header: 'Visit Type', key: 'visitType', width: 16 },
        { header: 'Scheduled Date', key: 'visitDate', width: 14 },
        { header: 'Arrival Mode', key: 'arrivalMode', width: 14 },
        { header: 'Pass Status', key: 'status', width: 14 },
        { header: 'Time In', key: 'timeIn', width: 20 },
        { header: 'Time Out', key: 'timeOut', width: 20 },
        { header: 'Gate', key: 'gate', width: 14 },
        { header: 'Office Attendance', key: 'attendanceStatus', width: 18 },
        { header: 'Accountability Status', key: 'accountabilityStatus', width: 20 },
        { header: 'Missing Records Flag', key: 'missingFlags', width: 26 },
        { header: 'Overdue Duration', key: 'overdueDuration', width: 18 },
        { header: 'Resolution Notes', key: 'notes', width: 30 },
        { header: 'Exit Verification', key: 'exitVerification', width: 18 },
      ];

      const rows = passesToExport.map((r) => {
        let missingFlags = 'None';
        if (r.bothMissing) {
          missingFlags = 'Both: No Recorded Exit & Office Visit Not Recorded';
        } else if (r.missingExit) {
          missingFlags = 'No Recorded Exit';
        } else if (r.missingOffice) {
          missingFlags = 'Office Visit Not Recorded';
        }

        let accountabilityStatusLabel = 'Pending Review';
        if (r.accountabilityStatus === 'resolved') accountabilityStatusLabel = 'Manually Corrected';
        else if (r.accountabilityStatus === 'reviewed') accountabilityStatusLabel = 'Reviewed';
        else if (r.accountabilityStatus === 'exception') accountabilityStatusLabel = 'Exception Recorded';

        const overdueDuration = r.overdueMinutes && r.overdueMinutes > 0
          ? `${Math.floor(r.overdueMinutes / 60)}h ${r.overdueMinutes % 60}m overdue`
          : '—';

        return {
          visitorName: r.visitorName,
          gender: r.gender ? r.gender.charAt(0).toUpperCase() + r.gender.slice(1) : '—',
          contactNumber: r.contactNumber || '—',
          email: r.email || '—',
          address:
            [r.homeBuilding, r.homeStreet, r.barangayName, r.cityName, r.provinceName, r.regionName]
              .filter(Boolean)
              .join(', ') ||
            r.homeAddress ||
            '—',
          destinationOffice: r.destinationOffice || 'General Campus',
          purpose: r.purpose,
          visitType: r.visitType ? r.visitType.replace(/_/g, ' ') : 'General',
          visitDate: r.visitDate || '—',
          arrivalMode: r.arrivalMode === 'vehicle' ? 'Vehicle' : 'No Vehicle (Walk-in)',
          status: r.status,
          timeIn: r.timeIn ? formatManilaDateTime(r.timeIn.toMillis()) : '—',
          timeOut: r.timeOut ? formatManilaDateTime(r.timeOut.toMillis()) : '—',
          gate: r.gate || '—',
          attendanceStatus: r.attendanceStatus ? r.attendanceStatus.replace(/_/g, ' ') : '—',
          accountabilityStatus: accountabilityStatusLabel,
          missingFlags,
          overdueDuration,
          notes: r.accountabilityNotes || '—',
          exitVerification: r.exitVerificationType ? r.exitVerificationType.replace(/_/g, ' ') : (r.timeOut ? 'Scanner' : '—'),
        };
      });

      const reportOpts = {
        title: info.title,
        reportTitle: info.title,
        columns,
        rows,
        filterMetadata: {
          'Report Category': info.title,
          'Date Range': `${reportDateFrom} to ${reportDateTo}`,
          'School Hours': `${accountabilitySummary?.schoolOpeningTime || '08:00'} – ${accountabilitySummary?.schoolClosingTime || '17:00'} (${accountabilitySummary?.timezone || 'Asia/Manila'})`,
        },
        filename: `${filename}.${format}`,
      };

      if (format === 'csv') {
        await exportReportToCsv(reportOpts);
      } else if (format === 'xlsx') {
        await exportReportToExcel({ ...reportOpts, sheetName: 'Visitor Accountability' });
      } else {
        await exportReportToPdf(reportOpts);
      }
      toast.success(`Exported ${passesToExport.length} records to ${format.toUpperCase()}.`);
    } catch (err: any) {
      toast.error(err?.message || `Failed to export ${format.toUpperCase()} report.`);
    } finally {
      setExporting(false);
      setExportFormat(null);
    }
  }

  const meta = reportDescriptions[reportCategory];

  return (
    <div className="space-y-5">
      {/* Operating Hours Info Banner */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3.5 text-xs text-[var(--color-text-secondary)]">
        <div className="flex items-center gap-2">
          <Clock className="h-4 w-4 text-[var(--color-brand)] shrink-0" />
          <span>
            <strong>Campus Operating Hours:</strong> {accountabilitySummary?.schoolOpeningTime || '08:00'} – {accountabilitySummary?.schoolClosingTime || '17:00'} ({accountabilitySummary?.timezone || 'Asia/Manila'}). Automated accountability checks evaluate incomplete visits after operating hours.
          </span>
        </div>
        <span className="font-semibold text-[var(--color-text-primary)]">
          {totalReportCount > 0 ? `${totalReportCount} ${totalReportCount === 1 ? 'record' : 'records'}` : `${reportPasses.length} ${reportPasses.length === 1 ? 'record' : 'records'}`} matching current view
        </span>
      </div>

      {/* 5 Deduplicated Overview Statistics Cards */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <button
          type="button"
          onClick={() => setReportCategory('all')}
          className={`rounded-xl border p-4 text-left transition-all ${
            reportCategory === 'all'
              ? 'border-[var(--color-brand)] bg-[var(--color-surface)] ring-2 ring-[var(--color-brand)]/20'
              : 'border-[var(--color-border)] bg-[var(--color-surface)] hover:border-[var(--color-border-strong)]'
          }`}
        >
          <p className="text-xs font-semibold uppercase tracking-wider text-[var(--color-text-secondary)]">Total Visitors</p>
          <p className="mt-1 text-2xl font-bold text-[var(--color-text-primary)]">
            {accountabilitySummary?.totalVisitors ?? 0}
          </p>
          <p className="mt-0.5 text-[11px] text-[var(--color-text-muted)]">Unique visitors</p>
        </button>

        <button
          type="button"
          onClick={() => setReportCategory('completed')}
          className={`rounded-xl border p-4 text-left transition-all ${
            reportCategory === 'completed'
              ? 'border-emerald-600 bg-emerald-50/50 ring-2 ring-emerald-500/20'
              : 'border-[var(--color-border)] bg-[var(--color-surface)] hover:border-emerald-300'
          }`}
        >
          <p className="text-xs font-semibold uppercase tracking-wider text-emerald-800">Completed Visits</p>
          <p className="mt-1 text-2xl font-bold text-emerald-700">
            {accountabilitySummary?.completedVisits ?? 0}
          </p>
          <p className="mt-0.5 text-[11px] text-emerald-600/80">Proper entry & exit</p>
        </button>

        <button
          type="button"
          onClick={() => setReportCategory('campus_exit')}
          className={`rounded-xl border p-4 text-left transition-all ${
            reportCategory === 'campus_exit'
              ? 'border-rose-600 bg-rose-50/50 ring-2 ring-rose-500/20'
              : 'border-[var(--color-border)] bg-[var(--color-surface)] hover:border-rose-300'
          }`}
        >
          <p className="text-xs font-semibold uppercase tracking-wider text-rose-800">No Recorded Exit</p>
          <p className="mt-1 text-2xl font-bold text-rose-700">
            {accountabilitySummary?.missingExitCount ?? 0}
          </p>
          <p className="mt-0.5 text-[11px] text-rose-600/80">Entered, no exit scan</p>
        </button>

        <button
          type="button"
          onClick={() => setReportCategory('office_visit')}
          className={`rounded-xl border p-4 text-left transition-all ${
            reportCategory === 'office_visit'
              ? 'border-amber-600 bg-amber-50/50 ring-2 ring-amber-500/20'
              : 'border-[var(--color-border)] bg-[var(--color-surface)] hover:border-amber-300'
          }`}
        >
          <p className="text-xs font-semibold uppercase tracking-wider text-amber-800">Office Not Recorded</p>
          <p className="mt-1 text-2xl font-bold text-amber-700">
            {accountabilitySummary?.missingOfficeCount ?? 0}
          </p>
          <p className="mt-0.5 text-[11px] text-amber-600/80">Arrival not logged</p>
        </button>

        <button
          type="button"
          onClick={() => setReportCategory('requiring_review')}
          className={`rounded-xl border p-4 text-left transition-all col-span-2 sm:col-span-1 ${
            reportCategory === 'requiring_review'
              ? 'border-purple-600 bg-purple-50/50 ring-2 ring-purple-500/20'
              : 'border-[var(--color-border)] bg-[var(--color-surface)] hover:border-purple-300'
          }`}
        >
          <p className="text-xs font-semibold uppercase tracking-wider text-purple-800">Requiring Review</p>
          <p className="mt-1 text-2xl font-bold text-purple-700">
            {accountabilitySummary?.requiringReviewCount ?? 0}
          </p>
          <p className="mt-0.5 text-[11px] text-purple-600/80">Unresolved anomalies</p>
        </button>
      </div>

      {/* Main Filter & Navigation Card */}
      <Card className="p-5 space-y-4">
        {/* Category Pills Navigation */}
        <div className="flex flex-wrap items-center gap-1.5 border-b border-[var(--color-border)] pb-3">
          <span className="text-xs font-bold uppercase tracking-wider text-[var(--color-text-secondary)] mr-2">Category:</span>
          <Button
            type="button"
            size="sm"
            variant={reportCategory === 'all' ? 'primary' : 'secondary'}
            onClick={() => setReportCategory('all')}
          >
            All Records
          </Button>
          <Button
            type="button"
            size="sm"
            variant={reportCategory === 'campus_exit' ? 'primary' : 'secondary'}
            onClick={() => setReportCategory('campus_exit')}
          >
            Campus Exit Report
            {(accountabilitySummary?.missingExitCount ?? 0) > 0 && (
              <span className="ml-1.5 rounded-full bg-rose-100 px-1.5 py-0.2 text-[10px] font-bold text-rose-800">
                {accountabilitySummary?.missingExitCount}
              </span>
            )}
          </Button>
          <Button
            type="button"
            size="sm"
            variant={reportCategory === 'office_visit' ? 'primary' : 'secondary'}
            onClick={() => setReportCategory('office_visit')}
          >
            Office Visit Report
            {(accountabilitySummary?.missingOfficeCount ?? 0) > 0 && (
              <span className="ml-1.5 rounded-full bg-amber-100 px-1.5 py-0.2 text-[10px] font-bold text-amber-800">
                {accountabilitySummary?.missingOfficeCount}
              </span>
            )}
          </Button>
          <Button
            type="button"
            size="sm"
            variant={reportCategory === 'completed' ? 'primary' : 'secondary'}
            onClick={() => setReportCategory('completed')}
          >
            Completed Visits
          </Button>
          <Button
            type="button"
            size="sm"
            variant={reportCategory === 'requiring_review' ? 'primary' : 'secondary'}
            onClick={() => setReportCategory('requiring_review')}
          >
            Requiring Review
            {(accountabilitySummary?.requiringReviewCount ?? 0) > 0 && (
              <span className="ml-1.5 rounded-full bg-purple-100 px-1.5 py-0.2 text-[10px] font-bold text-purple-800">
                {accountabilitySummary?.requiringReviewCount}
              </span>
            )}
          </Button>
        </div>

        {/* Date Presets */}
        <div className="flex flex-wrap items-center gap-1.5 border-b border-[var(--color-border)] pb-3">
          <span className="text-xs font-semibold text-[var(--color-text-secondary)] mr-1">Date Presets:</span>
          <Button
            type="button"
            size="sm"
            variant={datePreset === 'today' ? 'primary' : 'secondary'}
            onClick={() => applyPreset('today')}
          >
            Today
          </Button>
          <Button
            type="button"
            size="sm"
            variant={datePreset === 'yesterday' ? 'primary' : 'secondary'}
            onClick={() => applyPreset('yesterday')}
          >
            Yesterday
          </Button>
          <Button
            type="button"
            size="sm"
            variant={datePreset === 'thisWeek' ? 'primary' : 'secondary'}
            onClick={() => applyPreset('thisWeek')}
          >
            This Week
          </Button>
          <Button
            type="button"
            size="sm"
            variant={datePreset === 'thisMonth' ? 'primary' : 'secondary'}
            onClick={() => applyPreset('thisMonth')}
          >
            This Month
          </Button>
        </div>

        {/* Filter Controls Grid */}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-6 items-end">
          <div className="lg:col-span-1">
            <label htmlFor="report-date-from" className="mb-1 block text-xs font-bold uppercase tracking-wide text-[var(--color-text-secondary)]">
              From Date
            </label>
            <Input
              id="report-date-from"
              type="date"
              value={reportDateFrom}
              onChange={(e) => {
                setDatePreset('custom');
                setReportDateFrom(e.target.value);
              }}
            />
          </div>

          <div className="lg:col-span-1">
            <label htmlFor="report-date-to" className="mb-1 block text-xs font-bold uppercase tracking-wide text-[var(--color-text-secondary)]">
              To Date
            </label>
            <Input
              id="report-date-to"
              type="date"
              value={reportDateTo}
              onChange={(e) => {
                setDatePreset('custom');
                setReportDateTo(e.target.value);
              }}
            />
          </div>

          <div className="lg:col-span-1">
            <label htmlFor="report-office-filter" className="mb-1 block text-xs font-bold uppercase tracking-wide text-[var(--color-text-secondary)]">
              Destination Office
            </label>
            <Select
              id="report-office-filter"
              value={officeFilter}
              onChange={(e) => setOfficeFilter(e.target.value)}
            >
              <option value="all">All Offices</option>
              {availableOffices.map((office) => (
                <option key={office} value={office}>{office}</option>
              ))}
            </Select>
          </div>

          <div className="lg:col-span-1">
            <label htmlFor="report-review-status-filter" className="mb-1 block text-xs font-bold uppercase tracking-wide text-[var(--color-text-secondary)]">
              Review Status
            </label>
            <Select
              id="report-review-status-filter"
              value={reviewStatusFilter}
              onChange={(e) => setReviewStatusFilter(e.target.value)}
            >
              <option value="all">All Statuses</option>
              <option value="pending">Pending Review</option>
              <option value="resolved">Manually Corrected</option>
              <option value="reviewed">Reviewed</option>
              <option value="exception">Exception Recorded</option>
            </Select>
          </div>

          <div className="lg:col-span-2">
            <label htmlFor="report-search-query" className="mb-1 block text-xs font-bold uppercase tracking-wide text-[var(--color-text-secondary)]">
              Search Visitor
            </label>
            <div className="flex gap-2">
              <Input
                id="report-search-query"
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Name, phone, or purpose..."
                className="flex-1"
              />
              <Button
                type="button"
                variant="secondary"
                onClick={() => void loadReportData()}
                loading={loading}
                icon={<RefreshCw className="h-4 w-4" />}
              >
                Refresh
              </Button>
            </div>
          </div>
        </div>

        {/* Export Buttons */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--color-border)] pt-3">
          <div className="text-xs text-[var(--color-text-secondary)]">
            Export accountability data with full visitor, office, scan, and resolution notes:
          </div>
          <div className="flex items-center gap-1.5">
            <Button
              type="button"
              variant="secondary"
              onClick={() => void handleExportReport('csv')}
              loading={exporting && exportFormat === 'csv'}
              disabled={exporting || reportPasses.length === 0}
              icon={<Download className="h-4 w-4" />}
            >
              CSV
            </Button>
            <Button
              type="button"
              variant="secondary"
              onClick={() => void handleExportReport('xlsx')}
              loading={exporting && exportFormat === 'xlsx'}
              disabled={exporting || reportPasses.length === 0}
              icon={<Download className="h-4 w-4" />}
            >
              Excel
            </Button>
            <Button
              type="button"
              variant="secondary"
              onClick={() => void handleExportReport('pdf')}
              loading={exporting && exportFormat === 'pdf'}
              disabled={exporting || reportPasses.length === 0}
              icon={<Download className="h-4 w-4" />}
            >
              PDF
            </Button>
          </div>
        </div>
      </Card>

      {/* View Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 gap-3">
        <div>
          <h2 className="text-sm font-bold text-[var(--color-text-primary)]">{meta.title}</h2>
          <p className="text-xs text-[var(--color-text-secondary)] mt-0.5">{meta.desc}</p>
        </div>
        <div className="flex items-center gap-2">
          <span className="rounded-full bg-[#7A0A0A]/10 px-3 py-1 text-xs font-bold text-[#7A0A0A]">
            {totalReportCount > 0 ? totalReportCount : reportPasses.length} {(totalReportCount > 0 ? totalReportCount : reportPasses.length) === 1 ? 'Record' : 'Records'} Found
          </span>
        </div>
      </div>

      {/* Accountability Data Table */}
      {loading ? (
        <DataTable>
          <DataTableHead>
            <DataTableRow>
              <DataTableCell isHeader>Visitor Name & Contact</DataTableCell>
              <DataTableCell isHeader>Destination & Purpose</DataTableCell>
              <DataTableCell isHeader>Time In</DataTableCell>
              <DataTableCell isHeader>Time Out</DataTableCell>
              <DataTableCell isHeader>Office Attendance</DataTableCell>
              <DataTableCell isHeader>Accountability & Status</DataTableCell>
              <DataTableCell isHeader className="text-right">Actions</DataTableCell>
            </DataTableRow>
          </DataTableHead>
          <tbody>
            <TableSkeletonRows columns={7} rows={8} columnWidths={['22%', '18%', '13%', '13%', '12%', '14%', '8%']} ariaLabel="Loading accountability records…" />
          </tbody>
        </DataTable>
      ) : reportPasses.length === 0 ? (
        <Card className="p-8 text-center text-sm text-[var(--color-text-muted)]">
          No visitor records matched the selected accountability criteria for this date range.
        </Card>
      ) : (
        <DataTable>
          <DataTableHead>
            <DataTableRow>
              <DataTableCell isHeader>Visitor Name & Contact</DataTableCell>
              <DataTableCell isHeader>Destination & Purpose</DataTableCell>
              <DataTableCell isHeader>Time In</DataTableCell>
              <DataTableCell isHeader>Time Out</DataTableCell>
              <DataTableCell isHeader>Office Attendance</DataTableCell>
              <DataTableCell isHeader>Accountability & Status</DataTableCell>
              <DataTableCell isHeader className="text-right">Actions</DataTableCell>
            </DataTableRow>
          </DataTableHead>
          <tbody>
            {reportPasses.map((pass) => (
              <DataTableRow key={pass.id}>
                <DataTableCell className="text-xs">
                  <div className="font-semibold text-[var(--color-text-primary)]">
                    {pass.visitorName}
                  </div>
                  <div className="text-[11px] text-[var(--color-text-secondary)]">
                    {pass.contactNumber || 'No contact number'} • {pass.gender ? pass.gender.charAt(0).toUpperCase() + pass.gender.slice(1) : 'Sex —'}
                  </div>
                </DataTableCell>

                <DataTableCell className="text-xs">
                  <div className="font-medium text-[var(--color-text-primary)]">
                    {pass.destinationOffice || 'General Campus'}
                  </div>
                  <div className="text-[11px] text-[var(--color-text-muted)] truncate max-w-xs" title={pass.purpose}>
                    {pass.purpose}
                  </div>
                </DataTableCell>

                <DataTableCell className="text-xs text-[var(--color-text-secondary)]">
                  {pass.timeIn ? (
                    <div>
                      <div>{formatManilaTime(pass.timeIn.toDate())}</div>
                      {pass.gate && <div className="text-[10px] text-[var(--color-text-muted)]">Gate: {pass.gate}</div>}
                    </div>
                  ) : (
                    <span className="text-[var(--color-text-muted)] italic">No entry scan</span>
                  )}
                </DataTableCell>

                <DataTableCell className="text-xs text-[var(--color-text-secondary)]">
                  {pass.timeOut ? (
                    <div>
                      <div>{formatManilaTime(pass.timeOut.toDate())}</div>
                      {pass.exitVerificationType && pass.exitVerificationType !== 'scanner' && (
                        <div className="text-[10px] text-emerald-700 font-medium">({pass.exitVerificationType.replace(/_/g, ' ')})</div>
                      )}
                    </div>
                  ) : pass.hasEntered && pass.isPastClosing ? (
                    <span className="text-rose-600 font-semibold italic">No exit recorded</span>
                  ) : pass.hasEntered ? (
                    <span className="text-amber-600 font-medium italic">Inside (in hours)</span>
                  ) : (
                    <span className="text-[var(--color-text-muted)] italic">—</span>
                  )}
                </DataTableCell>

                <DataTableCell className="text-xs">
                  <span className={`inline-block rounded px-2 py-0.5 text-[10px] font-semibold ${
                    pass.attendanceStatus === 'confirmed' || pass.attendanceStatus === 'completed'
                      ? 'bg-emerald-100 text-emerald-800'
                      : pass.hasEntered
                      ? 'bg-amber-100 text-amber-800'
                      : 'bg-zinc-100 text-zinc-700'
                  }`}>
                    {pass.attendanceStatus ? pass.attendanceStatus.replace(/_/g, ' ') : 'awaiting'}
                  </span>
                </DataTableCell>

                <DataTableCell className="text-xs space-y-1">
                  {/* Both Missing dual badge */}
                  {pass.bothMissing ? (
                    <div className="space-y-1">
                      <span className="inline-block rounded bg-rose-100 px-2 py-0.5 text-[10px] font-bold text-rose-800">
                        No Recorded Exit
                      </span>
                      <span className="inline-block rounded bg-amber-100 px-2 py-0.5 text-[10px] font-bold text-amber-800">
                        Office Visit Not Recorded
                      </span>
                      {(pass.overdueMinutes ?? 0) > 0 && (
                        <div className="text-[10px] font-medium text-rose-700">
                          +{Math.floor((pass.overdueMinutes ?? 0) / 60)}h {(pass.overdueMinutes ?? 0) % 60}m past closing
                        </div>
                      )}
                    </div>
                  ) : pass.missingExit ? (
                    <div className="space-y-1">
                      <span className="inline-block rounded bg-rose-100 px-2 py-0.5 text-[10px] font-bold text-rose-800">
                        No Recorded Exit
                      </span>
                      {(pass.overdueMinutes ?? 0) > 0 && (
                        <div className="text-[10px] font-medium text-rose-700">
                          +{Math.floor((pass.overdueMinutes ?? 0) / 60)}h {(pass.overdueMinutes ?? 0) % 60}m past closing
                        </div>
                      )}
                    </div>
                  ) : pass.missingOffice ? (
                    <span className="inline-block rounded bg-amber-100 px-2 py-0.5 text-[10px] font-bold text-amber-800">
                      Office Visit Not Recorded
                    </span>
                  ) : pass.accountabilityStatus === 'resolved' ? (
                    <span className="inline-block rounded bg-emerald-100 px-2 py-0.5 text-[10px] font-bold text-emerald-800">
                      Manually Corrected
                    </span>
                  ) : pass.accountabilityStatus === 'reviewed' ? (
                    <span className="inline-block rounded bg-blue-100 px-2 py-0.5 text-[10px] font-bold text-blue-800">
                      Reviewed
                    </span>
                  ) : pass.accountabilityStatus === 'exception' ? (
                    <span className="inline-block rounded bg-purple-100 px-2 py-0.5 text-[10px] font-bold text-purple-800">
                      Exception Recorded
                    </span>
                  ) : pass.isCompleted ? (
                    <span className="inline-block rounded bg-emerald-100 px-2 py-0.5 text-[10px] font-bold text-emerald-800">
                      Completed Visit
                    </span>
                  ) : (
                    <StatusBadge status={pass.status} />
                  )}

                  {pass.accountabilityNotes && (
                    <div className="text-[10px] text-[var(--color-text-secondary)] italic truncate max-w-xs" title={pass.accountabilityNotes}>
                      {pass.accountabilityNotes}
                    </div>
                  )}
                </DataTableCell>

                <DataTableCell className="text-right">
                  <div className="flex items-center justify-end gap-1.5">
                    <Button
                      size="sm"
                      variant="secondary"
                      icon={<Eye className="h-3.5 w-3.5" />}
                      onClick={() => onSelectPass(pass)}
                    >
                      Details
                    </Button>
                    {isSuperAdmin && (
                      <Button
                        size="sm"
                        variant={pass.missingExit || pass.missingOffice ? 'primary' : 'secondary'}
                        icon={<ClipboardCheck className="h-3.5 w-3.5" />}
                        onClick={() => openResolutionModal(pass)}
                      >
                        Resolve
                      </Button>
                    )}
                  </div>
                </DataTableCell>
              </DataTableRow>
            ))}
          </tbody>
        </DataTable>
      )}

      {/* Load More Button */}
      {hasMore && (
        <div className="flex justify-center pt-2">
          <Button
            type="button"
            variant="secondary"
            onClick={() => void loadMoreReportData()}
            loading={loadingMore}
            disabled={loadingMore}
          >
            Load More Records ({reportPasses.length} of {totalReportCount})
          </Button>
        </div>
      )}

      {/* Review & Resolution Modal (Super Admin) */}
      <Modal
        isOpen={resolutionModalOpen}
        onClose={() => {
          if (!submittingResolution) {
            setResolutionModalOpen(false);
            setSelectedPassForResolution(null);
          }
        }}
        title="Visitor Accountability Review & Resolution"
        description={
          selectedPassForResolution
            ? `Super Admin review for visitor ${selectedPassForResolution.visitorName} (Pass #${selectedPassForResolution.id.slice(0, 8)})`
            : 'Super Admin review'
        }
        size="lg"
      >
        {selectedPassForResolution && (
          <div className="space-y-5">
            {/* Context Summary Box */}
            <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-canvas)] p-4 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--color-border)] pb-2.5">
                <div>
                  <h4 className="text-sm font-bold text-[var(--color-text-primary)]">
                    {selectedPassForResolution.visitorName}
                  </h4>
                  <p className="text-xs text-[var(--color-text-secondary)]">
                    {selectedPassForResolution.destinationOffice || 'General Campus'} • Purpose: {selectedPassForResolution.purpose}
                  </p>
                </div>
                <div className="flex items-center gap-1.5">
                  {selectedPassForResolution.bothMissing ? (
                    <span className="rounded bg-rose-100 px-2 py-0.5 text-xs font-bold text-rose-800">
                      Both Exit & Office Missing
                    </span>
                  ) : selectedPassForResolution.missingExit ? (
                    <span className="rounded bg-rose-100 px-2 py-0.5 text-xs font-bold text-rose-800">
                      No Recorded Exit
                    </span>
                  ) : selectedPassForResolution.missingOffice ? (
                    <span className="rounded bg-amber-100 px-2 py-0.5 text-xs font-bold text-amber-800">
                      Office Visit Not Recorded
                    </span>
                  ) : null}
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3 text-xs sm:grid-cols-4">
                <div>
                  <span className="text-[var(--color-text-muted)] block">Time In:</span>
                  <span className="font-semibold text-[var(--color-text-primary)]">
                    {selectedPassForResolution.timeIn ? formatManilaDateTime(selectedPassForResolution.timeIn.toMillis()) : 'No scan'}
                  </span>
                </div>
                <div>
                  <span className="text-[var(--color-text-muted)] block">Closing Time:</span>
                  <span className="font-semibold text-[var(--color-text-primary)]">
                    {accountabilitySummary?.schoolClosingTime || '17:00'} ({accountabilitySummary?.timezone || 'Asia/Manila'})
                  </span>
                </div>
                <div>
                  <span className="text-[var(--color-text-muted)] block">Attendance:</span>
                  <span className="font-semibold text-[var(--color-text-primary)]">
                    {selectedPassForResolution.attendanceStatus ? selectedPassForResolution.attendanceStatus.replace(/_/g, ' ') : 'awaiting'}
                  </span>
                </div>
                <div>
                  <span className="text-[var(--color-text-muted)] block">Review Status:</span>
                  <span className="font-semibold text-[var(--color-text-primary)]">
                    {selectedPassForResolution.accountabilityStatus || 'pending'}
                  </span>
                </div>
              </div>

              {/* Past Resolutions History */}
              {selectedPassForResolution.resolutions && selectedPassForResolution.resolutions.length > 0 && (
                <div className="mt-3 border-t border-[var(--color-border)] pt-2.5">
                  <h5 className="text-[11px] font-bold uppercase tracking-wider text-[var(--color-text-secondary)] mb-1.5">
                    Past Resolutions / Audit History:
                  </h5>
                  <div className="space-y-1.5">
                    {selectedPassForResolution.resolutions.map((res) => (
                      <div key={res.id} className="rounded bg-[var(--color-surface)] p-2 text-xs border border-[var(--color-border)]">
                        <div className="flex items-center justify-between font-semibold text-[var(--color-text-primary)]">
                          <span>{res.resolutionType.replace(/_/g, ' ').toUpperCase()} {res.exceptionType ? `(${res.exceptionType})` : ''}</span>
                          <span className="text-[10px] text-[var(--color-text-muted)]">
                            {formatManilaDateTime(new Date(res.createdAt).getTime())}
                          </span>
                        </div>
                        <p className="mt-0.5 text-[var(--color-text-secondary)]">{res.reason}</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* Authorization Guard */}
            {!isSuperAdmin ? (
              <div role="alert" className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-xs text-amber-900">
                <p className="font-bold">Super Admin Privilege Required</p>
                <p className="mt-1">
                  Only Super Administrators have authorization to record verified exits, confirm office arrivals, mark records as reviewed, or file exceptions. Your account is view-only.
                </p>
              </div>
            ) : (
              <form onSubmit={handleRecordResolution} className="space-y-4">
                {/* Action Tabs */}
                <div>
                  <label className="mb-1.5 block text-xs font-bold uppercase tracking-wide text-[var(--color-text-secondary)]">
                    Select Resolution Action
                  </label>
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                    <button
                      type="button"
                      onClick={() => setResolutionTab('record_verified_exit')}
                      className={`rounded-lg border p-2.5 text-xs font-semibold text-center transition-all ${
                        resolutionTab === 'record_verified_exit'
                          ? 'border-[var(--color-brand)] bg-[var(--color-brand)]/10 text-[var(--color-brand)] font-bold'
                          : 'border-[var(--color-border)] bg-[var(--color-surface)] hover:bg-[var(--color-surface-hover)]'
                      }`}
                    >
                      Record Verified Exit
                    </button>
                    <button
                      type="button"
                      onClick={() => setResolutionTab('confirm_office_visit')}
                      className={`rounded-lg border p-2.5 text-xs font-semibold text-center transition-all ${
                        resolutionTab === 'confirm_office_visit'
                          ? 'border-[var(--color-brand)] bg-[var(--color-brand)]/10 text-[var(--color-brand)] font-bold'
                          : 'border-[var(--color-border)] bg-[var(--color-surface)] hover:bg-[var(--color-surface-hover)]'
                      }`}
                    >
                      Confirm Office Visit
                    </button>
                    <button
                      type="button"
                      onClick={() => setResolutionTab('mark_reviewed')}
                      className={`rounded-lg border p-2.5 text-xs font-semibold text-center transition-all ${
                        resolutionTab === 'mark_reviewed'
                          ? 'border-[var(--color-brand)] bg-[var(--color-brand)]/10 text-[var(--color-brand)] font-bold'
                          : 'border-[var(--color-border)] bg-[var(--color-surface)] hover:bg-[var(--color-surface-hover)]'
                      }`}
                    >
                      Mark as Reviewed
                    </button>
                    <button
                      type="button"
                      onClick={() => setResolutionTab('record_exception')}
                      className={`rounded-lg border p-2.5 text-xs font-semibold text-center transition-all ${
                        resolutionTab === 'record_exception'
                          ? 'border-[var(--color-brand)] bg-[var(--color-brand)]/10 text-[var(--color-brand)] font-bold'
                          : 'border-[var(--color-border)] bg-[var(--color-surface)] hover:bg-[var(--color-surface-hover)]'
                      }`}
                    >
                      Record Exception
                    </button>
                  </div>
                </div>

                {/* Tab Specific Inputs */}
                {resolutionTab === 'record_verified_exit' && (
                  <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 space-y-3">
                    <p className="text-xs text-[var(--color-text-secondary)]">
                      Record a manual verified exit when the visitor left campus without an automated scan, confirmed via security logbook or guard verification. Original scan events are preserved.
                    </p>
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      <div>
                        <label htmlFor="verified-exit-time" className="mb-1 block text-xs font-bold uppercase tracking-wide text-[var(--color-text-secondary)]">
                          Verified Exit Time
                        </label>
                        <Input
                          id="verified-exit-time"
                          type="datetime-local"
                          value={verifiedExitTime}
                          onChange={(e) => setVerifiedExitTime(e.target.value)}
                          required
                        />
                      </div>
                      <div>
                        <label htmlFor="verified-exit-gate" className="mb-1 block text-xs font-bold uppercase tracking-wide text-[var(--color-text-secondary)]">
                          Verified Exit Gate
                        </label>
                        <Input
                          id="verified-exit-gate"
                          type="text"
                          value={verifiedExitGate}
                          onChange={(e) => setVerifiedExitGate(e.target.value)}
                          placeholder="e.g. Gate 1 / Main Gate"
                          required
                        />
                      </div>
                    </div>
                  </div>
                )}

                {resolutionTab === 'confirm_office_visit' && (
                  <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 space-y-3">
                    <p className="text-xs text-[var(--color-text-secondary)]">
                      Confirm office arrival when visitor attended their destination office but the office forgot or was unable to confirm in the portal.
                    </p>
                    <div>
                      <label htmlFor="verified-office-time" className="mb-1 block text-xs font-bold uppercase tracking-wide text-[var(--color-text-secondary)]">
                        Verified Office Arrival Time
                      </label>
                      <Input
                        id="verified-office-time"
                        type="datetime-local"
                        value={verifiedOfficeTime}
                        onChange={(e) => setVerifiedOfficeTime(e.target.value)}
                        required
                      />
                    </div>
                  </div>
                )}

                {resolutionTab === 'mark_reviewed' && (
                  <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 space-y-2">
                    <p className="text-xs text-[var(--color-text-secondary)]">
                      Document administrative investigation and review notes without altering scan records or fabricating exit timestamps.
                    </p>
                  </div>
                )}

                {resolutionTab === 'record_exception' && (
                  <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 space-y-3">
                    <p className="text-xs text-[var(--color-text-secondary)]">
                      Record a valid operational exception that prevented normal campus visit completion.
                    </p>
                    <div>
                      <label htmlFor="exception-type-select" className="mb-1 block text-xs font-bold uppercase tracking-wide text-[var(--color-text-secondary)]">
                        Exception Type
                      </label>
                      <Select
                        id="exception-type-select"
                        value={exceptionType}
                        onChange={(e) => setExceptionType(e.target.value as any)}
                      >
                        <option value="redirected">Redirected (Visitor redirected to another location)</option>
                        <option value="office_closed">Office Closed (Destination office closed early / unavailable)</option>
                        <option value="cancelled_after_entry">Cancelled After Entry (Visit cancelled after entering)</option>
                        <option value="cctv_verified">CCTV Verified (Exit confirmed via CCTV review)</option>
                        <option value="emergency_evacuation">Emergency Evacuation (Campus drill or evacuation)</option>
                        <option value="other">Other Campus Exception</option>
                      </Select>
                    </div>
                  </div>
                )}

                {/* Mandatory Reason Field */}
                <div>
                  <label htmlFor="resolution-reason" className="mb-1 block text-xs font-bold uppercase tracking-wide text-[var(--color-text-secondary)]">
                    Mandatory Verification Reason / Investigation Notes (min 5 chars)
                  </label>
                  <textarea
                    id="resolution-reason"
                    rows={3}
                    value={resolutionReason}
                    onChange={(e) => setResolutionReason(e.target.value)}
                    placeholder="Provide specific justification, verification evidence, or investigation findings..."
                    required
                    minLength={5}
                    className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-2.5 text-xs text-[var(--color-text-primary)] focus:border-[var(--color-brand)] focus:outline-none focus:ring-1 focus:ring-[var(--color-brand)]"
                  />
                </div>

                <div className="flex items-center justify-end gap-2 pt-2 border-t border-[var(--color-border)]">
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() => {
                      setResolutionModalOpen(false);
                      setSelectedPassForResolution(null);
                    }}
                    disabled={submittingResolution}
                  >
                    Cancel
                  </Button>
                  <Button
                    type="submit"
                    variant="primary"
                    loading={submittingResolution}
                    disabled={submittingResolution || resolutionReason.trim().length < 5}
                    icon={<Check className="h-4 w-4" />}
                  >
                    Confirm Resolution
                  </Button>
                </div>
              </form>
            )}
          </div>
        )}
      </Modal>
    </div>
  );
}
