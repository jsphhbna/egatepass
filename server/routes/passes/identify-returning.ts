/**
 * server/routes/passes/identify-returning.ts
 *
 * 1:1 Biometric Verification for Returning Visitors:
 * Compares a freshly captured live selfie directly against the selected returning visitor profile's
 * encrypted facial template.
 *
 * Eliminates 1:N gallery scanning, scale bottlenecks, and false-match margins.
 * Issues a single-use opaque match token upon successful 1:1 verification.
 */

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
  profileId: z.string().uuid(),
  photoIntentId: z.string().uuid(),
}).strict();

export function isReturningVisitorAvailable(): boolean {
  const minCosine = process.env.RETURNING_FACE_MIN_COSINE;
  const templateKey = process.env.RETURNING_VISITOR_TEMPLATE_KEY;
  const matchSecret = process.env.RETURNING_MATCH_TOKEN_SECRET;

  if (!minCosine || !templateKey || !matchSecret) {
    return false;
  }
  const cosineNum = Number(minCosine);
  if (isNaN(cosineNum) || cosineNum <= 0 || cosineNum >= 1) return false;
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
  if (!parsed.success) return jsonResponse(400, { error: 'invalid_request', details: parsed.error.issues });

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
    const templateKey = process.env.RETURNING_VISITOR_TEMPLATE_KEY!;
    const matchSecret = process.env.RETURNING_MATCH_TOKEN_SECRET!;

    // 1. Rate limiting - Actor Bucket (5 verification attempts per 10 minutes)
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

    // 2. Rate limiting - Network Bucket (15 verification attempts per 10 minutes)
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

    // 4. Single-pass live face quality evaluation and descriptor extraction
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

    // 5. Query candidate returning profile and its single template (1:1 verification)
    const { data: targetTemplate, error: templateError } = await admin
      .from('returning_face_templates')
      .select(`
        id, profile_id, encrypted_embedding, iv, auth_tag, key_version,
        returning_visitor_profiles!inner(
          id, first_name, middle_name, last_name, contact_number_e164, home_address,
          home_location_lat, home_location_lon,
          psgc_version, psgc_region_code, psgc_province_code, psgc_city_code, psgc_barangay_code,
          psgc_region_name, psgc_province_name, psgc_city_municipality_name, psgc_barangay_name,
          home_building, home_street, postal_code, postal_code_source,
          expires_at, revoked_at
        )
      `)
      .eq('profile_id', parsed.data.profileId)
      .maybeSingle();

    if (templateError) {
      console.error('Error fetching returning template:', templateError);
      return jsonResponse(500, { error: 'profile_lookup_failed' });
    }

    if (!targetTemplate || !targetTemplate.returning_visitor_profiles) {
      return jsonResponse(404, {
        available: true,
        matched: false,
        message: 'The selected returning visitor profile could not be found.',
      });
    }

    const profile = targetTemplate.returning_visitor_profiles as any;
    if (profile.revoked_at || new Date(profile.expires_at).getTime() <= Date.now()) {
      return jsonResponse(422, {
        available: true,
        matched: false,
        message: 'The selected returning visitor profile has expired or been revoked.',
      });
    }

    // 6. Decrypt profile template and compute 1:1 cosine similarity
    let targetEmbedding: Float32Array;
    try {
      targetEmbedding = decryptFaceTemplate(
        targetTemplate.encrypted_embedding,
        targetTemplate.iv,
        targetTemplate.auth_tag,
        templateKey,
        targetTemplate.key_version
      );
    } catch (decErr) {
      console.error('Decryption failed for template:', targetTemplate.id, decErr);
      return jsonResponse(500, { error: 'biometric_decryption_failed' });
    }

    const cosineScore = computeCosineSimilarity(queryEmbedding, targetEmbedding);
    const isMatch = cosineScore >= minCosine;

    if (isMatch) {
      // 1:1 Match succeeded: generate single-use opaque match token
      const matchToken = randomBytes(32).toString('hex');
      const matchTokenDigest = computeMatchTokenDigest(matchToken, matchSecret);
      const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();

      // Persist attempt with outcome = 'matched'
      const { error: insertErr } = await admin.from('returning_identity_attempts').insert({
        owner_id: actorId,
        request_id: parsed.data.requestId,
        photo_intent_id: parsed.data.photoIntentId,
        matched_profile_id: profile.id,
        outcome: 'matched',
        best_score: Number(cosineScore.toFixed(4)),
        second_score: null,
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
        .eq('profile_id', profile.id)
        .is('archived_at', null);

      return jsonResponse(200, {
        available: true,
        matched: true,
        matchToken,
        expiresAt,
        profile: {
          id: profile.id,
          firstName: profile.first_name,
          middleName: profile.middle_name,
          lastName: profile.last_name,
          contactNumber: profile.contact_number_e164,
          homeAddress: profile.home_address,
          psgc: profile.psgc_region_code && profile.psgc_city_code && profile.psgc_barangay_code ? {
            version: profile.psgc_version || '2026-q3',
            region: { code: profile.psgc_region_code, name: profile.psgc_region_name || '' },
            province: profile.psgc_province_code ? { code: profile.psgc_province_code, name: profile.psgc_province_name || '' } : null,
            city: { code: profile.psgc_city_code, name: profile.psgc_city_municipality_name || '' },
            barangay: { code: profile.psgc_barangay_code, name: profile.psgc_barangay_name || '' },
            houseBuilding: profile.home_building || undefined,
            street: profile.home_street || undefined,
            postalCode: profile.postal_code || undefined,
            postalCodeSource: profile.postal_code_source || undefined,
          } : null,
          homeLocation: (profile.home_location_lat != null && profile.home_location_lon != null)
            ? {
                lat: Number(profile.home_location_lat),
                lon: Number(profile.home_location_lon),
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

    // 1:1 Match failed: record neutral failure attempt
    const { error: failInsertErr } = await admin.from('returning_identity_attempts').insert({
      owner_id: actorId,
      request_id: parsed.data.requestId,
      photo_intent_id: parsed.data.photoIntentId,
      matched_profile_id: profile.id,
      outcome: 'low_similarity',
      best_score: Number(cosineScore.toFixed(4)),
      second_score: null,
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
      message: 'Photo did not match the selected returning visitor profile. Please retake photo or register as a new visitor.',
    });
  } catch (error) {
    if (error instanceof HttpError) return jsonResponse(error.status, { error: error.code });
    const errMessage = error instanceof Error ? error.message : 'unknown_error';
    console.error('Returning visitor 1:1 verification failed:', errMessage);

    if (errMessage.startsWith('invalid_upload_intent_') || errMessage.startsWith('missing_uploaded_object_') || errMessage.startsWith('invalid_uploaded_content_')) {
      return jsonResponse(422, { error: errMessage });
    }

    return jsonResponse(500, { error: 'identification_failed' });
  }
}

export default { fetch: handleRequest };
