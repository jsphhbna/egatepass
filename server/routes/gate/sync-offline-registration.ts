import { z } from 'zod';
import { jsonResponse, readBearerToken } from '../../http.js';
import { HttpError, requireStaffActor } from '../../actors.js';
import { getServerSupabaseClients } from '../../supabase.js';
import { inspectUploadIntent } from '../../upload-inspection.js';

const syncOfflineRegistrationSchema = z.object({
  offlineRegistrationId: z.string().uuid(),
  visitor: z.object({
    firstName: z.string().min(1).max(50),
    middleName: z.string().max(50).optional().nullable(),
    lastName: z.string().min(1).max(50),
    contactNumber: z.string().min(7).max(32),
    email: z.string().email().optional().nullable(),
    purpose: z.string().min(2).max(500),
    visitDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  }),
  action: z.enum(['approved', 'rejected']),
  occurredAt: z.string().datetime(),
  photoIntentId: z.string().uuid(),
  idIntentId: z.string().uuid().optional().nullable(),
  rejectionReason: z.string().max(500).optional().nullable(),
});

async function handleRequest(request: Request): Promise<Response> {
  if (request.method !== 'POST') return jsonResponse(405, { error: 'Method not allowed' }, { Allow: 'POST' });
  const token = readBearerToken(request);
  if (!token) return jsonResponse(401, { error: 'Authentication required' });

  const body = await request.json().catch(() => null);
  const parsed = syncOfflineRegistrationSchema.safeParse(body);
  if (!parsed.success) {
    return jsonResponse(400, { error: 'Invalid offline registration request payload', details: parsed.error.issues });
  }

  // R03 Requirement: Approved offline registration strictly requires ID evidence
  if (parsed.data.action === 'approved' && !parsed.data.idIntentId) {
    return jsonResponse(400, { error: 'valid_id_evidence_required_for_approval' });
  }

  try {
    const { admin } = getServerSupabaseClients();
    let actor;
    try {
      actor = await requireStaffActor(admin, token, ['guard', 'superadmin']);
    } catch (err) {
      if (err instanceof HttpError) {
        if (err.status === 401) return jsonResponse(401, { error: 'Invalid or expired session' });
        return jsonResponse(err.status, { error: 'Access denied', code: err.code });
      }
      return jsonResponse(401, { error: 'Invalid or expired session' });
    }

    // Inspect photo upload intent (bytes, MIME, magic bytes, SHA-256)
    const photo = await inspectUploadIntent(
      admin,
      parsed.data.photoIntentId,
      actor.id,
      'guard_offline',
      'photo'
    );

    // Inspect ID upload intent if provided
    const identification = parsed.data.idIntentId
      ? await inspectUploadIntent(
          admin,
          parsed.data.idIntentId,
          actor.id,
          'guard_offline',
          'id'
        )
      : null;

    // Call transactional DB RPC with trusted, server-verified byte metrics
    const { data, error } = await admin.schema('api').rpc('guard_sync_offline_registration', {
      requested_registration_id: parsed.data.offlineRegistrationId,
      requested_visitor: parsed.data.visitor,
      requested_action: parsed.data.action,
      requested_occurred_at: parsed.data.occurredAt,
      requested_photo_intent_id: parsed.data.photoIntentId,
      requested_photo_byte_size: photo.bytes,
      requested_photo_sha256: photo.sha256,
      requested_id_intent_id: parsed.data.idIntentId ?? null,
      requested_id_byte_size: identification?.bytes ?? null,
      requested_id_sha256: identification?.sha256 ?? null,
      requested_rejection_reason: parsed.data.rejectionReason ?? null,
    });

    if (error) {
      console.error('guard_sync_offline_registration RPC error:', error);
      return jsonResponse(400, { error: error.message || 'sync_failed' });
    }

    if (data?.status === 'conflict') {
      return jsonResponse(409, data);
    }

    return jsonResponse(200, data);
  } catch (error: any) {
    console.error('Offline registration sync error:', error);
    const msg = error?.message || 'internal_server_error';
    if (msg.startsWith('invalid_') || msg === 'missing_uploaded_object') {
      return jsonResponse(422, { error: msg });
    }
    return jsonResponse(500, { error: msg });
  }
}

export default { fetch: handleRequest };
