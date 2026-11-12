import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { HttpError, recordReconciliation, requireStaffActor } from '../../actors.js';
import { jsonResponse, readBearerToken, pgUuidSchema } from '../../http.js';
import { getServerSupabaseClients } from '../../supabase.js';

const schema = z.object({
  targetUid: pgUuidSchema,
  role: z.enum(['guard', 'admin', 'superadmin', 'office_staff']).optional(),
  active: z.boolean().optional(),
  officeIds: z.array(pgUuidSchema).optional(),
}).strict().refine((value) => value.role !== undefined || value.active !== undefined || value.officeIds !== undefined);

async function handleRequest(request: Request): Promise<Response> {
  if (request.method !== 'POST') return jsonResponse(405, { error: 'method_not_allowed' }, { Allow: 'POST' });
  const token = readBearerToken(request);
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!token) return jsonResponse(401, { error: 'authentication_required' });
  if (!parsed.success) return jsonResponse(400, { error: 'invalid_request' });
  if (parsed.data.role === 'guard') {
    return jsonResponse(422, { error: 'legacy_guard_role_disabled', message: 'The legacy guard role is disabled and cannot be assigned.' });
  }

  try {
    const { admin } = getServerSupabaseClients();
    const actor = await requireStaffActor(admin, token, ['admin', 'superadmin']);
    const uniqueOfficeIds =
      parsed.data.officeIds !== undefined ? [...new Set(parsed.data.officeIds)] : undefined;

    if (uniqueOfficeIds !== undefined && actor.role !== 'superadmin') {
      return jsonResponse(403, {
        error: 'superadmin_required',
        message: 'Only superadmin can modify office assignments',
      });
    }

    if (uniqueOfficeIds !== undefined && uniqueOfficeIds.length > 0) {
      if (parsed.data.active === false) {
        return jsonResponse(400, {
          error: 'staff_inactive',
          message: 'Cannot assign offices while deactivating a staff account.',
        });
      }
      if (parsed.data.role !== undefined && parsed.data.role !== 'office_staff') {
        return jsonResponse(400, {
          error: 'invalid_staff_role',
          message: 'Office assignments are only supported for office_staff accounts.',
        });
      }
    }

    const shouldUpdateProfile =
      parsed.data.role !== undefined || parsed.data.active !== undefined;

    if (shouldUpdateProfile) {
      const updated = await admin.schema('api').rpc('update_staff_profile', {
        requested_actor_id: actor.id,
        requested_user_id: parsed.data.targetUid,
        requested_role: parsed.data.role ?? null,
        requested_active: parsed.data.active ?? null,
        requested_request_id: randomUUID(),
      });
      if (updated.error) {
        if (updated.error.code === '22023' || updated.error.message?.includes('legacy_guard_role_disabled')) {
          return jsonResponse(422, { error: 'legacy_guard_role_disabled', message: 'The legacy guard role is disabled and cannot be assigned.' });
        }
        if (updated.error.code === 'P0004' || updated.error.message?.includes('target_decommissioned')) {
          return jsonResponse(409, { error: 'target_decommissioned' });
        }
        if (updated.error.code === '23514') return jsonResponse(409, { error: 'cannot_remove_last_superadmin' });
        if (updated.error.code === '42501') return jsonResponse(403, { error: 'access_denied' });
        throw updated.error;
      }
      if (parsed.data.active !== undefined) {
        const authUpdate = await admin.auth.admin.updateUserById(parsed.data.targetUid, {
          ban_duration: parsed.data.active ? 'none' : '876000h',
        });
        if (authUpdate.error) {
          await recordReconciliation(admin, 'staff.auth_status', 'staff_profile', parsed.data.targetUid, authUpdate.error.code ?? 'auth_update_failed', { active: parsed.data.active });
          return jsonResponse(503, {
            error: 'profile_updated_auth_reconciliation_required',
            result: 'partial',
            profileUpdated: true,
            authSynchronized: false,
            reconciliationRequired: true,
            message: 'The staff profile was updated, but authentication synchronization requires reconciliation.',
          });
        }
      }
    }

    if (uniqueOfficeIds !== undefined) {
      const assignRes = await admin.schema('api').rpc('replace_staff_office_assignments', {
        requested_actor_id: actor.id,
        requested_user_id: parsed.data.targetUid,
        requested_office_ids: uniqueOfficeIds,
        requested_request_id: randomUUID(),
      });

      if (assignRes.error) {
        const errCode = assignRes.error.code;
        const errMsg = assignRes.error.message || '';
        if (errCode === 'P0004' || errMsg.includes('target_decommissioned')) {
          return jsonResponse(409, { error: 'target_decommissioned', message: 'Cannot modify a decommissioned staff account.' });
        }
        if (errCode === '42501') {
          if (errMsg.includes('superadmin')) {
            return jsonResponse(403, { error: 'superadmin_required', message: 'Only superadmin can modify office assignments' });
          }
          if (errMsg.includes('office is inactive')) {
            return jsonResponse(400, { error: 'office_inactive', message: 'Cannot assign an inactive office.' });
          }
          if (errMsg.includes('inactive')) {
            return jsonResponse(409, { error: 'staff_inactive', message: 'Cannot assign offices to an inactive staff account.' });
          }
          return jsonResponse(403, { error: 'access_denied', message: errMsg });
        }
        if (errCode === 'P0002') {
          if (errMsg.includes('office')) {
            return jsonResponse(400, { error: 'invalid_office_id', message: 'One or more specified offices do not exist.' });
          }
          return jsonResponse(404, { error: 'staff_not_found', message: 'Target staff profile was not found.' });
        }
        if (errCode === '22023') {
          return jsonResponse(400, { error: 'invalid_office_assignment', message: errMsg });
        }
        throw assignRes.error;
      }

      return jsonResponse(200, { ok: true, officeIds: uniqueOfficeIds });
    }

    return jsonResponse(200, { ok: true });
  } catch (error) {
    if (error instanceof HttpError) return jsonResponse(error.status, { error: error.code });
    console.error('Staff update failed.', error instanceof Error ? error.message : 'unknown_error');
    return jsonResponse(503, { error: 'service_unavailable' });
  }
}

export const fetch = handleRequest;
export { handleRequest };
export default { fetch: handleRequest };
