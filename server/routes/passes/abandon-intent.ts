import { z } from 'zod';
import { getVerifiedSessionContext, HttpError, recordReconciliation } from '../../actors.js';
import { jsonResponse, readBearerToken } from '../../http.js';
import { createVisitorScopedSupabaseClient, getServerSupabaseClients } from '../../supabase.js';

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

    if (!session.isAnonymous) {
      return jsonResponse(403, {
        error: 'visitor_identity_required',
        message: 'Only portal visitors can abandon upload intents.',
      });
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
      return jsonResponse(200, {
        ok: true,
        success: true,
        code: 'not_found',
        databaseExpired: true,
        storageCleaned: true,
      });
    }

    // Security boundaries
    if (intent.owner_id !== actorId) {
      return jsonResponse(403, { error: 'forbidden', message: 'You do not own this upload intent.' });
    }

    if (intent.source !== 'portal') {
      return jsonResponse(400, { error: 'unsupported_source', message: 'Only portal intents may be abandoned.' });
    }

    if (intent.status === 'claimed' || intent.visitor_id) {
      return jsonResponse(409, { error: 'intent_claimed', message: 'Cannot abandon an already claimed upload intent.' });
    }

    // 1. Mark intent as expired via DB RPC under caller's visitor context
    const visitorClient = createVisitorScopedSupabaseClient(token);
    const { data: rpcRows, error: rpcError } = await visitorClient
      .schema('api')
      .rpc('abandon_upload_intent', {
        requested_intent_id: parsed.data.intentId,
      });

    if (rpcError) {
      console.error('abandon_upload_intent RPC failed:', rpcError);
      if (rpcError.code === '42501') {
        return jsonResponse(403, { error: 'visitor_identity_required', message: rpcError.message });
      }
      if (rpcError.code === '22023') {
        return jsonResponse(409, { error: 'intent_claimed', message: rpcError.message });
      }
      return jsonResponse(500, { error: 'database_error', message: rpcError.message });
    }

    // 2. Server-side trusted removal of uploaded storage object ONLY AFTER database confirmation
    let storageCleaned = true;
    let warning: string | undefined;

    if (intent.bucket_id && intent.object_path) {
      try {
        const { error: storageErr } = await admin.storage
          .from(intent.bucket_id)
          .remove([intent.object_path]);

        if (storageErr) {
          storageCleaned = false;
          console.warn('Storage cleanup on abandon-intent encountered error (DB expired):', storageErr);
          await recordReconciliation(
            admin,
            'upload_intent.abandon_storage_failed',
            'upload_intent',
            intent.id,
            storageErr.message || 'storage_remove_failed',
            {
              bucketId: intent.bucket_id,
              objectPath: intent.object_path,
            },
          );
          warning = 'Storage object removal pending background retention cleanup';
        }
      } catch (storageException) {
        storageCleaned = false;
        console.warn('Storage exception on abandon-intent (DB expired):', storageException);
        await recordReconciliation(
          admin,
          'upload_intent.abandon_storage_failed',
          'upload_intent',
          intent.id,
          storageException instanceof Error ? storageException.message : String(storageException),
          {
            bucketId: intent.bucket_id,
            objectPath: intent.object_path,
          },
        );
        warning = 'Storage object removal pending background retention cleanup';
      }
    }

    const rpcResult = Array.isArray(rpcRows) ? rpcRows[0] : rpcRows;
    return jsonResponse(200, {
      ok: true,
      success: true,
      intentId: parsed.data.intentId,
      code: (rpcResult as { code?: string } | undefined)?.code ?? 'abandoned',
      databaseExpired: true,
      storageCleaned,
      ...(warning ? { warning } : {}),
    });
  } catch (err) {
    if (err instanceof HttpError) return jsonResponse(err.status, { error: err.code });
    console.error('Failed to abandon upload intent:', err);
    return jsonResponse(500, { error: 'server_error', message: 'Failed to abandon upload intent' });
  }
}

export default { fetch: handleRequest };
