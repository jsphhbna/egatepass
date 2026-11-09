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
              .select('id, name, description, active, verified')
              .in('id', actor.assignedOfficeIds)
              .eq('active', true)
              .order('name');

            if (aErr) throw aErr;
            return jsonResponse(200, { offices: assignedOffices || [] });
          }
        } catch {
          // Fall through to public / unauthenticated path
        }
      }

      // Public visitor view: only active AND verified offices
      const { data: offices, error: offErr } = await admin
        .from('offices')
        .select('id, name, description, active, verified')
        .eq('active', true)
        .eq('verified', true)
        .order('name');

      if (offErr) {
        console.error('Failed to get offices:', offErr);
        return jsonResponse(500, { error: 'failed_to_get_offices' });
      }

      return jsonResponse(200, { offices: offices || [] });
    }

    // Check if caller is authorized office staff/admin
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

    let personnelQuery = admin
      .from('office_personnel')
      .select('id, office_id, name, title, active, created_at, updated_at')
      .eq('office_id', officeId);

    // Unauthenticated public visitors only receive active staff; office staff see all
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

      const { data: inserted, error: insertErr } = await admin
        .from('office_personnel')
        .insert({
          office_id: parsed.data.officeId,
          name: parsed.data.name,
          title: parsed.data.title || null,
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

      const effectivePersonnelId = (parsed.data.personnelId || parsed.data.id)!;
      const { data: existing, error: fetchErr } = await admin
        .from('office_personnel')
        .select('office_id')
        .eq('id', effectivePersonnelId)
        .maybeSingle();

      if (fetchErr || !existing) return jsonResponse(404, { error: 'personnel_not_found' });

      const actor = await requireOfficeStaffActor(admin, token, existing.office_id);

      const updateData: Record<string, unknown> = {
        updated_at: new Date().toISOString(),
        updated_by: actor.id,
      };
      if (parsed.data.name !== undefined) updateData.name = parsed.data.name;
      if (parsed.data.title !== undefined) updateData.title = parsed.data.title || null;
      if (parsed.data.active !== undefined) updateData.active = parsed.data.active;

      const { data: updated, error: updateErr } = await admin
        .from('office_personnel')
        .update(updateData)
        .eq('id', effectivePersonnelId)
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
