import { useAuth } from '@/hooks/useAuth';
import { formatManilaDateTime, formatManilaTime, formatManilaIso, formatManilaFileTimestamp } from '@/lib/manilaTime';
import { listIncidentHolds, createIncidentHold, releaseIncidentHold, type IncidentHold } from '@/services/incidentHold';
import { ShieldAlert, ShieldCheck } from 'lucide-react';
import { useState, useEffect } from 'react';
import { Download, Eye, Printer } from 'lucide-react';
import { Card, Input, Select, Button, DataTable, DataTableHead, DataTableRow, DataTableCell, Modal, StatusBadge } from '@/components/ui';
import { AuthenticatedImage } from '@/components/AuthenticatedImage';
import type { GatePass, PassSource, PassStatus } from '@/types';
import { toast } from 'sonner';
import { collectCursorPages, downloadCsvFile, EXPORT_MAX_ROWS } from '@/lib/completeExport';
import { asAppTimestamp } from '@/lib/timestamp';
import { getAccessToken } from '@/services/auth';

interface GatePassWithId extends GatePass {
  id: string;
}

interface SerializedRecordPass {
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

const RECORDS_PAGE_SIZE = 50;

export function AdminRecords() {
  const { role } = useAuth();
  const [passes, setPasses] = useState<GatePassWithId[]>([]);
  const [loading, setLoading] = useState(true);
  const [dateFilter, setDateFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [selectedPass, setSelectedPass] = useState<GatePassWithId | null>(null);
  const [activeHold, setActiveHold] = useState<IncidentHold | null>(null);
  const [loadingHold, setLoadingHold] = useState(false);
  const [showHoldModal, setShowHoldModal] = useState(false);
  const [holdReason, setHoldReason] = useState('');
  const [submittingHold, setSubmittingHold] = useState(false);
  const [showReleaseModal, setShowReleaseModal] = useState(false);
  const [releaseReason, setReleaseReason] = useState('');
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(search);
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);

  async function fetchRecordsPage(cursor: string | null, pageSize: number, searchOverride?: string) {
    const token = await getAccessToken();
    const params = new URLSearchParams();
    if (statusFilter) params.set('status', statusFilter);
    if (dateFilter) params.set('date', dateFilter);
    const activeSearch = searchOverride !== undefined ? searchOverride : debouncedSearch;
    if (activeSearch.trim()) params.set('search', activeSearch.trim());
    if (cursor) params.set('cursor', cursor);
    params.set('pageSize', String(pageSize));

    const response = await fetch(`/api/admin/records?${params.toString()}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await response.json().catch(() => null) as {
      passes?: SerializedRecordPass[];
      nextCursor?: string | null;
      hasMore?: boolean;
      error?: string;
    } | null;

    if (!response.ok) throw new Error(data?.error || 'Failed to load records');

    const mapped: GatePassWithId[] = (data?.passes ?? []).map((p) => ({
      id: p.id,
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
    }));

    return {
      items: mapped,
      nextCursor: data?.nextCursor ?? null,
      hasMore: data?.hasMore ?? false,
    };
  }

  async function loadRecords(append = false, currentSearch?: string) {
    append ? setLoadingMore(true) : setLoading(true);
    try {
      const res = await fetchRecordsPage(append ? nextCursor : null, RECORDS_PAGE_SIZE, currentSearch);
      setPasses((current) => (append ? [...current, ...res.items] : res.items));
      setNextCursor(res.nextCursor);
      setHasMore(res.hasMore);
    } catch (err) {
      console.error(err);
      toast.error('Visitor records could not be loaded');
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }

  useEffect(() => {
    setNextCursor(null);
    void loadRecords(false, debouncedSearch);
  }, [dateFilter, statusFilter, debouncedSearch]);

  const filteredPasses = passes;

  async function handleSelectPass(pass: GatePassWithId) {
    setSelectedPass(pass);
    setActiveHold(null);
    setLoadingHold(true);
    try {
      const holds = await listIncidentHolds({ activeOnly: true, limit: 100 });
      const found = holds.find((h) => h.passId === pass.id);
      setActiveHold(found || null);
    } catch {
      setActiveHold(null);
    } finally {
      setLoadingHold(false);
    }
  }

  async function handleCreateHold() {
    if (!selectedPass || !holdReason.trim()) return;
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
    if (!activeHold) return;
    setSubmittingHold(true);
    try {
      await releaseIncidentHold(activeHold.id, releaseReason.trim() || undefined);
      toast.success('Incident hold released. Normal retention policy restored.');
      setShowReleaseModal(false);
      setReleaseReason('');
      setActiveHold(null);
    } catch (err: any) {
      toast.error(err.message || 'Failed to release incident hold');
    } finally {
      setSubmittingHold(false);
    }
  }

  async function exportCSV() {
    setExporting(true);
    try {
      const exportResult = await collectCursorPages<GatePassWithId, string>(
        async (cursor, pageSize) => {
          const res = await fetchRecordsPage(cursor, pageSize, debouncedSearch);
          return {
            items: res.items,
            nextCursor: res.nextCursor,
          };
        },
        { pageSize: 250 },
      );
      const exportPasses = exportResult.items;
    const headers = ['Visitor Name', 'Purpose', 'Status', 'Issued At', 'Time In', 'Time Out', 'Gate'];
      const rows = exportPasses.map((p) => [
      p.visitorName,
      p.purpose,
      p.status,
      p.issuedAt ? formatManilaIso(p.issuedAt.toMillis()) : '',
      p.timeIn ? formatManilaIso(p.timeIn.toMillis()) : '',
      p.timeOut ? formatManilaIso(p.timeOut.toMillis()) : '',
      p.gate || '',
    ]);

      downloadCsvFile(`gate_passes_${formatManilaFileTimestamp(new Date())}.csv`, [headers, ...rows]);
      if (exportResult.truncated) {
        toast.warning(`Export reached the ${EXPORT_MAX_ROWS.toLocaleString()} record safety limit. Narrow the filters for a complete file.`);
      } else {
        toast.success(`Exported ${exportPasses.length.toLocaleString()} filtered record${exportPasses.length === 1 ? '' : 's'}.`);
      }
    } catch (error) {
      console.error(error);
      toast.error('The complete filtered export could not be generated');
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-[var(--color-text-primary)]">
            Visitor Records
          </h1>
          <p className="text-sm text-[var(--color-text-secondary)] mt-1">
            View and export gate pass history
          </p>
        </div>
        <div className="flex flex-col gap-2 print:hidden min-[420px]:flex-row">
          <Button
            onClick={() => window.print()}
            variant="secondary"
            icon={<Printer className="h-4 w-4" />}
          >
            Print loaded view
          </Button>
          <Button
            onClick={() => void exportCSV()}
            disabled={exporting}
            loading={exporting}
            icon={<Download className="h-4 w-4" />}
          >
            {exporting ? 'Exporting...' : 'Export filtered CSV'}
          </Button>
        </div>
      </div>

      {/* Print Header */}
      <div className="hidden print:block mb-4">
        <h2 className="text-xl font-bold text-black">Visitor Records Report</h2>
        <p className="text-sm text-black">
          Generated: {formatManilaDateTime(new Date(), { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true })} (Asia/Manila)
        </p>
      </div>

      {/* Filters */}
      <Card className="flex flex-wrap gap-4 p-5 print:hidden">
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
        
        <div className="w-full sm:w-48">
          <label htmlFor="visitor-date-filter" className="mb-2 block text-sm font-medium text-[var(--color-text-secondary)]">Date</label>
          <Input
            id="visitor-date-filter"
            type="date"
            value={dateFilter}
            onChange={(e) => setDateFilter(e.target.value)}
          />
        </div>

        <div className="w-full sm:w-48">
          <label className="mb-2 block text-sm font-medium text-[var(--color-text-secondary)]">Status</label>
          <Select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            aria-label="Filter by status"
          >
            <option value="">All Statuses</option>
            <option value="issued">Issued</option>
            <option value="pending">Pending</option>
            <option value="inside">Inside</option>
            <option value="exited">Exited</option>
            <option value="rejected">Rejected</option>
            <option value="expired">Expired</option>
          </Select>
        </div>
      </Card>

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
              <tr className="print:hidden">
                <td colSpan={6} className="py-12 text-center">
                  <div className="mx-auto h-8 w-8 animate-spin rounded-full border-4 border-[var(--color-border)] border-t-[var(--color-brand)]" role="status" aria-label="Loading visitor records" />
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
                    {pass.timeIn ? formatManilaTime(pass.timeIn.toMillis()) : '—'}
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
            <Button variant="secondary" loading={loadingMore} disabled={loadingMore} onClick={() => void loadRecords(true)}>
              {loadingMore ? 'Loading...' : 'Load more records'}
            </Button>
          </div>
        )}
      </div>

      <Modal
        isOpen={!!selectedPass}
        onClose={() => setSelectedPass(null)}
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
              <PassDetail label="Entry gate" value={selectedPass.gate || 'Not recorded'} />
              <PassDetail label="Issued" value={selectedPass.issuedAt ? formatManilaDateTime(selectedPass.issuedAt.toMillis()) : 'Not recorded'} />
              <PassDetail label="Time in" value={selectedPass.timeIn ? formatManilaDateTime(selectedPass.timeIn.toMillis()) : 'Not recorded'} />
              <PassDetail label="Time out" value={selectedPass.timeOut ? formatManilaDateTime(selectedPass.timeOut.toMillis()) : 'Not recorded'} />
            </dl>

            <div className="grid gap-5 sm:grid-cols-2">
              <VerificationImage title="Visitor photo" publicId={selectedPass.photoPublicId} />
              <VerificationImage title="Valid ID" publicId={selectedPass.idImagePublicId} emptyText="No ID image was required for this pass." />
            </div>

            {/* Incident Hold Section */}
            <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-canvas-subtle)] p-4 space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  {activeHold ? (
                    <ShieldAlert className="h-5 w-5 text-[var(--color-danger)]" />
                  ) : (
                    <ShieldCheck className="h-5 w-5 text-[var(--color-success)]" />
                  )}
                  <h4 className="font-semibold text-sm text-[var(--color-text-primary)]">
                    Evidence Retention Status: {activeHold ? 'Active Incident Hold' : 'Normal Retention'}
                  </h4>
                </div>
                {role === 'superadmin' && (
                  activeHold ? (
                    <Button size="sm" variant="destructive" onClick={() => setShowReleaseModal(true)}>
                      Release Hold
                    </Button>
                  ) : (
                    <Button size="sm" variant="secondary" onClick={() => setShowHoldModal(true)}>
                      Place Incident Hold
                    </Button>
                  )
                )}
              </div>
              {loadingHold ? (
                <p className="text-xs text-[var(--color-text-secondary)]">Checking hold status...</p>
              ) : activeHold ? (
                <div className="text-xs text-[var(--color-text-secondary)] space-y-1">
                  <p><strong className="text-[var(--color-text-primary)]">Hold Reason:</strong> {activeHold.reason}</p>
                  <p><strong className="text-[var(--color-text-primary)]">Placed:</strong> {formatManilaDateTime(activeHold.createdAt)}</p>
                  <p className="text-[var(--color-danger)] font-medium">Automatic and manual evidence deletion is paused for this pass while hold is active.</p>
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
    </div>
  );
}

function PassDetail({ label, value }: { label: string; value: string }) {
  return (
    <div>
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
