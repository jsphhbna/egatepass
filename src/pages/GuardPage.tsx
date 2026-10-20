import { useEffect, useState, useRef } from 'react';
import {
  collection,
  query,
  where,
  orderBy,
  onSnapshot,
  doc,
  getDoc,
  limit,
} from 'firebase/firestore';
import { auth, db } from '@/lib/firebase';
import { signOut } from 'firebase/auth';
import { useAuth } from '@/hooks/useAuth';
import { AuthenticatedImage } from '@/components/AuthenticatedImage';
import type { GatePass } from '@/types';
import {
  CheckCircle2,
  XCircle,
  Clock,
  WifiOff,
  MapPin,
  User,
  Volume2,
  BarChart2,
  UserCheck,
  X,
  ZoomIn,
  LogOut,
} from 'lucide-react';
import { Button, Card, EmptyState, Input, Select, StatCard, Modal, ConfirmModal } from '@/components/ui';
import { BrandMark } from '@/components/BrandMark';
import { toast } from 'sonner';
import { GuardAccountMenu } from '@/components/GuardAccountMenu';
import { GuardPasswordResetModal } from '@/components/GuardPasswordResetModal';

interface PassWithId extends GatePass {
  id: string;
}

export function GuardPage() {
  const { userData } = useAuth();
  const [passes, setPasses] = useState<PassWithId[]>([]);
  const [queueError, setQueueError] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  const [rejectionReasons, setRejectionReasons] = useState<string[]>([]);
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  const [zoomImage, setZoomImage] = useState<string | null>(null);
  const [isRejecting, setIsRejecting] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const previousPendingCountRef = useRef(0);

  // Daily Report stats
  const [dailyStats, setDailyStats] = useState({
    inside: 0,
    exited: 0,
    rejected: 0,
    total: 0,
  });

  const [showPasswordReset, setShowPasswordReset] = useState(false);

  const [showSignOutModal, setShowSignOutModal] = useState(false);
  const [isSigningOut, setIsSigningOut] = useState(false);

  // ============================================================
  // LOAD PREMADE REJECTION REASONS FROM settings/app
  // ============================================================
  useEffect(() => {
    async function loadSettings() {
      const settingsSnap = await getDoc(doc(db, 'settings', 'app'));
      if (settingsSnap.exists()) {
        const data = settingsSnap.data();
        if (Array.isArray(data.rejectionReasons)) {
          setRejectionReasons(data.rejectionReasons);
        }
      }
    }
    loadSettings();
  }, []);

  // ============================================================
  // REAL-TIME LISTENER: pending passes
  // ============================================================
  useEffect(() => {
    const q = query(
      collection(db, 'gatePasses'),
      where('status', '==', 'pending'),
      orderBy('scannedAt', 'asc'),
      limit(50)
    );

    const unsub = onSnapshot(
      q,
      (snap) => {
        setQueueError(false);
        const list: PassWithId[] = [];
        snap.forEach((docSnap) => {
          list.push({ id: docSnap.id, ...docSnap.data() } as PassWithId);
        });

        // Play alert sound for new entries
        if (list.length > previousPendingCountRef.current && audioRef.current) {
          audioRef.current.play().catch(() => {});
        }

        previousPendingCountRef.current = list.length;
        setPasses(list);
      },
      (error) => {
        console.error('Guard listener error:', error);
        setQueueError(true);
      }
    );

    return unsub;
  }, []);

  // ============================================================
  // REAL-TIME LISTENER: daily report stats
  // ============================================================
  useEffect(() => {
    // Get start of today
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    const q = query(
      collection(db, 'gatePasses'),
      where('issuedAt', '>=', startOfToday)
    );

    const unsub = onSnapshot(
      q,
      (snap) => {
        let inside = 0;
        let exited = 0;
        let rejected = 0;
        let total = 0;

        snap.forEach((docSnap) => {
          const pass = docSnap.data() as GatePass;
          total++;
          if (pass.status === 'inside') inside++;
          else if (pass.status === 'exited') exited++;
          else if (pass.status === 'rejected') rejected++;
        });

        setDailyStats({ inside, exited, rejected, total });
      },
      (error) => {
        console.error('Daily stats listener error:', error);
      }
    );

    return unsub;
  }, []);

  // ============================================================
  // ONLINE/OFFLINE DETECTION
  // ============================================================
  useEffect(() => {
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  // ============================================================
  // APPROVE
  // ============================================================
  async function handleApprove(pass: PassWithId) {
    try {
      await recordDecision(pass.id, 'approved');

      toast.success(`${pass.visitorName} approved`);
    } catch (err) {
      console.error('Approve error:', err);
      toast.error('Failed to approve. Try again.');
    }
  }

  async function recordDecision(passId: string, decision: 'approved' | 'rejected', reason: string | null = null) {
    const token = await auth.currentUser?.getIdToken();
    if (!token) throw new Error('Your session has expired. Please sign in again.');

    const response = await fetch('/.netlify/functions/decide-visit', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ passId, decision, reason }),
    });
    const responseBody = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(responseBody.error || 'Failed to record the visitor decision');
    }
  }

  // ============================================================
  // REJECT
  // ============================================================
  async function handleReject(pass: PassWithId) {
    if (!rejectReason.trim()) {
      toast.error('Select or type a rejection reason.');
      return;
    }

    try {
      await recordDecision(pass.id, 'rejected', rejectReason);

      toast.success(`${pass.visitorName} rejected`);
      setRejectingId(null);
      setRejectReason('');
      setIsRejecting(false);
    } catch (err) {
      console.error('Reject error:', err);
      toast.error('Failed to reject. Try again.');
    }
  }

  // ============================================================
  // FILTER
  // ============================================================
  const filteredPasses = searchTerm
    ? passes.filter(
        (p) =>
          (p.visitorName ?? '').toLowerCase().includes(searchTerm.toLowerCase()) ||
          (p.purpose ?? '').toLowerCase().includes(searchTerm.toLowerCase())
      )
    : passes;

  // ============================================================
  // PENDING AGE — highlight if > 30 seconds
  // ============================================================
  function isPendingLong(pass: PassWithId): boolean {
    if (!pass.scannedAt) return false;
    const scannedMs = pass.scannedAt.toMillis();
    return Date.now() - scannedMs > 30000;
  }

  // ============================================================
  // ============================================================
  // AUTH ACTIONS
  // ============================================================
  async function handleSignOut() {
    setIsSigningOut(true);
    try {
      await signOut(auth);
    } catch (err) {
      toast.error('Failed to sign out');
    } finally {
      setIsSigningOut(false);
      setShowSignOutModal(false);
    }
  }

  // ============================================================
  // RENDER
  // ============================================================
  return (
    <main id="main-content" className="mx-auto min-h-dvh max-w-screen-2xl bg-[var(--color-canvas)] p-4 sm:p-6 lg:p-8">
      {/* Simple beep audio — we generate it programmatically to avoid external files */}
      <audio ref={audioRef} preload="auto">
        <source
          src="data:audio/wav;base64,UklGRnoGAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YVoGAACAgICAgICAgICAgICAgICAgICAgICAgICAf3+AgYGCgoODhISFhYaGhoaGhoWFhISEg4OCgoGBgICAgIB/f39+fn59fX19fX19fX1+fn5/f3+AgIGBgoKDg4ODhISEhISEhISDg4OCgoGBgIB/f39+fn59fX19fX19fn5+f39/gICBgYKCg4ODg4OEhISEhISDg4OCgoGBgIB/f39+fn59fX19fX19fn5+f3+AgIGBgoKDg4OEhISEhISDg4OCgoGBgH9/f35+fn19fX19fX1+fn5/gICBgYKCg4ODhIWFhYWFhISEg4OCgoGBgICAf39/fn5+fX19fX19fX5+fn9/f4CAgYGCgoODg4SEhISDg4ODgoKBgYCAf39/fn5+fX19fX19fn5+fn9/f4CAgYGCgoODg4SEhISEhISDg4KCgYGAf39/fn5+fX19fX19fn5+fn9/gICBgYKCg4ODhISEhISEhIODgoKBgYB/f39+fn59fX19fn5+fn5/f3+AgIGBgoKCg4OEhISEhISDg4OCgoGBgIB/f39+fn59fX19fn5+fn9/f4CAgICBgoKDg4SEhISEhISDg4OCgoGBgIB/f39+fn5+fX1+fn5+fn9/gICAgYGCgoODg4SEhISEg4ODgoKBgYGAf39/fn5+fn19fn5+fn5/f4CAgIGBgoKDg4OEhISEhIODgoKBgYGAf39+fn5+fn19fn5+fn9/f4CAgIGBgoKDg4OEhISEg4ODgoKBgYGAf39/fn5+fn5+fn5+fn9/gICAgYGCgoODg4OEhISDg4OCgoGBgIB/f39+fn5+fn5+fn5/f3+AgIGBgYKCg4ODhISDg4ODgoKBgYCAf39/fn5+fn5+fn5+f39/gICBgYGCgoODg4OEg4ODg4KCgYGAgH9/f35+fn5+fn5+fn9/gICAgYGBgoKDg4ODg4ODg4KCgYGBgH9/f35+fn5+fn5+f39/gICBgYGCgoKDg4ODg4ODgoKBgYGAf39/fn5+fn5+fn5/f39/gICBgYGCgoKDg4ODg4OCgoKBgYGAf39/fn5+fn5+fn5/f3+AgICBgYGCgoKDg4ODg4OCgoGBgYCAf39/fn5+fn5+fn9/f3+AgICBgYGCgoKDg4ODgoKCgoGBgICAf39/fn5+fn5+fn9/f3+AgICBgYGCgoKDg4OCgoKCgYGBgIB/f39+fn5+fn5+f39/f4CAgICBgYGCgoKDg4OCgoKBgYGBgH9/f35+fn5+fn9/f39/gICAgIGBgYKCgoODg4KCgoGBgYGAf39/fn5+fn5+f39/f3+AgICAgYGBgoKCg4KCgoKBgYGAgH9/f35+fn5+fn9/f39/gICAgIGBgYKCgoKCgoKCgYGBgICAf39/fn5+fn5/f39/f4CAgICBgYGBgoKCgoKCgoGBgYCAgH9/f39+fn5+f39/f3+AgICAgICBgYGCgoKCgoKBgYGBgICAf39/fn5+fn9/f39/f4CAgICBgYGBgoKCgoKCgYGBgYCAgH9/f39+fn5/f39/f3+AgICAgIGBgYKCgoKCgoGBgYGAgIB/f39/fn5+f39/f39/gICAgICBgYGBgoKCgoKBgYGBgICAf39/f39+f39/f39/f4CAgICAgYGBgYKCgoKCgYGBgYCAgH9/f39/fn9/f39/f3+AgICAgICBgYGBgoKCgYGBgYGAgIB/f39/f39/f39/f39/gICAgICAgYGBgYKCgoGBgYGBgICAf39/f39/f39/f39/f4CAgICAgIGBgYGCgoGBgYGBgICAf39/f39/f39/f39/gICAgICAgIGBgYGBgoGBgYGBgICAf39/f39/f39/f39/gICAgICAgICBgYGBgYGBgYGBgICAf39/f39/f39/f39/gICAgICAgICBgYGBgYGBgYGAgICAf39/f39/f39/f39/f4CAgICAgICBgYGBgYGBgYCAgICAgH9/f39/f39/f39/f4CAgICAgICBgYGBgYGBgYCAgICAf39/f39/f39/f39/f4CAgICAgICBgYGBgYGBgICAgIB/f39/f39/f39/f3+AgICAgICAgIGBgYGBgYGAgICAgH9/f39/f39/f39/f4CAgICAgICAgYGBgYGBgICAgICAf39/f39/f39/f3+AgICAgICAgICBgYGBgYCAgICAgH9/f39/f39/f39/gICAgICAgICAgYGBgYCAgICAgIB/f39/f39/f39/f4CAgICAgICA"
          type="audio/wav"
        />
      </audio>

      {/* Offline Banner */}
      {!isOnline && (
        <div className="mb-4 flex items-center justify-center gap-2 rounded-md bg-[var(--color-danger)] px-4 py-2 text-sm font-semibold text-white" role="status">
          <WifiOff className="h-4 w-4" />
          Connection lost — data may be stale
        </div>
      )}

      {/* Header & Search */}
      <div className="mb-6 flex flex-col gap-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <p className="mb-1 text-xs font-bold uppercase tracking-widest text-[var(--color-brand)]">Campus security</p>
            <h1 className="text-2xl font-bold text-[var(--color-text-primary)]">
              Guard Queue
            </h1>
            <p className="mt-1 text-sm text-[var(--color-text-secondary)]">
              {passes.length} pending verification
              {passes.length !== 1 ? 's' : ''}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <GuardAccountMenu
              name={userData && 'name' in userData ? userData.name : 'Guard'}
              onResetPassword={() => setShowPasswordReset(true)}
            />
            <Button variant="destructive-outline" size="sm" onClick={() => setShowSignOutModal(true)} icon={<LogOut className="w-4 h-4" />}>
              Sign Out
            </Button>
          </div>
        </div>

        <div className="flex flex-col gap-3 sm:items-end mt-2">
          <div className="w-full sm:w-64">
            <Input
              type="search"
              aria-label="Search by name or purpose"
              placeholder="Search by name or purpose…"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
            />
          </div>
        </div>
      </div>

      {/* Daily Report Summary */}
      <div className="mb-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          title="Total Issued"
          value={dailyStats.total}
          icon={<BarChart2 className="h-5 w-5 text-[var(--color-text-secondary)]" />}
        />
        <StatCard
          title="Currently Inside"
          value={dailyStats.inside}
          icon={<UserCheck className="h-5 w-5 text-[var(--color-success)]" />}
          trend={`${dailyStats.inside} visitors on campus`}
          trendUp={true}
        />
        <StatCard
          title="Exited"
          value={dailyStats.exited}
          icon={<UserCheck className="h-5 w-5 text-[var(--color-text-secondary)]" />}
          trend={`${dailyStats.exited} left campus`}
          trendUp={false}
        />
        <StatCard
          title="Rejected"
          value={dailyStats.rejected}
          icon={<X className="h-5 w-5 text-[var(--color-danger)]" />}
        />
      </div>

      {/* Pass Cards */}
      {queueError ? (
        <EmptyState
          icon={<WifiOff className="h-8 w-8" />}
          title="Queue unavailable"
          description="The visitor queue could not be loaded. Check the connection and try again."
          className="min-h-64"
        />
      ) : filteredPasses.length === 0 ? (
        <EmptyState
          icon={<BrandMark size="sm" />}
          title={searchTerm ? 'No matching visitors' : 'No pending passes'}
          description={searchTerm ? 'Try a different name or purpose.' : 'New requests appear here after visitors scan at the entry gate.'}
          className="min-h-64"
        />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {filteredPasses.map((pass, index) => {
            const isActive = index === 0;

            if (isActive) {
              return (
                <Card
                  key={pass.id}
                  className={`col-span-full overflow-hidden transition-all motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-2 motion-safe:duration-200 ${
                    isPendingLong(pass) 
                      ? 'border-[var(--color-warning)] ring-1 ring-[var(--color-warning)]'
                      : ''
                  }`}
                >
                  {isPendingLong(pass) && (
                    <div className="flex items-center gap-2 border-b border-[var(--color-warning)] bg-[var(--color-warning-light)] px-4 py-3 text-sm font-bold text-[var(--color-warning-dark)]">
                      <Volume2 className="h-4 w-4" />
                      Pending for over 30 seconds
                    </div>
                  )}

                  <div className="p-6">
                    <div className="mb-6 grid gap-6 md:grid-cols-3">
                      {/* Panel 1: Info */}
                      <div className="flex flex-col justify-center border-b pb-6 md:border-b-0 md:border-r md:pb-0 md:pr-6 border-[var(--color-border)]">
                        <h3 className="text-2xl font-bold text-[var(--color-text-primary)]">
                          {pass.visitorName}
                        </h3>
                        <p className="mt-2 text-base text-[var(--color-text-secondary)]">
                          {pass.purpose}
                        </p>
                        <div className="mt-6 space-y-2">
                          <div className="flex items-center gap-2 text-sm text-[var(--color-text-muted)]">
                            <Clock className="h-4 w-4" />
                            <span>
                              Scanned: {pass.scannedAt ? new Date(pass.scannedAt.toMillis()).toLocaleTimeString() : '—'}
                            </span>
                          </div>
                          {pass.gate && (
                            <div className="flex items-center gap-2 text-sm text-[var(--color-text-muted)]">
                              <MapPin className="h-4 w-4" />
                              <span>Gate: {pass.gate}</span>
                            </div>
                          )}
                          <div className="flex items-center gap-2 text-sm text-[var(--color-text-muted)]">
                            <CheckCircle2 className="h-4 w-4" />
                            <span>
                              Valid: {new Date(pass.validFrom.toMillis()).toLocaleTimeString()} - {new Date(pass.validUntil.toMillis()).toLocaleTimeString()}
                            </span>
                          </div>
                        </div>
                      </div>

                      {/* Panel 2: Face Photo */}
                      <div className="flex flex-col items-center border-b pb-6 md:border-b-0 md:border-r md:pb-0 md:pr-6 border-[var(--color-border)]">
                        <span className="mb-3 text-xs font-bold uppercase tracking-wider text-[var(--color-text-muted)]">Live Photo</span>
                        <div 
                          className="group relative cursor-pointer rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-brand)]"
                          onClick={() => setZoomImage(pass.photoPublicId)}
                          role="button"
                          aria-label="Enlarge live photo"
                          tabIndex={0}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter' || event.key === ' ') setZoomImage(pass.photoPublicId);
                          }}
                        >
                          <AuthenticatedImage
                            publicId={pass.photoPublicId}
                            alt="Face Photo"
                            className="h-56 w-48 rounded-xl bg-[var(--color-overlay)] object-cover shadow-sm"
                          />
                          <div className="absolute inset-0 bg-black/0 group-hover:bg-black/10 transition-colors rounded-xl flex items-center justify-center">
                            <ZoomIn className="text-white opacity-0 group-hover:opacity-100 transition-opacity drop-shadow-md h-8 w-8" />
                          </div>
                        </div>
                      </div>

                      {/* Panel 3: ID Photo */}
                      <div className="flex flex-col items-center">
                        <span className="mb-3 text-xs font-bold uppercase tracking-wider text-[var(--color-text-muted)]">Valid ID</span>
                        {pass.idImagePublicId ? (
                          <div 
                            className="group relative w-full max-w-xs cursor-pointer rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-brand)]"
                            onClick={() => setZoomImage(pass.idImagePublicId!)}
                            role="button"
                            aria-label="Enlarge ID photo"
                            tabIndex={0}
                            onKeyDown={(event) => {
                              if ((event.key === 'Enter' || event.key === ' ') && pass.idImagePublicId) setZoomImage(pass.idImagePublicId);
                            }}
                          >
                            <AuthenticatedImage
                              publicId={pass.idImagePublicId}
                              alt="ID Photo"
                              className="h-56 w-full rounded-xl bg-[var(--color-overlay)] object-contain shadow-sm"
                            />
                            <div className="absolute inset-0 bg-black/0 group-hover:bg-black/10 transition-colors rounded-xl flex items-center justify-center">
                              <ZoomIn className="text-white opacity-0 group-hover:opacity-100 transition-opacity drop-shadow-md h-8 w-8" />
                            </div>
                          </div>
                        ) : (
                          <div className="flex h-56 w-full max-w-xs items-center justify-center rounded-xl border-2 border-dashed border-[var(--color-border)] bg-[var(--color-canvas)] text-sm font-medium text-[var(--color-text-muted)]">
                            No ID (Walk-in)
                          </div>
                        )}
                      </div>
                    </div>

                    {/* Actions */}
                      <div className="mx-auto flex max-w-md flex-col gap-3 sm:flex-row md:max-w-none">
                        <Button
                          variant="success"
                          onClick={() => handleApprove(pass)}
                          className="flex-1"
                          size="lg"
                          icon={<CheckCircle2 className="h-5 w-5" />}
                        >
                          Approve Visitor
                        </Button>
                        <Button
                          variant="destructive"
                          onClick={() => {
                            setRejectingId(pass.id);
                            setIsRejecting(true);
                          }}
                          className="flex-1"
                          size="lg"
                          icon={<XCircle className="h-5 w-5" />}
                        >
                          Reject
                        </Button>
                      </div>
                  </div>
                </Card>
              );
            }

            // ==========================================
            // COMPACT CARD (Queued Passes)
            // ==========================================
            return (
              <Card
                key={pass.id}
                className="overflow-hidden opacity-75 transition-opacity hover:opacity-100"
              >
                <div className="p-4">
                  <div className="flex items-center gap-3">
                    <div className="flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-full bg-[var(--color-neutral-light)]">
                      <User className="h-5 w-5 text-[var(--color-text-muted)]" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <h3 className="truncate text-sm font-bold text-[var(--color-text-primary)]">
                        {pass.visitorName}
                      </h3>
                      <p className="truncate text-xs text-[var(--color-text-secondary)] mt-0.5">
                        {pass.purpose}
                      </p>
                      <div className="mt-2 flex items-center gap-1.5 text-xs font-medium text-[var(--color-text-muted)]">
                        <Clock className="h-3 w-3" />
                        {pass.scannedAt ? new Date(pass.scannedAt.toMillis()).toLocaleTimeString() : '—'}
                        {pass.gate && ` • ${pass.gate}`}
                      </div>
                    </div>
                  </div>
                  <div className="mt-4 flex gap-2">
                    <Button
                      variant="success"
                      onClick={() => handleApprove(pass)}
                      className="flex-1"
                      size="sm"
                      icon={<CheckCircle2 className="h-4 w-4" />}
                    >
                      Approve
                    </Button>
                    <Button
                      variant="destructive"
                      onClick={() => {
                        setRejectingId(pass.id);
                        setIsRejecting(true);
                      }}
                      className="flex-1"
                      size="sm"
                      icon={<XCircle className="h-4 w-4" />}
                    >
                      Reject
                    </Button>
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      )}
      {/* Reject Modal */}
      <Modal
        isOpen={isRejecting}
        onClose={() => {
          setIsRejecting(false);
          setRejectReason('');
        }}
        title="Reject Visitor"
        size="sm"
      >
        <div className="space-y-4">
          <p className="text-sm text-[var(--color-text-secondary)]">
            Please provide a reason for rejection. This will be recorded in the audit logs.
          </p>
          <Select
            value={rejectReason}
            onChange={(e) => setRejectReason(e.target.value)}
            aria-label="Rejection reason"
          >
            <option value="">Select reason…</option>
            {rejectionReasons.map((reason) => (
              <option key={reason} value={reason}>
                {reason}
              </option>
            ))}
          </Select>
          <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
            <Button
              variant="secondary"
              onClick={() => {
                setIsRejecting(false);
                setRejectReason('');
              }}
              className="w-full sm:w-auto"
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                const pass = passes.find(p => p.id === rejectingId);
                if (pass) handleReject(pass);
              }}
              disabled={!rejectReason}
              className="w-full sm:w-auto"
            >
              Confirm Reject
            </Button>
          </div>
        </div>
      </Modal>

      {/* Image Zoom Modal */}
      <Modal
        isOpen={!!zoomImage}
        onClose={() => setZoomImage(null)}
        hideTitleRow
        size="lg"
      >
        {zoomImage && (
          <div className="flex items-center justify-center">
            <AuthenticatedImage
              publicId={zoomImage}
              alt="Zoomed"
              className="w-full h-auto max-h-[85vh] object-contain rounded-xl"
            />
          </div>
        )}
      </Modal>

      <GuardPasswordResetModal
        isOpen={showPasswordReset}
        email={auth.currentUser?.email || (userData && 'email' in userData ? userData.email || '' : '')}
        onClose={() => setShowPasswordReset(false)}
      />

      <ConfirmModal
        isOpen={showSignOutModal}
        onClose={() => setShowSignOutModal(false)}
        title="Confirm Sign Out"
        description="Are you sure you want to log out of your account?"
        onConfirm={handleSignOut}
        confirmText={isSigningOut ? "Signing Out..." : "Sign Out"}
        cancelText="Cancel"
        isDestructive={true}
        loading={isSigningOut}
      />
    </main>
  );
}
