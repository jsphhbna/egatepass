import crypto from 'node:crypto';
import { getServerSupabaseClients } from './supabase.js';

export interface SendSmsResult {
  success: boolean;
  status?: 'accepted' | 'sent' | 'delivered' | 'failed' | 'unknown';
  messageId?: string;
  error?: string;
  recipientCount: number;
  transactionId?: string;
}

/**
 * Mask a Philippine phone number for privacy-safe logging (RA 10173).
 * Example: "09171234567" -> "0917 ••• 4567"
 * Example: "+639171234567" -> "+63917 ••• 4567"
 */
export function maskPhoneNumber(phone: string): string {
  const clean = (phone || '').trim().replace(/[\s-]/g, '');
  if (clean.length < 8) return '••••••';
  const prefixLen = clean.startsWith('+63') ? 6 : 4;
  const suffixLen = 4;
  if (clean.length <= prefixLen + suffixLen) return `${clean.slice(0, 3)} ••• ${clean.slice(-2)}`;
  return `${clean.slice(0, prefixLen)} ••• ${clean.slice(-suffixLen)}`;
}

/**
 * Mask an Android Device ID for privacy-safe logging.
 * Example: "_3D0fcdgLnzghlYiYp9KM" -> "_3D0f ••• 9KM"
 */
export function maskDeviceId(deviceId: string): string {
  const clean = (deviceId || '').trim();
  if (clean.length <= 8) return '••••••••';
  return `${clean.slice(0, 4)} ••• ${clean.slice(-4)}`;
}

/**
 * Normalize and validate a Philippine phone number into standard E.164 (+639xxxxxxxxx).
 * Returns null if invalid or unrecognized.
 */
export function normalizePhilippinePhone(phone: string): string | null {
  const clean = (phone || '').trim().replace(/[\s-]/g, '');
  if (/^09\d{9}$/.test(clean)) {
    return `+63${clean.slice(1)}`;
  }
  if (/^\+639\d{9}$/.test(clean)) {
    return clean;
  }
  if (/^639\d{9}$/.test(clean)) {
    return `+${clean}`;
  }
  return null;
}

/**
 * Normalize and resolve the SMS Gateway API endpoint URL.
 * Enforces HTTPS in production and rejects unexpected protocols or non-local HTTP.
 */
export function resolveGatewayUrl(rawUrl?: string): string {
  let url = (rawUrl || process.env.SMS_GATEWAY_URL || '').trim();
  if (!url) {
    return 'https://api.sms-gate.app/3rdparty/v1/messages';
  }

  // Reject explicit dangerous or non-network schemes
  if (/^javascript:/i.test(url) || /^data:/i.test(url)) {
    throw new Error('invalid_sms_gateway_scheme');
  }

  // If a standard URI scheme (e.g. scheme://) is present, validate it
  const schemeMatch = url.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//);
  if (schemeMatch && schemeMatch[1]) {
    const scheme = schemeMatch[1].toLowerCase();
    if (scheme !== 'http' && scheme !== 'https') {
      throw new Error('invalid_sms_gateway_scheme');
    }
  } else {
    // If no scheme present (e.g. api.sms-gate.app:443), default to https
    url = `https://${url}`;
  }

  // Strip redundant default port 443
  url = url.replace(':443', '');

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('invalid_sms_gateway_url');
  }

  // HTTPS enforcement: In production or for any external/non-local host, require HTTPS
  const isLocalHost = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
  const isDev = process.env.NODE_ENV !== 'production';

  if (parsed.protocol === 'http:' && (!isLocalHost || !isDev)) {
    throw new Error('sms_gateway_https_required');
  }

  // Normalize endpoint path to /3rdparty/v1/messages
  if (parsed.pathname === '/' || parsed.pathname === '') {
    parsed.pathname = '/3rdparty/v1/messages';
  } else if (!parsed.pathname.endsWith('/messages')) {
    parsed.pathname = `${parsed.pathname.replace(/\/+$/, '')}/messages`;
  }

  return parsed.toString();
}

/**
 * Send an SMS message to one or more recipients via SMS Gateway for Android Cloud API.
 * Explicitly targets the configured Android Device ID, enforces timeout via AbortSignal,
 * normalizes phone numbers, and truthfully logs gateway acceptance state.
 */
export async function sendGatewaySms(options: {
  phoneNumbers: string[];
  message: string;
  purpose: 'emergency_roll_call' | 'overdue_exit_warning' | 'auth_code' | 'inbound_message' | 'manual_test' | 'status_update';
  actorId?: string | null;
  batchId?: string | null;
  transactionId?: string;
}): Promise<SendSmsResult> {
  const { phoneNumbers, message, purpose, actorId, batchId } = options;
  const transactionId = options.transactionId || `sms_tx_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;

  if (!phoneNumbers || phoneNumbers.length === 0) {
    return { success: false, status: 'failed', error: 'no_recipients_provided', recipientCount: 0, transactionId };
  }
  if (!message || message.trim() === '') {
    return { success: false, status: 'failed', error: 'empty_message', recipientCount: 0, transactionId };
  }

  const username = (process.env.SMS_GATEWAY_USERNAME || '').trim();
  const password = (process.env.SMS_GATEWAY_PASSWORD || '').trim();
  const deviceId = (process.env.SMS_GATEWAY_DEVICE_ID || '').trim();

  // Fail closed if gateway credentials are missing
  if (!username || !password) {
    console.warn('[SMS-GATEWAY] SMS Gateway credentials missing (SMS_GATEWAY_USERNAME / SMS_GATEWAY_PASSWORD).');
    await logSmsActivity({
      transactionId,
      direction: 'outbound',
      recipientMasked: phoneNumbers.map(maskPhoneNumber).join(', '),
      messageBody: message,
      purpose,
      status: 'failed',
      errorDetail: 'sms_gateway_credentials_not_configured',
      actorId,
      batchId,
    });
    return {
      success: false,
      status: 'failed',
      error: 'sms_gateway_not_configured',
      recipientCount: phoneNumbers.length,
      transactionId,
    };
  }

  // Fail closed if Android Device ID is not configured (Root Cause A)
  if (!deviceId) {
    console.warn('[SMS-GATEWAY] SMS Gateway device ID is not configured (SMS_GATEWAY_DEVICE_ID).');
    await logSmsActivity({
      transactionId,
      direction: 'outbound',
      recipientMasked: phoneNumbers.map(maskPhoneNumber).join(', '),
      messageBody: message,
      purpose,
      status: 'failed',
      errorDetail: 'sms_gateway_device_id_not_configured',
      actorId,
      batchId,
    });
    return {
      success: false,
      status: 'failed',
      error: 'sms_gateway_device_id_not_configured',
      recipientCount: phoneNumbers.length,
      transactionId,
    };
  }

  // Resolve and validate endpoint URL
  let endpoint: string;
  try {
    endpoint = resolveGatewayUrl();
  } catch (urlErr: any) {
    const errorMsg = urlErr?.message || 'invalid_gateway_url';
    await logSmsActivity({
      transactionId,
      deviceId: maskDeviceId(deviceId),
      direction: 'outbound',
      recipientMasked: phoneNumbers.map(maskPhoneNumber).join(', '),
      messageBody: message,
      purpose,
      status: 'failed',
      errorDetail: errorMsg,
      actorId,
      batchId,
    });
    return {
      success: false,
      status: 'failed',
      error: errorMsg,
      recipientCount: phoneNumbers.length,
      transactionId,
    };
  }

  // Normalize, validate, and deduplicate phone numbers
  const normalizedPhones: string[] = [];
  for (const p of phoneNumbers) {
    const norm = normalizePhilippinePhone(p);
    if (norm && !normalizedPhones.includes(norm)) {
      normalizedPhones.push(norm);
    }
  }

  if (normalizedPhones.length === 0) {
    await logSmsActivity({
      transactionId,
      deviceId: maskDeviceId(deviceId),
      direction: 'outbound',
      recipientMasked: phoneNumbers.map(maskPhoneNumber).join(', '),
      messageBody: message,
      purpose,
      status: 'failed',
      errorDetail: 'all_recipients_invalid_format',
      actorId,
      batchId,
    });
    return {
      success: false,
      status: 'failed',
      error: 'all_recipients_invalid_format',
      recipientCount: 0,
      transactionId,
    };
  }

  const basicAuth = Buffer.from(`${username}:${password}`).toString('base64');
  const payload = {
    textMessage: {
      text: message.trim(),
    },
    phoneNumbers: normalizedPhones,
    deviceId: deviceId, // Target the configured Android device explicitly
  };

  try {
    // 15-second request timeout via AbortSignal.timeout
    const response = await fetch(`${endpoint}?skipPhoneValidation=true`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Basic ${basicAuth}`,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15_000),
    });

    const data = await response.json().catch(() => null) as any;

    if (!response.ok) {
      const errorMsg = data?.message || data?.error || `HTTP ${response.status} from SMS Gateway`;
      console.error('[SMS-GATEWAY] Send failure:', errorMsg);
      await logSmsActivity({
        transactionId,
        deviceId: maskDeviceId(deviceId),
        direction: 'outbound',
        recipientMasked: normalizedPhones.map(maskPhoneNumber).join(', '),
        messageBody: message,
        purpose,
        status: 'failed',
        errorDetail: errorMsg,
        actorId,
        batchId,
      });
      return {
        success: false,
        status: 'failed',
        error: errorMsg,
        recipientCount: normalizedPhones.length,
        transactionId,
      };
    }

    const externalId = data?.id || data?.messageId || data?.data?.id || (Array.isArray(data) && data[0]?.id) || null;

    // HTTP 200/201 represents gateway acceptance/queueing, NOT confirmed SIM delivery
    await logSmsActivity({
      transactionId,
      deviceId: maskDeviceId(deviceId),
      direction: 'outbound',
      recipientMasked: normalizedPhones.map(maskPhoneNumber).join(', '),
      messageBody: message,
      purpose,
      status: 'accepted',
      externalId,
      actorId,
      batchId,
    });

    return {
      success: true,
      status: 'accepted',
      messageId: externalId,
      recipientCount: normalizedPhones.length,
      transactionId,
    };
  } catch (err: any) {
    const isTimeout = err?.name === 'TimeoutError' || err?.name === 'AbortError' || err?.code === 20;
    const errorMsg = isTimeout ? 'sms_gateway_request_timeout' : (err?.message || 'network_error_connecting_to_sms_gateway');
    console.error('[SMS-GATEWAY] Network/dispatch error:', errorMsg);

    // Timeout leaves status ambiguous; record as 'unknown' rather than resending naively
    await logSmsActivity({
      transactionId,
      deviceId: maskDeviceId(deviceId),
      direction: 'outbound',
      recipientMasked: normalizedPhones.map(maskPhoneNumber).join(', '),
      messageBody: message,
      purpose,
      status: isTimeout ? 'unknown' : 'failed',
      errorDetail: errorMsg,
      actorId,
      batchId,
    });

    return {
      success: false,
      status: isTimeout ? 'unknown' : 'failed',
      error: errorMsg,
      recipientCount: normalizedPhones.length,
      transactionId,
    };
  }
}

/**
 * Log an SMS transaction to public.sms_logs table.
 * Fully sanitized: passwords and authorization tokens are strictly excluded.
 */
export async function logSmsActivity(record: {
  transactionId?: string;
  direction: 'inbound' | 'outbound';
  recipientMasked: string;
  senderMasked?: string;
  messageBody: string;
  purpose: 'emergency_roll_call' | 'overdue_exit_warning' | 'auth_code' | 'inbound_message' | 'manual_test' | 'status_update';
  status: 'queued' | 'accepted' | 'sent' | 'delivered' | 'failed' | 'received' | 'unknown';
  externalId?: string | null;
  errorDetail?: string | null;
  actorId?: string | null;
  deviceId?: string | null;
  batchId?: string | null;
}) {
  try {
    const { admin } = getServerSupabaseClients();
    await admin.from('sms_logs').insert({
      transaction_id: record.transactionId || null,
      device_id: record.deviceId || null,
      batch_id: record.batchId || null,
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
