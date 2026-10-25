import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { HttpError, requireStaffActor } from '../../actors.js';
import { jsonResponse, readBearerToken } from '../../http.js';
import { getServerSupabaseClients } from '../../supabase.js';

const createHoldSchema = z.object({
  visitorId: z.string().uuid().nullable().optional(),
  passId: z.string().uuid().nullable().optional(),
  reason: z.string().trim().min(5).max(500),
}).refine(data => Boolean(data.visitorId || data.passId), {
  message: 'At least one of visitorId or passId is required',
});

const releaseHoldSchema = z.object({
  holdId: z.string().uuid(),
  reason: z.string().trim().min(1).max(500).optional(),
});

const getHoldsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  active: z.enum(['true', 'false']).optional(),
  activeOnly: z.enum(['true', 'false']).optional(),
  passId: z.string().uuid().optional(),
  visitorId: z.string().uuid().optional(),
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

      const queryParsed = getHoldsQuerySchema.safeParse({
        limit: url.searchParams.get('limit') || undefined,
        active: url.searchParams.get('active') || undefined,
        activeOnly: url.searchParams.get('activeOnly') || undefined,
        passId: url.searchParams.get('passId') || undefined,
        visitorId: url.searchParams.get('visitorId') || undefined,
      });

      if (!queryParsed.success) {
        return jsonResponse(400, { error: 'invalid_request', details: queryParsed.error.issues });
      }

      const { passId, visitorId, active, activeOnly } = queryParsed.data;
      const limit = queryParsed.data.limit ?? (passId || visitorId ? 100 : 50);

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
        `);

      if (passId && visitorId) {
        query = query.or(`pass_id.eq.${passId},visitor_id.eq.${visitorId}`);
      } else if (passId) {
        query = query.eq('pass_id', passId);
      } else if (visitorId) {
        query = query.eq('visitor_id', visitorId);
      }

      const isActiveFilter = activeOnly === 'true' || active === 'true';
      const isInactiveFilter = activeOnly === 'false' || active === 'false';

      if (isActiveFilter) {
        query = query.eq('active', true);
      } else if (isInactiveFilter) {
        query = query.eq('active', false);
      }

      if (!passId && !visitorId) {
        query = query.order('created_at', { ascending: false });
      }
      query = query.limit(limit);

      const { data, error } = await query;
      if (error) throw error;

      let holds = (data || []).map((h: any) => ({
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
      }));

      if (passId || visitorId) {
        holds.sort((a, b) => {
          // Direct pass hold first
          const aPass = passId && a.passId === passId ? 0 : 1;
          const bPass = passId && b.passId === passId ? 0 : 1;
          if (aPass !== bPass) return aPass - bPass;

          // Visitor-level hold
          const aVis = visitorId && a.visitorId === visitorId ? 0 : 1;
          const bVis = visitorId && b.visitorId === visitorId ? 0 : 1;
          if (aVis !== bVis) return aVis - bVis;

          // Newest created_at
          return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
        });
      }

      return jsonResponse(200, { holds });
    }

    // 2. POST: Create hold (superadmin only)
    if (request.method === 'POST') {
      const actor = await requireStaffActor(admin, token, ['superadmin']);
      const body = await request.json().catch(() => null);
      const parsed = createHoldSchema.safeParse(body);
      if (!parsed.success) {
        return jsonResponse(400, { error: 'invalid_request', details: parsed.error.issues });
      }

      if (parsed.data.visitorId && parsed.data.passId) {
        const { data: passRow, error: passErr } = await admin
          .from('passes')
          .select('visitor_id')
          .eq('id', parsed.data.passId)
          .maybeSingle();

        if (passErr) throw passErr;
        if (!passRow || passRow.visitor_id !== parsed.data.visitorId) {
          return jsonResponse(400, { error: 'pass_visitor_mismatch' });
        }
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
        if (error.code === '22023' && error.message?.includes('pass_visitor_mismatch')) {
          return jsonResponse(400, { error: 'pass_visitor_mismatch' });
        }
        if (error.code === '40001' || error.message?.includes('active_purge_claim_in_progress') || error.message?.includes('purge_in_progress')) {
          return jsonResponse(409, { error: 'active_purge_claim_in_progress' });
        }
        if (error.code === '22023' || error.message?.includes('evidence_already_purged')) {
          return jsonResponse(409, { error: 'evidence_already_purged' });
        }
        throw error;
      }

      if (data?.conflict === 'purge_in_progress') {
        return jsonResponse(409, { error: 'active_purge_claim_in_progress' });
      }
      if (data?.conflict === 'evidence_already_purged') {
        return jsonResponse(409, { error: 'evidence_already_purged' });
      }

      return jsonResponse(201, {
        holdId: data?.hold_id ?? data,
        requestId,
      });
    }

    // 3. DELETE or PATCH: Release hold (superadmin only)
    if (request.method === 'DELETE' || request.method === 'PATCH') {
      const actor = await requireStaffActor(admin, token, ['superadmin']);
      const holdIdFromQuery = url.searchParams.get('id');
      const body = await request.json().catch(() => ({}));
      const holdId = holdIdFromQuery || body?.holdId;
      const reason = body?.reason;

      const parsed = releaseHoldSchema.safeParse({ holdId, reason });
      if (!parsed.success) {
        return jsonResponse(400, { error: 'invalid_request', details: parsed.error.issues });
      }

      const requestId = randomUUID();
      const { data, error } = await admin.schema('api').rpc('release_incident_hold', {
        requested_actor_id: actor.id,
        requested_hold_id: parsed.data.holdId,
        requested_reason: parsed.data.reason ?? null,
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
    return jsonResponse(500, { error: 'incident_hold_operation_failed' });
  }
}

export default { fetch: handleRequest };
