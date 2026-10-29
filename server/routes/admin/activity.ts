import { HttpError, requireStaffActor } from '../../actors.js';
import { decodeCursorStrict, encodeCursor } from '../../cursor.js';
import { jsonResponse, readBearerToken } from '../../http.js';
import { getServerSupabaseClients } from '../../supabase.js';

interface RawVisitEventRow {
  id: number;
  occurred_at: string;
  event: string;
  pass_id: string | null;
  visitor_id: string | null;
  reason: string | null;
  device_id: string | null;
  gate: string | null;
  guard_id: string | null;
  visitors: { full_name: string } | null;
  staff_profiles: { display_name: string } | null;
}

interface RawAuditEventRow {
  id: number;
  occurred_at: string;
  actor_id: string | null;
  actor_kind: string;
  actor_role: string | null;
  action: string;
  target_type: string;
  target_id: string | null;
  before_state: Record<string, unknown> | null;
  after_state: Record<string, unknown> | null;
  outcome: string;
}

async function handleRequest(request: Request): Promise<Response> {
  if (request.method !== 'GET') {
    return jsonResponse(405, { error: 'method_not_allowed' }, { Allow: 'GET' });
  }

  const token = readBearerToken(request);
  if (!token) return jsonResponse(401, { error: 'authentication_required' });

  const url = new URL(request.url);
  const type = url.searchParams.get('type') === 'administrative' ? 'administrative' : 'visitor';
  const eventFilter = url.searchParams.get('event')?.trim();
  const roleFilter = url.searchParams.get('role')?.trim();
  const actionFilter = url.searchParams.get('action')?.trim().toLowerCase();
  const dateFrom = url.searchParams.get('dateFrom')?.trim();
  const dateTo = url.searchParams.get('dateTo')?.trim();

  if (dateFrom) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateFrom) || isNaN(Date.parse(`${dateFrom}T00:00:00+08:00`))) {
      return jsonResponse(400, { error: 'invalid_date_from', message: 'dateFrom must be a valid YYYY-MM-DD date' });
    }
  }
  if (dateTo) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateTo) || isNaN(Date.parse(`${dateTo}T00:00:00+08:00`))) {
      return jsonResponse(400, { error: 'invalid_date_to', message: 'dateTo must be a valid YYYY-MM-DD date' });
    }
  }
  if (dateFrom && dateTo && dateFrom > dateTo) {
    return jsonResponse(400, { error: 'invalid_date_range', message: 'dateFrom cannot be later than dateTo' });
  }

  const cursor = url.searchParams.get('cursor')?.trim();
  const pageSizeParam = parseInt(url.searchParams.get('pageSize') || '100', 10);
  const pageSize = Math.min(Math.max(Number.isFinite(pageSizeParam) ? pageSizeParam : 100, 1), 250);

  try {
    const { admin } = getServerSupabaseClients();
    await requireStaffActor(admin, token, ['admin', 'superadmin']);

    if (type === 'visitor') {
      let query = admin
        .from('visit_events')
        .select(`
          id,
          occurred_at,
          event,
          pass_id,
          visitor_id,
          reason,
          device_id,
          gate,
          guard_id,
          visitors ( full_name ),
          staff_profiles ( display_name )
        `)
        .order('occurred_at', { ascending: false })
        .order('id', { ascending: false });

      if (eventFilter) query = query.eq('event', eventFilter);
      if (dateFrom && /^\d{4}-\d{2}-\d{2}$/.test(dateFrom)) {
        query = query.gte('occurred_at', `${dateFrom}T00:00:00+08:00`);
      }
      if (dateTo && /^\d{4}-\d{2}-\d{2}$/.test(dateTo)) {
        const nextDay = new Date(new Date(`${dateTo}T00:00:00+08:00`).getTime() + 86_400_000).toISOString();
        query = query.lt('occurred_at', nextDay);
      }
      if (cursor) {
        const decoded = decodeCursorStrict(cursor, { idType: 'bigint' });
        if (decoded) {
          if (decoded.id) {
            query = query.or(`occurred_at.lt.${decoded.timestamp},and(occurred_at.eq.${decoded.timestamp},id.lt.${decoded.id})`);
          } else {
            query = query.lt('occurred_at', decoded.timestamp);
          }
        }
      }

      query = query.limit(pageSize + 1);

      const { data: rawRows, error } = await query;
      if (error) throw error;

      const rows = (rawRows ?? []) as unknown as RawVisitEventRow[];
      const hasMore = rows.length > pageSize;
      const returnRows = hasMore ? rows.slice(0, pageSize) : rows;
      const lastRow = returnRows[returnRows.length - 1];
      const nextCursor = hasMore && lastRow ? encodeCursor(lastRow.occurred_at, lastRow.id) : null;

      const items = returnRows.map((row) => ({
        id: String(row.id),
        timestamp: row.occurred_at,
        event: row.event,
        passToken: row.pass_id ?? '',
        visitorId: row.visitor_id,
        reason: row.reason,
        deviceId: row.device_id,
        gate: row.gate,
        guardUid: row.guard_id,
        guardName: row.staff_profiles?.display_name ?? null,
        visitorName: row.visitors?.full_name ?? null,
      }));

      return jsonResponse(200, { items, nextCursor, hasMore });
    } else {
      let query = admin
        .from('audit_events')
        .select(`
          id,
          occurred_at,
          actor_id,
          actor_kind,
          actor_role,
          action,
          target_type,
          target_id,
          before_state,
          after_state,
          outcome
        `)
        .order('occurred_at', { ascending: false })
        .order('id', { ascending: false });

      if (roleFilter) query = query.eq('actor_role', roleFilter);
      if (actionFilter) query = query.ilike('action', `%${actionFilter}%`);
      if (dateFrom && /^\d{4}-\d{2}-\d{2}$/.test(dateFrom)) {
        query = query.gte('occurred_at', `${dateFrom}T00:00:00+08:00`);
      }
      if (dateTo && /^\d{4}-\d{2}-\d{2}$/.test(dateTo)) {
        const nextDay = new Date(new Date(`${dateTo}T00:00:00+08:00`).getTime() + 86_400_000).toISOString();
        query = query.lt('occurred_at', nextDay);
      }
      if (cursor) {
        const decoded = decodeCursorStrict(cursor, { idType: 'bigint' });
        if (decoded) {
          if (decoded.id) {
            query = query.or(`occurred_at.lt.${decoded.timestamp},and(occurred_at.eq.${decoded.timestamp},id.lt.${decoded.id})`);
          } else {
            query = query.lt('occurred_at', decoded.timestamp);
          }
        }
      }

      query = query.limit(pageSize + 1);

      const { data: rawRows, error } = await query;
      if (error) throw error;

      const rows = (rawRows ?? []) as unknown as RawAuditEventRow[];
      const hasMore = rows.length > pageSize;
      const returnRows = hasMore ? rows.slice(0, pageSize) : rows;
      const lastAuditRow = returnRows[returnRows.length - 1];
      const nextCursor = hasMore && lastAuditRow ? encodeCursor(lastAuditRow.occurred_at, lastAuditRow.id) : null;

      const items = returnRows.map((row) => {
        const prevRole = typeof row.before_state?.role === 'string' ? row.before_state.role : undefined;
        const nextRole = typeof row.after_state?.role === 'string' ? row.after_state.role : undefined;
        const prevActive = typeof row.before_state?.active === 'boolean' ? row.before_state.active : undefined;
        const nextActive = typeof row.after_state?.active === 'boolean' ? row.after_state.active : undefined;

        return {
          id: String(row.id),
          timestamp: row.occurred_at,
          action: row.action,
          actorUid: row.actor_id ?? 'system',
          actorRole: row.actor_role ?? 'system',
          targetType: row.target_type,
          targetId: row.target_id ?? '',
          targetUid: row.target_id ?? undefined,
          previousRole: prevRole,
          newRole: nextRole,
          previousStatus: prevActive !== undefined ? String(prevActive) : undefined,
          newStatus: nextActive !== undefined ? String(nextActive) : undefined,
          result: row.outcome,
          metadata: {
            before: row.before_state,
            after: row.after_state,
          },
        };
      });

      return jsonResponse(200, { items, nextCursor, hasMore });
    }
  } catch (error) {
    if (error instanceof HttpError) return jsonResponse(error.status, { error: error.code });
    console.error('Audit activity load failed.', error instanceof Error ? error.message : 'unknown_error');
    return jsonResponse(503, { error: 'service_unavailable' });
  }
}

export default { fetch: handleRequest };
