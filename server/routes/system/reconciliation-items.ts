import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { HttpError, requireStaffActor } from '../../actors.js';
import { decodeCursorStrict, encodeCursor } from '../../cursor.js';
import { jsonResponse, readBearerToken } from '../../http.js';
import { getServerSupabaseClients } from '../../supabase.js';

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

const patchSchema = z.object({
  taskId: z.string().uuid(),
  resolutionNote: z.string().trim().min(1).max(500),
}).strict();

async function handleRequest(request: Request): Promise<Response> {
  const token = readBearerToken(request);
  if (!token) return jsonResponse(401, { error: 'authentication_required' });

  const { admin } = getServerSupabaseClients();

  // PATCH: Resolve reconciliation task (Super Admin required)
  if (request.method === 'PATCH') {
    let rawBody: unknown;
    try {
      rawBody = await request.json();
    } catch {
      return jsonResponse(400, { error: 'invalid_json_body' });
    }

    const parsed = patchSchema.safeParse(rawBody);
    if (!parsed.success) {
      return jsonResponse(400, { error: 'invalid_resolution_payload', details: parsed.error.issues });
    }

    try {
      const actor = await requireStaffActor(admin, token, ['superadmin']);
      const rpcResult = await admin.schema('api').rpc('resolve_reconciliation_task', {
        requested_actor_id: actor.id,
        requested_task_id: parsed.data.taskId,
        requested_note: parsed.data.resolutionNote,
        requested_request_id: randomUUID(),
      });

      if (rpcResult.error) {
        const errCode = rpcResult.error.code;
        const errMsg = rpcResult.error.message || 'resolution_failed';
        if (errCode === '42501' || errMsg.includes('super administrator required')) {
          throw new HttpError(403, 'super_administrator_required');
        }
        if (errCode === 'P0002' || errMsg.includes('reconciliation task not found')) {
          throw new HttpError(404, 'reconciliation_task_not_found');
        }
        throw new HttpError(503, errMsg);
      }

      return jsonResponse(200, {
        ok: true,
        resolved: true,
        taskId: parsed.data.taskId,
      });
    } catch (error) {
      if (error instanceof HttpError) return jsonResponse(error.status, { error: error.code || error.message });
      console.error('Reconciliation item resolution failed.', error instanceof Error ? error.message : 'unknown_error');
      return jsonResponse(503, { error: 'service_unavailable' });
    }
  }

  if (request.method !== 'GET') {
    return jsonResponse(405, { error: 'method_not_allowed' }, { Allow: 'GET, PATCH' });
  }

  const url = new URL(request.url);
  const cursor = url.searchParams.get('cursor')?.trim();
  const pageSizeParam = parseInt(url.searchParams.get('pageSize') || '50', 10);
  const pageSize = Math.min(Math.max(Number.isFinite(pageSizeParam) ? pageSizeParam : 50, 1), 250);

  try {
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
      status: row.status ?? 'pending',
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
    if (error instanceof HttpError) return jsonResponse(error.status, { error: error.code || error.message });
    console.error('Reconciliation items load failed.', error instanceof Error ? error.message : 'unknown_error');
    return jsonResponse(503, { error: 'service_unavailable' });
  }
}

export default { fetch: handleRequest };
