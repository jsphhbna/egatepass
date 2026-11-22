import { useState, useEffect, useRef, useCallback } from 'react';
import { getAccessToken } from '@/services/auth';
import { formatManilaDateTime, formatManilaTime } from '@/lib/manilaTime';
import { Button, Card, Input, Select, DataTable, DataTableHead, DataTableRow, DataTableCell, StatusBadge, TableSkeletonRows, SyncDots, Modal } from '@/components/ui';
import { toast } from 'sonner';
import {
  AlertTriangle,
  Printer,
  RefreshCw,
  AlertCircle,
  MessageSquare,
  Send,
  ShieldAlert,
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

  // Emergency Mass SMS modal state
  const [showSmsModal, setShowSmsModal] = useState(false);
  const [smsTemplates, setSmsTemplates] = useState<Array<{ id: string; title: string; body: string }>>([
    { id: 'evacuation', title: 'Campus Evacuation', body: 'EMERGENCY: EARIST campus evacuation in progress. Please exit calmly via the nearest gate.' },
    { id: 'lockdown', title: 'Security Lockdown', body: 'SECURITY ALERT: EARIST campus is on lockdown. Remain in your current location until security clears the area.' },
    { id: 'weather', title: 'Weather Dismissal', body: 'ADVISORY: Campus activities are suspended due to severe weather. Please proceed to the exit gate to scan out.' },
    { id: 'general', title: 'General Security Notice', body: 'SECURITY NOTICE: Please report to the nearest campus security station or exit immediately.' },
  ]);
  const [selectedTemplateId, setSelectedTemplateId] = useState('evacuation');
  const [customSmsMessage, setCustomSmsMessage] = useState(
    'EMERGENCY: EARIST campus evacuation in progress. Please exit calmly via the nearest gate.'
  );
  const [isSendingSms, setIsSendingSms] = useState(false);

  // Load configured templates from settings when opening modal
  useEffect(() => {
    if (showSmsModal) {
      getAccessToken().then(async (token) => {
        if (!token) return;
        try {
          const res = await fetch('/api/admin/settings', {
            headers: { Authorization: `Bearer ${token}` },
          });
          if (res.ok) {
            const data = await res.json();
            if (Array.isArray(data.smsEmergencyTemplates) && data.smsEmergencyTemplates.length > 0) {
              setSmsTemplates(data.smsEmergencyTemplates);
            }
          }
        } catch {}
      });
    }
  }, [showSmsModal]);

  async function handleSendEmergencyMassSms() {
    if (!customSmsMessage.trim()) {
      toast.error('Please enter an emergency message before broadcasting.');
      return;
    }
    setIsSendingSms(true);
    try {
      const token = await getAccessToken();
      const res = await fetch('/api/admin/sms/send', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          type: 'emergency',
          message: customSmsMessage.trim(),
        }),
      });
      const data = await res.json().catch(() => null);
      if (res.ok && data?.success) {
        toast.success(`Emergency SMS dispatched to ${data.count} visitors inside campus!`);
        setShowSmsModal(false);
      } else {
        toast.error(data?.message || data?.error || 'Failed to dispatch mass emergency SMS.');
      }
    } catch (err: any) {
      toast.error(err?.message || 'Network error broadcasting emergency SMS.');
    } finally {
      setIsSendingSms(false);
    }
  }

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
              <SyncDots size="xs" color="brand" label="Refreshing live list…" />
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
          <Button
            onClick={() => setShowSmsModal(true)}
            variant="primary"
            icon={<MessageSquare className="h-4 w-4" />}
          >
            Emergency Mass SMS
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
              <TableSkeletonRows columns={5} rows={8} columnWidths={['35%', '20%', '20%', '15%', '10%']} ariaLabel="Loading evacuation list…" />
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

      {/* Emergency Mass SMS Modal */}
      <Modal
        isOpen={showSmsModal}
        onClose={() => !isSendingSms && setShowSmsModal(false)}
        title="Emergency Mass SMS Broadcast"
        description="Broadcast an instant SMS alert to all visitors currently logged inside the campus."
        size="md"
        preventClose={isSendingSms}
      >
        <div className="space-y-4">
          <div className="flex items-center justify-between p-3 rounded-xl bg-red-50 border border-red-200">
            <div className="flex items-center gap-2.5">
              <ShieldAlert className="h-5 w-5 text-red-600 flex-shrink-0" />
              <div>
                <p className="text-xs font-bold text-red-950 uppercase tracking-wide">Recipients Ready</p>
                <p className="text-sm font-extrabold text-red-700">
                  {currentPasses.length} Visitors Currently Inside Campus
                </p>
              </div>
            </div>
            <span className="text-xs font-bold px-2.5 py-1 rounded-full bg-red-100 text-red-800">
              Live Gate Roll Call
            </span>
          </div>

          <div>
            <label className="block text-xs font-bold uppercase tracking-wider text-[var(--color-text-secondary)] mb-1.5">
              Select Pre-Typed Template
            </label>
            <select
              value={selectedTemplateId}
              onChange={(e) => {
                const id = e.target.value;
                setSelectedTemplateId(id);
                const found = smsTemplates.find((t) => t.id === id);
                if (found) setCustomSmsMessage(found.body);
              }}
              className="w-full text-xs font-semibold p-2.5 rounded-lg border border-[var(--color-border)] bg-white text-[var(--color-text-primary)] focus:border-[#7A0A0A] focus:outline-hidden"
            >
              {smsTemplates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.title}
                </option>
              ))}
            </select>
          </div>

          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="block text-xs font-bold uppercase tracking-wider text-[var(--color-text-secondary)]">
                Modifiable Alert Message
              </label>
              <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${
                customSmsMessage.length <= 160 ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-800'
              }`}>
                {customSmsMessage.length} / 160 chars ({customSmsMessage.length <= 160 ? '1 SMS' : '2 SMS segments'})
              </span>
            </div>
            <textarea
              rows={4}
              value={customSmsMessage}
              onChange={(e) => setCustomSmsMessage(e.target.value)}
              maxLength={320}
              placeholder="Type or modify your emergency text message..."
              className="w-full text-xs font-medium p-3 rounded-lg border border-[var(--color-border)] bg-white text-[var(--color-text-primary)] focus:border-[#7A0A0A] focus:ring-1 focus:ring-[#7A0A0A] focus:outline-hidden leading-relaxed"
            />
            <p className="text-xs text-[var(--color-text-secondary)] mt-1">
              You can edit this message freely before broadcasting. It will be sent through your connected Android phone SIM.
            </p>
          </div>

          <div className="p-3 rounded-xl border border-amber-200 bg-amber-50 text-xs text-amber-900 flex items-start gap-2">
            <AlertTriangle className="h-4 w-4 text-amber-700 flex-shrink-0 mt-0.5" />
            <span>
              This will send real text messages to all {currentPasses.length} visitors. Ensure message instructions are clear and accurate.
            </span>
          </div>

          <div className="flex items-center justify-end gap-3 pt-2">
            <Button
              type="button"
              variant="secondary"
              onClick={() => setShowSmsModal(false)}
              disabled={isSendingSms}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="primary"
              onClick={handleSendEmergencyMassSms}
              loading={isSendingSms}
              disabled={isSendingSms || !customSmsMessage.trim() || currentPasses.length === 0}
              icon={<Send className="h-4 w-4" />}
            >
              {isSendingSms ? 'Broadcasting...' : `Send to ${currentPasses.length} Visitors`}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
