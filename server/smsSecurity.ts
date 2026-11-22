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
      if (cleanSig.length === expectedB64.length && crypto.timingSafeEqual(Buffer.from(cleanSig), Buffer.from(expectedB64))) {
        return { valid: true };
      }
      if (cleanSig.length === expectedHex.length && crypto.timingSafeEqual(Buffer.from(cleanSig.toLowerCase()), Buffer.from(expectedHex.toLowerCase()))) {
        return { valid: true };
      }
    }
  }

  return { valid: false, error: 'signature_mismatch' };
}

/**
 * Verify SMS Gateway for Android webhook signature.
 * Headers: X-Signature, X-Timestamp
 * Hardened: Strict timestamp validation (finite, positive, <= tolerance), constant-time signature comparison across candidate formats
 */
export function verifyGatewayWebhook(opts: VerifyGatewayWebhookOptions): { valid: boolean; error?: string } {
  const { headers, rawBody, secret, toleranceSeconds = 300 } = opts;
  if (!secret || secret.trim() === '') {
    return { valid: false, error: 'signing_key_not_configured' };
  }

  const signature = headers['x-signature'] || headers['X-Signature'];
  const timestampStr = headers['x-timestamp'] || headers['X-Timestamp'];

  if (!signature) {
    return { valid: false, error: 'missing_x_signature' };
  }

  if (!timestampStr) {
    return { valid: false, error: 'missing_x_timestamp' };
  }

  const timestamp = parseInt(timestampStr.trim(), 10);
  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    return { valid: false, error: 'invalid_timestamp' };
  }

  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestamp) > toleranceSeconds) {
    return { valid: false, error: 'timestamp_outside_tolerance' };
  }

  // Candidate HMACs:
  // 1) HMAC of rawBody
  // 2) HMAC of `${timestampStr}.${rawBody}`
  const expectedHexBody = crypto.createHmac('sha256', Buffer.from(secret, 'utf8')).update(rawBody).digest('hex');
  const expectedHexTsBody = crypto.createHmac('sha256', Buffer.from(secret, 'utf8')).update(`${timestampStr}.${rawBody}`).digest('hex');

  const cleanPassed = signature.trim().toLowerCase();
  const passedBuf = Buffer.from(cleanPassed, 'utf8');

  for (const expectedHex of [expectedHexBody, expectedHexTsBody]) {
    const expectedBuf = Buffer.from(expectedHex.toLowerCase(), 'utf8');
    if (passedBuf.length === expectedBuf.length && crypto.timingSafeEqual(passedBuf, expectedBuf)) {
      return { valid: true };
    }
  }

  // Direct secret token match using timing-safe comparison
  const secretBuf = Buffer.from(secret.trim(), 'utf8');
  const rawSigBuf = Buffer.from(signature.trim(), 'utf8');
  if (rawSigBuf.length === secretBuf.length && crypto.timingSafeEqual(rawSigBuf, secretBuf)) {
    return { valid: true };
  }

  return { valid: false, error: 'signature_mismatch' };
}
