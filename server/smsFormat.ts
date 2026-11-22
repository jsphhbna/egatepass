// Short, versioned message format for bandwidth-constrained SMS transmission (< 160 characters)
// Prefix: EG1 (EARIST E-GatePass v1)
// Envelope: EG1|<msgId>|<type>|<lat>|<lon>|<timestamp>

export interface SmsEmergencyPayload {
  version: 'EG1';
  msgId: string; // 8-16 char unique identifier created on sender's device
  type: string; // SOS | SAFE | CHECKIN | ASSIST
  latitude: number | null;
  longitude: number | null;
  timestamp: number; // Unix timestamp in seconds
}

export type CompactSmsPayload = SmsEmergencyPayload;

export const SMS_PREFIX = 'EG1';
export const MAX_SMS_LENGTH = 160;

/**
 * Encode an emergency or telemetry payload into a compact string under 160 chars.
 */
export function encodeSmsMessage(payload: Omit<SmsEmergencyPayload, 'version'>): string {
  const latStr = payload.latitude !== null && payload.latitude !== undefined && !Number.isNaN(payload.latitude)
    ? payload.latitude.toFixed(5)
    : '';
  const lonStr = payload.longitude !== null && payload.longitude !== undefined && !Number.isNaN(payload.longitude)
    ? payload.longitude.toFixed(5)
    : '';
  const ts = payload.timestamp ?? Math.floor(Date.now() / 1000);
  const encoded = `${SMS_PREFIX}|${payload.msgId.trim()}|${payload.type.trim().toUpperCase()}|${latStr}|${lonStr}|${ts}`;
  if (encoded.length > MAX_SMS_LENGTH) {
    throw new Error(`Encoded SMS message exceeds 160 characters limit: ${encoded.length}`);
  }
  return encoded;
}

/**
 * Decode and validate a compact SMS string.
 */
export function decodeSmsMessage(raw: string): SmsEmergencyPayload | null {
  if (!raw || typeof raw !== 'string') return null;
  const parts = raw.trim().split('|');
  if (parts.length < 6) return null;
  const prefix = parts[0];
  const rawMsgId = parts[1];
  const rawType = parts[2];
  const rawLat = parts[3];
  const rawLon = parts[4];
  const rawTs = parts[5];

  if (!prefix || prefix !== SMS_PREFIX || !rawMsgId || !rawType || !rawTs) return null;

  const msgId = rawMsgId.trim();
  const type = rawType.trim().toUpperCase();
  const lat = rawLat && rawLat.trim() ? parseFloat(rawLat.trim()) : null;
  const lon = rawLon && rawLon.trim() ? parseFloat(rawLon.trim()) : null;
  const ts = parseInt(rawTs.trim(), 10);

  if (!msgId || !type || Number.isNaN(ts)) return null;

  return {
    version: SMS_PREFIX,
    msgId,
    type,
    latitude: lat !== null && !Number.isNaN(lat) ? lat : null,
    longitude: lon !== null && !Number.isNaN(lon) ? lon : null,
    timestamp: ts,
  };
}
