import { jsonResponse, readBearerToken } from '../../server/http.js';
import { HttpError, requireStaffActor } from '../../server/actors.js';
import { decodeCursorStrict, encodeCursor } from '../../server/cursor.js';
import { getServerSupabaseClients } from '../../server/supabase.js';

interface RawDeviceRow {
  user_id: string;
  name: string;
  alias: string;
  type: string;
  gate: string | null;
  status: string;
  created_by: string | null;
  created_at: string;
  last_seen_at: string | null;
}

async function handleRequest(request: Request): Promise<Response> {
  if (request.method !== 'GET') return jsonResponse(405, { error: 'method_not_allowed' }, { Allow: 'GET' });
  const token = readBearerToken(request);
  if (!token) return jsonResponse(401, { error: 'authentication_required' });

  const url = new URL(request.url);
  const cursor = url.searchParams.get('cursor')?.trim();
  const pageSizeParam = parseInt(url.searchParams.get('pageSize') || '50', 10);
  const pageSize = Math.min(Math.max(Number.isFinite(pageSizeParam) ? pageSizeParam : 50, 1), 200);

  try {
    const { admin } = getServerSupabaseClients();
    await requireStaffActor(admin, token, ['admin', 'superadmin']);

    const countRes = await admin
      .from('devices')
      .select('user_id', { count: 'exact', head: true })
      .is('deleted_at', null);
    if (countRes.error) throw countRes.error;
    const totalCount = countRes.count ?? 0;

    let query = admin
      .from('devices')
      .select('*')
      .is('deleted_at', null)
      .order('created_at', { ascending: false })
      .order('user_id', { ascending: false });

    if (cursor) {
      const decoded = decodeCursorStrict(cursor, { idType: 'uuid' });
      if (decoded) {
        if (decoded.id) {
          query = query.or(`created_at.lt.${decoded.timestamp},and(created_at.eq.${decoded.timestamp},user_id.lt.${decoded.id})`);
        } else {
          query = query.lt('created_at', decoded.timestamp);
        }
      }
    }

    query = query.limit(pageSize + 1);
    const { data: rawDevices, error } = await query;
    if (error) throw error;

    const deviceRows = (rawDevices ?? []) as unknown as RawDeviceRow[];
    const hasMore = deviceRows.length > pageSize;
    const returnDevices = hasMore ? deviceRows.slice(0, pageSize) : deviceRows;
    const lastDevice = returnDevices[returnDevices.length - 1];
    const nextCursor = hasMore && lastDevice ? encodeCursor(lastDevice.created_at, lastDevice.user_id) : null;

    // Direct Auth email lookup by ID eliminates page-1 truncation
    const emailLookups = await Promise.all(
      returnDevices.map(async (device) => {
        try {
          const { data: userRes } = await admin.auth.admin.getUserById(device.user_id);
          return [device.user_id, userRes.user?.email ?? ''] as const;
        } catch {
          return [device.user_id, ''] as const;
        }
      })
    );
    const emails = new Map(emailLookups);

    return jsonResponse(200, {
      devices: returnDevices.map((device) => ({
        id: device.user_id,
        name: device.name,
        type: device.type,
        gate: device.gate,
        status: device.status,
        email: emails.get(device.user_id) || `${device.alias}@devices.egatepass.invalid`,
        createdBy: device.created_by,
        createdAt: device.created_at,
        lastSeen: device.last_seen_at,
      })),
      total: totalCount,
      hasMore,
      nextCursor,
      limit: pageSize,
    });
  } catch (error) {
    if (error instanceof HttpError) return jsonResponse(error.status, { error: error.code });
    console.error('Device list failed.', error instanceof Error ? error.message : 'unknown_error');
    return jsonResponse(503, { error: 'service_unavailable' });
  }
}
export default { fetch: handleRequest };
