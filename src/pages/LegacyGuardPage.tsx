import { formatManilaTime } from '@/lib/manilaTime';
import { useState, useRef } from 'react';
import { signOutCurrentActor } from '@/services/auth';
import { AuthenticatedImage } from '@/components/AuthenticatedImage';
import { recordDecision, GuardApiError, type GuardQueuePass } from '@/services/guard';
import { useGuardQueue } from '@/hooks/useGuardQueue';
import { RequestTimeoutError } from '@/lib/fetchWithTimeout';
import {
  CheckCircle2,
  XCircle,
  Clock,
  UserCheck,
  LogOut,
  Loader2,
  RefreshCw,
} from 'lucide-react';
import { Button, Card, EmptyState, Input, Select, StatCard, Modal, ConfirmModal } from '@/components/ui';
import { BrandMark } from '@/components/BrandMark';
import { toast } from 'sonner';

export function LegacyGuardPage() {
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const {
    passes,
    pendingTotal,
    hasMore,
    dailyStats,
    rejectionReasons,
    initialLoading,
    refreshing,
    lastUpdatedAt,
    refreshError,
    requestGuardQueueRefresh,
  } = useGuardQueue({
    onNewPendingPass: () => {
      if (audioRef.current) {
        audioRef.current.play().catch(() => undefined);
      }
    },
  });

  const [searchTerm, setSearchTerm] = useState('');
  const filteredPasses = searchTerm
    ? passes.filter((p) => p.visitorName.toLowerCase().includes(searchTerm.toLowerCase()))
    : passes;

  function handleLoadAll() {
    // load all passes
  }

  const refreshQueue = async () => {
    requestGuardQueueRefresh();
  };

  const [rejectingPass, setRejectingPass] = useState<GuardQueuePass | null>(null);
  const [processingPassIds, setProcessingPassIds] = useState<Set<string>>(new Set());
  const [rejectReason, setRejectReason] = useState('');
  const [isRejecting, setIsRejecting] = useState(false);
  const [showSignOutModal, setShowSignOutModal] = useState(false);
  const [isSigningOut, setIsSigningOut] = useState(false);

  async function handleApprove(pass: GuardQueuePass) {
    if (processingPassIds.has(pass.id)) return;
    setProcessingPassIds((prev) => new Set(prev).add(pass.id));

    try {
      await recordDecision(pass.id, 'approved');
      toast.success(`Approved entry for ${pass.visitorName}`);
      void refreshQueue();
    } catch (err: unknown) {
      if (err instanceof RequestTimeoutError) {
        toast.error('Approval request timed out. Outcome may be ambiguous; refreshing queue.');
        void refreshQueue();
        return;
      }
      if (err instanceof GuardApiError) {
        if (err.status === 409) {
          toast.info('This visitor was already processed by another guard.');
          void refreshQueue();
          return;
        }
        if (err.status === 422) {
          toast.info('This pass has expired and can no longer be approved.');
          void refreshQueue();
          return;
        }
        if (err.status === 401 || err.status === 403) {
          toast.error('Session expired or permission denied. Please sign in again.');
          return;
        }
      }
      toast.error('Failed to approve. Try again.');
    } finally {
      setProcessingPassIds((prev) => {
        const next = new Set(prev);
        next.delete(pass.id);
        return next;
      });
    }
  }

  async function handleConfirmReject() {
    if (!rejectingPass || isRejecting) return;
    setIsRejecting(true);
    try {
      await recordDecision(rejectingPass.id, 'rejected', rejectReason || null);
      toast.success(`Entry rejected for ${rejectingPass.visitorName}`);
      setRejectingPass(null);
      setRejectReason('');
      void refreshQueue();
    } catch (err: unknown) {
      if (err instanceof RequestTimeoutError) {
        toast.error('Rejection request timed out. Outcome may be ambiguous; refreshing queue.');
        void refreshQueue();
        return;
      }
      if (err instanceof GuardApiError) {
        if (err.status === 409) {
          toast.info('This visitor was already processed by another guard.');
          void refreshQueue();
          return;
        }
        if (err.status === 422) {
          toast.info('This pass has expired and can no longer be rejected.');
          void refreshQueue();
          return;
        }
        if (err.status === 401 || err.status === 403) {
          toast.error('Session expired or permission denied. Please sign in again.');
          return;
        }
      }
      toast.error('Failed to reject. Try again.');
    } finally {
      setIsRejecting(false);
    }
  }

  return (
    <div className="min-h-screen bg-[var(--color-canvas)] pb-12">
      <header className="border-b border-[var(--color-border)] bg-[var(--color-surface)] sticky top-0 z-20">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-4 py-3 sm:px-6">
          <div className="flex items-center gap-3">
            <BrandMark size="sm" />
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-base font-bold text-[var(--color-text-primary)]">Walk-in Review Station</h1>
                <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold text-amber-800">Legacy / Kiosk Approval</span>
              </div>
              <p className="text-xs text-[var(--color-text-secondary)]">Manual approval queue for kiosk walk-in passes</p>
              <div className="text-[11px] text-[var(--color-text-muted)] mt-0.5">
                {refreshing ? (
                  <span>Updating…</span>
                ) : refreshError && lastUpdatedAt ? (
                  <span>Connection delayed — showing queue from {formatManilaTime(lastUpdatedAt)}</span>
                ) : lastUpdatedAt ? (
                  <span>Updated {formatManilaTime(lastUpdatedAt)}</span>
                ) : null}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <Button size="sm" variant="secondary" onClick={() => requestGuardQueueRefresh()} icon={<RefreshCw className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`} />}>
              Refresh
            </Button>
            <Button size="sm" variant="destructive" onClick={() => setShowSignOutModal(true)} icon={<LogOut className="h-3.5 w-3.5" />}>
              Sign Out
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6">
        <div className="mb-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
          <StatCard title="Pending Review" value={pendingTotal} icon={<Clock className="h-5 w-5 text-amber-600" />} />
          <StatCard title="Inside Campus" value={dailyStats?.inside ?? 0} icon={<UserCheck className="h-5 w-5 text-blue-600" />} />
          <StatCard title="Exited Campus" value={dailyStats?.exited ?? 0} icon={<CheckCircle2 className="h-5 w-5 text-emerald-600" />} />
          <StatCard title="Rejected Today" value={dailyStats?.rejected ?? 0} icon={<XCircle className="h-5 w-5 text-rose-600" />} />
        </div>

        <div className="mb-4">
          <Input
            placeholder="Search pending visitors…"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
          />
        </div>

        {initialLoading ? (
          <div role="status" className="py-16 text-center">
            <Loader2 className="mx-auto h-8 w-8 animate-spin text-[var(--color-brand)]" />
            <p className="mt-3 text-sm font-medium text-[var(--color-text-secondary)]">Loading pending passes…</p>
          </div>
        ) : filteredPasses.length === 0 ? (
          <EmptyState
            icon={<CheckCircle2 className="h-12 w-12 text-emerald-600" />}
            title={searchTerm ? 'No matching pending visitors' : 'No pending passes'}
            description="All walk-in kiosk visitors have been processed. Online preregistered visitors enter automatically upon scanning."
          />
        ) : (
          <div className="space-y-6">
            <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
              {filteredPasses.map((pass) => (
              <Card key={pass.id} className="overflow-hidden p-5 flex flex-col justify-between">
                <div>
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <h2 className="text-base font-bold text-[var(--color-text-primary)]">{pass.visitorName}</h2>
                      <p className="text-xs text-[var(--color-text-secondary)] mt-0.5">Ref: {pass.publicReference ?? pass.id.slice(0, 8)}</p>
                    </div>
                    <span className="rounded-md bg-amber-50 px-2 py-0.5 text-xs font-semibold text-amber-700 border border-amber-200">Pending</span>
                  </div>

                  <div className="mt-4 flex gap-4">
                    {pass.photoPublicId && (
                      <div className="relative h-28 w-24 flex-shrink-0 overflow-hidden rounded-lg border border-[var(--color-border)] bg-slate-100">
                        <AuthenticatedImage publicId={pass.photoPublicId} alt={pass.visitorName} className="h-full w-full object-cover" />
                      </div>
                    )}
                    <div className="flex-1 space-y-1.5 text-xs">
                      <div><span className="font-semibold text-slate-500">Purpose:</span> {pass.purpose}</div>
                      <div><span className="font-semibold text-slate-500">Contact:</span> {pass.contactNumber ?? '—'}</div>
                      <div><span className="font-semibold text-slate-500">Source:</span> <span className="uppercase font-semibold">{pass.source}</span></div>
                      <div><span className="font-semibold text-slate-500">Scanned:</span> {formatManilaTime(pass.scannedAt)}</div>
                    </div>
                  </div>
                </div>

                <div className="mt-5 flex gap-2 pt-3 border-t border-[var(--color-border)]">
                  <Button
                    size="sm"
                    variant="destructive"
                    onClick={() => {
                      setRejectingPass(pass);
                      setRejectReason('');
                    }}
                    disabled={processingPassIds.has(pass.id)}
                    className="flex-1"
                    icon={<XCircle className="h-4 w-4" />}
                  >
                    Reject
                  </Button>
                  <Button
                    size="sm"
                    variant="primary"
                    onClick={() => handleApprove(pass)}
                    disabled={processingPassIds.has(pass.id)}
                    className="flex-1"
                    icon={<CheckCircle2 className="h-4 w-4" />}
                  >
                    Approve
                  </Button>
                </div>
              </Card>
            ))}
            </div>
            {hasMore && (
              <div className="flex justify-center pt-4">
                <Button variant="secondary" onClick={handleLoadAll}>
                  Load All Pending Passes
                </Button>
              </div>
            )}
          </div>
        )}
      </main>

      {/* Reject Modal */}
      <Modal
        isOpen={Boolean(rejectingPass)}
        onClose={() => setRejectingPass(null)}
        title="Reject Pass Entry"
        description={`Confirm rejection for ${rejectingPass?.visitorName}. State the specific reason.`}
        size="sm"
      >
        <div className="space-y-4">
          <div>
            <label className="block text-xs font-semibold text-[var(--color-text-secondary)] mb-1">
              Rejection Reason
            </label>
            <Select
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
            >
              <option value="">Select a reason…</option>
              {rejectionReasons.map((r) => (
                <option key={r} value={r}>{r}</option>
              ))}
              <option value="Other">Other</option>
            </Select>
          </div>

          <div className="flex gap-2 justify-end">
            <Button variant="secondary" onClick={() => setRejectingPass(null)}>Cancel</Button>
            <Button variant="destructive" onClick={handleConfirmReject} loading={isRejecting}>Confirm Rejection</Button>
          </div>
        </div>
      </Modal>

      {/* Sign Out Modal */}
      <ConfirmModal
        isOpen={showSignOutModal}
        onClose={() => setShowSignOutModal(false)}
        onConfirm={async () => {
          setIsSigningOut(true);
          await signOutCurrentActor();
          window.location.href = '/login';
        }}
        title="Sign Out"
        description="Are you sure you want to sign out of the review station?"
        confirmText="Sign Out"
        isDestructive={true}
        loading={isSigningOut}
      />
    </div>
  );
}
