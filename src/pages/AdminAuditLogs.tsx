import { formatManilaDateTime, formatManilaIso, formatManilaFileTimestamp } from '@/lib/manilaTime';
import { useState, useEffect } from 'react';
import { ClipboardList, Download, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';
import { Button, DataTable, DataTableHead, DataTableRow, DataTableCell, Input, Select, Modal, Textarea, FormField } from '@/components/ui';
import { useAuth } from '@/hooks/useAuth';
import { isSuperAdmin } from '@/lib/permissions';
import { getAccessToken } from '@/services/auth';
import { asAppTimestamp } from '@/lib/timestamp';
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

  const [resolvingTaskId, setResolvingTaskId] = useState<string | null>(null);
  const [resolutionNote, setResolutionNote] = useState('');
  const [isResolving, setIsResolving] = useState(false);

  function handleOpenResolveModal(taskId: string) {
    setResolvingTaskId(taskId);
    setResolutionNote('');
  }

  async function handleConfirmResolve(event: React.FormEvent) {
    event.preventDefault();
    if (!resolvingTaskId) return;
    const note = resolutionNote.trim();
    if (!note) {
      toast.error('Resolution note is required');
      return;
    }

    setIsResolving(true);
    try {
      const token = await getAccessToken();
      const res = await fetch('/api/reconciliation-items', {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ taskId: resolvingTaskId, resolutionNote: note }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Failed to resolve reconciliation task');
      }
      toast.success('Reconciliation task marked as resolved.');
      setResolvingTaskId(null);
      setResolutionNote('');
      reconciliation.refresh();
    } catch (err: any) {
      toast.error(err.message || 'Failed to resolve task');
    } finally {
      setIsResolving(false);
    }
  }
  const [tab, setTab] = useState<AuditTab>('visitor');
  const [visitorEvent, setVisitorEvent] = useState('');
  const [administrativeRole, setAdministrativeRole] = useState('');
  const [administrativeAction, setAdministrativeAction] = useState('');
  const [debouncedAction, setDebouncedAction] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedAction(administrativeAction);
    }, 300);
    return () => clearTimeout(timer);
  }, [administrativeAction]);

  const visitor = useVisitorActivity(tab === 'visitor', {
    event: visitorEvent || undefined,
    dateFrom: dateFrom || undefined,
    dateTo: dateTo || undefined,
  });
  const administrative = useAdministrativeAudit(tab === 'administrative', {
    role: administrativeRole || undefined,
    action: debouncedAction.trim() || undefined,
    dateFrom: dateFrom || undefined,
    dateTo: dateTo || undefined,
  });
  const reconciliation = useReconciliationItems(canViewReconciliation);

  const tabs: Array<{ id: AuditTab; label: string }> = [
    { id: 'visitor', label: 'Visitor / Gate Activity' },
    { id: 'administrative', label: 'Administrative / System Activity' },
    ...(canViewReconciliation ? [{ id: 'reconciliation' as const, label: `Reconciliation (${reconciliation.total})` }] : []),
  ];
  const visibleVisitor = visitor.data;
  const actionSearch = administrativeAction.trim().toLocaleLowerCase();
  const visibleAdministrative = administrative.data;

  async function exportActivity() {
    if (tab === 'reconciliation') return;
    setExporting(true);
    try {
      const token = await getAccessToken();
      if (!token) throw new Error('Not authenticated');

      const result = await collectCursorPages<any, string>(
        async (cursor, pageSize) => {
          const params = new URLSearchParams({
            type: tab === 'visitor' ? 'visitor' : 'administrative',
            pageSize: String(pageSize),
          });
          if (dateFrom) params.set('dateFrom', dateFrom);
          if (dateTo) params.set('dateTo', dateTo);
          if (cursor) params.set('cursor', cursor);
          if (tab === 'visitor' && visitorEvent) params.set('event', visitorEvent);
          if (tab === 'administrative' && administrativeRole) params.set('role', administrativeRole);
          if (tab === 'administrative' && actionSearch) params.set('action', actionSearch);

          const res = await fetch(`/api/admin/activity?${params.toString()}`, {
            headers: { Authorization: `Bearer ${token}` },
          });
          if (!res.ok) throw new Error('Failed to fetch activity records');
          const data = await res.json();
          return {
            items: data.items || [],
            nextCursor: data.nextCursor || null,
          };
        },
      );

      if (tab === 'visitor') {
        const items = result.items
          .map((raw) => ({
            ...raw,
            timestamp: asAppTimestamp(raw.timestamp),
          }))
          .filter((item: VisitorActivityItem) => !visitorEvent || item.event === visitorEvent);
        downloadCsvFile(`visitor_activity_${formatManilaFileTimestamp(new Date())}.csv`, [
          ['Time', 'Event', 'Gate', 'Guard UID', 'Device UID', 'Visitor UID', 'Reason'],
          ...items.map((item: VisitorActivityItem) => [
            item.timestamp ? formatManilaIso(item.timestamp.toMillis()) : '',
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
          .map((raw) => normalizeAdministrativeAudit(raw))
          .filter((item) => (!administrativeRole || item.actorRole === administrativeRole)
            && (!actionSearch || item.action.toLocaleLowerCase().includes(actionSearch)));
        downloadCsvFile(`administrative_activity_${formatManilaFileTimestamp(new Date())}.csv`, [
          ['Time', 'Action', 'Actor UID', 'Actor role', 'Target type', 'Target ID', 'Previous role', 'New role', 'Previous status', 'New status', 'Result'],
          ...items.map((item) => [
            item.timestamp ? formatManilaIso(item.timestamp.toMillis()) : '',
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
                    <DataTableCell className="whitespace-nowrap">{log.timestamp ? formatManilaIso(log.timestamp.toMillis()) : '—'}</DataTableCell>
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
                    <DataTableCell className="whitespace-nowrap">{log.timestamp ? formatManilaIso(log.timestamp.toMillis()) : '—'}</DataTableCell>
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
            <div><p className="font-semibold text-[var(--color-text-primary)]">Manual investigation required</p><p className="text-sm text-[var(--color-text-secondary)]">These records are read-only. Confirm external and system state before taking corrective action.</p></div>
          </div>
          <DataTable>
            <DataTableHead><DataTableRow>
              <DataTableCell isHeader>Created</DataTableCell><DataTableCell isHeader>Type</DataTableCell>
              <DataTableCell isHeader>Affected Resource</DataTableCell><DataTableCell isHeader>Status</DataTableCell>
              <DataTableCell isHeader>Safe Description</DataTableCell>
              <DataTableCell isHeader>Action</DataTableCell>
            </DataTableRow></DataTableHead>
            <tbody className="divide-y border-[var(--color-border)] text-xs">
              {reconciliation.loading ? <LoadingRow label="Loading reconciliation items" columns={5} />
                : reconciliation.error ? <EmptyRow message={reconciliation.error} columns={5} />
                  : reconciliation.data.length === 0 ? <EmptyRow message="No unresolved reconciliation items." columns={5} />
                    : reconciliation.data.map((item) => <DataTableRow key={item.id}>
                      <DataTableCell className="whitespace-nowrap">{item.createdAt ? formatManilaDateTime(item.createdAt) : '—'}</DataTableCell>
                      <DataTableCell>{item.type.replace(/_/g, ' ')}</DataTableCell>
                      <DataTableCell>{item.targetType}: <span title={item.targetId}>{item.targetId.slice(0, 12)}…</span></DataTableCell>
                      <DataTableCell className="font-semibold text-[var(--color-warning-dark)]">{item.status}</DataTableCell>
                      <DataTableCell><div>{item.summary}</div>{item.requiredActions.length > 0 && <div className="mt-1 text-[var(--color-text-muted)]">Next: {item.requiredActions[0]}</div>}</DataTableCell>
                      <DataTableCell>
                        {(item.status === 'pending' || item.status === 'failed') && canViewReconciliation ? (
                          <Button size="sm" variant="secondary" onClick={() => handleOpenResolveModal(item.id)}>
                            Mark Resolved
                          </Button>
                        ) : (
                          <span className="text-[var(--color-text-muted)]">—</span>
                        )}
                      </DataTableCell>
                    </DataTableRow>)}
            </tbody>
          </DataTable>
          {reconciliation.hasMore && (
            <div className="mt-4 flex justify-center">
              <Button
                variant="secondary"
                loading={reconciliation.loadingMore}
                disabled={reconciliation.loadingMore}
                onClick={reconciliation.loadMore}
              >
                Load more reconciliation items ({reconciliation.data.length} of {reconciliation.total})
              </Button>
            </div>
          )}
        </div>
      )}
      <Modal
        isOpen={resolvingTaskId !== null}
        onClose={() => {
          if (!isResolving) {
            setResolvingTaskId(null);
            setResolutionNote('');
          }
        }}
        title="Resolve Reconciliation Item"
        size="md"
      >
        <form onSubmit={handleConfirmResolve} className="space-y-4">
          <p className="text-sm text-[var(--color-text-secondary)]">
            Provide an operational resolution note for this reconciliation discrepancy. The note will be recorded in the audit trail.
          </p>
          <FormField id="resolution-note" label="Resolution Note">
            <Textarea
              id="resolution-note"
              value={resolutionNote}
              onChange={(e) => setResolutionNote(e.target.value)}
              placeholder="Explain how this reconciliation discrepancy was reviewed or resolved…"
              required
              rows={3}
              autoFocus
            />
          </FormField>
          <div className="flex justify-end gap-3 pt-2">
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                setResolvingTaskId(null);
                setResolutionNote('');
              }}
              disabled={isResolving}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              variant="primary"
              loading={isResolving}
              disabled={!resolutionNote.trim()}
            >
              Mark Resolved
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}

