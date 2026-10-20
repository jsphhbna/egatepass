import { jsonResponse, readBearerToken } from '../../server/http.js';
import { HttpError, requireStaffActor } from '../../server/actors.js';
import { getServerSupabaseClients } from '../../server/supabase.js';

async function handleRequest(request: Request): Promise<Response> {
  if (request.method !== 'GET') return jsonResponse(405, { error: 'method_not_allowed' }, { Allow: 'GET' });
  const token = readBearerToken(request);
  if (!token) return jsonResponse(401, { error: 'authentication_required' });
  try {
    const { admin } = getServerSupabaseClients();
    await requireStaffActor(admin, token, ['admin', 'superadmin']);
    const { data: profiles, error } = await admin.from('staff_profiles')
      .select('user_id, display_name, role, active, privacy_accepted_at, must_change_password, created_at')
      .order('created_at', { ascending: false }).limit(200);
    if (error) throw error;
    const { data: authPage, error: authListError } = await admin.auth.admin.listUsers({ page: 1, perPage: 200 });
    if (authListError) throw authListError;
    const emails = new Map(authPage.users.map((user) => [user.id, user.email ?? '']));
    return jsonResponse(200, { users: (profiles ?? []).map((profile) => ({
      uid: profile.user_id, name: profile.display_name, email: emails.get(profile.user_id) ?? '',
      role: profile.role, active: profile.active, privacyAcceptedAt: profile.privacy_accepted_at,
      mustChangePassword: profile.must_change_password, createdAt: profile.created_at,
    })) });
  } catch (error) {
    if (error instanceof HttpError) return jsonResponse(error.status, { error: error.code });
    console.error('Staff list failed.', error instanceof Error ? error.message : 'unknown_error');
    return jsonResponse(503, { error: 'service_unavailable' });
  }
}
export default { fetch: handleRequest };
