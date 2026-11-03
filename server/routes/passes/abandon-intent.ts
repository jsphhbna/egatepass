import { z } from 'zod';
import { getVerifiedSessionContext, HttpError } from '../../actors.js';
import { jsonResponse, readBearerToken } from '../../http.js';
import { getServerSupabaseClients } from '../../supabase.js';

const requestSchema = z.object({
  intentId: z.string().uuid(),
}).strict();

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

    const actorId = session.user.id;

    // Look up target intent
    const { data: intent, error: queryError } = await admin
      .from('upload_intents')
      .select('id, owner_id, source, kind, bucket_id, object_path, status, visitor_id')
      .eq('id', parsed.data.intentId)
      .maybeSingle();

    if (queryError) throw queryError;
    if (!intent) {
      // Idempotent: already removed or non-existent
      return jsonResponse(200, { ok: true, code: 'not_found' });
    }

    // Security boundaries
    if (intent.owner_id !== actorId) {
      return jsonResponse(403, { error: 'forbidden', message: 'You do not own this upload intent.' });
    }

    if (intent.source !== 'portal') {
      return jsonResponse(400, { error: 'unsupported_source', message: 'Only portal intents may be abandoned.' });
    }

    if (intent.status === 'claimed' || intent.visitor_id) {
      return jsonResponse(400, { error: 'intent_claimed', message: 'Cannot abandon an already claimed upload intent.' });
    }

    // Server-side trusted removal of uploaded storage object if present
    if (intent.bucket_id && intent.object_path) {
      try {
        await admin.storage.from(intent.bucket_id).remove([intent.object_path]);
      } catch (storageErr) {
        console.warn('Storage cleanup on abandon-intent encountered error (proceeding with DB expire):', storageErr);
      }
    }

    // Mark intent as expired via DB RPC
    const { error: rpcError } = await admin.schema('api').rpc('abandon_upload_intent', {
      requested_intent_id: parsed.data.intentId,
    });

    if (rpcError) throw rpcError;

    return jsonResponse(200, { ok: true, intentId: parsed.data.intentId });
  } catch (err) {
    if (err instanceof HttpError) return jsonResponse(err.status, { error: err.code });
    console.error('Failed to abandon upload intent:', err);
    return jsonResponse(500, { error: 'server_error', message: 'Failed to abandon upload intent' });
  }
}

export default { fetch: handleRequest };
