import { HttpError, requireStaffActor } from '../../server/actors.js';
import { decodeCursorStrict, encodeCursor } from '../../server/cursor.js';
import { jsonResponse, readBearerToken } from '../../server/http.js';
import { getServerSupabaseClients } from '../../server/supabase.js';

interface RawRecordPassRow {
  id: string;
  visitor_id: string;
  source: 'portal' | 'kiosk';
  status: 'issued' | 'pending' | 'inside' | 'rejected' | 'exited' | 'expired';
  valid_from: string;
  valid_until: string;
  issued_at: string;
  entry_scanned_at: string | null;
  decided_at: string | null;
  time_in: string | null;
  time_out: string | null;
  entry_device_id: string | null;
  exit_device_id: string | null;
  decided_by: string | null;
  rejection_reason: string | null;
  gate: string | null;
  visitors: {
    full_name: string;
    purpose: string;
    visitor_evidence: Array<{ id: string; kind: 'photo' | 'id' }>;
  } | null;
}

function mapPass(row: RawRecordPassRow) {
  const visitor = row.visitors;
  const evidenceList = visitor?.visitor_evidence ?? [];
  const photoId = evidenceList.find((e) => e.kind === 'photo')?.id ?? null;
  const idImageId = evidenceList.find((e) => e.kind === 'id')?.id ?? null;

  return {
    id: row.id,
    visitorId: row.visitor_id,
    visitorName: visitor?.full_name ?? '',
    purpose: visitor?.purpose ?? '',
    photoPublicId: photoId,
    idImagePublicId: idImageId,
    source: row.source,
    status: row.status,
    validFrom: row.valid_from,
    validUntil: row.valid_until,
    issuedAt: row.issued_at,
    scannedAt: row.entry_scanned_at,
    timeIn: row.time_in,
    timeOut: row.time_out,
    entryDeviceId: row.entry_device_id,
    exitDeviceId: row.exit_device_id,
    decidedByUid: row.decided_by,
    rejectionReason: row.rejection_reason,
    gate: row.gate,
  };
}

async function handleRequest(request: Request): Promise<Response> {
  if (request.method !== 'GET') {
    return jsonResponse(405, { error: 'method_not_allowed' }, { Allow: 'GET' });
  }

  const token = readBearerToken(request);
  if (!token) return jsonResponse(401, { error: 'authentication_required' });

  const url = new URL(request.url);
  const statusParam = url.searchParams.get('status')?.trim();
  const dateParam = url.searchParams.get('date')?.trim();
  const searchParam = url.searchParams.get('search')?.trim().toLowerCase();
  const cursor = url.searchParams.get('cursor')?.trim();
  const pageSizeParam = parseInt(url.searchParams.get('pageSize') || '50', 10);
  const pageSize = Math.min(Math.max(Number.isFinite(pageSizeParam) ? pageSizeParam : 50, 1), 250);

  try {
    const { admin } = getServerSupabaseClients();
    await requireStaffActor(admin, token, ['admin', 'superadmin']);

    let query = admin
      .from('passes')
      .select(`
        id,
        visitor_id,
        source,
        status,
        valid_from,
        valid_until,
        issued_at,
        entry_scanned_at,
        decided_at,
        time_in,
        time_out,
        entry_device_id,
        exit_device_id,
        decided_by,
        rejection_reason,
        gate,
        visitors!inner (
          full_name,
          purpose,
          visitor_evidence (
            id,
            kind
          )
        )
      `)
      .order('issued_at', { ascending: false })
      .order('id', { ascending: false });

    if (statusParam) {
      query = query.eq('status', statusParam);
    }

    if (dateParam && /^\d{4}-\d{2}-\d{2}$/.test(dateParam)) {
      const start = `${dateParam}T00:00:00+08:00`;
      const nextDayDate = new Date(new Date(`${dateParam}T00:00:00+08:00`).getTime() + 86_400_000);
      const end = nextDayDate.toISOString();
      query = query.gte('issued_at', start).lt('issued_at', end);
    }

    if (searchParam) {
      query = query.ilike('visitors.full_name', `%${searchParam}%`);
    }

    if (cursor) {
      const decoded = decodeCursorStrict(cursor, { idType: 'uuid' });
      if (decoded) {
        if (decoded.id) {
          query = query.or(`issued_at.lt.${decoded.timestamp},and(issued_at.eq.${decoded.timestamp},id.lt.${decoded.id})`);
        } else {
          query = query.lt('issued_at', decoded.timestamp);
        }
      }
    }

    query = query.limit(pageSize + 1);

    const { data: rawRows, error } = await query;
    if (error) throw error;

    const rows = (rawRows ?? []) as unknown as RawRecordPassRow[];
    const hasMore = rows.length > pageSize;
    const returnRows = hasMore ? rows.slice(0, pageSize) : rows;
    const passes = returnRows.map(mapPass);
    const lastRow = returnRows[returnRows.length - 1];
    const nextCursor = hasMore && lastRow ? encodeCursor(lastRow.issued_at, lastRow.id) : null;

    return jsonResponse(200, {
      passes,
      nextCursor,
      hasMore,
    });
  } catch (error) {
    if (error instanceof HttpError) return jsonResponse(error.status, { error: error.code });
    console.error('Visitor records load failed.', error instanceof Error ? error.message : 'unknown_error');
    return jsonResponse(503, { error: 'service_unavailable' });
  }
}

export default { fetch: handleRequest };
