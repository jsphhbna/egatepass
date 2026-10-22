import { Webhook } from 'standardwebhooks';
import {
  renderSignupConfirmationEmail,
  renderPasswordResetEmail,
  renderStaffInviteEmail,
  renderEmailChangeEmail,
  renderMagicLinkEmail,
  renderReauthenticationEmail,
  renderSecurityNotificationEmail,
} from './templates/index.js';

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
 * Verifies standard webhook signatures (Standard Webhooks specification) using the official standardwebhooks package.
 * Secret format: canonical "v1,whsec_<base64>" or rotation format "v1,whsec_<new>|v1,whsec_<old>".
 */
export function verifyStandardWebhookSignature(
  rawBody: string,
  headers: Headers | Record<string, string | string[] | undefined>,
  secret: string
): boolean {
  if (!rawBody || !secret || typeof rawBody !== 'string' || typeof secret !== 'string') {
    return false;
  }

  const normalizedHeaders: Record<string, string> = {};
  if (headers instanceof Headers) {
    const id = headers.get('webhook-id');
    const ts = headers.get('webhook-timestamp');
    const sig = headers.get('webhook-signature');
    if (!id || !ts || !sig) return false;
    normalizedHeaders['webhook-id'] = id;
    normalizedHeaders['webhook-timestamp'] = ts;
    normalizedHeaders['webhook-signature'] = sig;
  } else if (headers && typeof headers === 'object') {
    const getVal = (name: string): string | null => {
      const val = headers[name] ?? headers[name.toLowerCase()];
      return Array.isArray(val) ? (val[0] ?? null) : (val ?? null);
    };
    const id = getVal('webhook-id');
    const ts = getVal('webhook-timestamp');
    const sig = getVal('webhook-signature');
    if (!id || !ts || !sig) return false;
    normalizedHeaders['webhook-id'] = id;
    normalizedHeaders['webhook-timestamp'] = ts;
    normalizedHeaders['webhook-signature'] = sig;
  } else {
    return false;
  }

  const candidates = secret.split('|').map((s) => s.trim()).filter(Boolean);
  if (candidates.length === 0) return false;

  for (const candidate of candidates) {
    if (!candidate.startsWith('v1,whsec_')) {
      continue;
    }
    const base64Secret = candidate.slice('v1,whsec_'.length);
    if (!base64Secret) continue;

    try {
      const wh = new Webhook(base64Secret);
      wh.verify(rawBody, normalizedHeaders, { jsonParse: false });
      return true;
    } catch {
      // Rotation candidate did not validate; try next candidate
      continue;
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
  const rawDisplayName = user?.user_metadata?.displayName;
  const displayName =
    typeof rawDisplayName === 'string' && rawDisplayName.trim().length > 0
      ? rawDisplayName.trim()
      : undefined;

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
      const html = await renderStaffInviteEmail({
        email: user.email,
        inviteUrl,
        displayName,
      });
      return [{
        to: user.email,
        subject: 'EARIST E-GatePass Account Invitation',
        html,
      }];
    }

    case 'email_change': {
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
      const html = await renderMagicLinkEmail({
        email: user.email,
        magicUrl,
        displayName,
      });
      return [{
        to: user.email,
        subject: 'Sign in to EARIST E-GatePass',
        html,
      }];
    }

    case 'reauthentication': {
      const reauthUrl = buildAuthVerificationUrl(authBaseUrl, email_data.token_hash, 'reauthentication', redirectTo);
      const html = await renderReauthenticationEmail({
        email: user.email,
        reauthUrl,
        displayName,
      });
      return [{
        to: user.email,
        subject: 'Confirm your identity for EARIST E-GatePass',
        html,
      }];
    }

    case 'password_changed_notification': {
      const html = await renderSecurityNotificationEmail({
        email: user.email,
        actionType: 'password_changed_notification',
        displayName,
      });
      return [{
        to: user.email,
        subject: 'Security Alert: Your EARIST E-GatePass password was changed',
        html,
      }];
    }

    case 'email_changed_notification': {
      const html = await renderSecurityNotificationEmail({
        email: user.email,
        actionType: 'email_changed_notification',
        displayName,
      });
      return [{
        to: user.email,
        subject: 'Security Alert: Your EARIST E-GatePass email address was changed',
        html,
      }];
    }

    case 'phone_changed_notification': {
      const html = await renderSecurityNotificationEmail({
        email: user.email,
        actionType: 'phone_changed_notification',
        displayName,
      });
      return [{
        to: user.email,
        subject: 'Security Alert: Phone number updated for EARIST E-GatePass',
        html,
      }];
    }

    case 'mfa_factor_enrolled_notification': {
      const html = await renderSecurityNotificationEmail({
        email: user.email,
        actionType: 'mfa_factor_enrolled_notification',
        displayName,
      });
      return [{
        to: user.email,
        subject: 'Security Alert: Multi-factor authentication enrolled',
        html,
      }];
    }

    case 'mfa_factor_unenrolled_notification': {
      const html = await renderSecurityNotificationEmail({
        email: user.email,
        actionType: 'mfa_factor_unenrolled_notification',
        displayName,
      });
      return [{
        to: user.email,
        subject: 'Security Alert: Multi-factor authentication removed',
        html,
      }];
    }

    case 'identity_linked_notification': {
      const html = await renderSecurityNotificationEmail({
        email: user.email,
        actionType: 'identity_linked_notification',
        displayName,
      });
      return [{
        to: user.email,
        subject: 'Security Alert: External identity linked',
        html,
      }];
    }

    case 'identity_unlinked_notification': {
      const html = await renderSecurityNotificationEmail({
        email: user.email,
        actionType: 'identity_unlinked_notification',
        displayName,
      });
      return [{
        to: user.email,
        subject: 'Security Alert: External identity unlinked',
        html,
      }];
    }

    case 'email': {
      const verifyUrl = buildAuthVerificationUrl(authBaseUrl, email_data.token_hash, 'email', redirectTo);
      const html = await renderSecurityNotificationEmail({
        email: user.email,
        actionType: 'email',
        displayName,
        actionUrl: verifyUrl,
      });
      return [{
        to: user.email,
        subject: 'Confirm your EARIST E-GatePass email',
        html,
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
  const first = emails[0];
  if (!first) throw new Error('No email could be prepared');
  return first;
}
