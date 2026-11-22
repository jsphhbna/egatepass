import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { maskPhoneNumber, resolveGatewayUrl, sendGatewaySms } from '../server/sms.js';

describe('SMS Gateway for Android pure functions and contract', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  describe('maskPhoneNumber', () => {
    it('masks standard 11-digit Philippine mobile numbers', () => {
      expect(maskPhoneNumber('09171234567')).toBe('0917 ••• 4567');
      expect(maskPhoneNumber('09289876543')).toBe('0928 ••• 6543');
    });

    it('masks E.164 Philippine mobile numbers with country code', () => {
      expect(maskPhoneNumber('+639171234567')).toBe('+63917 ••• 4567');
      expect(maskPhoneNumber('+639998887766')).toBe('+63999 ••• 7766');
    });

    it('handles formatted numbers with spaces and hyphens gracefully', () => {
      expect(maskPhoneNumber('0917-123-4567')).toBe('0917 ••• 4567');
      expect(maskPhoneNumber('+63 917 123 4567')).toBe('+63917 ••• 4567');
    });

    it('returns privacy placeholder for abnormally short input', () => {
      expect(maskPhoneNumber('12345')).toBe('••••••');
    });
  });

  describe('resolveGatewayUrl', () => {
    it('defaults to official cloud endpoint if empty', () => {
      expect(resolveGatewayUrl('')).toBe('https://api.sms-gate.app/3rdparty/v1/messages');
      expect(resolveGatewayUrl(undefined)).toBe('https://api.sms-gate.app/3rdparty/v1/messages');
    });

    it('normalizes host string with port 443 into full https endpoint', () => {
      expect(resolveGatewayUrl('api.sms-gate.app:443')).toBe('https://api.sms-gate.app/3rdparty/v1/messages');
    });

    it('appends messages path if only hostname or base URL is given', () => {
      expect(resolveGatewayUrl('https://api.sms-gate.app')).toBe('https://api.sms-gate.app/3rdparty/v1/messages');
      expect(resolveGatewayUrl('https://api.sms-gate.app/')).toBe('https://api.sms-gate.app/3rdparty/v1/messages');
    });

    it('retains explicit /messages path if already complete', () => {
      expect(resolveGatewayUrl('https://api.sms-gate.app/3rdparty/v1/messages')).toBe('https://api.sms-gate.app/3rdparty/v1/messages');
    });
  });

  describe('sendGatewaySms missing credentials guard', () => {
    it('fails closed gracefully when SMS_GATEWAY_USERNAME or SMS_GATEWAY_PASSWORD is not set', async () => {
      delete process.env.SMS_GATEWAY_USERNAME;
      delete process.env.SMS_GATEWAY_PASSWORD;

      const result = await sendGatewaySms({
        phoneNumbers: ['09171234567'],
        message: 'Test message',
        purpose: 'manual_test',
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('sms_gateway_not_configured');
    });

    it('rejects dispatch with empty recipients list', async () => {
      process.env.SMS_GATEWAY_USERNAME = 'user';
      process.env.SMS_GATEWAY_PASSWORD = 'pass';

      const result = await sendGatewaySms({
        phoneNumbers: [],
        message: 'Test message',
        purpose: 'manual_test',
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('no_recipients_provided');
    });

    it('rejects dispatch with empty message body', async () => {
      process.env.SMS_GATEWAY_USERNAME = 'user';
      process.env.SMS_GATEWAY_PASSWORD = 'pass';

      const result = await sendGatewaySms({
        phoneNumbers: ['09171234567'],
        message: '   ',
        purpose: 'manual_test',
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('empty_message');
    });
  });

  describe('sendGatewaySms live dispatch with mocked fetch', () => {
    it('formats Basic Auth and JSON payload envelope matching SMS Gateway for Android spec', async () => {
      process.env.SMS_GATEWAY_USERNAME = 'RV3T9G';
      process.env.SMS_GATEWAY_PASSWORD = 'test-secret-password';
      process.env.SMS_GATEWAY_URL = 'https://api.sms-gate.app/3rdparty/v1/messages';

      const fetchSpy = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ id: 'msg-abc-123', state: 'pending' }),
      });
      globalThis.fetch = fetchSpy as any;

      const result = await sendGatewaySms({
        phoneNumbers: ['09171234567'],
        message: 'EMERGENCY: Campus evacuation in progress.',
        purpose: 'emergency_roll_call',
      });

      expect(result.success).toBe(true);
      expect(result.messageId).toBe('msg-abc-123');
      expect(result.recipientCount).toBe(1);

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [calledUrl, calledInit] = fetchSpy.mock.calls[0];
      expect(calledUrl).toContain('https://api.sms-gate.app/3rdparty/v1/messages?skipPhoneValidation=true');
      expect(calledInit.method).toBe('POST');
      expect(calledInit.headers['Content-Type']).toBe('application/json');
      expect(calledInit.headers['Authorization']).toContain('Basic ');

      const parsedBody = JSON.parse(calledInit.body);
      expect(parsedBody.textMessage.text).toBe('EMERGENCY: Campus evacuation in progress.');
      expect(parsedBody.phoneNumbers).toEqual(['+639171234567']);
    });
  });
});
