import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import {
  maskNamePart,
  maskVisitorName,
  handleRequest as trackHandler,
} from '../server/routes/passes/track.js';
import { handleRequest as requestOfficeVisitHandler } from '../server/routes/passes/request-office-visit.js';
import { createEmailVerificationProofToken } from '../server/lib/office.js';
import { encryptQrPayload } from '../server/lib/encryption.js';
import * as officeDeliveryModule from '../server/lib/officeDelivery.js';
import * as supabaseModule from '../server/supabase.js';
import * as actorsModule from '../server/actors.js';

vi.mock('../server/upload-inspection.js', () => ({
  inspectUploadIntent: vi.fn().mockResolvedValue({ bytes: 2048, sha256: 'a'.repeat(64) }),
}));

describe('Specific-Person Request Acknowledgement & Secure Status Tracking', () => {
  const originalEnv = process.env;
  const mockSecret = 'test-pass-token-secret-must-be-at-least-32-chars-long!';
  const testVisitorUserId = '11111111-1111-4111-8111-111111111111';
  const testOfficeId = '00000000-0000-4000-8000-000000000001';
  const testPersonnelId = '00000000-0000-4000-8000-000000000002';
  const testVisitId = '00000000-0000-4000-8000-000000000099';

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      SUPABASE_URL: 'http://localhost:54321',
      SUPABASE_SECRET_KEY: 'test-secret-key-supabase-admin-service-role',
      PASS_TOKEN_SECRET: mockSecret,
      RETURNING_MATCH_TOKEN_SECRET: mockSecret,
      OFFICE_VISIT_HMAC_SECRET: mockSecret,
      RATE_LIMIT_HMAC_SECRET: mockSecret,
      OFFICE_VISIT_DELIVERY_ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    };
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  describe('Name Masking Utilities', () => {
    it('masks name parts preserving first and last letters for strings >= 3 characters', () => {
      expect(maskNamePart('Juan')).toBe('J**n');
      expect(maskNamePart('Cruz')).toBe('C**z');
      expect(maskNamePart('Rodriguez')).toBe('R*******z');
    });

    it('masks short names gracefully', () => {
      expect(maskNamePart('Al')).toBe('A*');
      expect(maskNamePart('A')).toBe('A*');
      expect(maskNamePart('')).toBe('');
    });

    it('masks compound visitor names with privacy protection', () => {
      expect(maskVisitorName('Juan', 'Dela Cruz')).toBe('J**n D*******z');
      expect(maskVisitorName('Maria Clara', 'Santos')).toBe('M*********a S****s');
    });
  });

  describe('Request Submission & Acknowledgement Delivery', () => {
    it('generates tracking token, passes digest to RPC, and triggers acknowledgement email', async () => {
      let passedRpcParams: any = null;
      let deliveredEmailParams: any = null;

      vi.spyOn(officeDeliveryModule, 'deliverOfficeAcknowledgementEmail').mockImplementation(
        async (_admin, params) => {
          deliveredEmailParams = params;
          return { status: 'sent', providerMessageId: 'msg_123', error: null };
        }
      );

      vi.spyOn(actorsModule, 'getVerifiedSessionContext').mockResolvedValue({
        user: { id: testVisitorUserId },
        isRecoverySession: false,
      } as any);

      const mockAdmin: any = {
        from: (table: string) => {
          if (table === 'offices') {
            return {
              select: () => ({
                eq: () => ({
                  maybeSingle: async () => ({
                    data: { id: testOfficeId, name: 'Office of the Registrar', active: true },
                    error: null,
                  }),
                }),
              }),
            };
          }
          if (table === 'office_personnel') {
            return {
              select: () => ({
                eq: () => ({
                  eq: () => ({
                    maybeSingle: async () => ({
                      data: { id: testPersonnelId, name: 'Dr. Maria Santos', office_id: testOfficeId, active: true },
                      error: null,
                    }),
                  }),
                }),
              }),
            };
          }
          if (table === 'portal_identity_verification_attempts') {
            return {
              select: () => ({
                eq: () => ({
                  eq: () => ({
                    eq: () => ({
                      eq: () => ({
                        eq: () => ({
                          gt: () => ({
                            order: () => ({
                              limit: () => ({
                                maybeSingle: async () => ({
                                  data: { id: 'ver_123', outcome: 'matched', expires_at: new Date(Date.now() + 10000).toISOString() },
                                  error: null,
                                }),
                              }),
                            }),
                          }),
                        }),
                      }),
                    }),
                  }),
                }),
              }),
            };
          }
          return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) };
        },
        schema: (s: string) => {
          if (s === 'api') {
            return {
              rpc: (fnName: string, params: any) => {
                if (fnName === 'create_specific_person_visit_request') {
                  passedRpcParams = params;
                  return Promise.resolve({
                    data: [{
                      visit_id: testVisitId,
                      request_id: params.requested_request_id,
                      approval_status: 'pending',
                      attendance_status: 'expected',
                      inserted: true,
                      encrypted_tracking_token: params.requested_encrypted_tracking_token,
                      tracking_token_expires_at: params.requested_tracking_token_expires_at,
                    }],
                    error: null,
                  });
                }
                return Promise.resolve({ data: null, error: null });
              },
            };
          }
          return mockAdmin;
        },
      };

      vi.spyOn(supabaseModule, 'getServerSupabaseClients').mockReturnValue({
        admin: mockAdmin,
        anon: mockAdmin,
      } as any);

      const emailProof = createEmailVerificationProofToken('visitor@example.com', testVisitorUserId);

      const request = new Request('https://egatepass.tech/api/passes/request-office-visit', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer test-bearer-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          requestId: '22222222-2222-4222-8222-222222222222',
          source: 'portal',
          registrationMode: 'new',
          visitor: {
            firstName: 'Juan',
            lastName: 'Dela Cruz',
            contactNumber: '09171234567',
            email: 'visitor@example.com',
            purpose: 'TOR Evaluation',
            visitDate: '2026-11-20',
          },
          officeId: testOfficeId,
          personnelId: testPersonnelId,
          specificPurpose: 'TOR Evaluation with Department Head',
          emailVerificationToken: emailProof,
          photoIntentId: '33333333-3333-4333-8333-333333333333',
          idIntentId: '44444444-4444-4444-8444-444444444444',
        }),
      });

      const response = await requestOfficeVisitHandler(request);
      expect(response.status).toBe(201);
      const resBody = await response.json();

      expect(resBody.ok).toBe(true);
      expect(resBody.visitId).toBe(testVisitId);
      expect(resBody.approvalStatus).toBe('pending');
      expect(resBody.trackingToken).toBeDefined();
      expect(typeof resBody.trackingToken).toBe('string');
      expect(resBody.trackingToken.length).toBeGreaterThan(20);

      // Verify tracking URL uses URL fragment/hash
      expect(resBody.trackingUrl).toBe(`https://egatepass.tech/track#t=${resBody.trackingToken}`);

      // Verify delivery parameters
      expect(deliveredEmailParams).toBeDefined();
      expect(deliveredEmailParams.visitId).toBe(testVisitId);
      expect(deliveredEmailParams.recipientEmail).toBe('visitor@example.com');
      expect(deliveredEmailParams.visitorName).toBe('Juan Dela Cruz');
      expect(deliveredEmailParams.officeName).toBe('Office of the Registrar');
      expect(deliveredEmailParams.trackingUrl).toBe(resBody.trackingUrl);

      // Verify RPC parameters received token digest and encrypted token, NEVER raw token
      expect(passedRpcParams).toBeDefined();
      expect(passedRpcParams.requested_tracking_token_digest).toBeDefined();
      expect(passedRpcParams.requested_tracking_token_digest).toHaveLength(64); // SHA-256 hex
      const expectedDigest = createHash('sha256').update(resBody.trackingToken).digest('hex');
      expect(passedRpcParams.requested_tracking_token_digest).toBe(expectedDigest);
      expect(passedRpcParams.requested_encrypted_tracking_token).toBeDefined();
      expect(passedRpcParams.requested_tracking_token).toBeUndefined(); // Raw token never passed
    });

    it('reuses existing tracking token on idempotent retry without token rotation', async () => {
      const existingRawToken = 'test_existing_token_from_first_submission_12345';
      const existingEncrypted = encryptQrPayload(existingRawToken);

      vi.spyOn(officeDeliveryModule, 'deliverOfficeAcknowledgementEmail').mockResolvedValue({
        status: 'pending',
        providerMessageId: null,
        error: null,
      });

      vi.spyOn(actorsModule, 'getVerifiedSessionContext').mockResolvedValue({
        user: { id: testVisitorUserId },
        isRecoverySession: false,
      } as any);

      const mockAdmin: any = {
        from: (table: string) => {
          if (table === 'offices') {
            return {
              select: () => ({
                eq: () => ({
                  maybeSingle: async () => ({
                    data: { id: testOfficeId, name: 'Office of the Registrar', active: true },
                    error: null,
                  }),
                }),
              }),
            };
          }
          if (table === 'office_personnel') {
            return {
              select: () => ({
                eq: () => ({
                  eq: () => ({
                    maybeSingle: async () => ({
                      data: { id: testPersonnelId, name: 'Dr. Maria Santos', office_id: testOfficeId, active: true },
                      error: null,
                    }),
                  }),
                }),
              }),
            };
          }
          if (table === 'portal_identity_verification_attempts') {
            return {
              select: () => ({
                eq: () => ({
                  eq: () => ({
                    eq: () => ({
                      eq: () => ({
                        eq: () => ({
                          gt: () => ({
                            order: () => ({
                              limit: () => ({
                                maybeSingle: async () => ({
                                  data: { id: 'ver_123', outcome: 'matched', expires_at: new Date(Date.now() + 10000).toISOString() },
                                  error: null,
                                }),
                              }),
                            }),
                          }),
                        }),
                      }),
                    }),
                  }),
                }),
              }),
            };
          }
          return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) };
        },
        schema: (s: string) => {
          if (s === 'api') {
            return {
              rpc: (fnName: string, params: any) => {
                if (fnName === 'create_specific_person_visit_request') {
                  return Promise.resolve({
                    data: [{
                      visit_id: testVisitId,
                      request_id: params.requested_request_id,
                      approval_status: 'pending',
                      attendance_status: 'expected',
                      inserted: false, // Idempotent retry
                      encrypted_tracking_token: existingEncrypted,
                      tracking_token_expires_at: new Date(Date.now() + 86400000).toISOString(),
                    }],
                    error: null,
                  });
                }
                return Promise.resolve({ data: null, error: null });
              },
            };
          }
          return mockAdmin;
        },
      };

      vi.spyOn(supabaseModule, 'getServerSupabaseClients').mockReturnValue({
        admin: mockAdmin,
        anon: mockAdmin,
      } as any);

      const emailProof = createEmailVerificationProofToken('visitor@example.com', testVisitorUserId);

      const request = new Request('https://egatepass.tech/api/passes/request-office-visit', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer test-bearer-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          requestId: '22222222-2222-4222-8222-222222222222',
          source: 'portal',
          registrationMode: 'new',
          visitor: {
            firstName: 'Juan',
            lastName: 'Dela Cruz',
            contactNumber: '09171234567',
            email: 'visitor@example.com',
            purpose: 'TOR Evaluation',
            visitDate: '2026-11-20',
          },
          officeId: testOfficeId,
          personnelId: testPersonnelId,
          specificPurpose: 'TOR Evaluation with Department Head',
          emailVerificationToken: emailProof,
          photoIntentId: '33333333-3333-4333-8333-333333333333',
          idIntentId: '44444444-4444-4444-8444-444444444444',
        }),
      });

      const response = await requestOfficeVisitHandler(request);
      expect(response.status).toBe(201);
      const resBody = await response.json();

      // Original token was decrypted and preserved
      expect(resBody.trackingToken).toBe(existingRawToken);
      expect(resBody.trackingUrl).toBe(`https://egatepass.tech/track#t=${existingRawToken}`);
    });
  });

  describe('Tracking Endpoint: POST /api/passes/track', () => {
    it('returns 405 Method Not Allowed for non-POST requests', async () => {
      const getReq = new Request('https://egatepass.tech/api/passes/track', { method: 'GET' });
      const response = await trackHandler(getReq);
      expect(response.status).toBe(405);
      expect(response.headers.get('Allow')).toBe('POST');
    });

    it('returns 400 for invalid token format', async () => {
      const badReq = new Request('https://egatepass.tech/api/passes/track', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: 'short' }),
      });

      const mockAdmin: any = {
        schema: () => ({
          rpc: (fn: string) => {
            if (fn === 'consume_rate_limit') return Promise.resolve({ data: true, error: null });
            return Promise.resolve({ data: null, error: null });
          },
        }),
      };
      vi.spyOn(supabaseModule, 'getServerSupabaseClients').mockReturnValue({ admin: mockAdmin } as any);

      const res = await trackHandler(badReq);
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('invalid_token');
    });

    it('returns 429 when rate limited', async () => {
      const req = new Request('https://egatepass.tech/api/passes/track', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: 'valid_looking_token_123456789012345' }),
      });

      const mockAdmin: any = {
        schema: () => ({
          rpc: (fn: string) => {
            if (fn === 'consume_rate_limit') return Promise.resolve({ data: false, error: null });
            return Promise.resolve({ data: null, error: null });
          },
        }),
      };
      vi.spyOn(supabaseModule, 'getServerSupabaseClients').mockReturnValue({ admin: mockAdmin } as any);

      const res = await trackHandler(req);
      expect(res.status).toBe(429);
      expect(res.headers.get('Retry-After')).toBe('60');
    });

    it('returns 404 when token is not found or invalid', async () => {
      const rawToken = 'non_existent_tracking_token_1234567890';
      const req = new Request('https://egatepass.tech/api/passes/track', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: rawToken }),
      });

      const mockAdmin: any = {
        schema: () => ({
          rpc: (fn: string) => {
            if (fn === 'consume_rate_limit') return Promise.resolve({ data: true, error: null });
            if (fn === 'lookup_office_visit_tracking_status') return Promise.resolve({ data: [], error: null });
            return Promise.resolve({ data: null, error: null });
          },
        }),
      };
      vi.spyOn(supabaseModule, 'getServerSupabaseClients').mockReturnValue({ admin: mockAdmin } as any);

      const res = await trackHandler(req);
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toBe('visit_not_found');
    });

    it('returns 410 when tracking token has expired', async () => {
      const rawToken = 'expired_tracking_token_123456789012';
      const req = new Request('https://egatepass.tech/api/passes/track', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: rawToken }),
      });

      const mockAdmin: any = {
        schema: () => ({
          rpc: (fn: string) => {
            if (fn === 'consume_rate_limit') return Promise.resolve({ data: true, error: null });
            if (fn === 'lookup_office_visit_tracking_status') {
              return Promise.resolve({
                data: [{
                  approval_status: 'pending',
                  is_expired: true,
                }],
                error: null,
              });
            }
            return Promise.resolve({ data: null, error: null });
          },
        }),
      };
      vi.spyOn(supabaseModule, 'getServerSupabaseClients').mockReturnValue({ admin: mockAdmin } as any);

      const res = await trackHandler(req);
      expect(res.status).toBe(410);
      const body = await res.json();
      expect(body.error).toBe('tracking_expired');
    });

    it('returns 200 with sanitized tracking status and zero PII or QR tokens', async () => {
      const rawToken = 'valid_tracking_token_abcdef1234567890';
      const expectedDigest = createHash('sha256').update(rawToken).digest('hex');
      let queriedDigest: string | null = null;

      const req = new Request('https://egatepass.tech/api/passes/track', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-forwarded-for': '203.0.113.195',
        },
        body: JSON.stringify({ token: rawToken }),
      });

      const mockAdmin: any = {
        schema: () => ({
          rpc: (fn: string, params: any) => {
            if (fn === 'consume_rate_limit') {
              expect(params.requested_action).toBe('portal.track_visit');
              expect(params.requested_key_hex).toMatch(/^[0-9a-f]{64}$/);
              expect(params.requested_max_requests).toBe(60);
              expect(params.requested_window_seconds).toBe(60);
              return Promise.resolve({ data: true, error: null });
            }
            if (fn === 'lookup_office_visit_tracking_status') {
              queriedDigest = params.requested_token_digest;
              return Promise.resolve({
                data: [{
                  visit_id: testVisitId,
                  approval_status: 'pending',
                  attendance_status: 'expected',
                  office_name: 'Office of the Registrar',
                  personnel_name: 'Dr. Maria Santos',
                  purpose: 'TOR Evaluation',
                  visit_date: '2026-11-20',
                  arrival_mode: 'no_vehicle',
                  visitor_first_name: 'Juan',
                  visitor_last_name: 'Dela Cruz',
                  rejection_reason: null,
                  submitted_at: '2026-11-11T04:00:00Z',
                  decided_at: null,
                  is_expired: false,
                }],
                error: null,
              });
            }
            return Promise.resolve({ data: null, error: null });
          },
        }),
      };
      vi.spyOn(supabaseModule, 'getServerSupabaseClients').mockReturnValue({ admin: mockAdmin } as any);

      const res = await trackHandler(req);
      expect(res.status).toBe(200);

      // Verify SHA-256 digest lookup
      expect(queriedDigest).toBe(expectedDigest);

      // Verify security headers
      expect(res.headers.get('Cache-Control')).toBe('no-store, no-cache, must-revalidate');
      expect(res.headers.get('Referrer-Policy')).toBe('no-referrer');
      expect(res.headers.get('X-Robots-Tag')).toBe('noindex, nofollow');

      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.tracking).toBeDefined();

      const tracking = body.tracking;
      expect(tracking.approvalStatus).toBe('pending');
      expect(tracking.maskedVisitorName).toBe('J**n D*******z');
      expect(tracking.officeName).toBe('Office of the Registrar');
      expect(tracking.personnelName).toBe('Dr. Maria Santos');
      expect(tracking.purpose).toBe('TOR Evaluation');
      expect(tracking.visitDate).toBe('2026-11-20');
      expect(tracking.arrivalMode).toBe('no_vehicle');
      expect(tracking.submittedAt).toBe('2026-11-11T04:00:00Z');
      expect(tracking.decidedAt).toBeNull();
      expect(tracking.rejectionReason).toBeNull();

      // STRICT ZERO PII & PASS LEAKAGE CHECKS:
      expect(tracking.visitId).toBeUndefined();
      expect(tracking.visit_id).toBeUndefined();
      expect(tracking.qrToken).toBeUndefined();
      expect(tracking.qr_token).toBeUndefined();
      expect(tracking.passId).toBeUndefined();
      expect(tracking.contactNumber).toBeUndefined();
      expect(tracking.email).toBeUndefined();
      expect(tracking.photoUrl).toBeUndefined();
      expect(tracking.idUrl).toBeUndefined();
      expect(tracking.token).toBeUndefined();
    });

    it('returns rejection reason when visit is rejected', async () => {
      const rawToken = 'rejected_visit_tracking_token_12345';
      const req = new Request('https://egatepass.tech/api/passes/track', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: rawToken }),
      });

      const mockAdmin: any = {
        schema: () => ({
          rpc: (fn: string) => {
            if (fn === 'consume_rate_limit') return Promise.resolve({ data: true, error: null });
            if (fn === 'lookup_office_visit_tracking_status') {
              return Promise.resolve({
                data: [{
                  approval_status: 'rejected',
                  attendance_status: 'cancelled',
                  office_name: 'Office of Student Affairs',
                  personnel_name: 'Dean Alonzo',
                  purpose: 'Club Accreditation',
                  visit_date: '2026-11-21',
                  arrival_mode: 'vehicle',
                  visitor_first_name: 'Pedro',
                  visitor_last_name: 'Penduko',
                  rejection_reason: 'Office closed for faculty summit on this date.',
                  submitted_at: '2026-11-11T04:00:00Z',
                  decided_at: '2026-11-11T04:30:00Z',
                  is_expired: false,
                }],
                error: null,
              });
            }
            return Promise.resolve({ data: null, error: null });
          },
        }),
      };
      vi.spyOn(supabaseModule, 'getServerSupabaseClients').mockReturnValue({ admin: mockAdmin } as any);

      const res = await trackHandler(req);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.tracking.approvalStatus).toBe('rejected');
      expect(body.tracking.rejectionReason).toBe('Office closed for faculty summit on this date.');
      expect(body.tracking.maskedVisitorName).toBe('P***o P*****o');
    });

    it('fails closed with 503 when consume_rate_limit RPC errors and returns 429 only when rate limit is exceeded', async () => {
      const makeReq = () =>
        new Request('https://egatepass.tech/api/passes/track', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '203.0.113.10' },
          body: JSON.stringify({ token: 'valid_tracking_token_abcdef1234567890' }),
        });

      const rpcErrAdmin: any = {
        schema: () => ({
          rpc: () => Promise.resolve({ data: null, error: { code: 'PGRST202', message: 'Could not find function' } }),
        }),
      };
      vi.spyOn(supabaseModule, 'getServerSupabaseClients').mockReturnValueOnce({ admin: rpcErrAdmin } as any);
      const errRes = await trackHandler(makeReq());
      expect(errRes.status).toBe(503);
      expect((await errRes.json()).error).toBe('abuse_control_unavailable');

      const throttledAdmin: any = {
        schema: () => ({
          rpc: () => Promise.resolve({ data: false, error: null }),
        }),
      };
      vi.spyOn(supabaseModule, 'getServerSupabaseClients').mockReturnValueOnce({ admin: throttledAdmin } as any);
      const limitRes = await trackHandler(makeReq());
      expect(limitRes.status).toBe(429);
      expect((await limitRes.json()).error).toBe('rate_limited');
    });
  });
});
