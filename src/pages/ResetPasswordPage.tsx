import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { BrandMark } from '@/components/BrandMark';
import { Button, Card, FormField, Input, LoadingState } from '@/components/ui';
import { getPasswordPolicyError, PASSWORD_MIN_LENGTH, PASSWORD_POLICY_HELPER_TEXT } from '@/lib/passwordPolicy';
import { supabase } from '@/lib/supabase';
import { resetPasswordWithRecoverySession } from '@/services/auth';

export function ResetPasswordPage() {
  const navigate = useNavigate();
  const [checking, setChecking] = useState(true);
  const [hasRecoverySession, setHasRecoverySession] = useState(false);
  const [recoveryToken, setRecoveryToken] = useState<string | null>(null);
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!supabase) {
      setChecking(false);
      return;
    }
    let active = true;

    const hash = window.location.hash || '';
    const search = window.location.search || '';
    const isErrorUrl = hash.includes('error=') || search.includes('error=');

    if (isErrorUrl) {
      setHasRecoverySession(false);
      setRecoveryToken(null);
      setChecking(false);
      return;
    }

    // Subscribe to auth state changes FIRST.
    // In Supabase Auth, clicking a genuine recovery link triggers onAuthStateChange with event === 'PASSWORD_RECOVERY'.
    // Browser storage (localStorage/sessionStorage) is NEVER used for recovery authority.
    // Mere URL query parameters (?type=recovery) or ordinary active staff/device/visitor sessions
    // MUST NEVER grant password reset authority.
    const { data } = supabase.auth.onAuthStateChange((event, session) => {
      if (!active) return;
      if (event === 'PASSWORD_RECOVERY' && session?.user && session?.access_token) {
        // Governance: Device and guest accounts cannot reset passwords via recovery
        const email = session.user.email ?? '';
        const isDevice = email.toLowerCase().endsWith('@devices.egatepass.invalid');
        const isGuest = session.user.is_anonymous === true;

        if (isDevice || isGuest) {
          setHasRecoverySession(false);
          setRecoveryToken(null);
          setChecking(false);
          toast.error('Device and guest accounts cannot reset passwords.');
          return;
        }

        setRecoveryToken(session.access_token);
        setHasRecoverySession(true);
        setChecking(false);
      } else if (event === 'SIGNED_OUT') {
        setHasRecoverySession(false);
        setRecoveryToken(null);
        setChecking(false);
      }
    });

    // Allow a brief window for onAuthStateChange to fire if PKCE exchange is in flight.
    // If no genuine recovery event was received, do NOT authorize based on existing session.
    const timer = setTimeout(() => {
      if (active) {
        setChecking(false);
      }
    }, 400);

    return () => {
      active = false;
      clearTimeout(timer);
      data.subscription.unsubscribe();
    };
  }, []);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    const policyError = getPasswordPolicyError(newPassword);
    if (policyError) return toast.error(policyError);
    if (newPassword !== confirmPassword) return toast.error('Passwords do not match.');
    if (!supabase || !hasRecoverySession || !recoveryToken) {
      return toast.error('This reset link is invalid or has expired.');
    }

    setLoading(true);
    try {
      await resetPasswordWithRecoverySession(recoveryToken, newPassword);
      await supabase.auth.signOut();
      toast.success('Password updated. Sign in with your new password.');
      navigate('/login', { replace: true });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Password could not be updated. Request a new reset link and try again.';
      toast.error(message);
    } finally {
      setLoading(false);
    }
  }

  if (checking) {
    return <main id="main-content" className="min-h-dvh bg-[var(--color-canvas)]"><LoadingState label="Checking reset link..." className="min-h-dvh" /></main>;
  }

  return (
    <main id="main-content" className="flex min-h-dvh items-center justify-center bg-[var(--color-canvas)] px-4 py-10">
      <Card className="w-full max-w-sm border-t-4 border-t-[var(--color-brand)] p-6 sm:p-8">
        <div className="mb-8 text-center">
          <BrandMark size="lg" className="mx-auto mb-4" />
          <p className="mb-2 text-xs font-bold uppercase tracking-widest text-[var(--color-brand)]">Account recovery</p>
          <h1 className="text-2xl font-bold text-[var(--color-text-primary)]">Create New Password</h1>
        </div>

        {!hasRecoverySession ? (
          <div className="space-y-5">
            <p className="rounded-lg border border-[var(--color-danger)] bg-[var(--color-danger-light)] px-4 py-3 text-sm text-[var(--color-danger-dark)]" role="alert">
              This password reset link is invalid or has expired. Request a new link to continue.
            </p>
            <Link to="/forgot-password" className="block text-center text-sm font-semibold text-[var(--color-brand)] hover:underline">Request a new reset link</Link>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-5">
            <FormField label="New Password" id="reset-new-password">
              <Input id="reset-new-password" type="password" autoComplete="new-password" minLength={PASSWORD_MIN_LENGTH} required value={newPassword} onChange={(event) => setNewPassword(event.target.value)} disabled={loading} />
              <p className="mt-1 text-xs text-[var(--color-text-muted)]">{PASSWORD_POLICY_HELPER_TEXT}</p>
            </FormField>
            <FormField label="Confirm Password" id="reset-confirm-password">
              <Input id="reset-confirm-password" type="password" autoComplete="new-password" minLength={PASSWORD_MIN_LENGTH} required value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} disabled={loading} />
            </FormField>
            <Button type="submit" className="w-full" size="lg" loading={loading}>Update Password</Button>
          </form>
        )}
      </Card>
    </main>
  );
}
