import { useState } from 'react';
import { sendPasswordResetEmail } from 'firebase/auth';
import { KeyRound, Mail } from 'lucide-react';
import { toast } from 'sonner';
import { auth } from '@/lib/firebase';
import { Button, Card } from '@/components/ui';

function errorMessage(error: unknown): string | undefined {
  return error instanceof Error ? error.message : undefined;
}

export function PasswordResetCard() {
  const [isSendingReset, setIsSendingReset] = useState(false);

  async function sendResetLink() {
    const user = auth.currentUser;
    if (!user?.email) {
      toast.error('Your account session has expired. Please sign in again.');
      return;
    }

    setIsSendingReset(true);
    try {
      await sendPasswordResetEmail(auth, user.email);
      toast.success(`A password reset link was sent to ${user.email}.`);
    } catch (error) {
      toast.error(errorMessage(error) || 'Could not send the password reset email.');
    } finally {
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

      <Button
        type="button"
        variant="secondary"
        onClick={sendResetLink}
        loading={isSendingReset}
        disabled={isSendingReset}
        icon={<Mail className="h-4 w-4" aria-hidden="true" />}
        className="mt-5 min-h-11 w-full"
      >
        {isSendingReset ? 'Sending Link...' : 'Email Me a Reset Link'}
      </Button>
    </Card>
  );
}
