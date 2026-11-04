/**
 * server/routes/passes/returning-photo-preview.ts
 *
 * Authorized Preview Endpoint for Historical Visitor Evidence:
 * Securely serves the original registration portrait or ID for a returning visitor profile.
 *
 * Security & Privacy Invariants:
 * 1. Tokens are strictly bound to exact profile ID and exact evidence kind ('photo' vs 'id').
 * 2. Candidate lookup tokens ('previewToken') authorize ONLY 'photo' (portrait preview).
 *    They can NEVER authorize ID image retrieval.
 * 3. Original ID retrieval requires a valid, calibrated face-match authorization and enforces
 *    atomic one-time consumption (anti-replay).
 * 4. In provisional mode, ID retrieval is strictly forbidden.
 * 5. Short, explicit token lifetime (300 seconds / 5 minutes).
 * 6. Emits Cache-Control: private, no-store, max-age=0 to ensure privacy and prevent downstream caching.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { getVerifiedSessionContext } from '../../actors.js';
import { jsonResponse, readBearerToken } from '../../http.js';
import { getServerSupabaseClients } from '../../supabase.js';
import { computeMatchTokenDigest } from './identify-returning.js';

const idSchema = z.string().uuid();

export interface CreatePreviewTokenOptions {
  profileId: string;
  kind?: 'photo' | 'id';
  actorId?: string;
  ttlSeconds?: number;
}

/**
 * Creates a signed HMAC preview token strictly bound to profileId and evidence kind.
 * Default TTL is 300 seconds (5 minutes).
 */
export function createPreviewToken(
  profileId: string,
  secret: string,
  ttlSeconds = 300,
  kind: 'photo' | 'id' = 'photo'
): string {
  const expiresAt = Math.floor(Date.now() / 1000) + ttlSeconds;
  const nonce = randomBytes(8).toString('hex');
  const payloadToSign = `preview:v2:${profileId}:${kind}:${expiresAt}:${nonce}`;
  const sig = createHmac('sha256', secret).update(payloadToSign).digest('base64url');
  return `v2.${profileId}.${kind}.${expiresAt}.${nonce}.${sig}`;
}

/**
 * Verifies a preview token and returns the bound profileId and kind if valid.
 */
export function verifyPreviewToken(
  token: string,
  secret: string
): { valid: boolean; profileId?: string; kind?: 'photo' | 'id'; expired?: boolean } {
  if (!token) return { valid: false };

  // Support v2 format: v2.<profileId>.<kind>.<expiresAt>.<nonce>.<sig>
  if (token.startsWith('v2.')) {
    const parts = token.split('.');
    if (parts.length !== 6) return { valid: false };
    const [, profileId, kindStr, expStr, nonce, sig] = parts;
    if (!profileId || !kindStr || !expStr || !nonce || !sig) return { valid: false };
    if (!idSchema.safeParse(profileId).success) return { valid: false };
    if (kindStr !== 'photo' && kindStr !== 'id') return { valid: false };

    const exp = parseInt(expStr, 10);
    if (!Number.isFinite(exp)) return { valid: false };
    if (exp < Math.floor(Date.now() / 1000)) return { valid: false, expired: true };

    const payloadToSign = `preview:v2:${profileId}:${kindStr}:${expStr}:${nonce}`;
    const expectedSig = createHmac('sha256', secret).update(payloadToSign).digest('base64url');
    try {
      const a = Buffer.from(sig);
      const b = Buffer.from(expectedSig);
      if (a.length !== b.length || !timingSafeEqual(a, b)) return { valid: false };
    } catch {
      return { valid: false };
    }

    return { valid: true, profileId, kind: kindStr as 'photo' | 'id' };
  }

  // Legacy fallback (v1): <profileId>.<expiresAt>.<sig> -> bound ONLY to 'photo'
  const parts = token.split('.');
  if (parts.length === 3) {
    const [profileId, expStr, sig] = parts;
    if (!profileId || !expStr || !sig) return { valid: false };
    if (!idSchema.safeParse(profileId).success) return { valid: false };
    const exp = parseInt(expStr, 10);
    if (!Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) return { valid: false, expired: true };
    const expectedSig = createHmac('sha256', secret).update(`preview:${profileId}:${expStr}`).digest('base64url');
    try {
      const a = Buffer.from(sig);
      const b = Buffer.from(expectedSig);
      if (a.length !== b.length || !timingSafeEqual(a, b)) return { valid: false };
    } catch {
      return { valid: false };
    }
    // Legacy tokens NEVER authorize ID retrieval
    return { valid: true, profileId, kind: 'photo' };
  }

  return { valid: false };
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
  const tokenSecret = process.env.PASS_TOKEN_SECRET || process.env.RETURNING_MATCH_TOKEN_SECRET || 'egatepass-fallback-secret-for-tokens-32chars!';
  const matchSecret = process.env.RETURNING_MATCH_TOKEN_SECRET || '';

  let authorized = false;
  let resolvedProfileId: string | null = null;

  // 1. Check if token is a previewToken
  if (tokenParam && tokenParam.includes('.')) {
    const previewRes = verifyPreviewToken(tokenParam, tokenSecret);
    if (previewRes.valid && previewRes.profileId) {
      if (profileIdParam && profileIdParam !== previewRes.profileId) {
        return jsonResponse(403, { error: 'profile_id_mismatch' });
      }
      // Critical check: previewToken must match the requested kind!
      if (previewRes.kind !== requestedKind) {
        return jsonResponse(403, { error: 'forbidden_evidence_kind' });
      }
      // Candidate lookup preview tokens CANNOT retrieve ID evidence under any circumstance
      if (requestedKind === 'id') {
        return jsonResponse(403, { error: 'id_preview_requires_calibrated_match' });
      }
      authorized = true;
      resolvedProfileId = previewRes.profileId;
    } else if (previewRes.expired) {
      return jsonResponse(403, { error: 'preview_token_expired' });
    }
  }

  // 2. Check if token is a matchToken (issued by identify-returning)
  if (!authorized && tokenParam && matchSecret) {
    const digest = computeMatchTokenDigest(tokenParam, matchSecret);
    const { data: attempt } = await admin
      .from('returning_identity_attempts')
      .select('id, owner_id, matched_profile_id, outcome, threshold_mode, expires_at, id_preview_consumed_at')
      .eq('match_token_digest', digest)
      .gt('expires_at', new Date().toISOString())
      .limit(1)
      .maybeSingle();

    if (attempt && attempt.matched_profile_id) {
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
          requested_actor_id: attempt.owner_id,
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
  if (!authorized) {
    const bearer = readBearerToken(request);
    if (bearer) {
      try {
        const session = await getVerifiedSessionContext(admin, bearer);
        if (!session.isRecoverySession && !session.isAnonymous) {
          const { data: staff } = await admin
            .from('staff_profiles')
            .select('role, active, must_change_password')
            .eq('user_id', session.user.id)
            .maybeSingle();

          if (staff && staff.active && !staff.must_change_password && ['admin', 'superadmin'].includes(staff.role)) {
            authorized = true;
            resolvedProfileId = profileIdParam || null;
          } else {
            const { data: device } = await admin
              .from('devices')
              .select('status, type')
              .eq('user_id', session.user.id)
              .maybeSingle();

            if (device && device.status === 'active' && device.type === 'guard_station') {
              authorized = true;
              resolvedProfileId = profileIdParam || null;
            }
          }
        }
      } catch {
        // Bearer validation failed
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

  const vIds = (visitors || []).map((v) => v.id);
  if (vIds.length === 0) {
    return jsonResponse(404, { error: 'preview_unavailable' });
  }

  const { data: evidence, error: evErr } = await admin
    .from('visitor_evidence')
    .select('bucket_id, object_path, content_type')
    .in('visitor_id', vIds)
    .eq('kind', requestedKind)
    .is('purged_at', null)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();

  if (evErr || !evidence) {
    return jsonResponse(404, { error: 'preview_unavailable' });
  }

  const downloaded = await admin.storage.from(evidence.bucket_id).download(evidence.object_path);
  if (downloaded.error || !downloaded.data) {
    return jsonResponse(404, { error: 'preview_unavailable' });
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
