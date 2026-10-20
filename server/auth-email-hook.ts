import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  renderSignupConfirmationEmail,
  renderPasswordResetEmail,
  renderStaffInviteEmail,
  renderEmailChangeEmail,
} from './templates/index.js';
import { sendResendEmail } from './email.js';

export type AuthEmailActionType =
  | 'signup'
  | 'recovery'
  | 'invite'
  | 'magiclink'
  | 'email_change'
  | 'reauthentication'
  | 'password_changed_notification'
  | 'email_changed_notification'
  | 'phone_changed_notification'
  | 'identity_linked_notification'
  | 'identity_unlinked_notification'
  | 'mfa_factor_enrolled_notification'
  | 'mfa_factor_unenrolled_notification'
  | 'email';

export interface SupabaseAuthEmailPayload {
  user: {
    id: string;
    email: string;
    new_email?: string;
    user_metadata?: {
      displayName?: string;
      role?: string;
      [key: string]: unknown;
    };
  };
  email_data: {
    token: string;
    token_hash: string;
    token_new?: string;
    token_hash_new?: string;
    redirect_to?: string;
    email_action_type: AuthEmailActionType;
    site_url?: string;
    old_email?: string;
    provider?: string;
    factor_type?: string;
  };
}

/**
 * Verifies standard webhook signatures (Standard Webhooks specification).
 * Signature header format: "v1,signature_base64" or "v1,signature_hex"
 */
export function verifyStandardWebhookSignature(
  rawBody: string,
  headers: Headers | Record<string, string | string[] | undefined>,
  secret: string
): boolean {
  if (!rawBody || !secret) return false;

  const getHeader = (name: string): string | null => {
    if (headers instanceof Headers) return headers.get(name);
    const val = headers[name] ?? headers[name.toLowerCase()];
    return Array.isArray(val) ? val[0] : (val ?? null);
  };

  const msgId = getHeader('webhook-id');
  const timestamp = getHeader('webhook-timestamp');
  const signatureHeader = getHeader('webhook-signature');

  if (!msgId || !timestamp || !signatureHeader) return false;

  // Enforce 5-minute replay tolerance
  const timestampNum = parseInt(timestamp, 10);
  if (isNaN(timestampNum)) return false;
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSeconds - timestampNum) > 300) {
    return false;
  }

  // Parse secret (strip 'whsec_' and decode base64 if present, else utf-8)
  let secretKey: Buffer;
  if (secret.startsWith('whsec_')) {
    secretKey = Buffer.from(secret.slice(6), 'base64');
  } else {
    secretKey = Buffer.from(secret, 'utf-8');
  }

  const toSign = `${msgId}.${timestamp}.${rawBody}`;
  const computedBuffer = createHmac('sha256', secretKey).update(toSign).digest();

  // Signature header can contain multiple signatures separated by space
  const signatures = signatureHeader.split(' ');
  for (const sig of signatures) {
    const parts = sig.split(',');
    if (parts.length !== 2) continue;
    const [version, hashString] = parts;
    if (version !== 'v1') continue;

    // Check base64 or hex
    let receivedBuffer: Buffer;
    try {
      if (/^[0-9a-fA-F]{64}$/.test(hashString)) {
        receivedBuffer = Buffer.from(hashString, 'hex');
      } else {
        receivedBuffer = Buffer.from(hashString, 'base64');
      }
    } catch {
      continue;
    }

    if (receivedBuffer.length === computedBuffer.length && timingSafeEqual(computedBuffer, receivedBuffer)) {
      return true;
    }
  }

  return false;
}

/**
 * Builds the canonical Supabase Auth verification URL based on action type.
 * Authority must always be the Supabase Auth base URL, never the application site URL.
 */
export function buildAuthVerificationUrl(
  authBaseUrl: string,
  tokenHash: string,
  actionType: string,
  redirectTo?: string
): string {
  const baseUrl = (
    process.env.SUPABASE_URL ||
    process.env.VITE_SUPABASE_URL ||
    authBaseUrl ||
    'https://nhoawvkfqblsgutdffie.supabase.co'
  ).replace(/\/+$/, '');

  const params = new URLSearchParams({
    token: tokenHash,
    type: actionType,
  });
  if (redirectTo) {
    params.set('redirect_to', redirectTo);
  }
  return `${baseUrl}/auth/v1/verify?${params.toString()}`;
}

export interface PreparedAuthEmail {
  to: string;
  subject: string;
  html: string;
}

/**
 * Maps Supabase Auth Send Email Hook payload to one or more EARIST React Email templates.
 * When Secure Email Change is enabled, Supabase sends email_action_type = "email_change"
 * with token_hash_new (for current email) and token_hash (for new email: user.new_email).
 */
export async function prepareAuthEmails(
  payload: SupabaseAuthEmailPayload
): Promise<PreparedAuthEmail[]> {
  const { user, email_data } = payload;
  const authBaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || 'https://nhoawvkfqblsgutdffie.supabase.co';
  const redirectTo = email_data.redirect_to || email_data.site_url || 'https://egatepass.tech';
  const displayName = user.user_metadata?.displayName as string | undefined;

  switch (email_data.email_action_type) {
    case 'signup': {
      const confirmationUrl = buildAuthVerificationUrl(authBaseUrl, email_data.token_hash, 'signup', redirectTo);
      const html = await renderSignupConfirmationEmail({
        email: user.email,
        confirmationUrl,
        displayName,
      });
      return [{
        to: user.email,
        subject: 'Confirm your EARIST E-GatePass staff account',
        html,
      }];
    }

    case 'recovery': {
      const resetUrl = buildAuthVerificationUrl(authBaseUrl, email_data.token_hash, 'recovery', redirectTo);
      const html = await renderPasswordResetEmail({
        email: user.email,
        resetUrl,
        displayName,
      });
      return [{
        to: user.email,
        subject: 'Reset your EARIST E-GatePass account password',
        html,
      }];
    }

    case 'invite': {
      const inviteUrl = buildAuthVerificationUrl(authBaseUrl, email_data.token_hash, 'invite', redirectTo);
      const roleName = (user.user_metadata?.role as string) || 'Authorized Staff';
      const html = await renderStaffInviteEmail({
        email: user.email,
        inviteUrl,
        roleName: roleName.toUpperCase(),
        displayName,
      });
      return [{
        to: user.email,
        subject: 'Invitation to join EARIST E-GatePass as staff',
        html,
      }];
    }

    case 'email_change': {
      // Current Supabase Send Email Hook specification:
      // Current email is on: user.email
      // Requested new email is on: user.new_email
      // When Secure Email Change is enabled, both token_hash_new and token_hash are sent:
      // - token_hash_new must be sent to the CURRENT email (user.email)
      // - token_hash must be sent to the NEW email (user.new_email)
      const emails: PreparedAuthEmail[] = [];
      const newEmail = user.new_email || user.email;

      if (email_data.token_hash_new && user.new_email) {
        // 1. Authorize change on current email
        const currentUrl = buildAuthVerificationUrl(authBaseUrl, email_data.token_hash_new, 'email_change', redirectTo);
        const currentHtml = await renderEmailChangeEmail({
          currentEmail: user.email,
          newEmail: user.new_email,
          changeUrl: currentUrl,
          targetAddress: 'current',
          displayName,
        });
        emails.push({
          to: user.email,
          subject: 'Authorize email address change for EARIST E-GatePass',
          html: currentHtml,
        });

        // 2. Verify new email
        const newUrl = buildAuthVerificationUrl(authBaseUrl, email_data.token_hash, 'email_change', redirectTo);
        const newHtml = await renderEmailChangeEmail({
          currentEmail: user.email,
          newEmail: user.new_email,
          changeUrl: newUrl,
          targetAddress: 'new',
          displayName,
        });
        emails.push({
          to: user.new_email,
          subject: 'Verify new email address for EARIST E-GatePass',
          html: newHtml,
        });
      } else {
        // Secure Email Change disabled: single confirmation sent to new email
        const changeUrl = buildAuthVerificationUrl(authBaseUrl, email_data.token_hash, 'email_change', redirectTo);
        const html = await renderEmailChangeEmail({
          currentEmail: user.email,
          newEmail,
          changeUrl,
          targetAddress: 'new',
          displayName,
        });
        emails.push({
          to: newEmail,
          subject: 'Verify new email address for EARIST E-GatePass',
          html,
        });
      }
      return emails;
    }

    case 'magiclink': {
      const magicUrl = buildAuthVerificationUrl(authBaseUrl, email_data.token_hash, 'magiclink', redirectTo);
      const html = await renderSignupConfirmationEmail({
        email: user.email,
        confirmationUrl: magicUrl,
        displayName,
      });
      return [{
        to: user.email,
        subject: 'Your EARIST E-GatePass sign-in link',
        html,
      }];
    }

    case 'reauthentication': {
      const reauthUrl = buildAuthVerificationUrl(authBaseUrl, email_data.token_hash, 'reauthentication', redirectTo);
      const html = await renderPasswordResetEmail({
        email: user.email,
        resetUrl: reauthUrl,
        displayName,
      });
      return [{
        to: user.email,
        subject: 'Confirm your identity for EARIST E-GatePass',
        html,
      }];
    }

    case 'password_changed_notification': {
      return [{
        to: user.email,
        subject: 'Security Alert: Your EARIST E-GatePass password was changed',
        html: `<p>Hello ${displayName || 'Staff'},</p><p>The password for your EARIST E-GatePass staff account (${user.email}) was recently changed.</p><p>If you did not perform this action, please contact your Super Admin immediately to secure your account.</p>`,
      }];
    }

    case 'email_changed_notification': {
      return [{
        to: user.email,
        subject: 'Security Alert: Your EARIST E-GatePass email address was changed',
        html: `<p>Hello ${displayName || 'Staff'},</p><p>The email address associated with your EARIST E-GatePass account was changed.</p><p>If you did not authorize this change, please report this incident immediately to the administrator.</p>`,
      }];
    }

    case 'phone_changed_notification': {
      return [{
        to: user.email,
        subject: 'Security Alert: Phone number updated for EARIST E-GatePass',
        html: `<p>Hello ${displayName || 'Staff'},</p><p>A phone number update was made to your account. If you did not make this change, please contact an administrator.</p>`,
      }];
    }

    case 'mfa_factor_enrolled_notification':
    case 'mfa_factor_unenrolled_notification': {
      const isEnrolled = email_data.email_action_type === 'mfa_factor_enrolled_notification';
      return [{
        to: user.email,
        subject: `Security Alert: Multi-factor authentication ${isEnrolled ? 'enrolled' : 'removed'}`,
        html: `<p>Hello ${displayName || 'Staff'},</p><p>A multi-factor authentication factor was ${isEnrolled ? 'enrolled on' : 'removed from'} your EARIST E-GatePass account. If you did not perform this update, contact an administrator immediately.</p>`,
      }];
    }

    case 'identity_linked_notification':
    case 'identity_unlinked_notification': {
      const isLinked = email_data.email_action_type === 'identity_linked_notification';
      return [{
        to: user.email,
        subject: `Security Alert: External identity ${isLinked ? 'linked' : 'unlinked'}`,
        html: `<p>Hello ${displayName || 'Staff'},</p><p>An identity provider was ${isLinked ? 'linked to' : 'unlinked from'} your EARIST E-GatePass account. If you did not authorize this, contact an administrator immediately.</p>`,
      }];
    }

    case 'email': {
      const verifyUrl = buildAuthVerificationUrl(authBaseUrl, email_data.token_hash, 'email', redirectTo);
      return [{
        to: user.email,
        subject: 'Confirm your EARIST E-GatePass email',
        html: `<p>Hello ${displayName || 'Staff'},</p><p>Please confirm your email by clicking the link below:</p><p><a href="${verifyUrl}">${verifyUrl}</a></p>`,
      }];
    }

    default:
      throw new Error(`unsupported_auth_email_action: ${(email_data as any).email_action_type}`);
  }
}

/**
 * Convenience wrapper returning the primary PreparedAuthEmail.
 */
export async function prepareAuthEmail(
  payload: SupabaseAuthEmailPayload
): Promise<PreparedAuthEmail> {
  const emails = await prepareAuthEmails(payload);
  if (!emails || emails.length === 0) {
    throw new Error('No email could be prepared for the supplied auth payload');
  }
  return emails[0];
}
