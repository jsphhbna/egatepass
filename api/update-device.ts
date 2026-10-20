import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { HttpError, recordReconciliation, requireStaffActor } from '../server/actors.js';
import { jsonResponse, readBearerToken } from '../server/http.js';
import { getServerSupabaseClients } from '../server/supabase.js';

const schema = z.object({ targetUid: z.string().uuid(), status: z.enum(['active', 'revoked']) }).strict();
async function handleRequest(request: Request): Promise<Response> {
  if (request.method !== 'POST') return jsonResponse(405, { error: 'method_not_allowed' }, { Allow: 'POST' });
  const token = readBearerToken(request); const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!token) return jsonResponse(401, { error: 'authentication_required' }); if (!parsed.success) return jsonResponse(400, { error: 'invalid_request' });
  try {
    const { admin } = getServerSupabaseClients(); const actor = await requireStaffActor(admin, token, ['admin', 'superadmin']);
    const updated = await admin.schema('api').rpc('update_device_profile', { requested_actor_id: actor.id, requested_user_id: parsed.data.targetUid, requested_status: parsed.data.status, requested_alias: null, requested_request_id: randomUUID() });
    if (updated.error) { if (updated.error.code === '42501') return jsonResponse(403, { error: 'access_denied' }); throw updated.error; }
    const authUpdate = await admin.auth.admin.updateUserById(parsed.data.targetUid, { ban_duration: parsed.data.status === 'active' ? 'none' : '876000h' });
    if (authUpdate.error) {
      await recordReconciliation(
        admin,
        'device.status.auth_ban_failed',
        'device',
        parsed.data.targetUid,
        authUpdate.error.message || 'auth_ban_failed',
        { targetStatus: parsed.data.status }
      );
      return jsonResponse(503, { error: 'device_updated_auth_reconciliation_required' });
    }
    return jsonResponse(200, { ok: true });
  } catch (error) { if (error instanceof HttpError) return jsonResponse(error.status, { error: error.code }); console.error('Device update failed.', error instanceof Error ? error.message : 'unknown_error'); return jsonResponse(503, { error: 'service_unavailable' }); }
}
export default { fetch: handleRequest };
