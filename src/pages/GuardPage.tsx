import { useEffect, useState, useCallback, useRef } from 'react';
import { signOutCurrentActor } from '@/services/auth';
import { AuthenticatedImage } from '@/components/AuthenticatedImage';
import { formatManilaTime } from '@/lib/manilaTime';
import { BrandMark } from '@/components/BrandMark';
import { Card, Button, ConfirmModal } from '@/components/ui';
import {
  ShieldCheck,
  MapPin,
  RefreshCw,
  LogOut,
  UserCheck,
  Clock,
  Wifi,
  WifiOff,
  AlertCircle,
  CheckCircle2,
  FileText,
  Car,
} from 'lucide-react';

interface StationInfo {
  id: string;
  name: string;
  alias: string;
  gate: string;
}

interface StationEntry {
  passId: string;
  publicReference: string;
  status: string;
  source: 'portal' | 'kiosk';
  enteredAt: string;
  visitorName: string;
  purpose: string;
  photoEvidenceId: string | null;
  gate: string;
  vehicle?: {
    plateNumber: string;
    vehicleType: string;
    color: string;
    makeModel?: string | null;
    vehiclePhotoEvidenceId?: string | null;
    plateConflictFlag?: boolean;
  } | null;
}

interface FeedResponse {
  station: StationInfo;
  entries: StationEntry[];
}

export function GuardPage() {
  const [station, setStation] = useState<StationInfo | null>(null);
  const [entries, setEntries] = useState<StationEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  const [showSignOutModal, setShowSignOutModal] = useState(false);
  const [isSigningOut, setIsSigningOut] = useState(false);
  const pollIntervalRef = useRef<NodeJS.Timeout | null>(null);

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

  const fetchFeed = useCallback(async (isBackground = false) => {
    if (!isBackground) setRefreshing(true);
    try {
      const token = localStorage.getItem('egatepass_token') || sessionStorage.getItem('egatepass_token');
      const res = await fetch('/api/guard-station-feed', {
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          Accept: 'application/json',
        },
      });

      if (!res.ok) {
        if (res.status === 401 || res.status === 403) {
          setError('This station is not authenticated as an active Guard Station.');
        } else {
          setError('Station feed temporarily unavailable.');
        }
        return;
      }

      const data = (await res.json()) as FeedResponse;
      setStation(data.station);
      setEntries(data.entries);
      setError(null);
    } catch (err) {
      console.error('Failed to load guard station feed:', err);
      if (!isBackground) {
        setError('Network interruption. Please check connection.');
      }
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void fetchFeed();
    pollIntervalRef.current = setInterval(() => {
      void fetchFeed(true);
    }, 4000);

    return () => {
      if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
    };
  }, [fetchFeed]);

  const latestEntry = entries[0] || null;
  const recentEntries = entries.slice(1);

  return (
    <div className="min-h-screen bg-[var(--color-canvas)] text-[var(--color-text-primary)]">
      {/* Station Header */}
      <header className="border-b border-[var(--color-border)] bg-[var(--color-surface)] sticky top-0 z-20 shadow-xs">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-4 py-3 sm:px-6">
          <div className="flex items-center gap-3">
            <BrandMark size="sm" />
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-base font-bold sm:text-lg">
                  {station?.name || 'Guard Station'}
                </h1>
                <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2.5 py-0.5 text-xs font-semibold text-emerald-800">
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-600 animate-pulse" />
                  Active Station
                </span>
              </div>
              <p className="flex items-center gap-1.5 text-xs text-[var(--color-text-secondary)] mt-0.5">
                <MapPin className="h-3 w-3 text-[var(--color-brand)]" />
                Assigned Gate: <strong className="text-[var(--color-text-primary)]">{station?.gate || 'Detecting…'}</strong>
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <div className="hidden sm:flex items-center gap-1.5 text-xs text-[var(--color-text-muted)] border-r border-[var(--color-border)] pr-3">
              {isOnline ? (
                <span className="flex items-center gap-1 text-emerald-700">
                  <Wifi className="h-3.5 w-3.5" /> Online
                </span>
              ) : (
                <span className="flex items-center gap-1 text-rose-600 font-semibold">
                  <WifiOff className="h-3.5 w-3.5" /> Disconnected
                </span>
              )}
            </div>

            <Button
              size="sm"
              variant="secondary"
              onClick={() => fetchFeed()}
              disabled={refreshing}
              icon={<RefreshCw className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`} />}
            >
              Refresh
            </Button>

            <Button
              size="sm"
              variant="destructive"
              onClick={() => setShowSignOutModal(true)}
              icon={<LogOut className="h-3.5 w-3.5" />}
            >
              Station Sign Out
            </Button>
          </div>
        </div>
      </header>

      {/* Main Station Content */}
      <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6">
        {error && (
          <div className="mb-6 flex items-center gap-3 rounded-xl border border-[var(--color-danger)] bg-[var(--color-danger-light)] p-4 text-sm text-[var(--color-danger-dark)]" role="alert">
            <AlertCircle className="h-5 w-5 flex-shrink-0" />
            <div className="flex-1">
              <p className="font-semibold">{error}</p>
              <p className="text-xs mt-0.5">Check device enrollment and ensure this device is assigned type Guard Station.</p>
            </div>
            <Button size="sm" variant="secondary" onClick={() => fetchFeed()}>
              Retry
            </Button>
          </div>
        )}

        {loading ? (
          <div className="py-20 text-center">
            <RefreshCw className="mx-auto h-8 w-8 animate-spin text-[var(--color-brand)]" />
            <p className="mt-3 text-sm font-medium text-[var(--color-text-secondary)]">Connecting to station feed…</p>
          </div>
        ) : entries.length === 0 ? (
          <Card className="p-12 text-center max-w-lg mx-auto">
            <ShieldCheck className="mx-auto h-16 w-16 text-emerald-600" />
            <h2 className="mt-4 text-lg font-bold text-[var(--color-text-primary)]">
              Station Ready for Scans
            </h2>
            <p className="mt-1 text-sm text-[var(--color-text-secondary)]">
              Passes scanned at <strong>{station?.gate || 'this gate'}</strong> will display here immediately with the visitor's verified live registration photo.
            </p>
          </Card>
        ) : (
          <div className="grid gap-6 lg:grid-cols-12">
            {/* Left: Latest Arrival (Prominent Hero Photo View) */}
            <div className="lg:col-span-7">
              <Card className="overflow-hidden border-2 border-[var(--color-brand)] shadow-md">
                <div className="bg-[var(--color-brand)] px-5 py-3 text-white flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <UserCheck className="h-5 w-5" />
                    <span className="font-bold text-sm tracking-wide uppercase">Current Arrival</span>
                  </div>
                  <span className="text-xs bg-white/20 px-2.5 py-0.5 rounded-full font-medium">
                    {latestEntry?.enteredAt ? formatManilaTime(latestEntry.enteredAt) : 'Just now'}
                  </span>
                </div>

                <div className="p-6">
                  <div className="grid gap-6 sm:grid-cols-2 items-start">
                    {/* Large Registration Photo */}
                    <div className="flex flex-col items-center">
                      <div className="relative aspect-square w-full max-w-[280px] overflow-hidden rounded-2xl border-2 border-[var(--color-border)] bg-slate-100 shadow-inner">
                        {latestEntry?.photoEvidenceId ? (
                          <AuthenticatedImage
                            publicId={latestEntry.photoEvidenceId}
                            alt={latestEntry.visitorName}
                            className="h-full w-full object-cover"
                          />
                        ) : (
                          <div className="flex h-full w-full items-center justify-center text-slate-400">
                            Photo unavailable
                          </div>
                        )}
                      </div>
                      <span className="mt-2 text-xs font-semibold text-[var(--color-text-secondary)]">
                        Verified Live Registration Photo
                      </span>
                    </div>

                    {/* Visitor Details & Inspection Guidance */}
                    <div className="space-y-4">
                      <div>
                        <span className="text-xs font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
                          Visitor Name
                        </span>
                        <h2 className="text-xl font-extrabold text-[var(--color-text-primary)] mt-0.5">
                          {latestEntry?.visitorName}
                        </h2>
                        <p className="text-xs text-[var(--color-text-secondary)] mt-0.5 font-mono">
                          Ref: {latestEntry?.publicReference}
                        </p>
                      </div>

                      <div className="space-y-2 border-t border-[var(--color-border)] pt-3 text-sm">
                        <div className="flex items-start gap-2">
                          <FileText className="h-4 w-4 text-[var(--color-brand)] flex-shrink-0 mt-0.5" />
                          <div>
                            <span className="text-xs text-[var(--color-text-muted)] block">Purpose of Visit:</span>
                            <span className="font-medium text-[var(--color-text-primary)]">{latestEntry?.purpose}</span>
                          </div>
                        </div>
                      </div>

                      {latestEntry?.vehicle && (
                        <div className="rounded-xl border border-blue-200 bg-blue-50/60 p-4 text-blue-950">
                          {latestEntry.vehicle.plateConflictFlag && (
                            <div className="mb-3 rounded-lg border border-red-300 bg-red-100 p-2.5 text-xs text-red-950 font-semibold flex items-center gap-2">
                              <AlertCircle className="h-4 w-4 text-red-700 flex-shrink-0" />
                              <span>Duplicate Plate Warning: Plate was declared on another active pass. Verify documentation.</span>
                            </div>
                          )}
                          <div className="flex items-center gap-2 font-bold text-xs uppercase tracking-wider text-blue-800">
                            <Car className="h-4 w-4 text-blue-600" />
                            Vehicle Declared
                          </div>
                          <div className="mt-2 grid grid-cols-2 gap-2 text-xs">
                            <div>
                              <span className="text-blue-600 block text-[11px]">Plate Number</span>
                              <span className="font-mono font-bold text-sm text-blue-900">{latestEntry.vehicle.plateNumber}</span>
                            </div>
                            <div>
                              <span className="text-blue-600 block text-[11px]">Type</span>
                              <span className="font-semibold capitalize text-blue-900">{latestEntry.vehicle.vehicleType}</span>
                            </div>
                            <div>
                              <span className="text-blue-600 block text-[11px]">Color</span>
                              <span className="font-semibold text-blue-900">{latestEntry.vehicle.color}</span>
                            </div>
                            {latestEntry.vehicle.makeModel && (
                              <div>
                                <span className="text-blue-600 block text-[11px]">Make / Model</span>
                                <span className="font-semibold text-blue-900">{latestEntry.vehicle.makeModel}</span>
                              </div>
                            )}
                          </div>
                          {latestEntry.vehicle.vehiclePhotoEvidenceId && (
                            <div className="mt-3 pt-3 border-t border-blue-200">
                              <span className="text-blue-800 block text-[11px] font-bold mb-1.5 uppercase tracking-wider">
                                Declared Vehicle Photo
                              </span>
                              <div className="relative aspect-video w-full max-w-[220px] overflow-hidden rounded-xl border border-blue-300 bg-slate-100 shadow-xs">
                                <AuthenticatedImage
                                  publicId={latestEntry.vehicle.vehiclePhotoEvidenceId}
                                  alt={`Vehicle ${latestEntry.vehicle.plateNumber}`}
                                  className="h-full w-full object-cover"
                                />
                              </div>
                            </div>
                          )}
                        </div>
                      )}

                      <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-emerald-900">
                        <div className="flex items-center gap-2 font-bold text-sm">
                          <CheckCircle2 className="h-5 w-5 text-emerald-600 flex-shrink-0" />
                          Entry Recorded
                        </div>
                        <p className="text-xs text-emerald-800 mt-1 leading-relaxed">
                          Identity was verified online during registration. Please perform the standard security physical inspection.
                        </p>
                      </div>
                    </div>
                  </div>
                </div>
              </Card>
            </div>

            {/* Right: Gate History / Recent Entries */}
            <div className="lg:col-span-5 space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="font-bold text-sm text-[var(--color-text-primary)] flex items-center gap-2">
                  <Clock className="h-4 w-4 text-[var(--color-brand)]" />
                  Recent Entries at {station?.gate || 'This Gate'}
                </h3>
                <span className="text-xs text-[var(--color-text-muted)]">
                  Today's total: {entries.length}
                </span>
              </div>

              {recentEntries.length === 0 ? (
                <Card className="p-6 text-center text-xs text-[var(--color-text-muted)]">
                  No other entries recorded at this gate today yet.
                </Card>
              ) : (
                <div className="space-y-3 max-h-[600px] overflow-y-auto pr-1">
                  {recentEntries.map((entry) => (
                    <Card key={entry.passId} className="p-3.5 flex items-center gap-3 hover:border-[var(--color-brand)] transition-colors">
                      <div className="h-14 w-14 flex-shrink-0 overflow-hidden rounded-xl border border-[var(--color-border)] bg-slate-100">
                        {entry.photoEvidenceId ? (
                          <AuthenticatedImage
                            publicId={entry.photoEvidenceId}
                            alt={entry.visitorName}
                            className="h-full w-full object-cover"
                          />
                        ) : (
                          <div className="flex h-full w-full items-center justify-center text-[10px] text-slate-400">
                            N/A
                          </div>
                        )}
                      </div>

                      <div className="flex-1 min-w-0">
                        <h4 className="font-bold text-sm truncate text-[var(--color-text-primary)]">
                          {entry.visitorName}
                        </h4>
                        <p className="text-xs text-[var(--color-text-secondary)] truncate">
                          {entry.purpose}
                        </p>
                        <div className="flex items-center gap-2 mt-1 text-[11px] text-[var(--color-text-muted)]">
                          <span>{entry.enteredAt ? formatManilaTime(entry.enteredAt) : ''}</span>
                          <span>•</span>
                          <span className="font-mono">{entry.publicReference}</span>
                        </div>
                        {entry.vehicle && (
                          <div className="mt-1 flex items-center gap-1.5 text-[11px] text-blue-700 font-mono">
                            <Car className="h-3 w-3" />
                            <span>{entry.vehicle.plateNumber} ({entry.vehicle.vehicleType})</span>
                          </div>
                        )}
                      </div>

                      <span className="flex-shrink-0 rounded-md bg-emerald-50 px-2 py-0.5 text-[11px] font-semibold text-emerald-700 border border-emerald-200">
                        Inside
                      </span>
                    </Card>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </main>

      {/* Sign Out Modal */}
      <ConfirmModal
        isOpen={showSignOutModal}
        onClose={() => setShowSignOutModal(false)}
        onConfirm={async () => {
          setIsSigningOut(true);
          await signOutCurrentActor();
          window.location.href = '/login';
        }}
        title="Sign Out of Guard Station"
        description="Are you sure you want to end this guard station monitoring session?"
        confirmText="Sign Out Station"
        isDestructive={true}
        loading={isSigningOut}
      />
    </div>
  );
}
