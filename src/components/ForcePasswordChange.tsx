import { useState } from 'react';
import { completeStaffPasswordChange } from '@/services/auth';
import { Button, Card, Input, FormField, Modal } from '@/components/ui';
import { BrandMark } from '@/components/BrandMark';
import { toast } from 'sonner';
import { getPasswordPolicyError, PASSWORD_MIN_LENGTH } from '@/lib/passwordPolicy';

import { useAuth } from '@/hooks/useAuth';
import { supabase } from '@/lib/supabase';
import { Eye, EyeOff } from 'lucide-react';

export function ForcePasswordChange() {
  const { refresh } = useAuth();
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
      await completeStaffPasswordChange(currentPassword, newPassword);

      if (supabase) {
        await supabase.auth.refreshSession();
        const { data: { user } } = await supabase.auth.getUser();
        if (user) {
          const { data: profile, error } = await supabase
            .from('staff_profiles')
            .select('must_change_password')
            .eq('user_id', user.id)
            .maybeSingle();
          if (error || (profile && profile.must_change_password !== false)) {
            throw new Error('Password change verification failed. Please try signing in again.');
          }
        }
      }

      toast.success('Password updated successfully. You can now continue using your account.');
      if (refresh) {
        await refresh();
      }
      try {
        window.location.reload();
      } catch {
        // Safe for test environments where window.location.reload is not implemented
      }
    } catch (err: any) {
      console.error(err);
      toast.error(err instanceof Error ? err.message : 'Failed to update password');
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
