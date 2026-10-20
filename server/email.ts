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
    const error = new Error('email_service_unconfigured');
    (error as unknown as { code: string }).code = 'email_service_unconfigured';
    throw error;
  }

  const fromEmail = process.env.RESEND_FROM_EMAIL?.trim() || 'EARIST E-GatePass <onboarding@resend.dev>';

  const response = await fetch('https://api.resend.com/emails', {
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

  const data = await response.json().catch(() => null) as { id?: string; message?: string } | null;
  if (!response.ok || !data?.id) {
    const error = new Error(data?.message || 'resend_send_failed');
    (error as unknown as { code: string }).code = 'resend_send_failed';
    throw error;
  }

  return { id: data.id, provider: 'resend' };
}
