import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { Button, FormField, Input, Modal } from '@/components/ui';
import { ShieldCheck, Copy, Check } from 'lucide-react';
import { toast } from 'sonner';

interface TotpEnrollModalProps {
  isOpen: boolean;
  onEnrolled: () => void;
  onCancel: () => void;
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

  useEffect(() => {
    if (!isOpen || !supabase) {
      setEnrollData(null);
      setVerificationCode('');
      setError(null);
      return;
    }

    let isMounted = true;
    async function startEnrollment() {
      setIsLoading(true);
      setError(null);
      try {
        const { data, error: enrollError } = await supabase!.auth.mfa.enroll({
          factorType: 'totp',
          issuer: 'EARIST E-GatePass',
        });

        if (enrollError) throw enrollError;
        if (!isMounted) return;

        if (data?.totp) {
          const rawQr = data.totp.qr_code;
          const qrCode = rawQr.startsWith('data:')
            ? rawQr
            : `data:image/svg+xml;utf-8,${encodeURIComponent(rawQr)}`;

          setEnrollData({
            id: data.id,
            qrCode,
            secret: data.totp.secret,
          });
        }
      } catch (err: unknown) {
        if (!isMounted) return;
        const msg = err instanceof Error ? err.message : 'Failed to initialize MFA enrollment.';
        setError(msg);
      } finally {
        if (isMounted) setIsLoading(false);
      }
    }

    void startEnrollment();

    return () => {
      isMounted = false;
    };
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
      // Attempt verification via official challengeAndVerify
      const { error: verifyError } = await supabase.auth.mfa.challengeAndVerify({
        factorId: enrollData.id,
        code: trimmed,
      });

      if (verifyError) {
        // Fallback to separate challenge + verify if needed
        const { data: challengeData, error: challengeError } = await supabase.auth.mfa.challenge({
          factorId: enrollData.id,
        });
        if (challengeError) throw challengeError;

        const { error: secondVerifyError } = await supabase.auth.mfa.verify({
          factorId: enrollData.id,
          challengeId: challengeData.id,
          code: trimmed,
        });
        if (secondVerifyError) throw secondVerifyError;
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

  function handleCopySecret() {
    if (!enrollData?.secret) return;
    void navigator.clipboard.writeText(enrollData.secret);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
    toast.success('Secret key copied to clipboard');
  }

  return (
    <Modal
      isOpen={isOpen}
      onClose={onCancel}
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
          <div className="py-8 text-center text-sm text-[var(--color-text-muted)]">
            Generating your unique authenticator QR code...
          </div>
        ) : error && !enrollData ? (
          <div className="rounded-lg bg-[var(--color-danger-light)] p-4 text-sm text-[var(--color-danger)] mb-4">
            {error}
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
                onClick={onCancel}
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
