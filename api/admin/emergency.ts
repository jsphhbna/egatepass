import { HttpError, requireStaffActor } from '../../server/actors.js';
import { jsonResponse, readBearerToken } from '../../server/http.js';
import { getServerSupabaseClients } from '../../server/supabase.js';

interface RawEmergencyPassRow {
  id: string;
  visitor_id: string;
  gate: string | null;
  time_in: string | null;
  status: 'inside';
  visitors: {
    full_name: string;
    purpose: string;
  } | null;
}

async function handleRequest(request: Request): Promise<Response> {
  if (request.method !== 'GET') {
    return jsonResponse(405, { error: 'method_not_allowed' }, { Allow: 'GET' });
  }

  const token = readBearerToken(request);
  if (!token) return jsonResponse(401, { error: 'authentication_required' });

  try {
    const { admin } = getServerSupabaseClients();
    await requireStaffActor(admin, token, ['admin', 'superadmin']);

    const { data: rows, error } = await admin
      .from('passes')
      .select(`
        id,
        visitor_id,
        gate,
        time_in,
        status,
        visitors (
          full_name,
          purpose
        )
      `)
      .eq('status', 'inside')
      .order('time_in', { ascending: false })
      .limit(500);

    if (error) throw error;

    const passes = ((rows ?? []) as unknown as RawEmergencyPassRow[]).map((row) => ({
      id: row.id,
      visitorId: row.visitor_id,
      visitorName: row.visitors?.full_name ?? '',
      purpose: row.visitors?.purpose ?? '',
      gate: row.gate,
      timeIn: row.time_in,
      status: row.status,
    }));

    return jsonResponse(200, { passes });
  } catch (error) {
    if (error instanceof HttpError) return jsonResponse(error.status, { error: error.code });
    console.error('Emergency evacuation pass load failed.', error instanceof Error ? error.message : 'unknown_error');
    return jsonResponse(503, { error: 'service_unavailable' });
  }
}

export default { fetch: handleRequest };
