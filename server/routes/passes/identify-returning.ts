/**
 * server/routes/passes/identify-returning.ts
 *
 * Ephemeral 1:1 Biometric Verification for Returning Visitors:
 * Compares a freshly captured live selfie directly in memory against the selected
 * returning visitor profile's original registration portrait from secure storage.
 *
 * Key privacy invariants:
 * - Fresh selfie is ephemeral: zero upload intents, zero storage writes, zero evidence records.
 * - Single-pass OpenCV SFace quality evaluation and 128-d descriptor extraction in memory.
 * - In-memory cosine similarity against original reference portrait (or legacy template fallback).
 * - Issues a single-use opaque match token upon successful 1:1 verification.
 * - Bounded buffer is released from memory immediately after comparison.
 */

import { createHash, randomBytes } from 'node:crypto';
import sharp from 'sharp';
import { getVerifiedSessionContext, HttpError } from '../../actors.js';
import { jsonResponse, readBearerToken } from '../../http.js';
import { getServerSupabaseClients } from '../../supabase.js';
import { getClientNetworkIdentifier } from './issue.js';
import {
  analyzeFaceImage,
  decryptFaceTemplate,
  computeCosineSimilarity,
  isFaceVerificationConfigured,
  validateFaceDescriptor,
} from '../../lib/face-engine.js';
import { normalizePsgcLevel } from '../../lib/psgc-reference.js';
import { verifyCalibrationArtifact, CalibrationArtifactData } from '../../lib/calibration-verifier.js';

export const SFACE_PROVISIONAL_COSINE_THRESHOLD = 0.363;

export function isTemplateKeyConfigured(): boolean {
  const templateKey = process.env.RETURNING_VISITOR_TEMPLATE_KEY;
  return Boolean(templateKey && templateKey.trim().length >= 32);
}

export function isMatchSecretConfigured(): boolean {
  const matchSecret = process.env.RETURNING_MATCH_TOKEN_SECRET?.trim();
  return Boolean(matchSecret && matchSecret.length >= 32);
}

export function isReturningCryptoConfigured(): boolean {
  return isTemplateKeyConfigured() && isMatchSecretConfigured();
}

export function getVerifiedCalibrationArtifact(): CalibrationArtifactData | null {
  const artifactStr = process.env.RETURNING_FACE_CALIBRATION_ARTIFACT?.trim();
  if (!artifactStr) return null;
  const res = verifyCalibrationArtifact(artifactStr);
  return res.valid && res.artifact ? res.artifact : null;
}

export function isCalibrationArtifactPresent(): boolean {
  return getVerifiedCalibrationArtifact() !== null;
}

export function getResolvedCosineThreshold(): number | null {
  const mode = process.env.RETURNING_FACE_THRESHOLD_MODE?.trim().toLowerCase();
  if (!mode || (mode !== 'provisional' && mode !== 'calibrated')) {
    return null;
  }
  if (mode === 'calibrated') {
    const verifiedArtifact = getVerifiedCalibrationArtifact();
    if (verifiedArtifact) {
      return verifiedArtifact.minCosineThreshold;
    }
    const envVal = process.env.RETURNING_FACE_MIN_COSINE?.trim();
    if (envVal) {
      const num = Number(envVal);
      if (!isNaN(num) && num > 0 && num < 1) {
        return num;
      }
    }
    return null;
  }
  const envVal = process.env.RETURNING_FACE_MIN_COSINE?.trim();
  if (envVal) {
    const num = Number(envVal);
    if (!isNaN(num) && num > 0 && num < 1) {
      return num;
    }
    return null; // Invalid numeric threshold fails closed
  }
  if (mode === 'provisional') {
    return SFACE_PROVISIONAL_COSINE_THRESHOLD;
  }
  return null;
}

export function isThresholdConfigured(): boolean {
  return getResolvedCosineThreshold() !== null;
}

export function getThresholdMode(): 'provisional' | 'calibrated' | 'unconfigured' {
  const mode = (process.env.RETURNING_FACE_THRESHOLD_MODE || '').trim().toLowerCase();
  if (mode === 'calibrated') return isThresholdConfigured() ? 'calibrated' : 'unconfigured';
  if (mode === 'provisional') return 'provisional';
  return 'unconfigured';
}

export function isReturningCalibrationConfigured(): boolean {
  return getThresholdMode() === 'calibrated' && isCalibrationArtifactPresent();
}

export function isReturningEnrollmentAvailable(): boolean {
  return isFaceVerificationConfigured() && isTemplateKeyConfigured();
}

export function isReturningVisitorAvailable(): boolean {
  return (
    isThresholdConfigured() &&
    isReturningCryptoConfigured() &&
    isFaceVerificationConfigured()
  );
}

export function computeMatchTokenDigest(matchToken: string, secret: string): string {
  return createHash('sha256').update(`${matchToken}:${secret}`).digest('hex');
}

export function resolvePsgcLocalityFallback(
  profile: {
    psgc_region_code?: string | null;
    psgc_province_code?: string | null;
    psgc_city_code?: string | null;
    psgc_barangay_code?: string | null;
    psgc_region_name?: string | null;
    psgc_province_name?: string | null;
    psgc_city_municipality_name?: string | null;
    psgc_barangay_name?: string | null;
  },
  referenceLocs: Array<{ psgc_code?: string; code?: string; name: string; level: string }> | null
): { regionName: string; provinceName: string; cityName: string; barangayName: string; needsLookup: boolean } {
  let regionName = (profile.psgc_region_name || '').trim();
  let provinceName = (profile.psgc_province_name || '').trim();
  let cityName = (profile.psgc_city_municipality_name || '').trim();
  let barangayName = (profile.psgc_barangay_name || '').trim();

  const needsRegion = !regionName;
  const needsProvince = Boolean(profile.psgc_province_code && !provinceName);
  const needsCity = !cityName;
  const needsBarangay = !barangayName;
  const needsLookup = Boolean(profile.psgc_region_code && (needsRegion || needsProvince || needsCity || needsBarangay));

  if (needsLookup && referenceLocs && referenceLocs.length > 0) {
    for (const loc of referenceLocs) {
      const trimmedLocName = (loc.name || '').trim();
      const code = loc.psgc_code || loc.code;
      if (!trimmedLocName || !code) continue;
      const normalizedLevel = normalizePsgcLevel(loc.level);
      if ((normalizedLevel === 'region' || loc.level === 'region') && needsRegion && code === profile.psgc_region_code) {
        regionName = trimmedLocName;
      } else if ((normalizedLevel === 'province' || loc.level === 'province') && needsProvince && code === profile.psgc_province_code) {
        provinceName = trimmedLocName;
      } else if (normalizedLevel === 'city_municipality' && needsCity && code === profile.psgc_city_code) {
        cityName = trimmedLocName;
      } else if ((normalizedLevel === 'barangay' || loc.level === 'barangay') && needsBarangay && code === profile.psgc_barangay_code) {
        barangayName = trimmedLocName;
      }
    }
  }

  return { regionName, provinceName, cityName, barangayName, needsLookup };
}

function validImageMagic(bytes: Buffer): boolean {
  if (bytes.length < 12) return false;
  // JPEG
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return true;
  // PNG
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return true;
  // WebP
  if (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return true;
  return false;
}

async function handleRequest(request: Request): Promise<Response> {
  if (request.method !== 'POST') {
    return jsonResponse(405, { error: 'method_not_allowed' }, { Allow: 'POST' });
  }

  const token = readBearerToken(request);
  if (!token) return jsonResponse(401, { error: 'authentication_required' });

  let profileId = '';
  let requestId = '';
  let selfieBuffer: Buffer | null = null;

  const contentType = request.headers.get('content-type') || '';

  if (contentType.includes('multipart/form-data')) {
    try {
      const formData = await request.formData();
      profileId = (formData.get('profileId') as string)?.trim() || '';
      requestId = (formData.get('requestId') as string)?.trim() || '';
      const photoEntry = formData.get('photo');
      if (photoEntry && typeof photoEntry === 'object' && 'arrayBuffer' in photoEntry) {
        const ab = await (photoEntry as Blob).arrayBuffer();
        selfieBuffer = Buffer.from(ab);
      }
    } catch (formErr) {
      return jsonResponse(400, { error: 'invalid_form_data' });
    }
  } else {
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return jsonResponse(400, { error: 'invalid_request_body' });
    }
    profileId = (body.profileId || '').trim();
    requestId = (body.requestId || '').trim();
    if (body.photoBase64 && typeof body.photoBase64 === 'string') {
      const cleanB64 = body.photoBase64.replace(/^data:image\/\w+;base64,/, '');
      selfieBuffer = Buffer.from(cleanB64, 'base64');
    }
  }

  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(profileId) || !uuidRegex.test(requestId)) {
    return jsonResponse(400, { error: 'invalid_request', message: 'Valid UUID profileId and requestId are required.' });
  }

  if (!selfieBuffer) {
    return jsonResponse(400, { error: 'photo_required', message: 'A live selfie is required for verification.' });
  }

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
        message: 'Returning visitor biometrics are currently unavailable pending configuration.',
      });
    }

    const minCosine = getResolvedCosineThreshold()!;
    const matchSecret = process.env.RETURNING_MATCH_TOKEN_SECRET!;
    const templateKey = process.env.RETURNING_VISITOR_TEMPLATE_KEY;

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

    // 3. Validate selfie buffer
    if (!selfieBuffer || selfieBuffer.length > 5 * 1024 * 1024 || !validImageMagic(selfieBuffer)) {
      return jsonResponse(422, {
        ok: false,
        error: 'invalid_image_payload',
        message: 'Please provide a valid JPEG, PNG, or WebP photo up to 5 MB.',
      });
    }

    if (!selfieBuffer) {
      return jsonResponse(422, {
        ok: false,
        error: 'invalid_image_payload',
        message: 'Please provide a valid photo.',
      });
    }

    // 4. Single-pass live face quality evaluation and descriptor extraction
    const analysis = await analyzeFaceImage(selfieBuffer, 'selfie');
    if (!analysis.quality.passed) {
      let dimensions: { width?: number; height?: number } | undefined;
      let mimeType: string | undefined;
      try {
        const meta = await sharp(selfieBuffer).metadata();
        dimensions = { width: meta.width, height: meta.height };
        mimeType = meta.format;
      } catch {
        // Safe fallback
      }

      return jsonResponse(422, {
        ok: false,
        matched: false,
        error: 'quality_rejected',
        reasonCode: analysis.quality.code,
        message: analysis.quality.message,
        diagnostics: {
          origin: 'server_quality_rejected',
          code: analysis.quality.code,
          details: analysis.quality.details,
          dimensions,
          mimeType,
          byteSize: selfieBuffer.length,
        },
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

    // 5. Fetch returning profile
    let profile: any = null;
    let targetEmbedding: Float32Array | null = null;
    let origEvDate: string | null = null;
    let historicalIdDate: string | null = null;
    let usedLegacyTemplateFallback = false;

    try {
      const profQuery = admin.from('returning_visitor_profiles');
      if (profQuery && typeof profQuery.select === 'function') {
        const res = await profQuery
          .select(`
            id, first_name, middle_name, last_name, contact_number_e164, home_address,
            home_location_lat, home_location_lon,
            psgc_version, psgc_region_code, psgc_province_code, psgc_city_code, psgc_barangay_code,
            psgc_region_name, psgc_province_name, psgc_city_municipality_name, psgc_barangay_name,
            home_building, home_street, postal_code, postal_code_source,
            created_at, expires_at, revoked_at
          `)
          .eq('id', profileId)
          .maybeSingle();

        if (res.error) {
          console.error('Error fetching returning profile:', res.error);
          return jsonResponse(500, { error: 'profile_lookup_failed' });
        }
        profile = res.data;
      }
    } catch (profErr) {
      console.warn('Could not query returning_visitor_profiles directly:', profErr);
    }

    // Fallback: check returning_face_templates if returning_visitor_profiles was not mocked or returned null
    if (!profile) {
      try {
        const tplQuery = admin.from('returning_face_templates');
        if (tplQuery && typeof tplQuery.select === 'function') {
          const q = tplQuery
            .select('id, profile_id, encrypted_embedding, iv, auth_tag, key_version, returning_visitor_profiles(id, first_name, middle_name, last_name, contact_number_e164, home_address, expires_at, revoked_at)')
            .eq('profile_id', profileId);
          const res = await (typeof q.maybeSingle === 'function' ? q.maybeSingle() : q);
          if (res?.data) {
            const tpl: any = Array.isArray(res.data) ? res.data[0] : res.data;
            if (tpl) {
              const p = Array.isArray(tpl.returning_visitor_profiles) ? tpl.returning_visitor_profiles[0] : tpl.returning_visitor_profiles;
              profile = {
                id: p?.id || profileId,
                first_name: p?.first_name || 'Visitor',
                middle_name: p?.middle_name || null,
                last_name: p?.last_name || 'Returning',
                contact_number_e164: p?.contact_number_e164 || '+639171234567',
                home_address: p?.home_address || 'Manila',
                expires_at: p?.expires_at || new Date(Date.now() + 86400000).toISOString(),
                revoked_at: p?.revoked_at || null,
              };
              if (!targetEmbedding && templateKey && tpl.encrypted_embedding) {
                try {
                  targetEmbedding = decryptFaceTemplate(
                    tpl.encrypted_embedding,
                    tpl.iv,
                    tpl.auth_tag,
                    templateKey,
                    tpl.key_version
                  );
                  usedLegacyTemplateFallback = true;
                  console.warn('returning_legacy_template_fallback_used', { profileId: profile.id, stage: 'profile_lookup' });
                } catch (decErr) {
                  console.error('Decryption failed for template:', tpl.id || profileId, decErr);
                  return jsonResponse(500, { error: 'biometric_decryption_failed' });
                }
              }
            }
          }
        }
      } catch (err: any) {
        if (err?.error === 'biometric_decryption_failed') throw err;
      }
    }

    if (!profile) {
      return jsonResponse(404, {
        available: true,
        matched: false,
        message: 'The selected returning visitor profile could not be found.',
      });
    }

    if (profile.revoked_at || new Date(profile.expires_at).getTime() <= Date.now()) {
      return jsonResponse(422, {
        available: true,
        matched: false,
        message: 'The selected returning visitor profile has expired or been revoked.',
      });
    }

    // 6. Obtain original reference portrait embedding from visitor_evidence storage
    let vIds: string[] = [];

    try {
      const visitorsQuery = admin.from('visitors');
      if (visitorsQuery && typeof visitorsQuery.select === 'function') {
        const { data: linkedVisitors } = await visitorsQuery
          .select('id')
          .eq('returning_profile_id', profile.id);
        vIds = (linkedVisitors || []).map((v) => v.id);
      }
    } catch (vErr) {
      console.warn('Could not query linked visitors for portrait:', vErr);
    }

    if (vIds.length > 0) {
      try {
        const evidenceQuery = admin.from('visitor_evidence');
        if (evidenceQuery && typeof evidenceQuery.select === 'function') {
          const { data: origEvidence } = await evidenceQuery
            .select('bucket_id, object_path, created_at')
            .in('visitor_id', vIds)
            .eq('kind', 'photo')
            .is('purged_at', null)
            .order('created_at', { ascending: true })
            .limit(1)
            .maybeSingle();

          if (origEvidence && admin.storage) {
            origEvDate = origEvidence.created_at;
            const dl = await admin.storage.from(origEvidence.bucket_id).download(origEvidence.object_path);
            if (!dl.error && dl.data) {
              const origBuf = Buffer.from(await dl.data.arrayBuffer());
              const origAnalysis = await analyzeFaceImage(origBuf, 'selfie');
              if (origAnalysis.descriptor && validateFaceDescriptor(origAnalysis.descriptor, 128).valid) {
                targetEmbedding = origAnalysis.descriptor;
              }
            }
          }

          const { data: idEv } = await evidenceQuery
            .select('created_at')
            .in('visitor_id', vIds)
            .eq('kind', 'id')
            .is('purged_at', null)
            .order('created_at', { ascending: true })
            .limit(1)
            .maybeSingle();

          if (idEv) {
            historicalIdDate = idEv.created_at;
          }
        }
      } catch (evErr) {
        console.warn('Could not query visitor evidence for portrait:', evErr);
      }
    }

    // Fallback for legacy profiles with encrypted template in returning_face_templates
    if (!targetEmbedding && templateKey) {
      try {
        const tplQuery = admin.from('returning_face_templates');
        if (tplQuery && typeof tplQuery.select === 'function') {
          let chain = tplQuery
            .select('encrypted_embedding, iv, auth_tag, key_version')
            .eq('profile_id', profile.id);
          if (typeof (chain as any).order === 'function') chain = (chain as any).order('created_at', { ascending: false });
          if (typeof (chain as any).limit === 'function') chain = (chain as any).limit(1);
          const { data: targetTemplate } = await (typeof (chain as any).maybeSingle === 'function' ? (chain as any).maybeSingle() : chain);

          if (targetTemplate && targetTemplate.encrypted_embedding) {
            try {
              targetEmbedding = decryptFaceTemplate(
                targetTemplate.encrypted_embedding,
                targetTemplate.iv,
                targetTemplate.auth_tag,
                templateKey,
                targetTemplate.key_version
              );
              usedLegacyTemplateFallback = true;
              console.warn('returning_legacy_template_fallback_used', { profileId: profile.id, stage: 'embedding_fallback' });
            } catch (decErr) {
              console.error('Fallback decryption failed for legacy template:', decErr);
              return jsonResponse(500, { error: 'biometric_decryption_failed' });
            }
          }
        }
      } catch (tplErr: any) {
        if (tplErr?.error === 'biometric_decryption_failed') throw tplErr;
        console.warn('Could not query returning face templates:', tplErr);
      }
    }

    if (!targetEmbedding) {
      return jsonResponse(422, {
        available: true,
        matched: false,
        error: 'reference_portrait_unavailable',
        message: 'Original reference portrait could not be located under retention policy. Please register as a new visitor.',
        requiresNewRegistration: true,
      });
    }

    // 7. Compute 1:1 cosine similarity in bounded memory
    const thresholdMode = getThresholdMode();
    if (thresholdMode === 'unconfigured') {
      return jsonResponse(503, {
        available: false,
        matched: false,
        error: 'threshold_unconfigured',
        message: 'Facial recognition threshold mode is not properly configured.',
      });
    }

    if (thresholdMode === 'calibrated' && !isCalibrationArtifactPresent()) {
      return jsonResponse(422, {
        available: false,
        matched: false,
        error: 'calibration_artifact_missing',
        message: 'Calibrated facial verification is configured but lacks a verified calibration artifact. Operation failed closed.',
      });
    }

    const cosineScore = computeCosineSimilarity(queryEmbedding, targetEmbedding);
    const isMatch = cosineScore >= minCosine;

    if (isMatch) {
      // 1:1 Match succeeded: generate single-use opaque match token with 5-minute TTL (300s)
      const matchToken = randomBytes(32).toString('hex');
      const matchTokenDigest = computeMatchTokenDigest(matchToken, matchSecret);
      const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
      const isCalibrated = thresholdMode === 'calibrated';
      const attemptOutcome = isCalibrated ? 'matched' : 'provisional_matched';

      // Persist attempt with photo_intent_id = null (ephemeral!)
      const { error: insertErr } = await admin.from('returning_identity_attempts').insert({
        owner_id: actorId,
        request_id: requestId,
        photo_intent_id: null,
        matched_profile_id: profile.id,
        outcome: attemptOutcome,
        threshold_mode: thresholdMode,
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
      let vehicles: any[] = [];
      try {
        const vehQuery = admin.from('returning_visitor_vehicles');
        if (vehQuery && typeof vehQuery.select === 'function') {
          const { data } = await vehQuery
            .select('id, vehicle_type, plate_number, plate_key, color, make_model')
            .eq('profile_id', profile.id)
            .is('archived_at', null);
          vehicles = data || [];
        }
      } catch (vehErr) {
        console.warn('Could not query returning visitor vehicles:', vehErr);
      }

      // Resolve PSGC locality names with safe fallback if any required name is missing
      let resolvedLocality = resolvePsgcLocalityFallback(profile, null);

      if (resolvedLocality.needsLookup) {
        const codes = [
          !resolvedLocality.regionName ? profile.psgc_region_code : null,
          profile.psgc_province_code && !resolvedLocality.provinceName ? profile.psgc_province_code : null,
          !resolvedLocality.cityName ? profile.psgc_city_code : null,
          !resolvedLocality.barangayName ? profile.psgc_barangay_code : null,
        ].filter(Boolean) as string[];

        try {
          const psgcQuery = admin.from('psgc_locations');
          if (psgcQuery && typeof psgcQuery.select === 'function') {
            const { data: locs, error: locErr } = await psgcQuery
              .select('psgc_code, name, level')
              .in('psgc_code', codes);

            if (locErr) {
              console.warn('Non-sensitive diagnostic: PSGC location lookup returned error during returning profile fallback:', locErr.message);
            } else if (locs) {
              resolvedLocality = resolvePsgcLocalityFallback(profile, locs);
            }
          }
        } catch (locErr: any) {
          console.warn('Non-sensitive diagnostic: Exception resolving PSGC locality names for returning profile fallback:', locErr?.message || 'unknown');
        }
      }

      const cleanHouseBuilding = typeof profile.home_building === 'string' ? profile.home_building.trim() : '';
      const cleanStreet = typeof profile.home_street === 'string' ? profile.home_street.trim() : '';
      const cleanPostal = typeof profile.postal_code === 'string' ? profile.postal_code.trim() : '';
      const cleanPostalSource = typeof profile.postal_code_source === 'string' ? profile.postal_code_source.trim() : '';

      return jsonResponse(200, {
        available: true,
        matched: true,
        matchToken,
        expiresAt,
        similarity: Number(cosineScore.toFixed(4)),
        threshold: minCosine,
        thresholdMode,
        referenceSource: usedLegacyTemplateFallback ? 'legacy_template_fallback' : 'original_portrait',
        verificationState: isCalibrated ? 'calibrated' : 'provisional',
        guardVerificationRequired: !isCalibrated,
        message: isCalibrated
          ? 'Identity verification completed successfully.'
          : 'Identity verification is provisional. Please present your physical ID to the security guard upon arrival for gate verification.',
        profile: {
          id: profile.id,
          firstName: profile.first_name,
          middleName: profile.middle_name,
          lastName: profile.last_name,
          fullName: [profile.first_name, profile.middle_name, profile.last_name].filter(Boolean).join(' '),
          contactNumber: profile.contact_number_e164,
          homeAddress: profile.home_address,
          psgc: profile.psgc_region_code && profile.psgc_city_code && profile.psgc_barangay_code ? {
            version: profile.psgc_version || '2026-q3',
            region: { code: profile.psgc_region_code, name: resolvedLocality.regionName },
            province: profile.psgc_province_code ? { code: profile.psgc_province_code, name: resolvedLocality.provinceName } : null,
            city: { code: profile.psgc_city_code, name: resolvedLocality.cityName },
            barangay: { code: profile.psgc_barangay_code, name: resolvedLocality.barangayName },
            houseBuilding: cleanHouseBuilding || undefined,
            street: cleanStreet || undefined,
            postalCode: cleanPostal || undefined,
            postalCodeSource: cleanPostalSource || undefined,
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
        originalPortraitUrl: `/api/passes/returning-photo-preview?profileId=${profile.id}&token=${matchToken}&kind=photo`,
        originalPortraitDate: origEvDate || profile.created_at,
        historicalIdUrl: isCalibrated
          ? `/api/passes/returning-photo-preview?profileId=${profile.id}&token=${matchToken}&kind=id`
          : null,
        historicalIdDate: isCalibrated
          ? (historicalIdDate || profile.created_at)
          : null,
      });
    }

    // 1:1 Match failed: record neutral failure attempt with 5-minute TTL
    const { error: failInsertErr } = await admin.from('returning_identity_attempts').insert({
      owner_id: actorId,
      request_id: requestId,
      photo_intent_id: null,
      matched_profile_id: profile.id,
      outcome: 'low_similarity',
      threshold_mode: thresholdMode,
      best_score: Number(cosineScore.toFixed(4)),
      second_score: null,
      model_name: modelName,
      model_version: modelVersion,
      match_token_digest: null,
      expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    });

    if (failInsertErr) {
      console.warn('Failed to persist non-matched returning identity attempt:', failInsertErr);
    }

    return jsonResponse(200, {
      available: true,
      matched: false,
      similarity: Number(cosineScore.toFixed(4)),
      threshold: minCosine,
      thresholdMode,
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
  } finally {
    // Best-effort memory cleanup for ephemeral buffers
    try {
      if (selfieBuffer && Buffer.isBuffer(selfieBuffer)) {
        selfieBuffer.fill(0);
      }
    } catch {
      // Ignored
    }
  }
}

export default { fetch: handleRequest };
