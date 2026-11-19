/**
 * server/lib/candidate-token.ts
 *
 * Genuinely opaque, cryptographically authenticated, actor-bound candidate authorization tokens
 * for returning visitor selection using AES-256-GCM.
 *
 * Security & Integrity Invariants:
 * 1. Bound to specific profileId, authenticated anonymous actorId, and time-limited TTL (default 300s).
 * 2. Authenticated encryption with AES-256-GCM using dedicated RETURNING_MATCH_TOKEN_SECRET (>= 32 chars).
 * 3. Genuinely opaque: raw profile UUID and actor UUID are encrypted in ciphertext and NEVER visible in plaintext.
 * 4. Cannot authorize evidence/portrait preview at /api/passes/returning-photo-preview.
 * 5. Fails verification on expired timestamp, tampered ciphertext/auth tag, or actor mismatch.
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { z } from 'zod';

const uuidSchema = z.string().uuid();

export interface CandidateTokenVerification {
  valid: boolean;
  profileId?: string;
  actorId?: string;
  expiresAt?: number;
  expired?: boolean;
  reason?: string;
  error?: string;
}

function deriveEncryptionKey(secret: string): Buffer {
  return createHash('sha256').update(`candidate-token-enc-v2:${secret.trim()}`).digest();
}

/**
 * Creates an opaque, authenticated encrypted candidate authorization token (cand.v2).
 * The profile UUID and actor UUID are fully encrypted under AES-256-GCM and cannot be inspected by the client.
 * Format: cand.v2.<iv_b64url>.<ciphertext_b64url>.<tag_b64url>
 */
export function createCandidateToken(
  profileId: string,
  actorId: string,
  secret: string,
  ttlSeconds = 300
): string {
  if (!secret || secret.trim().length < 32) {
    throw new Error('RETURNING_MATCH_TOKEN_SECRET must be at least 32 characters.');
  }
  if (!uuidSchema.safeParse(profileId).success) {
    throw new Error('Invalid profileId UUID for candidate token.');
  }
  if (!uuidSchema.safeParse(actorId).success) {
    throw new Error('Invalid actorId UUID for candidate token.');
  }

  const boundedTtl = ttlSeconds <= 0 ? ttlSeconds : Math.min(ttlSeconds, 300);
  const expiresAt = Math.floor(Date.now() / 1000) + boundedTtl;
  const nonce = randomBytes(16).toString('hex');

  const key = deriveEncryptionKey(secret);
  const iv = randomBytes(12);

  const payload = JSON.stringify({
    profileId,
    actorId,
    exp: expiresAt,
    nonce,
  });

  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from('cand.v2', 'utf8'));

  const ciphertext = Buffer.concat([cipher.update(payload, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return `cand.v2.${iv.toString('base64url')}.${ciphertext.toString('base64url')}.${tag.toString('base64url')}`;
}

/**
 * Verifies a candidate token against expected authenticated actor and secret.
 * Supports both opaque cand.v2 (AES-256-GCM) and legacy cand.v1 (HMAC-SHA256).
 */
export function verifyCandidateToken(
  token: string,
  expectedActorId: string,
  secret: string
): CandidateTokenVerification {
  if (!token || typeof token !== 'string') {
    return { valid: false, reason: 'missing_token', error: 'missing_token' };
  }
  if (!secret || secret.trim().length < 32) {
    return { valid: false, reason: 'insecure_secret', error: 'insecure_secret' };
  }
  if (!expectedActorId || !uuidSchema.safeParse(expectedActorId).success) {
    return { valid: false, reason: 'invalid_expected_actor', error: 'invalid_expected_actor' };
  }

  // Handle cand.v2 (AES-256-GCM authenticated encrypted token)
  if (token.startsWith('cand.v2.')) {
    const parts = token.split('.');
    if (parts.length !== 5) {
      return { valid: false, reason: 'malformed_candidate_token', error: 'malformed_candidate_token' };
    }

    const [, , ivB64, cipherB64, tagB64] = parts;
    if (!ivB64 || !cipherB64 || !tagB64) {
      return { valid: false, reason: 'incomplete_candidate_token', error: 'incomplete_candidate_token' };
    }

    try {
      const key = deriveEncryptionKey(secret);
      const iv = Buffer.from(ivB64, 'base64url');
      const ciphertext = Buffer.from(cipherB64, 'base64url');
      const tag = Buffer.from(tagB64, 'base64url');

      if (iv.length !== 12 || tag.length !== 16) {
        return { valid: false, reason: 'invalid_token_dimensions', error: 'signature_mismatch' };
      }

      const decipher = createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAAD(Buffer.from('cand.v2', 'utf8'));
      decipher.setAuthTag(tag);

      const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      const data = JSON.parse(decrypted.toString('utf8'));

      if (!data || typeof data !== 'object') {
        return { valid: false, reason: 'invalid_payload', error: 'signature_mismatch' };
      }

      const { profileId, actorId, exp } = data;

      if (!uuidSchema.safeParse(profileId).success || !uuidSchema.safeParse(actorId).success) {
        return { valid: false, reason: 'invalid_token_uuids', error: 'invalid_token_uuids' };
      }

      // Strict actor binding check
      if (actorId !== expectedActorId) {
        return { valid: false, reason: 'actor_mismatch', error: 'actor_mismatch' };
      }

      if (!Number.isFinite(exp)) {
        return { valid: false, reason: 'invalid_expiration', error: 'invalid_expiration' };
      }

      if (exp < Math.floor(Date.now() / 1000)) {
        return { valid: false, expired: true, reason: 'token_expired', error: 'candidate_token_expired' };
      }

      return {
        valid: true,
        profileId,
        actorId,
        expiresAt: exp,
      };
    } catch {
      return { valid: false, reason: 'verification_failed', error: 'signature_mismatch' };
    }
  }

  // Handle legacy cand.v1 (HMAC-SHA256)
  if (token.startsWith('cand.v1.')) {
    const parts = token.split('.');
    if (parts.length !== 7) {
      return { valid: false, reason: 'malformed_candidate_token', error: 'malformed_candidate_token' };
    }

    const [, , profileId, actorId, expStr, nonce, sig] = parts;
    if (!profileId || !actorId || !expStr || !nonce || !sig) {
      return { valid: false, reason: 'incomplete_candidate_token', error: 'incomplete_candidate_token' };
    }

    if (!uuidSchema.safeParse(profileId).success || !uuidSchema.safeParse(actorId).success) {
      return { valid: false, reason: 'invalid_token_uuids', error: 'invalid_token_uuids' };
    }

    // Strict actor binding check
    if (actorId !== expectedActorId) {
      return { valid: false, reason: 'actor_mismatch', error: 'actor_mismatch' };
    }

    const exp = parseInt(expStr, 10);
    if (!Number.isFinite(exp)) {
      return { valid: false, reason: 'invalid_expiration', error: 'invalid_expiration' };
    }

    if (exp < Math.floor(Date.now() / 1000)) {
      return { valid: false, expired: true, reason: 'token_expired', error: 'candidate_token_expired' };
    }

    const payloadToSign = `candidate:v1:${profileId}:${actorId}:${expStr}:${nonce}`;
    const expectedSig = createHmac('sha256', secret.trim()).update(payloadToSign).digest('base64url');

    try {
      const a = Buffer.from(sig);
      const b = Buffer.from(expectedSig);
      if (a.length !== b.length || !timingSafeEqual(a, b)) {
        return { valid: false, reason: 'signature_mismatch', error: 'signature_mismatch' };
      }
    } catch {
      return { valid: false, reason: 'verification_failed', error: 'verification_failed' };
    }

    return {
      valid: true,
      profileId,
      actorId,
      expiresAt: exp,
    };
  }

  return { valid: false, reason: 'unsupported_candidate_token_version', error: 'unsupported_candidate_token_version' };
}
