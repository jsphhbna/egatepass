import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { controlledDeviceEmail, HttpError, recordReconciliation, requireStaffActor } from '../server/actors.js';
import { jsonResponse, readBearerToken } from '../server/http.js';
import { getServerSupabaseClients } from '../server/supabase.js';

const schema = z.object({ name: z.string().trim().min(2).max(50), type: z.enum(['entry', 'exit', 'kiosk']), gate: z.string().trim().min(1).max(50), email: z.string().min(3).max(320), password: z.string().min(12).max(128).regex(/[A-Za-z]/).regex(/\d/) }).strict();
async function handleRequest(request: Request): Promise<Response> {
  if (request.method !== 'POST') return jsonResponse(405, { error: 'method_not_allowed' }, { Allow: 'POST' });
  const token = readBearerToken(request); const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!token) return jsonResponse(401, { error: 'authentication_required' });
  if (!parsed.success) return jsonResponse(400, { error: 'invalid_request' });
  const identity = controlledDeviceEmail(parsed.data.email);
  if (!identity) return jsonResponse(400, { error: 'invalid_device_alias' });
  try {
    const { admin } = getServerSupabaseClients(); const actor = await requireStaffActor(admin, token, ['admin', 'superadmin']);
    const created = await admin.auth.admin.createUser({ email: identity.email, password: parsed.data.password, email_confirm: true });
    if (created.error || !created.data.user) throw created.error ?? new Error('auth_create_failed');
    const targetId = created.data.user.id;
    const profile = await admin.schema('api').rpc('create_device_profile', {
      requested_actor_id: actor.id, requested_user_id: targetId, requested_alias: identity.alias,
      requested_name: parsed.data.name, requested_type: parsed.data.type, requested_gate: parsed.data.gate,
      requested_request_id: randomUUID(),
    });
    if (profile.error) {
      const cleanup = await admin.auth.admin.deleteUser(targetId);
      if (cleanup.error) await recordReconciliation(admin, 'device.create.rollback_auth', 'device', targetId, cleanup.error.code ?? 'cleanup_failed');
      throw profile.error;
    }
    return jsonResponse(201, { deviceId: targetId, alias: identity.alias });
  } catch (error) {
    if (error instanceof HttpError) return jsonResponse(error.status, { error: error.code });
    const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : 'service_unavailable';
    console.error('Device creation failed.', code);
    return jsonResponse(code.includes('unique') || code.includes('exists') ? 409 : 503, { error: code });
  }
}
export default { fetch: handleRequest };
