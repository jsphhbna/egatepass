import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { HttpError, recordReconciliation, requireStaffActor } from '../server/actors.js';
import { jsonResponse, readBearerToken } from '../server/http.js';
import { getServerSupabaseClients } from '../server/supabase.js';

const schema = z.object({ targetUid: z.string().uuid() }).strict();
async function handleRequest(request: Request): Promise<Response> {
  if (request.method !== 'DELETE') return jsonResponse(405, { error: 'method_not_allowed' }, { Allow: 'DELETE' });
  const token = readBearerToken(request); const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!token) return jsonResponse(401, { error: 'authentication_required' }); if (!parsed.success) return jsonResponse(400, { error: 'invalid_request' });
  try {
    const { admin } = getServerSupabaseClients(); const actor = await requireStaffActor(admin, token, ['superadmin']);
    const retired = await admin.schema('api').rpc('retire_device', { requested_actor_id: actor.id, requested_user_id: parsed.data.targetUid, requested_request_id: randomUUID() });
    if (retired.error) throw retired.error;
    const banned = await admin.auth.admin.updateUserById(parsed.data.targetUid, { ban_duration: '876000h' });
    if (banned.error) { await recordReconciliation(admin, 'device.retire_auth', 'device', parsed.data.targetUid, banned.error.code ?? 'auth_update_failed'); return jsonResponse(503, { error: 'device_retired_auth_reconciliation_required' }); }
    return jsonResponse(200, { ok: true });
  } catch (error) { if (error instanceof HttpError) return jsonResponse(error.status, { error: error.code }); console.error('Device retirement failed.', error instanceof Error ? error.message : 'unknown_error'); return jsonResponse(503, { error: 'service_unavailable' }); }
}
export default { fetch: handleRequest };
