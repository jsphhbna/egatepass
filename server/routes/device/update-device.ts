import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { HttpError, recordReconciliation, requireStaffActor } from '../../actors.js';
import { jsonResponse, readBearerToken } from '../../http.js';
import { getServerSupabaseClients } from '../../supabase.js';

const schema = z.object({
  targetUid: z.string().uuid(),
  status: z.enum(['active', 'revoked']).optional(),
  name: z.string().trim().min(2).max(50).optional(),
  gate: z.string().trim().min(1).max(50).optional(),
}).strict().refine(
  (v) => v.status !== undefined || v.name !== undefined || v.gate !== undefined,
  { message: 'At least one field (status, name, or gate) is required' },
);

async function handleRequest(request: Request): Promise<Response> {
  if (request.method !== 'POST') return jsonResponse(405, { error: 'method_not_allowed' }, { Allow: 'POST' });
  const token = readBearerToken(request);
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!token) return jsonResponse(401, { error: 'authentication_required' });
  if (!parsed.success) return jsonResponse(400, { error: 'invalid_request' });

  try {
    const { admin } = getServerSupabaseClients();
    const actor = await requireStaffActor(admin, token, ['admin', 'superadmin']);
    const updated = await admin.schema('api').rpc('update_device_profile', {
      requested_actor_id: actor.id,
      requested_user_id: parsed.data.targetUid,
      requested_status: parsed.data.status ?? null,
      requested_alias: null,
      requested_request_id: randomUUID(),
      requested_name: parsed.data.name ?? null,
      requested_gate: parsed.data.gate ?? null,
    });
    if (updated.error) {
      if (updated.error.code === '42501') {
        const msg = updated.error.message || '';
        return jsonResponse(403, {
          error: msg.includes('superadmin_required_for_emergency_gate_reassignment')
            ? 'superadmin_required_for_emergency_gate_reassignment'
            : 'access_denied',
        });
      }
      if (updated.error.code === 'P0002') {
        return jsonResponse(404, { error: 'device_not_found' });
      }
      throw updated.error;
    }

    if (parsed.data.status !== undefined) {
      const authUpdate = await admin.auth.admin.updateUserById(parsed.data.targetUid, {
        ban_duration: parsed.data.status === 'active' ? 'none' : '876000h',
      });
      if (authUpdate.error) {
        await recordReconciliation(
          admin,
          'device.status.auth_ban_failed',
          'device',
          parsed.data.targetUid,
          authUpdate.error.message || 'auth_ban_failed',
          { targetStatus: parsed.data.status }
        );
        return jsonResponse(503, {
          error: 'device_updated_auth_reconciliation_required',
          result: 'partial',
          deviceUpdated: true,
          authSynchronized: false,
          reconciliationRequired: true,
          message: 'The device was updated in the database, but authentication synchronization requires reconciliation.',
        });
      }
    }

    return jsonResponse(200, { ok: true });
  } catch (error) {
    if (error instanceof HttpError) return jsonResponse(error.status, { error: error.code });
    console.error('Device update failed.', error instanceof Error ? error.message : 'unknown_error');
    return jsonResponse(503, { error: 'service_unavailable' });
  }
}

export default { fetch: handleRequest };
