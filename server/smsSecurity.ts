import crypto from 'node:crypto';

export interface VerifyStandardWebhookOptions {
  headers: Record<string, string | undefined>;
  rawBody: string;
  secret: string; // "v1,whsec_..." or hex
  toleranceSeconds?: number;
}

export interface VerifyGatewayWebhookOptions {
  headers: Record<string, string | undefined>;
  rawBody: string;
  secret: string;
  toleranceSeconds?: number;
}

/**
 * Verify Standard Webhooks signature (Svix format used by Supabase Auth hooks).
 * Headers: webhook-id, webhook-timestamp, webhook-signature
 */
export function verifyStandardWebhook(opts: VerifyStandardWebhookOptions): { valid: boolean; error?: string } {
  const { headers, rawBody, secret, toleranceSeconds = 300 } = opts;
  const id = headers['webhook-id'] || headers['Webhook-Id'];
  const timestampStr = headers['webhook-timestamp'] || headers['Webhook-Timestamp'];
  const signature = headers['webhook-signature'] || headers['Webhook-Signature'];

  if (!id || !timestampStr || !signature) {
    return { valid: false, error: 'missing_webhook_headers' };
  }

  const timestamp = parseInt(timestampStr, 10);
  if (Number.isNaN(timestamp)) {
    return { valid: false, error: 'invalid_timestamp' };
  }

  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestamp) > toleranceSeconds) {
    return { valid: false, error: 'timestamp_outside_tolerance' };
  }

  const toSign = `${id}.${timestampStr}.${rawBody}`;

  // Candidate key buffers: handle whsec_ (base64), any even-length hex string, raw base64, and utf8
  const candidateKeys: Buffer[] = [];
  const cleanSecret = secret.trim();
  if (cleanSecret.startsWith('whsec_')) {
    candidateKeys.push(Buffer.from(cleanSecret.slice(6), 'base64'));
  }
  if (/^[0-9a-fA-F]+$/.test(cleanSecret) && cleanSecret.length % 2 === 0 && cleanSecret.length >= 16) {
    candidateKeys.push(Buffer.from(cleanSecret, 'hex'));
  }
  try {
    const b64Buf = Buffer.from(cleanSecret, 'base64');
    if (b64Buf.length > 0) candidateKeys.push(b64Buf);
  } catch {}
  candidateKeys.push(Buffer.from(cleanSecret, 'utf8'));

  const passedSignatures = signature.split(/\s+/).flatMap((s) => s.split(','));

  for (const key of candidateKeys) {
    if (!key || key.length === 0) continue;
    const expectedB64 = crypto.createHmac('sha256', key).update(toSign).digest('base64');
    const expectedHex = crypto.createHmac('sha256', key).update(toSign).digest('hex');

    for (const sig of passedSignatures) {
      const cleanSig = sig.startsWith('v1,') ? sig.slice(3) : sig;
      if (cleanSig === expectedB64 || cleanSig === expectedHex) {
        return { valid: true };
      }
    }
  }

  return { valid: false, error: 'signature_mismatch' };
}

/**
 * Verify SMS Gateway for Android webhook signature.
 * Headers: X-Signature, X-Timestamp
 */
export function verifyGatewayWebhook(opts: VerifyGatewayWebhookOptions): { valid: boolean; error?: string } {
  const { headers, rawBody, secret, toleranceSeconds = 300 } = opts;
  const signature = headers['x-signature'] || headers['X-Signature'];
  const timestampStr = headers['x-timestamp'] || headers['X-Timestamp'];

  if (!signature) {
    return { valid: false, error: 'missing_x_signature' };
  }

  if (timestampStr) {
    const timestamp = parseInt(timestampStr, 10);
    if (!Number.isNaN(timestamp)) {
      const now = Math.floor(Date.now() / 1000);
      if (Math.abs(now - timestamp) > toleranceSeconds) {
        return { valid: false, error: 'timestamp_outside_tolerance' };
      }
    }
  }

  // Gateway generates HMAC-SHA256 of the raw body using the shared signing secret
  const expectedHex = crypto.createHmac('sha256', Buffer.from(secret, 'utf8')).update(rawBody).digest('hex');

  const cleanPassed = signature.trim().toLowerCase();
  try {
    const isMatch = crypto.timingSafeEqual(
      Buffer.from(cleanPassed, 'utf8'),
      Buffer.from(expectedHex.toLowerCase(), 'utf8')
    );
    if (!isMatch) return { valid: false, error: 'signature_mismatch' };
  } catch {
    // If passed signature was raw token string instead of hex hmac, allow token comparison
    if (signature === secret) return { valid: true };
    return { valid: false, error: 'signature_mismatch' };
  }

  return { valid: true };
}
