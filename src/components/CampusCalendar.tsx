import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Archive,
  Calendar as CalendarIcon,
  ChevronLeft,
  ChevronRight,
  Edit3,
  Plus,
  Trash2,
} from 'lucide-react';
import { toast } from 'sonner';
import {
  eachDayOfInterval,
  endOfMonth,
  endOfWeek,
  format,
  startOfWeek,
} from 'date-fns';
import { Button, Card, ConfirmModal, FormField, Input, LoadingState, Modal, Select } from '@/components/ui';
import { getAccessToken } from '@/services/auth';
import { getManilaDateParts } from '@/lib/manilaTime';
import { isDateInClosure, type CalendarClosureType, type CampusCalendarClosure } from '@/types';

export interface AdminCalendarClosureItem extends CampusCalendarClosure {
  overlaps?: Array<{
    id: string;
    title: string;
    closureType: string;
    startDate: string;
    endDate: string;
  }>;
}

interface CampusCalendarProps {
  canEdit: boolean;
}

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

function closureTypeLabel(type: CalendarClosureType): string {
  switch (type) {
    case 'campus_closure':
      return 'Campus Closure';
    case 'emergency_suspension':
      return 'Emergency Suspension';
    case 'holiday':
    default:
      return 'Official Holiday';
  }
}

function closureBadgeClasses(closure: AdminCalendarClosureItem): string {
  if (closure.archivedAt || closure.archived) {
    return 'bg-slate-100 text-slate-600 border-slate-300';
  }
  switch (closure.closureType) {
    case 'emergency_suspension':
      return 'bg-rose-100 text-rose-900 border-rose-300';
    case 'campus_closure':
      return 'bg-amber-100 text-amber-900 border-amber-300';
    case 'holiday':
    default:
      return 'bg-blue-100 text-blue-900 border-blue-300';
  }
}

export function CampusCalendar({ canEdit }: CampusCalendarProps) {
  const manilaNow = useMemo(() => getManilaDateParts(), []);
  const [viewYear, setViewYear] = useState<number>(manilaNow.year);
  const [viewMonth, setViewMonth] = useState<number>(manilaNow.month); // 1-12
  const [includeArchived, setIncludeArchived] = useState(false);

  const [closures, setClosures] = useState<AdminCalendarClosureItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Create / Edit modal state
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingClosure, setEditingClosure] = useState<AdminCalendarClosureItem | null>(null);
  const [formTitle, setFormTitle] = useState('');
  const [formType, setFormType] = useState<CalendarClosureType>('holiday');
  const [formStartDate, setFormStartDate] = useState('');
  const [formEndDate, setFormEndDate] = useState('');
  const [formDescription, setFormDescription] = useState('');
  const [formPublished, setFormPublished] = useState(true);
  const [formActive, setFormActive] = useState(true);
  const [saving, setSaving] = useState(false);

  const [archivingClosure, setArchivingClosure] = useState<AdminCalendarClosureItem | null>(null);
  const [deletingClosure, setDeletingClosure] = useState<AdminCalendarClosureItem | null>(null);
  const [mutatingId, setMutatingId] = useState<string | null>(null);

  const loadClosures = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const token = await getAccessToken();
      const query = includeArchived ? '?includeArchived=true' : '';
      const res = await fetch(`/api/admin/calendar${query}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      const data = (await res.json().catch(() => ({}))) as {
        closures?: AdminCalendarClosureItem[];
        error?: string;
        message?: string;
      };
      if (!res.ok) {
        throw new Error(data.message || data.error || `Failed to load calendar (${res.status})`);
      }
      setClosures(Array.isArray(data.closures) ? data.closures : []);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unable to load campus calendar.';
      setLoadError(msg);
      toast.error(msg);
    } finally {
      setLoading(false);
    }
  }, [includeArchived]);

  useEffect(() => {
    void loadClosures();
  }, [loadClosures]);

  const calendarDays = useMemo(() => {
    const first = new Date(viewYear, viewMonth - 1, 1, 12, 0, 0);
    const last = endOfMonth(first);
    return eachDayOfInterval({
      start: startOfWeek(first),
      end: endOfWeek(last),
    });
  }, [viewMonth, viewYear]);

  const visibleOverlaps = useMemo(() => {
    if (!formStartDate) return [];
    const end = formEndDate || formStartDate;
    return closures.filter(
      (c) =>
        c.id !== editingClosure?.id &&
        !c.archivedAt &&
        !c.archived &&
        c.active &&
        c.startDate <= end &&
        c.endDate >= formStartDate,
    );
  }, [closures, editingClosure?.id, formEndDate, formStartDate]);

  function openCreateModal(prefillDate?: string) {
    if (!canEdit) return;
    setEditingClosure(null);
    setFormTitle('');
    setFormType('holiday');
    setFormStartDate(prefillDate || manilaNow.dateString);
    setFormEndDate(prefillDate || manilaNow.dateString);
    setFormDescription('');
    setFormPublished(true);
    setFormActive(true);
    setEditorOpen(true);
  }

  function openEditModal(closure: AdminCalendarClosureItem) {
    if (!canEdit) return;
    setEditingClosure(closure);
    setFormTitle(closure.title);
    setFormType(closure.closureType);
    setFormStartDate(closure.startDate);
    setFormEndDate(closure.endDate);
    setFormDescription(closure.description || '');
    setFormPublished(closure.published);
    setFormActive(closure.active);
    setEditorOpen(true);
  }

  function shiftMonth(delta: number) {
    const d = new Date(viewYear, viewMonth - 1 + delta, 1, 12, 0, 0);
    setViewYear(d.getFullYear());
    setViewMonth(d.getMonth() + 1);
  }

  async function handleSaveClosure() {
    if (!formTitle.trim() || formTitle.trim().length < 2) {
      toast.error('Please enter a closure title (at least 2 characters).');
      return;
    }
    if (!formStartDate) {
      toast.error('Please choose a start date.');
      return;
    }
    const effectiveEnd = formEndDate || formStartDate;
    if (effectiveEnd < formStartDate) {
      toast.error('End date cannot be earlier than start date.');
      return;
    }

    setSaving(true);
    try {
      const token = await getAccessToken();
      const method = editingClosure ? 'PATCH' : 'POST';
      const bodyPayload = editingClosure
        ? {
            id: editingClosure.id,
            title: formTitle.trim(),
            closureType: formType,
            startDate: formStartDate,
            endDate: effectiveEnd,
            description: formDescription.trim() || null,
            active: formActive,
            published: formPublished,
          }
        : {
            title: formTitle.trim(),
            closureType: formType,
            startDate: formStartDate,
            endDate: effectiveEnd,
            description: formDescription.trim() || undefined,
            active: formActive,
            published: formPublished,
          };

      const res = await fetch('/api/admin/calendar', {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(bodyPayload),
      });
      const data = (await res.json().catch(() => ({}))) as {
        message?: string;
        error?: string;
        overlaps?: Array<{ title: string }>;
      };
      if (!res.ok) {
        throw new Error(data.message || data.error || `Save failed (${res.status})`);
      }

      if (Array.isArray(data.overlaps) && data.overlaps.length > 0) {
        toast.warning(
          `Closure saved, overlapping with ${data.overlaps.map((o) => o.title).join(', ')}.`,
        );
      } else {
        toast.success(editingClosure ? 'Campus closure updated.' : 'Campus closure added.');
      }

      setEditorOpen(false);
      await loadClosures();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save closure.');
    } finally {
      setSaving(false);
    }
  }

  async function handleQuickToggle(closure: AdminCalendarClosureItem, field: 'active' | 'published') {
    setMutatingId(closure.id);
    try {
      const token = await getAccessToken();
      const res = await fetch('/api/admin/calendar', {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          id: closure.id,
          [field]: !closure[field],
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
      if (!res.ok) {
        throw new Error(data.message || data.error || 'Failed to update closure');
      }
      toast.success(
        field === 'active'
          ? `Closure ${!closure.active ? 'activated' : 'deactivated'}.`
          : `Closure ${!closure.published ? 'published publicly' : 'moved to draft/hidden'}.`,
      );
      await loadClosures();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to update closure.');
    } finally {
      setMutatingId(null);
    }
  }

  async function handleArchiveClosure(closure: AdminCalendarClosureItem) {
    setMutatingId(closure.id);
    try {
      const token = await getAccessToken();
      const res = await fetch('/api/admin/calendar', {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          id: closure.id,
          archive: true,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
      if (!res.ok) {
        throw new Error(data.message || data.error || 'Failed to archive closure');
      }
      toast.success('Campus closure archived.');
      setArchivingClosure(null);
      await loadClosures();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to archive closure.');
    } finally {
      setMutatingId(null);
    }
  }

  async function handleDeleteDraft(closure: AdminCalendarClosureItem) {
    setMutatingId(closure.id);
    try {
      const token = await getAccessToken();
      const res = await fetch('/api/admin/calendar', {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ id: closure.id }),
      });
      const data = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
      if (!res.ok) {
        throw new Error(data.message || data.error || 'Failed to delete draft closure');
      }
      toast.success('Draft closure deleted.');
      setDeletingClosure(null);
      await loadClosures();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to delete closure.');
    } finally {
      setMutatingId(null);
    }
  }

  const yearOptions = useMemo(() => {
    const base = manilaNow.year;
    return [base - 1, base, base + 1, base + 2, base + 3];
  }, [manilaNow.year]);

  const monthTitle = `${MONTH_NAMES[viewMonth - 1] ?? ''} ${viewYear}`;

  return (
    <div className="space-y-6">
      <Card className="p-6">
        <div className="flex flex-col gap-4 border-b border-[var(--color-border)] pb-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-xl font-bold text-[var(--color-text-primary)]">
              Institutional Campus Calendar
            </h2>
            <p className="mt-1 text-xs text-[var(--color-text-secondary)]">
              Plan future academic holidays, campus closures, and emergency suspensions. Visitors cannot book new passes during active closures. Published/active closures are archived rather than hard-deleted.
            </p>
          </div>
          {canEdit && (
            <Button
              type="button"
              onClick={() => openCreateModal()}
              icon={<Plus className="h-4 w-4" />}
              size="sm"
            >
              Add Campus Closure
            </Button>
          )}
        </div>

        {/* Month / Year Controls */}
        <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => shiftMonth(-1)}
              aria-label="Previous month"
              icon={<ChevronLeft className="h-4 w-4" />}
            >
              Prev
            </Button>

            <Select
              aria-label="Calendar month"
              value={viewMonth}
              onChange={(e) => setViewMonth(Number(e.target.value))}
              className="w-36"
            >
              {MONTH_NAMES.map((name, idx) => (
                <option key={name} value={idx + 1}>
                  {name}
                </option>
              ))}
            </Select>

            <Select
              aria-label="Calendar year"
              value={viewYear}
              onChange={(e) => setViewYear(Number(e.target.value))}
              className="w-24"
            >
              {yearOptions.map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
            </Select>

            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => shiftMonth(1)}
              aria-label="Next month"
              icon={<ChevronRight className="h-4 w-4" />}
            >
              Next
            </Button>

            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                setViewYear(manilaNow.year);
                setViewMonth(manilaNow.month);
              }}
            >
              Today
            </Button>
          </div>

          <label className="inline-flex cursor-pointer items-center gap-2 text-xs font-medium text-[var(--color-text-secondary)]">
            <input
              type="checkbox"
              checked={includeArchived}
              onChange={(e) => setIncludeArchived(e.target.checked)}
              className="h-4 w-4 rounded border-[var(--color-border-strong)]"
            />
            <span>Show archived closures</span>
          </label>
        </div>

        {/* Legend */}
        <div className="mt-4 flex flex-wrap items-center gap-3 text-[11px] font-medium">
          <span className="inline-flex items-center gap-1.5 rounded border border-blue-300 bg-blue-100 px-2 py-0.5 text-blue-900">
            Official Holiday
          </span>
          <span className="inline-flex items-center gap-1.5 rounded border border-amber-300 bg-amber-100 px-2 py-0.5 text-amber-900">
            Campus Closure
          </span>
          <span className="inline-flex items-center gap-1.5 rounded border border-rose-300 bg-rose-100 px-2 py-0.5 text-rose-900">
            Emergency Suspension
          </span>
        </div>

        {loading ? (
          <LoadingState label="Loading campus calendar..." className="py-12" />
        ) : loadError ? (
          <div className="mt-4 rounded-xl border border-[var(--color-danger)] bg-[var(--color-danger-light)] p-4 text-xs text-[var(--color-danger-dark)]">
            {loadError}
          </div>
        ) : (
          <>
            {/* Interactive Month Grid */}
            <div
              className="mt-4 grid grid-cols-7 gap-1"
              role="grid"
              aria-label={`Campus closure calendar for ${monthTitle}`}
            >
              {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => (
                <div
                  key={d}
                  role="columnheader"
                  className="py-1 text-center text-[11px] font-bold uppercase tracking-wide text-[var(--color-text-muted)]"
                >
                  {d}
                </div>
              ))}

              {calendarDays.map((day) => {
                const y = day.getFullYear();
                const m = day.getMonth() + 1;
                const d = day.getDate();
                const dateStr = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
                const inMonth = y === viewYear && m === viewMonth;
                const isToday = dateStr === manilaNow.dateString;

                const dayClosures = closures.filter((c) => {
                  const isArchived = Boolean(c.archivedAt || c.archived);
                  if (!includeArchived && isArchived) return false;
                  return dateStr >= c.startDate && dateStr <= c.endDate;
                });

                const activeForDay = dayClosures.some((c) => isDateInClosure(dateStr, c) && !c.archivedAt);

                return (
                  <div
                    key={dateStr}
                    role="gridcell"
                    aria-label={`${format(day, 'MMMM d, yyyy')}${dayClosures.length ? `, ${dayClosures.length} closure(s)` : ''}`}
                    className={`flex min-h-24 flex-col rounded-lg border p-1.5 transition-colors ${
                      inMonth
                        ? 'border-[var(--color-border)] bg-white'
                        : 'border-transparent bg-[var(--color-canvas)] opacity-60'
                    } ${isToday ? 'ring-2 ring-[var(--color-brand)] ring-offset-1' : ''} ${
                      activeForDay ? 'bg-amber-50/40' : ''
                    }`}
                  >
                    <div className="flex items-center justify-between gap-1">
                      <span
                        className={`text-xs font-bold ${
                          inMonth ? 'text-[var(--color-text-primary)]' : 'text-[var(--color-text-muted)]'
                        }`}
                      >
                        {d}
                      </span>
                      {canEdit && inMonth && (
                        <button
                          type="button"
                          onClick={() => openCreateModal(dateStr)}
                          title={`Schedule closure on ${dateStr}`}
                          className="rounded p-0.5 text-[10px] text-[var(--color-text-muted)] hover:bg-[var(--color-brand-light)] hover:text-[var(--color-brand)]"
                        >
                          <Plus className="h-3 w-3" aria-hidden="true" />
                        </button>
                      )}
                    </div>

                    <div className="mt-1 space-y-1 overflow-y-auto">
                      {dayClosures.slice(0, 3).map((c) => (
                        <button
                          key={c.id}
                          type="button"
                          onClick={() => (canEdit ? openEditModal(c) : undefined)}
                          className={`block w-full truncate rounded border px-1 py-0.5 text-left text-[10px] font-semibold ${closureBadgeClasses(c)}`}
                          title={`${c.title} (${closureTypeLabel(c.closureType)})${c.published ? '' : ' [Draft]'}`}
                        >
                          {c.published ? '' : '[Draft] '}
                          {c.title}
                        </button>
                      ))}
                      {dayClosures.length > 3 && (
                        <span className="block px-1 text-[10px] font-medium text-[var(--color-text-muted)]">
                          +{dayClosures.length - 3} more
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Structured Closure Management List */}
            <div className="mt-6">
              <h3 className="mb-3 text-sm font-bold text-[var(--color-text-primary)]">
                Scheduled Closures ({closures.length})
              </h3>
              {closures.length === 0 ? (
                <div className="rounded-xl border border-dashed border-[var(--color-border-strong)] py-10 text-center text-xs text-[var(--color-text-muted)]">
                  <CalendarIcon className="mx-auto mb-2 h-8 w-8 opacity-40" aria-hidden="true" />
                  <p>No campus calendar closures recorded yet.</p>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs">
                    <thead>
                      <tr className="border-b border-[var(--color-border)] font-semibold uppercase tracking-wider text-[var(--color-text-secondary)]">
                        <th className="px-3 py-2.5">Date Range</th>
                        <th className="px-3 py-2.5">Title &amp; Warnings</th>
                        <th className="px-3 py-2.5">Type</th>
                        <th className="px-3 py-2.5">Lifecycle</th>
                        {canEdit && <th className="px-3 py-2.5 text-right">Actions</th>}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[var(--color-border)]">
                      {closures.map((c) => {
                        const isArchived = Boolean(c.archivedAt || c.archived);
                        const canHardDelete = !c.published && !c.active && !isArchived;
                        const isBusy = mutatingId === c.id;
                        return (
                          <tr key={c.id} className="hover:bg-[var(--color-canvas)]">
                            <td className="whitespace-nowrap px-3 py-3 font-bold text-[var(--color-text-primary)]">
                              {c.startDate === c.endDate ? c.startDate : `${c.startDate} → ${c.endDate}`}
                            </td>
                            <td className="px-3 py-3">
                              <div className="font-semibold text-[var(--color-text-primary)]">{c.title}</div>
                              {c.description && (
                                <p className="mt-0.5 text-[11px] text-[var(--color-text-secondary)]">{c.description}</p>
                              )}
                              {c.overlaps && c.overlaps.length > 0 && (
                                <p className="mt-1 inline-flex items-center gap-1 rounded bg-amber-50 px-1.5 py-0.5 text-[10px] font-semibold text-amber-800 border border-amber-200">
                                  <AlertTriangle className="h-3 w-3 shrink-0" aria-hidden="true" />
                                  Overlaps with: {c.overlaps.map((o) => o.title).join(', ')}
                                </p>
                              )}
                            </td>
                            <td className="px-3 py-3">
                              <span
                                className={`inline-block rounded border px-2 py-0.5 text-[10px] font-bold uppercase ${closureBadgeClasses(c)}`}
                              >
                                {closureTypeLabel(c.closureType)}
                              </span>
                            </td>
                            <td className="px-3 py-3">
                              <div className="flex flex-wrap items-center gap-1.5">
                                {isArchived ? (
                                  <span className="rounded bg-slate-200 px-1.5 py-0.5 text-[10px] font-bold text-slate-700">
                                    Archived
                                  </span>
                                ) : (
                                  <>
                                    <span
                                      className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${
                                        c.active ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-600'
                                      }`}
                                    >
                                      {c.active ? 'Active' : 'Inactive'}
                                    </span>
                                    <span
                                      className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${
                                        c.published ? 'bg-blue-50 text-blue-700' : 'bg-amber-50 text-amber-800'
                                      }`}
                                    >
                                      {c.published ? 'Published' : 'Draft'}
                                    </span>
                                  </>
                                )}
                              </div>
                            </td>
                            {canEdit && (
                              <td className="whitespace-nowrap px-3 py-3 text-right">
                                <div className="inline-flex flex-wrap items-center justify-end gap-2">
                                  {!isArchived && (
                                    <>
                                      <button
                                        type="button"
                                        disabled={isBusy}
                                        onClick={() => openEditModal(c)}
                                        className="inline-flex items-center gap-1 text-[11px] font-semibold text-[var(--color-brand)] hover:underline disabled:opacity-50"
                                      >
                                        <Edit3 className="h-3 w-3" aria-hidden="true" />
                                        Edit
                                      </button>
                                      <button
                                        type="button"
                                        disabled={isBusy}
                                        onClick={() => void handleQuickToggle(c, 'published')}
                                        className="text-[11px] font-medium text-slate-700 hover:underline disabled:opacity-50"
                                      >
                                        {c.published ? 'Unpublish' : 'Publish'}
                                      </button>
                                      <button
                                        type="button"
                                        disabled={isBusy}
                                        onClick={() => void handleQuickToggle(c, 'active')}
                                        className="text-[11px] font-medium text-slate-700 hover:underline disabled:opacity-50"
                                      >
                                        {c.active ? 'Deactivate' : 'Activate'}
                                      </button>
                                      <button
                                        type="button"
                                        disabled={isBusy}
                                        onClick={() => setArchivingClosure(c)}
                                        className="inline-flex items-center gap-1 text-[11px] font-semibold text-amber-800 hover:underline disabled:opacity-50"
                                      >
                                        <Archive className="h-3 w-3" aria-hidden="true" />
                                        Archive
                                      </button>
                                    </>
                                  )}
                                  {canHardDelete && (
                                    <button
                                      type="button"
                                      disabled={isBusy}
                                      onClick={() => setDeletingClosure(c)}
                                      className="inline-flex items-center gap-1 text-[11px] font-semibold text-rose-700 hover:underline disabled:opacity-50"
                                      title="Delete inactive draft closure"
                                    >
                                      <Trash2 className="h-3 w-3" aria-hidden="true" />
                                      Delete Draft
                                    </button>
                                  )}
                                </div>
                              </td>
                            )}
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </>
        )}
      </Card>

      {/* Create / Edit Closure Modal */}
      <Modal
        isOpen={editorOpen}
        onClose={() => setEditorOpen(false)}
        title={editingClosure ? 'Edit Campus Closure' : 'Schedule Campus Closure'}
        size="sm"
        preventClose={saving}
      >
        <div className="space-y-4 text-xs">
          <div className="grid grid-cols-2 gap-3">
            <FormField label="Start Date" requirement="required" id="cc-start-date">
              <Input
                id="cc-start-date"
                type="date"
                value={formStartDate}
                onChange={(e) => {
                  const val = e.target.value;
                  setFormStartDate(val);
                  if (!formEndDate || formEndDate < val) {
                    setFormEndDate(val);
                  }
                }}
              />
            </FormField>

            <FormField label="End Date" requirement="required" id="cc-end-date">
              <Input
                id="cc-end-date"
                type="date"
                min={formStartDate || undefined}
                value={formEndDate}
                onChange={(e) => setFormEndDate(e.target.value)}
              />
            </FormField>
          </div>

          {visibleOverlaps.length > 0 && (
            <div
              role="status"
              className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 p-2.5 text-xs text-amber-900"
            >
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-700" aria-hidden="true" />
              <div>
                <p className="font-semibold">Date overlap detected</p>
                <p>
                  Overlaps with active closure(s): {visibleOverlaps.map((o) => o.title).join(', ')}.
                </p>
              </div>
            </div>
          )}

          <FormField label="Closure Title" requirement="required" id="cc-title">
            <Input
              id="cc-title"
              placeholder="e.g., Foundation Day / Typhoon Suspension"
              value={formTitle}
              onChange={(e) => setFormTitle(e.target.value)}
            />
          </FormField>

          <FormField label="Closure Type" requirement="required" id="cc-type">
            <Select
              id="cc-type"
              value={formType}
              onChange={(e) => setFormType(e.target.value as CalendarClosureType)}
            >
              <option value="holiday">Official Holiday</option>
              <option value="campus_closure">Campus Closure</option>
              <option value="emergency_suspension">Emergency Suspension</option>
            </Select>
          </FormField>

          <FormField label="Description / Advisory" id="cc-description">
            <Input
              id="cc-description"
              placeholder="Public advisory note shown when selecting dates"
              value={formDescription}
              onChange={(e) => setFormDescription(e.target.value)}
            />
          </FormField>

          <div className="flex flex-wrap gap-4 rounded-lg border border-[var(--color-border)] bg-[var(--color-canvas-subtle)] p-3">
            <label className="inline-flex cursor-pointer items-center gap-2 font-medium">
              <input
                type="checkbox"
                checked={formPublished}
                onChange={(e) => setFormPublished(e.target.checked)}
                className="h-4 w-4 rounded border-[var(--color-border-strong)]"
              />
              <span>Publish to visitor portal &amp; kiosk</span>
            </label>
            <label className="inline-flex cursor-pointer items-center gap-2 font-medium">
              <input
                type="checkbox"
                checked={formActive}
                onChange={(e) => setFormActive(e.target.checked)}
                className="h-4 w-4 rounded border-[var(--color-border-strong)]"
              />
              <span>Active (block bookings)</span>
            </label>
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={saving}
              onClick={() => setEditorOpen(false)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="primary"
              size="sm"
              loading={saving}
              onClick={() => void handleSaveClosure()}
            >
              {editingClosure ? 'Update Closure' : 'Save Closure'}
            </Button>
          </div>
        </div>
      </Modal>

      {/* Archive Confirmation Modal */}
      <ConfirmModal
        isOpen={!!archivingClosure}
        onClose={() => setArchivingClosure(null)}
        title="Archive Campus Closure?"
        description={
          archivingClosure ? (
            <>
              Archive <strong className="text-[var(--color-text-primary)]">{archivingClosure.title}</strong> ({archivingClosure.startDate} to {archivingClosure.endDate})? Archived records remain preserved in the institutional audit log and no longer block new bookings.
            </>
          ) : ''
        }
        onConfirm={() => {
          if (archivingClosure) void handleArchiveClosure(archivingClosure);
        }}
        confirmText="Archive Closure"
        loading={Boolean(archivingClosure && mutatingId === archivingClosure.id)}
      />

      {/* Delete Draft Modal */}
      <ConfirmModal
        isOpen={!!deletingClosure}
        onClose={() => setDeletingClosure(null)}
        title="Delete Draft Closure?"
        description={
          deletingClosure ? (
            <>
              Permanently delete inactive draft{' '}
              <strong className="text-[var(--color-text-primary)]">{deletingClosure.title}</strong>? Only inactive unpublished drafts may be deleted.
            </>
          ) : ''
        }
        onConfirm={() => {
          if (deletingClosure) void handleDeleteDraft(deletingClosure);
        }}
        confirmText="Delete Draft"
        isDestructive
        loading={Boolean(deletingClosure && mutatingId === deletingClosure.id)}
      />
    </div>
  );
}
