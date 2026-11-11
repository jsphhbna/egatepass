import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { getVerifiedSessionContext, HttpError } from '../../actors.js';
import { jsonResponse, readBearerToken } from '../../http.js';
import { getServerSupabaseClients } from '../../supabase.js';

const HUMAN_STAFF_ROLES = ['superadmin', 'admin', 'office_staff', 'guard'] as const;

const postBodySchema = z.object({
  action: z.enum(['touch', 'expire']).default('touch'),
  reason: z.enum(['idle_timeout_15m', 'manual_sign_out']).optional(),
}).strict();

async function handleRequest(request: Request): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'POST') {
    return jsonResponse(405, { error: 'method_not_allowed' }, { Allow: 'GET, POST' });
  }

  const token = readBearerToken(request);
  if (!token) return jsonResponse(401, { error: 'authentication_required' });

  try {
    const { admin } = getServerSupabaseClients();
    const session = await getVerifiedSessionContext(admin, token);

    if (session.isRecoverySession) {
      return jsonResponse(403, { error: 'recovery_session_forbidden' });
    }
    if (session.isAnonymous || !session.user.email) {
      return jsonResponse(403, { error: 'access_denied' });
    }

    const { data: staffProfile, error: staffErr } = await admin
      .from('staff_profiles')
      .select('role, active')
      .eq('user_id', session.user.id)
      .maybeSingle();
    if (staffErr) throw staffErr;

    if (!staffProfile) {
      const { data: deviceProfile } = await admin
        .from('devices')
        .select('type, status')
        .eq('user_id', session.user.id)
        .maybeSingle();

      if (deviceProfile && deviceProfile.status === 'active') {
        return jsonResponse(200, {
          kind: 'device',
          deviceType: deviceProfile.type,
          exemptFromIdleTimeout: true,
        });
      }
      return jsonResponse(403, { error: 'access_denied' });
    }

    if (!staffProfile.active || !HUMAN_STAFF_ROLES.includes(staffProfile.role)) {
      return jsonResponse(403, { error: 'access_denied' });
    }

    if (!session.sessionId) {
      return jsonResponse(401, { error: 'invalid_session_claim' });
    }

    if (request.method === 'GET') {
      const { data, error } = await admin.schema('api').rpc('touch_staff_session', {
        requested_session_id: session.sessionId,
        requested_user_id: session.user.id,
        requested_create_only: true,
        requested_request_id: randomUUID(),
      });
      if (error) throw error;
      if (data && (data.expired === true || data.valid === false)) {
        return jsonResponse(401, {
          error: 'session_idle_expired',
          reason: data.reason || 'idle_timeout_15m',
          expiredAt: data.expiredAt ?? null,
        });
      }
      return jsonResponse(200, {
        kind: 'staff',
        valid: true,
        expired: false,
        sessionId: data?.sessionId ?? session.sessionId,
        lastActiveAt: data?.lastActiveAt ?? null,
        expiresAt: data?.expiresAt ?? null,
        idleTimeoutSeconds: data?.idleTimeoutSeconds ?? 900,
      });
    }

    const rawBody = await request.json().catch(() => ({}));
    const parsed = postBodySchema.safeParse(rawBody && typeof rawBody === 'object' ? rawBody : {});
    if (!parsed.success) {
      return jsonResponse(400, { error: 'invalid_request' });
    }

    if (parsed.data.action === 'expire') {
      const { error } = await admin.schema('api').rpc('expire_staff_session', {
        requested_session_id: session.sessionId,
        requested_user_id: session.user.id,
        requested_reason: parsed.data.reason ?? 'manual_sign_out',
        requested_request_id: randomUUID(),
      });
      if (error) throw error;
      return jsonResponse(200, { ok: true, expired: true });
    }

    const { data, error } = await admin.schema('api').rpc('touch_staff_session', {
      requested_session_id: session.sessionId,
      requested_user_id: session.user.id,
      requested_create_only: false,
      requested_request_id: randomUUID(),
    });
    if (error) throw error;

    if (data && (data.expired === true || data.valid === false)) {
      return jsonResponse(401, {
        error: 'session_idle_expired',
        reason: data.reason || 'idle_timeout_15m',
        expiredAt: data.expiredAt ?? null,
      });
    }

    return jsonResponse(200, {
      kind: 'staff',
      valid: true,
      expired: false,
      sessionId: data?.sessionId ?? session.sessionId,
      lastActiveAt: data?.lastActiveAt ?? null,
      expiresAt: data?.expiresAt ?? null,
      idleTimeoutSeconds: data?.idleTimeoutSeconds ?? 900,
    });
  } catch (error) {
    if (error instanceof HttpError) return jsonResponse(error.status, { error: error.code });
    console.error('Staff session activity handler failed:', error instanceof Error ? error.message : 'unknown_error');
    return jsonResponse(503, { error: 'service_unavailable' });
  }
}

export default { fetch: handleRequest };
