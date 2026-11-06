import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { getAccessToken, signOutCurrentActor } from '@/services/auth';
import {
  Building2,
  CheckCircle2,
  Clock,
  Clock3,
  Filter,
  LogOut,
  Plus,
  RefreshCw,
  Search,
  User,
  UserCheck,
  XCircle,
  AlertTriangle,
  Users,
  ShieldCheck,
  Calendar,
  Mail,
  Phone,
} from 'lucide-react';
import { toast } from 'sonner';
import { BrandMark } from '@/components/BrandMark';
import { Button, Modal, Input } from '@/components/ui';
import { AuthenticatedImage } from '@/components/AuthenticatedImage';
import type { Office, OfficePersonnel, OfficeVisitRecord } from '@/types/office';

type QueueTab = 'pending' | 'approved' | 'awaiting_confirmation' | 'confirmed' | 'history';

export function OfficeDashboardPage() {
  const { userData, role } = useAuth();
  const navigate = useNavigate();

  const [offices, setOffices] = useState<Office[]>([]);
  const [selectedOfficeId, setSelectedOfficeId] = useState<string>('');
  const [activeQueue, setActiveQueue] = useState<QueueTab>('pending');
  const [visits, setVisits] = useState<OfficeVisitRecord[]>([]);
  const [personnelList, setPersonnelList] = useState<OfficePersonnel[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [dateFilter, setDateFilter] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);

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

  // Modal States
  const [approveModalVisit, setApproveModalVisit] = useState<OfficeVisitRecord | null>(null);
  const [isApproving, setIsApproving] = useState(false);

  const [rejectModalVisit, setRejectModalVisit] = useState<OfficeVisitRecord | null>(null);
  const [rejectionReason, setRejectionReason] = useState('');
  const [isRejecting, setIsRejecting] = useState(false);

  const [confirmArrivalVisit, setConfirmArrivalVisit] = useState<OfficeVisitRecord | null>(null);
  const [isConfirmingArrival, setIsConfirmingArrival] = useState(false);

  const [isPersonnelModalOpen, setIsPersonnelModalOpen] = useState(false);
  const [newPersonnelName, setNewPersonnelName] = useState('');
  const [newPersonnelTitle, setNewPersonnelTitle] = useState('');
  const [isSavingPersonnel, setIsSavingPersonnel] = useState(false);

  const [isSigningOut, setIsSigningOut] = useState(false);
  const [retryingEmailVisitId, setRetryingEmailVisitId] = useState<string | null>(null);

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

  // Fetch Visits for Current Queue & Office
  const loadVisits = useCallback(async (showRefreshing = false) => {
    if (!selectedOfficeId) return;
    if (showRefreshing) setIsRefreshing(true);
    else setIsLoading(true);

    try {
      const token = await getAccessToken();
      const params = new URLSearchParams({
        officeId: selectedOfficeId,
        queue: activeQueue,
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
      setVisits(data.visits || []);

      // Update Counts
      const [pRes, aRes, wRes, cRes, hRes] = await Promise.all([
        fetch(`/api/office/visits?officeId=${selectedOfficeId}&queue=pending&limit=1`, { headers: { Authorization: `Bearer ${token}` } }),
        fetch(`/api/office/visits?officeId=${selectedOfficeId}&queue=approved&limit=1`, { headers: { Authorization: `Bearer ${token}` } }),
        fetch(`/api/office/visits?officeId=${selectedOfficeId}&queue=awaiting_confirmation&limit=1`, { headers: { Authorization: `Bearer ${token}` } }),
        fetch(`/api/office/visits?officeId=${selectedOfficeId}&queue=confirmed&limit=1`, { headers: { Authorization: `Bearer ${token}` } }),
        fetch(`/api/office/visits?officeId=${selectedOfficeId}&queue=history&limit=1`, { headers: { Authorization: `Bearer ${token}` } }),
      ]);

      const [pData, aData, wData, cData, hData] = await Promise.all([
        pRes.json().catch(() => ({ total: 0 })),
        aRes.json().catch(() => ({ total: 0 })),
        wRes.json().catch(() => ({ total: 0 })),
        cRes.json().catch(() => ({ total: 0 })),
        hRes.json().catch(() => ({ total: 0 })),
      ]);

      setQueueCounts({
        pending: pData.total ?? pData.visits?.length ?? 0,
        approved: aData.total ?? aData.visits?.length ?? 0,
        awaiting_confirmation: wData.total ?? wData.visits?.length ?? 0,
        confirmed: cData.total ?? cData.visits?.length ?? 0,
        history: hData.total ?? hData.visits?.length ?? 0,
      });
    } catch (err) {
      console.error('Error loading visits:', err);
      toast.error('Unable to refresh visit records.');
    } finally {
      setIsLoading(false);
      setIsRefreshing(false);
    }
  }, [activeQueue, dateFilter, searchQuery, selectedOfficeId]);

  useEffect(() => {
    loadOfficesAndPersonnel();
  }, [loadOfficesAndPersonnel]);

  useEffect(() => {
    if (selectedOfficeId) {
      loadPersonnelForOffice(selectedOfficeId);
      loadVisits();
    }
  }, [selectedOfficeId, loadPersonnelForOffice, loadVisits]);

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

      toast.success(`Visit approved! Digital gate pass emailed to ${approveModalVisit.visitorEmail || 'visitor'}.`);
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

      toast.info('Visit request rejected. Explanation sent to visitor.');
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

  // Handle Retry Email Delivery for an approved visit
  async function handleRetryEmail(visitId: string) {
    setRetryingEmailVisitId(visitId);
    try {
      const token = await getAccessToken();
      const res = await fetch('/api/office/retry-email', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ visitId }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.message || data.error || 'Failed to retry email delivery');
      }
      toast.success('Gate pass email successfully re-sent to visitor!');
      loadVisits(true);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to re-send email.';
      toast.error(msg);
    } finally {
      setRetryingEmailVisitId(null);
    }
  }

  // Handle Add Personnel to Office
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

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.message || 'Failed to create personnel');
      }

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
    try {
      const token = await getAccessToken();
      const res = await fetch('/api/office/personnel', {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: person.id,
          active: !person.active,
        }),
      });

      if (!res.ok) throw new Error('Failed to update personnel');
      toast.success(`Personnel ${person.name} is now ${!person.active ? 'active' : 'inactive'}.`);
      loadPersonnelForOffice(selectedOfficeId);
    } catch {
      toast.error('Failed to update personnel status.');
    }
  }

  const selectedOffice = offices.find((o) => o.id === selectedOfficeId);

  return (
    <div className="min-h-screen bg-[var(--color-canvas)] text-[var(--color-text-primary)]">
      {/* Top Navigation Bar */}
      <header className="sticky top-0 z-30 border-b border-[var(--color-border)] bg-white/95 backdrop-blur shadow-xs">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-4 py-3 sm:px-6">
          <div className="flex items-center gap-3">
            <BrandMark size="sm" />
            <div>
              <div className="flex items-center gap-2">
                <span className="text-base font-extrabold text-[#7A0A0A] sm:text-lg">EARIST E-GatePass</span>
                <span className="rounded-md bg-[#7A0A0A]/10 px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide text-[#7A0A0A]">
                  Office Portal
                </span>
              </div>
              <p className="text-xs text-[var(--color-text-secondary)]">Visit Management & Attendance Confirmation</p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <div className="hidden sm:flex flex-col text-right">
              <span className="text-xs font-bold text-[var(--color-text-primary)]">
                {userData?.kind === 'staff' ? userData.name : 'Staff Member'}
              </span>
              <span className="text-[11px] text-[var(--color-text-secondary)] capitalize">{role?.replace('_', ' ')}</span>
            </div>

            <Button
              variant="secondary"
              size="sm"
              onClick={handleSignOut}
              disabled={isSigningOut}
              icon={<LogOut className="h-4 w-4" />}
            >
              <span className="hidden sm:inline">Sign Out</span>
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6">
        {/* Office Switcher & Quick Actions */}
        <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between rounded-2xl border border-[var(--color-border)] bg-white p-4 shadow-xs">
          <div className="flex flex-1 flex-col sm:flex-row sm:items-center gap-3">
            <label htmlFor="office-select" className="text-xs font-bold uppercase tracking-wider text-[var(--color-text-secondary)] sm:min-w-28">
              Target Office:
            </label>
            <div className="relative flex-1 max-w-md">
              <Building2 className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--color-text-muted)]" />
              <select
                id="office-select"
                value={selectedOfficeId}
                onChange={(e) => setSelectedOfficeId(e.target.value)}
                className="w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] py-2 pl-9 pr-8 text-sm font-semibold text-[var(--color-text-primary)] focus:border-[#7A0A0A] focus:outline-none focus:ring-1 focus:ring-[#7A0A0A]"
              >
                {offices.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setIsPersonnelModalOpen(true)}
              icon={<Users className="h-4 w-4" />}
            >
              Personnel Directory ({personnelList.length})
            </Button>

            <Button
              variant="secondary"
              size="sm"
              onClick={() => loadVisits(true)}
              disabled={isRefreshing}
              icon={<RefreshCw className={`h-4 w-4 ${isRefreshing ? 'animate-spin' : ''}`} />}
            >
              Refresh
            </Button>
          </div>
        </div>

        {/* Office Banner */}
        {selectedOffice && (
          <div className="mb-6 rounded-2xl border border-[#7A0A0A]/15 bg-gradient-to-r from-[#7A0A0A]/5 via-white to-transparent p-5">
            <div className="flex items-center gap-3">
              <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-[#7A0A0A] text-white shadow-sm">
                <Building2 className="h-6 w-6" />
              </div>
              <div>
                <h1 className="text-xl font-black text-[#7A0A0A] sm:text-2xl">{selectedOffice.name}</h1>
                <p className="text-xs text-[var(--color-text-secondary)] mt-0.5">
                  {selectedOffice.description || 'Designated university office for visitor management.'}
                </p>
              </div>
            </div>
          </div>
        )}

        {/* Queue Navigation Tabs */}
        <div className="mb-6 flex overflow-x-auto no-scrollbar gap-2 border-b border-[var(--color-border)] pb-2">
          <button
            type="button"
            onClick={() => setActiveQueue('pending')}
            className={`flex items-center gap-2 rounded-xl px-4 py-2.5 text-xs font-bold transition-all ${
              activeQueue === 'pending'
                ? 'bg-[#7A0A0A] text-white shadow-sm'
                : 'bg-white text-[var(--color-text-secondary)] hover:bg-[var(--color-surface)] border border-[var(--color-border)]'
            }`}
          >
            <Clock3 className="h-4 w-4" />
            <span>Pending Approval</span>
            <span
              className={`ml-1 rounded-full px-2 py-0.5 text-[10px] font-extrabold ${
                activeQueue === 'pending' ? 'bg-white text-[#7A0A0A]' : 'bg-[#7A0A0A]/10 text-[#7A0A0A]'
              }`}
            >
              {queueCounts.pending}
            </span>
          </button>

          <button
            type="button"
            onClick={() => setActiveQueue('approved')}
            className={`flex items-center gap-2 rounded-xl px-4 py-2.5 text-xs font-bold transition-all ${
              activeQueue === 'approved'
                ? 'bg-[#7A0A0A] text-white shadow-sm'
                : 'bg-white text-[var(--color-text-secondary)] hover:bg-[var(--color-surface)] border border-[var(--color-border)]'
            }`}
          >
            <ShieldCheck className="h-4 w-4" />
            <span>Approved / QR Issued</span>
            <span
              className={`ml-1 rounded-full px-2 py-0.5 text-[10px] font-extrabold ${
                activeQueue === 'approved' ? 'bg-white text-[#7A0A0A]' : 'bg-gray-100 text-gray-700'
              }`}
            >
              {queueCounts.approved}
            </span>
          </button>

          <button
            type="button"
            onClick={() => setActiveQueue('awaiting_confirmation')}
            className={`flex items-center gap-2 rounded-xl px-4 py-2.5 text-xs font-bold transition-all ${
              activeQueue === 'awaiting_confirmation'
                ? 'bg-amber-600 text-white shadow-sm'
                : 'bg-amber-50/50 text-amber-800 hover:bg-amber-100/50 border border-amber-200'
            }`}
          >
            <AlertTriangle className="h-4 w-4" />
            <span>Awaiting Office Confirmation</span>
            <span
              className={`ml-1 rounded-full px-2 py-0.5 text-[10px] font-extrabold ${
                activeQueue === 'awaiting_confirmation' ? 'bg-white text-amber-800' : 'bg-amber-200 text-amber-900'
              }`}
            >
              {queueCounts.awaiting_confirmation}
            </span>
          </button>

          <button
            type="button"
            onClick={() => setActiveQueue('confirmed')}
            className={`flex items-center gap-2 rounded-xl px-4 py-2.5 text-xs font-bold transition-all ${
              activeQueue === 'confirmed'
                ? 'bg-emerald-700 text-white shadow-sm'
                : 'bg-emerald-50/50 text-emerald-800 hover:bg-emerald-100/50 border border-emerald-200'
            }`}
          >
            <CheckCircle2 className="h-4 w-4" />
            <span>Currently at Office</span>
            <span
              className={`ml-1 rounded-full px-2 py-0.5 text-[10px] font-extrabold ${
                activeQueue === 'confirmed' ? 'bg-white text-emerald-800' : 'bg-emerald-200 text-emerald-900'
              }`}
            >
              {queueCounts.confirmed}
            </span>
          </button>

          <button
            type="button"
            onClick={() => setActiveQueue('history')}
            className={`flex items-center gap-2 rounded-xl px-4 py-2.5 text-xs font-bold transition-all ${
              activeQueue === 'history'
                ? 'bg-zinc-800 text-white shadow-sm'
                : 'bg-white text-[var(--color-text-secondary)] hover:bg-[var(--color-surface)] border border-[var(--color-border)]'
            }`}
          >
            <Clock className="h-4 w-4" />
            <span>Completed / Exceptions</span>
            <span
              className={`ml-1 rounded-full px-2 py-0.5 text-[10px] font-extrabold ${
                activeQueue === 'history' ? 'bg-white text-zinc-900' : 'bg-gray-100 text-gray-700'
              }`}
            >
              {queueCounts.history}
            </span>
          </button>
        </div>

        {/* Filter & Search Bar */}
        <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="relative flex-1 max-w-md">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--color-text-muted)]" />
            <input
              type="text"
              placeholder="Search visitor name, phone, purpose..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full rounded-xl border border-[var(--color-border)] bg-white py-2 pl-9 pr-4 text-xs font-medium text-[var(--color-text-primary)] placeholder-[var(--color-text-muted)] focus:border-[#7A0A0A] focus:outline-none focus:ring-1 focus:ring-[#7A0A0A]"
            />
          </div>

          <div className="flex items-center gap-2">
            <Filter className="h-4 w-4 text-[var(--color-text-muted)]" />
            <Input
              type="date"
              value={dateFilter}
              onChange={(e) => setDateFilter(e.target.value)}
              className="text-xs"
            />
            {dateFilter && (
              <Button size="sm" variant="ghost" onClick={() => setDateFilter('')}>
                Clear
              </Button>
            )}
          </div>
        </div>

        {/* Queue Content */}
        {isLoading ? (
          <div className="flex min-h-[300px] flex-col items-center justify-center rounded-2xl border border-[var(--color-border)] bg-white p-8">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-[#7A0A0A] border-t-transparent" />
            <p className="mt-3 text-xs font-semibold text-[var(--color-text-secondary)]">Loading visit records…</p>
          </div>
        ) : visits.length === 0 ? (
          <div className="flex min-h-[300px] flex-col items-center justify-center rounded-2xl border border-dashed border-[var(--color-border)] bg-white p-8 text-center">
            <Building2 className="h-10 w-10 text-[var(--color-text-muted)]" />
            <h2 className="mt-3 text-base font-bold text-[var(--color-text-primary)]">No visits in this queue</h2>
            <p className="mt-1 text-xs text-[var(--color-text-secondary)] max-w-sm">
              {activeQueue === 'pending'
                ? 'No pending visitor requests awaiting review for this office.'
                : activeQueue === 'awaiting_confirmation'
                ? 'No visitors have passed the gate scanner awaiting office confirmation.'
                : 'There are currently no records matching the selected queue and filters.'}
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4">
            {visits.map((visit) => {
              const isSpecificPerson = visit.visitType === 'specific_person';

              return (
                <div
                  key={visit.id}
                  className="overflow-hidden rounded-2xl border border-[var(--color-border)] bg-white p-5 shadow-xs transition-shadow hover:shadow-md"
                >
                  <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                    <div className="flex items-start gap-4">
                      {/* Portrait preview */}
                      <div className="h-16 w-16 flex-shrink-0 overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]">
                        {visit.portraitPreviewToken ? (
                          <AuthenticatedImage
                            srcUrl={`/api/office/portrait-preview?token=${visit.portraitPreviewToken}`}
                            alt={visit.visitorDisplayName || visit.visitorFullName}
                            className="h-full w-full object-cover"
                            fallbackText="Selfie"
                          />
                        ) : (
                          <div className="flex h-full w-full items-center justify-center text-[var(--color-text-muted)]">
                            <User className="h-8 w-8" />
                          </div>
                        )}
                      </div>

                      <div className="space-y-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <h3 className="text-base font-bold text-[var(--color-text-primary)]">
                            {visit.visitorDisplayName || visit.visitorFullName}
                          </h3>
                          <span
                            className={`rounded-md px-2 py-0.5 text-[10px] font-extrabold uppercase tracking-wide ${
                              isSpecificPerson
                                ? 'bg-purple-100 text-purple-800 border border-purple-200'
                                : 'bg-blue-100 text-blue-800 border border-blue-200'
                            }`}
                          >
                            {isSpecificPerson ? 'Specific Person' : 'General Office Visit'}
                          </span>

                          {/* Attendance Status Badge */}
                          <span
                            className={`rounded-md px-2 py-0.5 text-[10px] font-bold ${
                              visit.attendanceStatus === 'confirmed'
                                ? 'bg-emerald-100 text-emerald-800'
                                : visit.attendanceStatus === 'awaiting_office_confirmation'
                                ? 'bg-amber-100 text-amber-800 font-extrabold animate-pulse'
                                : visit.attendanceStatus === 'exited_unconfirmed'
                                ? 'bg-red-100 text-red-800'
                                : 'bg-gray-100 text-gray-700'
                            }`}
                          >
                            {visit.attendanceStatus.replace(/_/g, ' ')}
                          </span>
                        </div>

                        {isSpecificPerson && visit.personnelName && (
                          <p className="text-xs font-semibold text-[#7A0A0A] flex items-center gap-1">
                            <UserCheck className="h-3.5 w-3.5" />
                            <span>Requested Appointment with: <strong>{visit.personnelName}</strong> ({visit.personnelTitle || 'Personnel'})</span>
                          </p>
                        )}

                        <p className="text-xs text-[var(--color-text-secondary)]">
                          <strong>Purpose:</strong> {visit.purpose}
                        </p>

                        <div className="flex flex-wrap items-center gap-4 text-[11px] text-[var(--color-text-muted)] pt-1">
                          <span className="flex items-center gap-1">
                            <Calendar className="h-3 w-3" />
                            Visit Date: {visit.visitDate}
                          </span>
                          <span className="flex items-center gap-1">
                            <Phone className="h-3 w-3" />
                            {visit.visitorContactNumber}
                          </span>
                          {visit.visitorEmail && (
                            <span className="flex items-center gap-1">
                              <Mail className="h-3 w-3" />
                              {visit.visitorEmail}
                              {visit.emailDeliveryStatus === 'sent' && (
                                <span className="ml-1 rounded px-1.5 py-0.2 bg-emerald-100 text-emerald-800 text-[10px] font-bold">
                                  Email Sent
                                </span>
                              )}
                              {(visit.emailDeliveryStatus === 'failed' || visit.emailDeliveryStatus === 'unknown') && (
                                <span className="ml-1 rounded px-1.5 py-0.2 bg-red-100 text-red-800 text-[10px] font-bold">
                                  Email {visit.emailDeliveryStatus === 'failed' ? 'Failed' : 'Pending/Unknown'}
                                </span>
                              )}
                            </span>
                          )}
                          <span className="flex items-center gap-1">
                            <Clock className="h-3 w-3" />
                            Requested: {formatManilaTime(visit.createdAt)}
                          </span>
                        </div>
                      </div>
                    </div>

                    {/* Action Buttons based on status */}
                    <div className="flex flex-wrap items-center gap-2 pt-2 sm:pt-0">
                      {visit.approvalStatus === 'approved' &&
                        (visit.emailDeliveryStatus === 'failed' || visit.emailDeliveryStatus === 'unknown') && (
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => handleRetryEmail(visit.id)}
                            loading={retryingEmailVisitId === visit.id}
                            icon={<Mail className="h-3.5 w-3.5 text-red-600" />}
                            className="border-red-200 bg-red-50 text-red-800 hover:bg-red-100 text-xs font-semibold"
                          >
                            Retry Email
                          </Button>
                        )}
                      {activeQueue === 'pending' && isSpecificPerson && (
                        <>
                          <Button
                            variant="primary"
                            size="sm"
                            onClick={() => setApproveModalVisit(visit)}
                            icon={<CheckCircle2 className="h-4 w-4" />}
                            className="bg-emerald-600 hover:bg-emerald-700 text-white"
                          >
                            Approve & Issue Pass
                          </Button>
                          <Button
                            variant="destructive"
                            size="sm"
                            onClick={() => {
                              setRejectModalVisit(visit);
                              setRejectionReason('');
                            }}
                            icon={<XCircle className="h-4 w-4" />}
                          >
                            Reject
                          </Button>
                        </>
                      )}

                      {activeQueue === 'awaiting_confirmation' && (
                        <Button
                          variant="primary"
                          size="md"
                          onClick={() => setConfirmArrivalVisit(visit)}
                          icon={<CheckCircle2 className="h-5 w-5" />}
                          className="bg-emerald-600 hover:bg-emerald-700 text-white font-bold shadow-md"
                        >
                          Confirm Office Arrival
                        </Button>
                      )}

                      {activeQueue === 'confirmed' && (
                        <div className="rounded-xl bg-emerald-50 border border-emerald-200 px-3 py-1.5 text-right">
                          <span className="text-[11px] font-bold text-emerald-800 flex items-center gap-1 justify-end">
                            <CheckCircle2 className="h-3.5 w-3.5" /> Arrived at Office
                          </span>
                          <span className="text-[10px] text-emerald-600">
                            Confirmed at {formatManilaTime(visit.confirmedAt)}
                          </span>
                        </div>
                      )}

                      {activeQueue === 'history' && visit.rejectionReason && (
                        <div className="rounded-xl bg-red-50 border border-red-200 px-3 py-1.5 max-w-xs text-xs text-red-800">
                          <span className="font-bold">Rejection Reason:</span>
                          <p className="text-[11px] mt-0.5">{visit.rejectionReason}</p>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </main>

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
            Please provide a mandatory reason for rejecting the visit request from <strong>{rejectModalVisit?.visitorDisplayName || rejectModalVisit?.visitorFullName}</strong>. This explanation will be included in the polite rejection notice emailed to the visitor.
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
              placeholder="e.g. The requested personnel is attending an off-campus seminar today. Please reschedule for tomorrow."
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
            <p><strong>Gate Entry Recorded:</strong> Yes (Visitor is currently inside campus)</p>
          </div>

          <p className="text-xs text-[var(--color-text-muted)]">
            Confirming arrival marks their visit as attended, ensuring campus security will allow normal exit without attendance exception warnings.
          </p>

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
          {/* Add Personnel Form */}
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
              >
                Add Personnel
              </Button>
            </div>
          </form>

          {/* Directory List */}
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
                      onClick={() => handleTogglePersonnel(person)}
                      className={`rounded-full px-2.5 py-1 text-[10px] font-bold transition-colors ${
                        person.active
                          ? 'bg-emerald-100 text-emerald-800 hover:bg-emerald-200'
                          : 'bg-zinc-100 text-zinc-600 hover:bg-zinc-200'
                      }`}
                    >
                      {person.active ? 'Active' : 'Inactive'}
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
