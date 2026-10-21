import { HttpError, requireStaffActor } from '../../actors.js';
import { jsonResponse, readBearerToken } from '../../http.js';
import { getServerSupabaseClients } from '../../supabase.js';

interface RawEmergencyPassRow {
  id: string;
  visitor_id: string;
  gate: string | null;
  time_in: string | null;
  issued_at: string | null;
  valid_from: string | null;
  valid_until: string | null;
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

  const url = new URL(request.url);
  const gateParam = url.searchParams.get('gate')?.trim();

  try {
    const { admin } = getServerSupabaseClients();
    await requireStaffActor(admin, token, ['admin', 'superadmin']);

    const PAGE_SIZE = 1000;
    const MAX_EMERGENCY_RECORDS = 10000;
    let offset = 0;
    const allRows: RawEmergencyPassRow[] = [];
    let truncated = false;

    while (allRows.length < MAX_EMERGENCY_RECORDS) {
      let query = admin
        .from('passes')
        .select(`
          id,
          visitor_id,
          gate,
          time_in,
          issued_at,
          valid_from,
          valid_until,
          status,
          visitors (
            full_name,
            purpose
          )
        `)
        .eq('status', 'inside')
        .order('time_in', { ascending: false })
        .order('id', { ascending: false });

      if (gateParam) {
        query = query.eq('gate', gateParam);
      }

      const { data: pageRows, error } = await query.range(offset, offset + PAGE_SIZE - 1);
      if (error) throw error;

      const rows = (pageRows ?? []) as unknown as RawEmergencyPassRow[];
      allRows.push(...rows);

      if (rows.length < PAGE_SIZE) {
        break;
      }
      offset += PAGE_SIZE;
      if (allRows.length >= MAX_EMERGENCY_RECORDS) {
        truncated = true;
        break;
      }
    }

    const passes = allRows.map((row) => ({
      id: row.id,
      visitorId: row.visitor_id,
      visitorName: row.visitors?.full_name ?? '',
      purpose: row.visitors?.purpose ?? '',
      gate: row.gate,
      timeIn: row.time_in,
      issuedAt: row.issued_at,
      validFrom: row.valid_from,
      validUntil: row.valid_until,
      status: row.status,
    }));

    return jsonResponse(200, { passes, total: passes.length, truncated });
  } catch (error) {
    if (error instanceof HttpError) return jsonResponse(error.status, { error: error.code });
    console.error('Emergency evacuation pass load failed.', error instanceof Error ? error.message : 'unknown_error');
    return jsonResponse(503, { error: 'service_unavailable' });
  }
}

export default { fetch: handleRequest };
