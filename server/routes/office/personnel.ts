import { z } from 'zod';
import { requireOfficeStaffActor } from '../../lib/office.js';
import { jsonResponse, readBearerToken } from '../../http.js';
import { getServerSupabaseClients } from '../../supabase.js';
import { HttpError } from '../../actors.js';

const postSchema = z.object({
  officeId: z.string().uuid(),
  name: z.string().trim().min(2).max(150),
  title: z.string().trim().min(2).max(120),
}).strict();

const patchSchema = z.object({
  personnelId: z.string().uuid(),
  name: z.string().trim().min(2).max(150).optional(),
  title: z.string().trim().min(2).max(120).optional(),
  active: z.boolean().optional(),
}).strict();

export async function handleRequest(request: Request): Promise<Response> {
  const method = request.method;
  const { admin } = getServerSupabaseClients();

  if (method === 'GET') {
    const url = new URL(request.url);
    const officeId = url.searchParams.get('officeId');
    if (!officeId) {
      const { data: offices, error: offErr } = await admin
        .from('offices')
        .select('id, name, description, active')
        .eq('active', true)
        .order('name');

      if (offErr) {
        console.error('Failed to get offices:', offErr);
        return jsonResponse(500, { error: 'failed_to_get_offices' });
      }

      return jsonResponse(200, { offices: offices || [] });
    }

    const { data: personnel, error } = await admin
      .from('office_personnel')
      .select('id, office_id, name, title, active, created_at, updated_at')
      .eq('office_id', officeId)
      .eq('active', true)
      .order('name');

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

      const { data: inserted, error: insertErr } = await admin
        .from('office_personnel')
        .insert({
          office_id: parsed.data.officeId,
          name: parsed.data.name,
          title: parsed.data.title,
          active: true,
          created_by: actor.id,
        })
        .select()
        .single();

      if (insertErr) throw insertErr;
      return jsonResponse(201, { personnel: inserted });
    }

    if (method === 'PATCH') {
      const parsed = patchSchema.safeParse(await request.json().catch(() => null));
      if (!parsed.success) {
        return jsonResponse(400, { error: 'invalid_request', details: parsed.error.issues });
      }

      const { data: existing, error: fetchErr } = await admin
        .from('office_personnel')
        .select('office_id')
        .eq('id', parsed.data.personnelId)
        .maybeSingle();

      if (fetchErr || !existing) return jsonResponse(404, { error: 'personnel_not_found' });

      const actor = await requireOfficeStaffActor(admin, token, existing.office_id);

      const updateData: Record<string, unknown> = {
        updated_at: new Date().toISOString(),
        updated_by: actor.id,
      };
      if (parsed.data.name !== undefined) updateData.name = parsed.data.name;
      if (parsed.data.title !== undefined) updateData.title = parsed.data.title;
      if (parsed.data.active !== undefined) updateData.active = parsed.data.active;

      const { data: updated, error: updateErr } = await admin
        .from('office_personnel')
        .update(updateData)
        .eq('id', parsed.data.personnelId)
        .select()
        .single();

      if (updateErr) throw updateErr;
      return jsonResponse(200, { personnel: updated });
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
