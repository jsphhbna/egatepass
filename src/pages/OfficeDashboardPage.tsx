import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { getAccessToken, signOutCurrentActor } from '@/services/auth';
import {
  Building2,
  CheckCircle2,
  Clock3,
  LogOut,
  Plus,
  RefreshCw,
  Search,
  User,
  UserCheck,
  XCircle,
  Users,
  Calendar,
  Mail,
  Phone,
  CalendarDays,
  Trash2,
} from 'lucide-react';
import { toast } from 'sonner';
import { BrandMark } from '@/components/BrandMark';
import { Button, Modal, Input } from '@/components/ui';
import { AuthenticatedImage } from '@/components/AuthenticatedImage';
import type { Office, OfficePersonnel, OfficeVisitRecord } from '@/types/office';

export function OfficeDashboardPage() {
  const navigate = useNavigate();

  const [offices, setOffices] = useState<Office[]>([]);
  const [selectedOfficeId, setSelectedOfficeId] = useState<string>('');
  const [pendingVisits, setPendingVisits] = useState<OfficeVisitRecord[]>([]);
  const [confirmationVisits, setConfirmationVisits] = useState<OfficeVisitRecord[]>([]);
  const [personnelList, setPersonnelList] = useState<OfficePersonnel[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [dateFilter, setDateFilter] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [mobileTab, setMobileTab] = useState<'pending' | 'confirmation'>('pending');

  // Queue Counts
  const [queueCounts, setQueueCounts] = useState<{
    pending: number;
    approved: number;
    awaiting_confirmation: number;
    confirmed: number;
    history: number;
  }>({
    pending: 0,
    approved: 0,
    awaiting_confirmation: 0,
    confirmed: 0,
    history: 0,
  });

  // Action Modals
  const [approveModalVisit, setApproveModalVisit] = useState<OfficeVisitRecord | null>(null);
  const [isApproving, setIsApproving] = useState(false);

  const [rejectModalVisit, setRejectModalVisit] = useState<OfficeVisitRecord | null>(null);
  const [rejectionReason, setRejectionReason] = useState('');
  const [isRejecting, setIsRejecting] = useState(false);

  const [confirmArrivalVisit, setConfirmArrivalVisit] = useState<OfficeVisitRecord | null>(null);
  const [isConfirmingArrival, setIsConfirmingArrival] = useState(false);

  // Personnel Modal
  const [isPersonnelModalOpen, setIsPersonnelModalOpen] = useState(false);
  const [newPersonnelName, setNewPersonnelName] = useState('');
  const [newPersonnelTitle, setNewPersonnelTitle] = useState('');
  const [isSavingPersonnel, setIsSavingPersonnel] = useState(false);
  const [togglingPersonnelId, setTogglingPersonnelId] = useState<string | null>(null);

  // Office Calendar Modal State
  const [isCalendarModalOpen, setIsCalendarModalOpen] = useState(false);
  const [officeSchedules, setOfficeSchedules] = useState<Array<{ id: string; schedule_date: string; status: string; reason?: string }>>([]);
  const [calendarYear, setCalendarYear] = useState<number>(new Date().getFullYear());
  const [calendarMonth, setCalendarMonth] = useState<number>(new Date().getMonth() + 1); // 1-12
  const [selectedDateForEdit, setSelectedDateForEdit] = useState<string | null>(null);
  const [scheduleStatus, setScheduleStatus] = useState<'open' | 'closed' | 'maintenance' | 'holiday'>('closed');
  const [scheduleReason, setScheduleReason] = useState<string>('');
  const [isSavingSchedule, setIsSavingSchedule] = useState(false);
  const [loadingSchedules, setLoadingSchedules] = useState(false);

  const [isSigningOut, setIsSigningOut] = useState(false);
  const [retryingEmailVisitId, setRetryingEmailVisitId] = useState<string | null>(null);
  const [noOfficeAssigned, setNoOfficeAssigned] = useState<boolean>(false);

  async function handleSignOut() {
    setIsSigningOut(true);
    try {
      await signOutCurrentActor();
      navigate('/login', { replace: true });
    } finally {
      setIsSigningOut(false);
    }
  }

  // Format Manila Time
  const formatManilaTime = useCallback((isoString?: string | null) => {
    if (!isoString) return '—';
    try {
      return new Intl.DateTimeFormat('en-PH', {
        timeZone: 'Asia/Manila',
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
      }).format(new Date(isoString));
    } catch {
      return isoString;
    }
  }, []);

  // Fetch Offices & Personnel Directory
  const loadOfficesAndPersonnel = useCallback(async () => {
    try {
      const token = await getAccessToken();
      const res = await fetch('/api/office/personnel', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error('Failed to load office data');
      const data = await res.json();
      if (data?.code === 'no_office_assigned_to_staff' || (Array.isArray(data?.offices) && data.offices.length === 0)) {
        setNoOfficeAssigned(true);
        setOffices([]);
        return;
      }
      setNoOfficeAssigned(false);
      const loadedOffices = data.offices || [];
      setOffices(loadedOffices);

      if (loadedOffices.length > 0 && !selectedOfficeId) {
        setSelectedOfficeId(loadedOffices[0].id);
      }
    } catch (err) {
      console.error('Error fetching offices:', err);
      toast.error('Unable to load assigned offices.');
    }
  }, [selectedOfficeId]);

  // Load Personnel for selected office
  const loadPersonnelForOffice = useCallback(async (officeId: string) => {
    if (!officeId) return;
    try {
      const token = await getAccessToken();
      const res = await fetch(`/api/office/personnel?officeId=${officeId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error('Failed to load personnel');
      const data = await res.json();
      setPersonnelList(data.personnel || []);
    } catch (err) {
      console.error('Error fetching personnel:', err);
    }
  }, []);

  // Fetch Visits for Both Queues
  const loadVisits = useCallback(async (showRefreshing = false) => {
    if (!selectedOfficeId) return;
    if (showRefreshing) setIsRefreshing(true);
    else setIsLoading(true);

    try {
      const token = await getAccessToken();
      const params = new URLSearchParams({
        officeId: selectedOfficeId,
        queue: 'split',
      });
      if (searchQuery.trim()) params.set('search', searchQuery.trim());
      if (dateFilter) params.set('date', dateFilter);

      const res = await fetch(`/api/office/visits?${params.toString()}`, {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (!res.ok) {
        throw new Error('Failed to fetch visits');
      }

      const data = await res.json();
      const allVisits = data.visits || [];

      // Separate into two authoritative queues
      const pending = data.pendingVisits || allVisits.filter(
        (v: OfficeVisitRecord) => v.approvalStatus === 'pending' && v.visitType === 'specific_person'
      );
      const confirmation = data.confirmationVisits || allVisits.filter(
        (v: OfficeVisitRecord) => v.attendanceStatus === 'awaiting_office_confirmation'
      );

      setPendingVisits(pending);
      setConfirmationVisits(confirmation);

      // Update Counts
      if (data.counts) {
        setQueueCounts({
          pending: data.counts.pending ?? 0,
          approved: data.counts.approved ?? 0,
          awaiting_confirmation: data.counts.awaiting_confirmation ?? 0,
          confirmed: data.counts.confirmed ?? 0,
          history: data.counts.history ?? 0,
        });
      }
    } catch (err) {
      console.error('Error loading visits:', err);
      toast.error('Unable to refresh visit records.');
    } finally {
      setIsLoading(false);
      setIsRefreshing(false);
    }
  }, [dateFilter, searchQuery, selectedOfficeId]);

  // Load Office Calendar Schedules
  const loadOfficeSchedules = useCallback(async () => {
    if (!selectedOfficeId) return;
    setLoadingSchedules(true);
    try {
      const res = await fetch(`/api/office/calendar?officeId=${encodeURIComponent(selectedOfficeId)}`);
      if (res.ok) {
        const data = await res.json();
        setOfficeSchedules(data.schedules || []);
      }
    } catch (err) {
      console.warn('Failed to load office calendar schedules:', err);
    } finally {
      setLoadingSchedules(false);
    }
  }, [selectedOfficeId]);

  useEffect(() => {
    loadOfficesAndPersonnel();
  }, [loadOfficesAndPersonnel]);

  useEffect(() => {
    if (selectedOfficeId) {
      loadPersonnelForOffice(selectedOfficeId);
      loadVisits();
      loadOfficeSchedules();
    }
  }, [selectedOfficeId, loadPersonnelForOffice, loadVisits, loadOfficeSchedules]);

  // Handle Approve Specific-Person Visit
  async function handleApproveVisit() {
    if (!approveModalVisit) return;
    setIsApproving(true);
    try {
      const token = await getAccessToken();
      const res = await fetch('/api/office/decide', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          visitId: approveModalVisit.id,
          decision: 'approved',
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.message || data.error || 'Failed to approve visit');
      }

      const emailStatus = data.emailDelivery?.status;
      if (emailStatus === 'sent') {
        toast.success('Visit approved. QR email submitted to the email provider.');
      } else if (emailStatus === 'delivered') {
        toast.success('Visit approved. Email provider confirms delivery.');
      } else if (emailStatus === 'failed') {
        toast.warning('Visit approved, but the email could not be sent. Staff attention is required.');
      } else if (emailStatus === 'unknown') {
        toast.warning('Visit approved. Email outcome is uncertain; reconciliation is required.');
      } else if (approveModalVisit.visitorEmail) {
        toast.info('Visit approved. Email delivery is pending dispatch.');
      } else {
        toast.success('Visit approved.');
      }
      setApproveModalVisit(null);
      loadVisits(true);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Approval failed.';
      toast.error(msg);
    } finally {
      setIsApproving(false);
    }
  }

  // Handle Reject Specific-Person Visit
  async function handleRejectVisit() {
    if (!rejectModalVisit) return;
    if (!rejectionReason.trim()) {
      toast.error('Please enter a rejection reason.');
      return;
    }
    setIsRejecting(true);
    try {
      const token = await getAccessToken();
      const res = await fetch('/api/office/decide', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          visitId: rejectModalVisit.id,
          decision: 'rejected',
          rejectionReason: rejectionReason.trim(),
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.message || data.error || 'Failed to reject visit');
      }

      const emailStatus = data.emailDelivery?.status;
      if (emailStatus === 'sent') {
        toast.info('Visit request rejected. Explanation email submitted to the email provider.');
      } else if (emailStatus === 'delivered') {
        toast.info('Visit request rejected. Explanation delivered by provider.');
      } else if (emailStatus === 'failed') {
        toast.warning('Visit request rejected, but the explanation email could not be sent.');
      } else if (emailStatus === 'unknown') {
        toast.warning('Visit request rejected. Explanation email outcome is uncertain.');
      } else if (rejectModalVisit.visitorEmail) {
        toast.info('Visit request rejected. Explanation email is pending dispatch.');
      } else {
        toast.info('Visit request rejected.');
      }
      setRejectModalVisit(null);
      setRejectionReason('');
      loadVisits(true);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Rejection failed.';
      toast.error(msg);
    } finally {
      setIsRejecting(false);
    }
  }

  // Handle Office Arrival Confirmation
  async function handleConfirmArrival() {
    if (!confirmArrivalVisit) return;
    setIsConfirmingArrival(true);
    try {
      const token = await getAccessToken();
      const res = await fetch('/api/office/confirm-arrival', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          visitId: confirmArrivalVisit.id,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.message || data.error || 'Failed to confirm arrival');
      }

      toast.success(`Arrival confirmed for ${confirmArrivalVisit.visitorDisplayName || confirmArrivalVisit.visitorFullName}! Attendance recorded.`);
      setConfirmArrivalVisit(null);
      loadVisits(true);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Arrival confirmation failed.';
      toast.error(msg);
    } finally {
      setIsConfirmingArrival(false);
    }
  }

  // Handle Retry / Reconcile Email Delivery
  async function handleRetryEmail(
    visitId: string,
    action: 'retry' | 'mark_delivered' | 'permit_retry' = 'retry',
    note?: string,
  ) {
    setRetryingEmailVisitId(visitId);
    try {
      const token = await getAccessToken();
      const res = await fetch('/api/office/retry-email', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ visitId, action, note }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.message || data.error || 'Failed to process email action');
      }
      toast.success(data.message || (action === 'retry' ? 'Gate pass email re-sent to visitor!' : 'Email state updated.'));
      loadVisits(true);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to process email.';
      toast.error(msg);
    } finally {
      setRetryingEmailVisitId(null);
    }
  }

  // Handle Add Personnel
  async function handleAddPersonnel(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedOfficeId || !newPersonnelName.trim()) return;
    setIsSavingPersonnel(true);
    try {
      const token = await getAccessToken();
      const res = await fetch('/api/office/personnel', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          officeId: selectedOfficeId,
          name: newPersonnelName.trim(),
          title: newPersonnelTitle.trim() || undefined,
        }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.message || data.error || 'Failed to add personnel');

      toast.success('Personnel added successfully.');
      setNewPersonnelName('');
      setNewPersonnelTitle('');
      loadPersonnelForOffice(selectedOfficeId);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to add personnel.';
      toast.error(msg);
    } finally {
      setIsSavingPersonnel(false);
    }
  }

  // Handle Toggle Personnel Active Status
  async function handleTogglePersonnel(person: OfficePersonnel) {
    setTogglingPersonnelId(person.id);
    try {
      const token = await getAccessToken();
      const res = await fetch('/api/office/personnel', {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          personnelId: person.id,
          active: !person.active,
        }),
      });

      if (!res.ok) throw new Error('Failed to update personnel status');
      toast.success(`Personnel marked ${!person.active ? 'Active' : 'Inactive'}.`);
      loadPersonnelForOffice(selectedOfficeId);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to update status.';
      toast.error(msg);
    } finally {
      setTogglingPersonnelId(null);
    }
  }

  // Handle Save Calendar Schedule Date
  async function handleSaveSchedule() {
    if (!selectedDateForEdit || !selectedOfficeId) return;
    setIsSavingSchedule(true);
    try {
      const token = await getAccessToken();
      const res = await fetch('/api/office/calendar', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          officeId: selectedOfficeId,
          scheduleDate: selectedDateForEdit,
          status: scheduleStatus,
          reason: scheduleReason.trim() || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || data.error || 'Failed to update schedule');
      toast.success(`Schedule saved for ${selectedDateForEdit}: ${scheduleStatus}`);
      setSelectedDateForEdit(null);
      setScheduleReason('');
      loadOfficeSchedules();
    } catch (err: any) {
      toast.error(err.message || 'Failed to save date schedule');
    } finally {
      setIsSavingSchedule(false);
    }
  }

  // Handle Reset Date Schedule to Open
  async function handleDeleteSchedule(scheduleDate: string) {
    if (!selectedOfficeId) return;
    try {
      const token = await getAccessToken();
      const res = await fetch(`/api/office/calendar?officeId=${encodeURIComponent(selectedOfficeId)}&scheduleDate=${encodeURIComponent(scheduleDate)}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.message || data.error || 'Failed to reset schedule');
      }
      toast.success(`Schedule reset to Open for ${scheduleDate}`);
      setSelectedDateForEdit(null);
      setScheduleReason('');
      loadOfficeSchedules();
    } catch (err: any) {
      toast.error(err.message || 'Failed to reset schedule');
    }
  }

  const selectedOffice = offices.find((o) => o.id === selectedOfficeId);

  // Helper to render visitor cards
  const renderVisitorCard = (visit: OfficeVisitRecord, queueType: 'pending' | 'confirmation') => {
    const isSpecificPerson = visit.visitType === 'specific_person';

    return (
      <div
        key={visit.id}
        className="overflow-hidden rounded-2xl border border-[var(--color-border)] bg-white p-4 shadow-xs transition-shadow hover:shadow-md space-y-3"
      >
        <div className="flex items-start gap-3">
          {/* Portrait preview with secure AuthenticatedImage */}
          <div className="h-14 w-14 flex-shrink-0 overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]">
            {visit.portraitPreviewToken ? (
              <AuthenticatedImage
                srcUrl={`/api/office/portrait-preview?token=${visit.portraitPreviewToken}`}
                alt={visit.visitorDisplayName || visit.visitorFullName}
                className="h-full w-full object-cover"
                fallbackText="Selfie"
              />
            ) : (
              <div className="flex h-full w-full items-center justify-center text-[var(--color-text-muted)]">
                <User className="h-6 w-6" />
              </div>
            )}
          </div>

          <div className="flex-1 min-w-0">
            <div className="flex flex-wrap items-center gap-1.5">
              <h4 className="text-sm font-bold text-[var(--color-text-primary)] truncate">
                {visit.visitorDisplayName || visit.visitorFullName}
              </h4>
              <span
                className={`rounded-md px-1.5 py-0.5 text-[10px] font-extrabold uppercase tracking-wide ${
                  isSpecificPerson
                    ? 'bg-purple-100 text-purple-800 border border-purple-200'
                    : 'bg-blue-100 text-blue-800 border border-blue-200'
                }`}
              >
                {isSpecificPerson ? 'Specific Person' : 'General Visit'}
              </span>
            </div>

            {isSpecificPerson && visit.personnelName && (
              <p className="text-[11px] font-semibold text-[#7A0A0A] flex items-center gap-1 mt-0.5">
                <UserCheck className="h-3 w-3 shrink-0" />
                <span>Requested: <strong>{visit.personnelName}</strong></span>
              </p>
            )}

            <div className="flex flex-wrap items-center gap-2 text-[10px] text-[var(--color-text-secondary)] mt-1">
              <span className="flex items-center gap-1">
                <Calendar className="h-3 w-3 text-slate-400" />
                {visit.visitDate}
              </span>
              <span className="flex items-center gap-1">
                <Phone className="h-3 w-3 text-slate-400" />
                {visit.visitorContactNumber}
              </span>
              {visit.expectedGate && (
                <span className="rounded bg-slate-100 px-1 py-0.2 text-[10px] text-slate-700">
                  Gate: {visit.expectedGate}
                </span>
              )}
              <span className="flex items-center gap-1">
                <Clock3 className="h-3 w-3 text-slate-400" />
                {formatManilaTime(visit.createdAt)}
              </span>
            </div>
          </div>
        </div>

        {/* Prominent Visit Purpose Callout */}
        <div className={`rounded-xl p-3 text-xs ${
          queueType === 'pending'
            ? 'border border-[#7A0A0A]/20 bg-[#F8EEEE]/50 text-[#7A0A0A]'
            : 'border border-amber-200 bg-amber-50/70 text-amber-950'
        }`}>
          <span className="text-[10px] font-black uppercase tracking-wider block opacity-75">
            {queueType === 'pending' ? 'Appointment Purpose' : 'Visit Purpose'}
          </span>
          <p className="font-semibold text-xs text-[var(--color-text-primary)] mt-0.5 leading-relaxed">
            {visit.purpose}
          </p>
        </div>

        {/* Email & Outbox Delivery Status */}
        {visit.visitorEmail && (
          <div className="flex items-center justify-between text-[11px] text-[var(--color-text-muted)] pt-1 border-t border-[var(--color-border)]">
            <span className="flex items-center gap-1 truncate max-w-[200px]" title={visit.visitorEmail}>
              <Mail className="h-3 w-3 text-slate-400 shrink-0" />
              <span className="truncate">{visit.visitorEmail}</span>
            </span>
            {visit.emailDeliveryStatus === 'delivered' && (
              <span className="rounded px-1.5 py-0.5 bg-emerald-100 text-emerald-800 text-[10px] font-bold">
                Delivered
              </span>
            )}
            {visit.emailDeliveryStatus === 'sent' && (
              <span className="rounded px-1.5 py-0.5 bg-blue-100 text-blue-800 text-[10px] font-bold">
                Sent to Provider
              </span>
            )}
            {visit.emailDeliveryStatus === 'pending' && (
              <span className="rounded px-1.5 py-0.5 bg-slate-100 text-slate-700 text-[10px] font-bold">
                Pending Email
              </span>
            )}
            {visit.emailDeliveryStatus === 'failed' && (
              <span className="flex items-center gap-1">
                <span className="rounded px-1.5 py-0.5 bg-rose-100 text-rose-800 text-[10px] font-bold">
                  Email Failed
                </span>
                <button
                  type="button"
                  onClick={() => handleRetryEmail(visit.id, 'retry')}
                  disabled={retryingEmailVisitId === visit.id}
                  className="text-[10px] text-blue-700 underline font-semibold hover:text-blue-900 cursor-pointer"
                >
                  {retryingEmailVisitId === visit.id ? 'Retrying…' : 'Retry'}
                </button>
              </span>
            )}
          </div>
        )}

        {/* Actions */}
        <div className="pt-1 flex items-center justify-end gap-2">
          {queueType === 'pending' ? (
            <>
              <Button
                variant="destructive"
                size="sm"
                onClick={() => {
                  setRejectModalVisit(visit);
                  setRejectionReason('');
                }}
                icon={<XCircle className="h-3.5 w-3.5" />}
                className="text-xs"
              >
                Reject
              </Button>
              <Button
                variant="primary"
                size="sm"
                onClick={() => setApproveModalVisit(visit)}
                icon={<CheckCircle2 className="h-3.5 w-3.5" />}
                className="bg-[#7A0A0A] hover:bg-[#600808] text-white text-xs font-bold"
              >
                Approve & Issue Pass
              </Button>
            </>
          ) : (
            <Button
              variant="primary"
              size="sm"
              onClick={() => setConfirmArrivalVisit(visit)}
              icon={<CheckCircle2 className="h-4 w-4" />}
              className="bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-xs shadow-xs w-full sm:w-auto"
            >
              Confirm Office Arrival
            </Button>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="min-h-screen bg-[var(--color-canvas)] text-[var(--color-text-primary)]">
      {/* Top Navigation Bar with EARIST Maroon Identity */}
      <header className="sticky top-0 z-30 border-b border-[#7A0A0A]/20 bg-white/95 backdrop-blur-md shadow-xs">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-4 py-3 sm:px-6">
          <div className="flex items-center gap-3">
            <BrandMark />
            <div className="hidden h-5 w-px bg-gray-200 sm:block" />
            <span className="hidden text-xs font-extrabold uppercase tracking-wider text-[#7A0A0A] sm:inline-block">
              Office Portal
            </span>
          </div>

          <div className="flex items-center gap-2">
            {offices.length > 1 && (
              <select
                aria-label="Select office"
                value={selectedOfficeId}
                onChange={(e) => setSelectedOfficeId(e.target.value)}
                className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] py-1.5 px-3 text-xs font-semibold text-[var(--color-text-primary)] focus:border-[#7A0A0A] focus:outline-none"
              >
                {offices.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name}
                  </option>
                ))}
              </select>
            )}

            <Button
              variant="secondary"
              size="sm"
              onClick={() => setIsCalendarModalOpen(true)}
              disabled={!selectedOfficeId}
              icon={<CalendarDays className="h-3.5 w-3.5 text-[#7A0A0A]" />}
              className="border-[#7A0A0A]/30 text-[#7A0A0A] hover:bg-[#F8EEEE]"
            >
              Office Calendar
            </Button>

            <Button
              variant="secondary"
              size="sm"
              onClick={() => setIsPersonnelModalOpen(true)}
              disabled={!selectedOfficeId}
              icon={<Users className="h-3.5 w-3.5 text-gray-700" />}
            >
              Directory ({personnelList.length})
            </Button>

            <Button
              variant="secondary"
              size="sm"
              onClick={() => loadVisits(true)}
              disabled={isRefreshing}
              icon={<RefreshCw className={`h-3.5 w-3.5 ${isRefreshing ? 'animate-spin' : ''}`} />}
            >
              Refresh
            </Button>

            <Button
              variant="ghost"
              size="sm"
              onClick={handleSignOut}
              disabled={isSigningOut}
              icon={<LogOut className="h-3.5 w-3.5" />}
            >
              Sign Out
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6">
        {/* No Office Assigned Banner */}
        {noOfficeAssigned && (
          <div className="mb-6 rounded-2xl border border-amber-300 bg-amber-50 p-6 text-center space-y-3 shadow-xs">
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl bg-amber-100 text-amber-800">
              <Building2 className="h-6 w-6" />
            </div>
            <h2 className="text-lg font-bold text-amber-950">No Office Assigned</h2>
            <p className="text-xs text-amber-800 max-w-md mx-auto leading-relaxed">
              Your staff account is currently not assigned to any university office. Please contact the University Administrator to assign you to an office.
            </p>
          </div>
        )}

        {/* Office Header Banner */}
        {selectedOffice && (
          <div className="mb-6 rounded-2xl border border-[#7A0A0A]/15 bg-gradient-to-r from-[#7A0A0A]/10 via-[#F8EEEE]/40 to-transparent p-5">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
              <div className="flex items-center gap-3">
                <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-[#7A0A0A] text-white shadow-xs">
                  <Building2 className="h-6 w-6" />
                </div>
                <div>
                  <h1 className="text-xl font-black text-[#7A0A0A] sm:text-2xl">{selectedOffice.name}</h1>
                  <p className="text-xs text-[var(--color-text-secondary)] mt-0.5">
                    {selectedOffice.description || 'Designated university office for visitor management.'}
                  </p>
                </div>
              </div>

              {/* Quick Summary Badges */}
              <div className="flex items-center gap-2">
                <div className="rounded-xl border border-[#7A0A0A]/20 bg-white px-3 py-1.5 text-center shadow-xs">
                  <span className="text-[10px] font-bold uppercase tracking-wider text-[var(--color-text-secondary)] block">Pending Review</span>
                  <span className="text-sm font-black text-[#7A0A0A]">{queueCounts.pending}</span>
                </div>
                <div className="rounded-xl border border-amber-300 bg-white px-3 py-1.5 text-center shadow-xs">
                  <span className="text-[10px] font-bold uppercase tracking-wider text-amber-800 block">At Gate / Campus</span>
                  <span className="text-sm font-black text-amber-700">{queueCounts.awaiting_confirmation}</span>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Search & Filter Bar */}
        <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="relative flex-1 max-w-md">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--color-text-muted)]" />
            <input
              type="text"
              placeholder="Search visitor name or purpose…"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full rounded-xl border border-[var(--color-border)] bg-white py-2 pl-9 pr-4 text-xs font-medium text-[var(--color-text-primary)] focus:border-[#7A0A0A] focus:outline-none focus:ring-1 focus:ring-[#7A0A0A]"
            />
          </div>

          <div className="flex items-center gap-2">
            <input
              type="date"
              aria-label="Filter by visit date"
              value={dateFilter}
              onChange={(e) => setDateFilter(e.target.value)}
              className="rounded-xl border border-[var(--color-border)] bg-white py-2 px-3 text-xs font-semibold text-[var(--color-text-primary)] focus:border-[#7A0A0A] focus:outline-none focus:ring-1 focus:ring-[#7A0A0A]"
            />
            {dateFilter && (
              <Button size="sm" variant="ghost" onClick={() => setDateFilter('')}>
                Clear
              </Button>
            )}
          </div>
        </div>

        {/* Mobile Tab Switcher */}
        <div className="lg:hidden mb-4 grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={() => setMobileTab('pending')}
            className={`flex items-center justify-center gap-2 rounded-xl py-2.5 px-3 text-xs font-bold transition-all ${
              mobileTab === 'pending'
                ? 'bg-[#7A0A0A] text-white shadow-xs'
                : 'bg-white text-[var(--color-text-secondary)] border border-[var(--color-border)]'
            }`}
          >
            <Clock3 className="h-4 w-4" />
            <span>Pending Approval ({pendingVisits.length})</span>
          </button>
          <button
            type="button"
            onClick={() => setMobileTab('confirmation')}
            className={`flex items-center justify-center gap-2 rounded-xl py-2.5 px-3 text-xs font-bold transition-all ${
              mobileTab === 'confirmation'
                ? 'bg-amber-600 text-white shadow-xs'
                : 'bg-white text-[var(--color-text-secondary)] border border-[var(--color-border)]'
            }`}
          >
            <CheckCircle2 className="h-4 w-4" />
            <span>Arrivals ({confirmationVisits.length})</span>
          </button>
        </div>

        {/* ============================================================ */}
        {/* TWO-QUEUE SPLIT VIEW (Side-by-side on desktop, stacked/tab on mobile) */}
        {/* ============================================================ */}
        {isLoading ? (
          <div className="flex min-h-[300px] flex-col items-center justify-center rounded-2xl border border-[var(--color-border)] bg-white p-8">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-[#7A0A0A] border-t-transparent" />
            <p className="mt-3 text-xs font-semibold text-[var(--color-text-secondary)]">Loading visit records…</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-start">
            {/* ----------------- PANEL 1: PENDING APPROVAL ----------------- */}
            <div className={`space-y-4 ${mobileTab !== 'pending' ? 'hidden lg:block' : ''}`}>
              <div className="flex items-center justify-between pb-3 border-b-2 border-[#7A0A0A]">
                <div>
                  <h2 className="text-base font-black text-[#7A0A0A] flex items-center gap-2">
                    <Clock3 className="h-5 w-5" />
                    <span>Pending Approval</span>
                    <span className="rounded-full bg-[#7A0A0A] px-2.5 py-0.5 text-xs font-bold text-white">
                      {pendingVisits.length}
                    </span>
                  </h2>
                  <p className="text-xs text-[var(--color-text-secondary)] mt-0.5">
                    Specific-person appointment requests requiring office review.
                  </p>
                </div>
              </div>

              {pendingVisits.length === 0 ? (
                <div className="flex min-h-[220px] flex-col items-center justify-center rounded-2xl border border-dashed border-[var(--color-border)] bg-white p-6 text-center">
                  <CheckCircle2 className="h-8 w-8 text-emerald-600 mb-2" />
                  <p className="text-xs font-bold text-[var(--color-text-primary)]">All Caught Up</p>
                  <p className="text-[11px] text-[var(--color-text-secondary)] mt-0.5 max-w-xs">
                    No specific-person appointments currently pending review.
                  </p>
                </div>
              ) : (
                <div className="space-y-3">
                  {pendingVisits.map((v) => renderVisitorCard(v, 'pending'))}
                </div>
              )}
            </div>

            {/* ----------------- PANEL 2: OFFICE CONFIRMATION ----------------- */}
            <div className={`space-y-4 ${mobileTab !== 'confirmation' ? 'hidden lg:block' : ''}`}>
              <div className="flex items-center justify-between pb-3 border-b-2 border-amber-600">
                <div>
                  <h2 className="text-base font-black text-amber-900 flex items-center gap-2">
                    <CheckCircle2 className="h-5 w-5 text-amber-600" />
                    <span>Office Confirmation</span>
                    <span className="rounded-full bg-amber-600 px-2.5 py-0.5 text-xs font-bold text-white">
                      {confirmationVisits.length}
                    </span>
                  </h2>
                  <p className="text-xs text-[var(--color-text-secondary)] mt-0.5">
                    Visitors who entered campus and are awaiting arrival confirmation.
                  </p>
                </div>
              </div>

              {confirmationVisits.length === 0 ? (
                <div className="flex min-h-[220px] flex-col items-center justify-center rounded-2xl border border-dashed border-[var(--color-border)] bg-white p-6 text-center">
                  <Building2 className="h-8 w-8 text-[var(--color-text-muted)] mb-2" />
                  <p className="text-xs font-bold text-[var(--color-text-primary)]">No Pending Confirmations</p>
                  <p className="text-[11px] text-[var(--color-text-secondary)] mt-0.5 max-w-xs">
                    Visitors will appear here as soon as their pass is scanned at the entrance gate.
                  </p>
                </div>
              ) : (
                <div className="space-y-3">
                  {confirmationVisits.map((v) => renderVisitorCard(v, 'confirmation'))}
                </div>
              )}
            </div>
          </div>
        )}
      </main>

      {/* ============================================================ */}
      {/* OFFICE CALENDAR & AVAILABILITY MODAL */}
      {/* ============================================================ */}
      <Modal
        isOpen={isCalendarModalOpen}
        onClose={() => {
          setIsCalendarModalOpen(false);
          setSelectedDateForEdit(null);
        }}
        title={`Office Availability & Calendar — ${selectedOffice?.name || 'Office'}`}
      >
        <div className="space-y-4 max-h-[75vh] overflow-y-auto pr-1">
          <p className="text-xs text-[var(--color-text-secondary)] leading-relaxed">
            Configure dates when this office is Open, Closed, under Maintenance, or observing a Holiday. Visitors will see these statuses during registration.
          </p>

          {/* Month / Year Selectors */}
          <div className="flex items-center gap-3">
            <select
              aria-label="Select calendar month"
              value={calendarMonth}
              onChange={(e) => {
                setCalendarMonth(parseInt(e.target.value, 10));
                setSelectedDateForEdit(null);
              }}
              className="rounded-xl border border-[var(--color-border)] bg-white py-1.5 px-3 text-xs font-bold text-[var(--color-text-primary)]"
            >
              {[
                'January', 'February', 'March', 'April', 'May', 'June',
                'July', 'August', 'September', 'October', 'November', 'December'
              ].map((m, idx) => (
                <option key={m} value={idx + 1}>{m}</option>
              ))}
            </select>

            <select
              aria-label="Select calendar year"
              value={calendarYear}
              onChange={(e) => {
                setCalendarYear(parseInt(e.target.value, 10));
                setSelectedDateForEdit(null);
              }}
              className="rounded-xl border border-[var(--color-border)] bg-white py-1.5 px-3 text-xs font-bold text-[var(--color-text-primary)]"
            >
              {[new Date().getFullYear(), new Date().getFullYear() + 1].map((y) => (
                <option key={y} value={y}>{y}</option>
              ))}
            </select>
            {loadingSchedules && (
              <span className="text-[11px] text-[var(--color-text-muted)] animate-pulse">Loading schedules...</span>
            )}
          </div>

          {/* Monthly Calendar Grid */}
          <div className="rounded-xl border border-[var(--color-border)] bg-white p-3">
            <div className="grid grid-cols-7 gap-1 text-center text-[10px] font-bold text-[var(--color-text-secondary)] pb-2 border-b border-[var(--color-border)]">
              <span>Sun</span>
              <span>Mon</span>
              <span>Tue</span>
              <span>Wed</span>
              <span>Thu</span>
              <span>Fri</span>
              <span>Sat</span>
            </div>

            {/* Days Grid */}
            {(() => {
              const daysInMonth = new Date(calendarYear, calendarMonth, 0).getDate();
              const firstDayIndex = new Date(calendarYear, calendarMonth - 1, 1).getDay();
              const days = [];

              // Leading blank days
              for (let i = 0; i < firstDayIndex; i++) {
                days.push(<div key={`blank-${i}`} className="p-2 min-h-[52px]" />);
              }

              // Days of current month
              for (let day = 1; day <= daysInMonth; day++) {
                const dayStr = String(day).padStart(2, '0');
                const monthStr = String(calendarMonth).padStart(2, '0');
                const dateKey = `${calendarYear}-${monthStr}-${dayStr}`;

                const sched = officeSchedules.find((s) => s.schedule_date === dateKey);
                const isSelected = selectedDateForEdit === dateKey;

                let badgeColor = 'bg-slate-100 text-slate-700';
                if (sched?.status === 'closed') badgeColor = 'bg-rose-100 text-rose-800 border border-rose-300';
                else if (sched?.status === 'maintenance') badgeColor = 'bg-amber-100 text-amber-900 border border-amber-300';
                else if (sched?.status === 'holiday') badgeColor = 'bg-purple-100 text-purple-900 border border-purple-300';
                else if (sched?.status === 'open') badgeColor = 'bg-emerald-100 text-emerald-800';

                days.push(
                  <button
                    key={dateKey}
                    type="button"
                    onClick={() => {
                      setSelectedDateForEdit(dateKey);
                      setScheduleStatus((sched?.status as any) || 'closed');
                      setScheduleReason(sched?.reason || '');
                    }}
                    className={`min-h-[52px] p-1.5 rounded-lg border text-left flex flex-col justify-between transition-all ${
                      isSelected
                        ? 'border-[#7A0A0A] bg-[#F8EEEE] ring-1 ring-[#7A0A0A]'
                        : 'border-slate-100 hover:border-slate-300 bg-white'
                    }`}
                  >
                    <span className="text-[11px] font-bold text-[var(--color-text-primary)]">{day}</span>
                    {sched && sched.status !== 'open' ? (
                      <span className={`text-[9px] font-black uppercase tracking-tight rounded px-1 py-0.2 truncate block ${badgeColor}`}>
                        {sched.status}
                      </span>
                    ) : (
                      <span className="text-[9px] text-slate-400">Open</span>
                    )}
                  </button>
                );
              }

              return <div className="grid grid-cols-7 gap-1 pt-2">{days}</div>;
            })()}
          </div>

          {/* Edit Date Status Form */}
          {selectedDateForEdit && (
            <div className="rounded-xl border border-[#7A0A0A]/30 bg-[#F8EEEE]/40 p-4 space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-[#7A0A0A]">
                  Edit Schedule for: <strong>{selectedDateForEdit}</strong>
                </span>
                {officeSchedules.some((s) => s.schedule_date === selectedDateForEdit) && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => handleDeleteSchedule(selectedDateForEdit)}
                    icon={<Trash2 className="h-3 w-3 text-rose-600" />}
                    className="text-xs text-rose-700"
                  >
                    Reset to Open
                  </Button>
                )}
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
                <div>
                  <label className="block text-[11px] font-bold uppercase text-[var(--color-text-secondary)] mb-1">
                    Availability Status
                  </label>
                  <select
                    value={scheduleStatus}
                    onChange={(e) => setScheduleStatus(e.target.value as any)}
                    className="w-full rounded-xl border border-[var(--color-border)] bg-white py-1.5 px-3 text-xs font-semibold focus:border-[#7A0A0A] focus:outline-none"
                  >
                    <option value="closed">Closed</option>
                    <option value="maintenance">Maintenance</option>
                    <option value="holiday">Holiday</option>
                    <option value="open">Open (Normal)</option>
                  </select>
                </div>

                <div>
                  <label className="block text-[11px] font-bold uppercase text-[var(--color-text-secondary)] mb-1">
                    Reason / Description (optional)
                  </label>
                  <Input
                    placeholder="e.g. Faculty Planning Seminar"
                    value={scheduleReason}
                    onChange={(e) => setScheduleReason(e.target.value)}
                    className="text-xs"
                  />
                </div>
              </div>

              <div className="flex justify-end gap-2 pt-1">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setSelectedDateForEdit(null)}
                >
                  Cancel
                </Button>
                <Button
                  variant="primary"
                  size="sm"
                  onClick={handleSaveSchedule}
                  loading={isSavingSchedule}
                  className="bg-[#7A0A0A] hover:bg-[#600808] text-white"
                >
                  Save Date Status
                </Button>
              </div>
            </div>
          )}

          <div className="flex justify-end pt-2">
            <Button variant="secondary" onClick={() => setIsCalendarModalOpen(false)}>
              Done
            </Button>
          </div>
        </div>
      </Modal>

      {/* Approve Modal */}
      <Modal
        isOpen={Boolean(approveModalVisit)}
        onClose={() => {
          if (!isApproving) setApproveModalVisit(null);
        }}
        title="Approve Specific-Person Visit Request"
      >
        <div className="space-y-4">
          <p className="text-sm text-[var(--color-text-secondary)]">
            Are you sure you want to approve this visit request for <strong>{approveModalVisit?.visitorDisplayName || approveModalVisit?.visitorFullName}</strong>?
          </p>
          <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3 text-xs space-y-1">
            <p><strong>Office:</strong> {approveModalVisit?.officeName}</p>
            <p><strong>Target Personnel:</strong> {approveModalVisit?.personnelName}</p>
            <p><strong>Scheduled Date:</strong> {approveModalVisit?.visitDate}</p>
            {approveModalVisit?.expectedGate && (
              <p><strong>Expected Entry Gate:</strong> {approveModalVisit.expectedGate}</p>
            )}
            <p><strong>Visitor Email:</strong> {approveModalVisit?.visitorEmail}</p>
          </div>
          <p className="text-xs text-[var(--color-text-muted)]">
            Upon approval, an official digital gate pass with QR code will be generated and automatically emailed to the visitor.
          </p>
          <div className="flex justify-end gap-3 pt-2">
            <Button
              variant="secondary"
              onClick={() => setApproveModalVisit(null)}
              disabled={isApproving}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={handleApproveVisit}
              loading={isApproving}
              className="bg-emerald-600 hover:bg-emerald-700 text-white"
            >
              Confirm Approval & Issue Pass
            </Button>
          </div>
        </div>
      </Modal>

      {/* Reject Modal */}
      <Modal
        isOpen={Boolean(rejectModalVisit)}
        onClose={() => {
          if (!isRejecting) {
            setRejectModalVisit(null);
            setRejectionReason('');
          }
        }}
        title="Reject Specific-Person Visit Request"
      >
        <div className="space-y-4">
          <p className="text-sm text-[var(--color-text-secondary)]">
            Please provide a mandatory reason for rejecting the visit request from <strong>{rejectModalVisit?.visitorDisplayName || rejectModalVisit?.visitorFullName}</strong>.
          </p>

          <div>
            <label htmlFor="rejection-reason" className="block text-xs font-bold uppercase tracking-wider text-[var(--color-text-muted)] mb-1">
              Rejection Reason <span className="text-[var(--color-danger)]">*</span>
            </label>
            <textarea
              id="rejection-reason"
              rows={3}
              value={rejectionReason}
              onChange={(e) => setRejectionReason(e.target.value)}
              placeholder="e.g. The requested personnel is attending an off-campus seminar today. Please reschedule."
              className="w-full rounded-xl border border-[var(--color-border)] bg-white p-3 text-sm text-[var(--color-text-primary)] focus:border-[#7A0A0A] focus:outline-none focus:ring-1 focus:ring-[#7A0A0A]"
            />
          </div>

          <div className="flex justify-end gap-3 pt-2">
            <Button
              variant="secondary"
              onClick={() => {
                setRejectModalVisit(null);
                setRejectionReason('');
              }}
              disabled={isRejecting}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleRejectVisit}
              loading={isRejecting}
              disabled={!rejectionReason.trim()}
            >
              Confirm Rejection & Notify Visitor
            </Button>
          </div>
        </div>
      </Modal>

      {/* Confirm Arrival Modal */}
      <Modal
        isOpen={Boolean(confirmArrivalVisit)}
        onClose={() => {
          if (!isConfirmingArrival) setConfirmArrivalVisit(null);
        }}
        title="Confirm Office Arrival"
      >
        <div className="space-y-4">
          <p className="text-sm text-[var(--color-text-secondary)]">
            Confirm that visitor <strong>{confirmArrivalVisit?.visitorDisplayName || confirmArrivalVisit?.visitorFullName}</strong> has physically arrived at <strong>{confirmArrivalVisit?.officeName}</strong>.
          </p>

          <div className="rounded-xl border border-emerald-200 bg-emerald-50/50 p-3 text-xs text-emerald-900 space-y-1">
            <p><strong>Purpose:</strong> {confirmArrivalVisit?.purpose}</p>
            {confirmArrivalVisit?.personnelName && (
              <p><strong>Assigned To:</strong> {confirmArrivalVisit.personnelName}</p>
            )}
            <p><strong>Gate Entry Recorded:</strong> Yes (Visitor is inside campus)</p>
          </div>

          <div className="flex justify-end gap-3 pt-2">
            <Button
              variant="secondary"
              onClick={() => setConfirmArrivalVisit(null)}
              disabled={isConfirmingArrival}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={handleConfirmArrival}
              loading={isConfirmingArrival}
              className="bg-emerald-600 hover:bg-emerald-700 text-white font-bold"
            >
              Confirm Arrival Now
            </Button>
          </div>
        </div>
      </Modal>

      {/* Personnel Directory Modal */}
      <Modal
        isOpen={isPersonnelModalOpen}
        onClose={() => setIsPersonnelModalOpen(false)}
        title={`Personnel Directory — ${selectedOffice?.name || 'Office'}`}
      >
        <div className="space-y-6 max-h-[70vh] overflow-y-auto pr-1">
          <form onSubmit={handleAddPersonnel} className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 space-y-3">
            <h3 className="text-xs font-bold uppercase tracking-wider text-[var(--color-text-primary)]">
              Add New Faculty / Staff Member
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Input
                placeholder="Full Name (e.g. Dr. Maria Santos)"
                value={newPersonnelName}
                onChange={(e) => setNewPersonnelName(e.target.value)}
                required
              />
              <Input
                placeholder="Title / Position (e.g. Dean, Chairperson)"
                value={newPersonnelTitle}
                onChange={(e) => setNewPersonnelTitle(e.target.value)}
              />
            </div>
            <div className="flex justify-end">
              <Button
                type="submit"
                size="sm"
                variant="primary"
                loading={isSavingPersonnel}
                disabled={!newPersonnelName.trim()}
                icon={<Plus className="h-4 w-4" />}
                className="bg-[#7A0A0A] hover:bg-[#600808] text-white"
              >
                Add Personnel
              </Button>
            </div>
          </form>

          <div className="space-y-2">
            <h3 className="text-xs font-bold uppercase tracking-wider text-[var(--color-text-secondary)]">
              Active Directory ({personnelList.length})
            </h3>
            {personnelList.length === 0 ? (
              <p className="text-xs text-[var(--color-text-muted)] italic">No personnel listed for this office yet.</p>
            ) : (
              <div className="divide-y divide-[var(--color-border)] rounded-xl border border-[var(--color-border)] bg-white overflow-hidden">
                {personnelList.map((person) => (
                  <div key={person.id} className="flex items-center justify-between p-3 text-xs">
                    <div>
                      <p className="font-bold text-[var(--color-text-primary)]">{person.name}</p>
                      <p className="text-[11px] text-[var(--color-text-secondary)]">{person.title || 'Faculty / Staff'}</p>
                    </div>

                    <button
                      type="button"
                      disabled={togglingPersonnelId === person.id}
                      onClick={() => handleTogglePersonnel(person)}
                      className={`rounded-full px-2.5 py-1 text-[10px] font-bold transition-colors ${
                        togglingPersonnelId === person.id
                          ? 'opacity-50 cursor-not-allowed '
                          : ''
                      }${
                        person.active
                          ? 'bg-emerald-100 text-emerald-800 hover:bg-emerald-200'
                          : 'bg-zinc-100 text-zinc-600 hover:bg-zinc-200'
                      }`}
                    >
                      {togglingPersonnelId === person.id
                        ? 'Updating...'
                        : person.active ? 'Active' : 'Inactive'}
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="flex justify-end pt-2">
            <Button variant="secondary" onClick={() => setIsPersonnelModalOpen(false)}>
              Close Directory
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

export default OfficeDashboardPage;
