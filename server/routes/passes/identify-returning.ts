import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { getVerifiedSessionContext, HttpError } from '../../actors.js';
import { jsonResponse, readBearerToken } from '../../http.js';
import { getServerSupabaseClients } from '../../supabase.js';
import { getClientNetworkIdentifier } from './issue.js';
import { inspectAndDownloadUpload } from './verify-identity.js';
import {
  analyzeFaceImage,
  decryptFaceTemplate,
  computeCosineSimilarity,
  isFaceVerificationConfigured,
  validateFaceDescriptor,
} from '../../lib/face-engine.js';

const requestSchema = z.object({
  requestId: z.string().uuid(),
  photoIntentId: z.string().uuid(),
}).strict();

export function isReturningVisitorAvailable(): boolean {
  const minCosine = process.env.RETURNING_FACE_MIN_COSINE;
  const minMargin = process.env.RETURNING_FACE_MIN_MARGIN;
  const templateKey = process.env.RETURNING_VISITOR_TEMPLATE_KEY;
  const matchSecret = process.env.RETURNING_MATCH_TOKEN_SECRET;

  if (!minCosine || !minMargin || !templateKey || !matchSecret) {
    return false;
  }
  const cosineNum = Number(minCosine);
  const marginNum = Number(minMargin);
  if (isNaN(cosineNum) || cosineNum <= 0 || cosineNum >= 1) return false;
  if (isNaN(marginNum) || marginNum <= 0 || marginNum >= 1) return false;
  if (templateKey.trim().length < 32) return false;
  if (matchSecret.trim().length < 16) return false;
  if (!isFaceVerificationConfigured()) return false;

  return true;
}

export function computeMatchTokenDigest(matchToken: string, secret: string): string {
  return createHash('sha256').update(`${matchToken}:${secret}`).digest('hex');
}

async function handleRequest(request: Request): Promise<Response> {
  if (request.method !== 'POST') {
    return jsonResponse(405, { error: 'method_not_allowed' }, { Allow: 'POST' });
  }

  const token = readBearerToken(request);
  if (!token) return jsonResponse(401, { error: 'authentication_required' });

  const parsed = requestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return jsonResponse(400, { error: 'invalid_request' });

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

    // Safety Gate Check: fail-closed if biometric parameters or secrets are uncalibrated/missing
    if (!isReturningVisitorAvailable()) {
      return jsonResponse(200, {
        available: false,
        matched: false,
        message: 'Returning visitor biometrics are currently unavailable pending calibration.',
      });
    }

    const minCosine = Number(process.env.RETURNING_FACE_MIN_COSINE);
    const minMargin = Number(process.env.RETURNING_FACE_MIN_MARGIN);
    const templateKey = process.env.RETURNING_VISITOR_TEMPLATE_KEY!;
    const matchSecret = process.env.RETURNING_MATCH_TOKEN_SECRET!;

    // 1. Rate limiting - Actor Bucket (5 attempts per 10 minutes)
    const actorKeyHex = createHash('sha256').update(`actor:${actorId}`).digest('hex');
    const { data: actorAllowed, error: actorRlError } = await admin.schema('api').rpc('consume_rate_limit', {
      requested_key_hex: actorKeyHex,
      requested_action: 'portal.identify_returning',
      requested_max_requests: 5,
      requested_window_seconds: 600,
    });

    if (actorRlError) {
      console.error('Rate limit actor RPC error in identify-returning:', actorRlError);
      return jsonResponse(503, {
        error: 'abuse_control_unavailable',
        message: 'Returning visitor identification is temporarily unavailable.',
      });
    }

    if (actorAllowed === false) {
      return jsonResponse(429, {
        error: 'rate_limit_exceeded',
        message: 'Too many identification attempts for this session. Please wait before retrying.',
      });
    }

    // 2. Rate limiting - Network Bucket (15 attempts per 10 minutes)
    const networkKeyHex = getClientNetworkIdentifier(request);
    const { data: netAllowed, error: netRlError } = await admin.schema('api').rpc('consume_rate_limit', {
      requested_key_hex: networkKeyHex,
      requested_action: 'portal.network_identify',
      requested_max_requests: 15,
      requested_window_seconds: 600,
    });

    if (netRlError) {
      console.error('Rate limit network RPC error in identify-returning:', netRlError);
      return jsonResponse(503, {
        error: 'abuse_control_unavailable',
        message: 'Returning visitor identification is temporarily unavailable.',
      });
    }

    if (netAllowed === false) {
      return jsonResponse(429, {
        error: 'rate_limit_exceeded',
        message: 'Too many identification attempts from this network. Please wait before retrying.',
      });
    }

    // 3. Inspect and download photo (live selfie)
    const photoResult = await inspectAndDownloadUpload(admin, parsed.data.photoIntentId, actorId, 'photo');

    // 4. Single-pass live face quality evaluation and descriptor extraction (avoids redundant inference)
    const analysis = await analyzeFaceImage(photoResult.buffer, 'selfie');
    if (!analysis.quality.passed) {
      return jsonResponse(422, {
        ok: false,
        error: 'quality_rejected',
        reasonCode: analysis.quality.code,
        message: analysis.quality.message,
      });
    }

    if (!analysis.descriptor) {
      return jsonResponse(422, {
        ok: false,
        error: 'quality_rejected',
        reasonCode: 'no_face_in_selfie',
        message: 'Could not extract face descriptor. Please retake photo.',
      });
    }

    const queryEmbedding = analysis.descriptor;
    const queryValidation = validateFaceDescriptor(queryEmbedding, 128);
    if (!queryValidation.valid) {
      return jsonResponse(422, {
        ok: false,
        error: 'quality_rejected',
        reasonCode: 'no_face_in_selfie',
        message: 'Could not extract valid face descriptor. Please retake photo.',
      });
    }

    const modelName = analysis.modelName;
    const modelVersion = analysis.modelVersion;

    // 6. Complete gallery pagination with safety cap (Phase 4A)
    const PAGE_SIZE = 500;
    const SAFETY_CAP = 5000;
    const allTemplates: Array<any> = [];
    let from = 0;
    let hasMore = true;
    const nowIso = new Date().toISOString();

    while (hasMore) {
      if (allTemplates.length >= SAFETY_CAP) {
        console.warn(`Returning visitor gallery reached safety cap of ${SAFETY_CAP} templates.`);
        return jsonResponse(503, {
          error: 'gallery_capacity_exceeded',
          message: 'Returning visitor search capacity exceeded. Please consult guard station.',
        });
      }

      const { data: pageData, error: pageError } = await admin
        .from('returning_face_templates')
        .select(`
          id, profile_id, encrypted_embedding, iv, auth_tag, key_version,
          returning_visitor_profiles!inner(
            id, first_name, middle_name, last_name, contact_number_e164, home_address,
            home_location_lat, home_location_lon,
            expires_at, revoked_at
          )
        `)
        .is('returning_visitor_profiles.revoked_at', null)
        .gt('returning_visitor_profiles.expires_at', nowIso)
        .order('id', { ascending: true })
        .range(from, from + PAGE_SIZE - 1);

      if (pageError) {
        console.error('Failed to load returning templates page:', pageError);
        return jsonResponse(500, { error: 'template_query_failed' });
      }

      if (!pageData || pageData.length === 0) {
        hasMore = false;
        break;
      }

      allTemplates.push(...pageData);
      if (pageData.length < PAGE_SIZE) {
        hasMore = false;
        break;
      }
      from += PAGE_SIZE;
    }

    let bestScore = -1;
    let secondScore = -1;
    let bestProfile: {
      id: string;
      first_name: string;
      middle_name: string | null;
      last_name: string;
      contact_number_e164: string;
      home_address?: string | null;
      home_location_lat?: number | null;
      home_location_lon?: number | null;
    } | null = null;

    // Priority 1: Gallery evaluation must fail closed if ANY template fails decryption or validation.
    // A partial gallery evaluation must never proceed to pick a match from a subset.
    for (const t of allTemplates) {
      let candidateEmbedding: Float32Array;
      try {
        candidateEmbedding = decryptFaceTemplate(
          t.encrypted_embedding,
          t.iv,
          t.auth_tag,
          templateKey,
          t.key_version || 'v1'
        );
      } catch (decErr) {
        // Operational log only: privacy-safe, zero biometric data logged
        console.error(
          `Gallery template decryption failure for template ${t.id} (version: ${t.key_version || 'v1'}):`,
          decErr instanceof Error ? decErr.message : 'decryption_failed'
        );
        return jsonResponse(503, {
          error: 'gallery_evaluation_incomplete',
          message:
            'Returning visitor verification is temporarily unavailable. Please proceed to the Guard Station for manual verification.',
        });
      }

      const valRes = validateFaceDescriptor(candidateEmbedding, 128);
      if (!valRes.valid) {
        console.error(
          `Gallery template descriptor validation failure for template ${t.id}: ${valRes.reason}`
        );
        return jsonResponse(503, {
          error: 'gallery_evaluation_incomplete',
          message:
            'Returning visitor verification is temporarily unavailable. Please proceed to the Guard Station for manual verification.',
        });
      }

      const score = computeCosineSimilarity(queryEmbedding, candidateEmbedding);

      if (score > bestScore) {
        secondScore = bestScore;
        bestScore = score;
        const p = t.returning_visitor_profiles as unknown as {
          id: string;
          first_name: string;
          middle_name: string | null;
          last_name: string;
          contact_number_e164: string;
          home_address?: string | null;
          home_location_lat?: number | null;
          home_location_lon?: number | null;
        };
        bestProfile = p;
      } else if (score > secondScore) {
        secondScore = score;
      }
    }

    const margin = bestScore - (secondScore > -1 ? secondScore : 0);
    const isConfidentMatch =
      bestProfile !== null &&
      bestScore >= minCosine &&
      margin >= minMargin;

    if (isConfidentMatch && bestProfile) {
      // Confident match: issue short-lived opaque match token
      const matchToken = randomBytes(32).toString('hex');
      const matchTokenDigest = computeMatchTokenDigest(matchToken, matchSecret);
      const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();

      // Fail-closed persistence: never return match token if attempt failed to persist
      const { error: insertErr } = await admin.from('returning_identity_attempts').insert({
        owner_id: actorId,
        request_id: parsed.data.requestId,
        photo_intent_id: parsed.data.photoIntentId,
        matched_profile_id: bestProfile.id,
        outcome: 'matched',
        best_score: Number(bestScore.toFixed(4)),
        second_score: secondScore > -1 ? Number(secondScore.toFixed(4)) : null,
        model_name: modelName,
        model_version: modelVersion,
        match_token_digest: matchTokenDigest,
        expires_at: expiresAt,
      });

      if (insertErr) {
        console.error('Failed to persist matched returning identity attempt:', insertErr);
        return jsonResponse(500, {
          error: 'attempt_persistence_failed',
          message: 'Unable to secure identity verification attempt.',
        });
      }

      // Load saved convenience vehicles
      const { data: vehicles } = await admin
        .from('returning_visitor_vehicles')
        .select('id, vehicle_type, plate_number, plate_key, color, make_model')
        .eq('profile_id', bestProfile.id)
        .is('archived_at', null);

      return jsonResponse(200, {
        available: true,
        matched: true,
        matchToken,
        expiresAt,
        profile: {
          id: bestProfile.id,
          firstName: bestProfile.first_name,
          middleName: bestProfile.middle_name,
          lastName: bestProfile.last_name,
          contactNumber: bestProfile.contact_number_e164,
          homeLocation: (bestProfile.home_location_lat != null && bestProfile.home_location_lon != null)
            ? {
                lat: Number(bestProfile.home_location_lat),
                lon: Number(bestProfile.home_location_lon),
              }
            : null,
        },
        savedVehicles: (vehicles || []).map((v) => ({
          id: v.id,
          vehicleType: v.vehicle_type,
          plateNumber: v.plate_number,
          plateKey: v.plate_key,
          color: v.color,
          makeModel: v.make_model,
        })),
      });
    }

    // No confident match: record neutral failure attempt without leaking candidate scores
    const outcome = bestScore >= minCosine ? 'ambiguous_margin' : 'low_similarity';
    const { error: failInsertErr } = await admin.from('returning_identity_attempts').insert({
      owner_id: actorId,
      request_id: parsed.data.requestId,
      photo_intent_id: parsed.data.photoIntentId,
      matched_profile_id: null,
      outcome,
      best_score: bestScore > -1 ? Number(bestScore.toFixed(4)) : null,
      second_score: secondScore > -1 ? Number(secondScore.toFixed(4)) : null,
      model_name: modelName,
      model_version: modelVersion,
      match_token_digest: null,
      expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    });

    if (failInsertErr) {
      console.warn('Failed to persist non-matched returning identity attempt:', failInsertErr);
    }

    return jsonResponse(200, {
      available: true,
      matched: false,
      message: "We couldn't confidently find a saved visitor profile.",
    });
  } catch (error) {
    if (error instanceof HttpError) return jsonResponse(error.status, { error: error.code });
    const errMessage = error instanceof Error ? error.message : 'unknown_error';
    console.error('Returning visitor identification failed:', errMessage);

    if (errMessage.startsWith('invalid_upload_intent_') || errMessage.startsWith('missing_uploaded_object_') || errMessage.startsWith('invalid_uploaded_content_')) {
      return jsonResponse(422, { error: errMessage });
    }

    return jsonResponse(500, { error: 'identification_failed' });
  }
}

export default { fetch: handleRequest };
