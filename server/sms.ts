import { getServerSupabaseClients } from './supabase.js';

export interface SendSmsResult {
  success: boolean;
  messageId?: string;
  error?: string;
  recipientCount: number;
}

/**
 * Mask a Philippine phone number for privacy-safe logging (RA 10173).
 * Example: "09171234567" -> "0917 ••• 4567"
 * Example: "+639171234567" -> "+63917 ••• 4567"
 */
export function maskPhoneNumber(phone: string): string {
  const clean = phone.trim().replace(/[\s-]/g, '');
  if (clean.length < 8) return '••••••';
  const prefixLen = clean.startsWith('+63') ? 6 : 4;
  const suffixLen = 4;
  if (clean.length <= prefixLen + suffixLen) return `${clean.slice(0, 3)} ••• ${clean.slice(-2)}`;
  return `${clean.slice(0, prefixLen)} ••• ${clean.slice(-suffixLen)}`;
}

/**
 * Normalize and resolve the SMS Gateway API endpoint URL.
 */
export function resolveGatewayUrl(rawUrl?: string): string {
  let url = (rawUrl || process.env.SMS_GATEWAY_URL || '').trim();
  if (!url) {
    return 'https://api.sms-gate.app/3rdparty/v1/messages';
  }
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    url = `https://${url}`;
  }
  // Remove port 443 if present in hostname
  url = url.replace(':443', '');

  // Append endpoint path if pointing only to origin
  const parsed = new URL(url);
  if (parsed.pathname === '/' || parsed.pathname === '') {
    parsed.pathname = '/3rdparty/v1/messages';
  } else if (!parsed.pathname.endsWith('/messages')) {
    parsed.pathname = `${parsed.pathname.replace(/\/+$/, '')}/messages`;
  }
  return parsed.toString();
}

/**
 * Send an SMS message to one or more recipients via SMS Gateway for Android Cloud API.
 */
export async function sendGatewaySms(options: {
  phoneNumbers: string[];
  message: string;
  purpose: 'emergency_roll_call' | 'overdue_exit_warning' | 'auth_code' | 'inbound_message' | 'manual_test' | 'status_update';
  actorId?: string | null;
}): Promise<SendSmsResult> {
  const { phoneNumbers, message, purpose, actorId } = options;
  if (!phoneNumbers || phoneNumbers.length === 0) {
    return { success: false, error: 'no_recipients_provided', recipientCount: 0 };
  }
  if (!message || message.trim() === '') {
    return { success: false, error: 'empty_message', recipientCount: 0 };
  }

  const username = (process.env.SMS_GATEWAY_USERNAME || '').trim();
  const password = (process.env.SMS_GATEWAY_PASSWORD || '').trim();

  // If credentials are not set, fail clearly without crashing
  if (!username || !password) {
    console.warn('[SMS-GATEWAY] SMS Gateway credentials are not set in environment variables (SMS_GATEWAY_USERNAME / SMS_GATEWAY_PASSWORD).');
    await logSmsActivity({
      direction: 'outbound',
      recipientMasked: phoneNumbers.map(maskPhoneNumber).join(', '),
      messageBody: message,
      purpose,
      status: 'failed',
      errorDetail: 'sms_gateway_credentials_not_configured',
      actorId,
    });
    return {
      success: false,
      error: 'sms_gateway_not_configured',
      recipientCount: phoneNumbers.length,
    };
  }

  const endpoint = resolveGatewayUrl();
  const basicAuth = Buffer.from(`${username}:${password}`).toString('base64');

  // Format clean E.164 phone numbers (e.g., 0917... -> +63917...)
  const normalizedPhones = phoneNumbers.map((p) => {
    let clean = p.trim().replace(/[\s-]/g, '');
    if (clean.startsWith('09') && clean.length === 11) {
      clean = `+63${clean.slice(1)}`;
    }
    return clean;
  });

  try {
    const response = await fetch(`${endpoint}?skipPhoneValidation=true`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Basic ${basicAuth}`,
      },
      body: JSON.stringify({
        textMessage: {
          text: message.trim(),
        },
        phoneNumbers: normalizedPhones,
      }),
    });

    const data = await response.json().catch(() => null) as any;

    if (!response.ok) {
      const errorMsg = data?.message || data?.error || `HTTP ${response.status} from SMS Gateway`;
      console.error('[SMS-GATEWAY] Send failure:', errorMsg);
      await logSmsActivity({
        direction: 'outbound',
        recipientMasked: normalizedPhones.map(maskPhoneNumber).join(', '),
        messageBody: message,
        purpose,
        status: 'failed',
        errorDetail: errorMsg,
        actorId,
      });
      return { success: false, error: errorMsg, recipientCount: normalizedPhones.length };
    }

    const externalId = data?.id || data?.messageId || data?.data?.id || null;

    await logSmsActivity({
      direction: 'outbound',
      recipientMasked: normalizedPhones.map(maskPhoneNumber).join(', '),
      messageBody: message,
      purpose,
      status: 'sent',
      externalId,
      actorId,
    });

    return {
      success: true,
      messageId: externalId,
      recipientCount: normalizedPhones.length,
    };
  } catch (err: any) {
    const errorMsg = err?.message || 'network_error_connecting_to_sms_gateway';
    console.error('[SMS-GATEWAY] Network error:', err);
    await logSmsActivity({
      direction: 'outbound',
      recipientMasked: normalizedPhones.map(maskPhoneNumber).join(', '),
      messageBody: message,
      purpose,
      status: 'failed',
      errorDetail: errorMsg,
      actorId,
    });
    return { success: false, error: errorMsg, recipientCount: normalizedPhones.length };
  }
}

/**
 * Log an SMS transaction to public.sms_logs table.
 */
export async function logSmsActivity(record: {
  direction: 'inbound' | 'outbound';
  recipientMasked: string;
  senderMasked?: string;
  messageBody: string;
  purpose: 'emergency_roll_call' | 'overdue_exit_warning' | 'auth_code' | 'inbound_message' | 'manual_test' | 'status_update';
  status: 'queued' | 'sent' | 'delivered' | 'failed' | 'received';
  externalId?: string | null;
  errorDetail?: string | null;
  actorId?: string | null;
}) {
  try {
    const { admin } = getServerSupabaseClients();
    await admin.from('sms_logs').insert({
      direction: record.direction,
      recipient_masked: record.recipientMasked,
      sender_masked: record.senderMasked || null,
      message_body: record.messageBody,
      purpose: record.purpose,
      status: record.status,
      external_id: record.externalId || null,
      error_detail: record.errorDetail || null,
      actor_id: record.actorId || null,
    });
  } catch (logErr) {
    console.error('[SMS-GATEWAY] Could not write to sms_logs table:', logErr);
  }
}
