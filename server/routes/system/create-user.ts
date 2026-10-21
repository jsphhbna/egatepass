import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { HttpError, recordReconciliation, requireStaffActor } from '../../actors.js';
import { jsonResponse, readBearerToken } from '../../http.js';
import { passwordSchema } from '../../password-policy.js';
import { getServerSupabaseClients } from '../../supabase.js';

const schema = z.object({
  name: z.string().trim().min(2).max(50), email: z.email().max(320),
  password: passwordSchema, role: z.enum(['guard', 'admin']),
}).strict();

async function handleRequest(request: Request): Promise<Response> {
  if (request.method !== 'POST') return jsonResponse(405, { error: 'method_not_allowed' }, { Allow: 'POST' });
  const token = readBearerToken(request); const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!token) return jsonResponse(401, { error: 'authentication_required' });
  if (!parsed.success) return jsonResponse(400, { error: 'invalid_request' });
  try {
    const { admin } = getServerSupabaseClients();
    const actor = await requireStaffActor(admin, token, ['admin', 'superadmin']);
    if (actor.role === 'admin' && parsed.data.role !== 'guard') return jsonResponse(403, { error: 'admins_may_create_guards_only' });
    const created = await admin.auth.admin.createUser({ email: parsed.data.email.toLowerCase(), password: parsed.data.password, email_confirm: false });
    if (created.error || !created.data.user) throw created.error ?? new Error('auth_create_failed');
    const targetId = created.data.user.id;
    const profile = await admin.schema('api').rpc('create_staff_profile', {
      requested_actor_id: actor.id, requested_user_id: targetId, requested_name: parsed.data.name,
      requested_role: parsed.data.role, requested_request_id: randomUUID(),
    });
    if (profile.error) {
      const cleanup = await admin.auth.admin.deleteUser(targetId);
      if (cleanup.error) await recordReconciliation(admin, 'staff.create.rollback_auth', 'staff_profile', targetId, cleanup.error.code ?? 'cleanup_failed');
      throw profile.error;
    }
    const resend = await admin.auth.resend({ type: 'signup', email: parsed.data.email.toLowerCase() });
    if (resend.error) await recordReconciliation(admin, 'staff.verification_email', 'staff_profile', targetId, resend.error.code ?? 'email_failed');
    return jsonResponse(201, { userId: targetId, verificationEmailSent: !resend.error, confirmationPending: true });
  } catch (error) {
    if (error instanceof HttpError) return jsonResponse(error.status, { error: error.code });
    const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : 'service_unavailable';
    console.error('Staff creation failed.', code);
    return jsonResponse(code === 'email_exists' || code === 'user_already_exists' ? 409 : 503, { error: code });
  }
}
export default { fetch: handleRequest };
