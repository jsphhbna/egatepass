import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { Button, FormField, Input, Modal } from '@/components/ui';
import { ShieldCheck, Copy, Check } from 'lucide-react';
import { toast } from 'sonner';

interface TotpEnrollModalProps {
  isOpen: boolean;
  onEnrolled: () => void;
  onCancel: () => void | Promise<void>;
}

interface EnrollData {
  id: string;
  qrCode: string;
  secret: string;
}

export function TotpEnrollModal({ isOpen, onEnrolled, onCancel }: TotpEnrollModalProps) {
  const [enrollData, setEnrollData] = useState<EnrollData | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [verificationCode, setVerificationCode] = useState('');
  const [isVerifying, setIsVerifying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const startEnrollment = async () => {
    if (!supabase) return;
    setIsLoading(true);
    setError(null);
    try {
      // Clean up any stale unverified TOTP factors first to ensure clean enrollment
      try {
        const { data: factorsData } = await supabase.auth.mfa.listFactors();
        const unverified = factorsData?.all?.filter((f) => f.factor_type === 'totp' && f.status === 'unverified') ?? [];
        for (const factor of unverified) {
          await supabase.auth.mfa.unenroll({ factorId: factor.id });
        }
      } catch (cleanupErr) {
        console.warn('Could not clean up stale unverified factors:', cleanupErr);
      }

      const { data, error: enrollError } = await supabase.auth.mfa.enroll({
        factorType: 'totp',
        issuer: 'EARIST E-GatePass',
      });

      if (enrollError) throw enrollError;

      if (data?.totp) {
        const rawQr = data.totp.qr_code;
        let qrCode = rawQr;
        if (rawQr.startsWith('data:image/svg+xml')) {
          const commaIdx = rawQr.indexOf(',');
          if (commaIdx !== -1) {
            const prefix = rawQr.slice(0, commaIdx).replace(/;utf-8\b/i, ';charset=utf-8');
            const content = rawQr.slice(commaIdx + 1);
            if (content.trim().startsWith('<svg')) {
              qrCode = `${prefix},${encodeURIComponent(content)}`;
            } else {
              qrCode = `${prefix},${content}`;
            }
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
      setError(msg);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (!isOpen || !supabase) {
      setEnrollData(null);
      setVerificationCode('');
      setError(null);
      return;
    }

    void startEnrollment();
  }, [isOpen]);

  async function handleVerify(e: React.FormEvent) {
    e.preventDefault();
    if (!supabase || !enrollData || isVerifying) return;

    const trimmed = verificationCode.trim();
    if (trimmed.length !== 6 || !/^\d{6}$/.test(trimmed)) {
      setError('Please enter a valid 6-digit authentication code.');
      return;
    }

    setIsVerifying(true);
    setError(null);

    try {
      const { error: verifyError } = await supabase.auth.mfa.challengeAndVerify({
        factorId: enrollData.id,
        code: trimmed,
      });

      if (verifyError) {
        const errMsg = verifyError.message?.toLowerCase() || '';
        if (errMsg.includes('expired')) {
          setError('The verification challenge has expired. Please try entering a new code.');
        } else if (errMsg.includes('invalid') || errMsg.includes('code') || errMsg.includes('mfa')) {
          setError('Invalid verification code. Please check your authenticator app and try again.');
        } else {
          setError(verifyError.message || 'Verification failed. Check the code and try again.');
        }
        return;
      }

      // Verify that session has reached AAL2
      const { data: aalData, error: aalError } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
      if (aalError || aalData?.currentLevel !== 'aal2') {
        setError('Verification completed but session could not be elevated to AAL2. Please try again.');
        return;
      }

      toast.success('Two-factor authentication successfully configured.');
      onEnrolled();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Verification failed. Check the code and try again.';
      setError(msg);
    } finally {
      setIsVerifying(false);
    }
  }

  async function handleCancel() {
    if (enrollData?.id && supabase) {
      try {
        await supabase.auth.mfa.unenroll({ factorId: enrollData.id });
      } catch (unenrollErr) {
        console.warn('Could not unenroll cancelled factor:', unenrollErr);
      }
    }
    await onCancel();
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
      toast.error('Unable to copy secret key automatically. Please copy it manually.');
    }
  }

  return (
    <Modal
      isOpen={isOpen}
      onClose={handleCancel}
      preventClose={true}
      title="Set Up Two-Factor Authentication"
      description="Protect your staff account with mandatory TOTP authenticator."
      size="md"
    >
      <div className="p-6">
        <div className="flex items-center gap-3 mb-4 text-[var(--color-brand)]">
          <ShieldCheck className="h-7 w-7 text-[var(--color-brand)]" />
          <div>
            <h2 className="text-lg font-bold text-[var(--color-text-primary)]">Mandatory MFA Enrollment</h2>
            <p className="text-xs text-[var(--color-text-muted)]">Human staff accounts require two-factor authentication.</p>
          </div>
        </div>

        {isLoading ? (
          <div className="py-8 text-center text-sm text-[var(--color-text-muted)] space-y-4">
            <p>Generating your unique authenticator QR code...</p>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={handleCancel}
            >
              Sign Out / Cancel
            </Button>
          </div>
        ) : error && !enrollData ? (
          <div className="space-y-4">
            <div className="rounded-lg bg-[var(--color-danger-light)] p-4 text-sm text-[var(--color-danger)]">
              {error}
            </div>
            <div className="flex items-center justify-end gap-3 pt-2">
              <Button
                type="button"
                variant="secondary"
                onClick={handleCancel}
              >
                Sign Out / Cancel
              </Button>
              <Button
                type="button"
                variant="primary"
                onClick={() => void startEnrollment()}
              >
                Retry Setup
              </Button>
            </div>
          </div>
        ) : enrollData ? (
          <form onSubmit={handleVerify} className="space-y-4">
            <p className="text-xs text-[var(--color-text-secondary)] leading-relaxed">
              1. Scan this QR code using your authenticator app (Google Authenticator, Microsoft Authenticator, 1Password, or Authy).
            </p>

            <div className="flex justify-center my-3 bg-white p-3 rounded-lg border border-[var(--color-border)]">
              <img
                src={enrollData.qrCode}
                alt="Authenticator QR Code"
                className="w-48 h-48 object-contain"
              />
            </div>

            <div className="bg-[var(--color-canvas-subtle)] p-3 rounded-lg border border-[var(--color-border)] text-xs">
              <span className="text-[var(--color-text-muted)] block mb-1">Manual entry secret key:</span>
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

            <p className="text-xs text-[var(--color-text-secondary)] leading-relaxed">
              2. Enter the 6-digit code shown in your authenticator app to confirm setup:
            </p>

            <FormField label="Verification Code" requirement="required" error={error ?? undefined}>
              <Input
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                maxLength={6}
                value={verificationCode}
                onChange={(e) => {
                  setError(null);
                  setVerificationCode(e.target.value.replace(/\D/g, '').slice(0, 6));
                }}
                placeholder="000000"
                className="text-center font-mono text-xl tracking-widest"
                autoFocus
              />
            </FormField>

            <div className="flex items-center justify-end gap-3 pt-2">
              <Button
                type="button"
                variant="secondary"
                onClick={handleCancel}
                disabled={isVerifying}
              >
                Sign Out / Cancel
              </Button>
              <Button
                type="submit"
                variant="primary"
                disabled={isVerifying || verificationCode.length !== 6}
              >
                {isVerifying ? 'Verifying...' : 'Verify & Complete Setup'}
              </Button>
            </div>
          </form>
        ) : null}
      </div>
    </Modal>
  );
}
