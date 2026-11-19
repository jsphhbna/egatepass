/**
 * server/lib/candidate-token.ts
 *
 * Cryptographically signed, actor-bound candidate authorization tokens for returning visitor selection.
 *
 * Invariants:
 * 1. Bound to specific profileId, authenticated anonymous actorId, and time-limited TTL (default 300s).
 * 2. Signed with HMAC-SHA256 using dedicated RETURNING_MATCH_TOKEN_SECRET (>= 32 chars).
 * 3. Cannot authorize evidence/portrait preview at /api/passes/returning-photo-preview.
 * 4. Fails verification on expired timestamp, tampered signature, or actor mismatch.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
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

/**
 * Creates a signed candidate authorization token.
 * Format: cand.v1.<profileId>.<actorId>.<expiresAt>.<nonce>.<sig>
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
  const payloadToSign = `candidate:v1:${profileId}:${actorId}:${expiresAt}:${nonce}`;
  const sig = createHmac('sha256', secret.trim()).update(payloadToSign).digest('base64url');
  return `cand.v1.${profileId}.${actorId}.${expiresAt}.${nonce}.${sig}`;
}

/**
 * Verifies a candidate token against expected authenticated actor and secret.
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

  if (!token.startsWith('cand.v1.')) {
    return { valid: false, reason: 'unsupported_candidate_token_version', error: 'unsupported_candidate_token_version' };
  }

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
