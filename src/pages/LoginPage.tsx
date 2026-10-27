import { TurnstileWidget } from '@/components/TurnstileWidget';
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Eye, EyeOff } from 'lucide-react';
import { toast } from 'sonner';
import { useAuth } from '@/hooks/useAuth';
import { normalizeLoginIdentity } from '@/lib/identity';
import { evaluateAuthTurnstilePolicy } from '@/services/auth';
import { supabase } from '@/lib/supabase';
import { BrandMark } from '@/components/BrandMark';
import { Button, Card, FormField, Input } from '@/components/ui';

export function LoginPage() {
  const navigate = useNavigate();
  const { status, role, serviceStatus, serviceMessage } = useAuth();
  const [identity, setIdentity] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isSigningIn, setIsSigningIn] = useState(false);
  const [isResendingVerification, setIsResendingVerification] = useState(false);
  const [unverifiedEmail, setUnverifiedEmail] = useState('');
  const [resendCooldown, setResendCooldown] = useState(0);
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const [turnstileKey, setTurnstileKey] = useState(0);

  function resetTurnstile() {
    setCaptchaToken(null);
    setTurnstileKey((k) => k + 1);
  }

  useEffect(() => {
    if (resendCooldown <= 0) return;
    const timer = window.setTimeout(() => setResendCooldown((value) => value - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [resendCooldown]);

  useEffect(() => {
    if ((status !== 'authenticated' && status !== 'requires_password_change') || !role) return;
    const redirectMap: Record<string, string> = {
      admin: '/admin', superadmin: '/admin', guard: '/guard', entry: '/scan/entry', exit: '/scan/exit', kiosk: '/kiosk',
    };
    navigate(redirectMap[role] ?? '/login', { replace: true });
  }, [navigate, role, status]);

  async function handleResendVerification() {
    if (!supabase || resendCooldown > 0 || !unverifiedEmail || isSigningIn || isResendingVerification) return;
    const siteKey = (import.meta as any).env?.VITE_TURNSTILE_SITE_KEY?.trim();
    const isProd = Boolean((import.meta as any).env?.PROD);
    const policy = evaluateAuthTurnstilePolicy(isProd, siteKey, captchaToken);
    if (!policy.allowed) {
      toast.error(policy.error ?? 'Please complete the security challenge.');
      return;
    }
    setIsResendingVerification(true);
    try {
      const { error: resendError } = await supabase.auth.resend({
        type: 'signup',
        email: unverifiedEmail,
        options: captchaToken ? { captchaToken } : undefined,
      });
      if (resendError) throw resendError;
      toast.success('Verification email resent. Please check your inbox.');
      setResendCooldown(60);
    } catch {
      toast.error('We could not resend the verification email. Please try again later.');
    } finally {
      resetTurnstile();
      setIsResendingVerification(false);
    }
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (isSigningIn || isResendingVerification) return;
    setError(null);
    setUnverifiedEmail('');
    if (!supabase || serviceStatus === 'unavailable') {
      setError(serviceMessage ?? 'Staff and device services are unavailable.');
      return;
    }

    const normalized = normalizeLoginIdentity(identity);
    if (!normalized.ok) {
      setError(normalized.message);
      return;
    }

    const siteKey = (import.meta as any).env?.VITE_TURNSTILE_SITE_KEY?.trim();
    const isProd = Boolean((import.meta as any).env?.PROD);
    const policy = evaluateAuthTurnstilePolicy(isProd, siteKey, captchaToken);
    if (!policy.allowed) {
      setError(policy.error ?? 'Please complete the security challenge before signing in.');
      return;
    }

    setIsSigningIn(true);
    try {
      const { data, error: signInError } = await supabase.auth.signInWithPassword({
        email: normalized.email,
        password,
        options: captchaToken ? { captchaToken } : undefined,
      });
      if (signInError) throw signInError;
      if (data.user && !data.user.is_anonymous && !data.user.email_confirmed_at && identity.includes('@')) {
        setUnverifiedEmail(normalized.email);
        await supabase.auth.signOut();
        setError('Account not verified. Please verify your email first. Check your inbox, spam, or trash folder for the verification email.');
      }
    } catch (signInError: unknown) {
      const code = typeof signInError === 'object' && signInError !== null && 'code' in signInError
        ? String(signInError.code)
        : '';
      if (code === 'email_not_confirmed' && identity.includes('@')) {
        setUnverifiedEmail(normalized.email);
        setError('Account not verified. Please verify your email first. Check your inbox, spam, or trash folder for the verification email.');
      } else {
        setError('Invalid email, device username, or password. Please try again.');
      }
    } finally {
      resetTurnstile();
      setIsSigningIn(false);
    }
  }

  return (
    <main id="main-content" className="flex min-h-dvh items-center justify-center bg-[var(--color-canvas)] px-4 py-10">
      <Card className="w-full max-w-sm border-t-4 border-t-[var(--color-brand)] p-6 sm:p-8">
        <div className="mb-8 text-center">
          <BrandMark size="lg" className="mx-auto mb-4" />
          <p className="mb-2 text-xs font-bold uppercase tracking-widest text-[var(--color-brand)]">Staff and device access</p>
          <h1 className="text-2xl font-bold text-[var(--color-text-primary)]">Sign In</h1>
          <p className="mt-1 text-sm text-[var(--color-text-secondary)]">EARIST E-GatePass Staff Portal</p>
        </div>

        {serviceStatus === 'unavailable' && (
          <div className="mb-5 rounded-lg border border-[var(--color-warning)] bg-[var(--color-warning-light)] px-4 py-3 text-sm text-[var(--color-text-primary)]" role="status">
            {serviceMessage}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-5">
          <FormField label="Email or Device Username" id="login-email">
            <Input id="login-email" type="text" required autoComplete="username" value={identity} onChange={(event) => setIdentity(event.target.value)} placeholder="guard@earist.edu.ph or gate-kiosk-01" disabled={isSigningIn || isResendingVerification || serviceStatus === 'unavailable'} />
          </FormField>
          <FormField label="Password" id="login-password">
            <div className="relative">
              <Input id="login-password" type={showPassword ? 'text' : 'password'} required autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="••••••••" className="pr-10 app-password-toggle-input" disabled={isSigningIn || isResendingVerification || serviceStatus === 'unavailable'} />
              <button type="button" onClick={() => setShowPassword((value) => !value)} className="absolute inset-y-0 right-0 flex min-w-11 items-center justify-center text-[var(--color-text-muted)] hover:text-[var(--color-brand)]" aria-label={showPassword ? 'Hide password' : 'Show password'}>
                {showPassword ? <EyeOff className="h-5 w-5" /> : <Eye className="h-5 w-5" />}
              </button>
            </div>
          </FormField>
          {error && (
            <div className="flex flex-col gap-3 rounded-lg border border-[var(--color-danger)] bg-[var(--color-danger-light)] px-4 py-3 text-sm font-medium text-[var(--color-danger-dark)]">
              <p role="alert">{error}</p>
              {unverifiedEmail && <Button type="button" variant="secondary" onClick={handleResendVerification} loading={isResendingVerification} disabled={resendCooldown > 0 || isSigningIn || isResendingVerification} className="w-full">{isResendingVerification ? 'Sending…' : resendCooldown > 0 ? `Resend available in ${resendCooldown}s` : 'Resend Verification Email'}</Button>}
            </div>
          )}
          <div className="mt-2 flex justify-end"><Link to="/forgot-password" className="rounded-sm text-sm font-medium text-[var(--color-brand)] hover:underline">Forgot password?</Link></div>
          <TurnstileWidget key={turnstileKey} onVerify={setCaptchaToken} onExpire={() => setCaptchaToken(null)} />
          <Button type="submit" loading={isSigningIn} disabled={isSigningIn || isResendingVerification || serviceStatus === 'unavailable'} className="w-full" size="lg">{isSigningIn ? 'Signing in…' : 'Sign In'}</Button>
        </form>
      </Card>
    </main>
  );
}
