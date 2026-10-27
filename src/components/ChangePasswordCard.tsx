import { useState, useEffect } from 'react';
import { KeyRound, Mail } from 'lucide-react';
import { toast } from 'sonner';
import { sendPasswordReset, evaluateAuthTurnstilePolicy } from '@/services/auth';
import { useAuth } from '@/hooks/useAuth';
import { Button, Card } from '@/components/ui';
import { TurnstileWidget } from '@/components/TurnstileWidget';

function errorMessage(error: unknown): string | undefined {
  return error instanceof Error ? error.message : undefined;
}

export function PasswordResetCard() {
  const { userData } = useAuth();
  const [isSendingReset, setIsSendingReset] = useState(false);
  const [countdown, setCountdown] = useState(0);
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const [turnstileKey, setTurnstileKey] = useState(0);

  useEffect(() => {
    if (countdown <= 0) return;
    const timer = window.setTimeout(() => {
      setCountdown((previous) => Math.max(0, previous - 1));
    }, 1000);
    return () => window.clearTimeout(timer);
  }, [countdown]);

  async function sendResetLink() {
    const email = userData?.kind === 'staff' ? userData.email : '';
    if (!email) {
      toast.error('Your account session has expired. Please sign in again.');
      return;
    }
    if (countdown > 0) return;

    const siteKey = (import.meta as any).env?.VITE_TURNSTILE_SITE_KEY?.trim();
    const isProd = Boolean((import.meta as any).env?.PROD);
    const policy = evaluateAuthTurnstilePolicy(isProd, siteKey, captchaToken);
    if (!policy.allowed) {
      toast.error(policy.error ?? 'Please complete the security challenge before requesting a password reset.');
      return;
    }

    setIsSendingReset(true);
    try {
      await sendPasswordReset(email, captchaToken || undefined);
      toast.success(`A password reset link was sent to ${email}.`);
      setCountdown(60);
    } catch (error) {
      toast.error(errorMessage(error) || 'Could not send the password reset email.');
    } finally {
      setCaptchaToken(null);
      setTurnstileKey((k) => k + 1);
      setIsSendingReset(false);
    }
  }

  return (
    <Card className="p-6">
      <div className="flex items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[var(--color-brand-light)] text-[var(--color-brand)]">
          <KeyRound className="h-5 w-5" aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="text-xl font-bold text-[var(--color-text-primary)]">Reset Password</h2>
          <p className="mt-1 text-sm leading-relaxed text-[var(--color-text-secondary)]">
            Send a secure password reset link to the email address for your signed-in account.
          </p>
        </div>
      </div>

      <div className="mt-4">
        <TurnstileWidget
          resetKey={turnstileKey}
          onVerify={(token: string) => setCaptchaToken(token)}
          onExpire={() => setCaptchaToken(null)}
          onError={() => setCaptchaToken(null)}
        />
      </div>

      <Button
        type="button"
        variant="secondary"
        onClick={sendResetLink}
        loading={isSendingReset}
        disabled={isSendingReset || countdown > 0}
        icon={<Mail className="h-4 w-4" aria-hidden="true" />}
        className="mt-5 min-h-11 w-full"
      >
        {countdown > 0
          ? `Resend Link in ${countdown}s`
          : isSendingReset
          ? 'Sending Link...'
          : 'Email Me a Reset Link'}
      </Button>
    </Card>
  );
}
