import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { HttpError, recordReconciliation, requireStaffActor } from '../../actors.js';
import { jsonResponse, readBearerToken } from '../../http.js';
import { getServerSupabaseClients } from '../../supabase.js';

const schema = z
  .object({
    targetUid: z.string().uuid(),
    reason: z.string().trim().max(240).optional(),
    password: z.string().min(1).optional(),
  })
  .strict();

async function handleRequest(request: Request): Promise<Response> {
  if (request.method !== 'POST' && request.method !== 'DELETE') {
    return jsonResponse(405, { error: 'method_not_allowed' }, { Allow: 'POST, DELETE' });
  }

  const token = readBearerToken(request);
  const parsed = schema.safeParse(await request.json().catch(() => null));

  if (!token) return jsonResponse(401, { error: 'authentication_required' });
  if (!parsed.success) return jsonResponse(400, { error: 'invalid_request' });

  try {
    const { admin, passwordVerifier } = getServerSupabaseClients();
    const actor = await requireStaffActor(admin, token, ['superadmin']);

    if (actor.id === parsed.data.targetUid) {
      return jsonResponse(403, { error: 'cannot_delete_self' });
    }

    // Optional Super Admin re-authentication if password was provided in payload
    if (parsed.data.password) {
      const { data: verified, error: verificationError } = await passwordVerifier.auth.signInWithPassword({
        email: actor.email,
        password: parsed.data.password,
      });

      try {
        if (verificationError || !verified.user || verified.user.id !== actor.id) {
          return jsonResponse(401, { error: 'invalid_superadmin_password' });
        }
      } finally {
        try {
          await passwordVerifier.auth.signOut({ scope: 'local' });
        } catch {
          // ignore local signout error
        }
      }
    }

    // 1. Execute atomic database deletion RPC
    const rpcResult = await admin.schema('api').rpc('delete_staff_account', {
      requested_actor_id: actor.id,
      requested_target_uid: parsed.data.targetUid,
      requested_request_id: randomUUID(),
    });

    if (rpcResult.error) {
      const msg = rpcResult.error.message || '';
      if (msg.includes('cannot_delete_self')) {
        return jsonResponse(403, { error: 'cannot_delete_self' });
      }
      if (msg.includes('target_user_not_found')) {
        return jsonResponse(404, { error: 'target_user_not_found' });
      }
      if (msg.includes('cannot_delete_last_superadmin')) {
        return jsonResponse(409, { error: 'cannot_delete_last_superadmin' });
      }
      if (msg.includes('cannot_delete_device_via_staff_api')) {
        return jsonResponse(400, { error: 'cannot_delete_device_via_staff_api' });
      }
      if (msg.includes('target_has_active_incident_holds')) {
        return jsonResponse(409, {
          error: 'target_has_active_incident_holds',
          message: 'Cannot delete an account with active incident holds locking evidence.',
        });
      }
      if (rpcResult.error.code === '42501' || msg.includes('active_superadmin_required')) {
        return jsonResponse(403, { error: 'access_denied' });
      }
      throw rpcResult.error;
    }

    // 2. Permanently remove the user from Supabase Auth
    // This immediately invalidates active sessions, refresh tokens, and frees the email address for reuse
    const authDelete = await admin.auth.admin.deleteUser(parsed.data.targetUid);

    if (authDelete.error) {
      const authErr = authDelete.error;
      const authMsg = (typeof authErr === 'object' && authErr !== null && 'message' in authErr ? String(authErr.message) : '').toLowerCase();
      const authCode = typeof authErr === 'object' && authErr !== null && 'code' in authErr ? String(authErr.code) : '';

      if (authCode === 'user_not_found' || authMsg.includes('not found')) {
        // Identity was already missing from Auth; database profile was cleaned up
        return jsonResponse(200, {
          ok: true,
          deleted: true,
          targetUid: parsed.data.targetUid,
          authPreviouslyPurged: true,
        });
      }

      await recordReconciliation(
        admin,
        'staff.delete_auth',
        'staff_profile',
        parsed.data.targetUid,
        authCode || 'auth_delete_failed',
        { deleted: true }
      );

      return jsonResponse(503, {
        error: 'profile_deleted_auth_reconciliation_required',
        result: 'partial',
        profileDeleted: true,
        authSynchronized: false,
        reconciliationRequired: true,
        message: 'The staff account was deleted from the database, but authentication identity cleanup requires reconciliation.',
      });
    }

    return jsonResponse(200, {
      ok: true,
      deleted: true,
      targetUid: parsed.data.targetUid,
    });
  } catch (error) {
    if (error instanceof HttpError) return jsonResponse(error.status, { error: error.code });
    console.error('Staff permanent deletion failed:', error instanceof Error ? error.message : 'unknown_error');
    return jsonResponse(503, { error: 'service_unavailable' });
  }
}

export const fetch = handleRequest;
export default { fetch: handleRequest };
