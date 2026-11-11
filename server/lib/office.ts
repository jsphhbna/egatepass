import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { enforceHumanStaffSessionActivity, getVerifiedSessionContext, HttpError, type StaffActor } from '../actors.js';

export interface OfficeStaffActor extends StaffActor {
  assignedOfficeIds: string[];
}

export function getOfficeTokenSecret(): string {
  const secret = process.env.OFFICE_VISIT_HMAC_SECRET?.trim();
  if (!secret || secret.length < 32) {
    throw new HttpError(503, 'auth_secret_missing_or_insufficient');
  }
  return secret;
}

/**
 * Requires an authenticated staff actor who is either an administrator (admin/superadmin)
 * or an office_staff member assigned to the specified officeId.
 */
export async function requireOfficeStaffActor(
  admin: SupabaseClient,
  token: string,
  targetOfficeId?: string,
): Promise<OfficeStaffActor> {
  const session = await getVerifiedSessionContext(admin, token);

  if (session.isRecoverySession) {
    throw new HttpError(403, 'recovery_session_forbidden');
  }

  if (session.isAnonymous) {
    throw new HttpError(403, 'access_denied');
  }

  if (!session.user.email) {
    throw new HttpError(401, 'invalid_session');
  }

  if (!session.user.email_confirmed_at) {
    throw new HttpError(403, 'email_verification_required');
  }

  const { data: profile, error } = await admin
    .from('staff_profiles')
    .select('role, active, must_change_password, privacy_accepted_at')
    .eq('user_id', session.user.id)
    .maybeSingle();

  if (error) throw error;
  if (!profile?.active || profile.must_change_password || !profile.privacy_accepted_at) {
    throw new HttpError(403, 'access_denied');
  }

  if (!['admin', 'superadmin', 'office_staff'].includes(profile.role)) {
    throw new HttpError(403, 'access_denied');
  }

  await enforceHumanStaffSessionActivity(admin, session.sessionId, session.user.id);

  // Retrieve assigned office IDs
  const { data: assignments, error: assignError } = await admin
    .from('office_staff_assignments')
    .select('office_id')
    .eq('user_id', session.user.id);

  if (assignError) throw assignError;
  const assignedOfficeIds = (assignments || []).map((a) => a.office_id);

  // If a specific office is targeted, check authorization
  if (targetOfficeId && profile.role === 'office_staff') {
    if (!assignedOfficeIds.includes(targetOfficeId)) {
      throw new HttpError(403, 'unauthorized_for_this_office');
    }
  }

  return {
    id: session.user.id,
    email: session.user.email,
    role: profile.role,
    assignedOfficeIds,
  };
}

/**
 * Creates an HMAC-signed token for office staff to view a visitor's portrait.
 * Format: v1.<visitId>.<actorId>.<expiresAt>.<sig>
 */
export function createOfficePortraitToken(visitId: string, actorId: string, ttlSeconds = 600): string {
  const secret = getOfficeTokenSecret();
  const expiresAt = Math.floor(Date.now() / 1000) + ttlSeconds;
  const payload = `office_p.${visitId}.${actorId}.${expiresAt}`;
  const sig = createHmac('sha256', secret).update(payload).digest('hex');
  return `${payload}.${sig}`;
}

export function verifyOfficePortraitToken(token: string, expectedActorId: string): { visitId: string } | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 5 || parts[0] !== 'office_p') return null;
    const [, visitId, actorId, expStr, sig] = parts;
    if (!visitId || !actorId || !expStr || !sig) return null;
    if (actorId !== expectedActorId) return null;

    const expiresAt = parseInt(expStr, 10);
    if (isNaN(expiresAt) || Math.floor(Date.now() / 1000) > expiresAt) return null;

    const secret = getOfficeTokenSecret();
    const payload = `office_p.${visitId}.${actorId}.${expiresAt}`;
    const expectedSig = createHmac('sha256', secret).update(payload).digest('hex');

    if (Buffer.byteLength(sig) !== Buffer.byteLength(expectedSig)) return null;

    if (!timingSafeEqual(Buffer.from(sig), Buffer.from(expectedSig))) return null;

    return { visitId };
  } catch {
    return null;
  }
}

/**
 * Creates an HMAC-signed email verification proof token for specific-person visit request.
 * Format: v_email.<b64urlEmail>.<actorId>.<expiresAt>.<sig>
 */
export function createEmailVerificationProofToken(email: string, actorId: string, ttlSeconds = 3600): string {
  const secret = getOfficeTokenSecret();
  const normalizedEmail = email.trim().toLowerCase();
  const encodedEmail = Buffer.from(normalizedEmail).toString('base64url');
  const expiresAt = Math.floor(Date.now() / 1000) + ttlSeconds;
  const payload = `v_email.${encodedEmail}.${actorId}.${expiresAt}`;
  const sig = createHmac('sha256', secret).update(payload).digest('hex');
  return `${payload}.${sig}`;
}

export function verifyEmailVerificationProofToken(token: string, expectedEmail: string, expectedActorId: string): boolean {
  try {
    const parts = token.split('.');
    if (parts.length !== 5 || parts[0] !== 'v_email') return false;
    const [, encodedEmail, actorId, expStr, sig] = parts;
    if (!encodedEmail || !actorId || !expStr || !sig) return false;

    const email = Buffer.from(encodedEmail, 'base64url').toString('utf-8');
    if (email.toLowerCase() !== expectedEmail.trim().toLowerCase()) return false;
    if (actorId !== expectedActorId) return false;

    const expiresAt = parseInt(expStr, 10);
    if (isNaN(expiresAt) || Math.floor(Date.now() / 1000) > expiresAt) return false;

    const secret = getOfficeTokenSecret();
    const payload = `v_email.${encodedEmail}.${actorId}.${expiresAt}`;
    const expectedSig = createHmac('sha256', secret).update(payload).digest('hex');

    if (Buffer.byteLength(sig) !== Buffer.byteLength(expectedSig)) return false;

    return timingSafeEqual(Buffer.from(sig), Buffer.from(expectedSig));
  } catch {
    return false;
  }
}

export async function assignPassExpectedGate(
  admin: SupabaseClient,
  actorId: string,
  passId: string,
  expectedGate: string,
) {
  const { data, error } = await admin.schema('api').rpc('assign_pass_expected_gate', {
    requested_actor_id: actorId,
    requested_pass_id: passId,
    requested_expected_gate: expectedGate,
    requested_request_id: randomUUID(),
  });

  if (error) {
    const code = (error as { code?: string }).code;
    if (code === 'P0002') {
      throw new HttpError(404, 'pass_not_found');
    }
    if (code === '22023') {
      throw new HttpError(400, error.message || 'invalid_expected_gate');
    }
    if (code === '42501') {
      throw new HttpError(403, error.message || 'access_denied');
    }
    throw error;
  }

  return data;
}
