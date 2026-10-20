import { z } from 'zod';
import { jsonResponse, readBearerToken } from '../../server/http.js';
import { getServerSupabaseClients } from '../../server/supabase.js';

const requestSchema = z.object({
  currentPassword: z.string().min(1).max(256),
  newPassword: z.string().min(12).max(128).regex(/[A-Za-z]/).regex(/\d/),
}).refine(({ currentPassword, newPassword }) => currentPassword !== newPassword, {
  message: 'new password must differ from current password',
  path: ['newPassword'],
});

async function handleRequest(request: Request): Promise<Response> {
  if (request.method !== 'POST') return jsonResponse(405, { error: 'method_not_allowed' }, { Allow: 'POST' });

  const token = readBearerToken(request);
  const requestBody = await request.json().catch(() => null);
  const parsed = requestSchema.safeParse(requestBody);
  if (!token) return jsonResponse(401, { error: 'authentication_required' });
  if (!parsed.success) return jsonResponse(400, { error: 'invalid_request' });

  try {
    const { admin, passwordVerifier } = getServerSupabaseClients();
    const { data: identity, error: identityError } = await admin.auth.getUser(token);
    const user = identity.user;
    if (identityError || !user?.email) return jsonResponse(401, { error: 'invalid_session' });

    const { data: profile, error: profileError } = await admin
      .from('staff_profiles')
      .select('role, active, must_change_password')
      .eq('user_id', user.id)
      .maybeSingle();
    if (profileError) throw profileError;
    if (!profile || profile.role !== 'guard' || !profile.active || !profile.must_change_password) {
      return jsonResponse(403, { error: 'password_change_not_allowed' });
    }

    const { data: verified, error: verificationError } = await passwordVerifier.auth.signInWithPassword({
      email: user.email,
      password: parsed.data.currentPassword,
    });
    if (verificationError || verified.user?.id !== user.id) {
      return jsonResponse(401, { error: 'invalid_current_password' });
    }

    const { error: passwordError } = await admin.auth.admin.updateUserById(user.id, {
      password: parsed.data.newPassword,
    });
    if (passwordError) throw passwordError;

    const { error: finalizeError } = await admin.schema('api').rpc('finalize_guard_password_change', {
      target_user_id: user.id,
    });
    if (finalizeError) {
      await admin.from('reconciliation_tasks').insert({
        operation: 'guard.password_change_finalize',
        reference_type: 'staff_profile',
        reference_id: user.id,
        safe_context: { passwordChanged: true },
      });
      return jsonResponse(503, { error: 'password_changed_finalization_pending' });
    }

    await passwordVerifier.auth.signOut();
    return jsonResponse(200, { ok: true });
  } catch (error) {
    console.error('Guard password change failed.', error instanceof Error ? error.message : 'unknown_error');
    return jsonResponse(503, { error: 'service_unavailable' });
  }
}

export default { fetch: handleRequest };
