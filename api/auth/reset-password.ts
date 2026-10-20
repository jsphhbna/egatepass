import { z } from 'zod';
import { jsonResponse, readBearerToken } from '../../server/http.js';
import { passwordSchema } from '../../server/password-policy.js';
import { getServerSupabaseClients } from '../../server/supabase.js';

const requestSchema = z.object({
  newPassword: passwordSchema,
}).strict();

interface JwtPayload {
  sub?: string;
  email?: string;
  is_anonymous?: boolean;
  amr?: Array<{ method: string; timestamp?: number }>;
  role?: string;
  [key: string]: unknown;
}

function parseJwtClaims(token: string): JwtPayload | null {
  try {
    const parts = token.split('.');
    if (parts.length < 2) return null;
    const jsonStr = Buffer.from(parts[1], 'base64url').toString('utf8');
    return JSON.parse(jsonStr) as JwtPayload;
  } catch {
    return null;
  }
}

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

    // 1. Authenticate the session with Supabase Auth
    const { data: identity, error: identityError } = await admin.auth.getUser(token);
    const user = identity?.user;
    if (identityError || !user) {
      return jsonResponse(401, { error: 'invalid_session' });
    }

    // 2. Cryptographic Token Inspection: AMR Claim MUST contain 'recovery'
    // Ordinary authenticated staff/devices/visitors log in via password or anonymous
    // which yields amr: [{ method: 'password' }] or [{ method: 'anonymous' }], NEVER 'recovery'.
    const claims = parseJwtClaims(token);
    const isRecoverySession = Array.isArray(claims?.amr) && claims.amr.some((m) => m.method === 'recovery');
    if (!isRecoverySession) {
      return jsonResponse(403, { error: 'recovery_session_required' });
    }

    // 3. Anonymous Portal Accounts are strictly forbidden from password mutation
    if (user.is_anonymous === true || claims?.is_anonymous === true) {
      return jsonResponse(403, { error: 'anonymous_recovery_not_allowed' });
    }

    // 4. Device Credentials Governance: Devices are Super Admin managed only
    // A device session (@devices.egatepass.invalid or in public.devices) must never self-recover
    const isDeviceEmail = typeof user.email === 'string' && user.email.toLowerCase().endsWith('@devices.egatepass.invalid');
    if (isDeviceEmail) {
      return jsonResponse(403, { error: 'device_password_change_forbidden' });
    }

    const { data: deviceRecord } = await admin
      .from('devices')
      .select('id, alias, type')
      .eq('user_id', user.id)
      .maybeSingle();

    if (deviceRecord) {
      return jsonResponse(403, { error: 'device_password_change_forbidden' });
    }

    // 5. Verify the target is an active staff profile
    const { data: profile, error: profileError } = await admin
      .from('staff_profiles')
      .select('role, active')
      .eq('user_id', user.id)
      .maybeSingle();

    if (profileError || !profile || !profile.active) {
      return jsonResponse(403, { error: 'unauthorized_staff_identity' });
    }

    // 6. Update user password via service-role admin API
    const { error: updateError } = await admin.auth.admin.updateUserById(user.id, {
      password: parsed.data.newPassword,
    });
    if (updateError) {
      throw updateError;
    }

    // 7. Insert immutable audit record
    await admin.from('audit_events').insert({
      actor_id: user.id,
      actor_kind: 'staff',
      actor_role: profile.role,
      action: 'staff.password_reset',
      target_type: 'staff_profile',
      target_id: user.id,
      outcome: 'success',
      after_state: { passwordReset: true },
    });

    return jsonResponse(200, { ok: true });
  } catch (error) {
    console.error('Password recovery reset failed:', error instanceof Error ? error.message : 'unknown');
    return jsonResponse(500, { error: 'password_reset_failed' });
  }
}

export default { fetch: handleRequest };
