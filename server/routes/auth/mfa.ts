import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import { HttpError, requireStaffActor } from '../../actors.js';
import { jsonResponse, readBearerToken } from '../../http.js';
import { getServerSupabaseClients } from '../../supabase.js';

const resetMfaSchema = z.object({
  action: z.enum(['reset_factor', 'delete_factor']),
  userId: z.string().uuid(),
  factorId: z.string().min(1),
  reason: z.string().trim().max(500).optional(),
}).strict();

export interface AdminResetMfaParams {
  userId: string;
  factorId: string;
  reason?: string;
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

  // Call official Supabase Admin Auth MFA API
  const { data, error } = await admin.auth.admin.mfa.deleteFactor({
    userId: params.userId,
    id: params.factorId,
  });

  if (error) {
    throw new HttpError(400, error.message || 'mfa_factor_deletion_failed');
  }

  // Record immutable audit event
  const { error: auditError } = await admin.from('audit_events').insert({
    actor_id: actor.id,
    actor_kind: 'staff',
    actor_role: actor.role,
    action: 'staff.mfa_factor_reset',
    target_type: 'staff_mfa_factor',
    target_id: params.userId,
    before_state: { factorId: params.factorId, userId: params.userId },
    after_state: { factorReset: true, factorId: params.factorId, reason: params.reason ?? null },
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

  const { admin } = getServerSupabaseClients();

  // GET: List factors for user (Superadmin only)
  if (request.method === 'GET') {
    try {
      await requireStaffActor(admin, token, ['superadmin']);
      const url = new URL(request.url);
      const userId = url.searchParams.get('userId');
      if (!userId) {
        return jsonResponse(400, { error: 'missing_user_id' });
      }

      const { data, error } = await admin.auth.admin.mfa.listFactors({ userId });
      if (error) {
        return jsonResponse(400, { error: error.message });
      }
      return jsonResponse(200, { factors: data?.factors ?? [] });
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
      const body = await request.json().catch(() => null);
      const parsed = resetMfaSchema.safeParse(body);
      if (!parsed.success) {
        return jsonResponse(400, { error: 'invalid_request', details: parsed.error.issues });
      }

      const result = await adminResetMfaFactor(admin, token, {
        userId: parsed.data.userId,
        factorId: parsed.data.factorId,
        reason: parsed.data.reason,
      });

      return jsonResponse(200, { ok: true, factorId: result.factorId });
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
