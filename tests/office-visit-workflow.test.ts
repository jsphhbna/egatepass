import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createEmailVerificationProofToken,
  verifyEmailVerificationProofToken,
  createOfficePortraitToken,
  verifyOfficePortraitToken,
} from '../server/lib/office.js';
import * as officeLib from '../server/lib/office.js';
import requestOfficeVisitHandler from '../server/routes/passes/request-office-visit.js';
import decideHandler from '../server/routes/office/decide.js';
import * as supabaseModule from '../server/supabase.js';
import * as actorsModule from '../server/actors.js';

describe('Office Visit Workflow & Approval Subsystem', () => {
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
    };
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  describe('Email Verification Proof Token (HMAC SHA-256)', () => {
    it('creates and verifies a valid proof token for a verified email and actor', () => {
      const email = 'visitor@example.com';
      const actorId = testVisitorUserId;
      const proofToken = createEmailVerificationProofToken(email, actorId);
      expect(typeof proofToken).toBe('string');
      expect(proofToken.length).toBeGreaterThan(20);

      const isValid = verifyEmailVerificationProofToken(proofToken, email, actorId);
      expect(isValid).toBe(true);
    });

    it('rejects verification if the email does not match the token payload', () => {
      const email = 'visitor@example.com';
      const otherEmail = 'imposter@example.com';
      const actorId = testVisitorUserId;
      const proofToken = createEmailVerificationProofToken(email, actorId);

      const isValid = verifyEmailVerificationProofToken(proofToken, otherEmail, actorId);
      expect(isValid).toBe(false);
    });

    it('rejects verification if the actor ID does not match', () => {
      const email = 'visitor@example.com';
      const actorId = testVisitorUserId;
      const otherActorId = '22222222-2222-4222-8222-222222222222';
      const proofToken = createEmailVerificationProofToken(email, actorId);

      const isValid = verifyEmailVerificationProofToken(proofToken, email, otherActorId);
      expect(isValid).toBe(false);
    });

    it('rejects a tampered or malformed token', () => {
      const email = 'visitor@example.com';
      const actorId = testVisitorUserId;
      const proofToken = createEmailVerificationProofToken(email, actorId);
      const tampered = proofToken.slice(0, -4) + 'abcd';

      expect(verifyEmailVerificationProofToken(tampered, email, actorId)).toBe(false);
      expect(verifyEmailVerificationProofToken('invalid:token', email, actorId)).toBe(false);
      expect(verifyEmailVerificationProofToken('', email, actorId)).toBe(false);
    });
  });

  describe('Office Portrait Token (HMAC SHA-256)', () => {
    it('creates and verifies a valid portrait preview token', () => {
      const visitId = '33333333-3333-4333-8333-333333333333';
      const actorId = '44444444-4444-4444-8444-444444444444';
      const token = createOfficePortraitToken(visitId, actorId);

      expect(typeof token).toBe('string');
      const verified = verifyOfficePortraitToken(token, actorId);
      expect(verified).not.toBeNull();
      expect(verified?.visitId).toBe(visitId);
    });

    it('rejects portrait token if presented by a different actor', () => {
      const visitId = '33333333-3333-4333-8333-333333333333';
      const actorId = '44444444-4444-4444-8444-444444444444';
      const differentActorId = '55555555-5555-4555-8555-555555555555';
      const token = createOfficePortraitToken(visitId, actorId);

      expect(verifyOfficePortraitToken(token, differentActorId)).toBeNull();
    });

    it('rejects a tampered portrait token', () => {
      const visitId = '33333333-3333-4333-8333-333333333333';
      const actorId = '44444444-4444-4444-8444-444444444444';
      const token = createOfficePortraitToken(visitId, actorId);
      const tampered = token.slice(0, -3) + 'xyz';

      expect(verifyOfficePortraitToken(tampered, actorId)).toBeNull();
    });
  });

  describe('POST /api/request-office-visit Endpoint Contract', () => {
    it('rejects unauthenticated requests with 401', async () => {
      const req = new Request('http://localhost/api/request-office-visit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      const res = await requestOfficeVisitHandler.fetch(req);
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error).toBe('authentication_required');
    });

    it('rejects submission when email verification proof token is invalid with 403', async () => {
      vi.spyOn(actorsModule, 'getVerifiedSessionContext').mockResolvedValue({
        user: { id: testVisitorUserId, email: 'juan@example.com' } as any,
        isAnonymous: true,
        isRecoverySession: false,
        sessionType: 'anonymous',
      });

      const payload = {
        requestId: '55555555-5555-4555-8555-555555555555',
        source: 'portal',
        registrationMode: 'new',
        visitor: {
          firstName: 'Juan',
          lastName: 'Dela Cruz',
          contactNumber: '09171234567',
          email: 'juan@example.com',
          purpose: 'Official Business',
          visitDate: '2026-11-07',
        },
        officeId: testOfficeId,
        personnelId: testPersonnelId,
        specificPurpose: 'Academic Inquiry',
        emailVerificationToken: 'v_email.invalid.token.1234.sig',
      };

      const req = new Request('http://localhost/api/request-office-visit', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer valid.visitor.token',
        },
        body: JSON.stringify(payload),
      });

      const res = await requestOfficeVisitHandler.fetch(req);
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toBe('email_verification_invalid');
    });

    it('successfully processes valid specific-person visit request without creating an active pass', async () => {
      const email = 'juan@example.com';
      const validProofToken = createEmailVerificationProofToken(email, testVisitorUserId);

      vi.spyOn(actorsModule, 'getVerifiedSessionContext').mockResolvedValue({
        user: { id: testVisitorUserId, email } as any,
        isAnonymous: true,
        isRecoverySession: false,
        sessionType: 'anonymous',
      });

      const mockAdminClient = {
        from: vi.fn((table: string) => {
          if (table === 'app_settings') {
            return {
              select: vi.fn().mockReturnThis(),
              eq: vi.fn().mockReturnThis(),
              maybeSingle: vi.fn().mockResolvedValue({
                data: {
                  visitor_instructions: { max_advance_days: 7 },
                  working_hours_start: '08:00',
                  working_hours_end: '17:00',
                },
                error: null,
              }),
            };
          }
          if (table === 'offices') {
            return {
              select: vi.fn().mockReturnThis(),
              eq: vi.fn().mockReturnThis(),
              maybeSingle: vi.fn().mockResolvedValue({
                data: {
                  id: testOfficeId,
                  name: 'College of Engineering',
                  active: true,
                },
                error: null,
              }),
            };
          }
          if (table === 'office_personnel') {
            return {
              select: vi.fn().mockReturnThis(),
              eq: vi.fn().mockReturnThis(),
              maybeSingle: vi.fn().mockResolvedValue({
                data: {
                  id: testPersonnelId,
                  office_id: testOfficeId,
                  name: 'Dr. Jane Smith',
                  title: 'Dean',
                  active: true,
                },
                error: null,
              }),
            };
          }
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
          };
        }),
        rpc: vi.fn((fnName: string) => {
          if (fnName === 'create_specific_person_visit_request') {
            return Promise.resolve({
              data: {
                ok: true,
                visit_id: 'visit-uuid-12345',
                reference_code: 'OVR-20261107-1234',
                approval_status: 'pending',
                attendance_status: 'awaiting_entry',
                // Crucial invariant: no pass_id or qr_token!
                pass_id: null,
                qr_token: null,
              },
              error: null,
            });
          }
          return Promise.resolve({ data: null, error: null });
        }),
      };

      vi.spyOn(supabaseModule, 'getServerSupabaseClients').mockReturnValue({
        admin: mockAdminClient as any,
        anon: {} as any,
      });

      const payload = {
        requestId: '55555555-5555-4555-8555-555555555555',
        source: 'portal',
        registrationMode: 'new',
        visitor: {
          firstName: 'Juan',
          lastName: 'Dela Cruz',
          contactNumber: '09171234567',
          email,
          purpose: 'Official Business',
          visitDate: '2026-11-07',
        },
        officeId: testOfficeId,
        personnelId: testPersonnelId,
        specificPurpose: 'Consultation regarding curriculum',
        emailVerificationToken: validProofToken,
      };

      const req = new Request('http://localhost/api/request-office-visit', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer valid.visitor.token',
        },
        body: JSON.stringify(payload),
      });

      const res = await requestOfficeVisitHandler.fetch(req);
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.approvalStatus).toBe('pending');
      expect(body.visitId).toBe('visit-uuid-12345');
      // Assert that pass was not issued and no QR token is returned
      expect(body.pass).toBeUndefined();
      expect(body.qrToken).toBeUndefined();
    });
  });

  describe('POST /api/office/decide Endpoint & Decision Safety', () => {
    it('requires a mandatory rejection reason when rejecting a request', async () => {
      const req = new Request('http://localhost/api/office/decide', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer staff-token',
        },
        body: JSON.stringify({
          visitId: testVisitId,
          decision: 'rejected',
          rejectionReason: '   ', // Whitespace only
        }),
      });

      const res = await decideHandler.fetch(req);
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('Invalid decision request');
    });

    it('rejects decision if office staff is not assigned to the destination office', async () => {
      vi.spyOn(officeLib, 'requireOfficeStaffActor').mockResolvedValue({
        id: 'staff-user-2',
        email: 'staff2@earist.edu.ph',
        role: 'office_staff',
        assignedOfficeIds: ['00000000-0000-4000-8000-000000000001'], // Assigned to office-1 only
      });

      const mockAdminClient = {
        from: vi.fn((table: string) => {
          if (table === 'office_visits') {
            return {
              select: vi.fn().mockReturnThis(),
              eq: vi.fn().mockReturnThis(),
              maybeSingle: vi.fn().mockResolvedValue({
                data: {
                  id: testVisitId,
                  office_id: '00000000-0000-4000-8000-000000000002', // Belongs to office-2!
                  visitor_first_name: 'Maria',
                  visitor_last_name: 'Santos',
                  visitor_email: 'maria@example.com',
                  purpose: 'Meeting',
                  visit_date: '2026-11-07',
                  approval_status: 'pending',
                  offices: { name: 'Registrar' },
                  office_personnel: { name: 'Mr. Garcia' },
                },
                error: null,
              }),
            };
          }
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
          };
        }),
      };

      vi.spyOn(supabaseModule, 'getServerSupabaseClients').mockReturnValue({
        admin: mockAdminClient as any,
        anon: {} as any,
      });

      const req = new Request('http://localhost/api/office/decide', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer staff-token',
        },
        body: JSON.stringify({
          visitId: testVisitId,
          decision: 'approved',
        }),
      });

      const res = await decideHandler.fetch(req);
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toBe('unauthorized_for_this_office');
    });
  });
});
