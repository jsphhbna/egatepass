import { useState } from 'react';
import { KeyRound, Lock } from 'lucide-react';
import { toast } from 'sonner';
import { useAuth } from '@/hooks/useAuth';
import { Button, Card, FormField, Input } from '@/components/ui';
import { getPasswordPolicyError, PASSWORD_POLICY_HELPER_TEXT, PASSWORD_MIN_LENGTH } from '@/lib/passwordPolicy';
import { requireSupabase } from '@/lib/supabase';

export function PasswordResetCard() {
  const { userData } = useAuth();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [isUpdating, setIsUpdating] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const policyError = newPassword ? getPasswordPolicyError(newPassword) : null;
  const passwordsMismatch = confirmPassword && newPassword !== confirmPassword;

  async function handlePasswordChange(e: React.FormEvent) {
    e.preventDefault();
    setErrorMsg(null);

    const email = userData && 'email' in userData && typeof userData.email === 'string' ? userData.email : '';
    if (!email) {
      toast.error('Session expired. Please sign in again.');
      return;
    }

    if (!currentPassword) {
      setErrorMsg('Please enter your current password.');
      return;
    }

    if (policyError) {
      setErrorMsg(policyError);
      return;
    }

    if (newPassword !== confirmPassword) {
      setErrorMsg('New password and confirmation do not match.');
      return;
    }

    if (currentPassword === newPassword) {
      setErrorMsg('New password must be different from your current password.');
      return;
    }

    setIsUpdating(true);
    try {
      const client = requireSupabase();

      // 1. Verify current credentials
      const { error: signInError } = await client.auth.signInWithPassword({
        email,
        password: currentPassword,
      });

      if (signInError) {
        throw new Error('Current password is incorrect. Please check your password and try again.');
      }

      // 2. Update to new password
      const { error: updateError } = await client.auth.updateUser({
        password: newPassword,
      });

      if (updateError) {
        throw updateError;
      }

      toast.success('Your password has been changed successfully.');
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      setErrorMsg(null);
    } catch (err: any) {
      const message = err?.message || 'Failed to update password. Please try again.';
      setErrorMsg(message);
      toast.error(message);
    } finally {
      setIsUpdating(false);
    }
  }

  return (
    <Card className="p-6">
      <div className="flex items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[var(--color-brand-light)] text-[var(--color-brand)]">
          <KeyRound className="h-5 w-5" aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="text-xl font-bold text-[var(--color-text-primary)]">Change Password</h2>
          <p className="mt-1 text-sm leading-relaxed text-[var(--color-text-secondary)]">
            Update your account password securely. You must confirm your current password before saving a new one.
          </p>
        </div>
      </div>

      <form onSubmit={handlePasswordChange} className="mt-6 space-y-4">
        {errorMsg && (
          <div role="alert" className="rounded-xl border border-[var(--color-danger-border)] bg-[var(--color-danger-light)] p-3 text-xs text-[var(--color-danger-dark)]">
            {errorMsg}
          </div>
        )}

        <FormField label="Current Password" id="current-password" requirement="required">
          <Input
            id="current-password"
            type="password"
            autoComplete="current-password"
            value={currentPassword}
            onChange={(e) => {
              setCurrentPassword(e.target.value);
              setErrorMsg(null);
            }}
            placeholder="Enter current password"
            required
            disabled={isUpdating}
          />
        </FormField>

        <FormField label="New Password" id="new-password" requirement="required">
          <Input
            id="new-password"
            type="password"
            autoComplete="new-password"
            value={newPassword}
            onChange={(e) => {
              setNewPassword(e.target.value);
              setErrorMsg(null);
            }}
            placeholder={`At least ${PASSWORD_MIN_LENGTH} characters`}
            minLength={PASSWORD_MIN_LENGTH}
            required
            disabled={isUpdating}
          />
          <p className="mt-1 text-xs text-[var(--color-text-muted)]">
            {PASSWORD_POLICY_HELPER_TEXT}
          </p>
          {policyError && (
            <p className="mt-1 text-xs text-[var(--color-danger)] font-medium">
              {policyError}
            </p>
          )}
        </FormField>

        <FormField label="Confirm New Password" id="confirm-password" requirement="required">
          <Input
            id="confirm-password"
            type="password"
            autoComplete="new-password"
            value={confirmPassword}
            onChange={(e) => {
              setConfirmPassword(e.target.value);
              setErrorMsg(null);
            }}
            placeholder="Re-enter new password"
            minLength={PASSWORD_MIN_LENGTH}
            required
            disabled={isUpdating}
          />
          {passwordsMismatch && (
            <p className="mt-1 text-xs text-[var(--color-danger)] font-medium">
              Passwords do not match.
            </p>
          )}
        </FormField>

        <div className="pt-2">
          <Button
            type="submit"
            variant="primary"
            className="w-full bg-[#7A0A0A] hover:bg-[#600808] text-white font-bold h-11"
            loading={isUpdating}
            disabled={
              isUpdating ||
              !currentPassword ||
              !newPassword ||
              !confirmPassword ||
              Boolean(policyError) ||
              Boolean(passwordsMismatch)
            }
            icon={<Lock className="h-4 w-4" />}
          >
            {isUpdating ? 'Updating Password...' : 'Save New Password'}
          </Button>
        </div>
      </form>
    </Card>
  );
}

export default PasswordResetCard;
