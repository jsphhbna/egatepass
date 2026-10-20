import { useEffect, useRef, useState } from 'react';
import { Mail, CheckCircle2, AlertCircle, ArrowLeft } from 'lucide-react';
import { toast } from 'sonner';
import { Modal, FormField, Input, Button } from '@/components/ui';
import { requirePortalSupabase, requireSupabase } from '@/lib/supabase';

interface EmailPassModalProps {
  isOpen: boolean;
  onClose: () => void;
  passId: string;
  qrToken: string;
  source: 'portal' | 'kiosk';
}

export function EmailPassModal({
  isOpen,
  onClose,
  passId,
  qrToken,
  source,
}: EmailPassModalProps) {
  function friendlyEmailError(codeOrMessage: string | undefined, fallback: string): string {
    const messages: Record<string, string> = {
      invalid_code: 'That verification code is incorrect.',
      code_expired: 'That verification code has expired. Request a new code.',
      max_attempts_exceeded: 'Too many incorrect attempts. Request a new code.',
      too_many_requests: 'Too many email requests. Please wait before trying again.',
      email_service_unconfigured: 'Email delivery is currently unavailable.',
      email_state_unavailable: 'Email delivery state is temporarily unavailable. Your issued pass is unaffected.',
      recipient_mismatch: 'The email address no longer matches this verification request.',
      idempotency_key_mismatch: 'This email operation no longer matches the original request. Start again.',
      dispatch_in_progress: 'An email submission is already in progress. Do not submit again.',
      verification_delivery_failed: 'The provider rejected the verification email. Try a new code request.',
      email_delivery_failed: 'The provider rejected the QR email. Your issued pass is still available.',
    };
    return codeOrMessage ? (messages[codeOrMessage] ?? codeOrMessage) : fallback;
  }

  const [step, setStep] = useState<'input' | 'verify' | 'sent' | 'unknown'>('input');
  const [recipientEmail, setRecipientEmail] = useState('');
  const [consent, setConsent] = useState(false);
  const [code, setCode] = useState('');
  const [verificationId, setVerificationId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const requestCodeRequestIdRef = useRef(crypto.randomUUID());
  const sendRequestIdRef = useRef(crypto.randomUUID());

  useEffect(() => {
    setStep('input');
    setRecipientEmail('');
    setConsent(false);
    setCode('');
    setVerificationId(null);
    setLoading(false);
    setErrorMessage(null);
    requestCodeRequestIdRef.current = crypto.randomUUID();
    sendRequestIdRef.current = crypto.randomUUID();
  }, [passId, qrToken, source]);

  function resetState() {
    setStep('input');
    setRecipientEmail('');
    setConsent(false);
    setCode('');
    setVerificationId(null);
    setLoading(false);
    setErrorMessage(null);
    requestCodeRequestIdRef.current = crypto.randomUUID();
    sendRequestIdRef.current = crypto.randomUUID();
  }

  function handleClose() {
    resetState();
    onClose();
  }

  async function getClientToken(): Promise<string> {
    const client = source === 'portal' ? requirePortalSupabase() : requireSupabase();
    const { data: { session } } = await client.auth.getSession();
    if (!session?.access_token) {
      throw new Error('Your session has expired. Please refresh the page.');
    }
    return session.access_token;
  }

  async function handleRequestCode(e: React.FormEvent) {
    e.preventDefault();
    setErrorMessage(null);

    const email = recipientEmail.trim().toLowerCase();
    if (!email || !/^\S+@\S+\.\S+$/.test(email)) {
      setErrorMessage('Please enter a valid email address.');
      return;
    }
    if (!consent) {
      setErrorMessage('Please confirm your consent to receive the pass via email.');
      return;
    }

    setLoading(true);
    try {
      const token = await getClientToken();
      const res = await fetch('/api/passes/email', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          action: 'request_code',
          passId,
          qrToken,
          recipientEmail: email,
          consent: true,
          requestId: requestCodeRequestIdRef.current,
        }),
      });

      const data = await res.json().catch(() => null) as {
        verificationId?: string;
        error?: string;
        message?: string;
        status?: string;
        retryAllowed?: boolean;
      } | null;
      if (!res.ok || !data?.verificationId) {
        if (data?.retryAllowed) requestCodeRequestIdRef.current = crypto.randomUUID();
        throw new Error(data?.message || friendlyEmailError(data?.error, 'Failed to send verification code.'));
      }

      setVerificationId(data.verificationId);
      setStep('verify');
      toast.success('Verification code submitted to the email provider. Check your inbox.');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not send verification code.';
      setErrorMessage(message);
      toast.error(message);
    } finally {
      setLoading(false);
    }
  }

  async function handleVerifyAndSend(e: React.FormEvent) {
    e.preventDefault();
    setErrorMessage(null);

    const cleanCode = code.trim();
    if (!cleanCode || !/^\d{6}$/.test(cleanCode)) {
      setErrorMessage('Please enter the 6-digit verification code.');
      return;
    }
    if (!verificationId) {
      setErrorMessage('Verification session lost. Please request a new code.');
      setStep('input');
      return;
    }

    setLoading(true);
    try {
      const token = await getClientToken();
      const res = await fetch('/api/passes/email', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          action: 'verify_and_send',
          passId,
          qrToken,
          recipientEmail: recipientEmail.trim().toLowerCase(),
          verificationId,
          code: cleanCode,
          requestId: sendRequestIdRef.current,
        }),
      });

      const data = await res.json().catch(() => null) as {
        success?: boolean;
        error?: string;
        message?: string;
        status?: string;
        retryAllowed?: boolean;
      } | null;
      if (res.status === 202 || data?.status === 'outcome_unknown') {
        setStep('unknown');
        toast.error(data?.message || 'Email submission outcome is unknown. Do not retry automatically.');
        return;
      }
      if (!res.ok || !data?.success) {
        if (data?.retryAllowed) sendRequestIdRef.current = crypto.randomUUID();
        throw new Error(data?.message || friendlyEmailError(data?.error, 'Verification failed.'));
      }

      setStep('sent');
      toast.success('Gate Pass QR submitted to the email provider. Check your inbox.');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Verification failed.';
      setErrorMessage(message);
      toast.error(message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <Modal
      isOpen={isOpen}
      onClose={handleClose}
      title={step === 'sent' ? 'QR Code Submitted' : step === 'unknown' ? 'Submission Pending Review' : 'Email My QR Code'}
      description={
        step === 'input'
          ? 'Enter your email address to receive a secure copy of your digital pass.'
          : step === 'verify'
          ? 'Enter the 6-digit code submitted to the email provider to confirm your address.'
          : step === 'sent'
          ? 'Your pass QR code was submitted to the email provider. Check your inbox.'
          : 'The provider outcome could not be confirmed. Your issued pass is still available below.'
      }
      size="sm"
      preventClose={loading}
    >
      {errorMessage && (
        <div className="mb-4 flex items-start gap-2.5 rounded-lg border border-[var(--color-danger)] bg-[var(--color-danger-light)] p-3 text-xs font-medium text-[var(--color-danger-dark)]" role="alert">
          <AlertCircle className="h-4 w-4 shrink-0 text-[var(--color-danger)]" />
          <span>{errorMessage}</span>
        </div>
      )}

      {step === 'input' && (
        <form onSubmit={handleRequestCode} className="space-y-4">
          <FormField label="Recipient Email" id="recipient-email" hint="We will send a 6-digit verification code to this address.">
            <Input
              id="recipient-email"
              type="email"
              value={recipientEmail}
              onChange={(e) => setRecipientEmail(e.target.value)}
              placeholder="visitor@example.com"
              required
              autoFocus
            />
          </FormField>

          <label className="flex items-start gap-2.5 text-xs text-[var(--color-text-secondary)]">
            <input
              type="checkbox"
              checked={consent}
              onChange={(e) => setConsent(e.target.checked)}
              className="mt-0.5 rounded border-[var(--color-border)] text-[var(--color-brand)] focus:ring-[var(--color-brand)]"
            />
            <span>
              I consent to receive my EARIST gate pass QR code and visit instructions at this email address.
            </span>
          </label>

          <p className="text-xs text-[var(--color-text-muted)]">
            Email delivery is optional. You can always download or save your pass directly.
          </p>

          <div className="flex gap-2 pt-2">
            <Button type="button" variant="secondary" onClick={handleClose} disabled={loading} className="flex-1">
              Cancel
            </Button>
            <Button type="submit" loading={loading} disabled={loading || !consent} className="flex-1" icon={<Mail className="h-4 w-4" />}>
              Send Code
            </Button>
          </div>
        </form>
      )}

      {step === 'verify' && (
        <form onSubmit={handleVerifyAndSend} className="space-y-4">
          <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-canvas)] p-3 text-xs text-[var(--color-text-secondary)]">
            Verification code submitted for <strong>{recipientEmail}</strong>. Check your inbox and spam folder.
          </div>

          <FormField label="6-Digit Verification Code" id="verification-code">
            <Input
              id="verification-code"
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="123456"
              className="text-center text-lg font-mono tracking-widest"
              required
              autoFocus
            />
          </FormField>

          <div className="flex items-center justify-between text-xs">
            <button
              type="button"
              onClick={() => {
                setStep('input');
                setCode('');
                setErrorMessage(null);
                setVerificationId(null);
                requestCodeRequestIdRef.current = crypto.randomUUID();
                sendRequestIdRef.current = crypto.randomUUID();
              }}
              className="text-[var(--color-brand)] hover:underline"
            >
              Change email address
            </button>
            <button
              type="button"
              onClick={(e) => {
                requestCodeRequestIdRef.current = crypto.randomUUID();
                sendRequestIdRef.current = crypto.randomUUID();
                setVerificationId(null);
                void handleRequestCode(e);
              }}
              disabled={loading}
              className="text-[var(--color-brand)] hover:underline disabled:opacity-50"
            >
              Resend code
            </button>
          </div>

          <div className="flex gap-2 pt-2">
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                setStep('input');
                setVerificationId(null);
                requestCodeRequestIdRef.current = crypto.randomUUID();
                sendRequestIdRef.current = crypto.randomUUID();
              }}
              disabled={loading}
              className="flex-1"
              icon={<ArrowLeft className="h-4 w-4" />}
            >
              Back
            </Button>
            <Button
              type="submit"
              loading={loading}
              disabled={loading || code.trim().length !== 6}
              className="flex-1"
              icon={<CheckCircle2 className="h-4 w-4" />}
            >
              Verify &amp; Send
            </Button>
          </div>
        </form>
      )}

      {step === 'sent' && (
        <div className="space-y-4 py-3 text-center">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-[var(--color-success-light)] text-[var(--color-success)]">
            <CheckCircle2 className="h-8 w-8" />
          </div>
          <h3 className="text-lg font-bold text-[var(--color-text-primary)]">Pass Submitted</h3>
          <p className="text-xs leading-relaxed text-[var(--color-text-secondary)]">
            A scannable copy of your gate pass QR code was submitted to the email provider for <strong>{recipientEmail}</strong>. Check the inbox and spam folder.
          </p>
          <Button onClick={handleClose} className="w-full">
            Done
          </Button>
        </div>
      )}

      {step === 'unknown' && (
        <div className="space-y-4 py-3 text-center">
          <AlertCircle className="mx-auto h-10 w-10 text-[var(--color-warning)]" />
          <h3 className="text-lg font-bold text-[var(--color-text-primary)]">Outcome Unknown</h3>
          <p className="text-xs leading-relaxed text-[var(--color-text-secondary)]">
            The provider may have accepted the email, but confirmation was interrupted. To avoid sending the bearer QR twice, automatic retry is disabled. You can still download, print, or share the issued pass.
          </p>
          <Button onClick={handleClose} className="w-full">Close</Button>
        </div>
      )}
    </Modal>
  );
}
