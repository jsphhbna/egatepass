import { useState, useEffect } from 'react';
import { useWebcam } from '@/hooks/useWebcam';
import { useObjectUrl } from '@/hooks/useObjectUrl';
import { compressImageToWebP } from '@/lib/imageProcessing';
import { Button, Card, FormField, Input, Modal } from '@/components/ui';
import { CameraControls } from '@/components/CameraControls';
import {
  Camera,
  CheckCircle2,
  XCircle,
  RotateCcw,
  ShieldCheck,
  AlertTriangle,
} from 'lucide-react';
import { toast } from 'sonner';
import {
  saveOfflineRegistrationWithCache,
  type OfflineRegistrationRecord,
} from '@/lib/offline/guardIndexedDb';
import { syncAllPending } from '@/lib/offline/guardSyncManager';
import { getManilaDateString } from '@/lib/scheduling';
import { formatManilaTime } from '@/lib/manilaTime';

export interface GuardOfflineRegistrationTabProps {
  isBackendOnline: boolean;
  actorId?: string;
  onRegistered?: () => void;
}

export function GuardOfflineRegistrationTab({
  isBackendOnline,
  actorId,
  onRegistered,
}: GuardOfflineRegistrationTabProps) {
  const today = getManilaDateString();

  const [firstName, setFirstName] = useState('');
  const [middleName, setMiddleName] = useState('');
  const [lastName, setLastName] = useState('');
  const [contactNumber, setContactNumber] = useState('');
  const [purpose, setPurpose] = useState('');

  const [captureMode, setCaptureMode] = useState<'none' | 'photo' | 'id'>('none');
  const [photoBlob, setPhotoBlob] = useState<Blob | null>(null);
  const photoUrl = useObjectUrl();
  const [idBlob, setIdBlob] = useState<Blob | null>(null);
  const idUrl = useObjectUrl();

  const [saving, setSaving] = useState(false);
  const [completedRecord, setCompletedRecord] = useState<OfflineRegistrationRecord | null>(null);
  const [showRejectModal, setShowRejectModal] = useState(false);
  const [rejectReason, setRejectReason] = useState('');

  const webcam = useWebcam({
    facingMode: 'user',
    width: 640,
    height: 480,
    allowCaptureMirroring: true,
  });

  useEffect(() => {
    return () => {
      webcam.stop();
    };
  }, []);

  function startPhotoCapture() {
    setCaptureMode('photo');
    webcam.start({ facingMode: 'user' });
  }

  function startIdCapture() {
    setCaptureMode('id');
    webcam.start({ facingMode: 'environment' });
  }

  async function handleCapture() {
    const raw = captureMode === 'photo'
      ? webcam.capture({ mirror: webcam.mirrorPreview })
      : webcam.capture({ mirror: false });
    if (!raw) {
      toast.error('Failed to capture frame from camera');
      return;
    }

    try {
      const compressed = await compressImageToWebP(raw);
      if (captureMode === 'photo') {
        setPhotoBlob(compressed);
        photoUrl.setFromBlob(compressed);
        toast.success('Visitor selfie captured');
      } else {
        setIdBlob(compressed);
        idUrl.setFromBlob(compressed);
        toast.success('Valid ID captured');
      }
      webcam.stop();
      setCaptureMode('none');
    } catch {
      toast.error('Failed to process captured image');
    }
  }

  function handleCancelCapture() {
    webcam.stop();
    setCaptureMode('none');
  }

  function validateForm(isApproval = false): boolean {
    if (!firstName.trim() || !lastName.trim()) {
      toast.error('Visitor first and last name are required');
      return false;
    }
    if (!contactNumber.trim() || contactNumber.trim().length < 7) {
      toast.error('Valid contact number is required');
      return false;
    }
    if (!purpose.trim()) {
      toast.error('Visit purpose is required');
      return false;
    }
    if (!photoBlob) {
      toast.error('Visitor selfie photo is required');
      return false;
    }
    if (isApproval && !idBlob) {
      toast.error('Valid government or institutional ID capture is strictly required to approve entry');
      return false;
    }
    return true;
  }

  async function handleApproveEntry() {
    if (!validateForm(true)) return;

    setSaving(true);
    const offlineRegistrationId = crypto.randomUUID();
    const occurredAt = new Date().toISOString();

    const record: OfflineRegistrationRecord = {
      offlineRegistrationId,
      actorId: actorId || '',
      visitor: {
        firstName: firstName.trim(),
        middleName: middleName.trim() || undefined,
        lastName: lastName.trim(),
        contactNumber: contactNumber.trim(),
        purpose: purpose.trim(),
        visitDate: today,
      },
      action: 'approved',
      occurredAt,
      photoBlob: photoBlob!,
      idBlob: idBlob ?? null,
      rejectionReason: null,
      syncStatus: 'pending',
    };

    try {
      // Atomic registration + projected visitor cache insert (Root Causes 2.2 and 2.3)
      await saveOfflineRegistrationWithCache(actorId ? actorId : record, actorId ? record : undefined);

      setCompletedRecord(record);
      toast.success('Visitor entry approved offline (Stored on this device pending synchronization)');
      onRegistered?.();

      // Trigger background sync if online
      if (isBackendOnline) {
        void syncAllPending().catch(() => undefined);
      }
    } catch (err: any) {
      console.error('Failed to save offline registration:', err);
      toast.error('Failed to save offline record on device');
    } finally {
      setSaving(false);
    }
  }

  async function handleConfirmReject() {
    if (!validateForm()) return;

    const reason = rejectReason.trim() || 'Rejected during offline intake by Guard';
    setSaving(true);
    const offlineRegistrationId = crypto.randomUUID();
    const occurredAt = new Date().toISOString();

    const record: OfflineRegistrationRecord = {
      offlineRegistrationId,
      actorId: actorId || '',
      visitor: {
        firstName: firstName.trim(),
        middleName: middleName.trim() || undefined,
        lastName: lastName.trim(),
        contactNumber: contactNumber.trim(),
        purpose: purpose.trim(),
        visitDate: today,
      },
      action: 'rejected',
      occurredAt,
      photoBlob: photoBlob!,
      idBlob: idBlob ?? null,
      rejectionReason: reason,
      syncStatus: 'pending',
    };

    try {
      await saveOfflineRegistrationWithCache(actorId ? actorId : record, actorId ? record : undefined);
      setShowRejectModal(false);
      setCompletedRecord(record);
      toast.success('Visitor rejection recorded offline (Stored on this device pending synchronization)');
      onRegistered?.();

      if (isBackendOnline) {
        void syncAllPending().catch(() => undefined);
      }
    } catch (err: any) {
      console.error('Failed to save offline rejection:', err);
      toast.error('Failed to save rejection record');
    } finally {
      setSaving(false);
    }
  }

  function handleNewIntake() {
    setFirstName('');
    setMiddleName('');
    setLastName('');
    setContactNumber('');
    setPurpose('');
    setPhotoBlob(null);
    photoUrl.clear();
    setIdBlob(null);
    idUrl.clear();
    setCompletedRecord(null);
    setRejectReason('');
  }

  if (completedRecord) {
    const fullName = [
      completedRecord.visitor.firstName,
      completedRecord.visitor.middleName,
      completedRecord.visitor.lastName,
    ]
      .filter(Boolean)
      .join(' ');

    return (
      <Card className="max-w-xl mx-auto p-8 text-center space-y-6">
        <div
          className={`mx-auto flex h-16 w-16 items-center justify-center rounded-full ${
            completedRecord.action === 'approved'
              ? 'bg-emerald-100 text-emerald-600 dark:bg-emerald-950/60 dark:text-emerald-400'
              : 'bg-red-100 text-red-600 dark:bg-red-950/60 dark:text-red-400'
          }`}
        >
          {completedRecord.action === 'approved' ? (
            <CheckCircle2 className="h-8 w-8" />
          ) : (
            <XCircle className="h-8 w-8" />
          )}
        </div>

        <div>
          <h2 className="text-2xl font-black tracking-tight text-[var(--color-text-primary)] uppercase">
            {completedRecord.action === 'approved' ? '✓ ENTRY APPROVED' : 'ENTRY REJECTED'}
          </h2>
          <p className="mt-1 text-lg font-bold text-[var(--color-brand)]">{fullName}</p>
          {completedRecord.action === 'approved' && (
            <p className="mt-1 text-sm font-semibold text-[var(--color-text-secondary)]">
              Time In: {formatManilaTime(completedRecord.occurredAt)}
            </p>
          )}
        </div>

        <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-xs font-medium text-amber-900 dark:text-amber-200 text-left space-y-1">
          <p className="font-bold flex items-center gap-1.5">
            <AlertTriangle className="h-4 w-4 shrink-0 text-amber-600" />
            <span>Stored on this device pending synchronization</span>
          </p>
          <p>Registration ID: {completedRecord.offlineRegistrationId}</p>
          <p>This record will automatically synchronize as soon as cloud connectivity returns.</p>
        </div>

        <Button onClick={handleNewIntake} className="w-full">
          Register Another Visitor
        </Button>
      </Card>
    );
  }

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <Card className="p-6">
        <div className="border-b border-[var(--color-border)] pb-4 mb-6">
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-6 w-6 text-[var(--color-brand)]" />
            <h2 className="text-xl font-bold text-[var(--color-text-primary)]">
              Guard Offline Visitor Intake
            </h2>
          </div>
          <p className="mt-1 text-xs text-[var(--color-text-secondary)]">
            Use when the kiosk or backend is unreachable. You physically verify the visitor and their presented ID.
          </p>
        </div>

        {/* Camera Modal / Viewport */}
        {captureMode !== 'none' && (
          <div className="mb-6 rounded-2xl border-2 border-dashed border-[var(--color-brand)] bg-black p-4 text-center">
            <h3 className="text-sm font-bold text-white mb-2">
              {captureMode === 'photo' ? 'Capture Visitor Selfie' : 'Capture Presented Physical ID'}
            </h3>
            <div className="relative mx-auto aspect-[4/3] max-w-md overflow-hidden rounded-xl border border-white/20">
              <video
                ref={webcam.videoRef}
                autoPlay
                playsInline
                muted
                className="h-full w-full object-cover"
                style={{ transform: webcam.mirrorPreview ? 'scaleX(-1)' : 'none' }}
              />
            </div>
            <div className="mt-2 max-w-md mx-auto">
              <CameraControls
                activeFacingMode={webcam.activeFacingMode}
                mirrorPreview={webcam.mirrorPreview}
                canSwitchCamera={webcam.canSwitchCamera}
                onSwitchCamera={webcam.switchCamera}
                onToggleMirror={webcam.toggleMirrorPreview}
              />
            </div>
            <div className="mt-4 flex justify-center gap-3">
              <Button variant="secondary" size="sm" onClick={handleCancelCapture}>
                Cancel
              </Button>
              <Button size="sm" onClick={() => void handleCapture()} icon={<Camera className="h-4 w-4" />}>
                Snap Photo
              </Button>
            </div>
          </div>
        )}

        {/* Form Fields */}
        <div className="space-y-4 text-sm">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <FormField label="First Name" requirement="required" id="offline-first-name">
              <Input
                id="offline-first-name"
                type="text"
                required
                aria-required="true"
                value={firstName}
                onChange={(e) => setFirstName(e.target.value)}
                placeholder="e.g. Juan"
              />
            </FormField>
            <FormField label="Middle Name" requirement="optional" id="offline-middle-name">
              <Input
                id="offline-middle-name"
                type="text"
                value={middleName}
                onChange={(e) => setMiddleName(e.target.value)}
                placeholder="Optional"
              />
            </FormField>
            <FormField label="Last Name" requirement="required" id="offline-last-name">
              <Input
                id="offline-last-name"
                type="text"
                required
                aria-required="true"
                value={lastName}
                onChange={(e) => setLastName(e.target.value)}
                placeholder="e.g. Dela Cruz"
              />
            </FormField>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <FormField label="Contact Number" requirement="required" id="offline-contact-number">
              <Input
                id="offline-contact-number"
                type="tel"
                required
                aria-required="true"
                value={contactNumber}
                onChange={(e) => setContactNumber(e.target.value)}
                placeholder="09XXXXXXXXX"
              />
            </FormField>
            <FormField label="Visit Date (Current Manila Date)" id="offline-visit-date">
              <Input
                id="offline-visit-date"
                type="date"
                value={today}
                disabled
                readOnly
                className="cursor-not-allowed bg-[var(--color-surface-hover)] text-[var(--color-text-secondary)]"
              />
            </FormField>
          </div>

          <FormField label="Purpose of Visit" requirement="required" id="offline-purpose">
            <Input
              id="offline-purpose"
              type="text"
              required
              aria-required="true"
              value={purpose}
              onChange={(e) => setPurpose(e.target.value)}
              placeholder="e.g. Registrar inquiry, Admission exam, Department meeting"
            />
          </FormField>

          {/* Photo & ID Capture Buttons */}
          <div className="pt-2 border-t border-[var(--color-border)]">
            <p className="text-xs font-bold text-[var(--color-text-secondary)] mb-2 uppercase tracking-wide">
              Physical Evidence Capture
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {/* Selfie */}
              <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-canvas)] p-4 text-center">
                <p className="text-xs font-semibold text-[var(--color-text-primary)] mb-2">
                  Visitor Photo (Selfie) *
                </p>
                {photoUrl.url ? (
                  <div className="space-y-2">
                    <img src={photoUrl.url} alt="Selfie preview" className="h-28 w-24 object-cover mx-auto rounded-lg border" />
                    <Button size="sm" variant="secondary" onClick={startPhotoCapture} icon={<RotateCcw className="h-3.5 w-3.5" />}>
                      Retake Selfie
                    </Button>
                  </div>
                ) : (
                  <Button size="sm" variant="secondary" onClick={startPhotoCapture} icon={<Camera className="h-4 w-4" />}>
                    Capture Selfie
                  </Button>
                )}
              </div>

              {/* ID */}
              <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-canvas)] p-4 text-center">
                <p className="text-xs font-semibold text-[var(--color-text-primary)] mb-2">
                  Presented Valid ID — Required for approval
                </p>
                {idUrl.url ? (
                  <div className="space-y-2">
                    <img src={idUrl.url} alt="ID preview" className="h-28 w-40 object-cover mx-auto rounded-lg border" />
                    <Button size="sm" variant="secondary" onClick={startIdCapture} icon={<RotateCcw className="h-3.5 w-3.5" />}>
                      Retake ID
                    </Button>
                  </div>
                ) : (
                  <Button size="sm" variant="secondary" onClick={startIdCapture} icon={<Camera className="h-4 w-4" />}>
                    Capture ID
                  </Button>
                )}
              </div>
            </div>
          </div>

          {/* Verification Notice */}
          <div className="rounded-xl bg-[var(--color-surface)] p-3 text-xs text-[var(--color-text-secondary)] border border-[var(--color-border)]">
            <p className="font-semibold text-[var(--color-text-primary)] mb-0.5">Physical Verification Notice:</p>
            <p>You must confirm that the visitor in front of you matches the physical government/school ID presented.</p>
          </div>

          {/* Action Buttons */}
          <div className="pt-4 flex gap-3">
            <Button
              variant="destructive-outline"
              onClick={() => setShowRejectModal(true)}
              disabled={saving}
              className="flex-1"
              icon={<XCircle className="h-4 w-4" />}
            >
              Reject Visitor
            </Button>
            <Button
              onClick={() => void handleApproveEntry()}
              disabled={saving}
              loading={saving}
              className="flex-1 bg-emerald-600 hover:bg-emerald-700 text-white"
              icon={<CheckCircle2 className="h-4 w-4" />}
            >
              Approve Entry (Time In)
            </Button>
          </div>
        </div>
      </Card>

      {/* Reject Modal */}
      <Modal
        isOpen={showRejectModal}
        onClose={() => setShowRejectModal(false)}
        title="Reject Offline Visitor"
        description="Specify the reason for refusing entry."
      >
        <div className="p-6">
          <FormField label="Reason" requirement="required">
            <textarea
              id="offline-reject-reason"
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              placeholder="e.g. Expired ID, dress code violation, security concern..."
              className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-canvas)] p-3 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-brand)]"
              rows={3}
              required
              aria-required="true"
              autoFocus
            />
          </FormField>
          <div className="mt-5 flex justify-end gap-3">
            <Button variant="secondary" onClick={() => setShowRejectModal(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => void handleConfirmReject()}
              loading={saving}
              disabled={saving}
            >
              Record Rejection
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
