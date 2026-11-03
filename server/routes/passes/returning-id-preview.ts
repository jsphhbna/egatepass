/**
 * server/routes/passes/returning-id-preview.ts
 *
 * Secure Historical ID Preview Endpoint:
 * Allows a verified returning visitor to view their previously submitted ID
 * strictly AFTER passing 1:1 biometric identity verification.
 *
 * Security Boundaries:
 * - Requires anonymous visitor bearer session.
 * - Enforces cryptographically verified single-use match token binding to requestId, actor, and profile.
 * - Checks unrevoked returning profile and unexpired / unpurged retention lifecycle.
 * - Streams image bytes directly without exposing storage paths, signed URLs, or service-role keys.
 */

import { z } from 'zod';
import { jsonResponse, readBearerToken } from '../../http.js';
import { getVerifiedSessionContext, HttpError } from '../../actors.js';
import { getServerSupabaseClients } from '../../supabase.js';
import { computeMatchTokenDigest } from './identify-returning.js';

const querySchema = z.object({
  profileId: z.string().uuid(),
  requestId: z.string().uuid(),
  matchToken: z.string().min(16),
});

async function handleRequest(request: Request): Promise<Response> {
  if (request.method !== 'GET') {
    return jsonResponse(405, { error: 'method_not_allowed' }, { Allow: 'GET' });
  }

  const token = readBearerToken(request);
  if (!token) {
    return jsonResponse(401, { error: 'authentication_required' });
  }

  const url = new URL(request.url);
  const parsed = querySchema.safeParse({
    profileId: url.searchParams.get('profileId'),
    requestId: url.searchParams.get('requestId'),
    matchToken: url.searchParams.get('matchToken'),
  });

  if (!parsed.success) {
    return jsonResponse(400, { error: 'invalid_request' });
  }

  const { profileId, requestId, matchToken } = parsed.data;

  try {
    const { admin } = getServerSupabaseClients();
    let session;
    try {
      session = await getVerifiedSessionContext(admin, token);
    } catch (err) {
      if (err instanceof HttpError) return jsonResponse(err.status, { error: err.code });
      return jsonResponse(401, { error: 'invalid_session' });
    }

    if (session.isRecoverySession || !session.isAnonymous) {
      return jsonResponse(403, { error: 'anonymous_visitor_required' });
    }

    const actorId = session.user.id;
    const matchSecret = process.env.RETURNING_MATCH_TOKEN_SECRET?.trim();
    if (!matchSecret || matchSecret.length < 16) {
      console.error('RETURNING_MATCH_TOKEN_SECRET missing or insecure');
      return jsonResponse(503, { error: 'service_unavailable' });
    }

    const matchDigest = computeMatchTokenDigest(matchToken, matchSecret);

    // 1. Verify successful, unexpired 1:1 biometric match for this session & request
    const { data: attempt, error: attemptErr } = await admin
      .from('returning_identity_attempts')
      .select('id, matched_profile_id, outcome, expires_at')
      .eq('request_id', requestId)
      .eq('owner_id', actorId)
      .eq('matched_profile_id', profileId)
      .eq('match_token_digest', matchDigest)
      .eq('outcome', 'matched')
      .gt('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (attemptErr) throw attemptErr;
    if (!attempt) {
      return jsonResponse(403, {
        error: 'returning_match_required',
        message: 'Valid returning visitor biometric verification required before viewing ID evidence.',
      });
    }

    // 2. Verify active returning profile
    const { data: profile, error: profileErr } = await admin
      .from('returning_visitor_profiles')
      .select('id, expires_at, revoked_at')
      .eq('id', profileId)
      .is('revoked_at', null)
      .gt('expires_at', new Date().toISOString())
      .maybeSingle();

    if (profileErr) throw profileErr;
    if (!profile) {
      return jsonResponse(404, { error: 'profile_unavailable' });
    }

    // 3. Find historical visitor records linked to this returning profile
    const { data: visitors, error: visitorsErr } = await admin
      .from('visitors')
      .select('id')
      .eq('returning_profile_id', profileId);

    if (visitorsErr) throw visitorsErr;
    if (!visitors || visitors.length === 0) {
      return jsonResponse(404, { error: 'id_evidence_unavailable' });
    }

    const visitorIds = visitors.map((v) => v.id);

    // 4. Query unpurged, unexpired ID document evidence
    const { data: evidence, error: evidenceErr } = await admin
      .from('visitor_evidence')
      .select('id, bucket_id, object_path, content_type, expires_at, purged_at')
      .in('visitor_id', visitorIds)
      .eq('kind', 'id')
      .is('purged_at', null)
      .gt('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (evidenceErr) throw evidenceErr;
    if (!evidence) {
      return jsonResponse(404, {
        error: 'id_evidence_unavailable',
        message: 'Previous ID image is no longer available.',
      });
    }

    // 5. Download and stream the image
    const file = await admin.storage.from(evidence.bucket_id).download(evidence.object_path);
    if (file.error || !file.data) {
      return jsonResponse(404, {
        error: 'id_evidence_unavailable',
        message: 'Previous ID image could not be loaded from storage.',
      });
    }

    return new Response(file.data, {
      status: 200,
      headers: {
        'Cache-Control': 'private, no-store, max-age=0',
        'Content-Type': evidence.content_type,
        'Content-Security-Policy': "default-src 'none'; sandbox",
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (error) {
    console.error('Historical ID preview retrieval failed:', error instanceof Error ? error.message : 'unknown_error');
    return jsonResponse(503, { error: 'id_preview_unavailable' });
  }
}

export default { fetch: handleRequest };
