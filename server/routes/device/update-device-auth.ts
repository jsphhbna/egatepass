import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { controlledDeviceEmail, HttpError, recordReconciliation, requireStaffActor } from '../../actors.js';
import { jsonResponse, readBearerToken } from '../../http.js';
import { passwordSchema } from '../../password-policy.js';
import { getServerSupabaseClients } from '../../supabase.js';

const schema = z.object({
  targetUid: z.string().uuid(),
  email: z.string().min(3).max(320).optional(),
  password: passwordSchema.optional(),
}).strict().refine((v) => v.email || v.password, { message: 'Either email or password must be provided' });

async function handleRequest(request: Request): Promise<Response> {
  if (request.method !== 'POST') {
    return jsonResponse(405, { error: 'method_not_allowed' }, { Allow: 'POST' });
  }

  const token = readBearerToken(request);
  if (!token) return jsonResponse(401, { error: 'authentication_required' });

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return jsonResponse(400, { error: 'invalid_json_body' });
  }

  const parsed = schema.safeParse(rawBody);
  if (!parsed.success) {
    return jsonResponse(400, { error: 'invalid_request', details: parsed.error.issues });
  }

  const nextIdentity = parsed.data.email ? controlledDeviceEmail(parsed.data.email) : null;
  if (parsed.data.email && !nextIdentity) {
    return jsonResponse(400, { error: 'invalid_device_alias' });
  }

  try {
    const { admin } = getServerSupabaseClients();
    const actor = await requireStaffActor(admin, token, ['superadmin']);

    // 1. Explicitly verify target is NOT a staff user (defense-in-depth against staff modification)
    // P0-05: Handle staff_profiles read error fail-closed
    const { data: staffCheck, error: staffError } = await admin
      .from('staff_profiles')
      .select('user_id')
      .eq('user_id', parsed.data.targetUid)
      .maybeSingle();

    if (staffError) {
      throw new HttpError(503, 'staff_verification_failed');
    }

    if (staffCheck) {
      return jsonResponse(403, { error: 'cannot_modify_staff_via_device_endpoint' });
    }

    // 2. Target validation: verify targetUid belongs to an existing, non-retired device
    const { data: deviceRecord, error: deviceError } = await admin
      .from('devices')
      .select('user_id, alias, name, type, gate, status, deleted_at')
      .eq('user_id', parsed.data.targetUid)
      .maybeSingle();

    if (deviceError) throw deviceError;
    if (!deviceRecord || deviceRecord.deleted_at !== null || deviceRecord.status === 'revoked') {
      return jsonResponse(404, { error: 'device_not_found' });
    }

    // 3. If alias is changing, verify no conflict with another active device
    if (nextIdentity && nextIdentity.alias !== deviceRecord.alias) {
      const { data: conflictRecord, error: conflictError } = await admin
        .from('devices')
        .select('user_id')
        .eq('alias', nextIdentity.alias)
        .neq('user_id', parsed.data.targetUid)
        .is('deleted_at', null)
        .maybeSingle();

      if (conflictError) throw conflictError;
      if (conflictRecord) {
        return jsonResponse(409, { error: 'device_alias_conflict' });
      }
    }

    // 4. Verify Auth user exists before making any changes
    const before = await admin.auth.admin.getUserById(parsed.data.targetUid);
    if (before.error || !before.data.user) {
      return jsonResponse(404, { error: 'device_auth_user_not_found' });
    }

    const previousEmail = before.data.user.email || '';
    const existingAppMetadata = (before.data.user.app_metadata as Record<string, unknown> | undefined) || {};

    // 5. Update Auth credentials with Admin-Controlled Rotation Marker (Root Cause Class D & 6A)
    const credentialChangeId = randomUUID();
    const authUpdatePayload: {
      email?: string;
      email_confirm?: boolean;
      password?: string;
      app_metadata: Record<string, unknown>;
    } = {
      app_metadata: {
        ...existingAppMetadata,
        egatepass_device_credential_change_id: credentialChangeId,
      },
    };

    let hasCredentialMutation = false;
    if (nextIdentity && nextIdentity.email !== previousEmail) {
      authUpdatePayload.email = nextIdentity.email;
      authUpdatePayload.email_confirm = true;
      hasCredentialMutation = true;
    }
    if (parsed.data.password) {
      authUpdatePayload.password = parsed.data.password;
      hasCredentialMutation = true;
    }

    if (hasCredentialMutation) {
      const authUpdate = await admin.auth.admin.updateUserById(parsed.data.targetUid, authUpdatePayload);
      if (authUpdate.error) {
        throw authUpdate.error;
      }
    }

    // 6. If alias changed, update database record via service RPC
    if (nextIdentity && nextIdentity.alias !== deviceRecord.alias) {
      const profile = await admin.schema('api').rpc('update_device_profile', {
        requested_actor_id: actor.id,
        requested_user_id: parsed.data.targetUid,
        requested_status: null,
        requested_alias: nextIdentity.alias,
        requested_request_id: randomUUID(),
      });

      if (profile.error) {
        // Honest compensation: email can be reverted in Auth, but password cannot be un-hashed
        // Section 7A: Compensating rollback MUST use a second fresh marker
        if (nextIdentity.email !== previousEmail && previousEmail) {
          const rollbackCredentialChangeId = randomUUID();
          const rollbackAuth = await admin.auth.admin.updateUserById(parsed.data.targetUid, {
            email: previousEmail,
            email_confirm: true,
            app_metadata: {
              ...existingAppMetadata,
              egatepass_device_credential_change_id: rollbackCredentialChangeId,
            },
          });
          if (rollbackAuth.error) {
            await recordReconciliation(
              admin,
              'device.credentials.rollback_email_failed',
              'device',
              parsed.data.targetUid,
              rollbackAuth.error.message || 'email_rollback_failed',
              { previousEmail, requestedAlias: nextIdentity.alias }
            );
          }
        }
        await recordReconciliation(
          admin,
          'device.credentials.alias_db_failed',
          'device',
          parsed.data.targetUid,
          profile.error.message || 'alias_db_rpc_failed',
          {
            passwordChanged: !!parsed.data.password,
            requestedAlias: nextIdentity.alias,
            previousAlias: deviceRecord.alias,
          }
        );
        throw profile.error;
      }
    }

    // 7. Mandatory immutable audit event for credential updates
    // Section 14: Return truthful partial success if credentials changed but audit failed
    const { error: auditError } = await admin.from('audit_events').insert({
      actor_id: actor.id,
      actor_kind: 'staff',
      actor_role: actor.role,
      action: 'device.password_update',
      target_type: 'device',
      target_id: parsed.data.targetUid,
      before_state: {
        alias: deviceRecord.alias,
        email: previousEmail,
        password_changed: false,
      },
      after_state: {
        alias: nextIdentity ? nextIdentity.alias : deviceRecord.alias,
        email: nextIdentity ? nextIdentity.email : previousEmail,
        password_changed: !!parsed.data.password,
      },
      outcome: 'success',
    });

    if (auditError) {
      console.error('Audit insert failed for device credentials update', auditError);
      const reconciliationRecorded = await recordReconciliation(
        admin,
        'device.credentials.audit_failed',
        'device',
        parsed.data.targetUid,
        auditError.message || 'audit_insert_failed',
        {
          alias: nextIdentity ? nextIdentity.alias : deviceRecord.alias,
          passwordChanged: !!parsed.data.password,
        }
      );

      return jsonResponse(200, {
        ok: true,
        result: 'partial',
        credentialsChanged: true,
        auditPending: true,
        reconciliationRecorded,
      });
    }

    return jsonResponse(200, {
      ok: true,
      result: 'success',
      credentialsChanged: true,
      auditPending: false,
    });
  } catch (error) {
    if (error instanceof HttpError || (error && typeof error === 'object' && typeof (error as any).status === 'number')) {
      return jsonResponse((error as any).status, { error: (error as any).code || (error as any).message });
    }
    console.error('Device credential update failed.', error instanceof Error ? error.message : 'unknown_error');
    return jsonResponse(503, { error: 'service_unavailable' });
  }
}

export default { fetch: handleRequest };
export { handleRequest as POST };
