import { useState, useEffect, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Save,
  Trash2,
  AlertTriangle,
  Plus,
  Shield,
  Clock,
  Users,
  Database,
  CheckCircle,
  FileText,
  Lock,
  Camera,
  Car,
  KeyRound,
  ShieldAlert,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button, Card, Input, Select, ConfirmModal, LoadingState, Modal, FormField } from '@/components/ui';
import { CampusCalendar } from '@/components/CampusCalendar';
import { PasswordResetCard } from '@/components/ChangePasswordCard';
import { DEFAULT_REJECTION_REASONS, normalizeVisitPurposes } from '@/lib/settingsDefaults';
import type { VisitPurposeOption } from '@/types';
import { useAuth } from '@/hooks/useAuth';
import { isSuperAdmin } from '@/lib/permissions';
import { getAccessToken } from '@/services/auth';
import { DEFAULT_WORKING_HOURS, normalizeWorkingHours } from '@/lib/workingHours';
import { DEFAULT_RETENTION_POLICY, normalizeRetentionPolicy } from '@/lib/retentionPolicy';
import {
  createRetentionInputValues,
  getRetentionInputError,
  validateRetentionInputs,
  type RetentionInputErrors,
  type RetentionInputField,
} from '@/lib/retentionInput';

export type PeakModeScope = 'off' | 'portal' | 'kiosk' | 'both';

export function tryAcquireSettingsMutation(inFlightRef: { current: boolean }, busy: boolean): boolean {
  if (inFlightRef.current || busy) return false;
  inFlightRef.current = true;
  return true;
}

export const DEFAULT_VISITOR_INSTRUCTIONS: string[] = [
  'Follow the EARIST visitor dress code and campus policies.',
  'Bring a valid ID for identity verification at the gate.',
  'Keep your E-GatePass ready before approaching the entrance.',
  'This visitor pass is personal and non-transferable.',
  'Scan your E-GatePass when leaving the campus.',
];

export function AdminSettings() {
  const { role, userData } = useAuth();
  const [searchParams] = useSearchParams();
  const currentTab = searchParams.get('tab') || 'general';

  const canManageSecuritySettings = isSuperAdmin(role);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [purging, setPurging] = useState(false);
  const [calculatingPurge, setCalculatingPurge] = useState(false);

  const settingsBusy = saving || purging || calculatingPurge;
  const settingsMutationInFlightRef = useRef(false);

  const [settings, setSettings] = useState({
    ...DEFAULT_RETENTION_POLICY,
    workingHours: DEFAULT_WORKING_HOURS,
    peakMode: 'off' as PeakModeScope,
    rejectionReasons: DEFAULT_REJECTION_REASONS,
    visitPurposes: [] as VisitPurposeOption[],
    visitorInstructions: DEFAULT_VISITOR_INSTRUCTIONS,
    globalRetentionFreeze: false,
    globalRetentionFreezeReason: '',
    globalRetentionFreezeUpdatedAt: null as string | null,
    allowEmergencyException: false,
    emergencyExceptionPolicyNote: '',
    emergencyRecordRetentionEnabled: true,
    emergencyRecordRetentionDays: '90',
    defaultExpectedGate: '',
    securityInfo: {
      turnstileSiteKeyConfigured: false,
      turnstileVerifierConfigured: false,
      turnstileFullyVerified: false,
      biometricStorageRetired: true,
    },
  });
  const [retentionInputs, setRetentionInputs] = useState(() => createRetentionInputValues(DEFAULT_RETENTION_POLICY));
  const [retentionErrors, setRetentionErrors] = useState<RetentionInputErrors>({});

  const [newPurpose, setNewPurpose] = useState('');
  const [newInstruction, setNewInstruction] = useState('');
  const [retentionOverrideReason, setRetentionOverrideReason] = useState('');
  
  // Modals state
  const [showPeakModeConfirm, setShowPeakModeConfirm] = useState(false);
  const [pendingPeakMode, setPendingPeakMode] = useState<PeakModeScope | null>(null);
  const [showPurgeConfirm, setShowPurgeConfirm] = useState(false);
  const [purgeEligibleCount, setPurgeEligibleCount] = useState<number | null>(null);
  const [purgePhotoRetentionDays, setPurgePhotoRetentionDays] = useState<number | null>(null);
  const [purgeIdRetentionDays, setPurgeIdRetentionDays] = useState<number | null>(null);
  const [showOverridePurgeModal, setShowOverridePurgeModal] = useState(false);
  const [overrideReason, setOverrideReason] = useState('');
  const [overrideCategories, setOverrideCategories] = useState<string[]>(['photo', 'id', 'vehicle_photo']);
  const [isExecutingOverride, setIsExecutingOverride] = useState(false);

  async function loadSettings(options?: { background?: boolean }): Promise<{ ok: boolean; error?: string }> {
    const isBackground = Boolean(options?.background);
    if (!isBackground) {
      setLoading(true);
      setLoadError(null);
    }
    try {
      const token = await getAccessToken();
      const res = await fetch('/api/admin/settings', {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (res.ok) {
        const data = await res.json();
        const retentionPolicy = normalizeRetentionPolicy(data);
        const rawScope = data.peakModeScope;
        const peakScope: PeakModeScope = (['off', 'portal', 'kiosk', 'both'].includes(rawScope)
          ? rawScope
          : (data.peakMode ? 'both' : 'off')) as PeakModeScope;
        const loadedRejectionReasons = Array.isArray(data.rejectionReasons)
          ? data.rejectionReasons
              .filter((r: unknown): r is string => typeof r === 'string' && r.trim().length > 0)
              .map((r: string) => r.trim())
          : DEFAULT_REJECTION_REASONS;
        setSettings({
          ...retentionPolicy,
          workingHours: normalizeWorkingHours(data.workingHours),
          peakMode: peakScope,
          rejectionReasons: loadedRejectionReasons,
          visitPurposes: normalizeVisitPurposes(data.visitPurposes),
          visitorInstructions: Array.isArray(data.visitorInstructions) && data.visitorInstructions.length > 0
            ? data.visitorInstructions
            : DEFAULT_VISITOR_INSTRUCTIONS,
          globalRetentionFreeze: Boolean(data.globalRetentionFreeze),
          globalRetentionFreezeReason: typeof data.globalRetentionFreezeReason === 'string' ? data.globalRetentionFreezeReason : '',
          globalRetentionFreezeUpdatedAt: typeof data.globalRetentionFreezeUpdatedAt === 'string' ? data.globalRetentionFreezeUpdatedAt : null,
          allowEmergencyException: Boolean(data.allowEmergencyException),
          emergencyExceptionPolicyNote: typeof data.emergencyExceptionPolicyNote === 'string' ? data.emergencyExceptionPolicyNote : '',
          emergencyRecordRetentionEnabled: typeof data.emergencyRecordRetentionEnabled === 'boolean' ? data.emergencyRecordRetentionEnabled : true,
          emergencyRecordRetentionDays: String(typeof data.emergencyRecordRetentionDays === 'number' ? data.emergencyRecordRetentionDays : 90),
          defaultExpectedGate: typeof data.defaultExpectedGate === 'string' ? data.defaultExpectedGate : '',
          securityInfo: {
            turnstileSiteKeyConfigured: Boolean(data.security?.turnstileSiteKeyConfigured),
            turnstileVerifierConfigured: Boolean(data.security?.turnstileVerifierConfigured),
            turnstileFullyVerified: Boolean(data.security?.turnstileFullyVerified),
            biometricStorageRetired: data.security?.biometricStorageRetired !== false,
          },
        });
        setRetentionInputs(createRetentionInputValues(retentionPolicy));
        setLoadError(null);
        return { ok: true };
      } else {
        const errorData = await res.json().catch(() => null) as { message?: string; error?: string } | null;
        const errMsg = errorData?.message || errorData?.error || `Failed to load settings (HTTP ${res.status})`;
        if (!isBackground) {
          setLoadError(errMsg);
          toast.error(errMsg);
        }
        return { ok: false, error: errMsg };
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : 'Network failure loading system settings';
      console.error(err);
      if (!isBackground) {
        setLoadError(errMsg);
        toast.error(errMsg);
      }
      return { ok: false, error: errMsg };
    } finally {
      if (!isBackground) {
        setLoading(false);
      }
    }
  }

  useEffect(() => {
    void loadSettings();
  }, []);

  async function handleSave() {
    if (settingsMutationInFlightRef.current || settingsBusy) return;
    settingsMutationInFlightRef.current = true;
    setSaveError(null);
    try {
      const retentionValidation = canManageSecuritySettings
        ? validateRetentionInputs(retentionInputs)
        : null;
      if (retentionValidation && !retentionValidation.success) {
        setRetentionErrors(retentionValidation.errors);
        const msg = 'Correct the highlighted retention settings before saving.';
        setSaveError(msg);
        toast.error(msg);
        return;
      }
      setRetentionErrors({});
      if (settings.workingHours.start >= settings.workingHours.end) {
        const msg = 'Campus opening time must be earlier than closing time.';
        setSaveError(msg);
        toast.error(msg);
        return;
      }
      const missingPrompt = settings.visitPurposes.find((purpose) => purpose.requiresDetails && purpose.detailPrompt.trim().length < 3);
      if (missingPrompt) {
        const msg = `Add an instruction for “${missingPrompt.label}” before saving.`;
        setSaveError(msg);
        toast.error(msg);
        return;
      }
      const parsedEmergencyDays = Number(settings.emergencyRecordRetentionDays || '90');
      if (
        canManageSecuritySettings &&
        (!Number.isInteger(parsedEmergencyDays) || parsedEmergencyDays < 30 || parsedEmergencyDays > 365)
      ) {
        const msg = 'Emergency gate records retention period must be a whole number between 30 and 365 days.';
        setSaveError(msg);
        toast.error(msg);
        return;
      }
      if (
        canManageSecuritySettings &&
        settings.globalRetentionFreeze &&
        settings.globalRetentionFreezeReason.trim().length < 5
      ) {
        const msg = 'Provide a Global Retention Freeze reason of at least 5 characters before saving.';
        setSaveError(msg);
        toast.error(msg);
        return;
      }
      setSaving(true);
      const operationalSettings = {
        peakMode: settings.peakMode,
        rejectionReasons: settings.rejectionReasons,
        visitPurposes: settings.visitPurposes.map((purpose) => ({
          ...purpose,
          detailPrompt: purpose.requiresDetails ? purpose.detailPrompt.trim() : '',
        })),
        visitorInstructions: settings.visitorInstructions.map((i) => i.trim()).filter(Boolean),
      };
      const settingsToSave = canManageSecuritySettings
        ? {
            ...operationalSettings,
            workingHours: settings.workingHours,
            ...retentionValidation?.data,
            automaticCleanupEnabled: settings.automaticCleanupEnabled,
            photoRetentionEnabled: settings.photoRetentionEnabled,
            idRetentionEnabled: settings.idRetentionEnabled,
            vehiclePhotoRetentionEnabled: settings.vehiclePhotoRetentionEnabled,
            visitorRetentionEnabled: settings.visitorRetentionEnabled,
            returningProfileRetentionEnabled: settings.returningProfileRetentionEnabled,
            vehiclePhotoRetentionDays: Number(retentionInputs.vehiclePhotoRetentionDays || 30),
            returningProfileRetentionDays: Number(retentionInputs.returningProfileRetentionDays || 30),
            emergencyRecordRetentionEnabled: settings.emergencyRecordRetentionEnabled,
            emergencyRecordRetentionDays: parsedEmergencyDays,
            globalRetentionFreeze: settings.globalRetentionFreeze,
            globalRetentionFreezeReason: settings.globalRetentionFreeze
              ? settings.globalRetentionFreezeReason.trim()
              : null,
            allowEmergencyException: settings.allowEmergencyException,
            emergencyExceptionPolicyNote: settings.emergencyExceptionPolicyNote.trim() || null,
            defaultExpectedGate: settings.defaultExpectedGate.trim() || null,
            overrideReason: retentionOverrideReason.trim() || undefined,
          }
        : operationalSettings;
      const token = await getAccessToken();
      if (!token) throw new Error('Your session has expired. Please sign in again.');
      const response = await fetch('/api/update-settings', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(settingsToSave),
      });
      const result = await response.json().catch(() => null) as {
        error?: string;
        message?: string;
        details?: Array<{ path?: Array<string | number>; message?: string }>;
      } | null;
      if (!response.ok) {
        const firstIssue = Array.isArray(result?.details) ? result.details[0] : undefined;
        const issueDetail = firstIssue?.message
          ? (firstIssue.path?.length ? `${firstIssue.path.join('.')}: ${firstIssue.message}` : firstIssue.message)
          : null;
        throw new Error(issueDetail || result?.message || result?.error || `Failed to save settings (HTTP ${response.status})`);
      }
      setSaveError(null);
      toast.success('Settings saved successfully');
      setRetentionOverrideReason('');
      const refreshed = await loadSettings({ background: true });
      if (!refreshed.ok && refreshed.error) {
        const refreshMsg = `Settings saved, but reloading latest configuration failed: ${refreshed.error}`;
        setSaveError(refreshMsg);
        toast.warning(refreshMsg);
      }
    } catch (err) {
      console.error(err);
      const errMsg = err instanceof Error && err.message ? err.message : 'Failed to save settings';
      setSaveError(errMsg);
      toast.error(errMsg);
    } finally {
      setSaving(false);
      settingsMutationInFlightRef.current = false;
    }
  }

  function addPurpose() {
    if (settingsBusy) return;
    const purpose = newPurpose.trim();
    if (!purpose) return;
    if (purpose.length < 3) {
      toast.error('Purpose must be at least 3 characters');
      return;
    }
    if (settings.visitPurposes.some((item) => item.label.toLocaleLowerCase() === purpose.toLocaleLowerCase())) {
      toast.error('Purpose already exists');
      return;
    }
    setSettings((previous) => ({
      ...previous,
      visitPurposes: [...previous.visitPurposes, { label: purpose, requiresDetails: false, detailPrompt: '' }],
    }));
    setNewPurpose('');
  }

  function removePurpose(purpose: string) {
    if (settingsBusy) return;
    setSettings((previous) => ({
      ...previous,
      visitPurposes: previous.visitPurposes.filter((item) => item.label !== purpose),
    }));
  }

  function togglePurposeDetails(label: string) {
    if (settingsBusy) return;
    setSettings((previous) => ({
      ...previous,
      visitPurposes: previous.visitPurposes.map((purpose) => purpose.label === label
        ? {
            ...purpose,
            requiresDetails: !purpose.requiresDetails,
            detailPrompt: !purpose.requiresDetails && !purpose.detailPrompt
              ? 'What should the visitor specify?'
              : purpose.detailPrompt,
          }
        : purpose),
    }));
  }

  function updatePurposePrompt(label: string, detailPrompt: string) {
    if (settingsBusy) return;
    setSettings((previous) => ({
      ...previous,
      visitPurposes: previous.visitPurposes.map((purpose) => purpose.label === label
        ? { ...purpose, detailPrompt }
        : purpose),
    }));
  }

  function addInstruction() {
    if (settingsBusy) return;
    const instruction = newInstruction.trim();
    if (!instruction) return;
    if (instruction.length < 3 || instruction.length > 180) {
      toast.error('Instruction must be between 3 and 180 characters');
      return;
    }
    if (settings.visitorInstructions.length >= 8) {
      toast.error('Maximum of 8 instructions allowed');
      return;
    }
    setSettings((prev) => ({
      ...prev,
      visitorInstructions: [...prev.visitorInstructions, instruction],
    }));
    setNewInstruction('');
  }

  function removeInstruction(index: number) {
    if (settingsBusy) return;
    if (settings.visitorInstructions.length <= 1) {
      toast.error('At least one visitor instruction is required');
      return;
    }
    setSettings((prev) => ({
      ...prev,
      visitorInstructions: prev.visitorInstructions.filter((_, i) => i !== index),
    }));
  }

  function updateInstruction(index: number, text: string) {
    if (settingsBusy) return;
    setSettings((prev) => ({
      ...prev,
      visitorInstructions: prev.visitorInstructions.map((item, i) => (i === index ? text : item)),
    }));
  }

  // ============================================================
  // PURGE IMAGES
  // ============================================================
  async function handlePurgeClick() {
    if (settingsMutationInFlightRef.current || settingsBusy) return;
    settingsMutationInFlightRef.current = true;
    setCalculatingPurge(true);
    try {
      const token = await getAccessToken();
      if (!token) throw new Error('Not authenticated');

      let currentCursor: string | null = null;
      let snapshotAt: string | null = null;
      let hasMore = true;
      let totalVisitorsAffected = 0;
      let iterations = 0;
      const MAX_DRY_RUN_BATCHES = 10;
      let photoDays = settings.photoRetentionDays ?? 7;
      let idDays = settings.idRetentionDays ?? 30;

      while (hasMore && iterations < MAX_DRY_RUN_BATCHES) {
        iterations++;
        const payload: { dryRun: boolean; cursor?: string; snapshotAt?: string } = { dryRun: true };
        if (currentCursor) payload.cursor = currentCursor;
        if (snapshotAt) payload.snapshotAt = snapshotAt;

        const res = await fetch('/api/purge-images', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(payload),
        });

        if (!res.ok) {
          throw new Error('Could not check which images are ready for deletion');
        }

        const data = await res.json() as {
          result?: string;
          frozen?: boolean;
          freezeReason?: string | null;
          visitorsAffected: number;
          eligibleEvidenceCount?: number;
          retentionDays?: number;
          photoRetentionDays?: number;
          idRetentionDays?: number;
          hasMore: boolean;
          nextCursor?: string | null;
          snapshotAt?: string;
        };

        if (data.frozen || data.result === 'frozen') {
          toast.warning(`Global Institutional Retention Freeze is active (${data.freezeReason || 'No reason recorded'}). All purges are suspended.`);
          return;
        }

        totalVisitorsAffected += data.visitorsAffected ?? 0;
        photoDays = data.photoRetentionDays ?? photoDays;
        idDays = data.idRetentionDays ?? idDays;
        if (!snapshotAt && data.snapshotAt) {
          snapshotAt = data.snapshotAt;
        }

        hasMore = Boolean(data.hasMore && data.nextCursor);
        currentCursor = data.nextCursor || null;

        if ((data.eligibleEvidenceCount ?? 0) === 0 && !data.nextCursor) {
          break;
        }
      }

      setPurgeEligibleCount(totalVisitorsAffected);
      setPurgePhotoRetentionDays(photoDays);
      setPurgeIdRetentionDays(idDays);
      setShowPurgeConfirm(true);
    } catch (err) {
      console.error('Dry run failed', err);
      toast.error('Could not calculate purge impact');
    } finally {
      setCalculatingPurge(false);
      settingsMutationInFlightRef.current = false;
    }
  }

  async function executeOverridePurge() {
    if (!overrideReason.trim() || overrideReason.trim().length < 10) {
      toast.error('Audit reason of at least 10 characters is required for override.');
      return;
    }
    if (overrideCategories.length === 0) {
      toast.error('Select at least one category to override.');
      return;
    }
    setIsExecutingOverride(true);
    try {
      const token = await getAccessToken();
      if (!token) throw new Error('Not authenticated');

      let currentCursor: string | null = null;
      let snapshotAt: string | null = null;
      let hasMore = true;
      let totalSuccess = 0;
      let totalFailed = 0;
      let batchIterations = 0;
      const MAX_BATCHES = 50; // Guard against unbounded loops (2500 candidates max per user action)

      while (hasMore && batchIterations < MAX_BATCHES) {
        batchIterations++;
        const payload: {
          dryRun: boolean;
          cursor?: string;
          snapshotAt?: string;
          override: { reason: string; categories: string[] };
        } = {
          dryRun: false,
          override: {
            reason: overrideReason.trim(),
            categories: overrideCategories,
          },
        };
        if (currentCursor) payload.cursor = currentCursor;
        if (snapshotAt) payload.snapshotAt = snapshotAt;

        const res = await fetch('/api/purge-images', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(payload),
        });

        if (!res.ok) {
          const text = await res.text();
          throw new Error(`Override purge failed on batch ${batchIterations}: ${res.status} - ${text}`);
        }

        const data = await res.json() as {
          result?: string;
          frozen?: boolean;
          freezeReason?: string | null;
          successCount: number;
          failedCount: number;
          hasMore: boolean;
          nextCursor?: string | null;
          snapshotAt?: string;
        };

        if (data.frozen || data.result === 'frozen') {
          toast.warning(`Override blocked: Global Institutional Retention Freeze is active (${data.freezeReason || 'No reason recorded'}).`);
          setShowOverridePurgeModal(false);
          return;
        }

        totalSuccess += data.successCount;
        totalFailed += data.failedCount;
        if (!snapshotAt && data.snapshotAt) {
          snapshotAt = data.snapshotAt;
        }

        hasMore = Boolean(data.hasMore && data.nextCursor);
        currentCursor = data.nextCursor || null;

        if (data.successCount === 0 && data.failedCount === 0 && !data.nextCursor) {
          break;
        }
      }

      toast.success(hasMore
        ? `Superadmin override purge processed ${totalSuccess} evidence records. More records remain; run another override batch when ready.`
        : `Superadmin override purge completed: ${totalSuccess} evidence records permanently deleted with audit logging.`);
      setShowOverridePurgeModal(false);
      setOverrideReason('');
    } catch (err: any) {
      console.error(err);
      toast.error(err.message || 'Override purge failed');
    } finally {
      setIsExecutingOverride(false);
    }
  }

  async function executePurge() {
    if (settingsMutationInFlightRef.current || settingsBusy) return;
    settingsMutationInFlightRef.current = true;
    setPurging(true);
    try {
      const token = await getAccessToken();
      if (!token) throw new Error('Not authenticated');

      let currentCursor: string | null = null;
      let snapshotAt: string | null = null;
      let hasMore = true;
      let totalSuccess = 0;
      let totalFailed = 0;
      let totalVisitorsAffected = 0;
      let batchIterations = 0;
      const MAX_BATCHES = 50; // Guard against unbounded loops (50 * 50 = 2500 candidates max per user action)

      while (hasMore && batchIterations < MAX_BATCHES) {
        batchIterations++;
        const payload: { dryRun: boolean; cursor?: string; snapshotAt?: string } = { dryRun: false };
        if (currentCursor) payload.cursor = currentCursor;
        if (snapshotAt) payload.snapshotAt = snapshotAt;

        const res = await fetch('/api/purge-images', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(payload),
        });

        if (!res.ok) {
          const text = await res.text();
          throw new Error(`Purge failed on batch ${batchIterations}: ${res.status} - ${text}`);
        }

        const data = await res.json() as {
          result?: string;
          frozen?: boolean;
          freezeReason?: string | null;
          successCount: number;
          failedCount: number;
          visitorsAffected?: number;
          orphanDeletedCount?: number;
          orphanFailedCount?: number;
          hasMore: boolean;
          nextCursor?: string | null;
          snapshotAt?: string;
        };

        if (data.frozen || data.result === 'frozen') {
          toast.warning(`Purge aborted: Global Institutional Retention Freeze is active (${data.freezeReason || 'No reason recorded'}).`);
          setShowPurgeConfirm(false);
          return;
        }

        totalSuccess += data.successCount;
        totalFailed += data.failedCount + (data.orphanFailedCount || 0);
        totalVisitorsAffected += data.visitorsAffected || 0;
        if (!snapshotAt && data.snapshotAt) {
          snapshotAt = data.snapshotAt;
        }

        hasMore = Boolean(data.hasMore && data.nextCursor);
        currentCursor = data.nextCursor || null;

        if (data.successCount === 0 && data.failedCount === 0 && !data.nextCursor) {
          break;
        }
      }

      if (totalFailed > 0) {
        throw new Error(
          `Images were deleted for ${totalSuccess} records (${totalVisitorsAffected} visitor${totalVisitorsAffected === 1 ? '' : 's'}), but ${totalFailed} could not be completed. The failed records were not marked as deleted. Please try again.`
        );
      }

      toast.success(hasMore
        ? `Images deleted for ${totalSuccess} records (${totalVisitorsAffected} visitors). More eligible records remain; run another confirmed batch when ready.`
        : `Images deleted for ${totalSuccess} records (${totalVisitorsAffected} visitor${totalVisitorsAffected === 1 ? '' : 's'}). All eligible evidence purged.`);
      setShowPurgeConfirm(false);
    } catch (err: any) {
      console.error(err);
      toast.error(err.message || 'Purge failed');
    } finally {
      setPurging(false);
      settingsMutationInFlightRef.current = false;
    }
  }

  function handleRetentionDaysChange(field: RetentionInputField, value: string) {
    setRetentionInputs((current) => ({ ...current, [field]: value }));
    if (retentionErrors[field]) {
      setRetentionErrors((current) => ({
        ...current,
        [field]: getRetentionInputError(field, value),
      }));
    }
  }

  if (loading) {
    return <LoadingState label="Loading system settings" className="h-32" />;
  }

  if (loadError) {
    return (
      <div className="mx-auto max-w-6xl space-y-6">
        <div>
          <h1 className="text-2xl font-bold text-[var(--color-text-primary)]">System Settings</h1>
          <p className="text-sm text-[var(--color-text-secondary)]">Configure policies, campus calendar, and data retention</p>
        </div>
        <Card className="p-8 text-center border-[var(--color-danger)]">
          <AlertTriangle className="mx-auto h-12 w-12 text-[var(--color-danger)] mb-4" />
          <h2 className="text-lg font-bold text-[var(--color-text-primary)] mb-2">Unable to Load System Settings</h2>
          <p className="text-sm text-[var(--color-text-secondary)] max-w-md mx-auto mb-6">
            Authoritative system settings could not be retrieved from the server ({loadError}). Editable defaults have been locked to prevent accidental overwrite of production configuration.
          </p>
          <Button onClick={() => void loadSettings()}>
            Retry Loading Settings
          </Button>
        </Card>
      </div>
    );
  }

  const showSaveButton = ['general', 'visitor_ux', 'security', 'retention'].includes(currentTab);

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-[var(--color-text-primary)]">
            System Settings
          </h1>
          <p className="text-sm text-[var(--color-text-secondary)]">
            Configure campus policies, access hours, visitor experience, and privacy retention
          </p>
        </div>
        {showSaveButton && (
          <Button
            onClick={handleSave}
            disabled={settingsBusy}
            loading={saving}
            icon={<Save className="h-4 w-4" />}
          >
            {saving ? 'Saving...' : 'Save Settings'}
          </Button>
        )}
      </div>

      {saveError && (
        <div role="alert" className="flex items-start gap-2.5 rounded-lg border border-[var(--color-danger-border)] bg-[var(--color-danger-light)] px-4 py-3 text-xs text-[var(--color-danger-dark)]">
          <AlertTriangle className="h-4 w-4 mt-0.5 flex-shrink-0 text-[var(--color-danger)]" />
          <span className="font-medium">{saveError}</span>
        </div>
      )}

      {/* ===================== TAB: GENERAL SYSTEM ===================== */}
      {currentTab === 'general' && (
        <div className="space-y-6">
          <Card className="p-6">
            <h2 className="text-xl font-bold text-[var(--color-text-primary)]">Campus Access Hours</h2>
            <p className="mb-5 mt-2 text-sm leading-relaxed text-[var(--color-text-secondary)]">
              Gate passes use these operating hours for the selected visit date in Asia/Manila. Only a Super Admin can change this global policy.
            </p>
            <div className="grid gap-4 sm:grid-cols-2 max-w-xl">
              <div>
                <label htmlFor="working-hours-start" className="mb-2 block text-sm font-medium text-[var(--color-text-primary)]">Opens</label>
                <Input
                  id="working-hours-start"
                  type="time"
                  value={settings.workingHours.start}
                  disabled={!canManageSecuritySettings || settingsBusy}
                  onChange={(event) => setSettings((current) => ({
                    ...current,
                    workingHours: { ...current.workingHours, start: event.target.value },
                  }))}
                />
              </div>
              <div>
                <label htmlFor="working-hours-end" className="mb-2 block text-sm font-medium text-[var(--color-text-primary)]">Closes</label>
                <Input
                  id="working-hours-end"
                  type="time"
                  value={settings.workingHours.end}
                  disabled={!canManageSecuritySettings || settingsBusy}
                  onChange={(event) => setSettings((current) => ({
                    ...current,
                    workingHours: { ...current.workingHours, end: event.target.value },
                  }))}
                />
              </div>
            </div>
            <p className="mt-4 text-xs font-semibold text-[var(--color-text-muted)]">Timezone: Asia/Manila (UTC+08:00)</p>
          </Card>

          <Card className="p-6">
            <h2 className="text-xl font-bold text-[var(--color-text-primary)]">Default Expected Gate</h2>
            <p className="mb-4 mt-2 text-sm leading-relaxed text-[var(--color-text-secondary)]">
              Default expected gate assigned automatically to visitor passes and office visits unless manually updated by Admin/Guard oversight. Managed by Super Admin.
            </p>
            <div className="max-w-sm">
              <FormField label="Default Expected Gate" id="default-expected-gate">
                <Input
                  id="default-expected-gate"
                  value={settings.defaultExpectedGate}
                  maxLength={80}
                  placeholder="Main Gate"
                  disabled={!canManageSecuritySettings || settingsBusy}
                  onChange={(e) => setSettings((s) => ({ ...s, defaultExpectedGate: e.target.value }))}
                />
              </FormField>
            </div>
          </Card>

          {/* Peak Mode */}
          <Card className="p-6">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <h2 className="text-xl font-bold text-[var(--color-text-primary)]">Peak Mode</h2>
                  {settings.peakMode !== 'off' && (
                    <span className="inline-flex rounded-full border border-[var(--color-warning)] bg-[var(--color-warning-light)] px-2.5 py-0.5 text-xs font-bold text-[var(--color-warning-dark)]">
                      Active
                    </span>
                  )}
                </div>
                <p className="mt-2 text-sm leading-relaxed text-[var(--color-text-secondary)]">
                  When enabled, visitors are not required to upload a government ID, helping expedite campus entry during rush hours. Face portrait capture is always required.
                </p>
                {settings.peakMode !== 'off' && (
                  <p className="mt-2 text-xs font-semibold text-[var(--color-brand)]">
                    Currently skipping ID requirement on: {
                      settings.peakMode === 'both' ? 'Both Online Portal & Kiosk'
                      : settings.peakMode === 'portal' ? 'Online Portal only'
                      : 'Kiosk only'
                    }
                  </p>
                )}
              </div>
              <div className="w-full sm:w-60">
                <label className="mb-1 block text-xs font-semibold text-[var(--color-text-secondary)]">
                  Scope
                </label>
                <Select
                  value={settings.peakMode}
                  disabled={!canManageSecuritySettings || settingsBusy}
                  onChange={(e) => {
                    if (!canManageSecuritySettings || settingsBusy) return;
                    const newScope = e.target.value as PeakModeScope;
                    if (newScope !== 'off' && settings.peakMode === 'off') {
                      setPendingPeakMode(newScope);
                      setShowPeakModeConfirm(true);
                    } else {
                      setSettings((s) => ({ ...s, peakMode: newScope }));
                    }
                  }}
                  aria-label="Peak Mode Scope"
                >
                  <option value="off">Off (IDs Required)</option>
                  <option value="portal">Online Portal Only</option>
                  <option value="kiosk">Kiosk Devices Only</option>
                  <option value="both">Both (Portal & Kiosk)</option>
                </Select>
                {!canManageSecuritySettings && (
                  <p className="mt-1 text-xs text-[var(--color-text-muted)]">
                    Controlled by Super Admin.
                  </p>
                )}
              </div>
            </div>
          </Card>
        </div>
      )}

      {/* ===================== TAB: CAMPUS CALENDAR ===================== */}
      {currentTab === 'calendar' && (
        <CampusCalendar canEdit={canManageSecuritySettings} />
      )}

      {/* ===================== TAB: VISITOR EXPERIENCE ===================== */}
      {currentTab === 'visitor_ux' && (
        <div className="grid gap-6 lg:grid-cols-2">
          {canManageSecuritySettings && (
            <Card className="p-6">
              <h2 className="text-xl font-bold text-[var(--color-text-primary)]">Premade Visit Purposes</h2>
              <p className="mb-5 mt-2 text-sm text-[var(--color-text-secondary)]">
                Visitors can select these common options during registration. They can also choose Other to specify an unlisted purpose.
              </p>

              <ul className="divide-y overflow-hidden rounded-lg border border-[var(--color-border)]">
                {settings.visitPurposes.map((purpose, index) => (
                  <li key={purpose.label} className="p-4 transition-colors hover:bg-[var(--color-canvas)]">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <span className="text-sm font-medium text-[var(--color-text-primary)]">{purpose.label}</span>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => togglePurposeDetails(purpose.label)}
                          disabled={settingsBusy}
                          aria-pressed={purpose.requiresDetails}
                          className={`rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-brand)] ${
                            purpose.requiresDetails
                              ? 'border-[var(--color-brand)] bg-[var(--color-brand-light)] text-[var(--color-brand)]'
                              : 'border-[var(--color-border)] bg-white text-[var(--color-text-secondary)] hover:bg-[var(--color-canvas)]'
                          } ${settingsBusy ? 'opacity-50 cursor-not-allowed' : ''}`}
                        >
                          {purpose.requiresDetails ? 'Details required' : 'Require details'}
                        </button>
                        <button
                          type="button"
                          onClick={() => removePurpose(purpose.label)}
                          disabled={settingsBusy}
                          className={`rounded-md p-1.5 text-[var(--color-danger)] transition-colors hover:bg-[var(--color-danger-light)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-brand)] ${settingsBusy ? 'opacity-50 cursor-not-allowed' : ''}`}
                          aria-label={`Remove ${purpose.label}`}
                        >
                          <Trash2 className="h-4 w-4" aria-hidden="true" />
                        </button>
                      </div>
                    </div>
                    {purpose.requiresDetails && (
                      <div className="mt-3">
                        <label htmlFor={`purpose-prompt-${index}`} className="mb-1.5 block text-xs font-semibold text-[var(--color-text-secondary)]">
                          What should the visitor specify?
                        </label>
                        <Input
                          id={`purpose-prompt-${index}`}
                          value={purpose.detailPrompt}
                          disabled={settingsBusy}
                          onChange={(event) => updatePurposePrompt(purpose.label, event.target.value)}
                          maxLength={160}
                          placeholder="e.g. Who is your appointment with?"
                        />
                      </div>
                    )}
                  </li>
                ))}
                {settings.visitPurposes.length === 0 && (
                  <li className="p-6 text-center text-sm text-[var(--color-text-muted)]">No visit purposes configured</li>
                )}

                <li className="flex gap-3 border-t border-[var(--color-border)] bg-[var(--color-canvas)] p-4">
                  <div className="flex-1">
                    <Input
                      type="text"
                      value={newPurpose}
                      disabled={settingsBusy}
                      onChange={(event) => setNewPurpose(event.target.value)}
                      placeholder="Add visit purpose..."
                      maxLength={100}
                      aria-label="New visit purpose"
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          event.preventDefault();
                          addPurpose();
                        }
                      }}
                    />
                  </div>
                  <Button onClick={addPurpose} disabled={settingsBusy} variant="secondary" icon={<Plus className="h-4 w-4" />}>
                    Add
                  </Button>
                </li>
              </ul>
            </Card>
          )}

          {/* Visitor Instructions */}
          <Card className="overflow-hidden">
            <div className="border-b border-[var(--color-border)] p-6">
              <h2 className="text-xl font-bold text-[var(--color-text-primary)]">Visitor Instructions</h2>
              <p className="mt-1 text-sm text-[var(--color-text-secondary)]">
                These guidelines are shown to visitors after pass registration and included in digital E-GatePass delivery.
              </p>
            </div>

            <ul className="divide-y divide-[var(--color-border)]">
              {settings.visitorInstructions.map((instruction, index) => (
                <li key={index} className="flex items-center gap-3 p-4">
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[var(--color-brand-light)] text-xs font-bold text-[var(--color-brand)]">
                    {index + 1}
                  </span>
                  <div className="flex-1">
                    <Input
                      type="text"
                      value={instruction}
                      disabled={settingsBusy}
                      onChange={(e) => updateInstruction(index, e.target.value)}
                      maxLength={180}
                      aria-label={`Visitor instruction ${index + 1}`}
                    />
                  </div>
                  <button
                    type="button"
                    onClick={() => removeInstruction(index)}
                    disabled={settingsBusy || settings.visitorInstructions.length <= 1}
                    className="rounded p-2 text-[var(--color-text-muted)] hover:bg-[var(--color-danger-light)] hover:text-[var(--color-danger)] disabled:opacity-30 disabled:cursor-not-allowed"
                    aria-label={`Remove instruction ${index + 1}`}
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </li>
              ))}

              {settings.visitorInstructions.length < 8 && (
                <li className="flex gap-3 border-t border-[var(--color-border)] bg-[var(--color-canvas)] p-4">
                  <div className="flex-1">
                    <Input
                      type="text"
                      value={newInstruction}
                      disabled={settingsBusy}
                      onChange={(e) => setNewInstruction(e.target.value)}
                      placeholder="Add new visitor instruction..."
                      maxLength={180}
                      aria-label="New visitor instruction"
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          addInstruction();
                        }
                      }}
                    />
                  </div>
                  <Button
                    onClick={addInstruction}
                    disabled={settingsBusy || !newInstruction.trim()}
                    variant="secondary"
                    icon={<Plus className="h-4 w-4" />}
                  >
                    Add
                  </Button>
                </li>
              )}
            </ul>
          </Card>
        </div>
      )}

      {/* ===================== TAB: SECURITY & PRIVACY ===================== */}
      {currentTab === 'security' && (
        <div className="space-y-6">
          <Card className="p-6">
            <div className="flex items-center gap-3 border-b border-[var(--color-border)] pb-4 mb-6">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-[#7A0A0A]/10 text-[#7A0A0A]">
                <Shield className="h-5 w-5" />
              </div>
              <div>
                <h2 className="text-xl font-bold text-[var(--color-text-primary)]">System Security Policies & Safeguards</h2>
                <p className="text-xs text-[var(--color-text-secondary)] mt-0.5">
                  Authoritative runtime security state, human session controls, and emergency device boundaries.
                </p>
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <div className="p-4 rounded-xl border border-[var(--color-border)] bg-[var(--color-canvas)] space-y-2">
                <div className="flex items-center gap-2 text-[#7A0A0A] font-bold text-sm">
                  <Clock className="h-4 w-4" />
                  <span>Human Inactivity Timeout</span>
                </div>
                <p className="text-xs text-[var(--color-text-secondary)] leading-relaxed">
                  15-minute inactivity session expiration with 60-second warning modal and cross-tab sync enforced for human staff sessions (Admin, Superadmin, Office Staff). Managed gate/kiosk/emergency devices are strictly exempt.
                </p>
                <div className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded">
                  <CheckCircle className="h-3.5 w-3.5" /> Enforced for Staff (15m)
                </div>
              </div>

              <div className="p-4 rounded-xl border border-[var(--color-border)] bg-[var(--color-canvas)] space-y-2">
                <div className="flex items-center gap-2 text-[#7A0A0A] font-bold text-sm">
                  <Shield className="h-4 w-4" />
                  <span>Cloudflare Turnstile Bot Defense</span>
                </div>
                <p className="text-xs text-[var(--color-text-secondary)] leading-relaxed">
                  Bot verification fails closed (HTTP 503) when site or server verifier configuration is incomplete instead of silently bypassing verification. Site key: {settings.securityInfo.turnstileSiteKeyConfigured ? 'Configured' : 'Missing'} · Server verifier: {settings.securityInfo.turnstileVerifierConfigured ? 'Configured' : 'Missing'}.
                </p>
                {settings.securityInfo.turnstileFullyVerified ? (
                  <div className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded">
                    <CheckCircle className="h-3.5 w-3.5" /> Configured &amp; Enforced
                  </div>
                ) : (
                  <div className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-amber-800 bg-amber-50 px-2 py-0.5 rounded border border-amber-200">
                    <AlertTriangle className="h-3.5 w-3.5" /> Fail-Closed (Keys Incomplete)
                  </div>
                )}
              </div>

              <div className="p-4 rounded-xl border border-[var(--color-border)] bg-[var(--color-canvas)] space-y-2">
                <div className="flex items-center gap-2 text-[#7A0A0A] font-bold text-sm">
                  <Camera className="h-4 w-4" />
                  <span>Returning Identity Verification</span>
                </div>
                <p className="text-xs text-[var(--color-text-secondary)] leading-relaxed">
                  Provisional verification mode with legacy raw biometric template storage retired. Encrypted lookup tokens assist staff workflows; visual gate ID inspection remains mandatory.
                </p>
                <div className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-blue-700 bg-blue-50 px-2 py-0.5 rounded">
                  <CheckCircle className="h-3.5 w-3.5" /> {settings.securityInfo.biometricStorageRetired ? 'Raw Templates Retired' : 'Provisional Mode'}
                </div>
              </div>

              <div className="p-4 rounded-xl border border-[var(--color-border)] bg-[var(--color-canvas)] space-y-2">
                <div className="flex items-center gap-2 text-[#7A0A0A] font-bold text-sm">
                  <KeyRound className="h-4 w-4" />
                  <span>Pass &amp; Manifest Cryptography</span>
                </div>
                <p className="text-xs text-[var(--color-text-secondary)] leading-relaxed">
                  Gate passes are Ed25519 sealed; Emergency Device 24-hour gate manifests are ECDSA P-256 SHA-256 signed and encrypted at rest in AES-256-GCM IndexedDB vaults.
                </p>
                <div className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded">
                  <CheckCircle className="h-3.5 w-3.5" /> Ed25519 + ECDSA P-256
                </div>
              </div>

              <div className="p-4 rounded-xl border border-[var(--color-border)] bg-[var(--color-canvas)] space-y-2">
                <div className="flex items-center gap-2 text-[#7A0A0A] font-bold text-sm">
                  <Lock className="h-4 w-4" />
                  <span>Anti-Abuse &amp; Rate Limiting</span>
                </div>
                <p className="text-xs text-[var(--color-text-secondary)] leading-relaxed">
                  Multi-tier rate limiting on email delivery, pass issuance, and returning visitor lookups prevents API abuse and automated enumeration.
                </p>
                <div className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded">
                  <CheckCircle className="h-3.5 w-3.5" /> Active Limits
                </div>
              </div>

              <div className="p-4 rounded-xl border border-[var(--color-border)] bg-[var(--color-canvas)] space-y-2">
                <div className="flex items-center gap-2 text-[#7A0A0A] font-bold text-sm">
                  <FileText className="h-4 w-4" />
                  <span>Immutable Audit Trail</span>
                </div>
                <p className="text-xs text-[var(--color-text-secondary)] leading-relaxed">
                  All security updates, office lifecycle actions, retention freezes, and emergency reconciliations are permanently written to append-only audit logs.
                </p>
                <div className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded">
                  <CheckCircle className="h-3.5 w-3.5" /> Audit Logging On
                </div>
              </div>
            </div>
          </Card>

          <Card className="p-6 space-y-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <h3 className="text-lg font-bold text-[var(--color-text-primary)]">Emergency Offline Device Exception Policy</h3>
                <p className="mt-1 text-xs text-[var(--color-text-secondary)]">
                  Defaults to OFF. Only Super Admin may enable policy-gated emergency exceptions on signed Emergency Device gate manifests.
                </p>
              </div>
              <label className="flex items-center gap-2.5 rounded-xl border border-[var(--color-border)] bg-[var(--color-canvas)] px-3 py-2 text-xs font-bold">
                <input
                  type="checkbox"
                  checked={settings.allowEmergencyException}
                  disabled={!canManageSecuritySettings || settingsBusy}
                  onChange={(e) => setSettings((s) => ({ ...s, allowEmergencyException: e.target.checked }))}
                  className="h-4 w-4 rounded text-[#7A0A0A]"
                />
                <span>{settings.allowEmergencyException ? 'Exceptions Allowed (Policy On)' : 'Exceptions Disabled (Default OFF)'}</span>
              </label>
            </div>
            <FormField label="Emergency Exception Policy Note" id="emergency-exception-note">
              <Input
                id="emergency-exception-note"
                value={settings.emergencyExceptionPolicyNote}
                maxLength={300}
                disabled={!canManageSecuritySettings || settingsBusy}
                placeholder="Instructions displayed on Emergency Device consoles when exceptions are enabled"
                onChange={(e) => setSettings((s) => ({ ...s, emergencyExceptionPolicyNote: e.target.value }))}
              />
            </FormField>
          </Card>
        </div>
      )}

      {/* ===================== TAB: DATA RETENTION ===================== */}
      {currentTab === 'retention' && (
        <div className="space-y-6">
          <Card className="p-6">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 border-b border-[var(--color-border)] pb-4 mb-6">
              <div>
                <h2 className="text-xl font-bold text-[var(--color-text-primary)]">Granular Data Retention Policies</h2>
                <p className="text-xs text-[var(--color-text-secondary)] mt-1">
                  Super Admin controls for lifecycle deletion across distinct data categories. Scheduled cleanup purges expired evidence while strictly safeguarding active visits and incident holds.
                </p>
              </div>
              <label className="flex items-center gap-3 text-xs font-bold text-[var(--color-text-primary)] bg-[var(--color-canvas)] p-3 rounded-xl border border-[var(--color-border)]">
                <input
                  type="checkbox"
                  checked={settings.automaticCleanupEnabled}
                  disabled={!canManageSecuritySettings || settingsBusy}
                  onChange={(event) => setSettings((current) => ({ ...current, automaticCleanupEnabled: event.target.checked }))}
                  className="rounded text-[#7A0A0A] focus:ring-[#7A0A0A] h-4 w-4"
                />
                Enable Daily Automated Cleanup
              </label>
            </div>

            {/* Global Institutional Retention Freeze */}
            <div className={`mb-6 rounded-xl border p-4 space-y-3 ${settings.globalRetentionFreeze ? 'border-rose-400 bg-rose-50' : 'border-[var(--color-border)] bg-[var(--color-canvas)]'}`}>
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <div className="flex items-center gap-2">
                    <ShieldAlert className={`h-4 w-4 ${settings.globalRetentionFreeze ? 'text-rose-700' : 'text-[#7A0A0A]'}`} />
                    <span className="text-sm font-bold text-[var(--color-text-primary)]">
                      Global Institutional Retention Freeze
                    </span>
                    {settings.globalRetentionFreeze && (
                      <span className="rounded bg-rose-700 px-2 py-0.5 text-[10px] font-bold uppercase text-white">
                        Freeze Active
                      </span>
                    )}
                  </div>
                  <p className="mt-1 text-xs text-[var(--color-text-secondary)]">
                    When enabled, both automated CRON maintenance and manual purges are immediately halted across all categories until lifted by Super Admin.
                  </p>
                </div>
                <label className="flex items-center gap-2 cursor-pointer text-xs font-bold shrink-0">
                  <input
                    type="checkbox"
                    checked={settings.globalRetentionFreeze}
                    disabled={!canManageSecuritySettings || settingsBusy}
                    onChange={(e) => setSettings((s) => ({ ...s, globalRetentionFreeze: e.target.checked }))}
                    className="h-4 w-4 rounded text-rose-700"
                  />
                  <span>{settings.globalRetentionFreeze ? 'Unfreeze on Save' : 'Enable Global Freeze'}</span>
                </label>
              </div>
              <FormField
                label="Institutional Freeze Authorization Reason"
                requirement={settings.globalRetentionFreeze ? 'required' : 'optional'}
                id="global-retention-freeze-reason"
              >
                <Input
                  id="global-retention-freeze-reason"
                  value={settings.globalRetentionFreezeReason}
                  maxLength={300}
                  disabled={!canManageSecuritySettings || settingsBusy}
                  placeholder="e.g., Ongoing incident audit / legal preservation directive (min 5 chars when enabled)"
                  onChange={(e) => setSettings((s) => ({ ...s, globalRetentionFreezeReason: e.target.value }))}
                />
              </FormField>
            </div>

            {/* Granular Categories Grid */}
            <div className="space-y-4">
              <h3 className="text-sm font-bold text-[var(--color-text-primary)] uppercase tracking-wider">
                Category Retention Controls
              </h3>

              <div className="grid gap-4 sm:grid-cols-2">
                {/* 1. Visitor Face Photos */}
                <div className="p-4 rounded-xl border border-[var(--color-border)] bg-[var(--color-canvas)] space-y-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Camera className="h-4 w-4 text-[#7A0A0A]" />
                      <span className="text-sm font-bold text-[var(--color-text-primary)]">Visitor Face Photos</span>
                    </div>
                    <label className="flex items-center gap-2 cursor-pointer text-xs font-semibold">
                      <input
                        type="checkbox"
                        checked={settings.photoRetentionEnabled}
                        disabled={!canManageSecuritySettings || settingsBusy}
                        onChange={(e) => setSettings((s) => ({ ...s, photoRetentionEnabled: e.target.checked }))}
                        className="rounded text-[#7A0A0A] h-4 w-4"
                      />
                      <span>{settings.photoRetentionEnabled ? 'Purge Active' : 'Retain Indefinitely'}</span>
                    </label>
                  </div>
                  <p className="text-xs text-[var(--color-text-secondary)]">
                    Registration portraits and kiosk live selfie photos used for visual identity verification.
                  </p>
                  <div>
                    <label className="block text-xs font-semibold text-[var(--color-text-secondary)] mb-1">
                      Retention Period (1 to 90 days)
                    </label>
                    <Input
                      type="number"
                      min={1}
                      max={90}
                      value={retentionInputs.photoRetentionDays || ''}
                      disabled={!canManageSecuritySettings || !settings.photoRetentionEnabled || settingsBusy}
                      error={Boolean(retentionErrors.photoRetentionDays)}
                      onChange={(e) => handleRetentionDaysChange('photoRetentionDays', e.target.value)}
                    />
                    {retentionErrors.photoRetentionDays && (
                      <p className="mt-1 text-xs text-[var(--color-danger)]">{retentionErrors.photoRetentionDays}</p>
                    )}
                  </div>
                </div>

                {/* 2. Valid ID Images */}
                <div className="p-4 rounded-xl border border-[var(--color-border)] bg-[var(--color-canvas)] space-y-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <FileText className="h-4 w-4 text-[#7A0A0A]" />
                      <span className="text-sm font-bold text-[var(--color-text-primary)]">Valid ID Images</span>
                    </div>
                    <label className="flex items-center gap-2 cursor-pointer text-xs font-semibold">
                      <input
                        type="checkbox"
                        checked={settings.idRetentionEnabled}
                        disabled={!canManageSecuritySettings || settingsBusy}
                        onChange={(e) => setSettings((s) => ({ ...s, idRetentionEnabled: e.target.checked }))}
                        className="rounded text-[#7A0A0A] h-4 w-4"
                      />
                      <span>{settings.idRetentionEnabled ? 'Purge Active' : 'Retain Indefinitely'}</span>
                    </label>
                  </div>
                  <p className="text-xs text-[var(--color-text-secondary)]">
                    Government-issued and institutional identification cards uploaded during registration.
                  </p>
                  <div>
                    <label className="block text-xs font-semibold text-[var(--color-text-secondary)] mb-1">
                      Retention Period (1 to 90 days)
                    </label>
                    <Input
                      type="number"
                      min={1}
                      max={90}
                      value={retentionInputs.idRetentionDays || ''}
                      disabled={!canManageSecuritySettings || !settings.idRetentionEnabled || settingsBusy}
                      error={Boolean(retentionErrors.idRetentionDays)}
                      onChange={(e) => handleRetentionDaysChange('idRetentionDays', e.target.value)}
                    />
                    {retentionErrors.idRetentionDays && (
                      <p className="mt-1 text-xs text-[var(--color-danger)]">{retentionErrors.idRetentionDays}</p>
                    )}
                  </div>
                </div>

                {/* 3. Vehicle Photos */}
                <div className="p-4 rounded-xl border border-[var(--color-border)] bg-[var(--color-canvas)] space-y-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Car className="h-4 w-4 text-[#7A0A0A]" />
                      <span className="text-sm font-bold text-[var(--color-text-primary)]">Vehicle Photos</span>
                    </div>
                    <label className="flex items-center gap-2 cursor-pointer text-xs font-semibold">
                      <input
                        type="checkbox"
                        checked={settings.vehiclePhotoRetentionEnabled}
                        disabled={!canManageSecuritySettings || settingsBusy}
                        onChange={(e) => setSettings((s) => ({ ...s, vehiclePhotoRetentionEnabled: e.target.checked }))}
                        className="rounded text-[#7A0A0A] h-4 w-4"
                      />
                      <span>{settings.vehiclePhotoRetentionEnabled ? 'Purge Active' : 'Retain Indefinitely'}</span>
                    </label>
                  </div>
                  <p className="text-xs text-[var(--color-text-secondary)]">
                    License plate snapshots and parking entrance documentation photos.
                  </p>
                  <div>
                    <label className="block text-xs font-semibold text-[var(--color-text-secondary)] mb-1">
                      Retention Period (1 to 90 days)
                    </label>
                    <Input
                      type="number"
                      min={1}
                      max={90}
                      value={retentionInputs.vehiclePhotoRetentionDays || ''}
                      disabled={!canManageSecuritySettings || !settings.vehiclePhotoRetentionEnabled || settingsBusy}
                      error={Boolean(retentionErrors.vehiclePhotoRetentionDays)}
                      onChange={(e) => handleRetentionDaysChange('vehiclePhotoRetentionDays', e.target.value)}
                    />
                    {retentionErrors.vehiclePhotoRetentionDays && (
                      <p className="mt-1 text-xs text-[var(--color-danger)]">{retentionErrors.vehiclePhotoRetentionDays}</p>
                    )}
                  </div>
                </div>

                {/* 4. Visitor Personal Records (PII) */}
                <div className="p-4 rounded-xl border border-[var(--color-border)] bg-[var(--color-canvas)] space-y-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Users className="h-4 w-4 text-[#7A0A0A]" />
                      <span className="text-sm font-bold text-[var(--color-text-primary)]">Visitor Records & PII</span>
                    </div>
                    <label className="flex items-center gap-2 cursor-pointer text-xs font-semibold">
                      <input
                        type="checkbox"
                        checked={settings.visitorRetentionEnabled}
                        disabled={!canManageSecuritySettings || settingsBusy}
                        onChange={(e) => setSettings((s) => ({ ...s, visitorRetentionEnabled: e.target.checked }))}
                        className="rounded text-[#7A0A0A] h-4 w-4"
                      />
                      <span>{settings.visitorRetentionEnabled ? 'Purge Active' : 'Retain Indefinitely'}</span>
                    </label>
                  </div>
                  <p className="text-xs text-[var(--color-text-secondary)]">
                    Visitor names, contact numbers, and addresses. Anonymized to retain aggregate visit counts.
                  </p>
                  <div>
                    <label className="block text-xs font-semibold text-[var(--color-text-secondary)] mb-1">
                      Retention Period (7 to 365 days)
                    </label>
                    <Input
                      type="number"
                      min={7}
                      max={365}
                      value={retentionInputs.visitorRetentionDays || ''}
                      disabled={!canManageSecuritySettings || !settings.visitorRetentionEnabled || settingsBusy}
                      error={Boolean(retentionErrors.visitorRetentionDays)}
                      onChange={(e) => handleRetentionDaysChange('visitorRetentionDays', e.target.value)}
                    />
                    {retentionErrors.visitorRetentionDays && (
                      <p className="mt-1 text-xs text-[var(--color-danger)]">{retentionErrors.visitorRetentionDays}</p>
                    )}
                  </div>
                </div>

                {/* 5. Returning Visitor Profiles */}
                <div className="p-4 rounded-xl border border-[var(--color-border)] bg-[var(--color-canvas)] space-y-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Shield className="h-4 w-4 text-[#7A0A0A]" />
                      <span className="text-sm font-bold text-[var(--color-text-primary)]">Returning Visitor Profiles</span>
                    </div>
                    <label className="flex items-center gap-2 cursor-pointer text-xs font-semibold">
                      <input
                        type="checkbox"
                        checked={settings.returningProfileRetentionEnabled}
                        disabled={!canManageSecuritySettings || settingsBusy}
                        onChange={(e) => setSettings((s) => ({ ...s, returningProfileRetentionEnabled: e.target.checked }))}
                        className="rounded text-[#7A0A0A] h-4 w-4"
                      />
                      <span>{settings.returningProfileRetentionEnabled ? 'Purge Active' : 'Retain Indefinitely'}</span>
                    </label>
                  </div>
                  <p className="text-xs text-[var(--color-text-secondary)]">
                    Encrypted phone lookup tokens and sanitized metadata for returning visitors (legacy raw facial templates retired).
                  </p>
                  <div>
                    <label className="block text-xs font-semibold text-[var(--color-text-secondary)] mb-1">
                      Retention Period (7 to 365 days)
                    </label>
                    <Input
                      type="number"
                      min={7}
                      max={365}
                      value={retentionInputs.returningProfileRetentionDays || ''}
                      disabled={!canManageSecuritySettings || !settings.returningProfileRetentionEnabled || settingsBusy}
                      error={Boolean(retentionErrors.returningProfileRetentionDays)}
                      onChange={(e) => handleRetentionDaysChange('returningProfileRetentionDays', e.target.value)}
                    />
                    {retentionErrors.returningProfileRetentionDays && (
                      <p className="mt-1 text-xs text-[var(--color-danger)]">{retentionErrors.returningProfileRetentionDays}</p>
                    )}
                  </div>
                </div>

                {/* 6. System Audit Logs */}
                <div className="p-4 rounded-xl border border-[var(--color-border)] bg-[var(--color-canvas)] space-y-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Database className="h-4 w-4 text-[#7A0A0A]" />
                      <span className="text-sm font-bold text-[var(--color-text-primary)]">System Audit Trail</span>
                    </div>
                    <span className="inline-flex items-center gap-1 text-[11px] font-bold text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded">
                      <Lock className="h-3 w-3" /> Mandatory
                    </span>
                  </div>
                  <p className="text-xs text-[var(--color-text-secondary)]">
                    Immutable logs of administrative changes, security policy updates, and staff access events.
                  </p>
                  <div>
                    <label className="block text-xs font-semibold text-[var(--color-text-secondary)] mb-1">
                      Retention Period (90 to 1095 days)
                    </label>
                    <Input
                      type="number"
                      min={90}
                      max={1095}
                      value={retentionInputs.auditRetentionDays || ''}
                      disabled={!canManageSecuritySettings || settingsBusy}
                      error={Boolean(retentionErrors.auditRetentionDays)}
                      onChange={(e) => handleRetentionDaysChange('auditRetentionDays', e.target.value)}
                    />
                    {retentionErrors.auditRetentionDays && (
                      <p className="mt-1 text-xs text-[var(--color-danger)]">{retentionErrors.auditRetentionDays}</p>
                    )}
                  </div>
                </div>

                {/* 7. Emergency Gate Records */}
                <div className="p-4 rounded-xl border border-[var(--color-border)] bg-[var(--color-canvas)] space-y-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <ShieldAlert className="h-4 w-4 text-[#7A0A0A]" />
                      <span className="text-sm font-bold text-[var(--color-text-primary)]">Emergency Offline Records</span>
                    </div>
                    <label className="flex items-center gap-2 cursor-pointer text-xs font-semibold">
                      <input
                        type="checkbox"
                        checked={settings.emergencyRecordRetentionEnabled}
                        disabled={!canManageSecuritySettings || settingsBusy}
                        onChange={(e) => setSettings((s) => ({ ...s, emergencyRecordRetentionEnabled: e.target.checked }))}
                        className="rounded text-[#7A0A0A] h-4 w-4"
                      />
                      <span>{settings.emergencyRecordRetentionEnabled ? 'Anonymize Expired' : 'Retain Indefinitely'}</span>
                    </label>
                  </div>
                  <p className="text-xs text-[var(--color-text-secondary)]">
                    OFFLINE MODE RECORDED intake PII is anonymized on schedule while retaining aggregate contingency counts and audit references.
                  </p>
                  <div>
                    <label className="block text-xs font-semibold text-[var(--color-text-secondary)] mb-1">
                      Retention Period (30 to 365 days)
                    </label>
                    <Input
                      type="number"
                      min={30}
                      max={365}
                      value={settings.emergencyRecordRetentionDays}
                      disabled={!canManageSecuritySettings || !settings.emergencyRecordRetentionEnabled || settingsBusy}
                      onChange={(e) => setSettings((s) => ({ ...s, emergencyRecordRetentionDays: e.target.value }))}
                    />
                  </div>
                </div>
              </div>

              {/* Administrative Policy Override Note */}
              <div className="p-4 rounded-xl border border-amber-200 bg-amber-50/60 space-y-2 mt-4">
                <label className="block text-xs font-bold text-amber-900">
                  Super Admin Policy Change Reason (Optional Audit Note)
                </label>
                <Input
                  placeholder="e.g. Scheduled annual policy update or institutional compliance review"
                  value={retentionOverrideReason}
                  disabled={!canManageSecuritySettings || settingsBusy}
                  onChange={(e) => setRetentionOverrideReason(e.target.value)}
                />
                <p className="text-[11px] text-amber-800">
                  Any adjustment to retention categories or duration is recorded in the security audit log with timestamp and actor identity.
                </p>
              </div>
            </div>

            {/* Retention Safeguards & Purge Action */}
            <div className="mt-8 border-t border-[var(--color-border)] pt-6 space-y-4">
              <div className="p-4 rounded-xl border border-blue-200 bg-blue-50/50 space-y-1 text-xs text-blue-900">
                <div className="font-bold flex items-center gap-1.5 text-blue-950">
                  <Shield className="h-4 w-4" /> Built-in Retention Safeguards
                </div>
                <p>
                  Automated cleanup strictly protects active visits, visitors currently checked-in on campus (<code className="font-mono bg-blue-100 px-1 rounded">inside</code>), and records flagged with active legal or security holds. Expired images are only purged after verified gate exit or pass expiration.
                </p>
              </div>

              <div className="rounded-lg border border-[var(--color-danger)] bg-[var(--color-danger-light)] p-5">
                <div className="flex items-start gap-4">
                  <AlertTriangle className="mt-0.5 h-6 w-6 flex-shrink-0 text-[var(--color-danger)]" />
                  <div>
                    <h3 className="text-lg font-semibold text-[var(--color-danger-dark)]">Purge Eligible Evidence</h3>
                    <p className="mt-2 text-sm text-[var(--color-danger-dark)]">
                      Permanently deletes eligible visitor photos and ID images that have reached their authoritative expiry date under configured retention policies. Active visits and incident holds remain protected. Visitor details and visit history are kept. This action cannot be undone.
                    </p>
                    <div className="flex flex-wrap gap-3 mt-4">
                      <Button
                        variant="destructive"
                        onClick={handlePurgeClick}
                        disabled={settingsBusy || settings.globalRetentionFreeze}
                        loading={calculatingPurge}
                        icon={<Trash2 className="h-4 w-4" />}
                      >
                        {settings.globalRetentionFreeze
                          ? 'Purge Frozen'
                          : calculatingPurge ? 'Calculating...' : purging ? 'Purging...' : 'Run Standard Purge'}
                      </Button>
                      {canManageSecuritySettings && (
                        <Button
                          variant="secondary"
                          onClick={() => setShowOverridePurgeModal(true)}
                          disabled={settingsBusy || settings.globalRetentionFreeze}
                          className="border-red-300 text-red-900 hover:bg-red-50"
                          icon={<ShieldAlert className="h-4 w-4 text-red-700" />}
                        >
                          Superadmin Override Purge
                        </Button>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </Card>
        </div>
      )}

      {/* ===================== TAB: PERSONAL & PASSWORD ===================== */}
      {currentTab === 'personal' && (
        <div className="space-y-6 max-w-2xl">
          <Card className="p-6 space-y-4">
            <h2 className="text-xl font-bold text-[var(--color-text-primary)]">User Account & Session</h2>
            <div className="divide-y divide-[var(--color-border)] text-xs">
              <div className="py-2.5 flex justify-between">
                <span className="text-[var(--color-text-secondary)]">Authenticated User:</span>
                <span className="font-bold text-[var(--color-text-primary)]">{(userData && 'email' in userData && typeof userData.email === 'string') ? userData.email : 'N/A'}</span>
              </div>
              <div className="py-2.5 flex justify-between">
                <span className="text-[var(--color-text-secondary)]">Assigned Role:</span>
                <span className="font-bold text-[#7A0A0A] uppercase">{role || 'User'}</span>
              </div>
              <div className="py-2.5 flex justify-between">
                <span className="text-[var(--color-text-secondary)]">Session Protection:</span>
                <span className="font-semibold text-emerald-700">15-minute auto-expiry active</span>
              </div>
            </div>
          </Card>

          <PasswordResetCard />
        </div>
      )}

      {/* Purge Confirm Modal */}
      <ConfirmModal
        isOpen={canManageSecuritySettings && showPurgeConfirm && !saving}
        onClose={() => setShowPurgeConfirm(false)}
        title="Purge Expired Evidence?"
        description={
          <div className="space-y-3 text-left">
            <p>
              You are about to permanently delete evidence that has reached its authoritative expiry date for{' '}
              <strong className="text-[var(--color-text-primary)]">{purgeEligibleCount}</strong> eligible visitor{purgeEligibleCount === 1 ? '' : 's'}.
            </p>
            <div className="rounded border border-[var(--color-border)] bg-[var(--color-surface)] p-2.5 text-xs space-y-1">
              <p className="font-semibold text-[var(--color-text-primary)]">Configured policy:</p>
              <p>Face photos: {purgePhotoRetentionDays ?? settings.photoRetentionDays ?? 7} days</p>
              <p>Valid ID images: {purgeIdRetentionDays ?? settings.idRetentionDays ?? 30} days</p>
            </div>
            <p className="text-xs text-[var(--color-text-secondary)]">
              Active/future visits and authorized incident holds remain protected. Visitor details and visit history will remain. This action cannot be undone.
            </p>
          </div>
        }
        onConfirm={executePurge}
        confirmText="Yes, purge images"
        isDestructive
        loading={purging}
      />

      {/* Superadmin Override Purge Modal */}
      <Modal
        isOpen={showOverridePurgeModal}
        onClose={() => setShowOverridePurgeModal(false)}
        title="Superadmin Override Purge"
        size="md"
      >
        <div className="space-y-4">
          <div className="p-3.5 rounded-xl border border-red-300 bg-red-50 text-xs text-red-950 space-y-1.5">
            <div className="font-bold flex items-center gap-1.5 text-red-900">
              <ShieldAlert className="h-4 w-4 text-red-700" /> Intentional Retention Override
            </div>
            <p>
              This action bypasses standard retention timeframes for selected categories. Every invocation is permanently recorded in the immutable audit log.
            </p>
            <p className="font-semibold text-red-900">
              Mandatory Safeguards Enforced: Visitors currently on campus, active passes, and records under active incident holds will NOT be deleted.
            </p>
          </div>

          <div className="space-y-2">
            <label className="text-xs font-bold text-[var(--color-text-primary)]">Target Categories:</label>
            <div className="space-y-1.5 border border-[var(--color-border)] rounded-lg p-3 text-xs">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={overrideCategories.includes('photo')}
                  onChange={(e) => {
                    setOverrideCategories((prev) => e.target.checked ? [...prev, 'photo'] : prev.filter((c) => c !== 'photo'));
                  }}
                  className="rounded border-[var(--color-border)] text-[var(--color-brand)] focus:ring-[var(--color-brand)]"
                />
                <span className="font-semibold text-[var(--color-text-primary)]">Visitor Face Photos</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={overrideCategories.includes('id')}
                  onChange={(e) => {
                    setOverrideCategories((prev) => e.target.checked ? [...prev, 'id'] : prev.filter((c) => c !== 'id'));
                  }}
                  className="rounded border-[var(--color-border)] text-[var(--color-brand)] focus:ring-[var(--color-brand)]"
                />
                <span className="font-semibold text-[var(--color-text-primary)]">Valid Government ID Images</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={overrideCategories.includes('vehicle_photo')}
                  onChange={(e) => {
                    setOverrideCategories((prev) => e.target.checked ? [...prev, 'vehicle_photo'] : prev.filter((c) => c !== 'vehicle_photo'));
                  }}
                  className="rounded border-[var(--color-border)] text-[var(--color-brand)] focus:ring-[var(--color-brand)]"
                />
                <span className="font-semibold text-[var(--color-text-primary)]">Vehicle Photos</span>
              </label>
            </div>
          </div>

          <FormField label="Mandatory Audit Reason" id="override-reason" requirement="required">
            <textarea
              id="override-reason"
              rows={3}
              value={overrideReason}
              onChange={(e) => setOverrideReason(e.target.value)}
              placeholder="State the regulatory, legal, or administrative authorization for this override (min 10 characters)..."
              className="w-full rounded-md border border-[var(--color-border)] p-2.5 text-xs text-[var(--color-text-primary)] focus:outline-none focus:ring-1 focus:ring-[var(--color-brand)]"
            />
          </FormField>

          <div className="flex justify-end gap-2 pt-2">
            <Button
              variant="secondary"
              onClick={() => setShowOverridePurgeModal(false)}
              disabled={isExecutingOverride}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={executeOverridePurge}
              loading={isExecutingOverride}
              disabled={isExecutingOverride || overrideReason.trim().length < 10 || overrideCategories.length === 0}
            >
              Confirm & Execute Override Purge
            </Button>
          </div>
        </div>
      </Modal>

      {/* Peak Mode Modal */}
      <ConfirmModal
        isOpen={showPeakModeConfirm && !settingsBusy}
        onClose={() => {
          setShowPeakModeConfirm(false);
          setPendingPeakMode(null);
        }}
        title="Enable Peak Mode?"
        description={
          <>
            Enabling Peak Mode for <strong className="text-[var(--color-text-primary)]">{pendingPeakMode === 'both' ? 'both Portal and Kiosk' : pendingPeakMode === 'portal' ? 'Online Portal' : 'Kiosk Devices'}</strong> allows visitors to register without providing a government ID photo.
            Face photo is still strictly required. You can turn this off at any time.
          </>
        }
        onConfirm={() => {
          if (settingsBusy) return;
          if (pendingPeakMode) {
            setSettings({ ...settings, peakMode: pendingPeakMode });
            toast.info('Peak Mode change staged. Press Save Settings to apply.');
          }
          setShowPeakModeConfirm(false);
          setPendingPeakMode(null);
        }}
        confirmText="Enable Peak Mode"
      />
    </div>
  );
}
