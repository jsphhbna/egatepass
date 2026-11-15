import { TurnstileWidget } from '@/components/TurnstileWidget';
import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { Eye, EyeOff, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';
import { useAuth } from '@/hooks/useAuth';
import { normalizeLoginIdentity } from '@/lib/identity';
import { getDefaultHomeForRole } from '@/lib/permissions';
import { evaluateAuthTurnstilePolicy } from '@/services/auth';
import { supabase } from '@/lib/supabase';
import { BrandMark } from '@/components/BrandMark';
import { Button, Card, FormField, Input } from '@/components/ui';
import { TotpEnrollModal } from '@/components/auth/TotpEnrollModal';
import type { AuthRole } from '@/types';

export function LoginPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const { status, role, requiresMfa, serviceStatus, serviceMessage } = useAuth();
  const idleTimeoutNotice = new URLSearchParams(location.search).get('reason') === 'idle_timeout';
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

  // MFA state
  const [mfaStep, setMfaStep] = useState<'none' | 'challenge' | 'enroll'>('none');
  const [totpFactorId, setTotpFactorId] = useState<string | null>(null);
  const [totpCode, setTotpCode] = useState('');
  const [isVerifyingTotp, setIsVerifyingTotp] = useState(false);
  const [totpError, setTotpError] = useState<string | null>(null);
  const [pendingRole, setPendingRole] = useState<AuthRole | null>(null);

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
    if (role === 'guard') {
      void supabase?.auth.signOut();
      setError('This legacy Guard account is disabled. Gate monitoring now uses a Guard Station device.');
      return;
    }

    // Do not redirect human staff who have not yet satisfied MFA (aal2)
    const isHumanStaff = ['admin', 'superadmin', 'office_staff'].includes(role);
    if (isHumanStaff && requiresMfa) {
      return;
    }

    navigate(getDefaultHomeForRole(role), { replace: true });
  }, [navigate, role, status, requiresMfa]);

  // If already authenticated at aal1, trigger MFA step automatically
  useEffect(() => {
    if (
      status === 'authenticated' &&
      role &&
      ['admin', 'superadmin', 'office_staff'].includes(role) &&
      requiresMfa &&
      mfaStep === 'none'
    ) {
      void (async () => {
        if (!supabase) return;
        try {
          const { data: factorsData } = await supabase.auth.mfa.listFactors();
          const verifiedTotp = factorsData?.totp?.find((f) => f.status === 'verified');
          if (verifiedTotp) {
            setTotpFactorId(verifiedTotp.id);
            setMfaStep('challenge');
          } else {
            setMfaStep('enroll');
          }
        } catch {
          // If factors check fails, default to enrollment
          setMfaStep('enroll');
        }
      })();
    }
  }, [status, role, requiresMfa, mfaStep]);

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
      if (data.user && !data.user.is_anonymous) {
        if (!data.user.email_confirmed_at && identity.includes('@')) {
          setUnverifiedEmail(normalized.email);
          await supabase.auth.signOut();
          setError('Account not verified. Please verify your email first. Check your inbox, spam, or trash folder for the verification email.');
          return;
        }
        const { data: staff } = await supabase
          .from('staff_profiles')
          .select('role')
          .eq('user_id', data.user.id)
          .maybeSingle();
        if (staff?.role === 'guard') {
          await supabase.auth.signOut();
          setError('This legacy Guard account is disabled. Gate monitoring now uses a Guard Station device.');
          return;
        }

        // Check MFA for human staff roles
        if (staff && ['admin', 'superadmin', 'office_staff'].includes(staff.role)) {
          setPendingRole(staff.role as AuthRole);
          const { data: aalData } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
          if (aalData?.currentLevel !== 'aal2') {
            const { data: factorsData } = await supabase.auth.mfa.listFactors();
            const verifiedTotp = factorsData?.totp?.find((f) => f.status === 'verified');
            if (verifiedTotp) {
              setTotpFactorId(verifiedTotp.id);
              setMfaStep('challenge');
              return;
            } else {
              setMfaStep('enroll');
              return;
            }
          }
        }
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

  async function handleChallengeVerify(e: React.FormEvent) {
    e.preventDefault();
    if (!supabase || !totpFactorId || isVerifyingTotp) return;

    const trimmed = totpCode.trim();
    if (trimmed.length !== 6 || !/^\d{6}$/.test(trimmed)) {
      setTotpError('Please enter a valid 6-digit authentication code.');
      return;
    }

    setIsVerifyingTotp(true);
    setTotpError(null);

    try {
      const { error: verifyError } = await supabase.auth.mfa.challengeAndVerify({
        factorId: totpFactorId,
        code: trimmed,
      });

      if (verifyError) {
        const { data: challengeData, error: challengeError } = await supabase.auth.mfa.challenge({
          factorId: totpFactorId,
        });
        if (challengeError) throw challengeError;

        const { error: secondVerifyError } = await supabase.auth.mfa.verify({
          factorId: totpFactorId,
          challengeId: challengeData.id,
          code: trimmed,
        });
        if (secondVerifyError) throw secondVerifyError;
      }

      toast.success('Authentication code verified.');
      setMfaStep('none');
      const targetRole = role || pendingRole;
      if (targetRole) {
        navigate(getDefaultHomeForRole(targetRole), { replace: true });
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Invalid authenticator code. Please try again.';
      setTotpError(msg);
    } finally {
      setIsVerifyingTotp(false);
    }
  }

  async function handleMfaCancel() {
    setMfaStep('none');
    setTotpCode('');
    setTotpError(null);
    setTotpFactorId(null);
    setPendingRole(null);
    if (supabase) {
      await supabase.auth.signOut();
    }
  }

  return (
    <main id="main-content" className="flex min-h-dvh items-center justify-center bg-[var(--color-canvas)] px-4 py-10">
      <Card className="w-full max-w-sm border-t-4 border-t-[var(--color-brand)] p-6 sm:p-8">
        <div className="mb-8 text-center">
          <BrandMark size="lg" className="mx-auto mb-4" />
          <p className="mb-2 text-xs font-bold uppercase tracking-widest text-[var(--color-brand)]">Staff and device access</p>
          <h1 className="text-2xl font-bold text-[var(--color-text-primary)]">
            {mfaStep === 'challenge' ? 'Two-Factor Challenge' : 'Sign In'}
          </h1>
          <p className="mt-1 text-sm text-[var(--color-text-secondary)]">EARIST E-GatePass Staff Portal</p>
        </div>

        {idleTimeoutNotice && (
          <div className="mb-5 rounded-lg border border-[var(--color-warning)] bg-[var(--color-warning-light)] px-4 py-3 text-sm text-[var(--color-text-primary)]" role="status">
            Your staff session was signed out after 15 minutes of inactivity. Please sign in again.
          </div>
        )}

        {serviceStatus === 'unavailable' && (
          <div className="mb-5 rounded-lg border border-[var(--color-warning)] bg-[var(--color-warning-light)] px-4 py-3 text-sm text-[var(--color-text-primary)]" role="status">
            {serviceMessage}
          </div>
        )}

        {mfaStep === 'challenge' ? (
          <form onSubmit={handleChallengeVerify} className="space-y-5">
            <div className="flex items-center gap-2 rounded-lg bg-[var(--color-brand-light)] p-3 text-xs text-[var(--color-brand)]">
              <ShieldCheck className="h-5 w-5 shrink-0" />
              <span>Enter the 6-digit verification code from your authenticator app.</span>
            </div>

            <FormField label="Authenticator Code" id="totp-code" requirement="required" error={totpError ?? undefined}>
              <Input
                id="totp-code"
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                maxLength={6}
                autoComplete="one-time-code"
                value={totpCode}
                onChange={(e) => {
                  setTotpError(null);
                  setTotpCode(e.target.value.replace(/\D/g, '').slice(0, 6));
                }}
                placeholder="000000"
                className="text-center font-mono text-xl tracking-widest"
                autoFocus
                disabled={isVerifyingTotp}
              />
            </FormField>

            <div className="flex flex-col gap-2 pt-2">
              <Button type="submit" loading={isVerifyingTotp} disabled={isVerifyingTotp || totpCode.length !== 6} className="w-full" size="lg">
                {isVerifyingTotp ? 'Verifying…' : 'Verify & Continue'}
              </Button>
              <Button type="button" variant="secondary" onClick={handleMfaCancel} disabled={isVerifyingTotp} className="w-full">
                Sign Out / Cancel
              </Button>
            </div>
          </form>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-5">
            <FormField label="Email or Device Username" id="login-email" requirement="required">
              <Input id="login-email" type="text" required aria-required="true" autoComplete="username" value={identity} onChange={(event) => setIdentity(event.target.value)} placeholder="admin@earist.edu.ph or gate-kiosk-01" disabled={isSigningIn || isResendingVerification || serviceStatus === 'unavailable'} />
            </FormField>
            <FormField label="Password" id="login-password" requirement="required">
              <div className="relative">
                <Input id="login-password" type={showPassword ? 'text' : 'password'} required aria-required="true" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="••••••••" className="pr-10 app-password-toggle-input" disabled={isSigningIn || isResendingVerification || serviceStatus === 'unavailable'} />
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
        )}
      </Card>

      <TotpEnrollModal
        isOpen={mfaStep === 'enroll'}
        onEnrolled={() => {
          setMfaStep('none');
          const targetRole = role || pendingRole;
          if (targetRole) {
            navigate(getDefaultHomeForRole(targetRole), { replace: true });
          }
        }}
        onCancel={handleMfaCancel}
      />
    </main>
  );
}
