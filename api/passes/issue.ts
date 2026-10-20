import { createHash, createHmac } from 'node:crypto';
import { z } from 'zod';
import { jsonResponse, readBearerToken } from '../../server/http.js';
import { getServerSupabaseClients } from '../../server/supabase.js';

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

interface IssueResult {
  public_reference: string;
  valid_from: string;
  valid_until: string;
}

function validMagic(bytes: Uint8Array, contentType: string): boolean {
  if (contentType === 'image/jpeg') return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (contentType === 'image/png') return bytes.slice(0, 8).every((value, index) => value === [137, 80, 78, 71, 13, 10, 26, 10][index]);
  if (contentType === 'image/webp') {
    return new TextDecoder().decode(bytes.slice(0, 4)) === 'RIFF'
      && new TextDecoder().decode(bytes.slice(8, 12)) === 'WEBP';
  }
  return false;
}

async function inspectUpload(admin: ReturnType<typeof getServerSupabaseClients>['admin'], id: string, actorId: string, source: 'portal' | 'kiosk', kind: 'photo' | 'id') {
  const { data, error } = await admin.from('upload_intents').select('*').eq('id', id).maybeSingle<IntentRow>();
  if (error) throw error;
  if (!data || data.owner_id !== actorId || data.source !== source || data.kind !== kind
    || data.status !== 'pending' || new Date(data.expires_at).getTime() <= Date.now()) {
    throw new Error('invalid_upload_intent');
  }
  const downloaded = await admin.storage.from(data.bucket_id).download(data.object_path);
  if (downloaded.error) throw new Error('missing_uploaded_object');
  const bytes = new Uint8Array(await downloaded.data.arrayBuffer());
  if (bytes.length < 12 || bytes.length > data.max_bytes || !validMagic(bytes, data.content_type)) {
    throw new Error('invalid_uploaded_content');
  }
  return { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
}

async function handleRequest(request: Request): Promise<Response> {
  if (request.method !== 'POST') return jsonResponse(405, { error: 'method_not_allowed' }, { Allow: 'POST' });
  const token = readBearerToken(request);
  const parsed = requestSchema.safeParse(await request.json().catch(() => null));
  if (!token) return jsonResponse(401, { error: 'authentication_required' });
  if (!parsed.success) return jsonResponse(400, { error: 'invalid_request' });

  try {
    const { admin } = getServerSupabaseClients();
    const { data: identity, error: identityError } = await admin.auth.getUser(token);
    if (identityError || !identity.user) return jsonResponse(401, { error: 'invalid_session' });
    const actorId = identity.user.id;
    const photo = await inspectUpload(admin, parsed.data.photoIntentId, actorId, parsed.data.source, 'photo');
    const identification = parsed.data.idIntentId
      ? await inspectUpload(admin, parsed.data.idIntentId, actorId, parsed.data.source, 'id')
      : null;

    const secret = process.env.PASS_TOKEN_SECRET?.trim();
    if (!secret || secret.length < 32) throw new Error('pass_token_secret_unavailable');
    const qrToken = createHmac('sha256', secret)
      .update(`${actorId}:${parsed.data.requestId}`)
      .digest('base64url');
    const tokenDigest = createHash('sha256').update(qrToken).digest('hex');
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
      qrToken,
      validFrom: data.valid_from,
      validUntil: data.valid_until,
    });
  } catch (error) {
    const code = error instanceof Error ? error.message : 'unknown_error';
    console.error('Pass issuance failed.', code);
    if (code.startsWith('invalid_') || code === 'missing_uploaded_object') {
      return jsonResponse(422, { error: code });
    }
    return jsonResponse(503, { error: 'service_unavailable' });
  }
}

export default { fetch: handleRequest };
