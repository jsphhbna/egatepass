import { useState } from 'react';
import { format } from 'date-fns';
import { ClipboardList, Download, ShieldCheck } from 'lucide-react';
import { collection, getDocs, limit, orderBy, query, startAfter, where, Timestamp, type DocumentData, type QueryConstraint, type QueryDocumentSnapshot } from 'firebase/firestore';
import { toast } from 'sonner';
import { Button, DataTable, DataTableHead, DataTableRow, DataTableCell, Input, Select } from '@/components/ui';
import { useAuth } from '@/hooks/useAuth';
import { isSuperAdmin } from '@/lib/permissions';
import { db } from '@/lib/firebase';
import { collectCursorPages, downloadCsvFile, EXPORT_MAX_ROWS } from '@/lib/completeExport';
import {
  normalizeAdministrativeAudit,
  useAdministrativeAudit,
  useReconciliationItems,
  useVisitorActivity,
  type AdministrativeAuditItem,
  type VisitorActivityItem,
} from '@/hooks/useAuditActivity';

type AuditTab = 'visitor' | 'administrative' | 'reconciliation';

function LoadingRow({ label, columns }: { label: string; columns: number }) {
  return (
    <tr>
      <td colSpan={columns} className="py-12 text-center">
        <div className="mx-auto h-8 w-8 animate-spin rounded-full border-4 border-[var(--color-border)] border-t-[var(--color-brand)]" role="status" aria-label={label} />
      </td>
    </tr>
  );
}

function EmptyRow({ message, columns }: { message: string; columns: number }) {
  return <tr><td colSpan={columns} className="py-8 text-center text-[var(--color-text-muted)]">{message}</td></tr>;
}

function describeChange(log: AdministrativeAuditItem): string {
  const changes: string[] = [];
  if (log.previousRole !== undefined || log.newRole !== undefined) changes.push(`${log.previousRole ?? 'none'} → ${log.newRole ?? 'none'}`);
  if (log.previousStatus !== undefined || log.newStatus !== undefined) changes.push(`${String(log.previousStatus ?? 'none')} → ${String(log.newStatus ?? 'none')}`);
  if (Array.isArray(log.metadata?.changedFields)) changes.push(`Fields: ${log.metadata.changedFields.join(', ')}`);
  if (typeof log.metadata?.safeSummary === 'string') changes.push(log.metadata.safeSummary);
  return changes.join(' · ') || '—';
}

export function AdminAuditLogs() {
  const { role } = useAuth();
  const canViewReconciliation = isSuperAdmin(role);
  const [tab, setTab] = useState<AuditTab>('visitor');
  const [visitorEvent, setVisitorEvent] = useState('');
  const [administrativeRole, setAdministrativeRole] = useState('');
  const [administrativeAction, setAdministrativeAction] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [exporting, setExporting] = useState(false);
  const visitor = useVisitorActivity(tab === 'visitor');
  const administrative = useAdministrativeAudit(tab === 'administrative');
  const reconciliation = useReconciliationItems(canViewReconciliation);

  const tabs: Array<{ id: AuditTab; label: string }> = [
    { id: 'visitor', label: 'Visitor / Gate Activity' },
    { id: 'administrative', label: 'Administrative / System Activity' },
    ...(canViewReconciliation ? [{ id: 'reconciliation' as const, label: `Reconciliation (${reconciliation.data.length})` }] : []),
  ];
  const visibleVisitor = visitor.data.filter((item) => !visitorEvent || item.event === visitorEvent);
  const actionSearch = administrativeAction.trim().toLocaleLowerCase();
  const visibleAdministrative = administrative.data.filter((item) =>
    (!administrativeRole || item.actorRole === administrativeRole)
    && (!actionSearch || item.action.toLocaleLowerCase().includes(actionSearch)));

  async function exportActivity() {
    if (tab === 'reconciliation') return;
    setExporting(true);
    try {
      const collectionName = tab === 'visitor' ? 'visitLogs' : 'auditLogs';
      const result = await collectCursorPages<Record<string, unknown>, QueryDocumentSnapshot<DocumentData>>(
        async (cursor, pageSize) => {
          const constraints: QueryConstraint[] = [orderBy('timestamp', 'desc')];
          if (dateFrom) constraints.push(where('timestamp', '>=', Timestamp.fromDate(new Date(`${dateFrom}T00:00:00+08:00`))));
          if (dateTo) constraints.push(where('timestamp', '<', Timestamp.fromDate(new Date(new Date(`${dateTo}T00:00:00+08:00`).getTime() + 86_400_000))));
          if (cursor) constraints.push(startAfter(cursor));
          constraints.push(limit(pageSize));
          const snapshot = await getDocs(query(collection(db, collectionName), ...constraints));
          return {
            items: snapshot.docs.map((document) => ({ id: document.id, document })),
            nextCursor: snapshot.docs[snapshot.docs.length - 1] || null,
          };
        },
      );

      if (tab === 'visitor') {
        const items = result.items
          .map(({ document }) => {
            const snapshot = document as QueryDocumentSnapshot<DocumentData>;
            return { id: snapshot.id, ...snapshot.data() } as VisitorActivityItem;
          })
          .filter((item) => !visitorEvent || item.event === visitorEvent);
        downloadCsvFile(`visitor_activity_${format(new Date(), 'yyyyMMdd_HHmmss')}.csv`, [
          ['Time', 'Event', 'Gate', 'Guard UID', 'Device UID', 'Visitor UID', 'Reason'],
          ...items.map((item) => [
            item.timestamp ? format(item.timestamp.toMillis(), 'yyyy-MM-dd HH:mm:ss') : '',
            item.event,
            item.gate || '',
            item.guardUid || '',
            item.deviceId || '',
            item.visitorId || '',
            item.reason || '',
          ]),
        ]);
        toast.success(`Exported ${items.length.toLocaleString()} visitor activity record${items.length === 1 ? '' : 's'}.`);
      } else {
        const items = result.items
          .map(({ document }) => normalizeAdministrativeAudit(document as QueryDocumentSnapshot<DocumentData>))
          .filter((item) => (!administrativeRole || item.actorRole === administrativeRole)
            && (!actionSearch || item.action.toLocaleLowerCase().includes(actionSearch)));
        downloadCsvFile(`administrative_activity_${format(new Date(), 'yyyyMMdd_HHmmss')}.csv`, [
          ['Time', 'Action', 'Actor UID', 'Actor role', 'Target type', 'Target ID', 'Previous role', 'New role', 'Previous status', 'New status', 'Result'],
          ...items.map((item) => [
            item.timestamp ? format(item.timestamp.toMillis(), 'yyyy-MM-dd HH:mm:ss') : '',
            item.action,
            item.actorUid,
            item.actorRole,
            item.targetType,
            item.targetId,
            item.previousRole ?? '',
            item.newRole ?? '',
            item.previousStatus ?? '',
            item.newStatus ?? '',
            item.result,
          ]),
        ]);
        toast.success(`Exported ${items.length.toLocaleString()} administrative record${items.length === 1 ? '' : 's'}.`);
      }
      if (result.truncated) {
        toast.warning(`Export reached the ${EXPORT_MAX_ROWS.toLocaleString()} record safety limit. Narrow the filters for a complete file.`);
      }
    } catch (error) {
      console.error(error);
      toast.error('The complete filtered activity export could not be generated');
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <div className="flex items-center gap-2">
          <ClipboardList className="h-6 w-6 text-[var(--color-brand)]" />
          <h1 className="text-2xl font-bold text-[var(--color-text-primary)]">Audit and Activity</h1>
        </div>
        <p className="mt-1 text-sm text-[var(--color-text-secondary)]">Read-only visitor operations and privileged administrative events</p>
      </div>

      <div className="flex flex-wrap gap-2" role="tablist" aria-label="Audit log type">
        {tabs.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            onClick={() => setTab(item.id)}
            className={`rounded-lg border px-4 py-2 text-sm font-semibold transition-colors ${tab === item.id
              ? 'border-[var(--color-brand)] bg-[var(--color-brand)] text-white'
              : 'border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]'}`}
          >
            {item.label}
          </button>
        ))}
      </div>

      {tab !== 'reconciliation' && (
        <div className="flex flex-wrap items-end gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
          {tab === 'visitor' ? (
            <div className="w-full sm:w-56">
              <label className="mb-1.5 block text-xs font-semibold text-[var(--color-text-secondary)]">Event type</label>
              <Select aria-label="Event type" value={visitorEvent} onChange={(event) => setVisitorEvent(event.target.value)}>
                <option value="">All events</option>
                <option value="scan_entry">Entry scan</option><option value="scan_exit">Exit scan</option>
                <option value="invalid_scan">Invalid scan</option><option value="approved">Approved</option><option value="rejected">Rejected</option>
              </Select>
            </div>
          ) : (
            <>
              <div className="w-full sm:w-56">
                <label className="mb-1.5 block text-xs font-semibold text-[var(--color-text-secondary)]">Actor role</label>
                <Select aria-label="Actor role" value={administrativeRole} onChange={(event) => setAdministrativeRole(event.target.value)}>
                  <option value="">All roles</option><option value="admin">Admin</option><option value="superadmin">Super Admin</option><option value="system">System</option>
                </Select>
              </div>
              <div className="min-w-0 flex-1 sm:min-w-64">
                <label className="mb-1.5 block text-xs font-semibold text-[var(--color-text-secondary)]">Action contains</label>
                <Input aria-label="Action contains" value={administrativeAction} onChange={(event) => setAdministrativeAction(event.target.value)} placeholder="e.g. device, settings" />
              </div>
            </>
          )}
          <div className="w-full sm:w-44"><label className="mb-1.5 block text-xs font-semibold text-[var(--color-text-secondary)]">From</label><Input type="date" value={dateFrom} onChange={(event) => setDateFrom(event.target.value)} /></div>
          <div className="w-full sm:w-44"><label className="mb-1.5 block text-xs font-semibold text-[var(--color-text-secondary)]">To</label><Input type="date" value={dateTo} onChange={(event) => setDateTo(event.target.value)} /></div>
          <Button className="sm:ml-auto" variant="secondary" loading={exporting} disabled={exporting} icon={<Download className="h-4 w-4" />} onClick={() => void exportActivity()}>
            {exporting ? 'Exporting...' : 'Export complete filtered CSV'}
          </Button>
        </div>
      )}

      {tab === 'visitor' && (
        <>
          <DataTable>
          <DataTableHead><DataTableRow>
            <DataTableCell isHeader>Time</DataTableCell><DataTableCell isHeader>Event</DataTableCell>
            <DataTableCell isHeader>Location / Actor</DataTableCell><DataTableCell isHeader>Visitor / Pass</DataTableCell>
            <DataTableCell isHeader>Details</DataTableCell>
          </DataTableRow></DataTableHead>
          <tbody className="divide-y border-[var(--color-border)] font-mono text-xs">
            {visitor.loading ? <LoadingRow label="Loading visitor activity" columns={5} />
              : visitor.error ? <EmptyRow message={visitor.error} columns={5} />
                : visibleVisitor.length === 0 ? <EmptyRow message="No visitor activity found." columns={5} />
                  : visibleVisitor.map((log) => <DataTableRow key={log.id}>
                    <DataTableCell className="whitespace-nowrap">{log.timestamp ? format(log.timestamp.toMillis(), 'yyyy-MM-dd HH:mm:ss') : '—'}</DataTableCell>
                    <DataTableCell className="font-semibold text-[var(--color-brand)]">{log.event.toUpperCase()}</DataTableCell>
                    <DataTableCell>{log.gate && <div>Gate: {log.gate}</div>}{log.guardName && <div>Guard: {log.guardName}</div>}{log.deviceId && <div>Device: {log.deviceId.slice(0, 8)}…</div>}</DataTableCell>
                    <DataTableCell><div className="font-semibold">{log.visitorName || 'Unknown visitor'}</div><div>Pass: {log.passToken?.slice(0, 8) || 'N/A'}…</div></DataTableCell>
                    <DataTableCell>{log.reason || '—'}</DataTableCell>
                  </DataTableRow>)}
          </tbody>
          </DataTable>
          {visitor.hasMore && <div className="mt-4 flex justify-center"><Button variant="secondary" loading={visitor.loadingMore} disabled={visitor.loadingMore} onClick={visitor.loadMore}>Load more activity</Button></div>}
        </>
      )}

      {tab === 'administrative' && (
        <>
          <DataTable>
          <DataTableHead><DataTableRow>
            <DataTableCell isHeader>Time</DataTableCell><DataTableCell isHeader>Action</DataTableCell>
            <DataTableCell isHeader>Actor</DataTableCell><DataTableCell isHeader>Target</DataTableCell>
            <DataTableCell isHeader>Result / Changes</DataTableCell>
          </DataTableRow></DataTableHead>
          <tbody className="divide-y border-[var(--color-border)] font-mono text-xs">
            {administrative.loading ? <LoadingRow label="Loading administrative activity" columns={5} />
              : administrative.error ? <EmptyRow message={administrative.error} columns={5} />
                : visibleAdministrative.length === 0 ? <EmptyRow message="No administrative activity found." columns={5} />
                  : visibleAdministrative.map((log) => <DataTableRow key={log.id}>
                    <DataTableCell className="whitespace-nowrap">{log.timestamp ? format(log.timestamp.toMillis(), 'yyyy-MM-dd HH:mm:ss') : '—'}</DataTableCell>
                    <DataTableCell className="font-semibold text-[var(--color-brand)]">{log.action.replace(/_/g, ' ')}</DataTableCell>
                    <DataTableCell>{log.actorRole}<div title={log.actorUid}>{log.actorUid.slice(0, 8)}…</div></DataTableCell>
                    <DataTableCell>{log.targetType}: <span title={log.targetId}>{log.targetId.slice(0, 12)}{log.targetId.length > 12 ? '…' : ''}</span></DataTableCell>
                    <DataTableCell><div className="font-semibold">{log.result}</div><div className="text-[var(--color-text-secondary)]">{describeChange(log)}</div></DataTableCell>
                  </DataTableRow>)}
          </tbody>
          </DataTable>
          {administrative.hasMore && <div className="mt-4 flex justify-center"><Button variant="secondary" loading={administrative.loadingMore} disabled={administrative.loadingMore} onClick={administrative.loadMore}>Load more audit events</Button></div>}
        </>
      )}

      {tab === 'reconciliation' && canViewReconciliation && (
        <div className="space-y-3">
          <div className="flex items-start gap-3 rounded-lg border border-[var(--color-warning)]/40 bg-[var(--color-warning-light)] p-4">
            <ShieldCheck className="mt-0.5 h-5 w-5 text-[var(--color-warning-dark)]" />
            <div><p className="font-semibold text-[var(--color-text-primary)]">Manual investigation required</p><p className="text-sm text-[var(--color-text-secondary)]">These records are read-only. Confirm external and Firestore state before taking corrective action.</p></div>
          </div>
          <DataTable>
            <DataTableHead><DataTableRow>
              <DataTableCell isHeader>Created</DataTableCell><DataTableCell isHeader>Type</DataTableCell>
              <DataTableCell isHeader>Affected Resource</DataTableCell><DataTableCell isHeader>Status</DataTableCell>
              <DataTableCell isHeader>Safe Description</DataTableCell>
            </DataTableRow></DataTableHead>
            <tbody className="divide-y border-[var(--color-border)] text-xs">
              {reconciliation.loading ? <LoadingRow label="Loading reconciliation items" columns={5} />
                : reconciliation.error ? <EmptyRow message={reconciliation.error} columns={5} />
                  : reconciliation.data.length === 0 ? <EmptyRow message="No unresolved reconciliation items." columns={5} />
                    : reconciliation.data.map((item) => <DataTableRow key={item.id}>
                      <DataTableCell className="whitespace-nowrap">{item.createdAt ? format(new Date(item.createdAt), 'yyyy-MM-dd HH:mm:ss') : '—'}</DataTableCell>
                      <DataTableCell>{item.type.replace(/_/g, ' ')}</DataTableCell>
                      <DataTableCell>{item.targetType}: <span title={item.targetId}>{item.targetId.slice(0, 12)}…</span></DataTableCell>
                      <DataTableCell className="font-semibold text-[var(--color-warning-dark)]">{item.status}</DataTableCell>
                      <DataTableCell><div>{item.summary}</div>{item.requiredActions.length > 0 && <div className="mt-1 text-[var(--color-text-muted)]">Next: {item.requiredActions[0]}</div>}</DataTableCell>
                    </DataTableRow>)}
            </tbody>
          </DataTable>
        </div>
      )}
    </div>
  );
}
