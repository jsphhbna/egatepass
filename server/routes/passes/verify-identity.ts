import { createHash } from 'node:crypto';
import { z } from 'zod';
import { getVerifiedSessionContext, HttpError } from '../../actors.js';
import { jsonResponse, readBearerToken } from '../../http.js';
import { getServerSupabaseClients } from '../../supabase.js';
import { getClientNetworkIdentifier } from './issue.js';
import { compareFaces } from '../../lib/face-engine.js';

const requestSchema = z.object({
  requestId: z.string().uuid(),
  photoIntentId: z.string().uuid(),
  idIntentId: z.string().uuid(),
}).strict();

function validMagic(bytes: Uint8Array, contentType: string): boolean {
  if (contentType === 'image/jpeg') return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (contentType === 'image/png') return bytes.slice(0, 8).every((value, index) => value === [137, 80, 78, 71, 13, 10, 26, 10][index]);
  if (contentType === 'image/webp') {
    return new TextDecoder().decode(bytes.slice(0, 4)) === 'RIFF'
      && new TextDecoder().decode(bytes.slice(8, 12)) === 'WEBP';
  }
  return false;
}

interface IntentRow {
  id: string;
  owner_id: string;
  source: 'portal' | 'kiosk';
  kind: 'photo' | 'id';
  bucket_id: string;
  object_path: string;
  content_type: string;
  max_bytes: number;
  status: string;
  expires_at: string;
}

async function inspectAndDownloadUpload(
  admin: ReturnType<typeof getServerSupabaseClients>['admin'],
  id: string,
  actorId: string,
  kind: 'photo' | 'id'
): Promise<Buffer> {
  const { data, error } = await admin.from('upload_intents').select('*').eq('id', id).maybeSingle<IntentRow>();
  if (error) throw error;
  if (
    !data ||
    data.owner_id !== actorId ||
    data.source !== 'portal' ||
    data.kind !== kind ||
    data.status !== 'pending' ||
    new Date(data.expires_at).getTime() <= Date.now()
  ) {
    throw new Error(`invalid_upload_intent_${kind}`);
  }

  const downloaded = await admin.storage.from(data.bucket_id).download(data.object_path);
  if (downloaded.error) throw new Error(`missing_uploaded_object_${kind}`);

  const bytes = new Uint8Array(await downloaded.data.arrayBuffer());
  if (bytes.length < 12 || bytes.length > data.max_bytes || !validMagic(bytes, data.content_type)) {
    throw new Error(`invalid_uploaded_content_${kind}`);
  }

  return Buffer.from(bytes);
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

    if (session.isRecoverySession) {
      return jsonResponse(403, { error: 'recovery_session_forbidden' });
    }

    const actorId = session.user.id;

    // 1. Rate limiting - Actor Bucket (6 per 10 minutes)
    const actorKeyHex = createHash('sha256').update(`actor:${actorId}`).digest('hex');
    const { data: actorAllowed, error: actorRlError } = await admin.schema('api').rpc('consume_rate_limit', {
      requested_key_hex: actorKeyHex,
      requested_action: 'portal.verify_identity',
      requested_max_requests: 6,
      requested_window_seconds: 600,
    });

    if (actorRlError) {
      console.error('Rate limit actor RPC error:', actorRlError);
      return jsonResponse(503, {
        error: 'abuse_control_unavailable',
        message: 'Identity verification is temporarily unavailable. Please try again shortly.',
      });
    }

    if (actorAllowed === false) {
      return jsonResponse(429, {
        error: 'rate_limit_exceeded',
        message: 'Too many verification attempts for this session. Please wait before retrying.',
      });
    }

    // 2. Rate limiting - Network Bucket (15 per 10 minutes)
    const networkKeyHex = getClientNetworkIdentifier(request);
    const { data: netAllowed, error: netRlError } = await admin.schema('api').rpc('consume_rate_limit', {
      requested_key_hex: networkKeyHex,
      requested_action: 'portal.network_verify',
      requested_max_requests: 15,
      requested_window_seconds: 600,
    });

    if (netRlError) {
      console.error('Rate limit network RPC error:', netRlError);
      return jsonResponse(503, {
        error: 'abuse_control_unavailable',
        message: 'Identity verification is temporarily unavailable. Please try again shortly.',
      });
    }

    if (netAllowed === false) {
      return jsonResponse(429, {
        error: 'rate_limit_exceeded',
        message: 'Too many verification attempts from this network. Please wait before retrying.',
      });
    }

    // 3. Inspect and download photo (live selfie) and ID images
    const photoBytes = await inspectAndDownloadUpload(admin, parsed.data.photoIntentId, actorId, 'photo');
    const idBytes = await inspectAndDownloadUpload(admin, parsed.data.idIntentId, actorId, 'id');

    // 4. Run local face engine comparison (YuNet + SFace)
    const comparison = await compareFaces(photoBytes, idBytes);

    let dbOutcome: 'matched' | 'mismatched' | 'face_not_detected' | 'quality_rejected';
    let userMessage = 'Identity verified successfully.';

    if (comparison.outcome === 'matched') {
      dbOutcome = 'matched';
    } else if (comparison.outcome === 'mismatch') {
      dbOutcome = 'mismatched';
      userMessage = 'The face in your live photo does not match the portrait on your ID. Please ensure you are presenting your own ID document.';
    } else if (comparison.outcome === 'no_face_in_selfie') {
      dbOutcome = 'face_not_detected';
      userMessage = 'No face was detected in your live selfie. Please retake your photo inside the guide.';
    } else if (comparison.outcome === 'no_face_in_id') {
      dbOutcome = 'face_not_detected';
      userMessage = 'No portrait was found on the uploaded ID. Please ensure your ID image shows a clear photo of your face.';
    } else if (comparison.outcome === 'multiple_selfie_faces') {
      dbOutcome = 'quality_rejected';
      userMessage = 'More than one face was detected in your live selfie. Only the visitor must be in view.';
    } else if (comparison.outcome === 'ambiguous_id_faces') {
      dbOutcome = 'quality_rejected';
      userMessage = 'Multiple faces were found on the ID card. Please ensure only the document owner is visible.';
    } else if (comparison.outcome === 'low_quality_selfie') {
      dbOutcome = 'quality_rejected';
      userMessage = comparison.error || 'Your live selfie did not meet quality requirements. Please ensure good lighting and steady camera.';
    } else if (comparison.outcome === 'low_quality_id') {
      dbOutcome = 'quality_rejected';
      userMessage = comparison.error || 'Your ID image did not meet quality requirements. Please ensure the card is flat, clear, and well-lit.';
    } else {
      dbOutcome = 'quality_rejected';
      userMessage = 'We could not complete identity verification. Please retry with clear images.';
    }

    // 5. Store attempt in portal_identity_verification_attempts (valid for 30 minutes)
    // Minimization rule: zero persistence of embeddings, face descriptors, landmarks, or tensors.
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    const { data: attemptRow, error: insertError } = await admin
      .from('portal_identity_verification_attempts')
      .insert({
        actor_id: actorId,
        request_id: parsed.data.requestId,
        photo_intent_id: parsed.data.photoIntentId,
        id_intent_id: parsed.data.idIntentId,
        outcome: dbOutcome,
        confidence_score: comparison.score != null ? Math.round(comparison.score * 1000) / 1000 : null,
        decision_reason: comparison.outcome,
        expires_at: expiresAt,
      })
      .select('id, outcome, confidence_score, expires_at')
      .single();

    if (insertError) {
      console.error('Failed to record portal verification attempt:', insertError);
      return jsonResponse(500, { error: 'verification_storage_failed' });
    }

    return jsonResponse(200, {
      outcome: dbOutcome,
      matched: dbOutcome === 'matched',
      verificationId: attemptRow.id,
      expiresAt: attemptRow.expires_at,
      message: userMessage,
      reasonCode: comparison.outcome,
    });
  } catch (error) {
    if (error instanceof HttpError) return jsonResponse(error.status, { error: error.code });
    const errMessage = error instanceof Error ? error.message : 'unknown_error';
    console.error('Identity verification failed:', errMessage);

    if (errMessage.startsWith('invalid_upload_intent_') || errMessage.startsWith('missing_uploaded_object_') || errMessage.startsWith('invalid_uploaded_content_')) {
      return jsonResponse(422, { error: errMessage });
    }

    return jsonResponse(500, { error: 'verification_failed' });
  }
}

export default { fetch: handleRequest };
