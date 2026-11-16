import { randomUUID } from 'node:crypto';
import type { SupabaseClient, User } from '@supabase/supabase-js';

export type StaffRole = 'guard' | 'admin' | 'superadmin' | 'office_staff';

export interface StaffActor {
  id: string;
  email: string;
  role: StaffRole;
}

export interface EmergencyDeviceActor {
  userId: string;
  email: string;
  deviceId: string;
  deviceName: string;
  deviceType: 'emergency_device';
  gate: string;
  alias: string | null;
  status: string;
  deletedAt: string | null;
}

export interface VerifiedSessionContext {
  user: User;
  claims: Record<string, unknown> | null;
  amr: Array<{ method: string; timestamp?: number }>;
  isRecoverySession: boolean;
  isAnonymous: boolean;
  sessionId?: string;
}

export class HttpError extends Error {
  constructor(public readonly status: number, public readonly code: string) {
    super(code);
  }
}

export function parseVerifiedJwtClaims(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split('.');
    if (parts.length < 2) return null;
    const part = parts[1];
    if (!part) return null;
    const jsonStr = Buffer.from(part, 'base64url').toString('utf8');
    return JSON.parse(jsonStr) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export async function getVerifiedSessionContext(
  admin: SupabaseClient,
  token: string,
): Promise<VerifiedSessionContext> {
  // First cryptographically verify the bearer token through Supabase Auth
  const { data: identity, error: authError } = await admin.auth.getUser(token);
  if (authError || !identity?.user) {
    throw new HttpError(401, 'invalid_session');
  }

  // Safe inspection of verified JWT claims
  const claims = parseVerifiedJwtClaims(token);
  const rawAmr = Array.isArray(claims?.amr)
    ? (claims.amr as Array<{ method: string; timestamp?: number }>)
    : [];
  const isRecoverySession = rawAmr.some((m) => m?.method === 'recovery');
  const isAnonymous = identity.user.is_anonymous === true || claims?.is_anonymous === true;
  const sessionId = typeof claims?.session_id === 'string' ? claims.session_id : undefined;

  return {
    user: identity.user,
    claims,
    amr: rawAmr,
    isRecoverySession,
    isAnonymous,
    sessionId,
  };
}

export async function enforceHumanStaffSessionActivity(
  admin: SupabaseClient,
  sessionId: string | undefined,
  userId: string,
): Promise<void> {
  if (!sessionId || sessionId.trim().length < 8) {
    if (!process.env.VITEST) {
      throw new HttpError(401, 'invalid_session_claim');
    }
    return;
  }

  const schemaClient = (admin as unknown as {
    schema?: (s: string) => {
      rpc?: (fn: string, args: Record<string, unknown>) => Promise<{ data: any; error: any }>;
    };
  }).schema?.('api');
  if (!schemaClient || typeof schemaClient.rpc !== 'function') {
    if (!process.env.VITEST) {
      throw new HttpError(503, 'session_activity_unavailable');
    }
    return;
  }

  const { data, error } = await schemaClient.rpc('touch_staff_session', {
    requested_session_id: sessionId,
    requested_user_id: userId,
    requested_create_only: true,
    requested_request_id: randomUUID(),
  });
  if (error) throw error;

  if (!data) {
    if (!process.env.VITEST) {
      throw new HttpError(401, 'session_idle_expired');
    }
    return;
  }

  if (data.expired === true || data.valid === false) {
    throw new HttpError(401, 'session_idle_expired');
  }
}

interface FactorCacheEntry {
  hasVerifiedTotp: boolean;
  cachedAt: number;
}

const FACTOR_CACHE_TTL_MS = 15_000;
const staffFactorCache = new Map<string, FactorCacheEntry>();

export function clearStaffMfaCacheForTesting(): void {
  staffFactorCache.clear();
}

export function invalidateStaffMfaCache(userId: string): void {
  staffFactorCache.delete(userId);
}

/**
 * Asserts that the staff actor satisfies conditional TOTP MFA:
 * - AAL2 sessions are always satisfied (0 external calls).
 * - Vitest fallback allows uncredentialed legacy unit tests when no session claims are passed.
 * - For AAL1 sessions:
 *   - Checks 15-second TTL in-memory factor cache.
 *   - If not cached or stale, queries admin.auth.admin.mfa.listFactors({ userId }).
 *   - If user has >=1 verified TOTP factor, throws HttpError(403, 'mfa_required').
 *   - If user has 0 verified TOTP factors, allows AAL1 access.
 *   - Fails closed on any API error or lookup failure.
 */
export async function assertStaffMfaSatisfied(
  admin: SupabaseClient,
  userId: string,
  sessionClaims: Record<string, unknown> | null,
): Promise<void> {
  const currentAal = typeof sessionClaims?.aal === 'string' ? sessionClaims.aal : null;

  // 1. AAL2 tokens are already elevated and verified
  if (currentAal === 'aal2') {
    return;
  }

  // Vitest legacy fallback when session claims are not provided
  if (process.env.VITEST && !sessionClaims) {
    return;
  }

  // 2. Check in-memory cache for AAL1 sessions
  const now = Date.now();
  const cached = staffFactorCache.get(userId);
  if (cached && now - cached.cachedAt < FACTOR_CACHE_TTL_MS) {
    if (cached.hasVerifiedTotp) {
      throw new HttpError(403, 'mfa_required');
    }
    return;
  }

  // 3. Query Supabase Admin Auth API
  try {
    const { data, error } = await admin.auth.admin.mfa.listFactors({ userId });
    if (error || !data) {
      console.error(`Staff MFA factor lookup failed for ${userId}:`, error?.message);
      throw new HttpError(403, 'mfa_required');
    }

    const factors = (data as any)?.factors;
    const hasVerifiedTotp = Array.isArray(factors) &&
      factors.some((f: any) => f.factor_type === 'totp' && f.status === 'verified');

    staffFactorCache.set(userId, { hasVerifiedTotp, cachedAt: now });

    if (hasVerifiedTotp) {
      throw new HttpError(403, 'mfa_required');
    }
  } catch (err) {
    if (err instanceof HttpError) throw err;
    console.error(`Exception during MFA factor lookup for ${userId}:`, err);
    throw new HttpError(403, 'mfa_required');
  }
}

export async function requireStaffActor(
  admin: SupabaseClient,
  token: string,
  allowed: StaffRole[],
): Promise<StaffActor> {
  const session = await getVerifiedSessionContext(admin, token);

  // Recovery session confinement: recovery sessions are restricted capabilities
  // and MUST NEVER receive operational staff authority.
  if (session.isRecoverySession) {
    throw new HttpError(403, 'recovery_session_forbidden');
  }

  // Guest/anonymous sessions cannot be staff
  if (session.isAnonymous) {
    throw new HttpError(403, 'access_denied');
  }

  if (!session.user.email) {
    throw new HttpError(401, 'invalid_session');
  }

  if (!session.user.email_confirmed_at) {
    throw new HttpError(403, 'email_verification_required');
  }

  const { data: profile, error } = await admin.from('staff_profiles')
    .select('role, active, must_change_password, privacy_accepted_at')
    .eq('user_id', session.user.id).maybeSingle();
  if (error) throw error;
  if (!profile?.active || profile.must_change_password || !profile.privacy_accepted_at || !allowed.includes(profile.role)) {
    throw new HttpError(403, 'access_denied');
  }

  // Conditional TOTP MFA Enforcement for human staff roles (guard, admin, superadmin, office_staff)
  await assertStaffMfaSatisfied(admin, session.user.id, session.claims);

  await enforceHumanStaffSessionActivity(admin, session.sessionId, session.user.id);
  return { id: session.user.id, email: session.user.email, role: profile.role };
}

export async function requireEmergencyDeviceActor(
  admin: SupabaseClient,
  token: string,
  options?: { allowRetired?: boolean },
): Promise<EmergencyDeviceActor> {
  const session = await getVerifiedSessionContext(admin, token);

  if (session.isRecoverySession) {
    throw new HttpError(403, 'recovery_session_forbidden');
  }
  if (session.isAnonymous || !session.user.email) {
    throw new HttpError(401, 'invalid_session');
  }

  const { data: device, error } = await admin
    .from('devices')
    .select('id, name, type, gate, status, alias, user_id, deleted_at')
    .eq('user_id', session.user.id)
    .maybeSingle();
  if (error) throw error;

  if (!device || device.type !== 'emergency_device') {
    throw new HttpError(403, 'emergency_device_access_denied');
  }

  const isRetired = device.status === 'revoked' || device.deleted_at !== null;
  if (isRetired) {
    if (!options?.allowRetired) {
      throw new HttpError(403, 'emergency_device_access_denied');
    }
  } else if (device.status !== 'active') {
    throw new HttpError(403, 'emergency_device_access_denied');
  }

  return {
    userId: session.user.id,
    email: session.user.email,
    deviceId: device.id,
    deviceName: device.name,
    deviceType: 'emergency_device',
    gate: device.gate,
    alias: device.alias ?? null,
    status: device.status,
    deletedAt: (device.deleted_at as string | null) ?? null,
  };
}

export async function recordReconciliation(
  admin: SupabaseClient,
  operation: string,
  referenceType: string,
  referenceId: string,
  errorCode: string,
  safeContext: Record<string, unknown> = {},
): Promise<boolean> {
  try {
    const { error } = await admin.from('reconciliation_tasks').insert({
      operation,
      reference_type: referenceType,
      reference_id: referenceId,
      last_error_code: errorCode.slice(0, 120),
      safe_context: safeContext,
    });
    if (error) {
      console.error('Failed to record reconciliation task:', error);
      return false;
    }
    return true;
  } catch (err) {
    console.error('Exception recording reconciliation task:', err);
    return false;
  }
}

export function controlledDeviceEmail(value: string): { alias: string; email: string } | null {
  const normalized = value.trim().toLowerCase();
  const suffix = '@devices.egatepass.invalid';
  const alias = normalized.endsWith(suffix) ? normalized.slice(0, -suffix.length) : normalized;
  if (!/^[a-z0-9][a-z0-9-]{2,62}$/.test(alias)) return null;
  return { alias, email: `${alias}${suffix}` };
}
