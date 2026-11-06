import { z } from 'zod';
import { requireOfficeStaffActor } from '../../lib/office.js';
import { jsonResponse, readBearerToken } from '../../http.js';
import { getServerSupabaseClients } from '../../supabase.js';
import { HttpError } from '../../actors.js';

const schema = z.object({
  visitId: z.string().uuid(),
}).strict();

export async function handleRequest(request: Request): Promise<Response> {
  if (request.method !== 'POST') {
    return jsonResponse(405, { error: 'Method not allowed' }, { Allow: 'POST' });
  }

  const token = readBearerToken(request);
  if (!token) return jsonResponse(401, { error: 'Authentication required' });

  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return jsonResponse(400, { error: 'Invalid confirmation request' });
  }

  try {
    const { admin } = getServerSupabaseClients();
    const actor = await requireOfficeStaffActor(admin, token);

    // Call atomic RPC
    const { data: rows, error: rpcErr } = await admin.schema('api').rpc('confirm_office_arrival', {
      requested_actor_id: actor.id,
      requested_visit_id: parsed.data.visitId,
    });

    if (rpcErr) {
      if (rpcErr.message?.includes('unauthorized_for_this_office')) {
        return jsonResponse(403, { error: 'unauthorized_for_this_office' });
      }
      if (rpcErr.message?.includes('visitor_must_be_inside_campus')) {
        return jsonResponse(409, {
          error: 'visitor_must_be_inside_campus',
          message: 'Arrival can only be confirmed after the visitor has successfully entered campus through the gate.',
        });
      }
      if (rpcErr.message?.includes('visit_not_found')) {
        return jsonResponse(404, { error: 'visit_not_found' });
      }
      throw rpcErr;
    }

    const result = Array.isArray(rows) ? rows[0] : rows;
    return jsonResponse(200, {
      ok: true,
      attendanceStatus: result?.attendance_status || 'confirmed',
      confirmedAt: result?.confirmed_at || new Date().toISOString(),
    });
  } catch (error) {
    if (error instanceof HttpError) {
      return jsonResponse(error.status, { error: error.code });
    }
    console.error('Failed to confirm office arrival:', error);
    return jsonResponse(500, { error: 'arrival_confirmation_failed' });
  }
}

export default { fetch: handleRequest };
