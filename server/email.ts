import QRCode from 'qrcode';

export interface EmailAttachment {
  filename: string;
  content: string; // base64 encoded
}

export interface SendEmailPayload {
  to: string;
  subject: string;
  html: string;
  attachments?: EmailAttachment[];
}

export interface SendEmailResult {
  id: string;
  provider: 'resend' | 'mock';
}

export type EmailSender = (payload: SendEmailPayload) => Promise<SendEmailResult>;

export class EmailDeliveryError extends Error {
  constructor(
    public readonly code: string,
    public readonly outcome: 'definitive_rejection' | 'unknown',
    message = code,
  ) {
    super(message);
    this.name = 'EmailDeliveryError';
  }
}

let customEmailSender: EmailSender | null = null;

export function setEmailSenderForTest(sender: EmailSender | null): void {
  customEmailSender = sender;
}

export function escapeHtml(value: string | null | undefined): string {
  if (!value) return '';
  return String(value).replace(/[&<>"']/g, (char) => {
    switch (char) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      case "'": return '&#039;';
      default: return char;
    }
  });
}

export async function generateQrPngBuffer(qrToken: string): Promise<Buffer> {
  return QRCode.toBuffer(qrToken, {
    type: 'png',
    width: 360,
    margin: 2,
    color: {
      dark: '#800000', // EARIST maroon
      light: '#FFFFFF',
    },
  });
}

export interface ResendClassification {
  outcome: 'definitive_rejection' | 'unknown';
  code: string;
  message: string;
}

export function classifyResendHttpStatus(
  status: number,
  data: { id?: string; message?: string; name?: string } | null,
): ResendClassification {
  const message = data?.message || `HTTP ${status}`;
  // 400 (Bad Request), 401 (Unauthorized), 403 (Forbidden), 422 (Unprocessable Entity)
  // are deterministic client/validation errors where Resend definitively rejects the submission.
  if (status === 400 || status === 401 || status === 403 || status === 422) {
    return {
      outcome: 'definitive_rejection',
      code: 'resend_rejected',
      message,
    };
  }

  // 429 (Rate Limit): Request was throttled. The message may or may not have been queued.
  if (status === 429) {
    return {
      outcome: 'unknown',
      code: 'resend_rate_limited',
      message: 'Provider rate limit exceeded. Outcome is uncertain.',
    };
  }

  // 5xx (Internal Error, Bad Gateway, Service Unavailable, Gateway Timeout):
  // Upstream server errors cannot guarantee non-acceptance.
  if (status >= 500 && status <= 599) {
    return {
      outcome: 'unknown',
      code: 'resend_server_error',
      message: `Provider server error (${status}). Outcome is uncertain.`,
    };
  }

  // Any other non-2xx status
  return {
    outcome: 'unknown',
    code: 'resend_status_uncertain',
    message: `Unexpected provider status (${status}). Outcome is uncertain.`,
  };
}

export async function sendResendEmail(payload: SendEmailPayload): Promise<SendEmailResult> {
  if (customEmailSender) {
    return customEmailSender(payload);
  }

  const apiKey = process.env.RESEND_API_KEY?.trim();
  if (!apiKey) {
    throw new EmailDeliveryError('email_service_unconfigured', 'definitive_rejection');
  }

  const fromEmail = process.env.RESEND_FROM_EMAIL?.trim() || process.env.EMAIL_FROM?.trim() || 'EARIST E-GatePass <onboarding@resend.dev>';

  let response: Response;
  try {
    response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: fromEmail,
        to: [payload.to],
        subject: payload.subject,
        html: payload.html,
        attachments: payload.attachments,
      }),
    });
  } catch {
    // A transport exception can happen after the provider accepted the request.
    throw new EmailDeliveryError('email_transport_unknown', 'unknown');
  }

  const data = await response.json().catch(() => null) as { id?: string; message?: string; name?: string } | null;
  if (!response.ok) {
    const classified = classifyResendHttpStatus(response.status, data);
    throw new EmailDeliveryError(classified.code, classified.outcome, classified.message);
  }
  if (!data?.id) {
    // A successful HTTP status with an unreadable acknowledgement cannot prove
    // whether the provider durably accepted the message.
    throw new EmailDeliveryError('provider_acknowledgement_unknown', 'unknown');
  }

  return { id: data.id, provider: 'resend' };
}
