import { useState, useEffect } from 'react';
import {
  doc,
  getDoc,
} from 'firebase/firestore';
import { db, auth } from '@/lib/firebase';
import { Save, Trash2, AlertTriangle, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { Button, Card, Input, ConfirmModal, LoadingState } from '@/components/ui';
import { PasswordResetCard } from '@/components/ChangePasswordCard';
import { DEFAULT_REJECTION_REASONS, DEFAULT_VISIT_PURPOSES, normalizeVisitPurposes } from '@/lib/settingsDefaults';
import type { VisitPurposeOption } from '@/types';
import { useAuth } from '@/hooks/useAuth';
import { isSuperAdmin } from '@/lib/permissions';
import { DEFAULT_WORKING_HOURS, normalizeWorkingHours } from '@/lib/workingHours';
import { DEFAULT_RETENTION_POLICY, normalizeRetentionPolicy } from '@/lib/retentionPolicy';
import {
  RETENTION_INPUT_FIELDS,
  createRetentionInputValues,
  getRetentionInputError,
  validateRetentionInputs,
  type RetentionInputErrors,
} from '@/lib/retentionInput';

export function AdminSettings() {
  const { role } = useAuth();
  const canManageSecuritySettings = isSuperAdmin(role);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [purging, setPurging] = useState(false);
  
  const [settings, setSettings] = useState({
    ...DEFAULT_RETENTION_POLICY,
    workingHours: DEFAULT_WORKING_HOURS,
    peakMode: false,
    rejectionReasons: [] as string[],
    visitPurposes: [] as VisitPurposeOption[],
  });
  const [retentionInputs, setRetentionInputs] = useState(() => createRetentionInputValues(DEFAULT_RETENTION_POLICY));
  const [retentionErrors, setRetentionErrors] = useState<RetentionInputErrors>({});

  const [newReason, setNewReason] = useState('');
  const [newPurpose, setNewPurpose] = useState('');
  
  // Modals state
  const [showPeakModeConfirm, setShowPeakModeConfirm] = useState(false);
  const [showPurgeConfirm, setShowPurgeConfirm] = useState(false);
  const [purgeEligibleCount, setPurgeEligibleCount] = useState<number | null>(null);
  const [purgeRetentionDays, setPurgeRetentionDays] = useState<number | null>(null);
  const [calculatingPurge, setCalculatingPurge] = useState(false);

  useEffect(() => {
    async function loadSettings() {
      try {
        const snap = await getDoc(doc(db, 'settings', 'app'));
        if (snap.exists()) {
          const data = snap.data();
          const retentionPolicy = normalizeRetentionPolicy(data);
          setSettings({
            ...retentionPolicy,
            workingHours: normalizeWorkingHours(data.workingHours),
            peakMode: data.peakMode === true,
            rejectionReasons: Array.isArray(data.rejectionReasons) ? data.rejectionReasons : DEFAULT_REJECTION_REASONS,
            visitPurposes: normalizeVisitPurposes(data.visitPurposes),
          });
          setRetentionInputs(createRetentionInputValues(retentionPolicy));
        } else {
          const defaultSettings = {
            ...DEFAULT_RETENTION_POLICY,
            workingHours: DEFAULT_WORKING_HOURS,
            peakMode: false,
            rejectionReasons: DEFAULT_REJECTION_REASONS,
            visitPurposes: DEFAULT_VISIT_PURPOSES,
          };
          setSettings(defaultSettings);
          setRetentionInputs(createRetentionInputValues(DEFAULT_RETENTION_POLICY));
        }
      } catch (err) {
        console.error(err);
        toast.error('Failed to load settings');
      } finally {
        setLoading(false);
      }
    }
    loadSettings();
  }, []);

  async function handleSave() {
    const retentionValidation = canManageSecuritySettings
      ? validateRetentionInputs(retentionInputs)
      : null;
    if (retentionValidation && !retentionValidation.success) {
      setRetentionErrors(retentionValidation.errors);
      toast.error('Correct the highlighted retention settings before saving');
      return;
    }
    setRetentionErrors({});
    if (settings.workingHours.start >= settings.workingHours.end) {
      toast.error('Campus opening time must be earlier than closing time');
      return;
    }
    const missingPrompt = settings.visitPurposes.find((purpose) => purpose.requiresDetails && purpose.detailPrompt.trim().length < 3);
    if (missingPrompt) {
      toast.error(`Add an instruction for “${missingPrompt.label}” before saving`);
      return;
    }
    setSaving(true);
    try {
      const operationalSettings = {
        peakMode: settings.peakMode,
        rejectionReasons: settings.rejectionReasons,
        visitPurposes: settings.visitPurposes.map((purpose) => ({
          ...purpose,
          detailPrompt: purpose.requiresDetails ? purpose.detailPrompt.trim() : '',
        })),
      };
      const settingsToSave = canManageSecuritySettings
        ? { ...operationalSettings, workingHours: settings.workingHours,
          ...retentionValidation?.data,
          automaticCleanupEnabled: settings.automaticCleanupEnabled }
        : operationalSettings;
      const token = await auth.currentUser?.getIdToken();
      if (!token) throw new Error('Your session has expired. Please sign in again.');
      const response = await fetch('/api/update-settings', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(settingsToSave),
      });
      const result = await response.json().catch(() => null) as { error?: string } | null;
      if (!response.ok) throw new Error(result?.error || 'Failed to save settings');
      setSettings((current) => ({ ...current, ...settingsToSave }));
      toast.success('Settings saved successfully');
    } catch (err) {
      console.error(err);
      toast.error('Failed to save settings');
    } finally {
      setSaving(false);
    }
  }

  function addReason() {
    if (!newReason.trim()) return;
    if (settings.rejectionReasons.includes(newReason.trim())) {
      toast.error('Reason already exists');
      return;
    }
    setSettings((prev) => ({
      ...prev,
      rejectionReasons: [...prev.rejectionReasons, newReason.trim()],
    }));
    setNewReason('');
  }

  function removeReason(reason: string) {
    setSettings((prev) => ({
      ...prev,
      rejectionReasons: prev.rejectionReasons.filter((r) => r !== reason),
    }));
  }

  function addPurpose() {
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
    setSettings((previous) => ({
      ...previous,
      visitPurposes: previous.visitPurposes.filter((item) => item.label !== purpose),
    }));
  }

  function togglePurposeDetails(label: string) {
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
    setSettings((previous) => ({
      ...previous,
      visitPurposes: previous.visitPurposes.map((purpose) => purpose.label === label
        ? { ...purpose, detailPrompt }
        : purpose),
    }));
  }

  // ============================================================
  // PURGE IMAGES
  // ============================================================
  async function handlePurgeClick() {
    setCalculatingPurge(true);
    try {
      const token = await auth.currentUser?.getIdToken();
      if (!token) throw new Error('Not authenticated');

      const res = await fetch('/api/purge-images', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ dryRun: true }),
      });

      if (!res.ok) {
        throw new Error('Could not check which images are ready for deletion');
      }

      const data = await res.json() as { visitorsAffected: number; retentionDays: number };
      setPurgeEligibleCount(data.visitorsAffected);
      setPurgeRetentionDays(data.retentionDays);
      setShowPurgeConfirm(true);
    } catch (err) {
      console.error('Dry run failed', err);
      toast.error('Could not calculate purge impact');
    } finally {
      setCalculatingPurge(false);
    }
  }

  async function executePurge() {
    setPurging(true);
    try {
      const token = await auth.currentUser?.getIdToken();
      if (!token) throw new Error('Not authenticated');

      const res = await fetch('/api/purge-images', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Purge failed: ${res.status} - ${text}`);
      }
      const data = await res.json() as {
        successCount: number;
        failedCount: number;
        orphanDeletedCount?: number;
        orphanFailedCount?: number;
        hasMore: boolean;
      };
      const totalFailed = data.failedCount + (data.orphanFailedCount || 0);
      if (totalFailed > 0) {
        throw new Error(
          `Images were deleted for ${data.successCount} visitor${data.successCount === 1 ? '' : 's'}, but ${totalFailed} could not be completed. The failed records were not marked as deleted. Please try again.`
        );
      }
      toast.success(data.hasMore
        ? `Images deleted for ${data.successCount} visitors. More eligible records remain; run another confirmed batch when ready.`
        : `Images deleted for ${data.successCount} visitor${data.successCount === 1 ? '' : 's'}.`);
      setShowPurgeConfirm(false);
    } catch (err: any) {
      console.error(err);
      toast.error(err.message || 'Purge failed');
    } finally {
      setPurging(false);
    }
  }

  function togglePeakMode() {
    if (!settings.peakMode) {
      setShowPeakModeConfirm(true);
    } else {
      // Instant off
      setSettings({ ...settings, peakMode: false });
      toast.success('Peak Mode disabled');
    }
  }

  if (loading) {
    return <LoadingState label="Loading system settings" className="h-32" />;
  }

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-[var(--color-text-primary)]">
            System Settings
          </h1>
          <p className="text-sm text-[var(--color-text-secondary)]">
            Configure policies, reasons, and data retention
          </p>
        </div>
        <Button
          onClick={handleSave}
          disabled={saving}
          icon={<Save className="h-4 w-4" />}
        >
          {saving ? 'Saving...' : 'Save Settings'}
        </Button>
      </div>

      <div className={`grid items-start gap-6 ${canManageSecuritySettings ? 'lg:grid-cols-2' : ''}`}>
        <div className="grid content-start gap-6">
          <Card className="p-6">
          <h2 className="text-xl font-bold text-[var(--color-text-primary)]">Campus Access Hours</h2>
          <p className="mb-5 mt-2 text-sm leading-relaxed text-[var(--color-text-secondary)]">
            Gate passes use these hours for the selected visit date in Asia/Manila. Only a Super Admin can change this global policy.
          </p>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="working-hours-start" className="mb-2 block text-sm font-medium text-[var(--color-text-primary)]">Opens</label>
              <Input
                id="working-hours-start"
                type="time"
                value={settings.workingHours.start}
                disabled={!canManageSecuritySettings}
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
                disabled={!canManageSecuritySettings}
                onChange={(event) => setSettings((current) => ({
                  ...current,
                  workingHours: { ...current.workingHours, end: event.target.value },
                }))}
              />
            </div>
          </div>
          <p className="mt-4 text-xs font-semibold text-[var(--color-text-muted)]">Timezone: Asia/Manila (UTC+08:00)</p>
          </Card>

          {/* Peak Mode */}
          <Card className="p-6">
            <div className="flex items-center justify-between gap-4">
              <div className="min-w-0">
                <h2 className="text-xl font-bold text-[var(--color-text-primary)]">Peak Mode</h2>
                <p className="mt-2 text-sm leading-relaxed text-[var(--color-text-secondary)]">
                  When enabled, visitors are not required to upload a government ID, helping speed up the queue.
                </p>
              </div>
              <button
                type="button"
                onClick={togglePeakMode}
                className={`relative inline-flex h-7 w-12 shrink-0 items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-brand)] focus-visible:ring-offset-2 ${
                  settings.peakMode ? 'bg-[var(--color-brand)]' : 'bg-[var(--color-border-strong)]'
                }`}
                role="switch"
                aria-checked={settings.peakMode}
                aria-label="Peak mode"
              >
                <span
                  className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${
                    settings.peakMode ? 'translate-x-6' : 'translate-x-1'
                  }`}
                />
              </button>
            </div>
          </Card>

          <PasswordResetCard />

          {canManageSecuritySettings && <Card className="p-6">
            <h2 className="text-xl font-bold text-[var(--color-text-primary)]">Premade Visit Purposes</h2>
            <p className="mb-5 mt-2 text-sm text-[var(--color-text-secondary)]">
              Visitors can choose these options when requesting a gate pass. They can still select Other and type their own purpose.
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
                        aria-pressed={purpose.requiresDetails}
                        className={`rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-brand)] ${
                          purpose.requiresDetails
                            ? 'border-[var(--color-brand)] bg-[var(--color-brand-light)] text-[var(--color-brand)]'
                            : 'border-[var(--color-border)] bg-white text-[var(--color-text-secondary)] hover:bg-[var(--color-canvas)]'
                        }`}
                      >
                        {purpose.requiresDetails ? 'Details required' : 'Require details'}
                      </button>
                      <button
                        type="button"
                        onClick={() => removePurpose(purpose.label)}
                        className="rounded-md p-1.5 text-[var(--color-danger)] transition-colors hover:bg-[var(--color-danger-light)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-brand)]"
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
                <Button onClick={addPurpose} variant="secondary" icon={<Plus className="h-4 w-4" />}>
                  Add
                </Button>
              </li>
            </ul>
          </Card>}
        </div>

        {canManageSecuritySettings && <div className="grid content-start gap-6">
          {/* Retention Policy */}
          <Card className="p-6">
            <h2 className="mb-5 text-xl font-bold text-[var(--color-text-primary)]">Data Retention</h2>

            <p className="mb-5 text-sm text-[var(--color-text-secondary)]">Automatic cleanup uses these policies for new eligible data. Export records needed for long-term archive before their retention deadline.</p>
            <div className="mb-8 grid gap-4 sm:grid-cols-2">
              {RETENTION_INPUT_FIELDS.map(({ field, label, min, max }) => <div key={field}>
                <label htmlFor={field} className="mb-2 block text-sm font-medium text-[var(--color-text-primary)]">{label} (days)</label>
                <Input
                  id={field}
                  type="number"
                  inputMode="numeric"
                  step={1}
                  min={min}
                  max={max}
                  value={retentionInputs[field]}
                  error={Boolean(retentionErrors[field])}
                  aria-describedby={retentionErrors[field] ? `${field}-error` : undefined}
                  onChange={(event) => {
                    const value = event.target.value;
                    setRetentionInputs((current) => ({ ...current, [field]: value }));
                    if (retentionErrors[field]) {
                      setRetentionErrors((current) => ({
                        ...current,
                        [field]: getRetentionInputError(field, value),
                      }));
                    }
                  }}
                  onBlur={(event) => setRetentionErrors((current) => ({
                    ...current,
                    [field]: getRetentionInputError(field, event.target.value),
                  }))}
                />
                {retentionErrors[field] && (
                  <p id={`${field}-error`} className="mt-1.5 text-xs font-medium text-[var(--color-danger)]" role="alert">
                    {retentionErrors[field]}
                  </p>
                )}
              </div>)}
            </div>
            <label className="mb-8 flex items-center gap-3 text-sm font-medium text-[var(--color-text-primary)]">
              <input type="checkbox" checked={settings.automaticCleanupEnabled} onChange={(event) => setSettings((current) => ({ ...current, automaticCleanupEnabled: event.target.checked }))} />
              Enable automatic daily cleanup
            </label>

            <div className="rounded-lg border border-[var(--color-danger)] bg-[var(--color-danger-light)] p-5">
              <div className="flex items-start gap-4">
                <AlertTriangle className="mt-0.5 h-6 w-6 flex-shrink-0 text-[var(--color-danger)]" />
                <div>
                  <h3 className="text-lg font-semibold text-[var(--color-danger-dark)]">Purge Eligible Images</h3>
                  <p className="mt-2 text-sm text-[var(--color-danger-dark)]">
                    Permanently deletes eligible visitor photos and ID images under the {settings.imageRetentionDays}-day image policy. Visitor details and visit history are kept. This action cannot be undone.
                  </p>
                  <Button
                    variant="destructive"
                    onClick={handlePurgeClick}
                    disabled={purging || calculatingPurge}
                    loading={calculatingPurge}
                    className="mt-4"
                    icon={<Trash2 className="h-4 w-4" />}
                  >
                    {calculatingPurge ? 'Calculating...' : purging ? 'Purging...' : 'Run Purge Now'}
                  </Button>
                </div>
              </div>
            </div>
          </Card>

        {/* Rejection Reasons */}
        <Card className="p-6">
          <h2 className="mb-5 text-xl font-bold text-[var(--color-text-primary)]">Premade Rejection Reasons</h2>
          
          <ul className="divide-y rounded-lg border border-[var(--color-border)] overflow-hidden">
            {settings.rejectionReasons.map((reason) => (
              <li key={reason} className="flex items-center justify-between p-4 hover:bg-[var(--color-canvas)] transition-colors">
                <span className="text-sm font-medium text-[var(--color-text-primary)]">{reason}</span>
                <button
                  type="button"
                  onClick={() => removeReason(reason)}
                  className="rounded-md p-1.5 text-[var(--color-danger)] hover:bg-[var(--color-danger-light)] transition-colors"
                  aria-label="Remove reason"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </li>
            ))}
            {settings.rejectionReasons.length === 0 && (
              <li className="p-6 text-center text-sm text-[var(--color-text-muted)]">No reasons configured</li>
            )}
            
            <li className="flex gap-3 border-t border-[var(--color-border)] bg-[var(--color-canvas)] p-4">
              <div className="flex-1">
                <Input
                  type="text"
                  value={newReason}
                  onChange={(e) => setNewReason(e.target.value)}
                  placeholder="Add new reason..."
                  aria-label="New rejection reason"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      addReason();
                    }
                  }}
                />
              </div>
              <Button
                onClick={addReason}
                variant="secondary"
                icon={<Plus className="h-4 w-4" />}
              >
                Add
              </Button>
            </li>
          </ul>
        </Card>

        </div>}
      </div>
      
      <ConfirmModal
        isOpen={canManageSecuritySettings && showPurgeConfirm}
        onClose={() => setShowPurgeConfirm(false)}
        title="Purge Images?"
        description={
          <>
            You are about to permanently delete photos and ID images for <strong className="text-[var(--color-text-primary)]">{purgeEligibleCount}</strong> eligible visitor{purgeEligibleCount === 1 ? '' : 's'} under the {purgeRetentionDays ?? settings.imageRetentionDays}-day image policy. Visitor details and visit history will remain.
            This action cannot be undone.
          </>
        }
        onConfirm={executePurge}
        confirmText="Yes, purge images"
        isDestructive
        loading={purging}
      />

      <ConfirmModal
        isOpen={showPeakModeConfirm}
        onClose={() => setShowPeakModeConfirm(false)}
        title="Enable Peak Mode?"
        description={
          <>
            Are you sure you want to enable Peak Mode? Visitors will not be required to provide a government ID photo during registration. This reduces security but speeds up processing.
          </>
        }
        onConfirm={() => {
          setSettings({ ...settings, peakMode: true });
          setShowPeakModeConfirm(false);
          toast.success('Peak Mode enabled');
        }}
        confirmText="Enable Peak Mode"
      />
    </div>
  );
}
