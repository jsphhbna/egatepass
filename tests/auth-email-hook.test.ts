import { describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  verifyStandardWebhookSignature,
  buildAuthVerificationUrl,
  prepareAuthEmail,
  type SupabaseAuthEmailPayload,
} from '../server/auth-email-hook.js';
import sendEmailHookHandler from '../api/auth/send-email-hook.js';

describe('EMAIL-01: Supabase Auth Send Email Hook Infrastructure', () => {
  const secret = 'whsec_MfKQ9r8vN5yU7wT3aB2cE1dF4gH6jK8m'; // base64 secret with whsec_ prefix
  const rawSecret = Buffer.from(secret.slice(6), 'base64');

  function makeSignature(msgId: string, timestamp: number, body: string, key = rawSecret): string {
    const toSign = `${msgId}.${timestamp}.${body}`;
    const hash = createHmac('sha256', key).update(toSign).digest('base64');
    return `v1,${hash}`;
  }

  describe('Standard Webhook Signature Verification', () => {
    it('verifies valid signature with whsec_ base64 secret', () => {
      const msgId = 'msg_test_123';
      const timestamp = Math.floor(Date.now() / 1000);
      const body = JSON.stringify({ hello: 'world' });
      const signature = makeSignature(msgId, timestamp, body);

      const headers = new Headers({
        'webhook-id': msgId,
        'webhook-timestamp': timestamp.toString(),
        'webhook-signature': signature,
      });

      const valid = verifyStandardWebhookSignature(body, headers, secret);
      expect(valid).toBe(true);
    });

    it('verifies valid signature with raw utf-8 secret', () => {
      const rawSecretStr = 'my_super_secret_raw_key_12345';
      const msgId = 'msg_raw_456';
      const timestamp = Math.floor(Date.now() / 1000);
      const body = JSON.stringify({ action: 'ping' });
      const toSign = `${msgId}.${timestamp}.${body}`;
      const hash = createHmac('sha256', Buffer.from(rawSecretStr, 'utf-8')).update(toSign).digest('base64');
      const signature = `v1,${hash}`;

      const headers = {
        'webhook-id': msgId,
        'webhook-timestamp': timestamp.toString(),
        'webhook-signature': signature,
      };

      const valid = verifyStandardWebhookSignature(body, headers, rawSecretStr);
      expect(valid).toBe(true);
    });

    it('rejects tampered body', () => {
      const msgId = 'msg_tamper_1';
      const timestamp = Math.floor(Date.now() / 1000);
      const originalBody = JSON.stringify({ user: 'admin' });
      const signature = makeSignature(msgId, timestamp, originalBody);

      const headers = new Headers({
        'webhook-id': msgId,
        'webhook-timestamp': timestamp.toString(),
        'webhook-signature': signature,
      });

      const tamperedBody = JSON.stringify({ user: 'attacker' });
      const valid = verifyStandardWebhookSignature(tamperedBody, headers, secret);
      expect(valid).toBe(false);
    });

    it('rejects expired timestamp beyond 5-minute replay window', () => {
      const msgId = 'msg_expired_1';
      const expiredTimestamp = Math.floor(Date.now() / 1000) - 360; // 6 minutes ago
      const body = JSON.stringify({ test: 'replay' });
      const signature = makeSignature(msgId, expiredTimestamp, body);

      const headers = new Headers({
        'webhook-id': msgId,
        'webhook-timestamp': expiredTimestamp.toString(),
        'webhook-signature': signature,
      });

      const valid = verifyStandardWebhookSignature(body, headers, secret);
      expect(valid).toBe(false);
    });

    it('rejects missing signature headers', () => {
      const body = JSON.stringify({ hello: 'world' });
      expect(verifyStandardWebhookSignature(body, new Headers(), secret)).toBe(false);
    });
  });

  describe('Auth Verification URL Builder', () => {
    it('constructs correct Supabase GoTrue verification link with Supabase origin and app redirect_to', () => {
      const url = buildAuthVerificationUrl('https://nhoawvkfqblsgutdffie.supabase.co', 'sample_token_hash_123', 'signup', 'https://egatepass.tech/login');
      expect(url).toBe('https://nhoawvkfqblsgutdffie.supabase.co/auth/v1/verify?token=sample_token_hash_123&type=signup&redirect_to=https%3A%2F%2Fegatepass.tech%2Flogin');

      const parsed = new URL(url);
      expect(parsed.origin).toBe('https://nhoawvkfqblsgutdffie.supabase.co');
      expect(parsed.pathname).toBe('/auth/v1/verify');
      expect(parsed.searchParams.get('token')).toBe('sample_token_hash_123');
      expect(parsed.searchParams.get('type')).toBe('signup');
      expect(parsed.searchParams.get('redirect_to')).toBe('https://egatepass.tech/login');
    });

    it('asserts origin is Supabase and app domain appears only as redirect_to for all actions', () => {
      const actions = ['signup', 'invite', 'recovery', 'email_change', 'magiclink', 'reauthentication'];
      for (const action of actions) {
        const url = buildAuthVerificationUrl('https://nhoawvkfqblsgutdffie.supabase.co', 'hash_test', action, 'https://egatepass.tech/dest');
        const parsed = new URL(url);
        expect(parsed.origin).toBe('https://nhoawvkfqblsgutdffie.supabase.co');
        expect(parsed.searchParams.get('type')).toBe(action);
        expect(parsed.searchParams.get('redirect_to')).toBe('https://egatepass.tech/dest');
      }
    });
  });

  describe('prepareAuthEmail Template Mapping', () => {
    it('maps signup action to SignupConfirmationEmail with confirmation link', async () => {
      const payload: SupabaseAuthEmailPayload = {
        user: {
          id: 'user-0001',
          email: 'guard.santos@earist.edu.ph',
          user_metadata: { displayName: 'Roberto Santos' },
        },
        email_data: {
          token: '123456',
          token_hash: 'hash_signup_abc',
          email_action_type: 'signup',
          site_url: 'https://egatepass.earist.edu.ph',
          redirect_to: 'https://egatepass.earist.edu.ph/login',
        },
      };

      const prepared = await prepareAuthEmail(payload);
      expect(prepared.to).toBe('guard.santos@earist.edu.ph');
      expect(prepared.subject).toContain('Confirm your EARIST E-GatePass');
      expect(prepared.html).toContain('Roberto Santos');
      expect(prepared.html).toContain('hash_signup_abc');
      expect(prepared.html).toContain('#800000'); // Maroon
    });

    it('maps recovery action to PasswordResetEmail with reset link', async () => {
      const payload: SupabaseAuthEmailPayload = {
        user: {
          id: 'user-0002',
          email: 'admin.reyes@earist.edu.ph',
          user_metadata: { displayName: 'Elena Reyes' },
        },
        email_data: {
          token: '654321',
          token_hash: 'hash_recovery_xyz',
          email_action_type: 'recovery',
          site_url: 'https://egatepass.earist.edu.ph',
          redirect_to: 'https://egatepass.earist.edu.ph/reset-password',
        },
      };

      const prepared = await prepareAuthEmail(payload);
      expect(prepared.to).toBe('admin.reyes@earist.edu.ph');
      expect(prepared.subject).toContain('Reset your EARIST E-GatePass');
      expect(prepared.html).toContain('Elena Reyes');
      expect(prepared.html).toContain('hash_recovery_xyz');
      expect(prepared.html).toContain('Security Advisory');
    });

    it('maps invite action to StaffInviteEmail with role name', async () => {
      const payload: SupabaseAuthEmailPayload = {
        user: {
          id: 'user-0003',
          email: 'newguard@earist.edu.ph',
          user_metadata: { role: 'guard', displayName: 'Pedro Penduko' },
        },
        email_data: {
          token: '999888',
          token_hash: 'hash_invite_111',
          email_action_type: 'invite',
          site_url: 'https://egatepass.earist.edu.ph',
        },
      };

      const prepared = await prepareAuthEmail(payload);
      expect(prepared.to).toBe('newguard@earist.edu.ph');
      expect(prepared.subject).toContain('Invitation to join EARIST E-GatePass');
      expect(prepared.html).toContain('GUARD');
      expect(prepared.html).toContain('hash_invite_111');
    });

    it('maps secure email change: token_hash_new to current email, token_hash to new email', async () => {
      // 1. Notification to current email
      const payloadCurrent: SupabaseAuthEmailPayload = {
        user: {
          id: 'user-0004',
          email: 'old.address@earist.edu.ph',
        },
        email_data: {
          token: '111222',
          token_hash: 'new_address_hash',
          token_hash_new: 'current_address_hash', // Counter-intuitive Supabase naming!
          new_email: 'new.address@earist.edu.ph',
          email_action_type: 'email_change_current',
          site_url: 'https://egatepass.earist.edu.ph',
        },
      };

      const currentEmail = await prepareAuthEmail(payloadCurrent);
      expect(currentEmail.to).toBe('old.address@earist.edu.ph');
      expect(currentEmail.subject).toContain('Authorize email address change');
      expect(currentEmail.html).toContain('current_address_hash'); // Uses token_hash_new!
      expect(currentEmail.html).toContain('new.address@earist.edu.ph');

      // 2. Notification to new email
      const payloadNew: SupabaseAuthEmailPayload = {
        user: {
          id: 'user-0004',
          email: 'old.address@earist.edu.ph',
        },
        email_data: {
          token: '333444',
          token_hash: 'new_address_hash',
          new_email: 'new.address@earist.edu.ph',
          email_action_type: 'email_change_new',
          site_url: 'https://egatepass.earist.edu.ph',
        },
      };

      const newEmail = await prepareAuthEmail(payloadNew);
      expect(newEmail.to).toBe('new.address@earist.edu.ph');
      expect(newEmail.subject).toContain('Verify new email address');
      expect(newEmail.html).toContain('new_address_hash'); // Uses token_hash!
    });

    it('handles current Supabase email_change action with Secure Email Change enabled (2 emails)', async () => {
      const payload: SupabaseAuthEmailPayload = {
        user: {
          id: 'user-0005',
          email: 'current.staff@earist.edu.ph',
          user_metadata: { displayName: 'Staff Member' },
        },
        email_data: {
          token: '555666',
          token_hash: 'hash_for_new_email',
          token_hash_new: 'hash_for_current_email',
          new_email: 'updated.staff@earist.edu.ph',
          email_action_type: 'email_change',
          site_url: 'https://egatepass.tech',
        },
      };

      const { prepareAuthEmails } = await import('../server/auth-email-hook.js');
      const emails = await prepareAuthEmails(payload);
      expect(emails.length).toBe(2);

      // 1. Current address confirmation email uses token_hash_new
      const currentEmail = emails.find(e => e.to === 'current.staff@earist.edu.ph');
      expect(currentEmail).toBeDefined();
      expect(currentEmail!.subject).toContain('Authorize email address change');
      expect(currentEmail!.html).toContain('hash_for_current_email');

      // 2. New address verification email uses token_hash
      const newEmail = emails.find(e => e.to === 'updated.staff@earist.edu.ph');
      expect(newEmail).toBeDefined();
      expect(newEmail!.subject).toContain('Verify new email address');
      expect(newEmail!.html).toContain('hash_for_new_email');
    });

    it('handles current Supabase email_change action with Secure Email Change disabled (1 email)', async () => {
      const payload: SupabaseAuthEmailPayload = {
        user: {
          id: 'user-0006',
          email: 'current.staff@earist.edu.ph',
          user_metadata: { displayName: 'Staff Member' },
        },
        email_data: {
          token: '777888',
          token_hash: 'single_hash_for_change',
          new_email: 'new.staff@earist.edu.ph',
          email_action_type: 'email_change',
          site_url: 'https://egatepass.tech',
        },
      };

      const { prepareAuthEmails } = await import('../server/auth-email-hook.js');
      const emails = await prepareAuthEmails(payload);
      expect(emails.length).toBe(1);
      expect(emails[0].to).toBe('new.staff@earist.edu.ph');
      expect(emails[0].html).toContain('single_hash_for_change');
    });

    it('handles magiclink and reauthentication actions', async () => {
      const { prepareAuthEmails } = await import('../server/auth-email-hook.js');

      const magicPayload: SupabaseAuthEmailPayload = {
        user: { id: 'user-magic', email: 'magic@earist.edu.ph' },
        email_data: { token: '11', token_hash: 'hash_magic', email_action_type: 'magiclink' },
      };
      const magicEmails = await prepareAuthEmails(magicPayload);
      expect(magicEmails[0].to).toBe('magic@earist.edu.ph');
      expect(magicEmails[0].subject).toContain('sign-in link');

      const reauthPayload: SupabaseAuthEmailPayload = {
        user: { id: 'user-reauth', email: 'reauth@earist.edu.ph' },
        email_data: { token: '22', token_hash: 'hash_reauth', email_action_type: 'reauthentication' },
      };
      const reauthEmails = await prepareAuthEmails(reauthPayload);
      expect(reauthEmails[0].to).toBe('reauth@earist.edu.ph');
      expect(reauthEmails[0].subject).toContain('identity');
    });
  });

  describe('API Web Handler: /api/auth/send-email-hook', () => {
    it('returns 405 for non-POST requests', async () => {
      const req = new Request('http://localhost:5173/api/auth/send-email-hook', { method: 'GET' });
      const res = await sendEmailHookHandler.fetch(req);
      expect(res.status).toBe(405);
    });

    it('returns 503 if SEND_EMAIL_HOOK_SECRET is unconfigured', async () => {
      const origSecret = process.env.SEND_EMAIL_HOOK_SECRET;
      delete process.env.SEND_EMAIL_HOOK_SECRET;

      const req = new Request('http://localhost:5173/api/auth/send-email-hook', {
        method: 'POST',
        body: JSON.stringify({ test: 'data' }),
      });
      const res = await sendEmailHookHandler.fetch(req);
      expect(res.status).toBe(503);

      if (origSecret) process.env.SEND_EMAIL_HOOK_SECRET = origSecret;
    });

    it('returns 401 if signature is invalid or tampered', async () => {
      process.env.SEND_EMAIL_HOOK_SECRET = secret;

      const body = JSON.stringify({ user: { email: 'test@earist.edu.ph' } });
      const req = new Request('http://localhost:5173/api/auth/send-email-hook', {
        method: 'POST',
        headers: {
          'webhook-id': 'msg_test',
          'webhook-timestamp': Math.floor(Date.now() / 1000).toString(),
          'webhook-signature': 'v1,invalid_signature_hash',
        },
        body,
      });

      const res = await sendEmailHookHandler.fetch(req);
      expect(res.status).toBe(401);
      const data = await res.json();
      expect(data.error).toBe('invalid_webhook_signature');
    });

    it('returns 200 with empty object for valid signed payload', async () => {
      process.env.SEND_EMAIL_HOOK_SECRET = secret;
      const prevResend = process.env.RESEND_API_KEY;
      delete process.env.RESEND_API_KEY; // Run in dry-run mode

      const msgId = 'msg_valid_hook_1';
      const timestamp = Math.floor(Date.now() / 1000);
      const payload: SupabaseAuthEmailPayload = {
        user: {
          id: 'user-hook-1',
          email: 'staff.hook@earist.edu.ph',
          user_metadata: { displayName: 'Staff Hook' },
        },
        email_data: {
          token: '123456',
          token_hash: 'hash_test_123',
          email_action_type: 'signup',
          site_url: 'https://egatepass.earist.edu.ph',
        },
      };
      const rawBody = JSON.stringify(payload);
      const signature = makeSignature(msgId, timestamp, rawBody);

      const req = new Request('http://localhost:5173/api/auth/send-email-hook', {
        method: 'POST',
        headers: {
          'webhook-id': msgId,
          'webhook-timestamp': timestamp.toString(),
          'webhook-signature': signature,
        },
        body: rawBody,
      });

      const res = await sendEmailHookHandler.fetch(req);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json).toEqual({});

      if (prevResend) process.env.RESEND_API_KEY = prevResend;
    });

    it('returns 503 if RESEND_API_KEY is missing in production environment (REPAIR 6C)', async () => {
      process.env.SEND_EMAIL_HOOK_SECRET = secret;
      const prevResend = process.env.RESEND_API_KEY;
      const prevEnv = process.env.NODE_ENV;
      delete process.env.RESEND_API_KEY;
      process.env.NODE_ENV = 'production';

      const msgId = 'msg_valid_hook_prod_1';
      const timestamp = Math.floor(Date.now() / 1000);
      const payload: SupabaseAuthEmailPayload = {
        user: { id: 'user-hook-2', email: 'prod@earist.edu.ph' },
        email_data: { token: '111', token_hash: 'hash', email_action_type: 'signup' },
      };
      const rawBody = JSON.stringify(payload);
      const signature = makeSignature(msgId, timestamp, rawBody);

      const req = new Request('http://localhost:5173/api/auth/send-email-hook', {
        method: 'POST',
        headers: {
          'webhook-id': msgId,
          'webhook-timestamp': timestamp.toString(),
          'webhook-signature': signature,
        },
        body: rawBody,
      });

      const res = await sendEmailHookHandler.fetch(req);
      expect(res.status).toBe(503);
      const json = await res.json();
      expect(json.error).toBe('provider_unconfigured');

      process.env.NODE_ENV = prevEnv;
      if (prevResend) process.env.RESEND_API_KEY = prevResend;
    });
  });
});
