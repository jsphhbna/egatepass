import { useState, useEffect, useCallback, useRef } from 'react';
import { Link } from 'react-router-dom';
import {
  Clock,
  CheckCircle2,
  XCircle,
  AlertCircle,
  ArrowLeft,
  Copy,
  Check,
  RefreshCw,
  Building2,
  User,
  Calendar,
  Car,
  FileText,
  Shield,
  Search,
} from 'lucide-react';
import { Button, Card, Input } from '@/components/ui';

interface TrackingData {
  approvalStatus: 'pending' | 'approved' | 'rejected';
  attendanceStatus: 'expected' | 'arrived' | 'departed' | 'cancelled';
  officeName: string;
  personnelName: string | null;
  purpose: string;
  visitDate: string;
  arrivalMode: 'no_vehicle' | 'vehicle';
  maskedVisitorName: string;
  rejectionReason: string | null;
  submittedAt: string;
  decidedAt: string | null;
}

interface FetchError {
  title: string;
  message: string;
  isExpired?: boolean;
  isRateLimited?: boolean;
}

function parseTokenFromHash(): string {
  if (typeof window === 'undefined') return '';
  const hash = window.location.hash.replace(/^#/, '');
  if (!hash) return '';
  const params = new URLSearchParams(hash);
  return (params.get('t') || params.get('token') || hash).trim();
}

function formatDate(isoString: string | null): string {
  if (!isoString) return '—';
  try {
    const d = new Date(isoString);
    return d.toLocaleString('en-US', {
      timeZone: 'Asia/Manila',
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: true,
    });
  } catch {
    return isoString;
  }
}

export function TrackVisitPage() {
  const [tokenInput, setTokenInput] = useState('');
  const [activeToken, setActiveToken] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<TrackingData | null>(null);
  const [error, setError] = useState<FetchError | null>(null);
  const [copied, setCopied] = useState(false);
  const [lastRefreshedAt, setLastRefreshedAt] = useState<Date | null>(null);
  const autoRefreshTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Initialize token from hash on mount
  useEffect(() => {
    const tokenFromUrl = parseTokenFromHash();
    if (tokenFromUrl) {
      setActiveToken(tokenFromUrl);
      setTokenInput(tokenFromUrl);
    }

    const handleHashChange = () => {
      const updated = parseTokenFromHash();
      if (updated && updated !== activeToken) {
        setActiveToken(updated);
        setTokenInput(updated);
      }
    };

    window.addEventListener('hashchange', handleHashChange);
    return () => window.removeEventListener('hashchange', handleHashChange);
  }, []);

  const fetchStatus = useCallback(async (token: string, isManual = false) => {
    if (!token) return;
    setLoading(true);
    if (isManual) setError(null);

    try {
      const res = await fetch('/api/passes/track', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: JSON.stringify({ token }),
      });

      const body = await res.json().catch(() => null);

      if (res.status === 200 && body?.ok && body.tracking) {
        setData(body.tracking);
        setError(null);
        setLastRefreshedAt(new Date());
      } else if (res.status === 404) {
        setData(null);
        setError({
          title: 'Visit Request Not Found',
          message: 'The tracking link is invalid or the request no longer exists. Please double-check your link or contact the office.',
        });
      } else if (res.status === 410) {
        setData(null);
        setError({
          title: 'Tracking Link Expired',
          message: 'This tracking link has expired. Tracking links are maintained for 30 days after submission.',
          isExpired: true,
        });
      } else if (res.status === 429) {
        setError({
          title: 'Too Many Requests',
          message: 'You have made too many status inquiries recently. Please wait a moment before trying again.',
          isRateLimited: true,
        });
      } else {
        setError({
          title: 'Unable to Load Status',
          message: body?.message || 'A network error occurred while checking request status. Please try again.',
        });
      }
    } catch {
      setError({
        title: 'Connection Error',
        message: 'Could not connect to the campus gate system. Please check your internet connection and try again.',
      });
    } finally {
      setLoading(false);
    }
  }, []);

  // Fetch when activeToken changes
  useEffect(() => {
    if (activeToken) {
      fetchStatus(activeToken);
    }
  }, [activeToken, fetchStatus]);

  // Setup auto-refresh for pending visits
  useEffect(() => {
    if (autoRefreshTimerRef.current) {
      clearInterval(autoRefreshTimerRef.current);
      autoRefreshTimerRef.current = null;
    }

    if (!activeToken || !data || data.approvalStatus !== 'pending') {
      return;
    }

    autoRefreshTimerRef.current = setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
        fetchStatus(activeToken);
      }
    }, 30000);

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible' && activeToken) {
        fetchStatus(activeToken);
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      if (autoRefreshTimerRef.current) clearInterval(autoRefreshTimerRef.current);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [activeToken, data, fetchStatus]);

  const handleManualSearch = (e: React.FormEvent) => {
    e.preventDefault();
    const clean = tokenInput.trim();
    if (!clean) return;
    window.location.hash = `t=${encodeURIComponent(clean)}`;
    setActiveToken(clean);
  };

  const handleCopyLink = () => {
    if (typeof window === 'undefined') return;
    const currentUrl = window.location.href;
    navigator.clipboard.writeText(currentUrl).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    }).catch(() => {
      // ignore clipboard error
    });
  };

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 flex flex-col justify-between selection:bg-amber-100 selection:text-amber-900">
      <header className="border-b border-slate-200 bg-white/95 backdrop-blur-sm sticky top-0 z-20">
        <div className="max-w-3xl mx-auto px-4 py-3.5 flex items-center justify-between">
          <Link to="/" className="flex items-center gap-3 group focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 rounded-lg p-1">
            <img src="/earist-logo.png" alt="EARIST Logo" className="h-10 w-10 object-contain drop-shadow-xs" />
            <div>
              <div className="flex items-center gap-2">
                <span className="font-black text-sm tracking-tight text-[#700f14] group-hover:text-amber-700 transition-colors">
                  EARIST E-GatePass
                </span>
                <span className="text-[10px] uppercase font-bold tracking-wider px-2 py-0.5 rounded-full bg-amber-50 text-amber-800 border border-amber-200">
                  Visitor Tracking
                </span>
              </div>
              <p className="text-[11px] text-slate-500 font-medium leading-none mt-0.5">
                Official Campus Appointment Status Portal
              </p>
            </div>
          </Link>

          <Link
            to="/"
            className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-600 hover:text-slate-900 transition-colors px-3 py-1.5 rounded-lg hover:bg-slate-100"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            <span>Home</span>
          </Link>
        </div>
      </header>

      <main id="main-content" className="flex-1 max-w-3xl w-full mx-auto px-4 py-8">
        {/* Token Search Bar (if not provided in hash or user wants to enter different token) */}
        {!activeToken && (
          <Card className="p-6 md:p-8 shadow-sm border-slate-200 bg-white mb-6">
            <div className="max-w-md mx-auto text-center space-y-4">
              <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-amber-100 text-amber-800">
                <Search className="h-7 w-7" />
              </div>
              <div>
                <h1 className="text-xl font-black text-slate-900 tracking-tight">Track Your Visit Request</h1>
                <p className="text-xs text-slate-600 mt-1.5">
                  Enter the private tracking code from your submission acknowledgement email to check the current review status.
                </p>
              </div>

              <form onSubmit={handleManualSearch} className="space-y-3 pt-2 text-left">
                <div>
                  <label htmlFor="token-input" className="block text-xs font-bold uppercase tracking-wider text-slate-700 mb-1.5">
                    Private Tracking Code
                  </label>
                  <Input
                    id="token-input"
                    type="text"
                    value={tokenInput}
                    onChange={(e) => setTokenInput(e.target.value)}
                    placeholder="e.g. gD73b_9A2xkLm..."
                    className="w-full font-mono text-xs"
                    required
                  />
                </div>
                <Button type="submit" className="w-full bg-[#700f14] hover:bg-[#851218] text-white">
                  Check Request Status
                </Button>
              </form>
            </div>
          </Card>
        )}

        {/* Loading State */}
        {loading && !data && (
          <div className="py-16 text-center space-y-3" role="status" aria-live="polite">
            <div className="mx-auto h-10 w-10 animate-spin rounded-full border-3 border-amber-200 border-t-[#700f14]" />
            <p className="text-sm font-semibold text-slate-700">Looking up visit request…</p>
            <p className="text-xs text-slate-500">Checking campus office registry</p>
          </div>
        )}

        {/* Error State */}
        {error && (
          <Card className="p-6 shadow-sm border-rose-200 bg-rose-50/50 mb-6">
            <div className="flex items-start gap-4">
              <div className="flex-shrink-0 flex h-10 w-10 items-center justify-center rounded-xl bg-rose-100 text-rose-700">
                <AlertCircle className="h-5 w-5" />
              </div>
              <div className="flex-1 min-w-0">
                <h2 className="text-sm font-bold text-rose-950">{error.title}</h2>
                <p className="text-xs text-rose-800 mt-1 leading-relaxed">{error.message}</p>
                <div className="mt-4 flex flex-wrap gap-2.5">
                  {activeToken && (
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => fetchStatus(activeToken, true)}
                      className="bg-white border-rose-300 text-rose-900 hover:bg-rose-100"
                    >
                      <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
                      Retry Check
                    </Button>
                  )}
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => {
                      setActiveToken('');
                      setTokenInput('');
                      window.location.hash = '';
                      setData(null);
                      setError(null);
                    }}
                    className="bg-white border-slate-300 text-slate-700 hover:bg-slate-50"
                  >
                    Enter Another Code
                  </Button>
                </div>
              </div>
            </div>
          </Card>
        )}

        {/* Tracking Details View */}
        {data && (
          <div className="space-y-6">
            {/* Status Header Banner */}
            <div
              className={`rounded-2xl border p-5 shadow-xs transition-colors ${
                data.approvalStatus === 'approved'
                  ? 'border-emerald-300 bg-emerald-50/80 text-emerald-950'
                  : data.approvalStatus === 'rejected'
                  ? 'border-rose-300 bg-rose-50/80 text-rose-950'
                  : 'border-amber-300 bg-amber-50/80 text-amber-950'
              }`}
            >
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
                <div className="flex items-center gap-3.5">
                  <div
                    className={`flex h-12 w-12 items-center justify-center rounded-2xl ${
                      data.approvalStatus === 'approved'
                        ? 'bg-emerald-600 text-white'
                        : data.approvalStatus === 'rejected'
                        ? 'bg-rose-600 text-white'
                        : 'bg-amber-500 text-white animate-pulse'
                    }`}
                  >
                    {data.approvalStatus === 'approved' && <CheckCircle2 className="h-6 w-6" />}
                    {data.approvalStatus === 'rejected' && <XCircle className="h-6 w-6" />}
                    {data.approvalStatus === 'pending' && <Clock className="h-6 w-6" />}
                  </div>

                  <div>
                    <span className="text-[10px] font-black uppercase tracking-wider block opacity-75">
                      Request Status
                    </span>
                    <h1 className="text-lg font-black tracking-tight leading-tight">
                      {data.approvalStatus === 'approved' && 'Visit Request Approved'}
                      {data.approvalStatus === 'rejected' && 'Visit Request Declined'}
                      {data.approvalStatus === 'pending' && 'Pending Office Review'}
                    </h1>
                    <p className="text-xs opacity-90 mt-0.5">
                      {data.approvalStatus === 'approved' && 'Your appointment has been authorized by the designated office.'}
                      {data.approvalStatus === 'rejected' && 'The requested office was unable to accommodate this appointment.'}
                      {data.approvalStatus === 'pending' && 'Queued for review by office staff. This page refreshes automatically.'}
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-2 self-start sm:self-auto">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => fetchStatus(activeToken, true)}
                    disabled={loading}
                    className="bg-white/80 hover:bg-white text-xs border-current"
                  >
                    <RefreshCw className={`h-3 w-3 mr-1.5 ${loading ? 'animate-spin' : ''}`} />
                    Refresh
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={handleCopyLink}
                    className="bg-white/80 hover:bg-white text-xs border-current"
                    title="Copy private tracking link"
                  >
                    {copied ? (
                      <>
                        <Check className="h-3 w-3 mr-1.5 text-emerald-600" />
                        <span>Copied!</span>
                      </>
                    ) : (
                      <>
                        <Copy className="h-3 w-3 mr-1.5" />
                        <span>Copy Link</span>
                      </>
                    )}
                  </Button>
                </div>
              </div>

              {lastRefreshedAt && (
                <div className="mt-3 pt-3 border-t border-black/10 flex items-center justify-between text-[11px] opacity-75">
                  <span>Last synchronized: {lastRefreshedAt.toLocaleTimeString()}</span>
                  {data.approvalStatus === 'pending' && (
                    <span className="flex items-center gap-1 font-medium">
                      <span className="h-1.5 w-1.5 rounded-full bg-amber-500 animate-ping" />
                      Auto-checking every 30s
                    </span>
                  )}
                </div>
              )}
            </div>

            {/* Visual 4-Step Timeline */}
            <Card className="p-5 md:p-6 shadow-sm border-slate-200 bg-white">
              <h2 className="text-xs font-bold uppercase tracking-wider text-slate-500 mb-4">
                Appointment Workflow
              </h2>

              <ol className="relative border-l-2 border-slate-200 ml-3.5 space-y-6">
                {/* Step 1: Submission */}
                <li className="relative pl-6">
                  <span className="absolute -left-[9px] top-0 flex h-4 w-4 items-center justify-center rounded-full bg-emerald-500 ring-4 ring-white">
                    <Check className="h-2.5 w-2.5 text-white" />
                  </span>
                  <div>
                    <h3 className="text-xs font-bold text-slate-900">Request Submitted</h3>
                    <p className="text-[11px] text-slate-500 mt-0.5">
                      Submitted on {formatDate(data.submittedAt)}
                    </p>
                  </div>
                </li>

                {/* Step 2: Office Review */}
                <li className="relative pl-6">
                  <span
                    className={`absolute -left-[9px] top-0 flex h-4 w-4 items-center justify-center rounded-full ring-4 ring-white ${
                      data.approvalStatus === 'pending'
                        ? 'bg-amber-500 animate-pulse'
                        : 'bg-emerald-500'
                    }`}
                  >
                    {data.approvalStatus === 'pending' ? (
                      <span className="h-1.5 w-1.5 rounded-full bg-white" />
                    ) : (
                      <Check className="h-2.5 w-2.5 text-white" />
                    )}
                  </span>
                  <div>
                    <h3 className="text-xs font-bold text-slate-900">Office Review</h3>
                    <p className="text-[11px] text-slate-500 mt-0.5">
                      {data.approvalStatus === 'pending'
                        ? `Awaiting staff review at ${data.officeName}`
                        : `Reviewed by ${data.officeName}`}
                    </p>
                  </div>
                </li>

                {/* Step 3: Decision */}
                <li className="relative pl-6">
                  <span
                    className={`absolute -left-[9px] top-0 flex h-4 w-4 items-center justify-center rounded-full ring-4 ring-white ${
                      data.approvalStatus === 'approved'
                        ? 'bg-emerald-500'
                        : data.approvalStatus === 'rejected'
                        ? 'bg-rose-500'
                        : 'bg-slate-300'
                    }`}
                  >
                    {data.approvalStatus === 'approved' && <Check className="h-2.5 w-2.5 text-white" />}
                    {data.approvalStatus === 'rejected' && <XCircle className="h-2.5 w-2.5 text-white" />}
                    {data.approvalStatus === 'pending' && <span className="h-1.5 w-1.5 rounded-full bg-slate-400" />}
                  </span>
                  <div>
                    <h3 className="text-xs font-bold text-slate-900">
                      {data.approvalStatus === 'approved' && 'Request Approved'}
                      {data.approvalStatus === 'rejected' && 'Request Declined'}
                      {data.approvalStatus === 'pending' && 'Decision Pending'}
                    </h3>
                    <p className="text-[11px] text-slate-500 mt-0.5">
                      {data.decidedAt ? `Decided on ${formatDate(data.decidedAt)}` : 'Office personnel will evaluate availability'}
                    </p>
                  </div>
                </li>

                {/* Step 4: Gate Entry Pass */}
                <li className="relative pl-6">
                  <span
                    className={`absolute -left-[9px] top-0 flex h-4 w-4 items-center justify-center rounded-full ring-4 ring-white ${
                      data.approvalStatus === 'approved'
                        ? 'bg-emerald-500'
                        : 'bg-slate-300'
                    }`}
                  >
                    {data.approvalStatus === 'approved' ? (
                      <Check className="h-2.5 w-2.5 text-white" />
                    ) : (
                      <span className="h-1.5 w-1.5 rounded-full bg-slate-400" />
                    )}
                  </span>
                  <div>
                    <h3 className="text-xs font-bold text-slate-900">Digital Gate Pass Issuance</h3>
                    <p className="text-[11px] text-slate-500 mt-0.5">
                      {data.approvalStatus === 'approved'
                        ? 'Emailed directly to your registered email address with an entry QR code'
                        : 'QR entry passes are only generated once approved'}
                    </p>
                  </div>
                </li>
              </ol>
            </Card>

            {/* Rejection Notice (if rejected) */}
            {data.approvalStatus === 'rejected' && (
              <div className="rounded-2xl border border-rose-200 bg-rose-50/70 p-4 text-xs text-rose-950 space-y-1.5">
                <span className="font-bold text-rose-900 flex items-center gap-1.5">
                  <XCircle className="h-4 w-4" />
                  Office Reason for Decision
                </span>
                <p className="leading-relaxed pl-5 font-medium">
                  {data.rejectionReason || 'No specific explanation was provided by the office.'}
                </p>
              </div>
            )}

            {/* Approved Pass Notice */}
            {data.approvalStatus === 'approved' && (
              <div className="rounded-2xl border border-emerald-200 bg-emerald-50/70 p-4 text-xs text-emerald-950 space-y-2">
                <span className="font-bold text-emerald-900 flex items-center gap-1.5">
                  <Shield className="h-4 w-4 text-emerald-700" />
                  Important: Campus Gate Entry Pass
                </span>
                <p className="leading-relaxed">
                  Your entry pass containing the official QR code has been dispatched to your email address.
                  Please have the QR code ready on your phone or printed out to present to security personnel at the gate.
                </p>
                <p className="leading-relaxed text-[11px] text-emerald-800 italic">
                  Note: For security and physical entry control, scannable QR passes are never displayed on this public tracking page.
                </p>
              </div>
            )}

            {/* Request Summary Card */}
            <Card className="p-5 md:p-6 shadow-sm border-slate-200 bg-white space-y-4">
              <div className="border-b border-slate-100 pb-3 flex items-center justify-between">
                <span className="text-xs font-bold uppercase tracking-wider text-slate-500">
                  Appointment Details
                </span>
                <span className="text-xs font-semibold text-slate-600">
                  Visitor: <strong className="text-slate-900">{data.maskedVisitorName}</strong>
                </span>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs">
                <div className="flex items-start gap-3">
                  <Building2 className="h-4 w-4 text-slate-400 flex-shrink-0 mt-0.5" />
                  <div>
                    <span className="text-slate-500 block">Destination Office</span>
                    <p className="font-bold text-slate-900 mt-0.5">{data.officeName}</p>
                  </div>
                </div>

                <div className="flex items-start gap-3">
                  <User className="h-4 w-4 text-slate-400 flex-shrink-0 mt-0.5" />
                  <div>
                    <span className="text-slate-500 block">Requested Personnel</span>
                    <p className="font-bold text-[#700f14] mt-0.5">
                      {data.personnelName || 'General Office Staff'}
                    </p>
                  </div>
                </div>

                <div className="flex items-start gap-3">
                  <Calendar className="h-4 w-4 text-slate-400 flex-shrink-0 mt-0.5" />
                  <div>
                    <span className="text-slate-500 block">Scheduled Visit Date</span>
                    <p className="font-bold text-slate-900 mt-0.5">{data.visitDate}</p>
                  </div>
                </div>

                <div className="flex items-start gap-3">
                  <Car className="h-4 w-4 text-slate-400 flex-shrink-0 mt-0.5" />
                  <div>
                    <span className="text-slate-500 block">Arrival Mode</span>
                    <p className="font-bold text-slate-900 mt-0.5">
                      {data.arrivalMode === 'vehicle' ? 'With Declared Vehicle' : 'On Foot / Commute'}
                    </p>
                  </div>
                </div>
              </div>

              <div className="pt-2 border-t border-slate-100">
                <div className="flex items-start gap-3 text-xs">
                  <FileText className="h-4 w-4 text-slate-400 flex-shrink-0 mt-0.5" />
                  <div>
                    <span className="text-slate-500 block">Stated Purpose of Visit</span>
                    <p className="font-medium text-slate-800 mt-0.5 whitespace-pre-wrap leading-relaxed">
                      {data.purpose}
                    </p>
                  </div>
                </div>
              </div>
            </Card>

            {/* Privacy & Security Footer Info */}
            <div className="rounded-xl border border-slate-200 bg-slate-100/70 p-4 text-[11px] text-slate-600 space-y-1">
              <span className="font-bold text-slate-800 flex items-center gap-1.5">
                <Shield className="h-3.5 w-3.5 text-slate-500" />
                Privacy & Data Security Notice
              </span>
              <p className="leading-relaxed">
                This tracking page is accessible only through your unique private token. It reveals no personal identity documents, photos, biometrics, contact numbers, or home addresses. Keep your private tracking link confidential.
              </p>
            </div>
          </div>
        )}
      </main>

      <footer className="border-t border-slate-200 bg-white py-4 mt-8">
        <div className="max-w-3xl mx-auto px-4 flex flex-col sm:flex-row items-center justify-between gap-2 text-xs text-slate-500">
          <span>&copy; {new Date().getFullYear()} Eulogio &quot;Amang&quot; Rodriguez Institute of Science and Technology</span>
          <div className="flex items-center gap-4">
            <Link to="/" className="hover:text-slate-900 transition-colors">
              Portal Home
            </Link>
            <Link to="/get-pass" className="hover:text-slate-900 transition-colors">
              Get Pass
            </Link>
          </div>
        </div>
      </footer>
    </div>
  );
}

export default TrackVisitPage;
