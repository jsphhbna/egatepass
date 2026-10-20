import type { SupabaseClient } from '@supabase/supabase-js';

export type StaffRole = 'guard' | 'admin' | 'superadmin';

export interface StaffActor {
  id: string;
  email: string;
  role: StaffRole;
}

export class HttpError extends Error {
  constructor(public readonly status: number, public readonly code: string) {
    super(code);
  }
}

export async function requireStaffActor(
  admin: SupabaseClient,
  token: string,
  allowed: StaffRole[],
): Promise<StaffActor> {
  const { data: identity, error: authError } = await admin.auth.getUser(token);
  if (authError || !identity.user?.email) throw new HttpError(401, 'invalid_session');
  if (!identity.user.email_confirmed_at) {
    throw new HttpError(403, 'email_verification_required');
  }
  const { data: profile, error } = await admin.from('staff_profiles')
    .select('role, active, must_change_password, privacy_accepted_at')
    .eq('user_id', identity.user.id).maybeSingle();
  if (error) throw error;
  if (!profile?.active || profile.must_change_password || !profile.privacy_accepted_at || !allowed.includes(profile.role)) {
    throw new HttpError(403, 'access_denied');
  }
  return { id: identity.user.id, email: identity.user.email, role: profile.role };
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
