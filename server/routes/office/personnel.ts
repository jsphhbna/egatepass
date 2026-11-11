import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { requireOfficeStaffActor } from '../../lib/office.js';
import { jsonResponse, readBearerToken } from '../../http.js';
import { getServerSupabaseClients } from '../../supabase.js';
import { HttpError } from '../../actors.js';

const postSchema = z.object({
  officeId: z.string().uuid(),
  name: z.string().trim().min(2).max(150),
  title: z.string().trim().max(120).optional().nullable(),
}).strict();

const patchSchema = z.object({
  personnelId: z.string().uuid().optional(),
  id: z.string().uuid().optional(),
  name: z.string().trim().min(2).max(150).optional(),
  title: z.string().trim().max(120).optional().nullable(),
  active: z.boolean().optional(),
}).strict().refine((data) => Boolean(data.personnelId || data.id), {
  message: 'personnelId or id is required',
  path: ['personnelId'],
});

export async function handleRequest(request: Request): Promise<Response> {
  const method = request.method;
  const { admin } = getServerSupabaseClients();

  if (method === 'GET') {
    const url = new URL(request.url);
    const officeId = url.searchParams.get('officeId');
    const token = readBearerToken(request);

    if (!officeId) {
      if (token) {
        try {
          const actor = await requireOfficeStaffActor(admin, token);
          if (actor.role === 'office_staff') {
            if (actor.assignedOfficeIds.length === 0) {
              return jsonResponse(200, {
                offices: [],
                code: 'no_office_assigned_to_staff',
                message: 'No office assigned to staff account.',
              });
            }
            const { data: assignedOffices, error: aErr } = await admin
              .from('offices')
              .select('id, name, description, active, verified, publication_status, requires_approval_before_pass, archived_at')
              .in('id', actor.assignedOfficeIds)
              .eq('active', true)
              .is('archived_at', null)
              .order('name');

            if (aErr) throw aErr;
            return jsonResponse(200, { offices: assignedOffices || [] });
          }
        } catch {
          // Fall through to public / unauthenticated path
        }
      }

      const { data: offices, error: offErr } = await admin
        .from('offices')
        .select('id, name, description, active, verified, publication_status, requires_approval_before_pass, archived_at')
        .eq('active', true)
        .eq('publication_status', 'published')
        .is('archived_at', null)
        .order('name');

      if (offErr) {
        console.error('Failed to get offices:', offErr);
        return jsonResponse(500, { error: 'failed_to_get_offices' });
      }

      return jsonResponse(200, { offices: offices || [] });
    }

    let isStaff = false;
    if (token) {
      try {
        await requireOfficeStaffActor(admin, token, officeId);
        isStaff = true;
      } catch (err) {
        if (err instanceof HttpError) {
          return jsonResponse(err.status, { error: err.code });
        }
        throw err;
      }
    }

    if (!isStaff) {
      const { data: officeRow, error: pubErr } = await admin
        .from('offices')
        .select('id, active, publication_status, archived_at')
        .eq('id', officeId)
        .maybeSingle();

      if (pubErr) {
        return jsonResponse(500, { error: 'failed_to_verify_office' });
      }
      if (!officeRow || !officeRow.active || officeRow.publication_status !== 'published' || officeRow.archived_at) {
        return jsonResponse(200, { personnel: [] });
      }
    }

    let personnelQuery = admin
      .from('office_personnel')
      .select('id, office_id, name, title, active, created_at, updated_at')
      .eq('office_id', officeId);

    if (!isStaff) {
      personnelQuery = personnelQuery.eq('active', true);
    }

    const { data: personnel, error } = await personnelQuery.order('name');

    if (error) {
      console.error('Failed to get office personnel:', error);
      return jsonResponse(500, { error: 'failed_to_get_personnel' });
    }

    return jsonResponse(200, { personnel: personnel || [] });
  }

  const token = readBearerToken(request);
  if (!token) return jsonResponse(401, { error: 'Authentication required' });

  try {
    if (method === 'POST') {
      const parsed = postSchema.safeParse(await request.json().catch(() => null));
      if (!parsed.success) {
        return jsonResponse(400, { error: 'invalid_request', details: parsed.error.issues });
      }

      const actor = await requireOfficeStaffActor(admin, token, parsed.data.officeId);

      const { data: saved, error: rpcErr } = await admin.schema('api').rpc('save_office_personnel_record', {
        requested_actor_id: actor.id,
        requested_personnel_id: null,
        requested_office_id: parsed.data.officeId,
        requested_name: parsed.data.name,
        requested_title: parsed.data.title ?? null,
        requested_active: true,
        requested_request_id: randomUUID(),
      });

      if (rpcErr) {
        const code = (rpcErr as { code?: string }).code;
        if (code === '42501') return jsonResponse(403, { error: rpcErr.message || 'access_denied' });
        if (code === '22023') return jsonResponse(400, { error: rpcErr.message || 'invalid_request' });
        throw rpcErr;
      }

      const row = (saved || {}) as Record<string, unknown>;
      return jsonResponse(201, {
        personnel: {
          id: row.id,
          office_id: row.officeId ?? parsed.data.officeId,
          officeId: row.officeId ?? parsed.data.officeId,
          name: row.name,
          title: row.title ?? null,
          active: row.active ?? true,
        },
      });
    }

    if (method === 'PATCH') {
      const parsed = patchSchema.safeParse(await request.json().catch(() => null));
      if (!parsed.success) {
        return jsonResponse(400, { error: 'invalid_request', details: parsed.error.issues });
      }

      const effectivePersonnelId = (parsed.data.personnelId || parsed.data.id)!;
      const { data: existing, error: fetchErr } = await admin
        .from('office_personnel')
        .select('office_id')
        .eq('id', effectivePersonnelId)
        .maybeSingle();

      if (fetchErr || !existing) return jsonResponse(404, { error: 'personnel_not_found' });

      const actor = await requireOfficeStaffActor(admin, token, existing.office_id);

      const { data: saved, error: rpcErr } = await admin.schema('api').rpc('save_office_personnel_record', {
        requested_actor_id: actor.id,
        requested_personnel_id: effectivePersonnelId,
        requested_office_id: existing.office_id,
        requested_name: parsed.data.name ?? null,
        requested_title: parsed.data.title !== undefined ? parsed.data.title : null,
        requested_active: parsed.data.active !== undefined ? parsed.data.active : null,
        requested_request_id: randomUUID(),
      });

      if (rpcErr) {
        const code = (rpcErr as { code?: string }).code;
        if (code === 'P0002') return jsonResponse(404, { error: 'personnel_not_found' });
        if (code === '42501') return jsonResponse(403, { error: rpcErr.message || 'access_denied' });
        if (code === '22023') return jsonResponse(400, { error: rpcErr.message || 'invalid_request' });
        throw rpcErr;
      }

      const row = (saved || {}) as Record<string, unknown>;
      return jsonResponse(200, {
        personnel: {
          id: row.id,
          office_id: row.officeId ?? existing.office_id,
          officeId: row.officeId ?? existing.office_id,
          name: row.name,
          title: row.title ?? null,
          active: row.active,
        },
      });
    }

    return jsonResponse(405, { error: 'Method not allowed' }, { Allow: 'GET, POST, PATCH' });
  } catch (error) {
    if (error instanceof HttpError) {
      return jsonResponse(error.status, { error: error.code });
    }
    console.error('Personnel operation failed:', error);
    return jsonResponse(500, { error: 'personnel_operation_failed' });
  }
}

export default { fetch: handleRequest };
