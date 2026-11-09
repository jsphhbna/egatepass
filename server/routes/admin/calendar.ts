import { z } from 'zod';
import { requireStaffActor } from '../../actors.js';
import { jsonResponse, readBearerToken } from '../../http.js';
import { getServerSupabaseClients } from '../../supabase.js';

const closureTypeSchema = z.enum(['holiday', 'campus_closure']);

const createClosureSchema = z.object({
  title: z.string().trim().min(2).max(150),
  closureType: closureTypeSchema,
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  description: z.string().trim().max(500).optional().nullable(),
  active: z.boolean().optional().default(true),
  published: z.boolean().optional().default(true),
}).refine((data) => data.endDate >= data.startDate, {
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
});

const deleteClosureSchema = z.object({
  id: z.string().uuid(),
});

export async function handleRequest(request: Request): Promise<Response> {
  const token = readBearerToken(request);
  if (!token) return jsonResponse(401, { error: 'authentication_required' });

  const { admin } = getServerSupabaseClients();
  const actor = await requireStaffActor(admin, token, ['admin', 'superadmin']);

  if (request.method === 'GET') {
    const url = new URL(request.url);
    const activeOnly = url.searchParams.get('activeOnly') === 'true';

    let query = admin
      .from('campus_calendar_closures')
      .select('id, title, closure_type, start_date, end_date, description, active, published, created_by, updated_by, created_at, updated_at')
      .order('start_date', { ascending: true });

    if (activeOnly) {
      query = query.eq('active', true);
    }

    const { data, error } = await query;
    if (error) throw error;

    const closures = (data || []).map((row) => ({
      id: row.id,
      title: row.title,
      closureType: row.closure_type,
      startDate: row.start_date,
      endDate: row.end_date,
      description: row.description,
      active: row.active,
      published: row.published,
      createdBy: row.created_by,
      updatedBy: row.updated_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));

    return jsonResponse(200, { closures });
  }

  // Mutation operations (POST, PATCH, DELETE) require superadmin
  if (actor.role !== 'superadmin') {
    return jsonResponse(403, { error: 'superadmin_required', message: 'Only superadmin can modify campus calendar closures' });
  }

  if (request.method === 'POST') {
    const body = await request.json().catch(() => null);
    const parsed = createClosureSchema.safeParse(body);
    if (!parsed.success) {
      return jsonResponse(400, { error: 'invalid_request', details: parsed.error.issues });
    }

    const { data: newClosure, error: insErr } = await admin
      .from('campus_calendar_closures')
      .insert({
        title: parsed.data.title,
        closure_type: parsed.data.closureType,
        start_date: parsed.data.startDate,
        end_date: parsed.data.endDate,
        description: parsed.data.description || null,
        active: parsed.data.active ?? true,
        published: parsed.data.published ?? true,
        created_by: actor.id,
        updated_by: actor.id,
      })
      .select()
      .single();

    if (insErr) throw insErr;

    return jsonResponse(201, {
      ok: true,
      closure: {
        id: newClosure.id,
        title: newClosure.title,
        closureType: newClosure.closure_type,
        startDate: newClosure.start_date,
        endDate: newClosure.end_date,
        description: newClosure.description,
        active: newClosure.active,
        published: newClosure.published,
      },
    });
  }

  if (request.method === 'PATCH') {
    const body = await request.json().catch(() => null);
    const parsed = patchClosureSchema.safeParse(body);
    if (!parsed.success) {
      return jsonResponse(400, { error: 'invalid_request', details: parsed.error.issues });
    }

    const updates: Record<string, unknown> = {
      updated_by: actor.id,
      updated_at: new Date().toISOString(),
    };
    if (parsed.data.title !== undefined) updates.title = parsed.data.title;
    if (parsed.data.closureType !== undefined) updates.closure_type = parsed.data.closureType;
    if (parsed.data.startDate !== undefined) updates.start_date = parsed.data.startDate;
    if (parsed.data.endDate !== undefined) updates.end_date = parsed.data.endDate;
    if (parsed.data.description !== undefined) updates.description = parsed.data.description;
    if (parsed.data.active !== undefined) updates.active = parsed.data.active;
    if (parsed.data.published !== undefined) updates.published = parsed.data.published;

    const { data: updatedClosure, error: updErr } = await admin
      .from('campus_calendar_closures')
      .update(updates)
      .eq('id', parsed.data.id)
      .select()
      .single();

    if (updErr) throw updErr;

    return jsonResponse(200, {
      ok: true,
      closure: {
        id: updatedClosure.id,
        title: updatedClosure.title,
        closureType: updatedClosure.closure_type,
        startDate: updatedClosure.start_date,
        endDate: updatedClosure.end_date,
        description: updatedClosure.description,
        active: updatedClosure.active,
        published: updatedClosure.published,
      },
    });
  }

  if (request.method === 'DELETE') {
    const body = await request.json().catch(() => null);
    const parsed = deleteClosureSchema.safeParse(body);
    if (!parsed.success) {
      return jsonResponse(400, { error: 'invalid_request', details: parsed.error.issues });
    }

    const { error: delErr } = await admin
      .from('campus_calendar_closures')
      .delete()
      .eq('id', parsed.data.id);

    if (delErr) throw delErr;

    return jsonResponse(200, { ok: true, message: 'Campus calendar closure deleted successfully.' });
  }

  return jsonResponse(405, { error: 'method_not_allowed' }, { Allow: 'GET, POST, PATCH, DELETE' });
}

export const fetch = handleRequest;
export default { fetch: handleRequest };
