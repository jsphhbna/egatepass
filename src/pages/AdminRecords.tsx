import { useState, useEffect } from 'react';
import {
  collection,
  query,
  orderBy,
  limit,
  getDocs,
  where,
  startAfter,
  type DocumentData,
  type QueryDocumentSnapshot,
  type QueryConstraint,
} from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { Download, Eye, Printer } from 'lucide-react';
import { addDays, format } from 'date-fns';
import { Card, Input, Select, Button, DataTable, DataTableHead, DataTableRow, DataTableCell, Modal, StatusBadge } from '@/components/ui';
import { AuthenticatedImage } from '@/components/AuthenticatedImage';
import type { GatePass } from '@/types';
import { toast } from 'sonner';
import { collectCursorPages, downloadCsvFile, EXPORT_MAX_ROWS } from '@/lib/completeExport';

interface GatePassWithId extends GatePass {
  id: string;
}

const RECORDS_PAGE_SIZE = 50;

export function AdminRecords() {
  const [passes, setPasses] = useState<GatePassWithId[]>([]);
  const [loading, setLoading] = useState(true);
  const [dateFilter, setDateFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [search, setSearch] = useState('');
  const [selectedPass, setSelectedPass] = useState<GatePassWithId | null>(null);
  const [lastDocument, setLastDocument] = useState<QueryDocumentSnapshot<DocumentData> | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [exporting, setExporting] = useState(false);

  function recordsQuery(pageSize: number, cursor: QueryDocumentSnapshot<DocumentData> | null = null) {
    const constraints: QueryConstraint[] = [];
    if (statusFilter) constraints.push(where('status', '==', statusFilter));
    if (dateFilter) {
      const start = new Date(`${dateFilter}T00:00:00+08:00`);
      const end = addDays(start, 1);
      constraints.push(where('issuedAt', '>=', start), where('issuedAt', '<', end));
    }
    constraints.push(orderBy('issuedAt', 'desc'));
    if (cursor) constraints.push(startAfter(cursor));
    constraints.push(limit(pageSize));
    return query(collection(db, 'gatePasses'), ...constraints);
  }

  async function loadRecords(append = false) {
    append ? setLoadingMore(true) : setLoading(true);
    try {
      const snap = await getDocs(recordsQuery(RECORDS_PAGE_SIZE, append ? lastDocument : null));
      const list = snap.docs.map((document) => ({ id: document.id, ...document.data() } as GatePassWithId));
      setPasses((current) => append ? [...current, ...list] : list);
      setLastDocument(snap.docs[snap.docs.length - 1] || null);
      setHasMore(snap.docs.length === RECORDS_PAGE_SIZE);
    } catch (err) {
      console.error(err);
      toast.error('Visitor records could not be loaded');
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }

  useEffect(() => {
    setLastDocument(null);
    void loadRecords(false);
  }, [dateFilter, statusFilter]);

  const filteredPasses = passes.filter((p) => {
    if (statusFilter && p.status !== statusFilter) return false;
    if (search && !(p.visitorName ?? '').toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  async function exportCSV() {
    setExporting(true);
    try {
      const exportResult = await collectCursorPages<GatePassWithId, QueryDocumentSnapshot<DocumentData>>(
        async (cursor, pageSize) => {
          const snapshot = await getDocs(recordsQuery(pageSize, cursor));
          return {
            items: snapshot.docs.map((document) => ({ id: document.id, ...document.data() } as GatePassWithId)),
            nextCursor: snapshot.docs[snapshot.docs.length - 1] || null,
          };
        },
      );
      const normalizedSearch = search.trim().toLocaleLowerCase();
      const exportPasses = exportResult.items.filter((pass) => !normalizedSearch
        || (pass.visitorName ?? '').toLocaleLowerCase().includes(normalizedSearch));
    const headers = ['Visitor Name', 'Purpose', 'Status', 'Issued At', 'Time In', 'Time Out', 'Gate'];
      const rows = exportPasses.map((p) => [
      p.visitorName,
      p.purpose,
      p.status,
      p.issuedAt ? format(p.issuedAt.toMillis(), 'yyyy-MM-dd HH:mm:ss') : '',
      p.timeIn ? format(p.timeIn.toMillis(), 'yyyy-MM-dd HH:mm:ss') : '',
      p.timeOut ? format(p.timeOut.toMillis(), 'yyyy-MM-dd HH:mm:ss') : '',
      p.gate || '',
    ]);

      downloadCsvFile(`gate_passes_${format(new Date(), 'yyyyMMdd_HHmmss')}.csv`, [headers, ...rows]);
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
          Generated: {format(new Date(), 'PPpp')}
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
                    {pass.issuedAt ? format(pass.issuedAt.toMillis(), 'MMM d, h:mm a') : '—'}
                  </DataTableCell>
                  <DataTableCell className="whitespace-nowrap text-[var(--color-text-secondary)] print:px-2">
                    {pass.timeIn ? format(pass.timeIn.toMillis(), 'h:mm a') : '—'}
                  </DataTableCell>
                  <DataTableCell className="whitespace-nowrap text-[var(--color-text-secondary)] print:px-2">
                    {pass.timeOut ? format(pass.timeOut.toMillis(), 'h:mm a') : '—'}
                  </DataTableCell>
                  <DataTableCell className="text-right print:hidden">
                    <Button variant="ghost" size="sm" onClick={() => setSelectedPass(pass)} icon={<Eye className="h-4 w-4" aria-hidden="true" />}>
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
              <PassDetail label="Issued" value={selectedPass.issuedAt ? format(selectedPass.issuedAt.toMillis(), 'PPp') : 'Not recorded'} />
              <PassDetail label="Time in" value={selectedPass.timeIn ? format(selectedPass.timeIn.toMillis(), 'PPp') : 'Not recorded'} />
              <PassDetail label="Time out" value={selectedPass.timeOut ? format(selectedPass.timeOut.toMillis(), 'PPp') : 'Not recorded'} />
            </dl>

            <div className="grid gap-5 sm:grid-cols-2">
              <VerificationImage title="Visitor photo" publicId={selectedPass.photoPublicId} />
              <VerificationImage title="Valid ID" publicId={selectedPass.idImagePublicId} emptyText="No ID image was required for this pass." />
            </div>
          </div>
        )}
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
