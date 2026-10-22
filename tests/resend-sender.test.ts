import { describe, expect, it, vi } from 'vitest';
import {
  validateSenderEmail,
  sendResendEmail,
  EmailDeliveryError,
  setEmailSenderForTest,
} from '../server/email.js';

describe('FIX GROUP I: Resend Sender Configuration Hardening', () => {
  describe('validateSenderEmail', () => {
    it('accepts valid formatted sender with display name and angle brackets', () => {
      const res = validateSenderEmail('EARIST E-GatePass <notifications@egatepass.tech>', true);
      expect(res.valid).toBe(true);
      expect(res.email).toBe('EARIST E-GatePass <notifications@egatepass.tech>');
      expect(res.error).toBeUndefined();
    });

    it('accepts valid raw email address as sender', () => {
      const res = validateSenderEmail('notifications@egatepass.tech', true);
      expect(res.valid).toBe(true);
      expect(res.email).toBe('notifications@egatepass.tech');
    });

    it('rejects API key accidentally passed as sender (re_...)', () => {
      const res = validateSenderEmail('re_1234567890abcdef', true);
      expect(res.valid).toBe(false);
      expect(res.error).toBe('email_sender_invalid');
    });

    it('rejects malformed sender strings', () => {
      expect(validateSenderEmail('not-an-email', true).valid).toBe(false);
      expect(validateSenderEmail('<>', true).valid).toBe(false);
      expect(validateSenderEmail('Name <>', true).valid).toBe(false);
      expect(validateSenderEmail('foo@bar', true).valid).toBe(false);
    });

    it('fails closed in production when sender is missing or empty', () => {
      expect(validateSenderEmail(undefined, true)).toEqual({
        valid: false,
        error: 'email_sender_unconfigured',
      });
      expect(validateSenderEmail('', true)).toEqual({
        valid: false,
        error: 'email_sender_unconfigured',
      });
      expect(validateSenderEmail('   ', true)).toEqual({
        valid: false,
        error: 'email_sender_unconfigured',
      });
    });

    it('allows onboarding fallback only in non-production environments', () => {
      const res = validateSenderEmail(undefined, false);
      expect(res.valid).toBe(true);
      expect(res.email).toBe('EARIST E-GatePass <onboarding@resend.dev>');
    });
  });

  describe('sendResendEmail pre-flight sender enforcement', () => {
    it('rejects re_... sender before contacting Resend API', async () => {
      setEmailSenderForTest(null); // Ensure real logic runs
      const originalFetch = globalThis.fetch;
      const fetchSpy = vi.fn();
      globalThis.fetch = fetchSpy;

      process.env.RESEND_API_KEY = 're_test_valid_key_123';
      process.env.RESEND_FROM_EMAIL = 're_accidental_api_key';

      try {
        await expect(
          sendResendEmail({
            to: 'target@example.com',
            subject: 'Test Subject',
            html: '<p>Test</p>',
          })
        ).rejects.toThrowError(
          expect.objectContaining({
            code: 'email_sender_invalid',
            outcome: 'definitive_rejection',
          })
        );

        // Fetch must NEVER have been called
        expect(fetchSpy).not.toHaveBeenCalled();
      } finally {
        globalThis.fetch = originalFetch;
        delete process.env.RESEND_API_KEY;
        delete process.env.RESEND_FROM_EMAIL;
      }
    });

    it('fails closed in production if sender is unconfigured before contacting API', async () => {
      setEmailSenderForTest(null);
      const originalFetch = globalThis.fetch;
      const fetchSpy = vi.fn();
      globalThis.fetch = fetchSpy;

      const origNodeEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';
      process.env.RESEND_API_KEY = 're_test_valid_key_123';
      delete process.env.RESEND_FROM_EMAIL;
      delete process.env.EMAIL_FROM;

      try {
        await expect(
          sendResendEmail({
            to: 'target@example.com',
            subject: 'Test Subject',
            html: '<p>Test</p>',
          })
        ).rejects.toThrowError(
          expect.objectContaining({
            code: 'email_sender_unconfigured',
            outcome: 'definitive_rejection',
          })
        );

        expect(fetchSpy).not.toHaveBeenCalled();
      } finally {
        globalThis.fetch = originalFetch;
        process.env.NODE_ENV = origNodeEnv;
        delete process.env.RESEND_API_KEY;
      }
    });
  });
});
