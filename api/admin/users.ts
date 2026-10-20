import { jsonResponse, readBearerToken } from '../../server/http.js';
import { HttpError, requireStaffActor } from '../../server/actors.js';
import { getServerSupabaseClients } from '../../server/supabase.js';

interface CursorData {
  createdAt: string;
  userId: string;
}

function decodeCursor(cursor: string): CursorData | null {
  try {
    const raw = Buffer.from(cursor, 'base64').toString('utf8');
    const parsed = JSON.parse(raw);
    if (typeof parsed.createdAt === 'string' && typeof parsed.userId === 'string') {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

function encodeCursor(createdAt: string, userId: string): string {
  return Buffer.from(JSON.stringify({ createdAt, userId })).toString('base64');
}

async function handleRequest(request: Request): Promise<Response> {
  if (request.method !== 'GET') return jsonResponse(405, { error: 'method_not_allowed' }, { Allow: 'GET' });
  const token = readBearerToken(request);
  if (!token) return jsonResponse(401, { error: 'authentication_required' });

  const url = new URL(request.url);
  const rawLimit = Number(url.searchParams.get('limit'));
  const limit = Number.isInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 100) : 50;
  const rawCursor = url.searchParams.get('cursor');
  const cursor = rawCursor ? decodeCursor(rawCursor) : null;

  try {
    const { admin } = getServerSupabaseClients();
    await requireStaffActor(admin, token, ['admin', 'superadmin']);

    let query = admin.from('staff_profiles')
      .select('user_id, display_name, role, active, privacy_accepted_at, must_change_password, created_at')
      .order('created_at', { ascending: false })
      .order('user_id', { ascending: false })
      .limit(limit + 1);

    if (cursor) {
      query = query.or(`created_at.lt.${cursor.createdAt},and(created_at.eq.${cursor.createdAt},user_id.lt.${cursor.userId})`);
    }

    const { data: profiles, error } = await query;
    if (error) throw error;

    const rows = profiles ?? [];
    const hasMore = rows.length > limit;
    const pageItems = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore && pageItems.length > 0
      ? encodeCursor(pageItems[pageItems.length - 1].created_at, pageItems[pageItems.length - 1].user_id)
      : null;

    const { data: authPage } = await admin.auth.admin.listUsers({ page: 1, perPage: 100 });
    const emails = new Map((authPage?.users ?? []).map((user) => [user.id, user.email ?? '']));

    const missingProfileIds = pageItems
      .map((p) => p.user_id)
      .filter((id) => !emails.has(id));

    if (missingProfileIds.length > 0) {
      const fetched = await Promise.all(
        missingProfileIds.map(async (id) => {
          try {
            const { data: userData } = await admin.auth.admin.getUserById(id);
            return userData?.user ? ([id, userData.user.email ?? ''] as const) : null;
          } catch {
            return null;
          }
        })
      );
      for (const item of fetched) {
        if (item) emails.set(item[0], item[1]);
      }
    }

    return jsonResponse(200, {
      users: pageItems.map((profile) => ({
        uid: profile.user_id,
        name: profile.display_name,
        email: emails.get(profile.user_id) ?? '',
        role: profile.role,
        active: profile.active,
        privacyAcceptedAt: profile.privacy_accepted_at,
        mustChangePassword: profile.must_change_password,
        createdAt: profile.created_at,
      })),
      nextCursor,
      hasMore,
    });
  } catch (error) {
    if (error instanceof HttpError) return jsonResponse(error.status, { error: error.code });
    console.error('Staff list failed.', error instanceof Error ? error.message : 'unknown_error');
    return jsonResponse(503, { error: 'service_unavailable' });
  }
}

export default { fetch: handleRequest };
