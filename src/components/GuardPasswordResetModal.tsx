import { useEffect, useState } from 'react';
import { sendPasswordResetEmail } from 'firebase/auth';
import { Mail } from 'lucide-react';
import { auth } from '@/lib/firebase';
import { Button, Modal } from '@/components/ui';
import { toast } from 'sonner';

const RESEND_COOLDOWN_MS = 60_000;
const LAST_SENT_STORAGE_KEY = 'e-gatepass-guard-password-reset-sent-at';

interface GuardPasswordResetModalProps {
  isOpen: boolean;
  email: string;
  onClose: () => void;
}

function storageKeyFor(email: string): string {
  return `${LAST_SENT_STORAGE_KEY}:${email.trim().toLowerCase()}`;
}

function storedLastSentAt(email: string): number {
  const value = Number(window.localStorage.getItem(storageKeyFor(email)));
  return Number.isFinite(value) ? value : 0;
}

export function GuardPasswordResetModal({ isOpen, email, onClose }: GuardPasswordResetModalProps) {
  const [sending, setSending] = useState(false);
  const [lastSentAt, setLastSentAt] = useState(() => storedLastSentAt(email));
  const [now, setNow] = useState(Date.now());
  const secondsRemaining = Math.max(0, Math.ceil((lastSentAt + RESEND_COOLDOWN_MS - now) / 1000));

  useEffect(() => {
    setLastSentAt(storedLastSentAt(email));
    setNow(Date.now());
  }, [email]);

  useEffect(() => {
    if (secondsRemaining <= 0) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [secondsRemaining]);

  async function handleSendResetLink() {
    if (!email || secondsRemaining > 0) return;
    setSending(true);
    try {
      await sendPasswordResetEmail(auth, email);
      const sentAt = Date.now();
      window.localStorage.setItem(storageKeyFor(email), String(sentAt));
      setLastSentAt(sentAt);
      setNow(sentAt);
      toast.success('Password reset link sent. Check your inbox and spam folder.');
    } catch (error) {
      console.error('Password reset email failed:', error);
      toast.error('We could not send the reset link. Please try again.');
    } finally {
      setSending(false);
    }
  }

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Reset Password"
      description="Send a secure password reset link to your account email"
      size="sm"
      preventClose={sending}
    >
      <div className="space-y-5">
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-[var(--color-brand-light)] text-[var(--color-brand)]">
          <Mail className="h-6 w-6" aria-hidden="true" />
        </div>
        <div>
          <p className="text-sm leading-relaxed text-[var(--color-text-secondary)]">
            We will email a secure reset link to:
          </p>
          <p className="mt-2 break-all text-sm font-semibold text-[var(--color-text-primary)]">{email}</p>
          <p className="mt-3 text-xs leading-relaxed text-[var(--color-text-muted)]">
            Your current password stays active until you complete the reset from the email.
          </p>
        </div>
        <Button
          type="button"
          onClick={handleSendResetLink}
          loading={sending}
          disabled={!email || secondsRemaining > 0}
          className="w-full"
          icon={<Mail className="h-4 w-4" />}
        >
          {secondsRemaining > 0 ? `Resend in ${secondsRemaining}s` : 'Email Me a Reset Link'}
        </Button>
      </div>
    </Modal>
  );
}
