import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { HttpError, recordReconciliation, requireStaffActor } from '../../actors.js';
import { jsonResponse, readBearerToken } from '../../http.js';
import { passwordSchema } from '../../password-policy.js';
import { getServerSupabaseClients } from '../../supabase.js';

const schema = z.object({
  name: z.string().trim().min(2).max(50),
  email: z.string().email().max(320),
  password: passwordSchema,
  role: z.literal('admin'),
}).strict();

async function handleRequest(request: Request): Promise<Response> {
  if (request.method !== 'POST') return jsonResponse(405, { error: 'method_not_allowed' }, { Allow: 'POST' });
  const token = readBearerToken(request);
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!token) return jsonResponse(401, { error: 'authentication_required' });
  if (!parsed.success) return jsonResponse(400, { error: 'invalid_request' });

  try {
    const { admin } = getServerSupabaseClients();
    const actor = await requireStaffActor(admin, token, ['superadmin']);

    const normalizedEmail = parsed.data.email.toLowerCase().trim();
    const created = await admin.auth.admin.createUser({
      email: normalizedEmail,
      password: parsed.data.password,
      email_confirm: false,
    });

    if (created.error || !created.data.user) {
      const err = created.error;
      const code = typeof err === 'object' && err !== null && 'code' in err ? String(err.code) : '';
      const msg = typeof err === 'object' && err !== null && 'message' in err ? String(err.message).toLowerCase() : '';

      if (code === 'email_exists' || code === 'user_already_exists' || msg.includes('already exists') || msg.includes('already registered')) {
        // Detect if the existing identity is an unprovisioned orphan identity
        let existingAuthUserId: string | null = null;
        let page = 1;
        while (page <= 10) {
          const { data: pageData } = await admin.auth.admin.listUsers({ page, perPage: 100 });
          if (!pageData?.users || pageData.users.length === 0) break;
          const match = pageData.users.find((u) => u.email?.toLowerCase().trim() === normalizedEmail);
          if (match) {
            existingAuthUserId = match.id;
            break;
          }
          if (pageData.users.length < 100) break;
          page++;
        }

        if (existingAuthUserId) {
          const [{ data: staff }, { data: dev }] = await Promise.all([
            admin.from('staff_profiles').select('user_id').eq('user_id', existingAuthUserId).maybeSingle(),
            admin.from('devices').select('user_id').eq('user_id', existingAuthUserId).maybeSingle(),
          ]);

          if (!staff && !dev) {
            // An authentication account exists but has not been provisioned as staff or device.
            // Do NOT automatically adopt or attach. Return safe operational code.
            return jsonResponse(409, { error: 'existing_auth_identity_unprovisioned' });
          }
        }
        return jsonResponse(409, { error: code || 'user_already_exists' });
      }

      throw created.error ?? new Error('auth_create_failed');
    }

    const targetId = created.data.user.id;
    const profile = await admin.schema('api').rpc('create_staff_profile', {
      requested_actor_id: actor.id,
      requested_user_id: targetId,
      requested_name: parsed.data.name,
      requested_role: parsed.data.role,
      requested_request_id: randomUUID(),
    });

    if (profile.error) {
      const cleanup = await admin.auth.admin.deleteUser(targetId);
      if (cleanup.error) {
        await recordReconciliation(admin, 'staff.create.rollback_auth', 'staff_profile', targetId, cleanup.error.code ?? 'cleanup_failed');
      }
      throw profile.error;
    }

    const resend = await admin.auth.resend({ type: 'signup', email: normalizedEmail });
    if (resend.error) {
      await recordReconciliation(admin, 'staff.verification_email', 'staff_profile', targetId, resend.error.code ?? 'email_failed');
    }

    return jsonResponse(201, {
      userId: targetId,
      verificationEmailSent: !resend.error,
      confirmationPending: true,
    });
  } catch (error) {
    if (error instanceof HttpError) return jsonResponse(error.status, { error: error.code });
    const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : 'service_unavailable';
    console.error('Staff creation failed.', code);
    return jsonResponse(code === 'email_exists' || code === 'user_already_exists' ? 409 : 503, { error: code });
  }
}

export default { fetch: handleRequest };
