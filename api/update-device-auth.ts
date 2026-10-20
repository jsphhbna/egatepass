import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { controlledDeviceEmail, HttpError, recordReconciliation, requireStaffActor } from '../server/actors.js';
import { jsonResponse, readBearerToken } from '../server/http.js';
import { getServerSupabaseClients } from '../server/supabase.js';

const schema = z.object({ targetUid: z.string().uuid(), email: z.string().min(3).max(320).optional(), password: z.string().min(12).max(128).regex(/[A-Za-z]/).regex(/\d/).optional() }).strict().refine((v) => v.email || v.password);
async function handleRequest(request: Request): Promise<Response> {
  if (request.method !== 'POST') return jsonResponse(405, { error: 'method_not_allowed' }, { Allow: 'POST' });
  const token = readBearerToken(request); const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!token) return jsonResponse(401, { error: 'authentication_required' }); if (!parsed.success) return jsonResponse(400, { error: 'invalid_request' });
  const nextIdentity = parsed.data.email ? controlledDeviceEmail(parsed.data.email) : null;
  if (parsed.data.email && !nextIdentity) return jsonResponse(400, { error: 'invalid_device_alias' });
  try {
    const { admin } = getServerSupabaseClients(); const actor = await requireStaffActor(admin, token, ['superadmin']);
    const before = await admin.auth.admin.getUserById(parsed.data.targetUid); if (before.error || !before.data.user) return jsonResponse(404, { error: 'device_not_found' });
    const authUpdate = await admin.auth.admin.updateUserById(parsed.data.targetUid, { ...(nextIdentity ? { email: nextIdentity.email, email_confirm: true } : {}), ...(parsed.data.password ? { password: parsed.data.password } : {}) });
    if (authUpdate.error) throw authUpdate.error;
    if (nextIdentity) {
      const profile = await admin.schema('api').rpc('update_device_profile', { requested_actor_id: actor.id, requested_user_id: parsed.data.targetUid, requested_status: null, requested_alias: nextIdentity.alias, requested_request_id: randomUUID() });
      if (profile.error) {
        const rollback = before.data.user.email ? await admin.auth.admin.updateUserById(parsed.data.targetUid, { email: before.data.user.email, email_confirm: true }) : null;
        if (rollback?.error) await recordReconciliation(admin, 'device.credentials.rollback_auth', 'device', parsed.data.targetUid, rollback.error.code ?? 'rollback_failed');
        throw profile.error;
      }
    } else {
      await admin.from('audit_events').insert({
        actor_id: actor.id,
        actor_kind: 'staff',
        actor_role: actor.role,
        action: 'device.password_update',
        target_type: 'device',
        target_id: parsed.data.targetUid,
        outcome: 'success',
      });
    }
    return jsonResponse(200, { ok: true });
  } catch (error) { if (error instanceof HttpError) return jsonResponse(error.status, { error: error.code }); console.error('Device credential update failed.', error instanceof Error ? error.message : 'unknown_error'); return jsonResponse(503, { error: 'service_unavailable' }); }
}
export default { fetch: handleRequest };
