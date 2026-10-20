import { useState, useEffect } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { signInWithEmailAndPassword, sendEmailVerification, signOut } from 'firebase/auth';
import { doc, getDoc } from 'firebase/firestore';
import { auth, db } from '@/lib/firebase';
import { useAuth } from '@/hooks/useAuth';
import { Card, Button, Input, FormField } from '@/components/ui';
import { BrandMark } from '@/components/BrandMark';
import { Eye, EyeOff } from 'lucide-react';
import { toast } from 'sonner';

export function LoginPage() {
  const navigate = useNavigate();
  const { status, role } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [unverifiedEmail, setUnverifiedEmail] = useState('');
  const [unverifiedPassword, setUnverifiedPassword] = useState('');
  const [resendCooldown, setResendCooldown] = useState(0);

  useEffect(() => {
    if (resendCooldown > 0) {
      const timer = setTimeout(() => setResendCooldown(resendCooldown - 1), 1000);
      return () => clearTimeout(timer);
    }
  }, [resendCooldown]);

  useEffect(() => {
    if (status !== 'authenticated' || !role) return;
    const redirectMap: Record<string, string> = {
      admin: '/admin',
      superadmin: '/admin',
      guard: '/guard',
      entry: '/scan/entry',
      exit: '/scan/exit',
      kiosk: '/kiosk',
    };
    navigate(redirectMap[role] ?? '/login', { replace: true });
  }, [navigate, role, status]);

  async function handleResendVerification() {
    if (resendCooldown > 0 || !unverifiedEmail || !unverifiedPassword) return;
    setLoading(true);
    try {
      const userCred = await signInWithEmailAndPassword(auth, unverifiedEmail, unverifiedPassword);
      await sendEmailVerification(userCred.user);
      await signOut(auth);
      toast.success('Verification email resent. Please check your inbox.');
      setResendCooldown(60);
    } catch (err: any) {
      toast.error(err.message || 'Failed to resend verification email.');
    } finally {
      setLoading(false);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setUnverifiedEmail('');
    setUnverifiedPassword('');
    setLoading(true);

    try {
      const userCred = await signInWithEmailAndPassword(auth, email, password);
      await userCred.user.reload();
      
      const userDoc = await getDoc(doc(db, 'users', userCred.user.uid));
      if (userDoc.exists()) {
        const userData = userDoc.data();
        if ((userData.role === 'admin' || userData.role === 'superadmin' || userData.role === 'guard') && userData.active) {
          if (!auth.currentUser?.emailVerified) {
            await signOut(auth);
            setUnverifiedEmail(email);
            setUnverifiedPassword(password);
            const msg = 'Account not verified. Please verify your email first. Check your inbox, spam, or trash folder for the verification email.';
            setError(msg);
            toast.error(msg, { id: 'unverified-toast' });
            setLoading(false);
            return;
          }
          await auth.currentUser?.getIdToken(true);
        }
      }
      
      // onAuthStateChanged in AuthProvider handles role resolution and redirect
    } catch {
      setError('Invalid email, device username, or password. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <main id="main-content" className="flex min-h-dvh items-center justify-center bg-[var(--color-canvas)] px-4 py-10">
      <Card className="w-full max-w-sm border-t-4 border-t-[var(--color-brand)] p-6 sm:p-8">
        <div className="mb-8 text-center">
          <BrandMark size="lg" className="mx-auto mb-4" />
          <p className="mb-2 text-xs font-bold uppercase tracking-widest text-[var(--color-brand)]">Staff and device access</p>
          <h1 className="text-2xl font-bold text-[var(--color-text-primary)]">
            Sign In
          </h1>
          <p className="mt-1 text-sm text-[var(--color-text-secondary)]">
            EARIST E-GatePass Staff Portal
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-5">
          <FormField label="Email or Device Username" id="login-email">
            <Input
              id="login-email"
              type="email"
              required
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="guard@earist.edu.ph or device@earist-devices.local"
            />
          </FormField>

          <FormField label="Password" id="login-password">
            <div className="relative">
              <Input
                id="login-password"
                type={showPassword ? 'text' : 'password'}
                required
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                className="pr-10"
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute inset-y-0 right-0 flex min-w-11 items-center justify-center text-[var(--color-text-muted)] hover:text-[var(--color-brand)] focus:outline-none"
                aria-label={showPassword ? "Hide password" : "Show password"}
              >
                {showPassword ? (
                  <EyeOff className="h-5 w-5" />
                ) : (
                  <Eye className="h-5 w-5" />
                )}
              </button>
            </div>
          </FormField>

          {error && (
            <div className="flex flex-col gap-3 rounded-lg border border-[var(--color-danger)] bg-[var(--color-danger-light)] px-4 py-3 text-sm font-medium text-[var(--color-danger-dark)]">
              <p role="alert">{error}</p>
              {unverifiedEmail && (
                <Button
                  type="button"
                  variant="secondary"
                  onClick={handleResendVerification}
                  disabled={resendCooldown > 0 || loading}
                  className="w-full border-[var(--color-danger)] text-[var(--color-danger-dark)] hover:bg-white"
                >
                  {resendCooldown > 0 ? `Resend available in ${resendCooldown}s` : 'Resend Verification Email'}
                </Button>
              )}
            </div>
          )}

          <div className="flex justify-end mt-2">
            <Link to="/forgot-password" className="text-sm font-medium text-[var(--color-brand)] hover:underline focus:outline-none focus:ring-2 focus:ring-[var(--color-brand)] rounded-sm">
              Forgot password?
            </Link>
          </div>

          <Button
            type="submit"
            disabled={loading}
            className="w-full"
            size="lg"
          >
            {loading ? 'Signing in...' : 'Sign In'}
          </Button>
        </form>
      </Card>
    </main>
  );
}
