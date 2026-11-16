import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import { HttpError, invalidateStaffMfaCache, requireStaffActor } from '../../actors.js';
import { jsonResponse, readBearerToken } from '../../http.js';
import { getServerSupabaseClients } from '../../supabase.js';

const ELIGIBLE_STAFF_ROLES = ['admin', 'superadmin', 'office_staff'] as const;

const resetMfaSchema = z
  .object({
    action: z.enum(['reset_factor', 'delete_factor']),
    userId: z.string().uuid(),
    factorId: z.string().uuid(),
    password: z.string().min(1, 'Superadmin password is required'),
    reason: z.string().trim().min(5, 'Reason must be at least 5 characters').max(500),
    confirmed: z.boolean().optional(),
    confirm: z.boolean().optional(),
  })
  .strict();

export interface AdminResetMfaParams {
  userId: string;
  factorId: string;
  reason?: string;
  confirmed?: boolean;
  confirm?: boolean;
}

/**
 * Superadmin recovery helper to delete/reset an enrolled MFA factor for a staff member.
 * Strictly audited and confined to superadmin authority.
 */
export async function adminResetMfaFactor(
  admin: SupabaseClient,
  token: string,
  params: AdminResetMfaParams,
): Promise<{ success: boolean; factorId: string }> {
  const actor = await requireStaffActor(admin, token, ['superadmin']);

  if (params.confirmed !== undefined && !params.confirmed && !params.confirm) {
    throw new HttpError(400, 'confirmation_required');
  }

  const cleanReason = (params.reason ?? '').trim();
  if (cleanReason.length < 5 || cleanReason.length > 500) {
    throw new HttpError(400, 'invalid_reason');
  }

  // Verify target user is eligible human staff
  const { data: targetProfile, error: targetErr } = await admin
    .from('staff_profiles')
    .select('user_id, role, active')
    .eq('user_id', params.userId)
    .maybeSingle();

  if (targetErr || !targetProfile) {
    throw new HttpError(404, 'target_user_not_found');
  }

  if (!targetProfile.active || !ELIGIBLE_STAFF_ROLES.includes(targetProfile.role as any)) {
    throw new HttpError(400, 'ineligible_target_role');
  }

  // Verify factor exists, belongs to target, and is TOTP
  const { data: factorList, error: listError } = await admin.auth.admin.mfa.listFactors({
    userId: params.userId,
  });

  if (listError || !factorList) {
    throw new HttpError(400, 'factor_lookup_failed');
  }

  const targetFactor = Array.isArray(factorList.factors)
    ? factorList.factors.find((f: any) => f.id === params.factorId)
    : null;

  if (!targetFactor || targetFactor.factor_type !== 'totp') {
    throw new HttpError(400, 'mismatched_factor_id');
  }

  // Call official Supabase Admin Auth MFA API
  const { data, error } = await admin.auth.admin.mfa.deleteFactor({
    userId: params.userId,
    id: params.factorId,
  });

  if (error) {
    throw new HttpError(400, 'mfa_factor_deletion_failed');
  }

  // Invalidate active sessions in staff_sessions
  const { error: sessionError } = await admin
    .from('staff_sessions')
    .update({
      expired_at: new Date().toISOString(),
      expired_reason: 'mfa_factor_reset',
      updated_at: new Date().toISOString(),
    })
    .eq('user_id', params.userId)
    .is('expired_at', null);

  if (sessionError) {
    console.error('Failed to invalidate staff_sessions:', sessionError);
  }

  // Invalidate in-memory factor cache
  invalidateStaffMfaCache(params.userId);

  // Record immutable audit event
  const { error: auditError } = await admin.from('audit_events').insert({
    actor_id: actor.id,
    actor_kind: 'staff',
    actor_role: actor.role,
    action: 'staff.mfa_factor_reset',
    target_type: 'staff_mfa_factor',
    target_id: params.userId,
    before_state: { factorId: params.factorId, userId: params.userId },
    after_state: { factorReset: true, factorId: params.factorId, reason: cleanReason },
    outcome: 'success',
  });

  if (auditError) {
    console.error('Failed to log MFA reset audit event:', auditError);
  }

  return { success: true, factorId: (data as any)?.id ?? params.factorId };
}

export async function handleRequest(request: Request): Promise<Response> {
  const token = readBearerToken(request);
  if (!token) {
    return jsonResponse(401, { error: 'authentication_required' });
  }

  const { admin, passwordVerifier } = getServerSupabaseClients();

  // GET: List factors for user (Superadmin only)
  if (request.method === 'GET') {
    try {
      await requireStaffActor(admin, token, ['superadmin']);
      const url = new URL(request.url);
      const userId = url.searchParams.get('userId');
      if (!userId) {
        return jsonResponse(400, { error: 'missing_user_id' });
      }

      const parsedUserId = z.string().uuid().safeParse(userId);
      if (!parsedUserId.success) {
        return jsonResponse(404, { error: 'target_user_not_found' });
      }

      // Verify target user is staff
      const { data: staff, error: staffErr } = await admin
        .from('staff_profiles')
        .select('user_id, role, active')
        .eq('user_id', parsedUserId.data)
        .maybeSingle();

      if (staffErr || !staff) {
        return jsonResponse(404, { error: 'target_user_not_found' });
      }

      if (!staff.active || !ELIGIBLE_STAFF_ROLES.includes(staff.role as any)) {
        return jsonResponse(400, { error: 'ineligible_target_role' });
      }

      const { data, error } = await admin.auth.admin.mfa.listFactors({ userId: parsedUserId.data });
      if (error) {
        console.error('MFA factor listing failed:', error);
        return jsonResponse(400, { error: 'factor_lookup_failed' });
      }
      const sanitizedFactors = (data?.factors ?? []).map((f: any) => ({
        id: f.id,
        friendly_name: f.friendly_name ?? null,
        factor_type: f.factor_type,
        status: f.status,
        created_at: f.created_at,
        updated_at: f.updated_at,
      }));
      return jsonResponse(200, { factors: sanitizedFactors });
    } catch (err) {
      if (err instanceof HttpError) {
        return jsonResponse(err.status, { error: err.code });
      }
      return jsonResponse(500, { error: 'internal_server_error' });
    }
  }

  // POST: Reset/Delete enrolled factor (Superadmin only)
  if (request.method === 'POST') {
    try {
      const actor = await requireStaffActor(admin, token, ['superadmin']);

      const rawBody = await request.json().catch(() => null);
      const parsed = resetMfaSchema.safeParse(rawBody);
      if (!parsed.success) {
        return jsonResponse(400, { error: 'invalid_request', details: parsed.error.issues });
      }

      if (parsed.data.confirm !== true && parsed.data.confirmed !== true) {
        return jsonResponse(400, { error: 'confirmation_required' });
      }

      // 1. Fresh password re-authentication of superadmin
      const { data: verified, error: verificationError } = await passwordVerifier.auth.signInWithPassword({
        email: actor.email,
        password: parsed.data.password,
      });

      try {
        if (verificationError || !verified.user || verified.user.id !== actor.id) {
          return jsonResponse(401, { error: 'invalid_superadmin_password' });
        }

        // 2. Validate target user is human staff
        const { data: targetProfile, error: targetErr } = await admin
          .from('staff_profiles')
          .select('user_id, role, active')
          .eq('user_id', parsed.data.userId)
          .maybeSingle();

        if (targetErr || !targetProfile) {
          return jsonResponse(404, { error: 'target_user_not_found' });
        }

        if (!targetProfile.active || !ELIGIBLE_STAFF_ROLES.includes(targetProfile.role as any)) {
          return jsonResponse(400, { error: 'ineligible_target_role' });
        }

        // 3. Verify factor exists, belongs to target, and is TOTP
        const { data: factorList, error: listError } = await admin.auth.admin.mfa.listFactors({
          userId: parsed.data.userId,
        });

        if (listError || !factorList) {
          return jsonResponse(400, { error: 'factor_lookup_failed' });
        }

        const targetFactor = Array.isArray(factorList.factors)
          ? factorList.factors.find((f: any) => f.id === parsed.data.factorId)
          : null;

        if (!targetFactor || targetFactor.factor_type !== 'totp') {
          return jsonResponse(400, { error: 'mismatched_factor_id' });
        }

        // 4. Delete the factor via Supabase Admin Auth API
        const { error: deleteError } = await admin.auth.admin.mfa.deleteFactor({
          userId: parsed.data.userId,
          id: parsed.data.factorId,
        });

        if (deleteError) {
          console.error('Supabase deleteFactor error:', deleteError);
          return jsonResponse(400, { error: 'mfa_factor_deletion_failed' });
        }

        // 5. Invalidate target user's active sessions in staff_sessions
        const { error: sessionError } = await admin
          .from('staff_sessions')
          .update({
            expired_at: new Date().toISOString(),
            expired_reason: 'mfa_factor_reset',
            updated_at: new Date().toISOString(),
          })
          .eq('user_id', parsed.data.userId)
          .is('expired_at', null);

        if (sessionError) {
          console.error('Failed to invalidate staff_sessions:', sessionError);
        }

        // Invalidate backend cache
        invalidateStaffMfaCache(parsed.data.userId);

        // 6. Record immutable audit event
        const { error: auditError } = await admin.from('audit_events').insert({
          action: 'staff.mfa_factor_reset',
          actor_id: actor.id,
          actor_kind: 'staff',
          actor_role: actor.role,
          target_type: 'staff_mfa_factor',
          target_id: parsed.data.userId,
          before_state: { factorId: parsed.data.factorId, userId: parsed.data.userId },
          after_state: { factorReset: true, factorId: parsed.data.factorId, reason: parsed.data.reason },
          outcome: 'success',
        });

        if (auditError) {
          console.error('Failed to log MFA factor reset audit event:', auditError);
        }

        return jsonResponse(200, { ok: true, factorId: parsed.data.factorId });
      } finally {
        try {
          await passwordVerifier.auth.signOut({ scope: 'local' });
        } catch {
          // Ignore local signout error
        }
      }
    } catch (err) {
      if (err instanceof HttpError) {
        return jsonResponse(err.status, { error: err.code });
      }
      return jsonResponse(500, { error: 'internal_server_error' });
    }
  }

  return jsonResponse(405, { error: 'method_not_allowed' }, { Allow: 'GET, POST' });
}

export default { fetch: handleRequest };
