import { z } from 'zod';
import { getVerifiedSessionContext, HttpError, recordReconciliation } from '../../actors.js';
import { jsonResponse, readBearerToken } from '../../http.js';
import { passwordSchema } from '../../password-policy.js';
import { getServerSupabaseClients } from '../../supabase.js';

const requestSchema = z.object({
  newPassword: passwordSchema,
}).strict();

async function handleRequest(request: Request): Promise<Response> {
  if (request.method !== 'POST') {
    return jsonResponse(405, { error: 'method_not_allowed' }, { Allow: 'POST' });
  }

  const token = readBearerToken(request);
  if (!token) {
    return jsonResponse(401, { error: 'authentication_required' });
  }

  const requestBody = await request.json().catch(() => null);
  const parsed = requestSchema.safeParse(requestBody);
  if (!parsed.success) {
    return jsonResponse(400, { error: 'invalid_request', details: parsed.error.issues });
  }

  try {
    const { admin } = getServerSupabaseClients();

    // 1. Authenticate and cryptographically verify session context through Supabase Auth
    let session;
    try {
      session = await getVerifiedSessionContext(admin, token);
    } catch (err) {
      if (err instanceof HttpError) {
        return jsonResponse(err.status, { error: err.code });
      }
      return jsonResponse(401, { error: 'invalid_session' });
    }

    // 2. Recovery Capability Verification: Token AMR claim MUST contain 'recovery'
    // Ordinary password-authenticated sessions, device sessions, or generic OTP tokens
    // MUST NEVER be accepted as password recovery authority.
    if (!session.isRecoverySession) {
      return jsonResponse(403, { error: 'recovery_session_required' });
    }

    // 3. Anonymous Portal Accounts are strictly forbidden from password mutation
    if (session.isAnonymous) {
      return jsonResponse(403, { error: 'anonymous_recovery_not_allowed' });
    }

    const user = session.user;

    // 4. Device Credentials Governance: Devices are Super Admin managed only
    // A device session (@devices.egatepass.invalid or in public.devices) must never self-recover
    const isDeviceEmail = typeof user.email === 'string' && user.email.toLowerCase().endsWith('@devices.egatepass.invalid');
    if (isDeviceEmail) {
      return jsonResponse(403, { error: 'device_password_change_forbidden' });
    }

    // Query devices using real canonical columns and fail closed if lookup fails
    const { data: deviceRecord, error: deviceError } = await admin
      .from('devices')
      .select('user_id, alias, type, status')
      .eq('user_id', user.id)
      .maybeSingle();

    if (deviceError) {
      console.error('Authoritative device lookup failed during password recovery:', deviceError.message || deviceError);
      return jsonResponse(503, { error: 'service_unavailable' });
    }

    if (deviceRecord) {
      return jsonResponse(403, { error: 'device_password_change_forbidden' });
    }

    // 5. Verify the target is an active staff profile
    const { data: profile, error: profileError } = await admin
      .from('staff_profiles')
      .select('role, active')
      .eq('user_id', user.id)
      .maybeSingle();

    if (profileError) {
      console.error('Authoritative staff profile lookup failed during password recovery:', profileError.message || profileError);
      return jsonResponse(503, { error: 'service_unavailable' });
    }

    if (!profile || !profile.active) {
      return jsonResponse(403, { error: 'unauthorized_staff_identity' });
    }

    // 6. Update user password via service-role admin API
    const { error: updateError } = await admin.auth.admin.updateUserById(user.id, {
      password: parsed.data.newPassword,
    });
    if (updateError) {
      throw updateError;
    }

    // 7. Insert immutable audit record (inspect returned error truthfully)
    const { error: auditError } = await admin.from('audit_events').insert({
      actor_id: user.id,
      actor_kind: 'staff',
      actor_role: profile.role,
      action: 'staff.password_reset',
      target_type: 'staff_profile',
      target_id: user.id,
      outcome: 'success',
      after_state: { passwordReset: true },
    });

    if (auditError) {
      console.error('Password reset audit insert failed:', auditError.message || auditError);
      const reconciliationRecorded = await recordReconciliation(
        admin,
        'staff.password_reset.audit_failed',
        'staff_profile',
        user.id,
        auditError.message || 'audit_insert_failed',
        { role: profile.role }
      );

      return jsonResponse(200, {
        ok: true,
        result: 'partial',
        passwordChanged: true,
        auditPending: true,
        reconciliationRecorded,
      });
    }

    return jsonResponse(200, {
      ok: true,
      result: 'success',
      passwordChanged: true,
      auditPending: false,
    });
  } catch (error) {
    console.error('Password recovery reset failed:', error instanceof Error ? error.message : 'unknown');
    return jsonResponse(500, { error: 'password_reset_failed' });
  }
}

export default { fetch: handleRequest };