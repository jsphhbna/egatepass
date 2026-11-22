/**
 * SMS Offline Fallback Utility
 * Allows web/PWA/mobile devices to transmit emergency or roll call reports
 * via native SMS when cellular signal is available but mobile internet/data is down.
 */

import { encodeSmsMessage, decodeSmsMessage, type CompactSmsPayload } from '../../../server/smsFormat';

const CACHED_GATEWAY_NUMBER_KEY = 'egatepass_cached_gateway_phone';
const OFFLINE_SMS_QUEUE_KEY = 'egatepass_offline_sms_queue';

export interface QueuedOfflineSmsReport {
  msgId: string;
  type: string;
  text: string;
  gatewayNumber: string;
  sentBySms: boolean;
  syncedOverInternet: boolean;
  createdAt: string;
}

/**
 * Cache gateway phone number from server settings for offline use.
 */
export function cacheGatewayNumber(phone: string): void {
  if (typeof window === 'undefined') return;
  const clean = phone.trim();
  if (clean) {
    try {
      localStorage.setItem(CACHED_GATEWAY_NUMBER_KEY, clean);
    } catch {
      // Ignore localStorage errors
    }
  }
}

/**
 * Retrieve cached gateway phone number (never hard-coded).
 */
export function getCachedGatewayNumber(): string {
  if (typeof window === 'undefined') return '';
  try {
    return localStorage.getItem(CACHED_GATEWAY_NUMBER_KEY) || '';
  } catch {
    return '';
  }
}

/**
 * Construct SMS URI intent to open Android/iOS SMS app with pre-filled number and body.
 */
export function createSmsUri(phone: string, body: string): string {
  const cleanPhone = phone.trim().replace(/[\s-]/g, '');
  // Format for Android and iOS compatible SMS scheme
  return `sms:${encodeURIComponent(cleanPhone)}?body=${encodeURIComponent(body)}`;
}

/**
 * Trigger SMS dispatch via device's native messaging application.
 * Returns true if SMS app was opened.
 */
export function openDeviceSmsApp(phone: string, message: string): boolean {
  if (typeof window === 'undefined') return false;
  const uri = createSmsUri(phone, message);
  try {
    window.location.href = uri;
    return true;
  } catch (e) {
    console.error('Failed to open SMS app:', e);
    return false;
  }
}

/**
 * Queue an emergency offline report locally and open native SMS app.
 */
export function dispatchOfflineSmsEmergency(options: {
  msgId: string;
  type: string;
  lat?: number | null;
  lon?: number | null;
  timestamp?: number;
  gatewayNumber?: string;
}): { success: boolean; smsText: string; smsUri: string } {
  const gatewayPhone = options.gatewayNumber || getCachedGatewayNumber();
  const encodedSms = encodeSmsMessage({
    msgId: options.msgId,
    type: options.type,
    latitude: options.lat ?? null,
    longitude: options.lon ?? null,
    timestamp: options.timestamp ?? Math.floor(Date.now() / 1000),
  });

  const uri = createSmsUri(gatewayPhone, encodedSms);

  // Store in offline queue
  try {
    const existingRaw = localStorage.getItem(OFFLINE_SMS_QUEUE_KEY);
    const queue: QueuedOfflineSmsReport[] = existingRaw ? JSON.parse(existingRaw) : [];
    queue.push({
      msgId: options.msgId,
      type: options.type,
      text: encodedSms,
      gatewayNumber: gatewayPhone,
      sentBySms: true,
      syncedOverInternet: false,
      createdAt: new Date().toISOString(),
    });
    localStorage.setItem(OFFLINE_SMS_QUEUE_KEY, JSON.stringify(queue.slice(-50)));
  } catch {
    // Ignore storage write issues
  }

  if (gatewayPhone) {
    openDeviceSmsApp(gatewayPhone, encodedSms);
  }

  return {
    success: true,
    smsText: encodedSms,
    smsUri: uri,
  };
}

export { encodeSmsMessage, decodeSmsMessage, type CompactSmsPayload };
