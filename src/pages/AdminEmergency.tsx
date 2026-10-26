import { useState, useEffect, useRef, useCallback } from 'react';
import { getAccessToken } from '@/services/auth';
import { formatManilaDateTime, formatManilaTime } from '@/lib/manilaTime';
import { Button, Card, Input, Select, DataTable, DataTableHead, DataTableRow, DataTableCell, StatusBadge } from '@/components/ui';
import {
  AlertTriangle,
  Printer,
  Loader2,
  RefreshCw,
  AlertCircle,
} from 'lucide-react';

interface EmergencyEvacuationPass {
  id: string | number;
  visitorName: string;
  timeIn: string | null;
  gate: string | null;
  status: 'inside';
}

export function AdminEmergency() {
  const [passes, setPasses] = useState<EmergencyEvacuationPass[] | null>(null);
  const [initialLoading, setInitialLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<Date | null>(null);
  const [initialError, setInitialError] = useState<string | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [isRetrying, setIsRetrying] = useState(false);
  const [gateFilter, setGateFilter] = useState('');
  const [search, setSearch] = useState('');
  const [isTruncated, setIsTruncated] = useState(false);
  const [snapshotTotal, setSnapshotTotal] = useState(0);
  const [snapshotAt, setSnapshotAt] = useState<string | null>(null);
  const [printMode, setPrintMode] = useState<'full' | 'filtered'>('full');

  // Serialization and lifecycle fencing refs
  const hasLoadedOnceRef = useRef(false);
  const isFetchingRef = useRef(false);
  const queuedFollowUpRef = useRef(false);
  const latestIntentRef = useRef(0);
  const mountedRef = useRef(true);

  // Extract unique gates from passes
  const currentPasses = passes ?? [];
  const gates = Array.from(new Set(currentPasses.map((p) => p.gate).filter(Boolean))) as string[];

  const loadEmergencyPasses = useCallback(async (isManualRetry = false) => {
    if (isFetchingRef.current) {
      if (isManualRetry) {
        queuedFollowUpRef.current = true;
      }
      return;
    }

    isFetchingRef.current = true;
    const intentId = ++latestIntentRef.current;

    if (isManualRetry) {
      setIsRetrying(true);
    } else if (!hasLoadedOnceRef.current) {
      setInitialLoading(true);
      setInitialError(null);
    } else {
      setRefreshing(true);
    }

    try {
      const token = await getAccessToken();
      const response = await fetch('/api/admin/emergency', {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await response.json().catch(() => null) as {
        passes?: EmergencyEvacuationPass[];
        total?: number;
        snapshotTotal?: number;
        snapshotAt?: string;
        truncated?: boolean;
        error?: string;
      } | null;

      if (!mountedRef.current || intentId !== latestIntentRef.current) {
        return;
      }

      if (!response.ok) {
        throw new Error(data?.error || 'Failed to load evacuation list');
      }

      setPasses(data?.passes ?? []);
      setSnapshotTotal(data?.snapshotTotal ?? (data?.passes?.length ?? 0));
      setSnapshotAt(data?.snapshotAt ?? null);
      setIsTruncated(Boolean(data?.truncated));
      setLastUpdatedAt(new Date());
      hasLoadedOnceRef.current = true;
      setInitialError(null);
      setRefreshError(null);
    } catch (err) {
      if (!mountedRef.current || intentId !== latestIntentRef.current) {
        return;
      }
      const msg = err instanceof Error ? err.message : 'Failed to load evacuation list';
      if (!hasLoadedOnceRef.current) {
        setInitialError(msg);
      } else {
        setRefreshError(msg);
      }
      console.error('Emergency load error:', err);
    } finally {
      if (mountedRef.current && intentId === latestIntentRef.current) {
        setInitialLoading(false);
        setRefreshing(false);
        setIsRetrying(false);
      }
      isFetchingRef.current = false;
      if (queuedFollowUpRef.current && mountedRef.current) {
        queuedFollowUpRef.current = false;
        void loadEmergencyPasses(true);
      }
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void loadEmergencyPasses();
    const timer = setInterval(() => {
      void loadEmergencyPasses();
    }, 15_000);
    return () => {
      mountedRef.current = false;
      clearInterval(timer);
    };
  }, [loadEmergencyPasses]);

  const filteredPasses = currentPasses.filter((p) => {
    if (gateFilter && p.gate !== gateFilter) return false;
    if (search && !(p.visitorName ?? '').toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  const hasActiveFilters = Boolean(search.trim() || gateFilter);
  const printPasses = printMode === 'filtered' ? filteredPasses : currentPasses;

  if (initialError && passes === null) {
    return (
      <Card className="mx-auto mt-12 max-w-lg text-center" role="alert">
        <AlertCircle className="mx-auto h-10 w-10 text-[var(--color-danger)]" aria-hidden="true" />
        <h1 className="mt-4 text-xl font-bold text-[var(--color-text-primary)]">Evacuation list unavailable</h1>
        <p className="mt-2 text-sm text-[var(--color-text-secondary)]">{initialError}</p>
        <Button
          onClick={() => void loadEmergencyPasses(true)}
          loading={isRetrying}
          disabled={isRetrying}
          icon={!isRetrying ? <RefreshCw className="h-4 w-4" /> : undefined}
          className="mt-5"
        >
          {isRetrying ? 'Retrying…' : 'Try Again'}
        </Button>
      </Card>
    );
  }

  return (
    <div className="space-y-6 print:m-0 print:p-0">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between print:hidden">
        <div>
          <div className="flex items-center gap-2">
            <AlertTriangle className="h-6 w-6 text-[var(--color-danger)]" />
            <h1 className="text-2xl font-bold text-[var(--color-text-primary)]">
              Emergency Evacuation List
            </h1>
          </div>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-[var(--color-text-secondary)]">
            Use this list during an emergency to see which visitors are still inside the premises. Search or filter the list, then print it to help account for everyone during evacuation.
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-3 text-xs">
            <p className="font-medium text-[var(--color-danger)]">
              Currently Inside: {currentPasses.length} Visitors
            </p>
            {refreshing ? (
              <span className="inline-flex items-center gap-1.5 text-[var(--color-brand)] font-medium" role="status" aria-live="polite">
                <Loader2 className="h-3.5 w-3.5 animate-spin shrink-0" aria-hidden="true" />
                Refreshing live list…
              </span>
            ) : refreshError && lastUpdatedAt ? (
              <span className="text-[var(--color-warning-dark)] font-medium" role="status">
                Refresh delayed — showing data from {formatManilaTime(lastUpdatedAt)}.
              </span>
            ) : lastUpdatedAt ? (
              <span className="text-[var(--color-text-secondary)]">Updated {formatManilaTime(lastUpdatedAt)}</span>
            ) : null}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {hasActiveFilters && (
            <Button
              onClick={() => {
                setPrintMode('filtered');
                setTimeout(() => window.print(), 20);
              }}
              variant="ghost"
              icon={<Printer className="h-4 w-4" />}
            >
              Print Filtered View
            </Button>
          )}
          <Button
            onClick={() => {
              setPrintMode('full');
              setTimeout(() => window.print(), 20);
            }}
            variant="secondary"
            icon={<Printer className="h-4 w-4" />}
          >
            Print Roll Call
          </Button>
        </div>
      </div>

      {/* Screen Incompleteness Alert Banner (C-02) */}
      {isTruncated && (
        <div className="rounded-lg border-2 border-red-500 bg-red-50 p-4 text-red-900 shadow-sm print:hidden" role="alert">
          <div className="flex items-center gap-3">
            <AlertTriangle className="h-6 w-6 flex-shrink-0 text-red-600" />
            <div>
              <h3 className="text-sm font-bold uppercase tracking-wide">Warning: Evacuation List Truncated</h3>
              <p className="mt-1 text-xs leading-relaxed">
                The safety query ceiling (10,000 records) was reached. Showing the first {currentPasses.length.toLocaleString()} inside visitors. Additional visitors may be inside the premises. Immediately check physical gate logs.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Screen Load Error Banner (C-02) */}
      {refreshError && (
        <div className="rounded-lg border-2 border-red-500 bg-red-50 p-4 text-red-900 print:hidden" role="alert">
          <p className="font-bold text-sm">Failed to refresh live evacuation list: {refreshError}</p>
          <p className="text-xs mt-1">
            {lastUpdatedAt
              ? `Refresh delayed — showing data from ${formatManilaTime(lastUpdatedAt)}. Do not rely on stale evacuation counts during active incidents. Verify manual gate logs.`
              : 'Do not rely on stale evacuation counts during active incidents. Verify manual gate logs.'}
          </p>
        </div>
      )}

      {/* Print Header (Visible only in print) */}
      <div className="hidden print:block mb-4">
        <h1 className="text-2xl font-bold text-black mb-1">
          {printMode === 'filtered' ? 'EARIST Emergency Roll Call (FILTERED VIEW)' : 'EARIST Emergency Roll Call'}
        </h1>
        <p className="text-sm font-medium text-black">
          Snapshot Generated: {snapshotAt ? formatManilaDateTime(new Date(snapshotAt), { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true }) : formatManilaDateTime(new Date(), { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true })} (Asia/Manila)
        </p>
        <p className="text-sm font-medium text-black">
          {printMode === 'filtered'
            ? `FILTERED ROLL CALL: ${filteredPasses.length} of ${currentPasses.length} visitors shown (Snapshot total: ${snapshotTotal})`
            : `Total Visitors Listed Inside: ${currentPasses.length} / ${snapshotTotal} snapshot total`}
        </p>
        {printMode === 'filtered' && (
          <p className="text-xs font-bold text-black mt-1">
            Active Filters: {search ? `Search="${search}" ` : ''}{gateFilter ? `Gate="${gateFilter}"` : ''}
          </p>
        )}
      </div>

      {/* Print Incompleteness Warning Banner (Visible only in print) */}
      {isTruncated && (
        <div className="hidden print:block border-4 border-black p-3 mb-4 text-black bg-white">
          <p className="font-extrabold text-base uppercase tracking-wider">
            *** CRITICAL — ROSTER INCOMPLETE / TRUNCATED ***
          </p>
          <p className="text-xs font-bold mt-1">
            Safety ceiling of 10,000 records reached. Showing {currentPasses.length} of {snapshotTotal} inside visitors. Do NOT assume all visitors are listed. Reconcile with manual gate logs immediately.
          </p>
        </div>
      )}

      {/* Print Error Warning Banner (Visible only in print) */}
      {refreshError && (
        <div className="hidden print:block border-4 border-black p-3 mb-4 text-black bg-white">
          <p className="font-extrabold text-base uppercase tracking-wider">
            *** CRITICAL — DATA REFRESH FAILED / ROSTER MAY BE STALE ***
          </p>
          <p className="text-xs font-bold mt-1">
            {lastUpdatedAt
              ? `Last successful update: ${formatManilaDateTime(lastUpdatedAt, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true })} (Asia/Manila). Verify with manual gate logs.`
              : `Error: ${refreshError}`}
          </p>
        </div>
      )}

      <Card className="flex flex-wrap gap-4 p-5 print:hidden">
        <div className="min-w-0 flex-1 sm:min-w-52">
          <label htmlFor="emergency-visitor-search" className="mb-2 block text-sm font-medium text-[var(--color-text-secondary)]">Search Name</label>
          <Input
            id="emergency-visitor-search"
            type="text"
            placeholder="Search..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        
        <div className="w-full sm:w-48">
          <label className="mb-2 block text-sm font-medium text-[var(--color-text-secondary)]">Filter by Entry Gate</label>
          <Select
            value={gateFilter}
            onChange={(e) => setGateFilter(e.target.value)}
            aria-label="Filter by entry gate"
          >
            <option value="">All Gates</option>
            {gates.map((g) => (
              <option key={g} value={g}>{g}</option>
            ))}
          </Select>
        </div>
      </Card>

      {/* Screen Table (Hidden when printing) */}
      <div className="print:hidden">
        <DataTable>
          <DataTableHead>
            <DataTableRow>
              <DataTableCell isHeader>Visitor Name</DataTableCell>
              <DataTableCell isHeader>Time In</DataTableCell>
              <DataTableCell isHeader>Entry Gate</DataTableCell>
              <DataTableCell isHeader>Status</DataTableCell>
              <DataTableCell isHeader className="w-20">Accounted</DataTableCell>
            </DataTableRow>
          </DataTableHead>
          <tbody className="divide-y border-[var(--color-border)]">
            {initialLoading && passes === null ? (
              <tr>
                <td colSpan={5} className="py-12 text-center" role="status" aria-live="polite">
                  <Loader2 className="mx-auto h-8 w-8 animate-spin text-[var(--color-brand)] mb-2" aria-hidden="true" />
                  <span className="text-sm font-medium text-[var(--color-text-secondary)]">Loading evacuation list…</span>
                </td>
              </tr>
            ) : filteredPasses.length === 0 ? (
              <tr>
                <td colSpan={5} className="py-8 text-center text-[var(--color-text-muted)]">
                  No visitors currently inside.
                </td>
              </tr>
            ) : (
              filteredPasses.map((pass) => (
                <DataTableRow key={pass.id as string}>
                  <DataTableCell className="font-bold">{pass.visitorName}</DataTableCell>
                  <DataTableCell>
                    {pass.timeIn ? formatManilaTime(pass.timeIn) : '—'}
                  </DataTableCell>
                  <DataTableCell>{pass.gate || 'Unknown'}</DataTableCell>
                  <DataTableCell><StatusBadge status="inside" label="Inside" /></DataTableCell>
                  <DataTableCell>
                    <div className="h-6 w-6 rounded border-2 border-[var(--color-border)]" />
                  </DataTableCell>
                </DataTableRow>
              ))
            )}
          </tbody>
        </DataTable>
      </div>

      {/* Dedicated Print Table (Visible ONLY in print) */}
      <div className="hidden print:block print:border-none print:shadow-none print:m-0 print:p-0">
        <DataTable>
          <DataTableHead>
            <DataTableRow>
              <DataTableCell isHeader className="print:px-2 print:text-black">Visitor Name</DataTableCell>
              <DataTableCell isHeader className="print:px-2 print:text-black">Time In</DataTableCell>
              <DataTableCell isHeader className="print:px-2 print:text-black">Entry Gate</DataTableCell>
              <DataTableCell isHeader className="print:px-2 print:text-black">Status</DataTableCell>
              <DataTableCell isHeader className="print:w-20 print:text-black">Accounted</DataTableCell>
            </DataTableRow>
          </DataTableHead>
          <tbody className="divide-y print:divide-black/20">
            {printPasses.length === 0 ? (
              <tr>
                <td colSpan={5} className="py-8 text-center print:text-black">
                  No visitors currently inside.
                </td>
              </tr>
            ) : (
              printPasses.map((pass) => (
                <DataTableRow key={pass.id as string} className="print:hover:bg-transparent">
                  <DataTableCell className="font-bold print:px-2 print:text-black">{pass.visitorName}</DataTableCell>
                  <DataTableCell className="print:px-2 print:text-black">
                    {pass.timeIn ? formatManilaTime(pass.timeIn) : '—'}
                  </DataTableCell>
                  <DataTableCell className="print:px-2 print:text-black">{pass.gate || 'Unknown'}</DataTableCell>
                  <DataTableCell className="print:px-2 print:text-black"><StatusBadge status="inside" label="Inside" /></DataTableCell>
                  <DataTableCell className="print:px-2">
                    <div className="h-6 w-6 rounded border-2 border-black" />
                  </DataTableCell>
                </DataTableRow>
              ))
            )}
          </tbody>
        </DataTable>
      </div>
    </div>
  );
}
