import { useState } from 'react';
import { updatePassword } from 'firebase/auth';
import { auth } from '@/lib/firebase';
import { Button, Card, Input, FormField, Modal } from '@/components/ui';
import { BrandMark } from '@/components/BrandMark';
import { toast } from 'sonner';
import { getPasswordPolicyError, PASSWORD_MIN_LENGTH } from '@/lib/passwordPolicy';

import { Eye, EyeOff } from 'lucide-react';

export function ForcePasswordChange() {
  const [showForm, setShowForm] = useState(false);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [showPasswords, setShowPasswords] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!currentPassword) {
      toast.error('Please enter your current temporary password');
      return;
    }
    if (!newPassword) {
      toast.error('Please enter a new password');
      return;
    }
    const passwordError = getPasswordPolicyError(newPassword);
    if (passwordError) {
      toast.error(passwordError);
      return;
    }
    if (newPassword !== confirmPassword) {
      toast.error('Passwords do not match');
      return;
    }

    setLoading(true);
    try {
      if (!auth.currentUser || !auth.currentUser.email) throw new Error('Not authenticated');

      // Re-authenticate first
      const { EmailAuthProvider, reauthenticateWithCredential } = await import('firebase/auth');
      const credential = EmailAuthProvider.credential(auth.currentUser.email, currentPassword);
      await reauthenticateWithCredential(auth.currentUser, credential);

      // Update password using client SDK
      await updatePassword(auth.currentUser, newPassword);

      // Call the Netlify function to clear the flag
      const token = await auth.currentUser.getIdToken(true);
      const res = await fetch('/.netlify/functions/clear-password-flag', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });

      if (!res.ok) {
        throw new Error('Failed to update server-side state. Please contact an administrator.');
      }

      toast.success('Password updated successfully. You can now continue using your account.');
      // After success, we want the app to reload or re-evaluate the auth state.
      // useAuth won't automatically re-run resolveRole unless we force it or reload the page.
      window.location.reload();
    } catch (err: any) {
      console.error(err);
      if (err.code === 'auth/wrong-password' || err.code === 'auth/invalid-credential') {
        toast.error('Incorrect current password.');
      } else if (err.code === 'auth/weak-password') {
        toast.error(`Password is too weak. Please use at least ${PASSWORD_MIN_LENGTH} characters.`);
      } else {
        toast.error(err.message || 'Failed to update password');
      }
    } finally {
      setLoading(false);
    }
  }

  if (!showForm) {
    return (
      <Modal
        isOpen={true}
        onClose={() => {}}
        preventClose={true}
        title="Password Change Required"
        description="Security Update"
      >
        <div className="space-y-6">
          <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-canvas)] p-4 text-center">
            <BrandMark size="sm" className="mx-auto" />
            <p className="mt-4 text-sm text-[var(--color-text-secondary)] text-left">
              Your account was created by an administrator using a temporary password. For your privacy and security, please create your own password before continuing.
            </p>
          </div>
          <Button
            onClick={() => setShowForm(true)}
            className="w-full"
            size="lg"
          >
            OK / Change Password
          </Button>
        </div>
      </Modal>
    );
  }

  return (
    <div className="flex min-h-dvh items-center justify-center bg-[var(--color-canvas)] p-4">
      <Card className="w-full max-w-md border-t-4 border-t-[var(--color-brand)] p-6">
        <div className="text-center mb-6">
          <BrandMark size="sm" className="mx-auto mb-4" />
          <h2 className="text-xl font-bold text-[var(--color-text-primary)]">
            Create New Password
          </h2>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <FormField label="Current Password" id="current-password">
            <div className="relative">
              <Input
                id="current-password"
                type={showPasswords ? "text" : "password"}
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                disabled={loading}
                autoComplete="current-password"
                placeholder="••••••••"
                className="pr-10"
              />
              <button
                type="button"
                onClick={() => setShowPasswords(!showPasswords)}
                className="absolute inset-y-0 right-0 flex min-w-11 items-center justify-center text-[var(--color-text-muted)] hover:text-[var(--color-brand)] focus:outline-none"
                aria-label={showPasswords ? 'Hide passwords' : 'Show passwords'}
              >
                {showPasswords ? <EyeOff className="h-5 w-5" /> : <Eye className="h-5 w-5" />}
              </button>
            </div>
          </FormField>

          <FormField label="New Password" id="new-password">
            <div className="relative">
              <Input
                id="new-password"
                type={showPasswords ? "text" : "password"}
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                disabled={loading}
                minLength={PASSWORD_MIN_LENGTH}
                autoComplete="new-password"
                placeholder="••••••••"
                className="pr-10"
              />
              <button
                type="button"
                onClick={() => setShowPasswords(!showPasswords)}
                className="absolute inset-y-0 right-0 flex min-w-11 items-center justify-center text-[var(--color-text-muted)] hover:text-[var(--color-brand)] focus:outline-none"
                aria-label={showPasswords ? 'Hide passwords' : 'Show passwords'}
              >
                {showPasswords ? <EyeOff className="h-5 w-5" /> : <Eye className="h-5 w-5" />}
              </button>
            </div>
            <p className="mt-1 text-xs text-[var(--color-text-muted)]">
              Use at least {PASSWORD_MIN_LENGTH} characters with a letter and a number.
            </p>
          </FormField>

          <FormField label="Confirm Password" id="confirm-password">
            <div className="relative">
              <Input
                id="confirm-password"
                type={showPasswords ? "text" : "password"}
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                disabled={loading}
                minLength={PASSWORD_MIN_LENGTH}
                autoComplete="new-password"
                placeholder="••••••••"
                className="pr-10"
              />
              <button
                type="button"
                onClick={() => setShowPasswords(!showPasswords)}
                className="absolute inset-y-0 right-0 flex min-w-11 items-center justify-center text-[var(--color-text-muted)] hover:text-[var(--color-brand)] focus:outline-none"
                aria-label={showPasswords ? 'Hide passwords' : 'Show passwords'}
              >
                {showPasswords ? <EyeOff className="h-5 w-5" /> : <Eye className="h-5 w-5" />}
              </button>
            </div>
          </FormField>

          <Button
            type="submit"
            loading={loading}
            className="w-full mt-4"
          >
            {loading ? 'Updating...' : 'Update Password'}
          </Button>
        </form>
      </Card>
    </div>
  );
}
