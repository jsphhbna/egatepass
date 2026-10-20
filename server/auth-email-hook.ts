import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  renderSignupConfirmationEmail,
  renderPasswordResetEmail,
  renderStaffInviteEmail,
  renderEmailChangeEmail,
} from './templates/index.js';
import { sendResendEmail } from './email.js';

export interface SupabaseAuthEmailPayload {
  user: {
    id: string;
    email: string;
    user_metadata?: {
      displayName?: string;
      role?: string;
      [key: string]: unknown;
    };
  };
  email_data: {
    token: string;
    token_hash: string;
    redirect_to?: string;
    email_action_type: 'signup' | 'recovery' | 'invite' | 'magiclink' | 'email_change_current' | 'email_change_new' | 'reauthentication';
    site_url?: string;
    token_hash_new?: string;
    new_email?: string;
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
 */
export function buildAuthVerificationUrl(
  siteUrl: string,
  tokenHash: string,
  actionType: string,
  redirectTo?: string
): string {
  const baseUrl = (siteUrl || 'https://egatepass.earist.edu.ph').replace(/\/+$/, '');
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
 * Maps Supabase Auth Send Email Hook payload to an EARIST React Email template.
 */
export async function prepareAuthEmail(
  payload: SupabaseAuthEmailPayload
): Promise<PreparedAuthEmail> {
  const { user, email_data } = payload;
  const siteUrl = email_data.site_url || process.env.VITE_SUPABASE_URL || 'https://egatepass.earist.edu.ph';
  const redirectTo = email_data.redirect_to;
  const displayName = user.user_metadata?.displayName as string | undefined;

  switch (email_data.email_action_type) {
    case 'signup': {
      const confirmationUrl = buildAuthVerificationUrl(siteUrl, email_data.token_hash, 'signup', redirectTo);
      const html = await renderSignupConfirmationEmail({
        email: user.email,
        confirmationUrl,
        displayName,
      });
      return {
        to: user.email,
        subject: 'Confirm your EARIST E-GatePass staff account',
        html,
      };
    }

    case 'recovery': {
      const resetUrl = buildAuthVerificationUrl(siteUrl, email_data.token_hash, 'recovery', redirectTo);
      const html = await renderPasswordResetEmail({
        email: user.email,
        resetUrl,
        displayName,
      });
      return {
        to: user.email,
        subject: 'Reset your EARIST E-GatePass account password',
        html,
      };
    }

    case 'invite': {
      const inviteUrl = buildAuthVerificationUrl(siteUrl, email_data.token_hash, 'invite', redirectTo);
      const roleName = (user.user_metadata?.role as string) || 'Authorized Staff';
      const html = await renderStaffInviteEmail({
        email: user.email,
        inviteUrl,
        roleName: roleName.toUpperCase(),
        displayName,
      });
      return {
        to: user.email,
        subject: 'Invitation to join EARIST E-GatePass as staff',
        html,
      };
    }

    case 'email_change_current': {
      // Under secure change, Supabase counterintuitively assigns token_hash_new to the current email!
      const currentHash = email_data.token_hash_new || email_data.token_hash;
      const changeUrl = buildAuthVerificationUrl(siteUrl, currentHash, 'email_change', redirectTo);
      const newEmail = email_data.new_email || 'the requested address';
      const html = await renderEmailChangeEmail({
        currentEmail: user.email,
        newEmail,
        changeUrl,
        targetAddress: 'current',
        displayName,
      });
      return {
        to: user.email,
        subject: 'Authorize email address change for EARIST E-GatePass',
        html,
      };
    }

    case 'email_change_new': {
      // And token_hash to the new email!
      const newHash = email_data.token_hash;
      const changeUrl = buildAuthVerificationUrl(siteUrl, newHash, 'email_change', redirectTo);
      const targetEmail = email_data.new_email || user.email;
      const html = await renderEmailChangeEmail({
        currentEmail: user.email,
        newEmail: targetEmail,
        changeUrl,
        targetAddress: 'new',
        displayName,
      });
      return {
        to: targetEmail,
        subject: 'Verify new email address for EARIST E-GatePass',
        html,
      };
    }

    default:
      throw new Error(`unsupported_auth_email_action: ${email_data.email_action_type}`);
  }
}
