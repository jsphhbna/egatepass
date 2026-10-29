import { useState, useEffect, useCallback } from 'react';
import { requireSupabase } from '@/lib/supabase';
import { AuthenticatedImage } from '@/components/AuthenticatedImage';
import { Button, Card } from '@/components/ui';
import {
  Search,
  UserCheck,
  XCircle,
  LogOut,
  Clock,
  Phone,
  FileText,
  AlertCircle,
  Loader2,
  ZoomIn,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import {
  searchCachedVisitors,
  queueOfflineVisitorAction,
} from '@/lib/offline/guardIndexedDb';
import { isTransportOrNetworkError } from '@/lib/offline/errorClassification';
import { formatPassReference } from '@/lib/passPresentation';

export interface GuardVisitorRecoveryTabProps {
  isBackendOnline: boolean;
  actorId?: string;
  onActionComplete?: () => void;
}

export function GuardVisitorRecoveryTab({
  isBackendOnline,
  actorId,
  onActionComplete,
}: GuardVisitorRecoveryTabProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [results, setResults] = useState<any[]>([]);
  const [searching, setSearching] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
  const [isCachedResults, setIsCachedResults] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [processingId, setProcessingId] = useState<string | null>(null);
  const [rejectingPass, setRejectingPass] = useState<any | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  const [zoomImage, setZoomImage] = useState<{ publicId?: string | null; blob?: Blob | null } | null>(null);

  const performSearch = useCallback(
    async (queryText: string) => {
      const clean = queryText.trim();
      if (clean.length < 2) {
        setResults([]);
        setHasSearched(false);
        setSearchError(null);
        setIsCachedResults(false);
        return;
      }

      setSearching(true);
      setHasSearched(true);
      setSearchError(null);
      setIsCachedResults(false);

      if (isBackendOnline) {
        try {
          const client = requireSupabase();
          const { data, error } = await client.schema('api').rpc('guard_search_recovery_visitors', {
            query: clean,
            requested_limit: 20,
          });

          if (error) throw error;
          setResults(Array.isArray(data) ? data : []);
          setIsCachedResults(false);
        } catch (err: any) {
          if (isTransportOrNetworkError(err)) {
            console.warn('Online recovery search transport failure, falling back to local cache:', err);
            const cached = await searchCachedVisitors(clean);
            setResults(cached);
            setIsCachedResults(true);
            toast.info('Showing cached offline visitor results due to network issue.');
          } else {
            // Authoritative server error (403, 42501, invalid parameter, etc.):
            // Invariant: DO NOT silently fall back to cached PII on authoritative rejection (Section 12)
            console.error('Authoritative server error for recovery search:', err);
            setResults([]);
            setIsCachedResults(false);
            const errorMsg = err.message || 'Server error occurred while searching visitors.';
            setSearchError(errorMsg);
            toast.error(errorMsg);
          }
        } finally {
          setSearching(false);
        }
      } else {
        // Offline Search in local IndexedDB
        try {
          const cached = await searchCachedVisitors(clean);
          setResults(cached);
          setIsCachedResults(true);
        } catch (err) {
          console.error('Offline recovery search error:', err);
          toast.error('Local visitor cache search failed');
        } finally {
          setSearching(false);
        }
      }
    },
    [isBackendOnline]
  );

  useEffect(() => {
    const timer = setTimeout(() => {
      if (searchQuery.trim().length >= 2) {
        void performSearch(searchQuery);
      } else {
        setResults([]);
        setHasSearched(false);
      }
    }, 300);

    return () => clearTimeout(timer);
  }, [searchQuery, performSearch]);

  async function handleApprove(pass: any) {
    setProcessingId(pass.id);
    const passId = pass.id;
    const occurredAt = new Date().toISOString();

    if (isBackendOnline) {
      try {
        const client = requireSupabase();
        const { error } = await client.schema('api').rpc('guard_recover_pass_action', {
          requested_pass_id: passId,
          requested_action: 'approve_entry',
          requested_reason: 'visitor_recovery',
        });
        if (error) throw error;

        toast.success(`Entry approved for ${pass.visitorName}`);
        await performSearch(searchQuery);
        onActionComplete?.();
      } catch (err: any) {
        if (isTransportOrNetworkError(err)) {
          console.warn('Online recovery action network failure, queueing offline event:', err);
          await queueOfflineApproval(pass, occurredAt);
        } else {
          console.error('Authoritative server refusal for recovery action:', err);
          toast.error(err.message || 'Server refused pass action');
        }
      } finally {
        setProcessingId(null);
      }
    } else {
      await queueOfflineApproval(pass, occurredAt);
      setProcessingId(null);
    }
  }

  async function queueOfflineApproval(pass: any, occurredAt: string) {
    try {
      await queueOfflineVisitorAction({
        passId: pass.id,
        action: 'approve_entry',
        reason: 'visitor_recovery',
        occurredAt,
      });
      toast.success(`Entry approved offline for ${pass.visitorName} (Stored on this device pending synchronization)`);
      await performSearch(searchQuery);
      onActionComplete?.();
    } catch (offlineErr: any) {
      console.error('Queue offline approval failed:', offlineErr);
      toast.error(offlineErr.message || 'Failed to store offline approval');
    }
  }

  async function handleConfirmReject() {
    if (!rejectingPass) return;
    const pass = rejectingPass;
    const passId = pass.id;
    const reason = rejectReason.trim() || 'Rejected during visitor recovery';
    const occurredAt = new Date().toISOString();
    setProcessingId(passId);

    if (isBackendOnline) {
      try {
        const client = requireSupabase();
        const { error } = await client.schema('api').rpc('guard_recover_pass_action', {
          requested_pass_id: passId,
          requested_action: 'reject_entry',
          requested_reason: reason,
        });
        if (error) throw error;

        toast.success(`Pass rejected for ${pass.visitorName}`);
        setRejectingPass(null);
        setRejectReason('');
        await performSearch(searchQuery);
        onActionComplete?.();
      } catch (err: any) {
        if (isTransportOrNetworkError(err)) {
          console.warn('Online recovery reject network failure, queueing offline event:', err);
          await queueOfflineRejection(pass, reason, occurredAt);
        } else {
          console.error('Authoritative server refusal for rejection:', err);
          toast.error(err.message || 'Server refused pass rejection');
        }
      } finally {
        setProcessingId(null);
      }
    } else {
      await queueOfflineRejection(pass, reason, occurredAt);
      setProcessingId(null);
    }
  }

  async function queueOfflineRejection(pass: any, reason: string, occurredAt: string) {
    try {
      await queueOfflineVisitorAction({
        passId: pass.id,
        action: 'reject_entry',
        reason,
        occurredAt,
      });
      setRejectingPass(null);
      setRejectReason('');
      toast.success(`Pass rejected offline for ${pass.visitorName} (Stored on this device pending synchronization)`);
      await performSearch(searchQuery);
      onActionComplete?.();
    } catch (offlineErr: any) {
      console.error('Queue offline reject failed:', offlineErr);
      toast.error(offlineErr.message || 'Failed to store offline rejection');
    }
  }

  async function handleRecordExit(pass: any) {
    setProcessingId(pass.id);
    const passId = pass.id;
    const occurredAt = new Date().toISOString();

    if (isBackendOnline) {
      try {
        const client = requireSupabase();
        const { error } = await client.schema('api').rpc('guard_recover_pass_action', {
          requested_pass_id: passId,
          requested_action: 'record_exit',
          requested_reason: 'visitor_recovery_exit',
        });
        if (error) throw error;

        toast.success(`Exit recorded for ${pass.visitorName}`);
        await performSearch(searchQuery);
        onActionComplete?.();
      } catch (err: any) {
        if (isTransportOrNetworkError(err)) {
          console.warn('Online recovery exit network failure, queueing offline event:', err);
          await queueOfflineExit(pass, occurredAt);
        } else {
          console.error('Authoritative server refusal for exit:', err);
          toast.error(err.message || 'Server refused pass exit');
        }
      } finally {
        setProcessingId(null);
      }
    } else {
      await queueOfflineExit(pass, occurredAt);
      setProcessingId(null);
    }
  }

  async function queueOfflineExit(pass: any, occurredAt: string) {
    try {
      await queueOfflineVisitorAction({
        passId: pass.id,
        action: 'record_exit',
        reason: 'visitor_recovery_exit',
        occurredAt,
        actorId: actorId || null,
      });
      toast.success(`Exit recorded offline for ${pass.visitorName} (Stored on this device pending synchronization)`);
      await performSearch(searchQuery);
      onActionComplete?.();
    } catch (offlineErr: any) {
      console.error('Queue offline exit failed:', offlineErr);
      toast.error(offlineErr.message || 'Failed to store offline exit');
    }
  }

  return (
    <div className="space-y-6">
      {/* Search Header */}
      <Card className="p-6">
        <div className="max-w-2xl">
          <h2 className="text-lg font-bold text-[var(--color-text-primary)]">
            Visitor Recovery
          </h2>
          <p className="mt-1 text-sm text-[var(--color-text-secondary)]">
            Recover and verify visitors who registered online or at the kiosk but lost their QR code or phone battery died.
          </p>

          <div className="mt-4 relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-[var(--color-text-muted)]" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search today's visitors by name, contact number, or pass reference…"
              className="w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-canvas)] pl-10 pr-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-brand)]"
              autoFocus
            />
            {searching && (
              <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 animate-spin text-[var(--color-brand)]" />
            )}
          </div>
          <p className="mt-2 text-xs text-[var(--color-text-muted)]">
            Searches Manila calendar day active visitors (<span className="font-semibold">issued, pending, inside</span>).
          </p>
        </div>
      </Card>

      {/* Authoritative Error State (Section 12) */}
      {searchError && (
        <Card className="p-6 border-red-300 bg-red-50 dark:bg-red-950/20 text-center">
          <AlertCircle className="mx-auto h-8 w-8 text-red-600 mb-2" />
          <h3 className="text-base font-bold text-red-900 dark:text-red-200">
            Search Unavailable
          </h3>
          <p className="mt-1 text-sm text-red-700 dark:text-red-300 max-w-md mx-auto">
            {searchError}
          </p>
        </Card>
      )}

      {/* Cached Offline Results Notice (Section 12) */}
      {isCachedResults && results.length > 0 && (
        <div className="flex items-center gap-2 rounded-lg bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800/40 px-4 py-2.5 text-xs text-amber-800 dark:text-amber-200">
          <AlertCircle className="h-4 w-4 shrink-0 text-amber-600" />
          <span>Showing cached offline visitor results from device storage.</span>
        </div>
      )}

      {/* Results List */}
      {hasSearched && results.length === 0 && !searching && !searchError && (
        <Card className="p-12 text-center">
          <AlertCircle className="mx-auto h-10 w-10 text-[var(--color-text-muted)] mb-3" />
          <h3 className="text-base font-semibold text-[var(--color-text-primary)]">
            No matching active visitors found
          </h3>
          <p className="mt-1 text-sm text-[var(--color-text-secondary)] max-w-sm mx-auto">
            Verify the spelling of the name or check the contact number. Visitors scheduled for another date must register for today.
          </p>
        </Card>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {results.map((pass) => {
          const isProcessing = processingId === pass.id;
          const canonicalRef = pass.publicReference || pass.passReference || pass.id;
          const refDisplay = formatPassReference(canonicalRef);

          return (
            <Card key={pass.id} className="p-5 flex flex-col justify-between space-y-4">
              <div>
                <div className="flex items-start justify-between gap-2 border-b border-[var(--color-border)] pb-3">
                  <div>
                    <h3 className="font-bold text-base text-[var(--color-text-primary)] uppercase">
                      {pass.visitorName}
                    </h3>
                    <p className="font-mono text-xs font-semibold text-[var(--color-brand)]">
                      {refDisplay}
                    </p>
                  </div>
                  <span
                    className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-bold uppercase tracking-wider ${
                      pass.status === 'inside'
                        ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300'
                        : pass.status === 'pending'
                        ? 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300'
                        : 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300'
                    }`}
                  >
                    {pass.status}
                  </span>
                </div>

                {/* Evidence Photos (Protected API / Offline Blobs) */}
                <div className="my-3 flex items-center justify-center gap-4 py-1">
                  {(pass.photoEvidenceId || pass.photoBlob) && (
                    <div className="text-center">
                      <p className="text-[10px] text-[var(--color-text-muted)] mb-1 font-semibold uppercase">
                        Selfie Photo
                      </p>
                      <button
                        type="button"
                        aria-label="Open visitor selfie"
                        className="relative cursor-pointer group h-24 w-20 overflow-hidden rounded-lg border border-[var(--color-border)] shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-brand)] focus-visible:ring-offset-2"
                        onClick={() => setZoomImage({ publicId: pass.photoEvidenceId, blob: pass.photoBlob })}
                      >
                        <AuthenticatedImage
                          publicId={pass.photoEvidenceId}
                          blob={pass.photoBlob}
                          alt={`${pass.visitorName} Photo`}
                          className="h-full w-full object-cover"
                        />
                        <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                          <ZoomIn className="h-5 w-5 text-white" />
                        </div>
                      </button>
                    </div>
                  )}

                  {(pass.idEvidenceId || pass.idBlob) ? (
                    <div className="text-center">
                      <p className="text-[10px] text-[var(--color-text-muted)] mb-1 font-semibold uppercase">
                        Presented ID
                      </p>
                      <button
                        type="button"
                        aria-label="Open presented ID"
                        className="relative cursor-pointer group h-24 w-36 overflow-hidden rounded-lg border border-[var(--color-border)] shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-brand)] focus-visible:ring-offset-2"
                        onClick={() => setZoomImage({ publicId: pass.idEvidenceId, blob: pass.idBlob })}
                      >
                        <AuthenticatedImage
                          publicId={pass.idEvidenceId}
                          blob={pass.idBlob}
                          alt={`${pass.visitorName} ID`}
                          className="h-full w-full object-cover"
                        />
                        <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                          <ZoomIn className="h-5 w-5 text-white" />
                        </div>
                      </button>
                    </div>
                  ) : (
                    <div className="text-center flex flex-col items-center justify-center h-24 w-36 rounded-lg border border-dashed border-[var(--color-border)] text-[10px] text-[var(--color-text-muted)] p-2">
                      <p className="font-semibold uppercase mb-0.5">ID Evidence</p>
                      <p>Unavailable</p>
                    </div>
                  )}
                </div>

                {/* Visitor Metadata */}
                <div className="space-y-1.5 text-xs text-[var(--color-text-secondary)] rounded-lg bg-[var(--color-canvas)] p-3 border border-[var(--color-border)]">
                  <div className="flex items-center gap-1.5">
                    <Phone className="h-3.5 w-3.5 shrink-0 text-[var(--color-text-muted)]" />
                    <span>Contact: {pass.contactNumber || '—'}</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <FileText className="h-3.5 w-3.5 shrink-0 text-[var(--color-text-muted)]" />
                    <span className="truncate">Purpose: {pass.purpose || '—'}</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <Clock className="h-3.5 w-3.5 shrink-0 text-[var(--color-text-muted)]" />
                    <span>
                      {pass.timeIn ? `Time In: ${pass.timeIn}` : 'Not yet entered'}
                    </span>
                  </div>
                </div>
              </div>

              {/* Action Buttons */}
              <div className="pt-2 border-t border-[var(--color-border)] flex gap-2">
                {pass.status === 'inside' ? (
                  <Button
                    onClick={() => void handleRecordExit(pass)}
                    disabled={isProcessing}
                    loading={isProcessing}
                    className="w-full bg-zinc-800 hover:bg-black text-white"
                    icon={<LogOut className="h-4 w-4" />}
                  >
                    Record Exit
                  </Button>
                ) : (
                  <>
                    <Button
                      variant="destructive-outline"
                      size="sm"
                      onClick={() => setRejectingPass(pass)}
                      disabled={isProcessing}
                      className="flex-1"
                      icon={<XCircle className="h-4 w-4" />}
                    >
                      Reject
                    </Button>
                    <Button
                      size="sm"
                      onClick={() => void handleApprove(pass)}
                      disabled={isProcessing}
                      loading={isProcessing}
                      className="flex-1 bg-emerald-600 hover:bg-emerald-700 text-white"
                      icon={<UserCheck className="h-4 w-4" />}
                    >
                      Approve Entry
                    </Button>
                  </>
                )}
              </div>
            </Card>
          );
        })}
      </div>

      {/* Rejection Modal */}
      {rejectingPass && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-md rounded-2xl bg-white dark:bg-zinc-900 p-6 shadow-xl border border-[var(--color-border)]">
            <h3 className="text-lg font-bold text-[var(--color-text-primary)]">
              Reject Visitor Entry
            </h3>
            <p className="mt-1 text-sm text-[var(--color-text-secondary)]">
              Specify reason for rejecting <strong className="text-black dark:text-white">{rejectingPass.visitorName}</strong>.
            </p>

            <div className="mt-4">
              <label className="block text-xs font-semibold text-[var(--color-text-secondary)] mb-1">
                Rejection Reason
              </label>
              <textarea
                value={rejectReason}
                onChange={(e) => setRejectReason(e.target.value)}
                placeholder="e.g. Identity mismatch with presented physical ID, improper attire, prohibited items..."
                className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-canvas)] p-3 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-brand)]"
                rows={3}
                autoFocus
              />
            </div>

            <div className="mt-5 flex justify-end gap-3">
              <Button variant="secondary" onClick={() => setRejectingPass(null)}>
                Cancel
              </Button>
              <Button
                variant="destructive"
                onClick={() => void handleConfirmReject()}
                loading={processingId === rejectingPass.id}
                disabled={processingId === rejectingPass.id}
              >
                Confirm Rejection
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Zoom Image Modal */}
      {zoomImage && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/90 p-4 cursor-pointer"
          onClick={() => setZoomImage(null)}
        >
          <div className="relative max-h-[90vh] max-w-[90vw] overflow-hidden rounded-2xl bg-black">
            <AuthenticatedImage
              publicId={zoomImage.publicId}
              blob={zoomImage.blob}
              alt="Enlarged verification evidence"
              className="max-h-[85vh] max-w-[85vw] object-contain"
            />
            <button
              onClick={() => setZoomImage(null)}
              className="absolute top-4 right-4 rounded-full bg-black/70 p-2 text-white hover:bg-black"
            >
              <X className="h-6 w-6" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
