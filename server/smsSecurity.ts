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

  // Extract base64 secret if prefixed with whsec_
  let keyBytes: Buffer;
  if (secret.startsWith('whsec_')) {
    keyBytes = Buffer.from(secret.slice(6), 'base64');
  } else {
    keyBytes = Buffer.from(secret, 'utf8');
  }

  const toSign = `${id}.${timestampStr}.${rawBody}`;
  const expectedHmac = crypto.createHmac('sha256', keyBytes).update(toSign).digest('base64');

  // Signature format in header: "v1,base64..." or space/comma separated list of signatures
  const passedSignatures = signature.split(/\s+/).flatMap((s) => s.split(','));
  const hasMatch = passedSignatures.some((sig) => {
    const cleanSig = sig.startsWith('v1,') ? sig.slice(3) : sig;
    try {
      return crypto.timingSafeEqual(Buffer.from(cleanSig, 'utf8'), Buffer.from(expectedHmac, 'utf8'));
    } catch {
      return false;
    }
  });

  if (!hasMatch) {
    return { valid: false, error: 'signature_mismatch' };
  }

  return { valid: true };
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
