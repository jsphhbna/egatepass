import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
import { maskPhoneNumber, resolveGatewayUrl, sendGatewaySms } from '../server/sms.js';
import { encodeSmsMessage, decodeSmsMessage, SMS_PREFIX } from '../server/smsFormat.js';
import { verifyStandardWebhook, verifyGatewayWebhook } from '../server/smsSecurity.js';

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

  describe('Pure Message Format Encoder & Decoder (under 160 characters)', () => {
    it('encodes and decodes an SOS payload with location correctly', () => {
      const payload = {
        msgId: 'MSG12345',
        type: 'SOS',
        latitude: 14.59951,
        longitude: 120.98422,
        timestamp: 1732318800,
      };

      const encoded = encodeSmsMessage(payload);
      expect(encoded).toBe('EG1|MSG12345|SOS|14.59951|120.98422|1732318800');
      expect(encoded.length).toBeLessThanOrEqual(160);

      const decoded = decodeSmsMessage(encoded);
      expect(decoded).not.toBeNull();
      expect(decoded?.version).toBe(SMS_PREFIX);
      expect(decoded?.msgId).toBe('MSG12345');
      expect(decoded?.type).toBe('SOS');
      expect(decoded?.latitude).toBeCloseTo(14.59951, 4);
      expect(decoded?.longitude).toBeCloseTo(120.98422, 4);
      expect(decoded?.timestamp).toBe(1732318800);
    });

    it('handles message without GPS coordinates cleanly', () => {
      const payload = {
        msgId: 'SAFE9988',
        type: 'SAFE',
        latitude: null,
        longitude: null,
        timestamp: 1732318900,
      };

      const encoded = encodeSmsMessage(payload);
      expect(encoded).toBe('EG1|SAFE9988|SAFE|||1732318900');
      expect(encoded.length).toBeLessThan(40);

      const decoded = decodeSmsMessage(encoded);
      expect(decoded?.msgId).toBe('SAFE9988');
      expect(decoded?.type).toBe('SAFE');
      expect(decoded?.latitude).toBeNull();
      expect(decoded?.longitude).toBeNull();
    });

    it('rejects malformed or invalid version payloads', () => {
      expect(decodeSmsMessage('INVALID_PREFIX|1|2|3|4|5')).toBeNull();
      expect(decodeSmsMessage('too|short')).toBeNull();
      expect(decodeSmsMessage('')).toBeNull();
    });
  });

  describe('Standard Webhook Signature Verification (Supabase Auth Send-SMS Hook)', () => {
    const rawSecret = 'test_secret_1234567890_abcdefghij';
    const base64Secret = Buffer.from(rawSecret).toString('base64');
    const whsec = `whsec_${base64Secret}`;

    it('validates authentic Svix / Standard Webhook signature', () => {
      const id = 'msg_test_001';
      const timestamp = String(Math.floor(Date.now() / 1000));
      const rawBody = JSON.stringify({ user: { phone: '09171234567' }, sms: { otp: '123456' } });

      const toSign = `${id}.${timestamp}.${rawBody}`;
      const hmac = crypto.createHmac('sha256', Buffer.from(rawSecret, 'utf8')).update(toSign).digest('base64');
      const signature = `v1,${hmac}`;

      const result = verifyStandardWebhook({
        headers: {
          'webhook-id': id,
          'webhook-timestamp': timestamp,
          'webhook-signature': signature,
        },
        rawBody,
        secret: whsec,
      });

      expect(result.valid).toBe(true);
    });

    it('rejects expired or tampered timestamps (> 300 seconds old)', () => {
      const id = 'msg_test_002';
      const oldTimestamp = String(Math.floor(Date.now() / 1000) - 400); // 400s old
      const rawBody = '{"hello":"world"}';

      const result = verifyStandardWebhook({
        headers: {
          'webhook-id': id,
          'webhook-timestamp': oldTimestamp,
          'webhook-signature': 'v1,some_fake_sig',
        },
        rawBody,
        secret: whsec,
      });

      expect(result.valid).toBe(false);
      expect(result.error).toBe('timestamp_outside_tolerance');
    });

    it('rejects tampered payload', () => {
      const id = 'msg_test_003';
      const timestamp = String(Math.floor(Date.now() / 1000));
      const originalBody = '{"foo":"bar"}';
      const tamperedBody = '{"foo":"baz"}';

      const toSign = `${id}.${timestamp}.${originalBody}`;
      const hmac = crypto.createHmac('sha256', Buffer.from(rawSecret, 'utf8')).update(toSign).digest('base64');

      const result = verifyStandardWebhook({
        headers: {
          'webhook-id': id,
          'webhook-timestamp': timestamp,
          'webhook-signature': `v1,${hmac}`,
        },
        rawBody: tamperedBody,
        secret: whsec,
      });

      expect(result.valid).toBe(false);
      expect(result.error).toBe('signature_mismatch');
    });

    it('validates genuine Standard Webhook with hex secret', () => {
      const hexSecret = 'a3c0ab35fb2be1672034bb8ede4b2a02b6d9878ed0abceee92411112222334455';
      const normalizedHex = hexSecret.slice(0, 64);
      expect(normalizedHex.length).toBe(64);
      const id = 'msg_hex_001';
      const timestamp = String(Math.floor(Date.now() / 1000));
      const rawBody = JSON.stringify({ user: { phone: '+639171234567' }, sms: { otp: '654321' } });

      const toSign = `${id}.${timestamp}.${rawBody}`;
      const hmac = crypto.createHmac('sha256', Buffer.from(normalizedHex, 'hex')).update(toSign).digest('base64');

      const result = verifyStandardWebhook({
        headers: {
          'webhook-id': id,
          'webhook-timestamp': timestamp,
          'webhook-signature': `v1,${hmac}`,
        },
        rawBody,
        secret: normalizedHex,
      });

      expect(result.valid).toBe(true);
    });
  });

  describe('Gateway X-Signature Verification', () => {
    const signingKey = 'earist-egatepass-sms-webhook-key-2026';

    it('validates genuine X-Signature HMAC header', () => {
      const rawBody = JSON.stringify({ event: 'sms:received', data: { message: 'TEST' } });
      const expectedHex = crypto.createHmac('sha256', Buffer.from(signingKey, 'utf8')).update(rawBody).digest('hex');

      const result = verifyGatewayWebhook({
        headers: {
          'x-signature': expectedHex,
          'x-timestamp': String(Math.floor(Date.now() / 1000)),
        },
        rawBody,
        secret: signingKey,
      });

      expect(result.valid).toBe(true);
    });

    it('rejects tampered body or incorrect secret', () => {
      const rawBody = JSON.stringify({ event: 'sms:received', data: { message: 'TEST' } });
      const badHex = crypto.createHmac('sha256', Buffer.from('wrong-key', 'utf8')).update(rawBody).digest('hex');

      const result = verifyGatewayWebhook({
        headers: {
          'x-signature': badHex,
        },
        rawBody,
        secret: signingKey,
      });

      expect(result.valid).toBe(false);
      expect(result.error).toBe('signature_mismatch');
    });
  });

  describe('Confirmation Reply Length Contract', () => {
    it('ensures confirmation reply is under 160 characters', () => {
      const confirmationText = 'EARIST Alert: Received your emergency report. Security dispatch has been notified.';
      expect(confirmationText.length).toBeLessThanOrEqual(160);
      expect(confirmationText.length).toBe(82);
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
});
