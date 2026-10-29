import { useEffect, useRef, useState } from 'react';
import { Mail, CheckCircle2, AlertCircle, ArrowLeft } from 'lucide-react';
import { toast } from 'sonner';
import { Modal, FormField, Input, Button } from '@/components/ui';
import { requirePortalSupabase, requireSupabase } from '@/lib/supabase';
import {
  buildRequestCodePayload,
  buildVerifyAndSendPayload,
  type RequestCodePayload,
  type VerifyAndSendPayload,
} from '@/lib/passEmailContract';
import { fetchWithTimeout, RequestTimeoutError } from '@/lib/fetchWithTimeout';

interface EmailPassModalProps {
  isOpen: boolean;
  onClose: () => void;
  passId: string;
  qrToken: string;
  source: 'portal' | 'kiosk';
  mode?: 'modal' | 'delivery-gate';
  onSuccess?: () => void;
  onUnknown?: () => void;
  onSkip?: () => void;
  initialEmail?: string;
}

export function EmailPassModal({
  isOpen,
  onClose,
  passId,
  qrToken,
  source,
  mode = 'modal',
  onSuccess,
  onUnknown,
  onSkip,
  initialEmail = '',
}: EmailPassModalProps) {
  const isDeliveryGate = mode === 'delivery-gate';

  function friendlyEmailError(codeOrMessage: string | undefined, fallback: string): string {
    const messages: Record<string, string> = {
      invalid_code: 'That verification code is incorrect.',
      code_expired: 'That verification code has expired. Request a new code.',
      max_attempts_exceeded: 'Too many incorrect attempts. Request a new code.',
      too_many_requests: 'Too many email requests. Please wait before trying again.',
      too_many_requests_recipient: 'Too many verification code requests for this email address. Please try again later.',
      too_many_requests_actor: 'Too many verification requests from this device or session. Please wait before retrying.',
      recipient_challenge_limit_exceeded: 'Too many verification code requests for this email address. Please try again later.',
      actor_challenge_limit_exceeded: 'Too many verification requests from this device or session. Please wait before retrying.',
      email_service_unconfigured: 'Email delivery is currently unavailable.',
      email_state_unavailable: 'Email delivery state is temporarily unavailable. Your issued pass is unaffected.',
      recipient_mismatch: 'The email address no longer matches this verification request.',
      idempotency_key_mismatch: 'This email operation no longer matches the original request. Start again.',
      dispatch_in_progress: 'An email submission is already in progress. Please wait for confirmation.',
      dispatched_unknown_outcome: 'The email provider took too long to confirm. Your pass is issued and available.',
      email_outcome_unknown: 'The email provider took too long to confirm. Your pass is issued and available.',
      verification_delivery_unknown: 'The verification code delivery outcome is uncertain. Please wait before requesting another code.',
      verification_finalization_conflict: 'Verification code delivery was interrupted. Please wait before retrying.',
      email_finalization_conflict: 'Email delivery confirmation was interrupted. Your pass is issued and available.',
      database_unavailable: 'Database is currently unavailable. Your issued pass is unaffected.',
    };
    if (codeOrMessage && messages[codeOrMessage]) {
      return messages[codeOrMessage];
    }
    return fallback;
  }

  const [step, setStep] = useState<'input' | 'verify' | 'sent' | 'unknown'>('input');
  const [recipientEmail, setRecipientEmail] = useState(initialEmail);
  const [code, setCode] = useState('');
  const [consent, setConsent] = useState(false);
  const [verificationId, setVerificationId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [resendCooldown, setResendCooldown] = useState(0);

  type CodeRequestAttemptState = 'ready' | 'in-flight' | 'ambiguous';
  const requestCodeAttemptStateRef = useRef<CodeRequestAttemptState>('ready');
  const requestCodeRequestIdRef = useRef<string>(crypto.randomUUID());
  const sendRequestIdRef = useRef<string>(crypto.randomUUID());

  useEffect(() => {
    if (initialEmail && !recipientEmail) {
      setRecipientEmail(initialEmail);
    }
  }, [initialEmail]);

  useEffect(() => {
    if (resendCooldown <= 0) return;
    const timer = setInterval(() => {
      setResendCooldown((prev) => (prev <= 1 ? 0 : prev - 1));
    }, 1000);
    return () => clearInterval(timer);
  }, [resendCooldown]);

  function handleClose() {
    if (loading) return;
    setStep('input');
    setRecipientEmail(initialEmail);
    setCode('');
    setConsent(false);
    setVerificationId(null);
    setErrorMessage(null);
    setResendCooldown(0);
    requestCodeAttemptStateRef.current = 'ready';
    requestCodeRequestIdRef.current = crypto.randomUUID();
    sendRequestIdRef.current = crypto.randomUUID();
    onClose();
  }

  function handleSkip() {
    if (loading) return;
    onSkip?.();
  }

  async function executeRequestCode(isResend: boolean) {
    if (!consent) {
      setErrorMessage('You must consent to receive your pass by email.');
      return;
    }
    setLoading(true);
    setErrorMessage(null);

    // If ready for a new attempt, rotate request ID; if ambiguous after timeout, reuse SAME request ID (Section 11)
    if (requestCodeAttemptStateRef.current === 'ready') {
      requestCodeRequestIdRef.current = crypto.randomUUID();
    }
    requestCodeAttemptStateRef.current = 'in-flight';

    try {
      const supabase = source === 'portal' ? requirePortalSupabase() : requireSupabase();
      const { data: { session } } = await supabase.auth.getSession();
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (session?.access_token) {
        headers['Authorization'] = `Bearer ${session.access_token}`;
      }

      const payload: RequestCodePayload = buildRequestCodePayload({
        passId,
        qrToken,
        recipientEmail,
        consent,
        requestId: requestCodeRequestIdRef.current,
      });

      let res: Response;
      try {
        res = await fetchWithTimeout('/api/passes/email', {
          method: 'POST',
          headers,
          body: JSON.stringify(payload),
        }, 10000);
      } catch (netErr) {
        // Simulated or real timeout: mark attempt ambiguous so the NEXT resend reuses the SAME request ID
        requestCodeAttemptStateRef.current = 'ambiguous';
        if (netErr instanceof RequestTimeoutError) {
          throw new Error('Verification code request timed out. Please try again.');
        }
        throw netErr;
      }

      const data = await res.json().catch(() => null);

      if (res.status === 429) {
        requestCodeAttemptStateRef.current = 'ready';
        setResendCooldown(60);
        throw new Error(data?.message || friendlyEmailError('too_many_requests', 'Too many requests. Please wait before retrying.'));
      }
      if (!res.ok || !data?.success) {
        requestCodeAttemptStateRef.current = 'ready';
        throw new Error(data?.message || friendlyEmailError(data?.error, 'Failed to request verification code.'));
      }

      // Definitive success: store new verificationId and mark ready for future resends
      requestCodeAttemptStateRef.current = 'ready';
      setVerificationId(data.verificationId);
      if (isResend) {
        // Clear/reset entered OTP only after the new challenge is successfully created
        setCode('');
      }
      setStep('verify');
      setResendCooldown(60);
      toast.success('Verification code submitted. Check your inbox.');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to send code.';
      setErrorMessage(message);
      toast.error(message);
    } finally {
      setLoading(false);
    }
  }

  async function handleRequestCode(e: React.FormEvent) {
    e.preventDefault();
    await executeRequestCode(false);
  }

  async function handleVerifyAndSend(e: React.FormEvent) {
    e.preventDefault();
    if (!verificationId || code.trim().length !== 6) return;
    setLoading(true);
    setErrorMessage(null);

    try {
      const supabase = source === 'portal' ? requirePortalSupabase() : requireSupabase();
      const { data: { session } } = await supabase.auth.getSession();
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (session?.access_token) {
        headers['Authorization'] = `Bearer ${session.access_token}`;
      }

      const payload: VerifyAndSendPayload = buildVerifyAndSendPayload({
        passId,
        qrToken,
        recipientEmail,
        verificationId,
        code,
        requestId: sendRequestIdRef.current,
      });

      let res: Response;
      try {
        res = await fetchWithTimeout('/api/passes/email', {
          method: 'POST',
          headers,
          body: JSON.stringify(payload),
        }, 15000);
      } catch (netErr) {
        if (netErr instanceof RequestTimeoutError) {
          // If final email dispatch times out after provider submission may have occurred:
          // use the existing outcome_unknown semantics, do not automatically send a duplicate bearer QR.
          setStep('unknown');
          return;
        }
        throw netErr;
      }

      const data = await res.json().catch(() => null);

      if (
        res.status === 504 ||
        res.status === 202 ||
        data?.status === 'outcome_unknown' ||
        data?.error === 'email_outcome_unknown' ||
        data?.error === 'dispatched_unknown_outcome' ||
        data?.error === 'email_finalization_conflict'
      ) {
        setStep('unknown');
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
      title={
        isDeliveryGate
          ? step === 'sent'
            ? 'Delivery Secured'
            : step === 'unknown'
            ? 'Delivery Status Uncertain'
            : 'Deliver Your E-GatePass'
          : 'Email My E-GatePass QR Code'
      }
      size="sm"
      preventClose={loading || (isDeliveryGate && (step === 'input' || step === 'verify'))}
    >
      {errorMessage && (
        <div className="mb-4 flex items-start gap-2.5 rounded-lg border border-[var(--color-danger)] bg-[var(--color-danger-light)] p-3 text-xs font-medium text-[var(--color-danger-dark)]" role="alert">
          <AlertCircle className="h-4 w-4 shrink-0 text-[var(--color-danger)]" />
          <span>{errorMessage}</span>
        </div>
      )}

      {step === 'input' && (
        <form onSubmit={handleRequestCode} className="space-y-4">
          <FormField label="Recipient Email" id="recipient-email" requirement="required" hint="We will send a 6-digit verification code to this address.">
            <Input
              id="recipient-email"
              type="email"
              value={recipientEmail}
              onChange={(e) => setRecipientEmail(e.target.value)}
              placeholder="visitor@example.com"
              required
              aria-required="true"
              autoFocus
            />
          </FormField>

          <label className="flex items-start gap-2.5 text-xs text-[var(--color-text-secondary)]">
            <input
              type="checkbox"
              checked={consent}
              onChange={(e) => setConsent(e.target.checked)}
              required
              aria-required="true"
              className="mt-0.5 rounded border-[var(--color-border)] text-[var(--color-brand)] focus:ring-[var(--color-brand)]"
            />
            <span>
              I consent to receive my EARIST gate pass QR code and visit instructions at this email address. <span className="text-red-500 font-bold">*</span>
            </span>
          </label>

          <p className="text-xs text-[var(--color-text-muted)]">
            {isDeliveryGate
              ? 'Verifying your email ensures you have a permanent copy of your pass if you leave this page.'
              : 'Email delivery is optional. You can always download or save your pass directly.'}
          </p>

          <div className="flex gap-2 pt-2">
            {isDeliveryGate && onSkip ? (
              <Button type="button" variant="secondary" onClick={handleSkip} disabled={loading} className="flex-1">
                Continue without email
              </Button>
            ) : (
              <Button type="button" variant="secondary" onClick={handleClose} disabled={loading} className="flex-1">
                Cancel
              </Button>
            )}
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

          <FormField label="6-Digit Verification Code" id="verification-code" requirement="required">
            <Input
              id="verification-code"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]*"
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
              placeholder="123456"
              className="text-center text-lg font-mono tracking-widest"
              required
              aria-required="true"
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
                requestCodeAttemptStateRef.current = 'ready';
                requestCodeRequestIdRef.current = crypto.randomUUID();
                sendRequestIdRef.current = crypto.randomUUID();
              }}
              className="text-[var(--color-brand)] hover:underline"
            >
              Change email address
            </button>
            <button
              type="button"
              onClick={() => {
                if (resendCooldown > 0) return;
                sendRequestIdRef.current = crypto.randomUUID();
                void executeRequestCode(true);
              }}
              disabled={loading || resendCooldown > 0}
              className="text-[var(--color-brand)] hover:underline disabled:opacity-50 disabled:no-underline font-medium"
            >
              {resendCooldown > 0 ? `Resend code in ${resendCooldown}s` : 'Resend code'}
            </button>
          </div>

          <div className="flex gap-2 pt-2">
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                setStep('input');
                setVerificationId(null);
                requestCodeAttemptStateRef.current = 'ready';
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

          {isDeliveryGate && onSkip && (
            <div className="text-center pt-1">
              <button
                type="button"
                onClick={handleSkip}
                disabled={loading}
                className="text-xs text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:underline disabled:opacity-50 disabled:cursor-not-allowed disabled:no-underline"
              >
                Continue without email
              </button>
            </div>
          )}
        </form>
      )}

      {step === 'sent' && (
        <div className="space-y-4 py-3 text-center">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-[var(--color-success-light)] text-[var(--color-success)]">
            <CheckCircle2 className="h-8 w-8" />
          </div>
          <h3 className="text-lg font-bold text-[var(--color-text-primary)]">
            {isDeliveryGate ? 'E-GatePass Emailed!' : 'Pass Submitted'}
          </h3>
          <p className="text-xs leading-relaxed text-[var(--color-text-secondary)]">
            A scannable copy of your gate pass QR code was submitted to the email provider for <strong>{recipientEmail}</strong>. Check the inbox and spam folder.
          </p>
          <Button
            onClick={() => {
              if (onSuccess) {
                onSuccess();
              } else {
                handleClose();
              }
            }}
            className="w-full"
          >
            {isDeliveryGate ? 'View My E-GatePass' : 'Done'}
          </Button>
        </div>
      )}

      {step === 'unknown' && (
        <div className="space-y-4 py-3 text-center">
          <AlertCircle className="mx-auto h-10 w-10 text-[var(--color-warning)]" />
          <h3 className="text-lg font-bold text-[var(--color-text-primary)]">Outcome Unknown</h3>
          <p className="text-xs leading-relaxed text-[var(--color-text-secondary)]">
            The provider may have accepted the email, but confirmation was interrupted. To avoid sending the bearer QR twice, automatic retry is disabled. You can still download or save the issued pass.
          </p>
          <Button
            onClick={() => {
              if (onUnknown) {
                onUnknown();
              } else {
                handleClose();
              }
            }}
            className="w-full"
          >
            {isDeliveryGate ? 'Continue to E-GatePass' : 'Close'}
          </Button>
        </div>
      )}
    </Modal>
  );
}
