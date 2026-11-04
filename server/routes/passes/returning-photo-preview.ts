/**
 * server/routes/passes/returning-photo-preview.ts
 *
 * Authorized Preview Endpoint for Historical Visitor Evidence:
 * Securely serves the original registration portrait or ID for a returning visitor profile.
 *
 * Authorization models:
 * 1. previewToken: signed HMAC token issued by lookup-returning.ts during candidate search (Step 1).
 * 2. matchToken: opaque token issued by identify-returning.ts after successful 1:1 biometric match.
 * 3. Authenticated staff session (admin/superadmin) or active guard station device.
 *
 * Emits Cache-Control: private, no-store, max-age=0 to ensure privacy and prevent downstream caching.
 */

import { createHmac } from 'node:crypto';
import { z } from 'zod';
import { getVerifiedSessionContext } from '../../actors.js';
import { jsonResponse, readBearerToken } from '../../http.js';
import { getServerSupabaseClients } from '../../supabase.js';
import { computeMatchTokenDigest } from './identify-returning.js';

const idSchema = z.string().uuid();

export function createPreviewToken(profileId: string, secret: string, ttlSeconds = 900): string {
  const expiresAt = Math.floor(Date.now() / 1000) + ttlSeconds;
  const payload = `${profileId}:${expiresAt}`;
  const sig = createHmac('sha256', secret).update(`preview:${payload}`).digest('base64url');
  return `${profileId}.${expiresAt}.${sig}`;
}

export function verifyPreviewToken(token: string, secret: string): { valid: boolean; profileId?: string } {
  const parts = token.split('.');
  if (parts.length !== 3) return { valid: false };
  const [profileId, expStr, sig] = parts;
  if (!profileId || !expStr || !sig) return { valid: false };
  if (!idSchema.safeParse(profileId).success) return { valid: false };
  const exp = parseInt(expStr, 10);
  if (!Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) return { valid: false };
  const expectedSig = createHmac('sha256', secret).update(`preview:${profileId}:${expStr}`).digest('base64url');
  if (sig !== expectedSig) return { valid: false };
  return { valid: true, profileId };
}

async function handleRequest(request: Request): Promise<Response> {
  if (request.method !== 'GET') {
    return jsonResponse(405, { error: 'method_not_allowed' }, { Allow: 'GET' });
  }

  const url = new URL(request.url);
  const profileId = url.searchParams.get('profileId')?.trim();
  const tokenParam = url.searchParams.get('token')?.trim();
  const kind = url.searchParams.get('kind')?.trim() === 'id' ? 'id' : 'photo';

  if (!profileId || !idSchema.safeParse(profileId).success) {
    return jsonResponse(400, { error: 'invalid_profile_id' });
  }

  const { admin } = getServerSupabaseClients();
  const tokenSecret = process.env.PASS_TOKEN_SECRET || process.env.RETURNING_MATCH_TOKEN_SECRET || 'egatepass-fallback-secret-for-tokens-32chars!';
  const matchSecret = process.env.RETURNING_MATCH_TOKEN_SECRET || '';

  let authorized = false;

  // 1. Check if valid previewToken
  if (tokenParam && tokenParam.includes('.')) {
    const previewRes = verifyPreviewToken(tokenParam, tokenSecret);
    if (previewRes.valid && previewRes.profileId === profileId) {
      authorized = true;
    }
  }

  // 2. Check if valid matchToken
  if (!authorized && tokenParam && matchSecret) {
    const digest = computeMatchTokenDigest(tokenParam, matchSecret);
    const { data: attempt } = await admin
      .from('returning_identity_attempts')
      .select('id, expires_at')
      .eq('matched_profile_id', profileId)
      .eq('match_token_digest', digest)
      .eq('outcome', 'matched')
      .gt('expires_at', new Date().toISOString())
      .limit(1)
      .maybeSingle();

    if (attempt) {
      authorized = true;
    }
  }

  // 3. Fallback to Bearer token authentication (staff or guard station)
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
          } else {
            const { data: device } = await admin
              .from('devices')
              .select('status, type')
              .eq('user_id', session.user.id)
              .maybeSingle();

            if (device && device.status === 'active' && device.type === 'guard_station') {
              authorized = true;
            }
          }
        }
      } catch {
        // Bearer validation failed
      }
    }
  }

  if (!authorized) {
    return jsonResponse(401, { error: 'unauthorized_preview_access' });
  }

  // Find earliest visitor_evidence of requested kind for this returning profile
  const { data: visitors, error: vErr } = await admin
    .from('visitors')
    .select('id')
    .eq('returning_profile_id', profileId);

  if (vErr) {
    console.error('Error fetching visitors for profile preview:', vErr);
    return jsonResponse(500, { error: 'database_error' });
  }

  const vIds = (visitors || []).map((v) => v.id);
  if (vIds.length === 0) {
    return jsonResponse(404, { error: 'no_historical_evidence_found' });
  }

  const { data: evidence, error: evErr } = await admin
    .from('visitor_evidence')
    .select('bucket_id, object_path, content_type')
    .in('visitor_id', vIds)
    .eq('kind', kind)
    .is('purged_at', null)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();

  if (evErr || !evidence) {
    return jsonResponse(404, { error: 'evidence_not_found_or_purged' });
  }

  const downloaded = await admin.storage.from(evidence.bucket_id).download(evidence.object_path);
  if (downloaded.error || !downloaded.data) {
    return jsonResponse(404, { error: 'storage_object_missing' });
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
