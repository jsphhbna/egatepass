import type { SupabaseClient, User } from '@supabase/supabase-js';

export type StaffRole = 'guard' | 'admin' | 'superadmin';

export interface StaffActor {
  id: string;
  email: string;
  role: StaffRole;
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
  return { id: session.user.id, email: session.user.email, role: profile.role };
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