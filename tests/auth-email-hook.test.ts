import { describe, expect, it, vi } from 'vitest';
import { Webhook } from 'standardwebhooks';
import {
  verifyStandardWebhookSignature,
  buildAuthVerificationUrl,
  prepareAuthEmail,
  prepareAuthEmails,
  type SupabaseAuthEmailPayload,
} from '../server/auth-email-hook.js';
import sendEmailHookHandler from '../server/routes/auth/send-email-hook.js';

describe('EMAIL-01: Supabase Auth Send Email Hook Infrastructure', () => {
  const base64KeyA = 'MfKQ9r8vN5yU7wT3aB2cE1dF4gH6jK8m';
  const canonicalSecretA = `v1,whsec_${base64KeyA}`;
  const webhookA = new Webhook(base64KeyA);

  const base64KeyB = 'X1y2Z3a4B5c6D7e8F9g0H1i2J3k4L5m6';
  const canonicalSecretB = `v1,whsec_${base64KeyB}`;
  const webhookB = new Webhook(base64KeyB);

  const base64KeyUnrelated = '99999999999999999999999999999999';
  const webhookUnrelated = new Webhook(base64KeyUnrelated);

  function makeSignature(msgId: string, timestamp: number, body: string, wh = webhookA): string {
    return wh.sign(msgId, new Date(timestamp * 1000), body);
  }

  describe('Standard Webhook Signature Verification (Canonical & Rotation)', () => {
    it('A1 canonical Supabase secret verifies', () => {
      const msgId = 'msg_test_123';
      const timestamp = Math.floor(Date.now() / 1000);
      const body = JSON.stringify({ hello: 'world' });
      const signature = makeSignature(msgId, timestamp, body, webhookA);

      const headers = new Headers({
        'webhook-id': msgId,
        'webhook-timestamp': timestamp.toString(),
        'webhook-signature': signature,
      });

      const valid = verifyStandardWebhookSignature(body, headers, canonicalSecretA);
      expect(valid).toBe(true);
    });

    it('A2 tampered body fails', () => {
      const msgId = 'msg_tamper_1';
      const timestamp = Math.floor(Date.now() / 1000);
      const originalBody = JSON.stringify({ user: 'admin' });
      const signature = makeSignature(msgId, timestamp, originalBody, webhookA);

      const headers = new Headers({
        'webhook-id': msgId,
        'webhook-timestamp': timestamp.toString(),
        'webhook-signature': signature,
      });

      const tamperedBody = JSON.stringify({ user: 'attacker' });
      const valid = verifyStandardWebhookSignature(tamperedBody, headers, canonicalSecretA);
      expect(valid).toBe(false);
    });

    it('A3 invalid signature fails', () => {
      const msgId = 'msg_invalid_sig';
      const timestamp = Math.floor(Date.now() / 1000);
      const body = JSON.stringify({ action: 'ping' });

      const headers = new Headers({
        'webhook-id': msgId,
        'webhook-timestamp': timestamp.toString(),
        'webhook-signature': 'v1,invalid_signature_hash_here',
      });

      const valid = verifyStandardWebhookSignature(body, headers, canonicalSecretA);
      expect(valid).toBe(false);
    });

    it('A4 stale timestamp fails', () => {
      const msgId = 'msg_expired_1';
      const expiredTimestamp = Math.floor(Date.now() / 1000) - 360; // 6 minutes ago (>300s)
      const body = JSON.stringify({ test: 'replay' });
      const signature = makeSignature(msgId, expiredTimestamp, body, webhookA);

      const headers = new Headers({
        'webhook-id': msgId,
        'webhook-timestamp': expiredTimestamp.toString(),
        'webhook-signature': signature,
      });

      const valid = verifyStandardWebhookSignature(body, headers, canonicalSecretA);
      expect(valid).toBe(false);
    });

    it('A5 missing headers fail', () => {
      const body = JSON.stringify({ hello: 'world' });
      expect(verifyStandardWebhookSignature(body, new Headers(), canonicalSecretA)).toBe(false);

      const missingSigHeaders = new Headers({
        'webhook-id': 'msg_1',
        'webhook-timestamp': Math.floor(Date.now() / 1000).toString(),
      });
      expect(verifyStandardWebhookSignature(body, missingSigHeaders, canonicalSecretA)).toBe(false);
    });

    it('A6 malformed secret fails', () => {
      const msgId = 'msg_malformed_secret';
      const timestamp = Math.floor(Date.now() / 1000);
      const body = JSON.stringify({ hello: 'world' });
      const signature = makeSignature(msgId, timestamp, body, webhookA);
      const headers = new Headers({
        'webhook-id': msgId,
        'webhook-timestamp': timestamp.toString(),
        'webhook-signature': signature,
      });

      // Non-canonical formats must fail
      expect(verifyStandardWebhookSignature(body, headers, 'whsec_oldlegacyformat')).toBe(false);
      expect(verifyStandardWebhookSignature(body, headers, 'raw_secret_without_prefix')).toBe(false);
      expect(verifyStandardWebhookSignature(body, headers, '')).toBe(false);
      expect(verifyStandardWebhookSignature(body, headers, 'v1,whsec_')).toBe(false);
    });

    it('A7 first key in rotation list verifies', () => {
      const rotationSecret = `${canonicalSecretA}|${canonicalSecretB}`;
      const msgId = 'msg_rotation_1';
      const timestamp = Math.floor(Date.now() / 1000);
      const body = JSON.stringify({ rotation: 'first' });
      const signature = makeSignature(msgId, timestamp, body, webhookA);

      const headers = {
        'webhook-id': msgId,
        'webhook-timestamp': timestamp.toString(),
        'webhook-signature': signature,
      };

      const valid = verifyStandardWebhookSignature(body, headers, rotationSecret);
      expect(valid).toBe(true);
    });

    it('A8 second key in rotation list verifies', () => {
      const rotationSecret = `${canonicalSecretA}|${canonicalSecretB}`;
      const msgId = 'msg_rotation_2';
      const timestamp = Math.floor(Date.now() / 1000);
      const body = JSON.stringify({ rotation: 'second' });
      const signature = makeSignature(msgId, timestamp, body, webhookB);

      const headers = {
        'webhook-id': msgId,
        'webhook-timestamp': timestamp.toString(),
        'webhook-signature': signature,
      };

      const valid = verifyStandardWebhookSignature(body, headers, rotationSecret);
      expect(valid).toBe(true);
    });

    it('A9 unrelated key fails', () => {
      const rotationSecret = `${canonicalSecretA}|${canonicalSecretB}`;
      const msgId = 'msg_unrelated';
      const timestamp = Math.floor(Date.now() / 1000);
      const body = JSON.stringify({ test: 'unrelated' });
      const signature = makeSignature(msgId, timestamp, body, webhookUnrelated);

      const headers = {
        'webhook-id': msgId,
        'webhook-timestamp': timestamp.toString(),
        'webhook-signature': signature,
      };

      const valid = verifyStandardWebhookSignature(body, headers, rotationSecret);
      expect(valid).toBe(false);
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

    it('handles current Supabase email_change action with Secure Email Change enabled (2 emails: user.new_email & user.email)', async () => {
      const payload: SupabaseAuthEmailPayload = {
        user: {
          id: 'user-0005',
          email: 'current.staff@earist.edu.ph',
          new_email: 'updated.staff@earist.edu.ph',
          user_metadata: { displayName: 'Staff Member' },
        },
        email_data: {
          token: '555666',
          token_hash: 'hash_for_new_email',
          token_hash_new: 'hash_for_current_email',
          email_action_type: 'email_change',
          site_url: 'https://egatepass.tech',
        },
      };

      const { prepareAuthEmails } = await import('../server/auth-email-hook.js');
      const emails = await prepareAuthEmails(payload);
      expect(emails.length).toBe(2);

      // 1. Current address confirmation email uses token_hash_new
      const currentEmail = emails.find((e) => e.to === 'current.staff@earist.edu.ph');
      expect(currentEmail).toBeDefined();
      expect(currentEmail!.subject).toContain('Authorize email address change');
      expect(currentEmail!.html).toContain('hash_for_current_email');

      // 2. New address verification email uses token_hash
      const newEmail = emails.find((e) => e.to === 'updated.staff@earist.edu.ph');
      expect(newEmail).toBeDefined();
      expect(newEmail!.subject).toContain('Verify new email address');
      expect(newEmail!.html).toContain('hash_for_new_email');
    });

    it('handles current Supabase email_change action with Secure Email Change disabled (1 email to user.new_email)', async () => {
      const payload: SupabaseAuthEmailPayload = {
        user: {
          id: 'user-0006',
          email: 'current.staff@earist.edu.ph',
          new_email: 'new.staff@earist.edu.ph',
          user_metadata: { displayName: 'Staff Member' },
        },
        email_data: {
          token: '777888',
          token_hash: 'single_hash_for_change',
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

    it('handles security-notification action types without throwing 500 error', async () => {
      const { prepareAuthEmails } = await import('../server/auth-email-hook.js');

      const securityActions: Array<SupabaseAuthEmailPayload['email_data']['email_action_type']> = [
        'password_changed_notification',
        'email_changed_notification',
        'phone_changed_notification',
        'identity_linked_notification',
        'identity_unlinked_notification',
        'mfa_factor_enrolled_notification',
        'mfa_factor_unenrolled_notification',
        'email',
      ];

      for (const actionType of securityActions) {
        const payload: SupabaseAuthEmailPayload = {
          user: { id: `user-${actionType}`, email: 'security.target@earist.edu.ph', user_metadata: { displayName: 'Alert User' } },
          email_data: {
            token: '123',
            token_hash: 'hash_alert',
            email_action_type: actionType,
            site_url: 'https://egatepass.tech',
          },
        };

        const emails = await prepareAuthEmails(payload);
        expect(emails.length).toBeGreaterThan(0);
        expect(emails[0].to).toBe('security.target@earist.edu.ph');
      }
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

    it('A11 API endpoint missing hook secret returns 503', async () => {
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
      process.env.SEND_EMAIL_HOOK_SECRET = canonicalSecretA;

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

    it('A10 API endpoint accepts canonical signed payload', async () => {
      process.env.SEND_EMAIL_HOOK_SECRET = canonicalSecretA;
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
      process.env.SEND_EMAIL_HOOK_SECRET = canonicalSecretA;
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
