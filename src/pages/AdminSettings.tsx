import { useState, useEffect } from 'react';
import { Save, Trash2, AlertTriangle, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { Button, Card, Input, Select, ConfirmModal, LoadingState } from '@/components/ui';
import { PasswordResetCard } from '@/components/ChangePasswordCard';
import { DEFAULT_REJECTION_REASONS, normalizeVisitPurposes } from '@/lib/settingsDefaults';
import type { VisitPurposeOption } from '@/types';
import { useAuth } from '@/hooks/useAuth';
import { isSuperAdmin } from '@/lib/permissions';
import { getAccessToken } from '@/services/auth';
import { DEFAULT_WORKING_HOURS, normalizeWorkingHours } from '@/lib/workingHours';
import { DEFAULT_RETENTION_POLICY, normalizeRetentionPolicy } from '@/lib/retentionPolicy';
import {
  RETENTION_INPUT_FIELDS,
  createRetentionInputValues,
  getRetentionInputError,
  validateRetentionInputs,
  type RetentionInputErrors,
} from '@/lib/retentionInput';

export type PeakModeScope = 'off' | 'portal' | 'kiosk' | 'both';

export function AdminSettings() {
  const { role } = useAuth();
  const canManageSecuritySettings = isSuperAdmin(role);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [purging, setPurging] = useState(false);
  const [calculatingPurge, setCalculatingPurge] = useState(false);

  const settingsBusy = saving || purging || calculatingPurge;
  
  const [settings, setSettings] = useState({
    ...DEFAULT_RETENTION_POLICY,
    workingHours: DEFAULT_WORKING_HOURS,
    peakMode: 'off' as PeakModeScope,
    rejectionReasons: [] as string[],
    visitPurposes: [] as VisitPurposeOption[],
  });
  const [retentionInputs, setRetentionInputs] = useState(() => createRetentionInputValues(DEFAULT_RETENTION_POLICY));
  const [retentionErrors, setRetentionErrors] = useState<RetentionInputErrors>({});

  const [newReason, setNewReason] = useState('');
  const [newPurpose, setNewPurpose] = useState('');
  
  // Modals state
  const [showPeakModeConfirm, setShowPeakModeConfirm] = useState(false);
  const [pendingPeakMode, setPendingPeakMode] = useState<PeakModeScope | null>(null);
  const [showPurgeConfirm, setShowPurgeConfirm] = useState(false);
  const [purgeEligibleCount, setPurgeEligibleCount] = useState<number | null>(null);
  const [purgeRetentionDays, setPurgeRetentionDays] = useState<number | null>(null);

  async function loadSettings() {
    setLoading(true);
    setLoadError(null);
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
        setSettings({
          ...retentionPolicy,
          workingHours: normalizeWorkingHours(data.workingHours),
          peakMode: peakScope,
          rejectionReasons: Array.isArray(data.rejectionReasons) ? data.rejectionReasons : DEFAULT_REJECTION_REASONS,
          visitPurposes: normalizeVisitPurposes(data.visitPurposes),
        });
        setRetentionInputs(createRetentionInputValues(retentionPolicy));
        setLoadError(null);
      } else {
        const errorData = await res.json().catch(() => null) as { error?: string } | null;
        const errMsg = errorData?.error || `Failed to load settings (HTTP ${res.status})`;
        setLoadError(errMsg);
        toast.error(errMsg);
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : 'Network failure loading system settings';
      console.error(err);
      setLoadError(errMsg);
      toast.error('Failed to load settings');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadSettings();
  }, []);

  async function handleSave() {
    if (settingsBusy) return;
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
      const token = await getAccessToken();
      if (!token) throw new Error('Your session has expired. Please sign in again.');
      const response = await fetch('/api/update-settings', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(settingsToSave),
      });
      const result = await response.json().catch(() => null) as { error?: string } | null;
      if (!response.ok) throw new Error(result?.error || 'Failed to save settings');
      toast.success('Settings saved successfully');
    } catch (err) {
      console.error(err);
      toast.error('Failed to save settings');
    } finally {
      setSaving(false);
    }
  }

  function addReason() {
    if (settingsBusy || !newReason.trim()) return;
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
    if (settingsBusy) return;
    setSettings((prev) => ({
      ...prev,
      rejectionReasons: prev.rejectionReasons.filter((r) => r !== reason),
    }));
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

  // ============================================================
  // PURGE IMAGES
  // ============================================================
  async function handlePurgeClick() {
    if (settingsBusy) return;
    setCalculatingPurge(true);
    try {
      const token = await getAccessToken();
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
    if (settingsBusy) return;
    setPurging(true);
    try {
      const token = await getAccessToken();
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


  if (loading) {
    return <LoadingState label="Loading system settings" className="h-32" />;
  }

  if (loadError) {
    return (
      <div className="mx-auto max-w-6xl space-y-6">
        <div>
          <h1 className="text-2xl font-bold text-[var(--color-text-primary)]">System Settings</h1>
          <p className="text-sm text-[var(--color-text-secondary)]">Configure policies, reasons, and data retention</p>
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
          disabled={settingsBusy}
          loading={saving}
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
                  When enabled, visitors are not required to upload a government ID, helping speed up the queue. Face photo is always required.
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
                  disabled={settingsBusy}
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
              <input
                type="checkbox"
                checked={settings.automaticCleanupEnabled}
                disabled={settingsBusy}
                onChange={(event) => setSettings((current) => ({ ...current, automaticCleanupEnabled: event.target.checked }))}
              />
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
                    disabled={settingsBusy}
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
                  disabled={settingsBusy}
                  className={`rounded-md p-1.5 text-[var(--color-danger)] hover:bg-[var(--color-danger-light)] transition-colors ${settingsBusy ? 'opacity-50 cursor-not-allowed' : ''}`}
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
                  disabled={settingsBusy}
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
                disabled={settingsBusy}
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
        isOpen={canManageSecuritySettings && showPurgeConfirm && !saving}
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
