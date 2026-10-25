import { useEffect, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Modal, Button } from './ui';

interface TimedSkipWarningModalProps {
  isOpen: boolean;
  onCancel: () => void;
  onConfirmSkip: () => void;
}

export function TimedSkipWarningModal({
  isOpen,
  onCancel,
  onConfirmSkip,
}: TimedSkipWarningModalProps) {
  const [countdown, setCountdown] = useState(5);

  useEffect(() => {
    if (!isOpen) {
      setCountdown(5);
      return;
    }

    setCountdown(5);
    const interval = setInterval(() => {
      setCountdown((prev) => {
        if (prev <= 1) {
          clearInterval(interval);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(interval);
  }, [isOpen]);

  return (
    <Modal
      isOpen={isOpen}
      onClose={onCancel}
      title="Continue Without Email"
      description="Important warning about continuing without providing an email address."
      size="sm"
      hideTitleRow
    >
      <div className="flex flex-col items-center text-center pt-2">
        <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-[var(--color-warning-light)] text-[var(--color-warning-dark)]">
          <AlertTriangle className="h-6 w-6" aria-hidden="true" />
        </div>
        <h2 className="mb-2 text-xl font-bold text-[var(--color-text-primary)]">
          Continue Without Email
        </h2>
        
        <div className="mb-6 text-sm text-[var(--color-text-secondary)] space-y-2 text-left">
          <p>
            You are continuing without an email address.
          </p>
          <p className="font-semibold text-[var(--color-text-primary)]">
            Your E-GatePass will only be available on this page.
          </p>
          <p>
            Do not refresh, close, or leave this page until you have downloaded or saved your QR code.
          </p>
          <p className="text-xs text-[var(--color-text-muted)]">
            If you lose this page, you may need to register again.
          </p>
        </div>

        <div className="sr-only" aria-live="polite">
          {countdown > 0 ? `Please wait ${countdown} seconds before continuing without an email.` : 'You can now choose to continue without an email.'}
        </div>

        <div className="flex w-full flex-col-reverse gap-3 sm:flex-row sm:justify-end">
          <Button
            type="button"
            variant="secondary"
            onClick={onCancel}
            className="w-full sm:w-auto flex-1"
          >
            Go Back
          </Button>
          <Button
            type="button"
            variant="primary"
            onClick={onConfirmSkip}
            disabled={countdown > 0}
            className="w-full sm:w-auto flex-1"
          >
            {countdown > 0 ? `Continue Without Email — ${countdown}` : 'Continue Without Email'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
