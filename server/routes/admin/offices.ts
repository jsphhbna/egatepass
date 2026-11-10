import { randomBytes, randomUUID } from 'node:crypto';
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
  verified: z.boolean().optional(),
});

const provisionAccountSchema = z.object({
  action: z.literal('provision_account'),
  officeId: z.string().uuid(),
  customEmail: z.string().email().max(320).optional(),
  displayName: z.string().trim().min(2).max(100).optional(),
});

const resetCredentialsSchema = z.object({
  action: z.literal('reset_account_credentials'),
  userId: z.string().uuid(),
  officeId: z.string().uuid().optional(),
});

const toggleAccountActiveSchema = z.object({
  action: z.literal('toggle_account_active'),
  userId: z.string().uuid(),
  active: z.boolean(),
});

export function generateTemporaryPassword(): string {
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const lower = 'abcdefghijkmnopqrstuvwxyz';
  const digits = '23456789';
  const symbols = '!@#$%^&*-_+=';

  const pick = (set: string, count: number) => {
    let res = '';
    const bytes = randomBytes(count);
    for (let i = 0; i < count; i++) {
      const b = bytes[i] ?? 0;
      res += set[b % set.length];
    }
    return res;
  };

  const parts = [
    pick(upper, 4),
    pick(lower, 4),
    pick(digits, 4),
    pick(symbols, 4),
  ].join('');

  const arr = parts.split('');
  for (let i = arr.length - 1; i > 0; i--) {
    const b = randomBytes(1)[0] ?? 0;
    const j = b % (i + 1);
    const temp = arr[i] ?? '';
    arr[i] = arr[j] ?? '';
    arr[j] = temp;
  }
  return arr.join('');
}

function slugifyOfficeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '.')
    .replace(/^\.+|\.+$/g, '')
    .slice(0, 30);
}

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
      .select('id, name, description, active, verified, verified_at, verified_by, created_at, updated_at')
      .order('name', { ascending: true });

    if (officeErr) throw officeErr;

    const { data: assignments, error: assignErr } = await admin
      .from('office_staff_assignments')
      .select('office_id, user_id, assigned_at');

    if (assignErr) throw assignErr;

    const allAssignedUserIds = Array.from(new Set((assignments || []).map((a) => a.user_id)));
    let staffMap = new Map<string, { userId: string; displayName: string; role: string; active: boolean; mustChangePassword: boolean; email?: string }>();

    if (allAssignedUserIds.length > 0) {
      const { data: profiles } = await admin
        .from('staff_profiles')
        .select('user_id, display_name, role, active, must_change_password')
        .in('user_id', allAssignedUserIds);

      for (const p of profiles || []) {
        staffMap.set(p.user_id, {
          userId: p.user_id,
          displayName: p.display_name,
          role: p.role,
          active: p.active,
          mustChangePassword: p.must_change_password,
        });
      }

      try {
        const { data: authPage } = await admin.auth.admin.listUsers({ page: 1, perPage: 100 });
        for (const u of authPage?.users || []) {
          const entry = staffMap.get(u.id);
          if (entry) {
            entry.email = u.email ?? '';
          }
        }
      } catch (err) {
        console.warn('Could not fetch auth emails for office staff:', err);
      }
    }

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

    const result = (offices || []).map((o) => {
      const assignedUserIds = assignmentMap.get(o.id) || [];
      const assignedStaff = assignedUserIds
        .map((uid) => staffMap.get(uid))
        .filter((s): s is NonNullable<typeof s> => Boolean(s));

      const dedicated = assignedStaff.find((s) => s.role === 'office_staff') || assignedStaff[0] || null;

      return {
        ...o,
        assignedStaffIds: assignedUserIds,
        staffCount: assignedUserIds.length,
        assignedStaff,
        dedicatedAccount: dedicated,
        personnel: withPersonnel ? personnelMap.get(o.id) || [] : undefined,
      };
    });

    return jsonResponse(200, { offices: result });
  }

  // Mutation operations (POST, PATCH) strictly require superadmin
  if (actor.role !== 'superadmin') {
    return jsonResponse(403, {
      error: 'superadmin_required',
      message: 'Only superadmin can modify offices, staff assignments, or provision office accounts',
    });
  }

  if (request.method === 'POST') {
    const body = await request.json().catch(() => null);

    // ==========================================
    // ACTION: PROVISION DEDICATED OFFICE ACCOUNT
    // ==========================================
    if (body?.action === 'provision_account') {
      const parsed = provisionAccountSchema.safeParse(body);
      if (!parsed.success) return jsonResponse(400, { error: 'invalid_request', details: parsed.error.issues });

      const { officeId, customEmail, displayName } = parsed.data;

      const { data: office, error: offErr } = await admin
        .from('offices')
        .select('id, name, active')
        .eq('id', officeId)
        .maybeSingle();

      if (offErr) throw offErr;
      if (!office) {
        return jsonResponse(404, { error: 'office_not_found', message: 'The specified office does not exist' });
      }

      const slug = slugifyOfficeName(office.name);
      const email = (customEmail || `office.${slug || 'dept'}@earist.edu.ph`).toLowerCase().trim();
      const temporaryPassword = generateTemporaryPassword();
      const staffName = (displayName || `${office.name} Staff`).trim();

      const created = await admin.auth.admin.createUser({
        email,
        password: temporaryPassword,
        email_confirm: true,
      });

      if (created.error || !created.data.user) {
        const err = created.error;
        const msg = typeof err === 'object' && err !== null && 'message' in err ? String(err.message).toLowerCase() : '';
        if (msg.includes('already exists') || msg.includes('already registered')) {
          return jsonResponse(409, {
            error: 'email_already_exists',
            message: `An account with email "${email}" is already registered. Choose a custom email or reset existing credentials.`,
          });
        }
        throw created.error ?? new Error('auth_user_creation_failed');
      }

      const newUserId = created.data.user.id;

      // Create staff profile with role = 'office_staff' (enforces must_change_password = true)
      const profile = await admin.schema('api').rpc('create_staff_profile', {
        requested_actor_id: actor.id,
        requested_user_id: newUserId,
        requested_name: staffName,
        requested_role: 'office_staff',
        requested_request_id: randomUUID(),
      });

      if (profile.error) {
        // Rollback created auth user
        await admin.auth.admin.deleteUser(newUserId).catch(() => undefined);
        throw profile.error;
      }

      // Assign to this office
      const { error: assignErr } = await admin.from('office_staff_assignments').insert({
        user_id: newUserId,
        office_id: officeId,
        assigned_by: actor.id,
      });

      if (assignErr) {
        console.warn('Failed to assign office to provisioned staff user:', assignErr);
      }

      // Staff creation and initial role assignment audited atomically in api.create_staff_profile

      return jsonResponse(200, {
        ok: true,
        officeId,
        userId: newUserId,
        email,
        temporaryPassword,
        mustChangePassword: true,
      });
    }

    // ==========================================
    // ACTION: RESET DEDICATED OFFICE CREDENTIALS
    // ==========================================
    if (body?.action === 'reset_account_credentials') {
      const parsed = resetCredentialsSchema.safeParse(body);
      if (!parsed.success) return jsonResponse(400, { error: 'invalid_request', details: parsed.error.issues });

      const { userId } = parsed.data;

      const { data: staff, error: stErr } = await admin
        .from('staff_profiles')
        .select('user_id, display_name, role')
        .eq('user_id', userId)
        .maybeSingle();

      if (stErr) throw stErr;
      if (!staff) {
        return jsonResponse(404, { error: 'staff_not_found', message: 'Staff profile not found' });
      }

      const temporaryPassword = generateTemporaryPassword();

      const { error: authErr } = await admin.auth.admin.updateUserById(userId, {
        password: temporaryPassword,
      });
      if (authErr) throw authErr;

      // Mark profile for mandatory password change and record audit event via RPC
      const rpcRes = await admin.schema('api').rpc('reset_staff_temporary_password', {
        requested_actor_id: actor.id,
        requested_user_id: userId,
        requested_request_id: randomUUID(),
      });
      if (rpcRes.error) {
        console.warn('reset_staff_temporary_password RPC notice:', rpcRes.error.message);
      }

      return jsonResponse(200, {
        ok: true,
        userId,
        temporaryPassword,
        mustChangePassword: true,
      });
    }

    // ==========================================
    // ACTION: TOGGLE OFFICE ACCOUNT ACTIVE
    // ==========================================
    if (body?.action === 'toggle_account_active') {
      const parsed = toggleAccountActiveSchema.safeParse(body);
      if (!parsed.success) return jsonResponse(400, { error: 'invalid_request', details: parsed.error.issues });

      const { userId, active } = parsed.data;

      // Update active state and record audit event via authoritative RPC
      const updateRes = await admin.schema('api').rpc('update_staff_profile', {
        requested_actor_id: actor.id,
        requested_user_id: userId,
        requested_role: null,
        requested_active: active,
        requested_request_id: randomUUID(),
      });

      if (updateRes.error) throw updateRes.error;

      return jsonResponse(200, { ok: true, userId, active });
    }

    if (body?.action === 'verify_office' || body?.action === 'unverify_office') {
      const officeId = body.officeId;
      if (!officeId || typeof officeId !== 'string') {
        return jsonResponse(400, { error: 'invalid_office_id' });
      }

      const { data: existingOffice, error: chkErr } = await admin
        .from('offices')
        .select('id')
        .eq('id', officeId)
        .maybeSingle();
      if (chkErr) throw chkErr;
      if (!existingOffice) {
        return jsonResponse(404, { error: 'office_not_found', message: 'The specified office does not exist' });
      }

      const isVerify = body.action === 'verify_office';
      const { data: updatedOffice, error: vErr } = await admin
        .from('offices')
        .update({
          verified: isVerify,
          verified_at: isVerify ? new Date().toISOString() : null,
          verified_by: isVerify ? actor.id : null,
          updated_at: new Date().toISOString(),
        })
        .eq('id', officeId)
        .select()
        .single();
      if (vErr) throw vErr;
      return jsonResponse(200, { ok: true, office: updatedOffice });
    }

    if (body?.action === 'assign_staff') {
      const parsed = assignStaffSchema.safeParse(body);
      if (!parsed.success) return jsonResponse(400, { error: 'invalid_request', details: parsed.error.issues });

      const { data: office, error: offErr } = await admin
        .from('offices')
        .select('id')
        .eq('id', parsed.data.officeId)
        .maybeSingle();
      if (offErr) throw offErr;
      if (!office) {
        return jsonResponse(404, { error: 'office_not_found', message: 'The specified office does not exist' });
      }

      const { data: staff, error: stErr } = await admin
        .from('staff_profiles')
        .select('user_id, role, active')
        .eq('user_id', parsed.data.userId)
        .maybeSingle();
      if (stErr) throw stErr;
      if (!staff) {
        return jsonResponse(404, { error: 'staff_not_found', message: 'The specified staff account does not exist' });
      }

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

    const { data: existingOffice, error: chkErr } = await admin
      .from('offices')
      .select('id')
      .eq('id', parsed.data.id)
      .maybeSingle();
    if (chkErr) throw chkErr;
    if (!existingOffice) {
      return jsonResponse(404, { error: 'office_not_found', message: 'The specified office does not exist' });
    }

    const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (parsed.data.name !== undefined) updates.name = parsed.data.name;
    if (parsed.data.description !== undefined) updates.description = parsed.data.description;
    if (parsed.data.active !== undefined) updates.active = parsed.data.active;
    if (parsed.data.verified !== undefined) {
      updates.verified = parsed.data.verified;
      updates.verified_at = parsed.data.verified ? new Date().toISOString() : null;
      updates.verified_by = parsed.data.verified ? actor.id : null;
    }

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
