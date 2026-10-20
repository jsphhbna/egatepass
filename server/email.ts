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

export async function sendResendEmail(payload: SendEmailPayload): Promise<SendEmailResult> {
  if (customEmailSender) {
    return customEmailSender(payload);
  }

  const apiKey = process.env.RESEND_API_KEY?.trim();
  if (!apiKey) {
    throw new EmailDeliveryError('email_service_unconfigured', 'definitive_rejection');
  }

  const fromEmail = process.env.RESEND_FROM_EMAIL?.trim() || 'EARIST E-GatePass <onboarding@resend.dev>';

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

  const data = await response.json().catch(() => null) as { id?: string; message?: string } | null;
  if (!response.ok) {
    throw new EmailDeliveryError('resend_rejected', 'definitive_rejection', data?.message || 'resend_rejected');
  }
  if (!data?.id) {
    // A successful HTTP status with an unreadable acknowledgement cannot prove
    // whether the provider durably accepted the message.
    throw new EmailDeliveryError('provider_acknowledgement_unknown', 'unknown');
  }

  return { id: data.id, provider: 'resend' };
}
