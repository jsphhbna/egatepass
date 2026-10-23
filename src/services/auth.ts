import { supabase, requireRecoverySupabase } from '@/lib/supabase';

export async function getAccessToken(): Promise<string> {
  if (!supabase) throw new Error('E-GatePass services are unavailable.');
  const { data, error } = await supabase.auth.getSession();
  if (error || !data.session?.access_token) throw new Error('Your session has expired. Please sign in again.');
  return data.session.access_token;
}

export async function signOutCurrentActor(): Promise<void> {
  if (!supabase) return;
  const { error } = await supabase.auth.signOut();
  if (error) throw error;
}

export async function sendPasswordReset(email: string, captchaToken?: string): Promise<void> {
  const recoveryClient = requireRecoverySupabase();
  const { error } = await recoveryClient.auth.resetPasswordForEmail(email, {
    redirectTo: `${window.location.origin}/reset-password`,
    captchaToken,
  });
  if (error) throw error;
}

export async function completeStaffPasswordChange(currentPassword: string, newPassword: string): Promise<void> {
  const token = await getAccessToken();
  const response = await fetch('/api/auth/complete-password-change', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ currentPassword, newPassword }),
  });

  if (response.ok) return;
  const payload = await response.json().catch(() => ({})) as { error?: string };
  if (payload.error === 'invalid_current_password') throw new Error('Incorrect current password.');
  if (payload.error === 'password_changed_finalization_pending') {
    throw new Error('Your password changed, but account activation is still pending. Retry using the new password or contact an administrator.');
  }
  throw new Error('Password update could not be completed. Please try again.');
}

export interface ResetPasswordResponse {
  ok: boolean;
  result: 'success' | 'partial';
  passwordChanged: boolean;
  auditPending?: boolean;
  reconciliationRecorded?: boolean;
}

export async function resetPasswordWithRecoverySession(recoveryToken: string, newPassword: string): Promise<ResetPasswordResponse> {
  const response = await fetch('/api/auth/reset-password', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${recoveryToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ newPassword }),
  });

  const payload = await response.json().catch(() => ({})) as ResetPasswordResponse & { error?: string };

  if (response.ok) {
    return payload;
  }

  if (payload.error === 'recovery_session_required') {
    throw new Error('This password reset link is invalid or has expired. Please request a new link.');
  }
  if (payload.error === 'device_password_change_forbidden') {
    throw new Error('Device credentials are Super Admin managed and cannot be changed here.');
  }
  if (payload.error === 'anonymous_recovery_not_allowed') {
    throw new Error('Guest accounts cannot reset passwords.');
  }
  throw new Error('Password could not be updated. Please request a new reset link.');
}
export const completeGuardPasswordChange = completeStaffPasswordChange;

export function evaluateAuthTurnstilePolicy(
  isProd: boolean,
  siteKey?: string | null,
  captchaToken?: string | null,
): { allowed: boolean; error?: string } {
  if (isProd) {
    if (!siteKey || siteKey.trim() === '') {
      return {
        allowed: false,
        error: 'Authentication is temporarily unavailable due to missing security configuration.',
      };
    }
    if (!captchaToken || captchaToken.trim() === '') {
      return {
        allowed: false,
        error: 'Please complete the security challenge before continuing.',
      };
    }
  }
  return { allowed: true };
}
