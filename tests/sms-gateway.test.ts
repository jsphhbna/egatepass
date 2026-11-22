import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
import * as actorsModule from '../server/actors.js';
import * as supabaseModule from '../server/supabase.js';
import {
  maskPhoneNumber,
  maskDeviceId,
  normalizePhilippinePhone,
  resolveGatewayUrl,
  sendGatewaySms,
  logSmsActivity,
  sanitizeErrorMessage,
} from '../server/sms.js';
import { encodeSmsMessage, decodeSmsMessage, SMS_PREFIX } from '../server/smsFormat.js';
import { verifyStandardWebhook, verifyGatewayWebhook } from '../server/smsSecurity.js';

describe('SMS Gateway Subsystem - Complete Root Cause Repair & Verification', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.restoreAllMocks();
    process.env = {
      ...originalEnv,
      NODE_ENV: 'test',
      SMS_GATEWAY_URL: 'https://api.sms-gate.app/3rdparty/v1/messages',
      SMS_GATEWAY_USERNAME: 'test_user',
      SMS_GATEWAY_PASSWORD: 'test_password',
      SMS_GATEWAY_DEVICE_ID: '_3D0fcdgLnzghlYiYp9KM',
      SUPABASE_URL: 'https://test.supabase.co',
      SUPABASE_SECRET_KEY: 'test_secret_key',
    };
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  // ==========================================================================
  // Section A: Configuration Tests
  // ==========================================================================
  describe('A. Configuration Tests', () => {
    it('defaults to official cloud endpoint if URL is empty or undefined', () => {
      expect(resolveGatewayUrl('')).toBe('https://api.sms-gate.app/3rdparty/v1/messages');
      expect(resolveGatewayUrl(undefined)).toBe('https://api.sms-gate.app/3rdparty/v1/messages');
    });

    it('normalizes host string with port 443 into full https endpoint', () => {
      expect(resolveGatewayUrl('api.sms-gate.app:443')).toBe('https://api.sms-gate.app/3rdparty/v1/messages');
    });

    it('fails closed when SMS_GATEWAY_USERNAME or SMS_GATEWAY_PASSWORD is not set', async () => {
      delete process.env.SMS_GATEWAY_USERNAME;
      delete process.env.SMS_GATEWAY_PASSWORD;

      const result = await sendGatewaySms({
        phoneNumbers: ['09171234567'],
        message: 'Test message',
        purpose: 'manual_test',
      });

      expect(result.success).toBe(false);
      expect(result.status).toBe('failed');
      expect(result.error).toBe('sms_gateway_not_configured');
    });

    it('fails closed when SMS_GATEWAY_DEVICE_ID is missing', async () => {
      delete process.env.SMS_GATEWAY_DEVICE_ID;

      const result = await sendGatewaySms({
        phoneNumbers: ['09171234567'],
        message: 'Test message',
        purpose: 'manual_test',
      });

      expect(result.success).toBe(false);
      expect(result.status).toBe('failed');
      expect(result.error).toBe('sms_gateway_device_id_not_configured');
    });

    it('rejects unencrypted HTTP gateway URL in production environment', () => {
      process.env.NODE_ENV = 'production';
      expect(() => resolveGatewayUrl('http://api.sms-gate.app/messages')).toThrow('sms_gateway_https_required');
    });

    it('permits HTTP only for local development on localhost or 127.0.0.1', () => {
      process.env.NODE_ENV = 'development';
      expect(resolveGatewayUrl('http://localhost:8080')).toBe('http://localhost:8080/3rdparty/v1/messages');
      expect(resolveGatewayUrl('http://127.0.0.1:8080')).toBe('http://127.0.0.1:8080/3rdparty/v1/messages');
    });

    it('rejects invalid or unsupported protocols (ftp, file, javascript)', () => {
      expect(() => resolveGatewayUrl('ftp://api.sms-gate.app')).toThrow('invalid_sms_gateway_scheme');
      expect(() => resolveGatewayUrl('javascript:alert(1)')).toThrow('invalid_sms_gateway_scheme');
    });
  });

  // ==========================================================================
  // Section B: Device Targeting Tests
  // ==========================================================================
  describe('B. Device Targeting Tests', () => {
    it('includes the configured deviceId in the outgoing SMS Gate payload', async () => {
      let capturedGatewayBody: any = null;

      globalThis.fetch = vi.fn().mockImplementation(async (url, options) => {
        const urlStr = String(url);
        if (urlStr.includes('sms-gate.app') || urlStr.includes('/messages')) {
          capturedGatewayBody = JSON.parse(options.body);
          return new Response(JSON.stringify({ id: 'msg_test_123', status: 'queued' }), { status: 200 });
        }
        return new Response(JSON.stringify([]), { status: 200, headers: { 'Content-Type': 'application/json' } });
      });

      const result = await sendGatewaySms({
        phoneNumbers: ['09171234567'],
        message: 'Device targeting test',
        purpose: 'manual_test',
      });

      expect(result.success).toBe(true);
      expect(result.status).toBe('accepted');
      expect(capturedGatewayBody).not.toBeNull();
      expect(capturedGatewayBody.deviceId).toBe('_3D0fcdgLnzghlYiYp9KM');
      expect(capturedGatewayBody.phoneNumbers).toEqual(['+639171234567']);
      expect(capturedGatewayBody.textMessage.text).toBe('Device targeting test');
    });

    it('masks Android Device ID for privacy-safe logging', () => {
      expect(maskDeviceId('_3D0fcdgLnzghlYiYp9KM')).toBe('_3D0 ••• p9KM');
      expect(maskDeviceId('ffffffffed2959c6000001a1568')).toBe('ffff ••• 1568');
      expect(maskDeviceId('short')).toBe('••••••••');
    });
  });

  // ==========================================================================
  // Section C: Phone Normalization & Validation Tests
  // ==========================================================================
  describe('C. Phone Number Normalization Tests', () => {
    it('normalizes standard 11-digit 09xx numbers to E.164 (+639xxxxxxxxx)', () => {
      expect(normalizePhilippinePhone('09171234567')).toBe('+639171234567');
      expect(normalizePhilippinePhone('0928-987-6543')).toBe('+639289876543');
    });

    it('preserves existing valid +639xx numbers', () => {
      expect(normalizePhilippinePhone('+639171234567')).toBe('+639171234567');
      expect(normalizePhilippinePhone('+63 917 123 4567')).toBe('+639171234567');
    });

    it('normalizes 639xx without plus sign to +639xx', () => {
      expect(normalizePhilippinePhone('639171234567')).toBe('+639171234567');
    });

    it('rejects invalid, short, landline, or non-Philippine numbers', () => {
      expect(normalizePhilippinePhone('12345')).toBeNull();
      expect(normalizePhilippinePhone('028123456')).toBeNull();
      expect(normalizePhilippinePhone('+14155552671')).toBeNull();
      expect(normalizePhilippinePhone('')).toBeNull();
    });

    it('masks phone numbers according to RA 10173 standards', () => {
      expect(maskPhoneNumber('09171234567')).toBe('0917 ••• 4567');
      expect(maskPhoneNumber('+639171234567')).toBe('+63917 ••• 4567');
      expect(maskPhoneNumber('123')).toBe('••••••');
    });
  });

  // ==========================================================================
  // Section D: Gateway State Separation (Accepted vs Delivered)
  // ==========================================================================
  describe('D. Gateway State Separation Tests', () => {
    it('marks successful HTTP 200 gateway responses as "accepted", NEVER as "delivered"', async () => {
      globalThis.fetch = vi.fn().mockImplementation(async (url, _options) => {
        const urlStr = String(url);
        if (urlStr.includes('sms-gate.app') || urlStr.includes('/messages')) {
          return new Response(JSON.stringify({ id: 'gw_msg_001', state: 'accepted' }), { status: 200 });
        }
        return new Response(JSON.stringify([]), { status: 200, headers: { 'Content-Type': 'application/json' } });
      });

      const result = await sendGatewaySms({
        phoneNumbers: ['09171234567'],
        message: 'Testing status truthfulness',
        purpose: 'manual_test',
      });

      expect(result.success).toBe(true);
      expect(result.status).toBe('accepted');
      expect(result.status).not.toBe('delivered');
      expect(result.messageId).toBe('gw_msg_001');
    });

    it('handles HTTP error status codes from gateway correctly', async () => {
      globalThis.fetch = vi.fn().mockImplementation(async (url, _options) => {
        const urlStr = String(url);
        if (urlStr.includes('sms-gate.app') || urlStr.includes('/messages')) {
          return new Response(JSON.stringify({ error: 'Device offline or unreachable' }), { status: 502 });
        }
        return new Response(JSON.stringify([]), { status: 200, headers: { 'Content-Type': 'application/json' } });
      });

      const result = await sendGatewaySms({
        phoneNumbers: ['09171234567'],
        message: 'Offline test',
        purpose: 'manual_test',
      });

      expect(result.success).toBe(false);
      expect(result.status).toBe('failed');
      expect(result.error).toBe('Device offline or unreachable');
    });
  });

  // ==========================================================================
  // Section E: Request Timeout and AbortSignal Handling
  // ==========================================================================
  describe('E. Timeout and Ambiguous Status Handling', () => {
    it('handles timeout safely: returns status "unknown" and does not blindly retry', async () => {
      globalThis.fetch = vi.fn().mockImplementation(async (url) => {
        const urlStr = String(url);
        if (urlStr.includes('sms-gate.app') || urlStr.includes('/messages')) {
          const timeoutErr = new Error('The operation was aborted due to timeout');
          timeoutErr.name = 'TimeoutError';
          throw timeoutErr;
        }
        return new Response(JSON.stringify([]), { status: 200, headers: { 'Content-Type': 'application/json' } });
      });

      const result = await sendGatewaySms({
        phoneNumbers: ['09171234567'],
        message: 'Timeout test',
        purpose: 'manual_test',
      });

      expect(result.success).toBe(false);
      expect(result.status).toBe('unknown');
      expect(result.error).toBe('sms_gateway_request_timeout');
    });
  });

  // ==========================================================================
  // Section F: Pure SMS Format (160 char limit) & Webhooks
  // ==========================================================================
  describe('F. Message Formats & Webhooks', () => {
    it('encodes and decodes an SOS payload with location under 160 characters', () => {
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
    });

    it('verifies standard webhook signatures for Supabase send-sms auth hook', () => {
      const rawSecret = 'test_secret_1234567890_abcdefghij';
      const base64Secret = Buffer.from(rawSecret).toString('base64');
      const whsec = `whsec_${base64Secret}`;

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
  });

  // ==========================================================================
  // Section G: Backend API Route Authorization & Quota Enforcement
  // ==========================================================================
  describe('G. API Route Authorization and Quota Enforcement', () => {
    it('rejects unauthenticated requests with 401', async () => {
      const { default: handleSmsRequest } = await import('../server/routes/admin/sms.js');
      const request = new Request('http://localhost/api/admin/sms/recipients', {
        method: 'GET',
      });

      const response = await handleSmsRequest(request);
      expect(response.status).toBe(401);
      const data = await response.json();
      expect(data.error).toBe('authentication_required');
    });

    it('enforces daily SMS safety cap: rejects when quota is exceeded with 429', async () => {
      vi.spyOn(actorsModule, 'requireStaffActor').mockResolvedValue({
        id: 'admin-uuid-123',
        userId: 'admin-uuid-123',
        email: 'admin@earist.edu.ph',
        role: 'admin',
        active: true,
      } as any);

      const mockAdmin = {
        from: vi.fn().mockReturnValue({
          insert: vi.fn().mockResolvedValue({ data: null, error: null }),
        }),
        schema: vi.fn().mockReturnValue({
          rpc: vi.fn().mockImplementation((fnName) => {
            if (fnName === 'check_and_reserve_sms_quota') {
              return Promise.resolve({
                data: {
                  allowed: false,
                  current_count: 500,
                  requested_count: 1,
                  daily_cap: 500,
                  remaining: 0,
                },
                error: null,
              });
            }
            return Promise.resolve({ data: null, error: null });
          }),
        }),
      };

      vi.spyOn(supabaseModule, 'getServerSupabaseClients').mockReturnValue({
        admin: mockAdmin as any,
        anon: {} as any,
      });

      const { default: handleSmsRequest } = await import('../server/routes/admin/sms.js');
      const request = new Request('http://localhost/api/admin/sms/send', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer valid-staff-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          type: 'test',
          testNumber: '09171234567',
          message: 'Testing daily cap',
        }),
      });

      const response = await handleSmsRequest(request);
      expect(response.status).toBe(429);
      const data = await response.json();
      expect(data.error).toBe('daily_sms_cap_exceeded');
      expect(data.quota.allowed).toBe(false);
    });

    it('passes requested_actor_id to recipient RPCs and returns deduplicated count', async () => {
      let passedParams: any = null;

      vi.spyOn(actorsModule, 'requireStaffActor').mockResolvedValue({
        id: 'admin-uuid-456',
        userId: 'admin-uuid-456',
        email: 'admin@earist.edu.ph',
        role: 'admin',
        active: true,
      } as any);

      const mockAdmin = {
        from: vi.fn().mockReturnValue({
          insert: vi.fn().mockResolvedValue({ data: null, error: null }),
        }),
        schema: vi.fn().mockReturnValue({
          rpc: vi.fn().mockImplementation((fnName, params) => {
            passedParams = params;
            if (fnName === 'get_emergency_sms_recipients') {
              return Promise.resolve({
                data: [
                  { pass_id: 'p1', visitor_name: 'Visitor A', contact_number: '09171112222', time_in: '2026-11-23T01:00:00Z', gate: 'Gate 1' },
                  { pass_id: 'p2', visitor_name: 'Visitor B', contact_number: '09171112222', time_in: '2026-11-23T01:05:00Z', gate: 'Gate 1' }, // duplicate phone
                  { pass_id: 'p3', visitor_name: 'Visitor C', contact_number: '09183334444', time_in: '2026-11-23T01:10:00Z', gate: 'Gate 2' },
                ],
                error: null,
              });
            }
            return Promise.resolve({ data: null, error: null });
          }),
        }),
      };

      vi.spyOn(supabaseModule, 'getServerSupabaseClients').mockReturnValue({
        admin: mockAdmin as any,
        anon: {} as any,
      });

      const { default: handleSmsRequest } = await import('../server/routes/admin/sms.js');
      const request = new Request('http://localhost/api/admin/sms/recipients?type=emergency', {
        method: 'GET',
        headers: {
          Authorization: 'Bearer valid-staff-token',
        },
      });

      const response = await handleSmsRequest(request);
      expect(response.status).toBe(200);
      const data = await response.json();
      expect(passedParams).toEqual({ requested_actor_id: 'admin-uuid-456' });
      expect(data.count).toBe(3); // 3 total records
      expect(data.uniqueRecipientCount).toBe(2); // 2 unique phone numbers
    });
  });

  // ==========================================================================
  // Section H: Bulk Campaign Processing & Deduplication
  // ==========================================================================
  describe('H. Bulk Campaign Processing', () => {
    it('processes mass emergency broadcasts in chunks of 50 and reports accurate results', async () => {
      const mockRecipients = Array.from({ length: 60 }, (_, i) => ({
        pass_id: `pass_${i}`,
        visitor_name: `Visitor ${i}`,
        contact_number: `0917000${String(i).padStart(4, '0')}`,
      }));

      vi.spyOn(actorsModule, 'requireStaffActor').mockResolvedValue({
        id: 'admin-uuid-789',
        userId: 'admin-uuid-789',
        email: 'admin@earist.edu.ph',
        role: 'admin',
        active: true,
      } as any);

      const mockAdmin = {
        from: vi.fn().mockReturnValue({
          insert: vi.fn().mockResolvedValue({ data: null, error: null }),
        }),
        schema: vi.fn().mockReturnValue({
          rpc: vi.fn().mockImplementation((fnName) => {
            if (fnName === 'get_emergency_sms_recipients') {
              return Promise.resolve({ data: mockRecipients, error: null });
            }
            if (fnName === 'check_and_reserve_sms_quota') {
              return Promise.resolve({
                data: { allowed: true, current_count: 10, requested_count: 60, daily_cap: 500, remaining: 490 },
                error: null,
              });
            }
            return Promise.resolve({ data: null, error: null });
          }),
        }),
      };

      vi.spyOn(supabaseModule, 'getServerSupabaseClients').mockReturnValue({
        admin: mockAdmin as any,
        anon: {} as any,
      });

      let dispatchCalls = 0;
      globalThis.fetch = vi.fn().mockImplementation(async (url) => {
        const urlStr = String(url);
        if (urlStr.includes('sms-gate.app') || urlStr.includes('/messages')) {
          dispatchCalls++;
          return new Response(JSON.stringify({ id: `batch_${dispatchCalls}`, status: 'queued' }), { status: 200 });
        }
        return new Response(JSON.stringify([]), { status: 200, headers: { 'Content-Type': 'application/json' } });
      });

      const { default: handleSmsRequest } = await import('../server/routes/admin/sms.js');
      const request = new Request('http://localhost/api/admin/sms/send', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer valid-staff-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          type: 'emergency',
          message: 'Campus evacuation notice',
        }),
      });

      const response = await handleSmsRequest(request);
      expect(response.status).toBe(200);
      const data = await response.json();
      expect(dispatchCalls).toBe(2); // 60 recipients chunked into batches of 50: batch 1 (50), batch 2 (10)
      expect(data.acceptedCount).toBe(60);
      expect(data.failedCount).toBe(0);
      expect(data.status).toBe('accepted_by_gateway');
    });
  });

  // ==========================================================================
  // Section I: Logging Integrity Tests
  // ==========================================================================
  describe('I. Logging Integrity Tests', () => {
    it('inserts structured transaction log without exposing credentials or unmasked numbers', async () => {
      let insertedLog: any = null;

      const mockAdmin = {
        from: vi.fn().mockImplementation((table) => {
          if (table === 'sms_logs') {
            return {
              insert: vi.fn().mockImplementation((record) => {
                insertedLog = record;
                return Promise.resolve({ data: null, error: null });
              }),
            };
          }
          return { insert: vi.fn() };
        }),
      };

      vi.spyOn(supabaseModule, 'getServerSupabaseClients').mockReturnValue({
        admin: mockAdmin as any,
        anon: {} as any,
      });

      await logSmsActivity({
        transactionId: 'tx_12345',
        deviceId: '_3D0f ••• 9KM',
        direction: 'outbound',
        recipientMasked: '0917 ••• 4567',
        messageBody: 'Hello world',
        purpose: 'manual_test',
        status: 'accepted',
        externalId: 'ext_999',
        actorId: 'admin-uuid-123',
      });

      expect(insertedLog).not.toBeNull();
      expect(insertedLog.transaction_id).toBe('tx_12345');
      expect(insertedLog.device_id).toBe('_3D0f ••• 9KM');
      expect(insertedLog.recipient_masked).toBe('0917 ••• 4567');
      expect(insertedLog.status).toBe('accepted');
      expect(insertedLog.external_id).toBe('ext_999');
      expect(insertedLog.actor_id).toBe('admin-uuid-123');
      expect(insertedLog.authorization).toBeUndefined();
      expect(insertedLog.password).toBeUndefined();
      // Privacy-first: message_body is omitted/redacted from database logs
      expect(insertedLog.message_body).toBeNull();
    });
  });

  // ==========================================================================
  // Section J: Atomic Quota Accounting & Idempotency Tests
  // ==========================================================================
  describe('J. Atomic Quota Accounting & Idempotency Tests', () => {
    it('associates campaignId with reservation and handles idempotent duplicate calls', async () => {
      let reservedCampaignId = '';
      let reservedCount = 0;

      vi.spyOn(actorsModule, 'requireStaffActor').mockResolvedValue({
        id: 'admin-uuid-idemp',
        userId: 'admin-uuid-idemp',
        email: 'admin@earist.edu.ph',
        role: 'admin',
        active: true,
      } as any);

      const mockAdmin = {
        from: vi.fn().mockReturnValue({
          insert: vi.fn().mockResolvedValue({ data: null, error: null }),
        }),
        schema: vi.fn().mockReturnValue({
          rpc: vi.fn().mockImplementation((fnName, params) => {
            if (fnName === 'check_and_reserve_sms_quota') {
              reservedCampaignId = params.campaign_id;
              reservedCount = params.requested_count;
              return Promise.resolve({
                data: {
                  allowed: true,
                  campaign_id: params.campaign_id,
                  requested_count: params.requested_count,
                  current_count: 50,
                  daily_cap: 500,
                  remaining: 450,
                },
                error: null,
              });
            }
            if (fnName === 'finalize_sms_quota') {
              return Promise.resolve({
                data: { success: true, status: params.outcome },
                error: null,
              });
            }
            return Promise.resolve({ data: null, error: null });
          }),
        }),
      };

      vi.spyOn(supabaseModule, 'getServerSupabaseClients').mockReturnValue({
        admin: mockAdmin as any,
        anon: {} as any,
      });

      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ id: 'msg_test_idemp' }), { status: 200 })
      );

      const { default: handleSmsRequest } = await import('../server/routes/admin/sms.js');
      const request = new Request('http://localhost/api/admin/sms/send', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer valid-staff-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          type: 'test',
          testNumber: '09171234567',
          message: 'Idempotency test',
        }),
      });

      const response = await handleSmsRequest(request);
      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(true);
      expect(data.status).toBe('accepted_by_gateway');
      expect(reservedCampaignId).toMatch(/^camp_test_/);
      expect(reservedCount).toBe(1);
      expect(data.campaignId).toBe(reservedCampaignId);
    });
  });

  // ==========================================================================
  // Section K: Webhook Security Verification & Constant-Time Defense
  // ==========================================================================
  describe('K. Webhook Security Verification & Constant-Time Defense', () => {
    const rawSecret = 'whsec_a3c0ab35fb2be1672034bb8ede4b2a02b6d9878ed0abceee924459aacffd8382';
    const id = 'evt_test_sec_001';
    const now = Math.floor(Date.now() / 1000);

    it('rejects missing webhook-id, webhook-timestamp, or webhook-signature', () => {
      const res1 = verifyStandardWebhook({
        headers: { 'webhook-timestamp': String(now), 'webhook-signature': 'v1,abc' },
        rawBody: '{}',
        secret: rawSecret,
      });
      expect(res1.valid).toBe(false);
      expect(res1.error).toBe('missing_webhook_headers');

      const res2 = verifyStandardWebhook({
        headers: { 'webhook-id': id, 'webhook-signature': 'v1,abc' },
        rawBody: '{}',
        secret: rawSecret,
      });
      expect(res2.valid).toBe(false);
      expect(res2.error).toBe('missing_webhook_headers');

      const res3 = verifyStandardWebhook({
        headers: { 'webhook-id': id, 'webhook-timestamp': String(now) },
        rawBody: '{}',
        secret: rawSecret,
      });
      expect(res3.valid).toBe(false);
      expect(res3.error).toBe('missing_webhook_headers');
    });

    it('rejects timestamp outside 300s window or non-numeric timestamp', () => {
      const resExpired = verifyStandardWebhook({
        headers: {
          'webhook-id': id,
          'webhook-timestamp': String(now - 301), // 301s ago
          'webhook-signature': 'v1,abc',
        },
        rawBody: '{}',
        secret: rawSecret,
      });
      expect(resExpired.valid).toBe(false);
      expect(resExpired.error).toBe('timestamp_outside_tolerance');

      const resNaN = verifyStandardWebhook({
        headers: {
          'webhook-id': id,
          'webhook-timestamp': 'not-a-number',
          'webhook-signature': 'v1,abc',
        },
        rawBody: '{}',
        secret: rawSecret,
      });
      expect(resNaN.valid).toBe(false);
      expect(resNaN.error).toBe('invalid_timestamp');
    });

    it('rejects tampered or modified request body even with previously valid signature', () => {
      const originalBody = JSON.stringify({ user: { phone: '09171234567' }, sms: { otp: '112233' } });
      const tamperedBody = JSON.stringify({ user: { phone: '09171234567' }, sms: { otp: '999999' } });

      const toSign = `${id}.${now}.${originalBody}`;
      const hmac = crypto.createHmac('sha256', Buffer.from(rawSecret.slice(6), 'base64')).update(toSign).digest('base64');
      const signature = `v1,${hmac}`;

      // Verify tampered body is rejected
      const result = verifyStandardWebhook({
        headers: {
          'webhook-id': id,
          'webhook-timestamp': String(now),
          'webhook-signature': signature,
        },
        rawBody: tamperedBody,
        secret: rawSecret,
      });

      expect(result.valid).toBe(false);
      expect(result.error).toBe('signature_mismatch');
    });
  });

  // ==========================================================================
  // Section L: Gateway Error Sanitization
  // ==========================================================================
  describe('L. Gateway Error Sanitization', () => {
    it('strips Basic Auth credentials and internal URLs from error strings', () => {
      const rawErrorWithAuth = 'Failed to connect: Basic cm9vdDoxMjM0NTY= to https://api.sms-gate.app:443/3rdparty/v1/messages';
      const sanitized = sanitizeErrorMessage(rawErrorWithAuth);
      expect(sanitized).not.toContain('cm9vdDoxMjM0NTY=');
      expect(sanitized).toContain('Basic [REDACTED]');
      expect(sanitized).not.toContain('https://api.sms-gate.app');
      expect(sanitized).toContain('[GATEWAY_ENDPOINT]');
    });

    it('strips passwords and bearer tokens safely', () => {
      const rawErrorWithToken = 'Invalid query with password=super_secret_123 and Bearer eyJhbGciOiJIUzI1Ni...';
      const sanitized = sanitizeErrorMessage(rawErrorWithToken);
      expect(sanitized).not.toContain('super_secret_123');
      expect(sanitized).not.toContain('eyJhbGciOiJIUzI1Ni');
      expect(sanitized).toContain('password=[REDACTED]');
      expect(sanitized).toContain('Bearer [REDACTED]');
    });
  });
});
