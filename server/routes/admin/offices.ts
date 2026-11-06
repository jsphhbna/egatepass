import { z } from 'zod';
import { requireStaffActor } from '../../actors.js';
import { jsonResponse, readBearerToken } from '../../http.js';
import { getServerSupabaseClients } from '../../supabase.js';

const createOfficeSchema = z.object({
  action: z.literal('create_office').optional(),
  name: z.string().trim().min(2).max(100),
  description: z.string().trim().max(300).optional(),
  active: z.boolean().optional().default(true),
});

const assignStaffSchema = z.object({
  action: z.literal('assign_staff'),
  userId: z.string().uuid(),
  officeId: z.string().uuid(),
});

const removeStaffSchema = z.object({
  action: z.literal('remove_staff'),
  userId: z.string().uuid(),
  officeId: z.string().uuid(),
});

const patchOfficeSchema = z.object({
  id: z.string().uuid(),
  name: z.string().trim().min(2).max(100).optional(),
  description: z.string().trim().max(300).optional(),
  active: z.boolean().optional(),
});

export async function handleRequest(request: Request): Promise<Response> {
  const token = readBearerToken(request);
  if (!token) return jsonResponse(401, { error: 'authentication_required' });

  const { admin } = getServerSupabaseClients();
  const actor = await requireStaffActor(admin, token, ['admin', 'superadmin']);

  if (request.method === 'GET') {
    const url = new URL(request.url);
    const withPersonnel = url.searchParams.get('withPersonnel') === 'true';

    const { data: offices, error: officeErr } = await admin
      .from('offices')
      .select('id, name, description, active, created_at, updated_at')
      .order('name', { ascending: true });

    if (officeErr) throw officeErr;

    const { data: assignments, error: assignErr } = await admin
      .from('office_staff_assignments')
      .select('office_id, user_id, assigned_at');

    if (assignErr) throw assignErr;

    const assignmentMap = new Map<string, string[]>();
    for (const a of assignments || []) {
      const list = assignmentMap.get(a.office_id) || [];
      list.push(a.user_id);
      assignmentMap.set(a.office_id, list);
    }

    let personnelMap = new Map<string, Array<{ id: string; name: string; title: string | null; active: boolean }>>();
    if (withPersonnel) {
      const { data: personnel, error: persErr } = await admin
        .from('office_personnel')
        .select('id, office_id, name, title, active')
        .order('name', { ascending: true });

      if (persErr) throw persErr;
      for (const p of personnel || []) {
        const list = personnelMap.get(p.office_id) || [];
        list.push({ id: p.id, name: p.name, title: p.title, active: p.active });
        personnelMap.set(p.office_id, list);
      }
    }

    const result = (offices || []).map((o) => ({
      ...o,
      assignedStaffIds: assignmentMap.get(o.id) || [],
      staffCount: (assignmentMap.get(o.id) || []).length,
      personnel: withPersonnel ? personnelMap.get(o.id) || [] : undefined,
    }));

    return jsonResponse(200, { offices: result });
  }

  if (request.method === 'POST') {
    const body = await request.json().catch(() => null);

    if (body?.action === 'assign_staff') {
      const parsed = assignStaffSchema.safeParse(body);
      if (!parsed.success) return jsonResponse(400, { error: 'invalid_request', details: parsed.error.issues });

      const { error: insErr } = await admin.from('office_staff_assignments').upsert({
        user_id: parsed.data.userId,
        office_id: parsed.data.officeId,
        assigned_by: actor.id,
      }, { onConflict: 'office_id,user_id' });

      if (insErr) throw insErr;
      return jsonResponse(200, { ok: true, message: 'Staff assigned to office successfully.' });
    }

    if (body?.action === 'remove_staff') {
      const parsed = removeStaffSchema.safeParse(body);
      if (!parsed.success) return jsonResponse(400, { error: 'invalid_request', details: parsed.error.issues });

      const { error: delErr } = await admin
        .from('office_staff_assignments')
        .delete()
        .eq('user_id', parsed.data.userId)
        .eq('office_id', parsed.data.officeId);

      if (delErr) throw delErr;
      return jsonResponse(200, { ok: true, message: 'Staff removed from office successfully.' });
    }

    const parsed = createOfficeSchema.safeParse(body);
    if (!parsed.success) return jsonResponse(400, { error: 'invalid_request', details: parsed.error.issues });

    const { data: newOffice, error: createErr } = await admin
      .from('offices')
      .insert({
        name: parsed.data.name,
        description: parsed.data.description || null,
        active: parsed.data.active ?? true,
      })
      .select()
      .single();

    if (createErr) throw createErr;
    return jsonResponse(201, { ok: true, office: newOffice });
  }

  if (request.method === 'PATCH') {
    const body = await request.json().catch(() => null);
    const parsed = patchOfficeSchema.safeParse(body);
    if (!parsed.success) return jsonResponse(400, { error: 'invalid_request', details: parsed.error.issues });

    const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (parsed.data.name !== undefined) updates.name = parsed.data.name;
    if (parsed.data.description !== undefined) updates.description = parsed.data.description;
    if (parsed.data.active !== undefined) updates.active = parsed.data.active;

    const { data: updatedOffice, error: updateErr } = await admin
      .from('offices')
      .update(updates)
      .eq('id', parsed.data.id)
      .select()
      .single();

    if (updateErr) throw updateErr;
    return jsonResponse(200, { ok: true, office: updatedOffice });
  }

  return jsonResponse(405, { error: 'method_not_allowed' }, { Allow: 'GET, POST, PATCH' });
}

export const fetch = handleRequest;
export default { fetch: handleRequest };
