import { z } from 'zod';
import { HttpError, recordReconciliation, requireStaffActor } from '../../actors.js';
import { jsonResponse, readBearerToken } from '../../http.js';
import { getServerSupabaseClients } from '../../supabase.js';

const schema = z
  .object({
    targetUid: z.string().uuid(),
    reason: z.string().trim().min(5).max(240),
    password: z.string().min(1),
  })
  .strict();

async function handleRequest(request: Request): Promise<Response> {
  if (request.method !== 'POST') {
    return jsonResponse(405, { error: 'method_not_allowed' }, { Allow: 'POST' });
  }

  const token = readBearerToken(request);
  const parsed = schema.safeParse(await request.json().catch(() => null));

  if (!token) return jsonResponse(401, { error: 'authentication_required' });
  if (!parsed.success) return jsonResponse(400, { error: 'invalid_request' });

  try {
    const { admin, passwordVerifier } = getServerSupabaseClients();
    const actor = await requireStaffActor(admin, token, ['superadmin']);

    if (actor.id === parsed.data.targetUid) {
      return jsonResponse(403, { error: 'cannot_decommission_self' });
    }

    // Reauthenticate Super Admin using isolated client
    const { data: verified, error: verificationError } = await passwordVerifier.auth.signInWithPassword({
      email: actor.email,
      password: parsed.data.password,
    });

    try {
      if (verificationError || !verified.user || verified.user.id !== actor.id) {
        return jsonResponse(401, { error: 'invalid_superadmin_password' });
      }

      // Execute atomic decommission RPC
      const rpcResult = await admin.schema('api').rpc('decommission_staff_profile', {
        requested_target_uid: parsed.data.targetUid,
        requested_reason: parsed.data.reason,
        requested_actor_id: actor.id,
      });

      if (rpcResult.error) {
        const msg = rpcResult.error.message || '';
        if (msg.includes('cannot decommission self')) {
          return jsonResponse(403, { error: 'cannot_decommission_self' });
        }
        if (msg.includes('target staff profile must already be inactive')) {
          return jsonResponse(409, { error: 'target_user_must_be_inactive' });
        }
        if (msg.includes('target staff profile is already decommissioned')) {
          return jsonResponse(409, { error: 'target_already_decommissioned' });
        }
        if (msg.includes('target staff profile not found')) {
          return jsonResponse(404, { error: 'target_user_not_found' });
        }
        if (msg.includes('managed device identities cannot be decommissioned')) {
          return jsonResponse(400, { error: 'cannot_decommission_device' });
        }
        if (rpcResult.error.code === '42501') {
          return jsonResponse(403, { error: 'access_denied' });
        }
        throw rpcResult.error;
      }

      // Enforce permanent Auth suspension
      const authUpdate = await admin.auth.admin.updateUserById(parsed.data.targetUid, {
        ban_duration: '876000h',
      });

      if (authUpdate.error) {
        await recordReconciliation(
          admin,
          'staff.auth_status',
          'staff_profile',
          parsed.data.targetUid,
          authUpdate.error.code ?? 'auth_suspend_failed',
          { decommissioned: true }
        );
        return jsonResponse(503, {
          error: 'profile_decommissioned_auth_reconciliation_required',
          result: 'partial',
          profileDecommissioned: true,
          authSynchronized: false,
          reconciliationRequired: true,
          message:
            'The staff account was permanently decommissioned in the database, but authentication suspension requires reconciliation.',
        });
      }

      return jsonResponse(200, {
        ok: true,
        targetUid: parsed.data.targetUid,
      });
    } finally {
      // Clean up isolated password verifier session (local scope only)
      try {
        await passwordVerifier.auth.signOut({ scope: 'local' });
      } catch {
        // Ignore local signout error
      }
    }
  } catch (error) {
    if (error instanceof HttpError) return jsonResponse(error.status, { error: error.code });
    console.error('Staff permanent decommission failed:', error instanceof Error ? error.message : 'unknown_error');
    return jsonResponse(503, { error: 'service_unavailable' });
  }
}

export default { fetch: handleRequest };
