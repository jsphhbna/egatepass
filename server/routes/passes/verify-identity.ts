import { createHash } from 'node:crypto';
import { z } from 'zod';
import { getVerifiedSessionContext, HttpError } from '../../actors.js';
import { jsonResponse, readBearerToken } from '../../http.js';
import { getServerSupabaseClients } from '../../supabase.js';
import { getClientNetworkIdentifier } from './issue.js';
import { compareFaces, evaluateLiveFaceQuality } from '../../lib/face-engine.js';

const requestSchema = z.object({
  requestId: z.string().uuid(),
  photoIntentId: z.string().uuid(),
  idIntentId: z.string().uuid().optional(),
  mode: z.enum(['preflight_face', 'verify']).optional(),
}).strict().superRefine((val, ctx) => {
  if (val.mode !== 'preflight_face' && !val.idIntentId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'idIntentId is required for identity verification',
      path: ['idIntentId'],
    });
  }
});

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

export interface UploadDownloadResult {
  buffer: Buffer;
  expiresAt: string;
}

export async function inspectAndDownloadUpload(
  admin: ReturnType<typeof getServerSupabaseClients>['admin'],
  id: string,
  actorId: string,
  kind: 'photo' | 'id'
): Promise<UploadDownloadResult> {
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

  return { buffer: Buffer.from(bytes), expiresAt: data.expires_at };
}

export function computeVerificationExpiry(
  photoIntentExpiresAt: string,
  idIntentExpiresAt: string,
  nowMs: number = Date.now(),
  maxWindowMs: number = 30 * 60 * 1000
): string {
  const photoExp = new Date(photoIntentExpiresAt).getTime();
  const idExp = new Date(idIntentExpiresAt).getTime();
  const cap = nowMs + maxWindowMs;
  const boundedMs = Math.min(photoExp, idExp, cap);
  return new Date(boundedMs).toISOString();
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

    // 1. Rate limiting - Actor Bucket
    const actorKeyHex = createHash('sha256').update(`actor:${actorId}`).digest('hex');
    const { data: actorAllowed, error: actorRlError } = await admin.schema('api').rpc('consume_rate_limit', {
      requested_key_hex: actorKeyHex,
      requested_action: 'portal.verify_identity',
      requested_max_requests: 12,
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

    // 2. Rate limiting - Network Bucket
    const networkKeyHex = getClientNetworkIdentifier(request);
    const { data: netAllowed, error: netRlError } = await admin.schema('api').rpc('consume_rate_limit', {
      requested_key_hex: networkKeyHex,
      requested_action: 'portal.network_verify',
      requested_max_requests: 30,
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

    // 3. Inspect and download photo (live selfie)
    const photoResult = await inspectAndDownloadUpload(admin, parsed.data.photoIntentId, actorId, 'photo');

    // 4. Branch: Preflight Face Check Mode (Live face presence & geometry check before ID step)
    if (parsed.data.mode === 'preflight_face') {
      const faceQuality = await evaluateLiveFaceQuality(photoResult.buffer);
      if (!faceQuality.passed) {
        return jsonResponse(422, {
          ok: false,
          error: 'quality_rejected',
          reasonCode: faceQuality.code,
          message: faceQuality.message,
        });
      }

      return jsonResponse(200, {
        ok: true,
        preflightPassed: true,
        message: 'Live face quality and geometry verified.',
      });
    }

    // 5. Full 1:1 Identity Verification Mode
    const idIntentId = parsed.data.idIntentId!;
    const idResult = await inspectAndDownloadUpload(admin, idIntentId, actorId, 'id');

    // Run local face engine comparison (OpenCV Zoo YuNet + SFace)
    const comparison = await compareFaces(photoResult.buffer, idResult.buffer);

    let userMessage = 'Identity verified successfully.';
    if (comparison.outcome === 'mismatch') {
      userMessage = 'The face in your live photo does not match the portrait on your ID. Please ensure you are presenting your own ID document.';
    } else if (comparison.outcome === 'no_face_in_selfie') {
      userMessage = 'No face was detected in your live selfie. Please retake your photo inside the guide.';
    } else if (comparison.outcome === 'no_face_in_id') {
      userMessage = 'No portrait was found on the uploaded ID. Please ensure your ID image shows a clear photo of your face.';
    } else if (comparison.outcome === 'multiple_selfie_faces') {
      userMessage = 'More than one face was detected in your live selfie. Only the visitor must be in view.';
    } else if (comparison.outcome === 'ambiguous_id_faces') {
      userMessage = 'Multiple faces were found on the ID card. Please ensure only the document owner is visible.';
    } else if (comparison.outcome === 'low_quality_selfie') {
      userMessage = comparison.error || 'Your live selfie did not meet quality requirements. Please ensure good lighting and steady camera.';
    } else if (comparison.outcome === 'low_quality_id') {
      userMessage = comparison.error || 'Your ID image did not meet quality requirements. Please ensure the card is flat, clear, and well-lit.';
    } else if (comparison.outcome === 'engine_error') {
      userMessage = 'We could not complete identity verification. Please retry with clear images.';
    }

    // Bounded expiry: min(photoIntent.expires_at, idIntent.expires_at, now + 30 mins)
    const expiresAt = computeVerificationExpiry(photoResult.expiresAt, idResult.expiresAt);

    // Persist attempt into public.portal_identity_verification_attempts using canonical schema
    // Zero vector persistence: no embeddings, landmarks, or tensors are saved.
    const { data: attemptRow, error: insertError } = await admin
      .from('portal_identity_verification_attempts')
      .insert({
        owner_id: actorId,
        request_id: parsed.data.requestId,
        photo_intent_id: parsed.data.photoIntentId,
        id_intent_id: idIntentId,
        outcome: comparison.outcome,
        model_name: comparison.modelName,
        model_version: comparison.modelVersion,
        verified_at: new Date().toISOString(),
        expires_at: expiresAt,
      })
      .select('id, outcome, expires_at')
      .single();

    if (insertError) {
      console.error('Failed to record portal verification attempt:', insertError);
      return jsonResponse(500, { error: 'verification_storage_failed' });
    }

    return jsonResponse(200, {
      outcome: comparison.outcome,
      matched: comparison.outcome === 'matched',
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
