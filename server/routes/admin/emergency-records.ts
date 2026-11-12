import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { HttpError, requireStaffActor } from '../../actors.js';
import { decodeCursorStrict, encodeCursor } from '../../cursor.js';
import { jsonResponse, readBearerToken } from '../../http.js';
import { normalizeGateName } from '../../lib/emergency-manifest.js';
import { getServerSupabaseClients } from '../../supabase.js';

const reconcileBodySchema = z.object({
  recordId: z.string().uuid(),
  decision: z.enum(['accepted', 'needs_review', 'duplicate', 'rejected']),
  notes: z.string().trim().min(5).max(1000),
  requestId: z.string().uuid().optional(),
}).strict();

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isValidIsoDate(val: string): boolean {
  if (!DATE_RE.test(val)) return false;
  const parsed = new Date(`${val}T00:00:00+08:00`);
  if (Number.isNaN(parsed.getTime())) return false;
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(parsed) === val;
}

async function handleGet(request: Request): Promise<Response> {
  const token = readBearerToken(request);
  if (!token) return jsonResponse(401, { error: 'authentication_required' });

  try {
    const { admin } = getServerSupabaseClients();
    await requireStaffActor(admin, token, ['admin', 'superadmin']);

    const url = new URL(request.url);
    const statusParam = url.searchParams.get('status')?.trim() || '';
    const gateParam = url.searchParams.get('gate')?.trim() || '';
    const dateFrom = url.searchParams.get('dateFrom')?.trim() || '';
    const dateTo = url.searchParams.get('dateTo')?.trim() || '';
    const recordIdParam = url.searchParams.get('recordId')?.trim() || '';
    const limit = Math.max(1, Math.min(200, Number(url.searchParams.get('limit') || 50) || 50));

    if (dateFrom && !isValidIsoDate(dateFrom)) {
      return jsonResponse(400, { error: 'invalid_date_from' });
    }
    if (dateTo && !isValidIsoDate(dateTo)) {
      return jsonResponse(400, { error: 'invalid_date_to' });
    }
    if (dateFrom && dateTo && dateFrom > dateTo) {
      return jsonResponse(400, { error: 'invalid_date_range' });
    }

    const cursorParam = url.searchParams.get('cursor')?.trim() || '';
    let currentCursor: { timestamp: string; id: string } | null = null;
    if (cursorParam) {
      try {
        const decoded = decodeCursorStrict(cursorParam, { idType: 'uuid' });
        if (decoded?.timestamp && decoded?.id) {
          currentCursor = { timestamp: decoded.timestamp, id: decoded.id };
        }
      } catch {
        return jsonResponse(400, { error: 'invalid_cursor', message: 'Malformed compound cursor' });
      }
    }

    let query = admin
      .from('emergency_gate_records')
      .select('*')
      .order('server_received_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(limit + 1);

    if (currentCursor) {
      query = query.or(
        `server_received_at.lt.${currentCursor.timestamp},and(server_received_at.eq.${currentCursor.timestamp},id.lt.${currentCursor.id})`,
      );
    }
    if (recordIdParam) {
      query = query.eq('id', recordIdParam);
    }
    if (statusParam && statusParam !== 'all') {
      query = query.eq('reconciliation_status', statusParam);
    }
    if (gateParam && gateParam !== 'all') {
      query = query.eq('normalized_gate', normalizeGateName(gateParam));
    }
    if (dateFrom) {
      query = query.gte('local_recorded_at', `${dateFrom}T00:00:00+08:00`);
    }
    if (dateTo) {
      query = query.lte('local_recorded_at', `${dateTo}T23:59:59.999+08:00`);
    }

    const { data: rawRows, error } = await query;
    if (error) throw error;

    const pageRows = rawRows || [];
    let hasMore = false;
    let nextCursor: string | null = null;

    if (pageRows.length > limit) {
      hasMore = true;
      pageRows.pop();
      const last = pageRows[pageRows.length - 1];
      if (last?.server_received_at && last?.id) {
        nextCursor = encodeCursor(last.server_received_at, last.id);
      }
    }

    const recordList = pageRows;
    const recordIds = recordList.map((r) => r.id as string);
    const deviceUserIds = Array.from(
      new Set(recordList.map((r) => r.device_user_id as string).filter(Boolean)),
    );

    const [receiptsRes, devicesRes] = await Promise.all([
      recordIds.length > 0
        ? admin
            .from('emergency_sync_receipts')
            .select('*')
            .in('emergency_record_id', recordIds)
            .order('created_at', { ascending: false })
        : Promise.resolve({ data: [] as Array<Record<string, unknown>>, error: null }),
      deviceUserIds.length > 0
        ? admin
            .from('devices')
            .select('user_id, name, alias, gate, status')
            .in('user_id', deviceUserIds)
        : Promise.resolve({ data: [] as Array<Record<string, unknown>>, error: null }),
    ]);

    if (receiptsRes.error) throw receiptsRes.error;
    if (devicesRes.error) throw devicesRes.error;

    const deviceMap = new Map(
      (devicesRes.data || []).map((d) => [d.user_id as string, d]),
    );
    const receiptsByRecordId: Record<string, Array<Record<string, unknown>>> = {};
    for (const rec of receiptsRes.data || []) {
      const id = rec.emergency_record_id as string;
      if (!receiptsByRecordId[id]) receiptsByRecordId[id] = [];
      receiptsByRecordId[id].push(rec);
    }

    const records = recordList.map((r) => {
      const device = deviceMap.get(r.device_user_id as string);
      return {
        ...r,
        device_name: (device?.name as string | undefined) ?? null,
        device_alias: (device?.alias as string | undefined) ?? null,
        current_device_status: (device?.status as string | undefined) ?? null,
        receipts: receiptsByRecordId[r.id as string] || [],
      };
    });

    // Calculate summary counts across the entire filtered dataset (not just the current page)
    const buildSummaryFilter = (base: any) => {
      let q = base;
      if (recordIdParam) q = q.eq('id', recordIdParam);
      if (gateParam && gateParam !== 'all') q = q.eq('normalized_gate', normalizeGateName(gateParam));
      if (dateFrom) q = q.gte('local_recorded_at', `${dateFrom}T00:00:00+08:00`);
      if (dateTo) q = q.lte('local_recorded_at', `${dateTo}T23:59:59.999+08:00`);
      return q;
    };

    const [
      totalCountRes,
      needsReviewCountRes,
      receivedCountRes,
      acceptedCountRes,
      duplicateCountRes,
      rejectedCountRes,
    ] = await Promise.all([
      buildSummaryFilter(admin.from('emergency_gate_records').select('*', { count: 'exact', head: true })),
      buildSummaryFilter(admin.from('emergency_gate_records').select('*', { count: 'exact', head: true }).eq('reconciliation_status', 'needs_review')),
      buildSummaryFilter(admin.from('emergency_gate_records').select('*', { count: 'exact', head: true }).eq('reconciliation_status', 'received')),
      buildSummaryFilter(admin.from('emergency_gate_records').select('*', { count: 'exact', head: true }).eq('reconciliation_status', 'accepted')),
      buildSummaryFilter(admin.from('emergency_gate_records').select('*', { count: 'exact', head: true }).eq('reconciliation_status', 'duplicate')),
      buildSummaryFilter(admin.from('emergency_gate_records').select('*', { count: 'exact', head: true }).eq('reconciliation_status', 'rejected')),
    ]);

    const summary = {
      totalCount: totalCountRes.count ?? 0,
      needsReviewCount: needsReviewCountRes.count ?? 0,
      receivedCount: receivedCountRes.count ?? 0,
      acceptedCount: acceptedCountRes.count ?? 0,
      duplicateCount: duplicateCountRes.count ?? 0,
      rejectedCount: rejectedCountRes.count ?? 0,
    };

    return jsonResponse(200, {
      classification: 'OFFLINE MODE RECORDED',
      records,
      total: summary.totalCount,
      hasMore,
      nextCursor,
      summary,
    });
  } catch (error) {
    if (error instanceof HttpError) {
      return jsonResponse(error.status, { error: error.code });
    }
    console.error('Admin emergency records GET error:', error);
    return jsonResponse(503, { error: 'emergency_records_unavailable' });
  }
}

async function handlePost(request: Request): Promise<Response> {
  const token = readBearerToken(request);
  if (!token) return jsonResponse(401, { error: 'authentication_required' });

  try {
    const { admin } = getServerSupabaseClients();
    const actor = await requireStaffActor(admin, token, ['admin', 'superadmin']);

    const body = await request.json().catch(() => null);
    const parsed = reconcileBodySchema.safeParse(body);
    if (!parsed.success) {
      return jsonResponse(400, { error: 'invalid_reconciliation_request' });
    }

    const clientRequestId = parsed.data.requestId || randomUUID();
    const { data, error } = await admin.schema('api').rpc('reconcile_emergency_gate_record', {
      requested_actor_id: actor.id,
      requested_record_id: parsed.data.recordId,
      requested_decision: parsed.data.decision,
      requested_notes: parsed.data.notes,
      requested_request_id: clientRequestId,
    });

    if (error) {
      const code = (error as { code?: string }).code;
      const msg = String(error.message || '');
      if (code === 'P0002') {
        return jsonResponse(404, { error: 'emergency_record_not_found' });
      }
      if (code === '40900' || msg.includes('record_already_finalized') || msg.includes('reconciliation_request_conflict')) {
        return jsonResponse(409, { error: 'reconciliation_conflict', message: msg });
      }
      if (code === '22023') {
        return jsonResponse(400, { error: msg || 'invalid_reconciliation_request' });
      }
      if (code === '42501') {
        return jsonResponse(403, { error: msg || 'access_denied' });
      }
      throw error;
    }

    return jsonResponse(200, data);
  } catch (error) {
    if (error instanceof HttpError) {
      return jsonResponse(error.status, { error: error.code });
    }
    console.error('Admin emergency records POST error:', error);
    return jsonResponse(503, { error: 'emergency_reconciliation_unavailable' });
  }
}

async function handleRequest(request: Request): Promise<Response> {
  if (request.method === 'GET') {
    return handleGet(request);
  }
  if (request.method === 'POST') {
    return handlePost(request);
  }
  return jsonResponse(405, { error: 'method_not_allowed' }, { Allow: 'GET, POST' });
}

export default { fetch: handleRequest };
