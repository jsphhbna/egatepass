import { jsonResponse, readBearerToken } from '../../server/http.js';
import { HttpError, requireStaffActor } from '../../server/actors.js';
import { getServerSupabaseClients } from '../../server/supabase.js';

async function handleRequest(request: Request): Promise<Response> {
  if (request.method !== 'GET') return jsonResponse(405, { error: 'method_not_allowed' }, { Allow: 'GET' });
  const token = readBearerToken(request); if (!token) return jsonResponse(401, { error: 'authentication_required' });
  try {
    const { admin } = getServerSupabaseClients(); await requireStaffActor(admin, token, ['admin', 'superadmin']);
    const { data: devices, error } = await admin.from('devices').select('*').is('deleted_at', null).order('created_at', { ascending: false }).limit(200);
    if (error) throw error;
    const { data: authPage, error: authError } = await admin.auth.admin.listUsers({ page: 1, perPage: 200 });
    if (authError) throw authError;
    const emails = new Map(authPage.users.map((user) => [user.id, user.email ?? '']));
    return jsonResponse(200, { devices: (devices ?? []).map((device) => ({
      id: device.user_id, name: device.name, type: device.type, gate: device.gate,
      status: device.status, email: emails.get(device.user_id) ?? `${device.alias}@devices.egatepass.invalid`,
      createdBy: device.created_by, createdAt: device.created_at, lastSeen: device.last_seen_at,
    })) });
  } catch (error) {
    if (error instanceof HttpError) return jsonResponse(error.status, { error: error.code });
    console.error('Device list failed.', error instanceof Error ? error.message : 'unknown_error');
    return jsonResponse(503, { error: 'service_unavailable' });
  }
}
export default { fetch: handleRequest };
