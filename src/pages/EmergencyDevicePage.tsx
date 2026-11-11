import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  AlertTriangle,
  CheckCircle2,
  ClipboardCheck,
  CloudOff,
  KeyRound,
  Lock,
  LogOut,
  MapPin,
  RefreshCw,
  Search,
  ShieldAlert,
  ShieldCheck,
  UploadCloud,
  Wifi,
  WifiOff,
} from 'lucide-react';
import { toast } from 'sonner';
import { useAuth } from '@/hooks/useAuth';
import { getAccessToken, signOutCurrentActor } from '@/services/auth';
import { BrandMark } from '@/components/BrandMark';
import { Button, Card, FormField, Input, Select, StatusBadge, Textarea } from '@/components/ui';
import {
  PHYSICAL_ID_ATTESTATION_TEXT,
  evaluateEmergencyManifestLease,
  type EmergencyLeaseStatus,
  type ManifestVerificationResult,
  type SignedEmergencyManifest,
} from '@/lib/offline/emergencyManifestVerifier';
import {
  enqueueEmergencyRecord,
  getLastSequence,
  listEmergencyRecords,
  loadEncryptedManifest,
  saveEncryptedManifest,
  updateEmergencyRecordSyncState,
  type EmergencyOfflineRecord,
  type OfflineSyncState,
} from '@/lib/offline/emergencyCryptoIdb';

function formatManilaTimestamp(iso: string | null | undefined): string {
  if (!iso) return 'N/A';
  const dt = new Date(iso);
  if (Number.isNaN(dt.getTime())) return iso;
  return dt.toLocaleString('en-PH', {
    timeZone: 'Asia/Manila',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function getLeaseBadgeStatus(status: EmergencyLeaseStatus): string {
  switch (status) {
    case 'valid':
      return 'active';
    case 'stale_lease':
    case 'expired_lease':
      return 'warning';
    case 'unverified_lease':
      return 'error';
    default:
      return 'inactive';
  }
}

function getLeaseLabel(status: EmergencyLeaseStatus): string {
  switch (status) {
    case 'valid':
      return 'Verified 24h Lease';
    case 'stale_lease':
      return 'Stale Lease';
    case 'expired_lease':
      return 'Expired 24h Lease (Flagged Sync Only)';
    case 'unverified_lease':
      return 'Unverified Manifest';
    case 'no_manifest':
    default:
      return 'No Manifest Cached';
  }
}

function getSyncBadgeStatus(state: OfflineSyncState): string {
  switch (state) {
    case 'synced':
      return 'active';
    case 'conflict':
      return 'warning';
    case 'rejected':
      return 'error';
    default:
      return 'pending';
  }
}

interface SyncApiItemResult {
  accepted: boolean;
  httpStatus: number;
  outcome: string;
  error?: string;
  recordId: string;
  localSequence: number;
  classification: 'OFFLINE MODE RECORDED';
}

interface SyncApiResponse {
  syncedAt: string;
  deviceId: string;
  gate: string;
  acceptedCount: number;
  conflictCount: number;
  rejectedCount: number;
  results: SyncApiItemResult[];
}

export function EmergencyDevicePage() {
  const { uid, userData } = useAuth();
  const navigate = useNavigate();

  const deviceActor = userData?.kind === 'device' ? userData : null;
  const deviceUserId = uid ?? '';
  const assignedGate = deviceActor?.gate?.trim() || 'Main Gate';
  const deviceName = deviceActor?.name || 'Emergency Device';
  const deviceAlias = deviceActor?.alias || '';

  const [isOnline, setIsOnline] = useState<boolean>(() =>
    typeof navigator !== 'undefined' ? navigator.onLine : true,
  );
  const [manifest, setManifest] = useState<SignedEmergencyManifest | null>(null);
  const [verification, setVerification] = useState<ManifestVerificationResult>({
    leaseStatus: 'no_manifest',
    cryptoValid: false,
    gateMatches: false,
    deviceMatches: false,
    expired: false,
    reason: 'Checking encrypted local manifest vault...',
  });
  const [records, setRecords] = useState<EmergencyOfflineRecord[]>([]);
  const [lastSequence, setLastSequence] = useState<number>(0);

  const [loadingVault, setLoadingVault] = useState(true);
  const [refreshingManifest, setRefreshingManifest] = useState(false);
  const [syncingRecords, setSyncingRecords] = useState(false);
  const [submittingIntake, setSubmittingIntake] = useState(false);
  const [vaultError, setVaultError] = useState<string | null>(null);
  const [expectedSearch, setExpectedSearch] = useState('');

  // Intake form state (zero selfies, zero ID uploads, zero postal codes, zero QR generation)
  const [visitorFullName, setVisitorFullName] = useState('');
  const [declaredAddress, setDeclaredAddress] = useState('');
  const [purpose, setPurpose] = useState('');
  const [selectedOfficeId, setSelectedOfficeId] = useState('');
  const [useManualOffice, setUseManualOffice] = useState(false);
  const [manualOfficeName, setManualOfficeName] = useState('');
  const [idPhysicallyInspected, setIdPhysicallyInspected] = useState(false);
  const [emergencyExceptionApplied, setEmergencyExceptionApplied] = useState(false);
  const [emergencyExceptionReason, setEmergencyExceptionReason] = useState('');

  useEffect(() => {
    const onOnline = () => setIsOnline(true);
    const onOffline = () => setIsOnline(false);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, []);

  const refreshLocalVaultState = useCallback(async () => {
    if (!deviceUserId) return;
    setLoadingVault(true);
    setVaultError(null);
    try {
      const [cachedManifest, cachedRecords, seq] = await Promise.all([
        loadEncryptedManifest(deviceUserId),
        listEmergencyRecords(deviceUserId),
        getLastSequence(deviceUserId),
      ]);
      const evalResult = await evaluateEmergencyManifestLease(
        cachedManifest,
        deviceUserId,
        assignedGate,
      );
      setManifest(cachedManifest);
      setVerification(evalResult);
      setRecords(cachedRecords);
      setLastSequence(seq);

      const firstOffice = cachedManifest?.payload.offices[0];
      if (firstOffice && !selectedOfficeId) {
        setSelectedOfficeId(firstOffice.id);
      }
    } catch (err) {
      setVaultError(err instanceof Error ? err.message : 'Unable to read encrypted local vault.');
    } finally {
      setLoadingVault(false);
    }
  }, [assignedGate, deviceUserId, selectedOfficeId]);

  const handleRefreshManifest = useCallback(
    async (silent = false) => {
      if (!deviceUserId) return;
      if (!isOnline) {
        if (!silent) {
          toast.info('Device is offline. Using verified local encrypted manifest cache.');
        }
        return;
      }

      setRefreshingManifest(true);
      try {
        const token = await getAccessToken();
        if (!token) {
          throw new Error('Authentication session unavailable.');
        }

        const res = await fetch('/api/gate/emergency-device', {
          method: 'GET',
          headers: { Authorization: `Bearer ${token}` },
        });
        const data = (await res.json()) as {
          manifest?: SignedEmergencyManifest;
          error?: string;
        };

        if (!res.ok || !data.manifest) {
          throw new Error(data.error || `Manifest refresh failed (${res.status})`);
        }

        const check = await evaluateEmergencyManifestLease(data.manifest, deviceUserId, assignedGate);
        if (!check.cryptoValid || !check.deviceMatches || !check.gateMatches) {
          setVerification(check);
          throw new Error(check.reason || 'Signed manifest verification failed.');
        }

        await saveEncryptedManifest(deviceUserId, data.manifest);
        setManifest(data.manifest);
        setVerification(check);

        const firstOffice = data.manifest.payload.offices[0];
        if (firstOffice) {
          setSelectedOfficeId((prev) =>
            data.manifest!.payload.offices.some((o) => o.id === prev)
              ? prev
              : firstOffice.id,
          );
          setUseManualOffice(false);
        }

        if (!silent) {
          toast.success('Signed 24-hour gate manifest verified and encrypted locally.');
        }
      } catch (err) {
        if (!silent) {
          toast.error(err instanceof Error ? err.message : 'Failed to refresh signed gate manifest.');
        }
      } finally {
        setRefreshingManifest(false);
      }
    },
    [assignedGate, deviceUserId, isOnline],
  );

  useEffect(() => {
    let active = true;
    async function init() {
      await refreshLocalVaultState();
      if (active && typeof navigator !== 'undefined' && navigator.onLine) {
        await handleRefreshManifest(true);
      }
    }
    void init();
    return () => {
      active = false;
    };
  }, [refreshLocalVaultState, handleRefreshManifest]);

  const cachedOffices = useMemo(
    () => manifest?.payload.offices ?? [],
    [manifest],
  );

  const selectedOfficeObj = useMemo(
    () => cachedOffices.find((o) => o.id === selectedOfficeId) ?? null,
    [cachedOffices, selectedOfficeId],
  );

  const allowEmergencyException = Boolean(
    verification.cryptoValid &&
      verification.deviceMatches &&
      verification.gateMatches &&
      manifest?.payload.allowEmergencyException === true,
  );

  useEffect(() => {
    if (!allowEmergencyException && emergencyExceptionApplied) {
      setEmergencyExceptionApplied(false);
      setEmergencyExceptionReason('');
    }
  }, [allowEmergencyException, emergencyExceptionApplied]);

  const filteredExpectedPasses = useMemo(() => {
    const list = manifest?.payload.expectedPasses ?? [];
    const q = expectedSearch.trim().toLowerCase();
    if (!q) return list;
    return list.filter(
      (item) =>
        item.visitorName.toLowerCase().includes(q) ||
        item.referenceCode.toLowerCase().includes(q) ||
        (item.officeName ?? '').toLowerCase().includes(q) ||
        item.purpose.toLowerCase().includes(q),
    );
  }, [expectedSearch, manifest]);

  const pendingRecords = useMemo(
    () => records.filter((r) => r.syncStatus === 'pending_sync'),
    [records],
  );

  const queueCounts = useMemo(() => {
    return records.reduce(
      (acc, r) => {
        acc[r.syncStatus] += 1;
        return acc;
      },
      { pending_sync: 0, synced: 0, conflict: 0, rejected: 0 },
    );
  }, [records]);

  const handleRecordOfflineEntry = async (e: FormEvent) => {
    e.preventDefault();
    if (!deviceUserId) {
      toast.error('Emergency Device identity missing.');
      return;
    }

    if (!idPhysicallyInspected) {
      toast.error('Physical identification inspection attestation is mandatory.');
      return;
    }

    const resolveManually = useManualOffice || cachedOffices.length === 0 || !selectedOfficeObj;
    const officeNameSnapshot = resolveManually
      ? manualOfficeName.trim()
      : selectedOfficeObj!.name;

    if (officeNameSnapshot.length < 2) {
      toast.error('Destination office is required.');
      return;
    }

    setSubmittingIntake(true);
    try {
      const currentEval = await evaluateEmergencyManifestLease(
        manifest,
        deviceUserId,
        assignedGate,
      );
      setVerification(currentEval);

      const record = await enqueueEmergencyRecord({
        deviceUserId,
        claimedGate: assignedGate,
        visitorFullName,
        declaredAddress,
        purpose,
        destinationOfficeId: resolveManually ? null : selectedOfficeObj!.id,
        destinationOfficeNameSnapshot: officeNameSnapshot,
        officeResolutionStatus: resolveManually ? 'unresolved_stale_snapshot' : 'resolved_snapshot',
        officeRequiresApprovalSnapshot: resolveManually
          ? false
          : selectedOfficeObj!.requiresApprovalBeforePass,
        idPhysicallyInspected,
        snapshotVersion: manifest?.payload.snapshotVersion ?? 'no-manifest',
        manifestId: manifest?.payload.manifestId ?? null,
        leaseStatusAtRecord: currentEval.leaseStatus,
        emergencyExceptionApplied: allowEmergencyException ? emergencyExceptionApplied : false,
        emergencyExceptionReason:
          allowEmergencyException && emergencyExceptionApplied ? emergencyExceptionReason : null,
        allowEmergencyExceptionPolicy: allowEmergencyException,
      });

      const updatedList = await listEmergencyRecords(deviceUserId);
      setRecords(updatedList);
      setLastSequence(record.localSequence);

      // Reset form cleanly for next visitor; always clear physical ID attestation checkbox
      setVisitorFullName('');
      setDeclaredAddress('');
      setPurpose('');
      setManualOfficeName('');
      setIdPhysicallyInspected(false);
      setEmergencyExceptionApplied(false);
      setEmergencyExceptionReason('');

      toast.success(
        `Entry #${record.localSequence} encrypted locally as OFFLINE MODE RECORDED.`,
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Unable to save offline entry.');
    } finally {
      setSubmittingIntake(false);
    }
  };

  const handleSyncQueuedRecords = async () => {
    if (!deviceUserId) return;
    if (!isOnline) {
      toast.error('Cannot sync while offline. Records remain safely encrypted on this device.');
      return;
    }
    if (pendingRecords.length === 0) {
      toast.info('No pending OFFLINE MODE RECORDED entries waiting to sync.');
      return;
    }

    setSyncingRecords(true);
    try {
      const token = await getAccessToken();
      if (!token) {
        throw new Error('Authentication session expired. Re-authenticate online to sync.');
      }

      const ordered = [...pendingRecords].sort((a, b) => a.localSequence - b.localSequence);
      let acceptedTotal = 0;
      let conflictTotal = 0;
      let rejectedTotal = 0;

      for (let i = 0; i < ordered.length; i += 50) {
        const batch = ordered.slice(i, i + 50);
        const payloadItems = batch.map((rec) => ({
          requestId: rec.requestId,
          recordId: rec.recordId,
          claimedGate: rec.claimedGate,
          visitorFullName: rec.visitorFullName,
          declaredAddress: rec.declaredAddress,
          purpose: rec.purpose,
          destinationOfficeId: rec.destinationOfficeId,
          destinationOfficeNameSnapshot: rec.destinationOfficeNameSnapshot,
          officeResolutionStatus: rec.officeResolutionStatus,
          officeRequiresApprovalSnapshot: rec.officeRequiresApprovalSnapshot,
          idPhysicallyInspected: true as const,
          idInspectionAttestationText: PHYSICAL_ID_ATTESTATION_TEXT,
          localRecordedAt: rec.localRecordedAt,
          localSequence: rec.localSequence,
          snapshotVersion: rec.snapshotVersion,
          manifestId: rec.manifestId,
          leaseStatusAtRecord: rec.leaseStatusAtRecord,
          emergencyExceptionApplied: rec.emergencyExceptionApplied,
          emergencyExceptionReason: rec.emergencyExceptionReason,
        }));

        const res = await fetch('/api/gate/emergency-device', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ items: payloadItems }),
        });

        const data = (await res.json()) as SyncApiResponse & { error?: string };
        if (!res.ok || !Array.isArray(data.results)) {
          throw new Error(data.error || `Sync batch failed (${res.status})`);
        }

        acceptedTotal += data.acceptedCount ?? 0;
        conflictTotal += data.conflictCount ?? 0;
        rejectedTotal += data.rejectedCount ?? 0;

        for (const itemResult of data.results) {
          const nextState: OfflineSyncState = itemResult.accepted
            ? 'synced'
            : itemResult.httpStatus === 409 || itemResult.outcome.includes('conflict')
              ? 'conflict'
              : 'rejected';

          await updateEmergencyRecordSyncState(
            deviceUserId,
            itemResult.recordId,
            nextState,
            itemResult.outcome,
            itemResult.error ?? null,
          );
        }
      }

      const refreshed = await listEmergencyRecords(deviceUserId);
      setRecords(refreshed);

      if (conflictTotal > 0 || rejectedTotal > 0) {
        toast.warning(
          `Sync finished: ${acceptedTotal} synced, ${conflictTotal} conflict(s), ${rejectedTotal} rejected.`,
        );
      } else {
        toast.success(`Successfully synced ${acceptedTotal} OFFLINE MODE RECORDED entries.`);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to sync offline records.');
    } finally {
      setSyncingRecords(false);
    }
  };

  const handleSignOut = async () => {
    await signOutCurrentActor();
    navigate('/login', { replace: true });
  };

  return (
    <div className="min-h-dvh bg-[var(--color-canvas)] font-sans text-[var(--color-text-primary)]">
      {/* Top Gate-Locked Header */}
      <header className="sticky top-0 z-30 border-b border-[var(--color-border)] bg-white/95 shadow-sm backdrop-blur-sm">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6">
          <div className="flex items-center gap-3">
            <BrandMark size="sm" />
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-base font-bold tracking-tight sm:text-lg">
                  Emergency Offline Gate Console
                </h1>
                <StatusBadge status="warning" label="OFFLINE MODE RECORDED" />
              </div>
              <p className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[var(--color-text-secondary)]">
                <span className="inline-flex items-center gap-1 font-semibold text-[var(--color-brand)]">
                  <MapPin className="h-3.5 w-3.5" aria-hidden="true" />
                  Assigned Gate: {assignedGate}
                </span>
                <span>Device: {deviceName}{deviceAlias ? ` (${deviceAlias})` : ''}</span>
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center gap-1.5">
              {isOnline ? (
                <Wifi className="h-3.5 w-3.5 text-emerald-700" aria-hidden="true" />
              ) : (
                <WifiOff className="h-3.5 w-3.5 text-amber-700" aria-hidden="true" />
              )}
              <StatusBadge
                status={isOnline ? 'active' : 'warning'}
                label={isOnline ? 'Online (Sync Ready)' : 'Offline Vault Active'}
              />
            </span>

            <Button
              type="button"
              variant="secondary"
              size="sm"
              loading={refreshingManifest}
              disabled={!isOnline}
              onClick={() => void handleRefreshManifest(false)}
              icon={<RefreshCw className="h-4 w-4" />}
            >
              Refresh 24h Lease
            </Button>

            <Button
              type="button"
              variant="primary"
              size="sm"
              loading={syncingRecords}
              disabled={!isOnline || pendingRecords.length === 0}
              onClick={() => void handleSyncQueuedRecords()}
              icon={<UploadCloud className="h-4 w-4" />}
            >
              Sync ({pendingRecords.length})
            </Button>

            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => void handleSignOut()}
              icon={<LogOut className="h-4 w-4" />}
            >
              Sign Out
            </Button>
          </div>
        </div>
      </header>

      <main id="main-content" className="mx-auto max-w-7xl space-y-6 p-4 sm:p-6">
        {/* Governance Notice */}
        <div
          className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950"
          role="region"
          aria-label="Emergency mode boundaries"
        >
          <div className="flex items-start gap-3">
            <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-amber-700" aria-hidden="true" />
            <div className="space-y-1">
              <p className="font-semibold">
                Strict Contingency Mode — Entries remain permanently classified as{' '}
                <span className="underline">OFFLINE MODE RECORDED</span>
              </p>
              <p className="text-xs leading-relaxed text-amber-900">
                This device does not generate QR gate passes, does not collect visitor selfies, ID uploads, or postal codes,
                and never converts offline records into standard passes automatically. Every intake record is AES-GCM encrypted
                locally with physical ID inspection attestation and awaits reconciliation when synced.
              </p>
            </div>
          </div>
        </div>

        {vaultError && (
          <div
            className="flex items-start gap-2 rounded-xl border border-[var(--color-danger)] bg-[var(--color-danger-light)] p-4 text-sm text-[var(--color-danger-dark)]"
            role="alert"
          >
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
            <div>
              <p className="font-semibold">Encrypted Vault Notice</p>
              <p className="text-xs">{vaultError}</p>
            </div>
          </div>
        )}

        {/* Lease & Vault Status Summary */}
        <div className="grid gap-4 md:grid-cols-2">
          <Card>
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">
                  Signed Gate Manifest Lease
                </p>
                <div className="mt-1.5 flex flex-wrap items-center gap-2">
                  <StatusBadge
                    status={getLeaseBadgeStatus(verification.leaseStatus)}
                    label={getLeaseLabel(verification.leaseStatus)}
                  />
                  {manifest && (
                    <span className="inline-flex items-center gap-1 text-xs text-[var(--color-text-secondary)]">
                      <KeyRound className="h-3.5 w-3.5" aria-hidden="true" />
                      ECDSA P-256 ({manifest.keyId})
                    </span>
                  )}
                </div>
              </div>
              {verification.leaseStatus === 'valid' ? (
                <ShieldCheck className="h-6 w-6 shrink-0 text-[var(--color-success)]" aria-hidden="true" />
              ) : (
                <AlertTriangle className="h-6 w-6 shrink-0 text-amber-600" aria-hidden="true" />
              )}
            </div>

            <p className="mt-3 text-xs leading-relaxed text-[var(--color-text-secondary)]">
              {verification.reason}
            </p>

            {manifest && (
              <dl className="mt-3 grid grid-cols-2 gap-2 rounded-lg bg-[var(--color-canvas-subtle)] p-3 text-xs">
                <div>
                  <dt className="text-[var(--color-text-muted)]">Issued At</dt>
                  <dd className="font-medium">{formatManilaTimestamp(manifest.payload.issuedAt)}</dd>
                </div>
                <div>
                  <dt className="text-[var(--color-text-muted)]">Lease Expires</dt>
                  <dd className="font-medium">{formatManilaTimestamp(manifest.payload.expiresAt)}</dd>
                </div>
                <div>
                  <dt className="text-[var(--color-text-muted)]">Snapshot Version</dt>
                  <dd className="font-mono text-[11px]">{manifest.payload.snapshotVersion}</dd>
                </div>
                <div>
                  <dt className="text-[var(--color-text-muted)]">Emergency Exception Policy</dt>
                  <dd className="font-semibold">
                    {manifest.payload.allowEmergencyException ? 'Enabled (Reason Required)' : 'Disabled (Default OFF)'}
                  </dd>
                </div>
              </dl>
            )}
          </Card>

          <Card>
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">
                  AES-256-GCM Encrypted IndexedDB Queue
                </p>
                <p className="mt-1 text-lg font-bold">
                  Monotonic Sequence #{lastSequence}
                </p>
              </div>
              <Lock className="h-6 w-6 shrink-0 text-[var(--color-brand)]" aria-hidden="true" />
            </div>

            <div className="mt-4 grid grid-cols-4 gap-2 text-center">
              <div className="rounded-lg border border-[var(--color-border)] p-2">
                <div className="text-lg font-bold">{queueCounts.pending_sync}</div>
                <div className="text-[11px] text-[var(--color-text-secondary)]">Pending</div>
              </div>
              <div className="rounded-lg border border-[var(--color-border)] p-2">
                <div className="text-lg font-bold text-[var(--color-success)]">{queueCounts.synced}</div>
                <div className="text-[11px] text-[var(--color-text-secondary)]">Synced</div>
              </div>
              <div className="rounded-lg border border-[var(--color-border)] p-2">
                <div className="text-lg font-bold text-amber-700">{queueCounts.conflict}</div>
                <div className="text-[11px] text-[var(--color-text-secondary)]">Conflict</div>
              </div>
              <div className="rounded-lg border border-[var(--color-border)] p-2">
                <div className="text-lg font-bold text-[var(--color-danger)]">{queueCounts.rejected}</div>
                <div className="text-[11px] text-[var(--color-text-secondary)]">Rejected</div>
              </div>
            </div>
          </Card>
        </div>

        <div className="grid gap-6 lg:grid-cols-12">
          {/* Left Column: Offline Gate Intake Form */}
          <Card className="lg:col-span-6">
            <div className="mb-4 flex items-center justify-between gap-2">
              <div>
                <h2 className="text-base font-bold">Record Offline Gate Entry</h2>
                <p className="text-xs text-[var(--color-text-secondary)]">
                  Gate-locked to <span className="font-semibold">{assignedGate}</span> · Sequence #{lastSequence + 1}
                </p>
              </div>
              <StatusBadge status="warning" label="OFFLINE MODE RECORDED" />
            </div>

            <form onSubmit={(e) => void handleRecordOfflineEntry(e)} className="space-y-4">
              <FormField label="Visitor Full Name" requirement="required" id="ed-visitor-name">
                <Input
                  id="ed-visitor-name"
                  required
                  minLength={2}
                  maxLength={120}
                  value={visitorFullName}
                  onChange={(e) => setVisitorFullName(e.target.value)}
                  placeholder="Enter full name from physical ID"
                />
              </FormField>

              <FormField
                label="Declared Address"
                requirement="required"
                id="ed-declared-address"
                hint="Barangay / Street / Municipality. Postal codes are not collected."
              >
                <Input
                  id="ed-declared-address"
                  required
                  minLength={5}
                  maxLength={250}
                  value={declaredAddress}
                  onChange={(e) => setDeclaredAddress(e.target.value)}
                  placeholder="Enter visitor declared address"
                />
              </FormField>

              <FormField label="Purpose of Visit" requirement="required" id="ed-purpose">
                <Input
                  id="ed-purpose"
                  required
                  minLength={2}
                  maxLength={200}
                  value={purpose}
                  onChange={(e) => setPurpose(e.target.value)}
                  placeholder="e.g., Registrar inquiry, delivery, appointment"
                />
              </FormField>

              {/* Destination Office Selector with unresolved snapshot fallback */}
              <div className="space-y-2">
                {cachedOffices.length > 0 && !useManualOffice ? (
                  <FormField
                    label="Destination Office (Signed Snapshot)"
                    requirement="required"
                    id="ed-office-select"
                    hint={
                      selectedOfficeObj?.requiresApprovalBeforePass
                        ? 'This office normally requires pre-approval before pass issuance. Admin/Office reconciliation will review this offline entry.'
                        : 'Selected from verified signed office snapshot.'
                    }
                  >
                    <Select
                      id="ed-office-select"
                      value={selectedOfficeId}
                      onChange={(e) => setSelectedOfficeId(e.target.value)}
                    >
                      {cachedOffices.map((office) => (
                        <option key={office.id} value={office.id}>
                          {office.name}
                          {office.code ? ` (${office.code})` : ''}
                          {office.requiresApprovalBeforePass ? ' — Approval Required' : ''}
                        </option>
                      ))}
                    </Select>
                  </FormField>
                ) : (
                  <FormField
                    label="Destination Office Name (Unresolved Snapshot Entry)"
                    requirement="required"
                    id="ed-office-manual"
                    hint="Recorded as unresolved_stale_snapshot for post-sync Admin/Office reconciliation."
                  >
                    <Input
                      id="ed-office-manual"
                      required
                      minLength={2}
                      maxLength={120}
                      value={manualOfficeName}
                      onChange={(e) => setManualOfficeName(e.target.value)}
                      placeholder="Enter office or person destination"
                    />
                  </FormField>
                )}

                {cachedOffices.length > 0 && (
                  <label className="inline-flex cursor-pointer items-center gap-2 text-xs text-[var(--color-text-secondary)]">
                    <input
                      type="checkbox"
                      checked={useManualOffice}
                      onChange={(e) => setUseManualOffice(e.target.checked)}
                      className="h-4 w-4 rounded border-[var(--color-border-strong)]"
                    />
                    <span>Office not listed in cached snapshot (record manually)</span>
                  </label>
                )}
              </div>

              {/* Mandatory Physical ID Inspection Attestation */}
              <div className="rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-canvas-subtle)] p-3">
                <label className="flex cursor-pointer items-start gap-2.5 text-xs leading-relaxed">
                  <input
                    id="ed-id-attestation"
                    type="checkbox"
                    checked={idPhysicallyInspected}
                    onChange={(e) => setIdPhysicallyInspected(e.target.checked)}
                    className="mt-0.5 h-4 w-4 shrink-0 rounded border-[var(--color-border-strong)]"
                  />
                  <span className="font-medium text-[var(--color-text-primary)]">
                    {PHYSICAL_ID_ATTESTATION_TEXT}
                  </span>
                </label>
              </div>

              {/* Policy-Gated Emergency Exception */}
              <div className="rounded-lg border border-[var(--color-border)] p-3 space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <label
                    className={`flex items-center gap-2 text-xs font-semibold ${
                      allowEmergencyException
                        ? 'cursor-pointer text-[var(--color-text-primary)]'
                        : 'cursor-not-allowed text-[var(--color-text-muted)]'
                    }`}
                  >
                    <input
                      type="checkbox"
                      disabled={!allowEmergencyException}
                      checked={emergencyExceptionApplied}
                      onChange={(e) => setEmergencyExceptionApplied(e.target.checked)}
                      className="h-4 w-4 rounded border-[var(--color-border-strong)]"
                    />
                    <span>Apply Gate Emergency Exception</span>
                  </label>
                  <StatusBadge
                    status={allowEmergencyException ? 'warning' : 'inactive'}
                    label={allowEmergencyException ? 'Policy Allowed' : 'Disabled by Policy'}
                  />
                </div>

                <p className="text-[11px] text-[var(--color-text-secondary)]">
                  {allowEmergencyException
                    ? manifest?.payload.emergencyExceptionPolicyNote ||
                      'Superadmin policy allows emergency exceptions on this manifest with mandatory justification.'
                    : 'Emergency exceptions are OFF by default and cannot be applied unless explicitly authorized by Superadmin in System Settings.'}
                </p>

                {allowEmergencyException && emergencyExceptionApplied && (
                  <FormField label="Emergency Exception Reason" requirement="required" id="ed-exception-reason">
                    <Textarea
                      id="ed-exception-reason"
                      required
                      minLength={5}
                      maxLength={300}
                      value={emergencyExceptionReason}
                      onChange={(e) => setEmergencyExceptionReason(e.target.value)}
                      placeholder="Specify verified urgency reason for post-outage Superadmin review"
                    />
                  </FormField>
                )}
              </div>

              <Button
                type="submit"
                variant="primary"
                className="w-full"
                loading={submittingIntake}
                disabled={!idPhysicallyInspected || loadingVault}
                icon={<ClipboardCheck className="h-4 w-4" />}
              >
                Save Encrypted Offline Entry
              </Button>
            </form>
          </Card>

          {/* Right Column: Expected Arrivals Preview + Local Vault Queue */}
          <div className="space-y-6 lg:col-span-6">
            <Card>
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h2 className="text-base font-bold">
                    Expected Arrivals Snapshot ({assignedGate})
                  </h2>
                  <p className="text-xs text-[var(--color-text-secondary)]">
                    Read-only manifest list for visual gate verification during outages.
                  </p>
                </div>
                <StatusBadge
                  status="inactive"
                  label={`${manifest?.payload.expectedPasses.length ?? 0} Expected`}
                />
              </div>

              <div className="relative mb-3">
                <Search
                  className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--color-text-muted)]"
                  aria-hidden="true"
                />
                <Input
                  value={expectedSearch}
                  onChange={(e) => setExpectedSearch(e.target.value)}
                  placeholder="Search expected visitor, reference code, or office..."
                  className="pl-9"
                  aria-label="Search expected arrivals"
                />
              </div>

              {filteredExpectedPasses.length === 0 ? (
                <div className="rounded-lg border border-dashed border-[var(--color-border-strong)] p-6 text-center text-xs text-[var(--color-text-secondary)]">
                  {manifest
                    ? 'No matching expected arrivals in this gate snapshot.'
                    : 'Refresh 24-hour signed lease online to download expected arrivals.'}
                </div>
              ) : (
                <ul className="max-h-64 space-y-2 overflow-y-auto pr-1">
                  {filteredExpectedPasses.map((item) => (
                    <li
                      key={item.passId}
                      className="rounded-lg border border-[var(--color-border)] bg-white p-3 text-xs"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="font-semibold text-[var(--color-text-primary)]">
                          {item.visitorName}
                        </span>
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="rounded bg-[var(--color-canvas-subtle)] px-1.5 py-0.5 font-mono text-[11px]">
                            {item.referenceCode}
                          </span>
                          <StatusBadge
                            status={item.requiresApproval ? 'warning' : 'approved'}
                            label={item.requiresApproval ? 'Approval Required' : item.status}
                          />
                        </div>
                      </div>
                      <p className="mt-1 text-[var(--color-text-secondary)]">
                        {item.officeName ? `Office: ${item.officeName} · ` : ''}
                        Purpose: {item.purpose}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            <Card>
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h2 className="text-base font-bold">Encrypted Local Queue</h2>
                  <p className="text-xs text-[var(--color-text-secondary)]">
                    Stored in AES-256-GCM IndexedDB until reconciled on Admin Portal.
                  </p>
                </div>
                <span className="inline-flex items-center gap-1 text-xs font-medium text-[var(--color-text-secondary)]">
                  <CloudOff className="h-3.5 w-3.5" aria-hidden="true" />
                  {records.length} Total
                </span>
              </div>

              {loadingVault ? (
                <p className="py-6 text-center text-xs text-[var(--color-text-secondary)]">
                  Decrypting local vault...
                </p>
              ) : records.length === 0 ? (
                <div className="rounded-lg border border-dashed border-[var(--color-border-strong)] p-6 text-center text-xs text-[var(--color-text-secondary)]">
                  No emergency gate entries captured on this device yet.
                </div>
              ) : (
                <ul className="max-h-80 space-y-2 overflow-y-auto pr-1">
                  {[...records].reverse().map((rec) => (
                    <li
                      key={rec.recordId}
                      className="rounded-lg border border-[var(--color-border)] bg-white p-3 text-xs space-y-1"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="font-mono font-bold text-[var(--color-brand)]">
                            #{rec.localSequence}
                          </span>
                          <span className="font-semibold text-[var(--color-text-primary)]">
                            {rec.visitorFullName}
                          </span>
                        </div>
                        <div className="flex flex-wrap items-center gap-1.5">
                          <StatusBadge status="warning" label={rec.classification} />
                          <StatusBadge
                            status={getSyncBadgeStatus(rec.syncStatus)}
                            label={
                              rec.syncStatus === 'pending_sync'
                                ? 'Pending Sync'
                                : rec.syncStatus === 'synced'
                                  ? 'Synced'
                                  : rec.syncStatus === 'conflict'
                                    ? 'Conflict'
                                    : 'Rejected'
                            }
                          />
                        </div>
                      </div>
                      <p className="text-[var(--color-text-secondary)]">
                        Destination: <span className="font-medium">{rec.destinationOfficeNameSnapshot}</span>
                        {rec.officeResolutionStatus === 'unresolved_stale_snapshot' ? ' (Unresolved Snapshot)' : ''}
                      </p>
                      <p className="text-[11px] text-[var(--color-text-muted)]">
                        Captured: {formatManilaTimestamp(rec.localRecordedAt)} · Lease: {rec.leaseStatusAtRecord}
                        {rec.emergencyExceptionApplied ? ' · Emergency Exception Applied' : ''}
                      </p>
                      {rec.syncStatus === 'synced' && (
                        <p className="inline-flex items-center gap-1 text-[11px] font-medium text-[var(--color-success)]">
                          <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
                          {rec.serverOutcome || 'Synced as OFFLINE MODE RECORDED'}
                        </p>
                      )}
                      {rec.serverMessage && (
                        <p className="text-[11px] font-medium text-[var(--color-danger)]">
                          {rec.serverOutcome}: {rec.serverMessage}
                        </p>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>
        </div>
      </main>
    </div>
  );
}
