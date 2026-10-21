import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { HttpError, recordReconciliation, requireStaffActor } from '../../actors.js';
import { jsonResponse, readBearerToken } from '../../http.js';
import { getServerSupabaseClients } from '../../supabase.js';

const schema = z.object({ targetUid: z.string().uuid(), role: z.enum(['guard', 'admin', 'superadmin']).optional(), active: z.boolean().optional() })
  .strict().refine((value) => value.role !== undefined || value.active !== undefined);

async function handleRequest(request: Request): Promise<Response> {
  if (request.method !== 'POST') return jsonResponse(405, { error: 'method_not_allowed' }, { Allow: 'POST' });
  const token = readBearerToken(request); const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!token) return jsonResponse(401, { error: 'authentication_required' });
  if (!parsed.success) return jsonResponse(400, { error: 'invalid_request' });
  try {
    const { admin } = getServerSupabaseClients(); const actor = await requireStaffActor(admin, token, ['admin', 'superadmin']);
    const updated = await admin.schema('api').rpc('update_staff_profile', {
      requested_actor_id: actor.id, requested_user_id: parsed.data.targetUid,
      requested_role: parsed.data.role ?? null, requested_active: parsed.data.active ?? null, requested_request_id: randomUUID(),
    });
    if (updated.error) {
      if (updated.error.code === '23514') return jsonResponse(409, { error: 'cannot_remove_last_superadmin' });
      if (updated.error.code === '42501') return jsonResponse(403, { error: 'access_denied' });
      throw updated.error;
    }
    if (parsed.data.active !== undefined) {
      const authUpdate = await admin.auth.admin.updateUserById(parsed.data.targetUid, {
        ban_duration: parsed.data.active ? 'none' : '876000h',
      });
      if (authUpdate.error) {
        await recordReconciliation(admin, 'staff.auth_status', 'staff_profile', parsed.data.targetUid, authUpdate.error.code ?? 'auth_update_failed', { active: parsed.data.active });
        return jsonResponse(503, { error: 'profile_updated_auth_reconciliation_required' });
      }
    }
    return jsonResponse(200, { ok: true });
  } catch (error) {
    if (error instanceof HttpError) return jsonResponse(error.status, { error: error.code });
    console.error('Staff update failed.', error instanceof Error ? error.message : 'unknown_error');
    return jsonResponse(503, { error: 'service_unavailable' });
  }
}
export default { fetch: handleRequest };
