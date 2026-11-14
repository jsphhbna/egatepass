/**
 * server/routes/passes/returning-photo-preview.ts
 *
 * Authorized Preview Endpoint for Historical Visitor Evidence:
 * Securely serves the original registration portrait or ID for a returning visitor profile.
 *
 * Security & Privacy Invariants:
 * 1. Tokens are cryptographically bound to profile ID, authenticated actor ID, and evidence kind.
 * 2. Requires an active authenticated session (Bearer token) matching the token's bound actor.
 * 3. Candidate lookup tokens ('previewToken') authorize ONLY 'photo' (portrait preview) and CANNOT retrieve ID evidence.
 * 4. Original ID retrieval requires a valid, calibrated face-match authorization and enforces
 *    atomic one-time consumption (anti-replay).
 * 5. In provisional mode, ID retrieval is strictly forbidden.
 * 6. Short, explicit token lifetime (maximum 300 seconds / 5 minutes).
 * 7. Dedicated secret (RETURNING_MATCH_TOKEN_SECRET >= 32 chars) with zero fallbacks to PASS_TOKEN_SECRET or defaults.
 * 8. Emits Cache-Control: private, no-store, max-age=0 to ensure privacy and prevent downstream caching.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { getVerifiedSessionContext, HttpError } from '../../actors.js';
import { jsonResponse, readBearerToken } from '../../http.js';
import { getServerSupabaseClients } from '../../supabase.js';
import { computeMatchTokenDigest } from './identify-returning.js';

const idSchema = z.string().uuid();

export interface CreatePreviewTokenOptions {
  profileId: string;
  actorId: string;
  kind?: 'photo' | 'id';
  ttlSeconds?: number;
}

/**
 * Creates a signed HMAC preview token cryptographically bound to profileId, actorId, and evidence kind.
 * Default TTL is 300 seconds (5 minutes). Maximum allowed TTL is 300 seconds.
 */
export function createPreviewToken(
  profileId: string,
  actorId: string,
  secret: string,
  ttlSeconds = 300,
  kind: 'photo' | 'id' = 'photo'
): string {
  if (!secret || secret.trim().length < 32) {
    throw new Error('RETURNING_MATCH_TOKEN_SECRET must be at least 32 characters.');
  }
  if (!idSchema.safeParse(profileId).success) {
    throw new Error('Invalid profileId UUID for preview token.');
  }
  if (!idSchema.safeParse(actorId).success) {
    throw new Error('Invalid actorId UUID for preview token.');
  }

  const boundedTtl = ttlSeconds <= 0 ? ttlSeconds : Math.min(ttlSeconds, 300);
  const expiresAt = Math.floor(Date.now() / 1000) + boundedTtl;
  const nonce = randomBytes(16).toString('hex');
  const payloadToSign = `preview:v3:${profileId}:${actorId}:${kind}:${expiresAt}:${nonce}`;
  const sig = createHmac('sha256', secret.trim()).update(payloadToSign).digest('base64url');
  return `v3.${profileId}.${actorId}.${kind}.${expiresAt}.${nonce}.${sig}`;
}

/**
 * Verifies an actor-bound preview token and returns the bound attributes if valid.
 */
export function verifyPreviewToken(
  token: string,
  expectedActorId: string,
  secret: string
): { valid: boolean; profileId?: string; actorId?: string; kind?: 'photo' | 'id'; expired?: boolean; reason?: string; error?: string } {
  if (!token || typeof token !== 'string') return { valid: false, reason: 'missing_token', error: 'missing_token' };
  if (!secret || secret.trim().length < 32) return { valid: false, reason: 'insecure_secret', error: 'insecure_secret' };
  if (!expectedActorId || !idSchema.safeParse(expectedActorId).success) {
    return { valid: false, reason: 'invalid_expected_actor', error: 'invalid_expected_actor' };
  }

  // Format v3: v3.<profileId>.<actorId>.<kind>.<expiresAt>.<nonce>.<sig>
  if (token.startsWith('v3.')) {
    const parts = token.split('.');
    if (parts.length !== 7) return { valid: false, reason: 'malformed_v3_token', error: 'malformed_v3_token' };
    const [, profileId, actorId, kindStr, expStr, nonce, sig] = parts;
    if (!profileId || !actorId || !kindStr || !expStr || !nonce || !sig) {
      return { valid: false, reason: 'incomplete_v3_token', error: 'incomplete_v3_token' };
    }
    if (!idSchema.safeParse(profileId).success || !idSchema.safeParse(actorId).success) {
      return { valid: false, reason: 'invalid_token_uuids', error: 'invalid_token_uuids' };
    }
    if (kindStr !== 'photo' && kindStr !== 'id') {
      return { valid: false, reason: 'invalid_token_kind', error: 'invalid_token_kind' };
    }

    // Strict actor binding check: token actor must match session actor
    if (actorId !== expectedActorId) {
      return { valid: false, reason: 'actor_mismatch', error: 'actor_mismatch' };
    }

    const exp = parseInt(expStr, 10);
    if (!Number.isFinite(exp)) return { valid: false, reason: 'invalid_expiration', error: 'invalid_expiration' };
    if (exp < Math.floor(Date.now() / 1000)) {
      return { valid: false, expired: true, reason: 'token_expired', error: 'token_expired' };
    }

    const payloadToSign = `preview:v3:${profileId}:${actorId}:${kindStr}:${expStr}:${nonce}`;
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

    return { valid: true, profileId, actorId, kind: kindStr as 'photo' | 'id' };
  }

  return { valid: false, reason: 'unsupported_token_version', error: 'unsupported_token_version' };
}

async function handleRequest(request: Request): Promise<Response> {
  if (request.method !== 'GET') {
    return jsonResponse(405, { error: 'method_not_allowed' }, { Allow: 'GET' });
  }

  const url = new URL(request.url);
  const profileIdParam = url.searchParams.get('profileId')?.trim();
  const tokenParam = url.searchParams.get('token')?.trim();
  const requestedKind: 'photo' | 'id' = url.searchParams.get('kind')?.trim() === 'id' ? 'id' : 'photo';

  const { admin } = getServerSupabaseClients();

  // Enforce dedicated secret: no fallbacks to PASS_TOKEN_SECRET or defaults
  const dedicatedSecret = process.env.RETURNING_MATCH_TOKEN_SECRET?.trim();
  if (!dedicatedSecret || dedicatedSecret.length < 32) {
    console.error('RETURNING_MATCH_TOKEN_SECRET missing or insecure in returning-photo-preview');
    return jsonResponse(503, {
      error: 'signing_key_unavailable',
      message: 'Returning visitor preview service is temporarily unavailable.',
    });
  }

  // Enforce session authentication (Bearer token required)
  const bearer = readBearerToken(request);
  if (!bearer) {
    return jsonResponse(401, {
      error: 'authentication_required',
      message: 'Active visitor or staff session required to access evidence preview.',
    });
  }

  let session;
  try {
    session = await getVerifiedSessionContext(admin, bearer);
  } catch (err) {
    if (err instanceof HttpError) return jsonResponse(err.status, { error: err.code });
    return jsonResponse(401, { error: 'invalid_session' });
  }

  if (session.isRecoverySession) {
    return jsonResponse(403, { error: 'recovery_session_not_permitted' });
  }

  const currentActorId = session.user.id;
  let authorized = false;
  let resolvedProfileId: string | null = null;

  // 1. Verify candidate lookup previewToken (v3 format with actor binding)
  if (tokenParam && tokenParam.startsWith('v3.')) {
    const previewRes = verifyPreviewToken(tokenParam, currentActorId, dedicatedSecret);
    if (previewRes.valid && previewRes.profileId) {
      if (profileIdParam && profileIdParam !== previewRes.profileId) {
        return jsonResponse(403, { error: 'profile_id_mismatch' });
      }
      // Critical check: previewToken must match requested kind
      if (previewRes.kind !== requestedKind) {
        return jsonResponse(403, { error: 'forbidden_evidence_kind' });
      }
      // Candidate lookup preview tokens CANNOT retrieve ID evidence under any circumstance
      if (requestedKind === 'id') {
        return jsonResponse(403, { error: 'id_preview_requires_calibrated_match' });
      }
      authorized = true;
      resolvedProfileId = previewRes.profileId;
    } else if (previewRes.reason === 'actor_mismatch') {
      return jsonResponse(403, {
        error: 'actor_mismatch',
        message: 'Preview token does not belong to the current authenticated session.',
      });
    } else if (previewRes.expired) {
      return jsonResponse(403, { error: 'preview_token_expired' });
    } else {
      return jsonResponse(403, { error: 'invalid_preview_token' });
    }
  }

  // 2. Check if token is a matchToken (issued by identify-returning)
  if (!authorized && tokenParam && !tokenParam.includes('.')) {
    const digest = computeMatchTokenDigest(tokenParam, dedicatedSecret);
    const { data: attempt } = await admin
      .from('returning_identity_attempts')
      .select('id, owner_id, matched_profile_id, outcome, threshold_mode, expires_at, id_preview_consumed_at')
      .eq('match_token_digest', digest)
      .gt('expires_at', new Date().toISOString())
      .limit(1)
      .maybeSingle();

    if (attempt && attempt.matched_profile_id) {
      // Actor binding check: attempt owner_id must match authenticated session actor
      if (attempt.owner_id !== currentActorId) {
        return jsonResponse(403, {
          error: 'actor_mismatch',
          message: 'Match token does not belong to the current authenticated session.',
        });
      }

      if (profileIdParam && profileIdParam !== attempt.matched_profile_id) {
        return jsonResponse(403, { error: 'profile_id_mismatch' });
      }

      resolvedProfileId = attempt.matched_profile_id;

      if (requestedKind === 'id') {
        // ID access requirements:
        // A. Verification must be CALIBRATED and MATCHED (Provisional mode CANNOT authorize ID access)
        if (attempt.threshold_mode !== 'calibrated' || attempt.outcome !== 'matched') {
          return jsonResponse(403, {
            error: 'provisional_mode_cannot_authorize_id_access',
            message: 'Provisional biometric verification cannot authorize identification document access.',
          });
        }

        // B. Atomic single-use consumption (anti-replay)
        if (attempt.id_preview_consumed_at) {
          return jsonResponse(403, {
            error: 'id_authorization_already_consumed',
            message: 'Identification preview authorization has already been consumed.',
          });
        }

        const { data: consumed, error: consumeErr } = await admin.schema('api').rpc('consume_id_preview_authorization_v1', {
          requested_profile_id: resolvedProfileId,
          requested_match_token_digest: digest,
          requested_actor_id: currentActorId,
        });

        if (consumeErr || !consumed) {
          return jsonResponse(403, {
            error: 'id_authorization_already_consumed',
            message: 'Identification preview authorization has already been consumed or is invalid.',
          });
        }

        authorized = true;
      } else {
        // Portrait preview authorized via valid match attempt
        authorized = true;
      }
    }
  }

  // 3. Fallback: Authenticated staff (admin/superadmin) or active guard station device
  if (!authorized && session && !session.isAnonymous) {
    const { data: staff } = await admin
      .from('staff_profiles')
      .select('role, active, must_change_password')
      .eq('user_id', currentActorId)
      .maybeSingle();

    if (staff && staff.active && !staff.must_change_password && ['admin', 'superadmin'].includes(staff.role)) {
      authorized = true;
      resolvedProfileId = profileIdParam || null;
    } else {
      const { data: device } = await admin
        .from('devices')
        .select('status, type')
        .eq('user_id', currentActorId)
        .maybeSingle();

      if (device && device.status === 'active' && device.type === 'guard_station') {
        authorized = true;
        resolvedProfileId = profileIdParam || null;
      }
    }
  }

  if (!authorized || !resolvedProfileId || !idSchema.safeParse(resolvedProfileId).success) {
    return jsonResponse(403, { error: 'unauthorized_preview_access' });
  }

  // Find earliest visitor_evidence of requested kind for this returning profile
  const { data: visitors, error: vErr } = await admin
    .from('visitors')
    .select('id')
    .eq('returning_profile_id', resolvedProfileId);

  if (vErr) {
    console.error('Error fetching visitors for profile preview:', vErr);
    return jsonResponse(500, { error: 'database_error' });
  }

  let vIds = (visitors || []).map((v) => v.id);
  if (vIds.length === 0) {
    // Secondary fallback lookup: if returning_profile_id was not directly linked on historical visitor records,
    // match by profile first_name, last_name, and contact_number_e164
    const { data: profile } = await admin
      .from('returning_visitor_profiles')
      .select('first_name, last_name, contact_number_e164')
      .eq('id', resolvedProfileId)
      .maybeSingle();

    if (profile) {
      const fullName = `${profile.first_name} ${profile.last_name}`.trim();
      const { data: fallbackVisitors } = await admin
        .from('visitors')
        .select('id')
        .eq('contact_number', profile.contact_number_e164)
        .ilike('full_name', fullName)
        .order('created_at', { ascending: true })
        .limit(5);

      if (fallbackVisitors && fallbackVisitors.length > 0) {
        vIds = fallbackVisitors.map((v) => v.id);
      }
    }
  }

  if (vIds.length === 0) {
    return jsonResponse(404, { error: 'preview_unavailable', message: 'No registration records found for profile.' });
  }

  const { data: evidence, error: evErr } = await admin
    .from('visitor_evidence')
    .select('bucket_id, object_path, content_type, purged_at, expires_at, created_at')
    .in('visitor_id', vIds)
    .eq('kind', requestedKind)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();

  if (evErr) {
    console.error('Error fetching visitor evidence for profile preview:', evErr);
    return jsonResponse(500, { error: 'database_error' });
  }

  if (!evidence) {
    return jsonResponse(404, { error: 'preview_unavailable', message: 'Evidence not found.' });
  }

  // Retention check: if evidence was purged or expired under the retention policy, return 410 Gone
  const now = new Date();
  const isPurged = Boolean(evidence.purged_at);
  const isExpired = Boolean(evidence.expires_at && new Date(evidence.expires_at) <= now);

  if (isPurged || isExpired) {
    return jsonResponse(410, {
      error: 'photo_expired_under_retention',
      message: 'Original portrait was removed under retention policy.',
    });
  }

  const downloaded = await admin.storage.from(evidence.bucket_id).download(evidence.object_path);
  if (downloaded.error || !downloaded.data) {
    return jsonResponse(404, { error: 'preview_unavailable', message: 'Object not found in storage.' });
  }

  const bytes = new Uint8Array(await downloaded.data.arrayBuffer());
  return new Response(bytes, {
    status: 200,
    headers: {
      'Content-Type': evidence.content_type || 'image/jpeg',
      'Content-Length': String(bytes.length),
      'Cache-Control': 'private, no-store, max-age=0',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

export default { fetch: handleRequest };
