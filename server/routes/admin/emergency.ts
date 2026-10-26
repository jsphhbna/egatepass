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
    const snapshotAt = new Date().toISOString();
    const allRows: RawEmergencyPassRow[] = [];
    let truncated = false;

    // Authoritative snapshot total of visitors physically inside at snapshotAt
    let countQuery = admin
      .from('passes')
      .select('id', { count: 'exact', head: true })
      .lte('time_in', snapshotAt)
      .or(`time_out.is.null,time_out.gt.${snapshotAt}`);

    if (gateParam) {
      countQuery = countQuery.eq('gate', gateParam);
    }

    const { count, error: countError } = await countQuery;
    if (countError) throw countError;
    const snapshotTotal = count ?? 0;

    let cursorTimeIn: string | null = null;
    let cursorId: string | null = null;
    let previousCursorKey: string | null = null;

    while (allRows.length < MAX_EMERGENCY_RECORDS) {
      const remainingLimit = Math.min(PAGE_SIZE, MAX_EMERGENCY_RECORDS - allRows.length);
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
        .lte('time_in', snapshotAt)
        .or(`time_out.is.null,time_out.gt.${snapshotAt}`)
        .order('time_in', { ascending: false })
        .order('id', { ascending: false })
        .limit(remainingLimit);

      if (gateParam) {
        query = query.eq('gate', gateParam);
      }

      if (cursorTimeIn !== null && cursorId !== null) {
        query = query.or(`time_in.lt.${cursorTimeIn},and(time_in.eq.${cursorTimeIn},id.lt.${cursorId})`);
      }

      const { data: pageRows, error } = await query;
      if (error) throw error;

      const rows = (pageRows ?? []) as unknown as RawEmergencyPassRow[];
      if (rows.length === 0) {
        break;
      }

      allRows.push(...rows);

      if (rows.length < remainingLimit) {
        break;
      }

      const lastRow = rows[rows.length - 1];
      if (!lastRow || !lastRow.time_in) {
        break;
      }
      const nextCursorKey = `${lastRow.time_in}_${lastRow.id}`;
      // Progress guard: stop if cursor fails to advance
      if (nextCursorKey === previousCursorKey) {
        console.warn('Emergency keyset pagination cursor failed to advance. Stopping.');
        break;
      }
      previousCursorKey = nextCursorKey;
      cursorTimeIn = lastRow.time_in;
      cursorId = lastRow.id;

      if (allRows.length >= MAX_EMERGENCY_RECORDS) {
        break;
      }
    }

    if (snapshotTotal > allRows.length) {
      truncated = true;
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

    return jsonResponse(200, {
      passes,
      total: passes.length,
      snapshotTotal,
      snapshotAt,
      truncated,
    });
  } catch (error) {
    if (error instanceof HttpError) return jsonResponse(error.status, { error: error.code });
    console.error('Emergency evacuation pass load failed.', error instanceof Error ? error.message : 'unknown_error');
    return jsonResponse(503, { error: 'service_unavailable' });
  }
}

export default { fetch: handleRequest };
