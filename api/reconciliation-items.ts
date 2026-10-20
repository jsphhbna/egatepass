import { HttpError, requireStaffActor } from '../server/actors.js';
import { decodeCursorStrict, encodeCursor } from '../server/cursor.js';
import { jsonResponse, readBearerToken } from '../server/http.js';
import { getServerSupabaseClients } from '../server/supabase.js';

interface RawReconciliationTask {
  id: string;
  operation: string;
  status: string;
  reference_type: string;
  reference_id: string | null;
  last_error_code: string | null;
  safe_context: Record<string, unknown> | null;
  created_at: string;
}

async function handleRequest(request: Request): Promise<Response> {
  if (request.method !== 'GET') {
    return jsonResponse(405, { error: 'method_not_allowed' }, { Allow: 'GET' });
  }

  const token = readBearerToken(request);
  if (!token) return jsonResponse(401, { error: 'authentication_required' });

  const url = new URL(request.url);
  const cursor = url.searchParams.get('cursor')?.trim();
  const pageSizeParam = parseInt(url.searchParams.get('pageSize') || '50', 10);
  const pageSize = Math.min(Math.max(Number.isFinite(pageSizeParam) ? pageSizeParam : 50, 1), 250);

  try {
    const { admin } = getServerSupabaseClients();
    await requireStaffActor(admin, token, ['superadmin']);

    const countRes = await admin
      .from('reconciliation_tasks')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'pending');
    if (countRes.error) throw countRes.error;
    const unresolvedTotal = countRes.count ?? 0;

    let query = admin
      .from('reconciliation_tasks')
      .select('id, operation, status, reference_type, reference_id, last_error_code, safe_context, created_at')
      .eq('status', 'pending')
      .order('created_at', { ascending: false })
      .order('id', { ascending: false });

    if (cursor) {
      const decoded = decodeCursorStrict(cursor, { idType: 'uuid' });
      if (decoded) {
        if (decoded.id) {
          query = query.or(`created_at.lt.${decoded.timestamp},and(created_at.eq.${decoded.timestamp},id.lt.${decoded.id})`);
        } else {
          query = query.lt('created_at', decoded.timestamp);
        }
      }
    }

    query = query.limit(pageSize + 1);

    const { data: rows, error } = await query;
    if (error) throw error;

    const rawRows = (rows ?? []) as unknown as RawReconciliationTask[];
    const hasMore = rawRows.length > pageSize;
    const returnRows = hasMore ? rawRows.slice(0, pageSize) : rawRows;
    const lastRow = returnRows[returnRows.length - 1];
    const nextCursor = hasMore && lastRow ? encodeCursor(lastRow.created_at, lastRow.id) : null;

    const items = returnRows.map((row) => ({
      id: row.id,
      type: row.operation,
      status: 'unresolved',
      targetType: row.reference_type,
      targetId: row.reference_id ?? 'unknown',
      createdAt: row.created_at,
      summary: row.last_error_code ? `Error: ${row.last_error_code}` : 'Manual investigation is required',
      requiredActions: ['Inspect linked identity or storage asset', 'Verify consistency and resolve task'],
    }));

    return jsonResponse(200, {
      items,
      count: items.length,
      total: unresolvedTotal,
      hasMore,
      nextCursor,
      limit: pageSize,
      readOnly: true,
    });
  } catch (error) {
    if (error instanceof HttpError) return jsonResponse(error.status, { error: error.code });
    console.error('Reconciliation items load failed.', error instanceof Error ? error.message : 'unknown_error');
    return jsonResponse(503, { error: 'service_unavailable' });
  }
}

export default { fetch: handleRequest };
