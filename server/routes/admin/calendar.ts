import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { HttpError, requireStaffActor } from '../../actors.js';
import { jsonResponse, readBearerToken } from '../../http.js';
import { getServerSupabaseClients } from '../../supabase.js';

const closureTypeSchema = z.enum(['holiday', 'campus_closure', 'emergency_suspension']);

const createClosureSchema = z.object({
  title: z.string().trim().min(2).max(150),
  closureType: closureTypeSchema,
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  description: z.string().trim().max(500).optional().nullable(),
  active: z.boolean().optional().default(true),
  published: z.boolean().optional().default(true),
}).strict().refine((data) => data.endDate >= data.startDate, {
  message: 'endDate must be greater than or equal to startDate',
  path: ['endDate'],
});

const patchClosureSchema = z.object({
  id: z.string().uuid(),
  title: z.string().trim().min(2).max(150).optional(),
  closureType: closureTypeSchema.optional(),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  description: z.string().trim().max(500).optional().nullable(),
  active: z.boolean().optional(),
  published: z.boolean().optional(),
  archive: z.boolean().optional(),
}).strict();

const deleteClosureSchema = z.object({
  id: z.string().uuid(),
}).strict();

interface OverlapSummary {
  id: string;
  title: string;
  closureType: string;
  startDate: string;
  endDate: string;
}

function findOverlaps(
  targetId: string,
  startDate: string,
  endDate: string,
  existing: Array<{
    id: string;
    title: string;
    closure_type: string;
    start_date: string;
    end_date: string;
    archived_at?: string | null;
    active: boolean;
  }>,
): OverlapSummary[] {
  return existing
    .filter(
      (c) =>
        c.id !== targetId &&
        !c.archived_at &&
        c.active &&
        c.start_date <= endDate &&
        c.end_date >= startDate,
    )
    .map((c) => ({
      id: c.id,
      title: c.title,
      closureType: c.closure_type,
      startDate: c.start_date,
      endDate: c.end_date,
    }));
}

export async function handleRequest(request: Request): Promise<Response> {
  const token = readBearerToken(request);
  if (!token) return jsonResponse(401, { error: 'authentication_required' });

  try {
    const { admin } = getServerSupabaseClients();
    const actor = await requireStaffActor(admin, token, ['admin', 'superadmin']);

    if (request.method === 'GET') {
      const url = new URL(request.url);
      const activeOnly = url.searchParams.get('activeOnly') === 'true';
      const includeArchived = url.searchParams.get('includeArchived') === 'true';

      let query = admin
        .from('campus_calendar_closures')
        .select('id, title, closure_type, start_date, end_date, description, active, published, archived_at, archived_by, created_by, updated_by, created_at, updated_at')
        .order('start_date', { ascending: true });

      if (activeOnly) {
        query = query.eq('active', true);
      }
      if (!includeArchived) {
        query = query.is('archived_at', null);
      }

      const { data, error } = await query;
      if (error) throw error;

      const rawRows = (data || []) as Array<any>;
      const closures = rawRows.map((row) => ({
        id: row.id,
        title: row.title,
        closureType: row.closure_type,
        startDate: row.start_date,
        endDate: row.end_date,
        description: row.description,
        active: row.active,
        published: row.published,
        archivedAt: row.archived_at ?? null,
        archivedBy: row.archived_by ?? null,
        overlaps: findOverlaps(row.id, row.start_date, row.end_date, rawRows),
        createdBy: row.created_by,
        updatedBy: row.updated_by,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }));

      return jsonResponse(200, { closures });
    }

    if (actor.role !== 'superadmin') {
      return jsonResponse(403, { error: 'superadmin_required', message: 'Only superadmin can modify campus calendar closures' });
    }

    if (request.method === 'POST') {
      const body = await request.json().catch(() => null);
      const parsed = createClosureSchema.safeParse(body);
      if (!parsed.success) {
        return jsonResponse(400, { error: 'invalid_request', details: parsed.error.issues });
      }

      const { data, error } = await admin.schema('api').rpc('save_campus_calendar_closure', {
        requested_actor_id: actor.id,
        requested_closure_id: null,
        requested_title: parsed.data.title,
        requested_closure_type: parsed.data.closureType,
        requested_start_date: parsed.data.startDate,
        requested_end_date: parsed.data.endDate,
        requested_description: parsed.data.description ?? null,
        requested_active: parsed.data.active ?? true,
        requested_published: parsed.data.published ?? true,
        requested_archive: false,
        requested_request_id: randomUUID(),
      });

      if (error) {
        const code = (error as { code?: string }).code;
        if (code === '42501') return jsonResponse(403, { error: 'superadmin_required', message: 'Superadmin privileges required' });
        if (code === '22023') return jsonResponse(400, { error: 'invalid_request', message: error.message?.includes('startDate') ? 'endDate must be greater than or equal to startDate' : 'Invalid calendar closure parameters' });
        throw error;
      }

      const saved = (data || {}) as Record<string, any>;
      const { data: allRows } = await admin
        .from('campus_calendar_closures')
        .select('id, title, closure_type, start_date, end_date, archived_at, active')
        .is('archived_at', null);

      const overlaps = findOverlaps(
        String(saved.id || ''),
        String(saved.startDate || parsed.data.startDate),
        String(saved.endDate || parsed.data.endDate),
        (allRows || []) as Array<any>,
      );

      return jsonResponse(201, {
        ok: true,
        closure: {
          id: saved.id,
          title: saved.title,
          closureType: saved.closureType,
          startDate: saved.startDate,
          endDate: saved.endDate,
          description: saved.description ?? null,
          active: saved.active,
          published: saved.published,
          archivedAt: saved.archivedAt ?? null,
        },
        overlaps,
      });
    }

    if (request.method === 'PATCH') {
      const body = await request.json().catch(() => null);
      const parsed = patchClosureSchema.safeParse(body);
      if (!parsed.success) {
        return jsonResponse(400, { error: 'invalid_request', details: parsed.error.issues });
      }

      const { data, error } = await admin.schema('api').rpc('save_campus_calendar_closure', {
        requested_actor_id: actor.id,
        requested_closure_id: parsed.data.id,
        requested_title: parsed.data.title ?? null,
        requested_closure_type: parsed.data.closureType ?? null,
        requested_start_date: parsed.data.startDate ?? null,
        requested_end_date: parsed.data.endDate ?? null,
        requested_description: parsed.data.description !== undefined ? parsed.data.description : null,
        requested_active: parsed.data.active !== undefined ? parsed.data.active : null,
        requested_published: parsed.data.published !== undefined ? parsed.data.published : null,
        requested_archive: parsed.data.archive ?? false,
        requested_request_id: randomUUID(),
      });

      if (error) {
        const code = (error as { code?: string }).code;
        if (code === 'P0002') {
          return jsonResponse(404, { error: 'closure_not_found', message: 'Campus calendar closure not found' });
        }
        if (code === '42501') {
          return jsonResponse(403, { error: 'superadmin_required', message: 'Superadmin privileges required' });
        }
        if (code === '22023') {
          return jsonResponse(400, { error: 'invalid_request', message: 'endDate must be greater than or equal to startDate' });
        }
        throw error;
      }

      const saved = (data || {}) as Record<string, any>;
      const { data: allRows } = await admin
        .from('campus_calendar_closures')
        .select('id, title, closure_type, start_date, end_date, archived_at, active')
        .is('archived_at', null);

      const overlaps = findOverlaps(
        String(saved.id || parsed.data.id),
        String(saved.startDate || ''),
        String(saved.endDate || ''),
        (allRows || []) as Array<any>,
      );

      return jsonResponse(200, {
        ok: true,
        closure: {
          id: saved.id,
          title: saved.title,
          closureType: saved.closureType,
          startDate: saved.startDate,
          endDate: saved.endDate,
          description: saved.description ?? null,
          active: saved.active,
          published: saved.published,
          archivedAt: saved.archivedAt ?? null,
        },
        overlaps,
      });
    }

    if (request.method === 'DELETE') {
      const body = await request.json().catch(() => null);
      const parsed = deleteClosureSchema.safeParse(body);
      if (!parsed.success) {
        return jsonResponse(400, { error: 'invalid_request', details: parsed.error.issues });
      }

      const { error } = await admin.schema('api').rpc('delete_campus_calendar_closure', {
        requested_actor_id: actor.id,
        requested_closure_id: parsed.data.id,
        requested_request_id: randomUUID(),
      });

      if (error) {
        const code = (error as { code?: string }).code;
        const msg = error.message || '';
        if (code === 'P0002') {
          return jsonResponse(404, { error: 'closure_not_found', message: 'Campus calendar closure not found' });
        }
        if (msg.includes('published_or_active_closure_must_be_archived')) {
          return jsonResponse(409, {
            error: 'published_or_active_closure_must_be_archived',
            message: 'Published or active calendar entries cannot be deleted; archive them instead.',
          });
        }
        if (code === '42501') {
          return jsonResponse(403, { error: 'superadmin_required', message: msg });
        }
        throw error;
      }

      return jsonResponse(200, { ok: true, message: 'Campus calendar closure deleted successfully.' });
    }

    return jsonResponse(405, { error: 'method_not_allowed' }, { Allow: 'GET, POST, PATCH, DELETE' });
  } catch (error) {
    if (error instanceof HttpError) {
      return jsonResponse(error.status, { error: error.code });
    }
    console.error('Campus calendar route failed:', error);
    return jsonResponse(503, { error: 'calendar_unavailable' });
  }
}

export const fetch = handleRequest;
export default { fetch: handleRequest };
