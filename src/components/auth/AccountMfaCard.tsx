import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/hooks/useAuth';
import { Button, Card, FormField, Input, Modal, ConfirmModal, StatusBadge } from '@/components/ui';
import { ShieldCheck, Copy, Check, AlertCircle } from 'lucide-react';
import { toast } from 'sonner';

interface EnrollData {
  id: string;
  qrCode: string;
  secret: string;
}

export function AccountMfaCard({ className = '' }: { className?: string }) {
  const { refresh } = useAuth();
  const [status, setStatus] = useState<'loading' | 'enabled' | 'disabled' | 'error'>('loading');
  const [, setVerifiedFactorId] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Enrollment modal state
  const [isEnrollModalOpen, setIsEnrollModalOpen] = useState(false);
  const [isEnrolling, setIsEnrolling] = useState(false);
  const [enrollData, setEnrollData] = useState<EnrollData | null>(null);
  const [verificationCode, setVerificationCode] = useState('');
  const [isVerifying, setIsVerifying] = useState(false);
  const [enrollError, setEnrollError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // Unenrollment modal state
  const [isDisableModalOpen, setIsDisableModalOpen] = useState(false);
  const [isDisabling, setIsDisabling] = useState(false);

  async function loadFactorStatus() {
    if (!supabase) return;
    setStatus('loading');
    setErrorMessage(null);
    try {
      const { data, error } = await supabase.auth.mfa.listFactors();
      if (error) throw error;
      const allFactors = data?.all ?? data?.totp ?? [];
      const verified = allFactors.find((f: any) => f.factor_type === 'totp' && f.status === 'verified') ??
        data?.totp?.find((f: any) => f.status === 'verified');
      if (verified) {
        setVerifiedFactorId(verified.id);
        setStatus('enabled');
      } else {
        setVerifiedFactorId(null);
        setStatus('disabled');
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to inspect MFA factor status';
      setErrorMessage(msg);
      setStatus('error');
    }
  }

  useEffect(() => {
    void loadFactorStatus();
  }, []);

  async function startEnrollment() {
    if (!supabase) return;
    setIsEnrollModalOpen(true);
    setIsEnrolling(true);
    setEnrollError(null);
    setVerificationCode('');

    try {
      // 1. Clean up stale unverified factors
      try {
        const { data: factorsData } = await supabase.auth.mfa.listFactors();
        const allFactors = factorsData?.all ?? factorsData?.totp ?? [];
        const unverified = allFactors.filter((f: any) => f.factor_type === 'totp' && f.status === 'unverified');
        for (const f of unverified) {
          await supabase.auth.mfa.unenroll({ factorId: f.id });
        }
      } catch (cleanErr) {
        console.warn('Failed cleaning stale unverified factors:', cleanErr);
      }

      // 2. Enroll new TOTP factor
      const { data, error: enrollErr } = await supabase.auth.mfa.enroll({
        factorType: 'totp',
        issuer: 'EARIST E-GatePass',
      });
      if (enrollErr) throw enrollErr;

      if (data?.totp) {
        const rawQr = data.totp.qr_code;
        let qrCode = rawQr;
        if (rawQr.startsWith('data:image/svg+xml')) {
          const commaIdx = rawQr.indexOf(',');
          if (commaIdx !== -1) {
            const prefix = rawQr.slice(0, commaIdx).replace(/;utf-8\b/i, ';charset=utf-8');
            const content = rawQr.slice(commaIdx + 1);
            qrCode = content.trim().startsWith('<svg')
              ? `${prefix},${encodeURIComponent(content)}`
              : `${prefix},${content}`;
          }
        } else if (rawQr.trim().startsWith('<svg')) {
          qrCode = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(rawQr)}`;
        }

        setEnrollData({
          id: data.id,
          qrCode,
          secret: data.totp.secret,
        });
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to initialize MFA enrollment.';
      setEnrollError(msg);
    } finally {
      setIsEnrolling(false);
    }
  }

  async function handleVerify(e: React.FormEvent) {
    e.preventDefault();
    if (!supabase || !enrollData || isVerifying) return;

    const trimmed = verificationCode.trim();
    if (trimmed.length !== 6 || !/^\d{6}$/.test(trimmed)) {
      setEnrollError('Please enter a valid 6-digit verification code.');
      return;
    }

    setIsVerifying(true);
    setEnrollError(null);

    try {
      const { error: verifyErr } = await supabase.auth.mfa.challengeAndVerify({
        factorId: enrollData.id,
        code: trimmed,
      });

      if (verifyErr) {
        const errMsg = verifyErr.message?.toLowerCase() || '';
        if (errMsg.includes('expired')) {
          setEnrollError('The verification challenge has expired. Please try entering a new code.');
        } else if (errMsg.includes('invalid') || errMsg.includes('code') || errMsg.includes('mfa')) {
          setEnrollError('Invalid verification code. Please check your authenticator app and try again.');
        } else {
          setEnrollError(verifyErr.message || 'Verification failed. Please check the code and try again.');
        }
        return;
      }

      const { data: aalData } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
      if (aalData?.currentLevel !== 'aal2') {
        setEnrollError('Verification succeeded but session could not be elevated to AAL2. Please refresh.');
        return;
      }

      // Wipe secrets from state
      setEnrollData(null);
      setVerificationCode('');
      setIsEnrollModalOpen(false);

      toast.success('Two-factor authentication successfully enabled!');
      if (refresh) await refresh();
      await loadFactorStatus();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Verification failed.';
      setEnrollError(msg);
    } finally {
      setIsVerifying(false);
    }
  }

  async function handleCancelEnrollment() {
    if (enrollData?.id && supabase) {
      try {
        await supabase.auth.mfa.unenroll({ factorId: enrollData.id });
      } catch (err) {
        console.warn('Could not unenroll cancelled factor:', err);
      }
    }
    setEnrollData(null);
    setVerificationCode('');
    setIsEnrollModalOpen(false);
  }

  async function handleCopySecret() {
    if (!enrollData?.secret) return;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(enrollData.secret);
      } else {
        const textarea = document.createElement('textarea');
        textarea.value = enrollData.secret;
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      toast.success('Secret key copied to clipboard');
    } catch {
      toast.error('Unable to copy secret key automatically.');
    }
  }

  async function handleDisableMfa() {
    if (!supabase || isDisabling) return;
    setIsDisabling(true);
    try {
      const { data: factorsData, error: listErr } = await supabase.auth.mfa.listFactors();
      if (listErr) throw listErr;

      const allFactors = factorsData?.all ?? factorsData?.totp ?? [];
      const toRemove = allFactors.filter((f: any) => f.factor_type === 'totp');
      for (const f of toRemove) {
        const { error: unenrollErr } = await supabase.auth.mfa.unenroll({ factorId: f.id });
        if (unenrollErr) throw unenrollErr;
      }

      await supabase.auth.refreshSession();
      if (refresh) await refresh();

      toast.success('Two-factor authentication disabled. Password-only login is now active.');
      setIsDisableModalOpen(false);
      await loadFactorStatus();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to disable two-factor authentication.';
      toast.error(msg);
    } finally {
      setIsDisabling(false);
    }
  }

  return (
    <>
      <Card className={`p-6 space-y-4 ${className}`.trim()}>
        <div className="flex items-start justify-between">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <ShieldCheck className="h-5 w-5 text-[var(--color-brand)]" />
              <h2 className="text-xl font-bold text-[var(--color-text-primary)]">Two-Factor Authentication (MFA)</h2>
            </div>
            <p className="text-xs text-[var(--color-text-secondary)]">
              Secure your staff account by requiring a 6-digit authenticator code (TOTP) during login.
            </p>
          </div>

          <div>
            {status === 'loading' && <span className="text-xs text-[var(--color-text-muted)]">Checking...</span>}
            {status === 'enabled' && <StatusBadge status="verified" label="Enabled" />}
            {status === 'disabled' && <StatusBadge status="inactive" label="Disabled" />}
            {status === 'error' && <StatusBadge status="error" label="Unavailable" />}
          </div>
        </div>

        {errorMessage && (
          <div className="rounded-lg bg-[var(--color-danger-light)] p-3 text-xs text-[var(--color-danger)] flex items-center gap-2">
            <AlertCircle className="h-4 w-4 shrink-0" />
            <span>{errorMessage}</span>
          </div>
        )}

        <div className="pt-2 border-t border-[var(--color-border)] flex items-center justify-between">
          <div className="text-xs text-[var(--color-text-muted)]">
            {status === 'enabled'
              ? 'Your account is protected. You will be prompted for an authenticator code on every login.'
              : 'MFA is currently optional for your account. You can enable it anytime to increase your security.'}
          </div>

          <div>
            {status === 'disabled' && (
              <Button
                type="button"
                variant="primary"
                size="sm"
                onClick={() => void startEnrollment()}
              >
                Enable MFA
              </Button>
            )}

            {status === 'enabled' && (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => setIsDisableModalOpen(true)}
                className="text-[var(--color-danger)] hover:bg-[var(--color-danger-light)]"
              >
                Disable MFA
              </Button>
            )}
          </div>
        </div>
      </Card>

      {/* Enrollment Modal */}
      <Modal
        isOpen={isEnrollModalOpen}
        onClose={handleCancelEnrollment}
        title="Set Up Two-Factor Authentication"
        description="Scan the QR code with your authenticator app and enter the 6-digit verification code."
        size="md"
        preventClose={isVerifying}
      >
        <div className="p-6">
          {isEnrolling ? (
            <div className="py-8 text-center text-sm text-[var(--color-text-muted)] space-y-4">
              <p>Generating your unique authenticator QR code...</p>
            </div>
          ) : enrollError && !enrollData ? (
            <div className="space-y-4">
              <div className="rounded-lg bg-[var(--color-danger-light)] p-4 text-sm text-[var(--color-danger)]">
                {enrollError}
              </div>
              <div className="flex justify-end gap-3">
                <Button type="button" variant="secondary" onClick={handleCancelEnrollment}>
                  Cancel
                </Button>
                <Button type="button" variant="primary" onClick={() => void startEnrollment()}>
                  Retry Setup
                </Button>
              </div>
            </div>
          ) : enrollData ? (
            <form onSubmit={handleVerify} className="space-y-4">
              <p className="text-xs text-[var(--color-text-secondary)]">
                1. Scan this QR code with Google Authenticator, Microsoft Authenticator, 1Password, or Authy:
              </p>

              <div className="flex justify-center my-3 bg-white p-3 rounded-lg border border-[var(--color-border)]">
                <img src={enrollData.qrCode} alt="TOTP QR Code" className="w-48 h-48 object-contain" />
              </div>

              <div className="bg-[var(--color-canvas-subtle)] p-3 rounded-lg border border-[var(--color-border)] text-xs">
                <span className="text-[var(--color-text-muted)] block mb-1">Manual secret entry key:</span>
                <div className="flex items-center justify-between font-mono bg-white px-2 py-1.5 rounded border border-[var(--color-border)]">
                  <span className="select-all tracking-wider break-all">{enrollData.secret}</span>
                  <button
                    type="button"
                    onClick={handleCopySecret}
                    className="ml-2 p-1 text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"
                    title="Copy secret"
                    aria-label="Copy secret"
                  >
                    {copied ? <Check className="h-4 w-4 text-[var(--color-success)]" /> : <Copy className="h-4 w-4" />}
                  </button>
                </div>
              </div>

              <FormField label="2. Enter 6-digit verification code:" requirement="required" error={enrollError ?? undefined}>
                <Input
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  maxLength={6}
                  value={verificationCode}
                  onChange={(e) => {
                    setEnrollError(null);
                    setVerificationCode(e.target.value.replace(/\D/g, '').slice(0, 6));
                  }}
                  placeholder="000000"
                  className="text-center font-mono text-xl tracking-widest"
                  autoFocus
                />
              </FormField>

              <div className="flex items-center justify-end gap-3 pt-2">
                <Button type="button" variant="secondary" onClick={handleCancelEnrollment} disabled={isVerifying}>
                  Cancel
                </Button>
                <Button type="submit" variant="primary" disabled={isVerifying || verificationCode.length !== 6}>
                  {isVerifying ? 'Verifying...' : 'Verify & Enable MFA'}
                </Button>
              </div>
            </form>
          ) : null}
        </div>
      </Modal>

      {/* Unenrollment Confirmation Modal */}
      <ConfirmModal
        isOpen={isDisableModalOpen}
        onClose={() => setIsDisableModalOpen(false)}
        title="Disable Two-Factor Authentication?"
        description="Disabling two-factor authentication will remove your authenticator factor. On future logins, you will authenticate using only your password. Are you sure you want to proceed?"
        confirmText="Disable MFA"
        cancelText="Keep MFA"
        isDestructive={true}
        loading={isDisabling}
        onConfirm={handleDisableMfa}
      />
    </>
  );
}
