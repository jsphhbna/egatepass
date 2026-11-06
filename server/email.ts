import { generateBrandedQrPngBuffer } from './brandedQr.js';

export interface SendEmailPayload {
  to: string;
  subject: string;
  html: string;
  idempotencyKey?: string;
  correlationId?: string;
  tags?: Array<{ name: string; value: string }>;
  headers?: Record<string, string>;
  attachments?: Array<{
    filename: string;
    content: string; // Base64 encoded
    content_type?: string;
  }>;
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
  return generateBrandedQrPngBuffer(qrToken);
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

export function validateSenderEmail(
  from: string | undefined | null,
  isProduction: boolean = process.env.NODE_ENV === 'production' || process.env.VERCEL_ENV === 'production'
): {
  valid: boolean;
  error?: 'email_sender_unconfigured' | 'email_sender_invalid';
  email?: string;
} {
  const trimmed = from?.trim();
  if (!trimmed) {
    if (isProduction) {
      return { valid: false, error: 'email_sender_unconfigured' };
    }
    return { valid: true, email: 'EARIST E-GatePass <onboarding@resend.dev>' };
  }

  // Reject malformed sender configurations such as API keys placed in the sender variable
  if (trimmed.startsWith('re_') || trimmed.startsWith('re-')) {
    return { valid: false, error: 'email_sender_invalid' };
  }

  // Sender format: either "Display Name <user@domain.tld>" or "user@domain.tld"
  const angleMatch = trimmed.match(/^([^<]*?)<([^>]+)>$/);
  let emailAddr = trimmed;
  if (angleMatch) {
    emailAddr = angleMatch[2]?.trim() ?? '';
  }

  // Strict email regex: no angle brackets, no spaces, valid domain
  const emailRegex = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;
  if (!emailAddr || !emailRegex.test(emailAddr)) {
    return { valid: false, error: 'email_sender_invalid' };
  }

  return { valid: true, email: trimmed };
}

export async function sendResendEmail(payload: SendEmailPayload): Promise<SendEmailResult> {
  if (customEmailSender) {
    return customEmailSender(payload);
  }

  const apiKey = process.env.RESEND_API_KEY?.trim();
  if (!apiKey) {
    throw new EmailDeliveryError('email_service_unconfigured', 'definitive_rejection');
  }

  const rawFrom = process.env.RESEND_FROM_EMAIL?.trim() || process.env.EMAIL_FROM?.trim();
  const isProd = process.env.NODE_ENV === 'production' || process.env.VERCEL_ENV === 'production';

  const validatedSender = validateSenderEmail(rawFrom, isProd);
  if (!validatedSender.valid) {
    throw new EmailDeliveryError(validatedSender.error!, 'definitive_rejection');
  }

  const fromEmail = validatedSender.email!;

  let response: Response;
  try {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    };
    if (payload.idempotencyKey) {
      headers['Idempotency-Key'] = payload.idempotencyKey;
    }

    const outgoingTags: Array<{ name: string; value: string }> = payload.tags ? [...payload.tags] : [];
    if (payload.correlationId) {
      outgoingTags.push({ name: 'outbox_id', value: payload.correlationId });
    }

    const outgoingCustomHeaders: Record<string, string> = { ...(payload.headers || {}) };
    if (payload.correlationId) {
      outgoingCustomHeaders['X-Entity-Ref-ID'] = payload.correlationId;
    }

    const requestBody: Record<string, any> = {
      from: fromEmail,
      to: [payload.to],
      subject: payload.subject,
      html: payload.html,
      attachments: payload.attachments,
    };
    if (outgoingTags.length > 0) {
      requestBody.tags = outgoingTags;
    }
    if (Object.keys(outgoingCustomHeaders).length > 0) {
      requestBody.headers = outgoingCustomHeaders;
    }

    response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers,
      body: JSON.stringify(requestBody),
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
