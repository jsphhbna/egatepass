import { createHash, createHmac } from 'node:crypto';
import { z } from 'zod';
import { getVerifiedSessionContext, HttpError } from '../../actors.js';
import { jsonResponse, readBearerToken } from '../../http.js';
import { getServerSupabaseClients } from '../../supabase.js';

const namePart = z.string().trim().min(2).max(50).regex(/^[\p{L}\s\-'.]+$/u);
const requestSchema = z.object({
  requestId: z.string().uuid(),
  source: z.enum(['portal', 'kiosk']),
  visitor: z.object({
    firstName: namePart,
    middleName: z.string().trim().max(50).regex(/^[\p{L}\s\-'.]*$/u).optional(),
    lastName: namePart,
    contactNumber: z.string().min(7).max(15).regex(/^[0-9+\-() ]+$/),
    purpose: z.string().trim().min(3).max(300),
    visitDate: z.iso.date(),
  }),
  photoIntentId: z.string().uuid(),
  idIntentId: z.string().uuid().nullable(),
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

interface InspectedUpload {
  bytes: number;
  sha256: string;
}

interface IssueResult {
  public_reference: string;
  valid_from: string;
  valid_until: string;
}

async function inspectUpload(admin: ReturnType<typeof getServerSupabaseClients>['admin'], id: string, actorId: string, source: 'portal' | 'kiosk', kind: 'photo' | 'id'): Promise<InspectedUpload> {
  const { data, error } = await admin.from('upload_intents').select('*').eq('id', id).maybeSingle<IntentRow>();
  if (error) throw error;
  if (
    !data ||
    data.owner_id !== actorId ||
    data.source !== source ||
    data.kind !== kind ||
    data.status !== 'pending' ||
    new Date(data.expires_at).getTime() <= Date.now()
  ) {
    throw new Error('invalid_upload_intent');
  }

  const downloaded = await admin.storage.from(data.bucket_id).download(data.object_path);
  if (downloaded.error) throw new Error('missing_uploaded_object');

  const bytes = new Uint8Array(await downloaded.data.arrayBuffer());
  if (bytes.length < 12 || bytes.length > data.max_bytes || !validMagic(bytes, data.content_type)) {
    throw new Error('invalid_uploaded_content');
  }

  return {
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

export function getClientNetworkIdentifier(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for');
  const realIp = request.headers.get('x-real-ip');
  const firstHop = forwarded ? forwarded.split(',')[0]?.trim() : null;
  const rawIp = firstHop || realIp || '127.0.0.1';

  const dedicatedSecret = process.env.RATE_LIMIT_HMAC_SECRET?.trim();
  const isProd = process.env.NODE_ENV === 'production' || process.env.VERCEL_ENV === 'production';

  // Strict cryptographic key separation: RATE_LIMIT_HMAC_SECRET must NEVER fall back to PASS_TOKEN_SECRET or other secrets
  if (!dedicatedSecret || dedicatedSecret.length < 32) {
    if (isProd) {
      throw new HttpError(503, 'abuse_control_unavailable');
    }
    return createHmac('sha256', 'test-rate-limit-secret-32-chars-minimum!').update(`network:${rawIp}`).digest('hex');
  }
  return createHmac('sha256', dedicatedSecret).update(`network:${rawIp}`).digest('hex');
}

async function handleRequest(request: Request): Promise<Response> {
  if (request.method !== 'POST') return jsonResponse(405, { error: 'method_not_allowed' }, { Allow: 'POST' });
  const token = readBearerToken(request);
  const parsed = requestSchema.safeParse(await request.json().catch(() => null));
  if (!token) return jsonResponse(401, { error: 'authentication_required' });
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

    const secret = process.env.PASS_TOKEN_SECRET?.trim();
    if (!secret || secret.length < 32) throw new Error('pass_token_secret_unavailable');
    const qrToken = createHmac('sha256', secret)
      .update(`${actorId}:${parsed.data.requestId}`)
      .digest('base64url');
    const tokenDigest = createHash('sha256').update(qrToken).digest('hex');

    // Safe idempotent replay check before inspecting upload intents.
    // If the database already committed the pass on a prior attempt whose response dropped,
    // the upload intents will already be in status = 'claimed'.
    const { data: existingPass, error: existingPassError } = await admin
      .from('passes')
      .select('id, public_reference, valid_from, valid_until, token_digest, visitor_id, status')
      .eq('issue_request_id', parsed.data.requestId)
      .maybeSingle();

    if (existingPassError) throw existingPassError;

    if (existingPass) {
      // Replay found. Validate owner, source, and payload consistency.
      const { data: existingVisitor, error: visitorError } = await admin
        .from('visitors')
        .select('id, owner_id, source, full_name, contact_number, purpose, visit_date')
        .eq('id', existingPass.visitor_id)
        .maybeSingle();

      if (visitorError) throw visitorError;
      if (!existingVisitor) throw new Error('visitor_record_missing');

      // Actor and source checks
      if (existingVisitor.owner_id !== actorId) {
        return jsonResponse(409, { error: 'cross_actor_replay' });
      }
      if (existingVisitor.source !== parsed.data.source) {
        return jsonResponse(409, { error: 'source_mismatch' });
      }

      // Payload consistency checks
      const expectedFullName = [parsed.data.visitor.firstName, parsed.data.visitor.middleName, parsed.data.visitor.lastName].filter(Boolean).join(' ');
      if (
        existingVisitor.full_name !== expectedFullName ||
        existingVisitor.contact_number !== parsed.data.visitor.contactNumber.trim() ||
        existingVisitor.purpose !== parsed.data.visitor.purpose.trim() ||
        existingVisitor.visit_date !== parsed.data.visitor.visitDate
      ) {
        return jsonResponse(409, { error: 'payload_mismatch' });
      }

      // Verify associated intents match
      const intentIds = [parsed.data.photoIntentId, parsed.data.idIntentId].filter(Boolean) as string[];
      const { data: claimedIntents, error: intentsError } = await admin
        .from('upload_intents')
        .select('id, kind, status, visitor_id')
        .in('id', intentIds);

      if (intentsError) throw intentsError;
      const photoIntentRow = claimedIntents?.find((i: any) => i.id === parsed.data.photoIntentId && i.kind === 'photo');
      if (!photoIntentRow || photoIntentRow.visitor_id !== existingVisitor.id) {
        return jsonResponse(409, { error: 'intent_mismatch' });
      }
      if (parsed.data.idIntentId) {
        const idIntentRow = claimedIntents?.find((i: any) => i.id === parsed.data.idIntentId && i.kind === 'id');
        if (!idIntentRow || idIntentRow.visitor_id !== existingVisitor.id) {
          return jsonResponse(409, { error: 'intent_mismatch' });
        }
      }

      // Check pass validity window
      if (new Date(existingPass.valid_until).getTime() <= Date.now() || existingPass.status === 'expired') {
        return jsonResponse(422, { error: 'pass_has_expired' });
      }

      // Check if HMAC secret was rotated
      const rawStoredDigest = typeof existingPass.token_digest === 'string'
        ? (existingPass.token_digest.startsWith('\\x') ? existingPass.token_digest.slice(2) : existingPass.token_digest)
        : '';
      if (rawStoredDigest.toLowerCase() !== tokenDigest.toLowerCase()) {
        throw new Error('pass_token_secret_rotated');
      }

      // Return existing pass with 200 OK (idempotent replay)
      return jsonResponse(200, {
        passId: existingPass.public_reference,
        publicReference: existingPass.public_reference,
        qrToken,
        validFrom: existingPass.valid_from,
        validUntil: existingPass.valid_until,
      });
    }

    if (parsed.data.source === 'portal') {
      // 1. Anonymous Actor Bucket
      const actorKeyHex = createHash('sha256').update(`actor:${actorId}`).digest('hex');
      const { data: actorAllowed, error: actorRlError } = await admin.schema('api').rpc('consume_rate_limit', {
        requested_key_hex: actorKeyHex,
        requested_action: 'portal.pass_issue',
        requested_max_requests: 3,
        requested_window_seconds: 3600,
      });

      if (actorRlError) {
        console.error('Rate limit actor RPC error:', actorRlError);
        return jsonResponse(503, {
          error: 'abuse_control_unavailable',
          message: 'Pass issuance abuse protection is temporarily unavailable. Please try again shortly.',
        });
      }

      if (actorAllowed === false) {
        return jsonResponse(429, {
          error: 'rate_limit_exceeded',
          message: 'Too many pass issuance requests for this session. Please wait before requesting another pass.',
        });
      }

      // 2. Privacy-Preserving Stable Network Bucket (campus threshold: 10 per 10 minutes)
      const networkKeyHex = getClientNetworkIdentifier(request);
      const { data: netAllowed, error: netRlError } = await admin.schema('api').rpc('consume_rate_limit', {
        requested_key_hex: networkKeyHex,
        requested_action: 'portal.network_issue',
        requested_max_requests: 10,
        requested_window_seconds: 600,
      });

      if (netRlError) {
        console.error('Rate limit network RPC error:', netRlError);
        return jsonResponse(503, {
          error: 'abuse_control_unavailable',
          message: 'Pass issuance abuse protection is temporarily unavailable. Please try again shortly.',
        });
      }

      if (netAllowed === false) {
        return jsonResponse(429, {
          error: 'rate_limit_exceeded',
          message: 'Too many pass issuance requests from this network. Please wait before requesting another pass.',
        });
      }
    }

    const photo = await inspectUpload(admin, parsed.data.photoIntentId, actorId, parsed.data.source, 'photo');
    const identification = parsed.data.idIntentId
      ? await inspectUpload(admin, parsed.data.idIntentId, actorId, parsed.data.source, 'id')
      : null;

    const visitor = parsed.data.visitor;
    const { data, error } = await admin.schema('api').rpc('issue_pass', {
      requested_actor_id: actorId,
      requested_source: parsed.data.source,
      requested_request_id: parsed.data.requestId,
      requested_full_name: [visitor.firstName, visitor.middleName, visitor.lastName].filter(Boolean).join(' '),
      requested_contact_number: visitor.contactNumber,
      requested_purpose: visitor.purpose,
      requested_visit_date: visitor.visitDate,
      requested_photo_intent_id: parsed.data.photoIntentId,
      requested_photo_bytes: photo.bytes,
      requested_photo_sha256: photo.sha256,
      requested_id_intent_id: parsed.data.idIntentId,
      requested_id_bytes: identification?.bytes ?? null,
      requested_id_sha256: identification?.sha256 ?? null,
      requested_token_digest: tokenDigest,
    }).single<IssueResult>();
    if (error || !data) throw error ?? new Error('issue_failed');

    return jsonResponse(201, {
      passId: data.public_reference,
      publicReference: data.public_reference,
      qrToken,
      validFrom: data.valid_from,
      validUntil: data.valid_until,
    });
  } catch (error) {
    if (error instanceof HttpError) return jsonResponse(error.status, { error: error.code });
    const errObj = typeof error === 'object' && error !== null ? error as Record<string, unknown> : {};
    const errCode = typeof errObj.code === 'string' ? errObj.code : '';
    const errMessage = typeof errObj.message === 'string' ? errObj.message : (error instanceof Error ? error.message : 'unknown_error');
    console.error('Pass issuance failed.', errCode || errMessage);

    // SQL 22023: visit date outside scheduling window
    if (errCode === '22023' || errMessage.includes('outside scheduling window') || errMessage.includes('visit date outside scheduling window')) {
      return jsonResponse(422, { error: 'visit_date_out_of_range' });
    }
    // Authorization / permission errors from Postgres / PostgREST (42501)
    if (errCode === '42501' || errMessage.includes('permission denied')) {
      return jsonResponse(403, { error: 'forbidden' });
    }
    if (errMessage === 'pass_token_secret_rotated') {
      return jsonResponse(409, { error: 'pass_token_secret_rotated' });
    }
    if (errMessage.startsWith('invalid_') || errMessage === 'missing_uploaded_object' || errMessage === 'pass_has_expired') {
      return jsonResponse(422, { error: errMessage });
    }
    if (errMessage === 'pass_token_secret_unavailable') {
      return jsonResponse(503, { error: errMessage });
    }
    return jsonResponse(503, { error: 'service_unavailable' });
  }
}

export default { fetch: handleRequest };
