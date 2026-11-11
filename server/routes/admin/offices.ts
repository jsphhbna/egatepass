import { randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { HttpError, recordReconciliation, requireStaffActor } from '../../actors.js';
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
  staffEmail: z.string().trim().email().max(320),
  displayName: z.string().trim().min(2).max(100).optional(),
});

const resetCredentialsSchema = z.object({
  action: z.literal('reset_account_credentials'),
  userId: z.string().uuid(),
  officeId: z.string().uuid().optional(),
});

const resendVerificationSchema = z.object({
  action: z.literal('resend_verification_email'),
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

export async function handleRequest(request: Request): Promise<Response> {
  try {
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
    let staffMap = new Map<string, { userId: string; displayName: string; role: string; active: boolean; mustChangePassword: boolean; email?: string; emailConfirmed?: boolean }>();

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
            entry.emailConfirmed = Boolean(u.email_confirmed_at);
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

  // General mutations (create office, provision, reset credentials, assign) permitted for admin and superadmin.

  if (request.method === 'POST') {
    const body = await request.json().catch(() => null);

    // ==========================================
    // ACTION: PROVISION DEDICATED OFFICE ACCOUNT
    // ==========================================
    if (body?.action === 'provision_account') {
      const parsed = provisionAccountSchema.safeParse(body);
      if (!parsed.success) return jsonResponse(400, { error: 'invalid_request', details: parsed.error.issues });

      const { officeId, staffEmail, displayName } = parsed.data;

      const { data: office, error: offErr } = await admin
        .from('offices')
        .select('id, name, active')
        .eq('id', officeId)
        .maybeSingle();

      if (offErr) throw offErr;
      if (!office) {
        return jsonResponse(404, { error: 'office_not_found', message: 'The specified office does not exist' });
      }

      if (!office.active) {
        return jsonResponse(400, { error: 'office_inactive', message: 'Cannot provision accounts for inactive offices' });
      }

      const email = staffEmail.toLowerCase().trim();
      const temporaryPassword = generateTemporaryPassword();
      const staffName = (displayName || `${office.name} Staff`).trim();

      const created = await admin.auth.admin.createUser({
        email,
        password: temporaryPassword,
        email_confirm: false,
      });

      if (created.error || !created.data.user) {
        const err = created.error;
        const msg = typeof err === 'object' && err !== null && 'message' in err ? String(err.message).toLowerCase() : '';
        if (msg.includes('already exists') || msg.includes('already registered')) {
          return jsonResponse(409, {
            error: 'email_already_exists',
            message: `An account with email "${email}" is already registered. Please use their assigned account or specify another valid email.`,
          });
        }
        throw created.error ?? new Error('auth_user_creation_failed');
      }

      const newUserId = created.data.user.id;

      // Atomic DB provisioning via RPC: staff_profiles (role=office_staff, must_change_password=true) + office_staff_assignments + audit_events
      const rpcRes = await admin.schema('api').rpc('provision_office_staff_account', {
        requested_actor_id: actor.id,
        requested_user_id: newUserId,
        requested_office_id: officeId,
        requested_name: staffName,
        requested_request_id: randomUUID(),
      });

      if (rpcRes.error) {
        // Rollback created auth user
        console.error('Database provisioning failed, rolling back Auth user:', rpcRes.error);
        const delRes = await admin.auth.admin.deleteUser(newUserId).catch((e) => ({ error: e }));
        if (delRes?.error) {
          console.error('CRITICAL: Auth rollback failed during office provisioning compensation:', delRes.error);
          await recordReconciliation(
            admin,
            'office.provision_compensation_failed',
            'auth.users',
            newUserId,
            `Rollback failed after DB error: ${rpcRes.error.message}`,
            { officeId, email }
          ).catch(() => undefined);
        }
        return jsonResponse(500, {
          error: 'provisioning_failed',
          message: 'Failed to provision office staff profile in database. Auth account rolled back.',
          details: rpcRes.error.message,
        });
      }

      // Dispatch real email verification via Supabase Auth / Resend
      const resendResult = await admin.auth.resend({
        type: 'signup',
        email,
      }).catch((err) => ({ error: err }));

      if (resendResult?.error) {
        console.warn('Office staff verification email delivery failed:', resendResult.error);
        await recordReconciliation(
          admin,
          'office.verification_email_failed',
          'staff_profiles',
          newUserId,
          (resendResult.error as any)?.message || 'resend_failed',
          { email, officeId }
        ).catch(() => undefined);
      }

      return jsonResponse(200, {
        ok: true,
        officeId,
        userId: newUserId,
        email,
        temporaryPassword,
        mustChangePassword: true,
        emailConfirmed: false,
        verificationEmailSent: !resendResult?.error,
      });
    }

    // ==========================================
    // ACTION: RESET DEDICATED OFFICE CREDENTIALS
    // ==========================================
    if (body?.action === 'reset_account_credentials') {
      const parsed = resetCredentialsSchema.safeParse(body);
      if (!parsed.success) return jsonResponse(400, { error: 'invalid_request', details: parsed.error.issues });

      const { userId, officeId } = parsed.data;

      const { data: staff, error: stErr } = await admin
        .from('staff_profiles')
        .select('user_id, display_name, role, active')
        .eq('user_id', userId)
        .maybeSingle();

      if (stErr) throw stErr;
      if (!staff) {
        return jsonResponse(404, { error: 'staff_not_found', message: 'Staff profile not found' });
      }

      // If officeId is specified, verify that the staff is assigned to that office
      if (officeId) {
        const { data: assignment, error: assignErr } = await admin
          .from('office_staff_assignments')
          .select('id')
          .eq('user_id', userId)
          .eq('office_id', officeId)
          .maybeSingle();

        if (assignErr) throw assignErr;
        if (!assignment) {
          return jsonResponse(403, {
            error: 'staff_not_assigned_to_office',
            message: 'This staff account is not assigned to the requested office',
          });
        }
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
        requested_office_id: officeId || null,
      });

      if (rpcRes.error) {
        console.error('CRITICAL: reset_staff_temporary_password failed after Auth password update:', rpcRes.error);
        
        // Active fail-closed compensation: actively revoke the temporary password by setting it to an unguessable 256-bit random secret
        const revokeSecret = randomBytes(32).toString('hex');
        const revokeRes = await admin.auth.admin.updateUserById(userId, {
          password: revokeSecret,
        }).catch((e) => ({ error: e }));

        if (revokeRes?.error) {
          console.error('CRITICAL: Failed to overwrite Auth password during reset failure compensation. Locking account:', revokeRes.error);
          await admin.auth.admin.updateUserById(userId, { ban_duration: '876000h' }).catch(() => undefined);
          await recordReconciliation(
            admin,
            'office.reset_compensation_failed',
            'auth.users',
            userId,
            `Revocation failed after DB error: ${rpcRes.error.message}`,
            { officeId }
          ).catch(() => undefined);
        }

        await recordReconciliation(
          admin,
          'office.reset_enforcement_failed',
          'staff_profiles',
          userId,
          `Password updated but forced-change flag failed: ${rpcRes.error.message}`,
          { officeId }
        ).catch(() => undefined);

        return jsonResponse(500, {
          error: 'reset_enforcement_failed',
          message: 'Failed to enforce mandatory password change on staff profile. Temporary credentials have been invalidated and revoked.',
        });
      }

      return jsonResponse(200, {
        ok: true,
        userId,
        temporaryPassword,
        mustChangePassword: true,
      });
    }

    // ==========================================
    // ACTION: RESEND OFFICE ACCOUNT VERIFICATION
    // ==========================================
    if (body?.action === 'resend_verification_email') {
      const parsed = resendVerificationSchema.safeParse(body);
      if (!parsed.success) return jsonResponse(400, { error: 'invalid_request', details: parsed.error.issues });

      const { userId, officeId } = parsed.data;

      const { data: staff, error: stErr } = await admin
        .from('staff_profiles')
        .select('user_id, display_name, role, active')
        .eq('user_id', userId)
        .maybeSingle();

      if (stErr) throw stErr;
      if (!staff) {
        return jsonResponse(404, { error: 'staff_not_found', message: 'Staff profile not found' });
      }

      if (officeId) {
        const { data: assignment, error: assignErr } = await admin
          .from('office_staff_assignments')
          .select('id')
          .eq('user_id', userId)
          .eq('office_id', officeId)
          .maybeSingle();

        if (assignErr) throw assignErr;
        if (!assignment) {
          return jsonResponse(403, {
            error: 'staff_not_assigned_to_office',
            message: 'This staff account is not assigned to the requested office',
          });
        }
      }

      const { data: authUser, error: authUserErr } = await admin.auth.admin.getUserById(userId);
      if (authUserErr || !authUser?.user) {
        return jsonResponse(404, { error: 'auth_user_not_found' });
      }

      if (authUser.user.email_confirmed_at) {
        return jsonResponse(400, {
          error: 'email_already_verified',
          message: 'This staff account email address has already been verified.',
        });
      }

      const resendRes = await admin.auth.resend({
        type: 'signup',
        email: authUser.user.email!,
      }).catch((e) => ({ error: e }));

      if (resendRes?.error) {
        return jsonResponse(500, {
          error: 'resend_failed',
          message: (resendRes.error as any)?.message || 'Failed to dispatch verification email',
        });
      }

      return jsonResponse(200, {
        ok: true,
        userId,
        email: authUser.user.email,
        verificationEmailSent: true,
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
      if (actor.role !== 'superadmin') {
        return jsonResponse(403, {
          error: 'superadmin_required',
          message: 'Only superadmin can verify or unverify campus offices',
        });
      }
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
        created_by: actor.id,
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

    const normalizedName = parsed.data.name;
    const normalizedDescription = parsed.data.description && parsed.data.description.length > 0
      ? parsed.data.description
      : null;
    const requestedActive = parsed.data.active ?? true;

    const { data: newOffice, error: createErr } = await admin
      .from('offices')
      .insert({
        name: normalizedName,
        description: normalizedDescription,
        active: requestedActive,
        verified: false,
        created_by: actor.id,
        updated_by: actor.id,
      })
      .select('id, name, description, active, verified, verified_at, verified_by, created_at, updated_at')
      .single();

    if (createErr) {
      const errCode = (createErr as { code?: string }).code;
      const errMessage = String((createErr as { message?: string }).message || '').toLowerCase();
      if (errCode === '23505' || errMessage.includes('offices_name_key') || errMessage.includes('duplicate key')) {
        const { data: existingOffice, error: lookupErr } = await admin
          .from('offices')
          .select('id, name, description, active, verified, verified_at, verified_by, created_at, updated_at')
          .eq('name', normalizedName)
          .maybeSingle();

        if (lookupErr) throw lookupErr;

        if (existingOffice) {
          const sameDescription = (existingOffice.description ?? null) === normalizedDescription;
          const sameActive = existingOffice.active === requestedActive;
          if (sameDescription && sameActive) {
            return jsonResponse(200, {
              ok: true,
              idempotent: true,
              alreadyExists: true,
              office: existingOffice,
              message: `Office "${existingOffice.name}" already exists in the directory.`,
            });
          }

          return jsonResponse(409, {
            error: 'office_already_exists',
            message: `An office named "${existingOffice.name}" already exists.`,
            office: existingOffice,
          });
        }

        return jsonResponse(409, {
          error: 'office_already_exists',
          message: `An office named "${normalizedName}" already exists.`,
        });
      }

      throw createErr;
    }

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

    const updates: Record<string, unknown> = { updated_at: new Date().toISOString(), updated_by: actor.id };
    if (parsed.data.name !== undefined) updates.name = parsed.data.name;
    if (parsed.data.description !== undefined) updates.description = parsed.data.description;
    if (parsed.data.active !== undefined) updates.active = parsed.data.active;
    if (parsed.data.verified !== undefined) {
      if (actor.role !== 'superadmin') {
        return jsonResponse(403, {
          error: 'superadmin_required',
          message: 'Only superadmin can modify office verification status',
        });
      }
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

    if (updateErr) {
      const errCode = (updateErr as { code?: string }).code;
      const errMessage = String((updateErr as { message?: string }).message || '').toLowerCase();
      if (errCode === '23505' || errMessage.includes('offices_name_key') || errMessage.includes('duplicate key')) {
        return jsonResponse(409, {
          error: 'office_already_exists',
          message: `An office named "${parsed.data.name ?? 'requested'}" already exists.`,
        });
      }
      throw updateErr;
    }
    return jsonResponse(200, { ok: true, office: updatedOffice });
  }

  return jsonResponse(405, { error: 'method_not_allowed' }, { Allow: 'GET, POST, PATCH' });
  } catch (error) {
    if (error instanceof HttpError) {
      return jsonResponse(error.status, { error: error.code });
    }
    console.error('Unhandled offices error:', error);
    return jsonResponse(500, { error: 'internal_error' });
  }
}

export const fetch = handleRequest;
export default { fetch: handleRequest };
