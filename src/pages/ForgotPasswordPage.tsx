import { TurnstileWidget } from '@/components/TurnstileWidget';
import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { sendPasswordReset } from '@/services/auth';
import { Card, Button, Input, FormField } from '@/components/ui';
import { BrandMark } from '@/components/BrandMark';
import { toast } from 'sonner';

export function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [countdown, setCountdown] = useState(0);
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const [turnstileKey, setTurnstileKey] = useState(0);

  function resetTurnstile() {
    setCaptchaToken(null);
    setTurnstileKey((k) => k + 1);
  }

  useEffect(() => {
    if (countdown <= 0) return;
    const timer = window.setTimeout(() => {
      setCountdown((previous) => Math.max(0, previous - 1));
    }, 1000);
    return () => window.clearTimeout(timer);
  }, [countdown]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!email) {
      toast.error('Please enter your email address');
      return;
    }
    
    // Basic email format check
    if (!/\S+@\S+\.\S+/.test(email)) {
      toast.error('Please enter a valid email address');
      return;
    }

    if (countdown > 0) return;

    const siteKey = (import.meta as any).env?.VITE_TURNSTILE_SITE_KEY?.trim();
    const isProd = Boolean((import.meta as any).env?.PROD);
    if (isProd && siteKey && !captchaToken) {
      toast.error('Please complete the security challenge before requesting a password reset.');
      return;
    }

    setLoading(true);
    try {
      await sendPasswordReset(email, captchaToken || undefined);
      toast.success('If an account exists for this email, a password reset link has been sent.', {
        duration: 6000
      });
      setCountdown(60);
    } catch (err: unknown) {
      console.error('Password reset error:', err);
      if (err instanceof Error && err.message.includes('not configured')) {
        toast.error('Account recovery is not configured. Please contact the system administrator.');
      } else if (!navigator.onLine) {
        toast.error('Network error. Please check your connection and try again.');
      } else {
        toast.error('Failed to send reset email. Please try again later.');
      }
    } finally {
      resetTurnstile();
      setLoading(false);
    }
  }

  return (
    <main id="main-content" className="flex min-h-dvh items-center justify-center bg-[var(--color-canvas)] px-4 py-10">
      <Card className="w-full max-w-sm border-t-4 border-t-[var(--color-brand)] p-6 sm:p-8">
        <div className="mb-8 text-center">
          <BrandMark size="lg" className="mx-auto mb-4" />
          <p className="mb-2 text-xs font-bold uppercase tracking-widest text-[var(--color-brand)]">Account recovery</p>
          <h1 className="text-2xl font-bold text-[var(--color-text-primary)]">
            Forgot Password
          </h1>
          <p className="mt-2 text-sm text-[var(--color-text-secondary)]">
            Enter the email address associated with your account and we'll send you a link to reset your password.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-5">
          <FormField label="Email" id="reset-email">
            <Input
              id="reset-email"
              type="email"
              required
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="guard@earist.edu.ph"
              disabled={loading || countdown > 0}
            />
          </FormField>

          <p className="text-xs text-[var(--color-text-muted)]">
            Security note: For PKCE protection, please open the reset link in this same browser.
          </p>

          <TurnstileWidget key={turnstileKey} onVerify={setCaptchaToken} onExpire={() => setCaptchaToken(null)} />
          <Button
            type="submit"
            disabled={loading || countdown > 0}
            className="w-full"
            size="lg"
          >
            {loading ? 'Sending...' : countdown > 0 ? `Resend link in ${countdown}s` : 'Send Reset Link'}
          </Button>

          <div className="text-center pt-2">
            <Link to="/login" className="text-sm font-medium text-[var(--color-brand)] hover:underline focus:outline-none focus:ring-2 focus:ring-[var(--color-brand)] rounded-sm">
              Back to Sign In
            </Link>
          </div>
        </form>
      </Card>
    </main>
  );
}