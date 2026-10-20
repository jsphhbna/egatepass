import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { HttpError, requireStaffActor } from '../../server/actors.js';
import { jsonResponse, readBearerToken } from '../../server/http.js';
import { getServerSupabaseClients } from '../../server/supabase.js';

const createHoldSchema = z.object({
  visitorId: z.string().uuid().nullable().optional(),
  passId: z.string().uuid().nullable().optional(),
  reason: z.string().trim().min(5).max(500),
}).refine(data => Boolean(data.visitorId || data.passId), {
  message: 'At least one of visitorId or passId is required',
});

const releaseHoldSchema = z.object({
  holdId: z.string().uuid(),
});

async function handleRequest(request: Request): Promise<Response> {
  const token = readBearerToken(request);
  if (!token) return jsonResponse(401, { error: 'authentication_required' });

  const url = new URL(request.url);

  try {
    const { admin } = getServerSupabaseClients();

    // 1. GET: List holds (admin or superadmin)
    if (request.method === 'GET') {
      await requireStaffActor(admin, token, ['admin', 'superadmin']);

      const activeParam = url.searchParams.get('active');
      const limitParam = parseInt(url.searchParams.get('limit') || '50', 10);
      const limit = Math.min(Math.max(Number.isFinite(limitParam) ? limitParam : 50, 1), 100);

      let query = admin
        .from('incident_holds')
        .select(`
          id,
          visitor_id,
          pass_id,
          reason,
          active,
          created_by,
          created_at,
          released_by,
          released_at,
          visitors (
            full_name
          ),
          passes (
            public_reference
          )
        `)
        .order('created_at', { ascending: false })
        .limit(limit);

      if (activeParam === 'true') {
        query = query.eq('active', true);
      } else if (activeParam === 'false') {
        query = query.eq('active', false);
      }

      const { data, error } = await query;
      if (error) throw error;

      return jsonResponse(200, {
        holds: (data || []).map((h: any) => ({
          id: h.id,
          visitorId: h.visitor_id,
          passId: h.pass_id,
          visitorName: h.visitors?.full_name ?? null,
          passReference: h.passes?.public_reference ?? null,
          reason: h.reason,
          active: h.active,
          createdBy: h.created_by,
          createdAt: h.created_at,
          releasedBy: h.released_by,
          releasedAt: h.released_at,
        })),
      });
    }

    // 2. POST: Create hold (superadmin only)
    if (request.method === 'POST') {
      const actor = await requireStaffActor(admin, token, ['superadmin']);
      const body = await request.json().catch(() => null);
      const parsed = createHoldSchema.safeParse(body);
      if (!parsed.success) {
        return jsonResponse(400, { error: 'invalid_request', details: parsed.error.issues });
      }

      const requestId = randomUUID();
      const { data, error } = await admin.schema('api').rpc('create_incident_hold', {
        requested_actor_id: actor.id,
        requested_visitor_id: parsed.data.visitorId ?? null,
        requested_pass_id: parsed.data.passId ?? null,
        requested_reason: parsed.data.reason,
        requested_request_id: requestId,
      });

      if (error) {
        if (error.code === '40001' || error.message?.includes('active_purge_claim_in_progress')) {
          return jsonResponse(409, { error: 'active_purge_claim_in_progress' });
        }
        if (error.code === '22023' || error.message?.includes('evidence_already_purged')) {
          return jsonResponse(409, { error: 'evidence_already_purged' });
        }
        throw error;
      }

      return jsonResponse(201, {
        holdId: data,
        requestId,
      });
    }

    // 3. DELETE or PATCH: Release hold (superadmin only)
    if (request.method === 'DELETE' || request.method === 'PATCH') {
      const actor = await requireStaffActor(admin, token, ['superadmin']);
      const holdIdFromQuery = url.searchParams.get('id');
      const body = await request.json().catch(() => ({}));
      const holdId = holdIdFromQuery || body?.holdId;

      const parsed = releaseHoldSchema.safeParse({ holdId });
      if (!parsed.success) {
        return jsonResponse(400, { error: 'invalid_request', details: parsed.error.issues });
      }

      const requestId = randomUUID();
      const { data, error } = await admin.schema('api').rpc('release_incident_hold', {
        requested_actor_id: actor.id,
        requested_hold_id: parsed.data.holdId,
        requested_request_id: requestId,
      });

      if (error) {
        if (error.code === 'P0002' || error.message?.includes('incident_hold_not_found')) {
          return jsonResponse(404, { error: 'incident_hold_not_found' });
        }
        throw error;
      }

      return jsonResponse(200, {
        released: data,
        requestId,
      });
    }

    return jsonResponse(405, { error: 'method_not_allowed' }, { Allow: 'GET, POST, DELETE, PATCH' });
  } catch (error) {
    if (error instanceof HttpError) {
      return jsonResponse(error.status, { error: error.code });
    }
    console.error('Incident hold operation failed:', error instanceof Error ? error.message : 'unknown_error');
    return jsonResponse(500, { error: 'internal_error' });
  }
}

export default { fetch: handleRequest };
