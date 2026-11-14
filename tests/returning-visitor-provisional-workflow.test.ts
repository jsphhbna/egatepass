import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  computeCosineSimilarity,
  validateFaceDescriptor,
} from '../server/lib/face-engine.js';
import * as faceEngine from '../server/lib/face-engine.js';
import * as supabaseModule from '../server/supabase.js';
import * as actorsModule from '../server/actors.js';
import * as verifyIdentityModule from '../server/routes/passes/verify-identity.js';
import identifyReturningHandler, {
  isReturningVisitorAvailable,
  isReturningEnrollmentAvailable,
  isThresholdConfigured,
  getThresholdMode,
  computeMatchTokenDigest,
  SFACE_PROVISIONAL_COSINE_THRESHOLD,
} from '../server/routes/passes/identify-returning.js';
import capabilitiesHandler from '../server/routes/passes/capabilities.js';
import lookupReturningHandler from '../server/routes/passes/lookup-returning.js';
import { resetTurnstileReplayCache } from '../server/lib/turnstile.js';

describe('Returning Visitor Provisional 1:1 Biometric & Enrollment Architecture (Comprehensive)', () => {
  const originalEnv = { ...process.env };
  const testKey = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  const testSecret = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  const actorId = '11111111-1111-4111-8111-111111111111';
  const requestId = '22222222-2222-4222-8222-222222222222';
  const photoBase64 = '/9j/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCABkAGQDASIAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAAAP/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAUAQEAAAAAAAAAAAAAAAAAAAAA/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA//2Q==';
  const profileId = '44444444-4444-4444-8444-444444444444';

  function makeDescriptor(base: number): Float32Array {
    const arr = new Float32Array(128);
    let norm = 0;
    for (let i = 0; i < 128; i++) {
      arr[i] = Math.sin(base + i);
      norm += arr[i]! * arr[i]!;
    }
    norm = Math.sqrt(norm);
    for (let i = 0; i < 128; i++) {
      arr[i] = arr[i]! / norm;
    }
    return arr;
  }

  beforeEach(() => {
    resetTurnstileReplayCache();
    process.env = { ...originalEnv };
    process.env.RETURNING_VISITOR_TEMPLATE_KEY = testKey;
    process.env.RETURNING_MATCH_TOKEN_SECRET = testSecret;
    process.env.RETURNING_FACE_MIN_COSINE = '0.363';
    process.env.RETURNING_FACE_THRESHOLD_MODE = 'provisional';
    process.env.TURNSTILE_SECRET_KEY = 'test-turnstile-secret-at-least-32-chars!';
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ success: true, hostname: 'localhost' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  // =========================================================================
  // 1. ARCHITECTURAL DECOUPLING (ENROLLMENT VS VERIFICATION)
  // =========================================================================
  describe('1. Architectural Decoupling: Enrollment vs Verification', () => {
    it('blocks enrollment when template key is absent or retired', async () => {
      delete process.env.RETURNING_MATCH_TOKEN_SECRET;
      delete process.env.RETURNING_FACE_MIN_COSINE;
      delete process.env.RETURNING_FACE_THRESHOLD_MODE;

      expect(isReturningEnrollmentAvailable()).toBe(false);
      expect(isReturningVisitorAvailable()).toBe(false);

      const res = await capabilitiesHandler.fetch(
        new Request('http://localhost/api/passes/capabilities', { method: 'GET' })
      );
      const data = await res.json();
      expect(data.returningEnrollmentAvailable).toBe(false);
      expect(data.returningVisitorAvailable).toBe(false);
      expect(data.thresholdConfigured).toBe(false);
      expect(data.thresholdMode).toBe('unconfigured');
    });

    it('blocks enrollment when template key is absent or too short', () => {
      delete process.env.RETURNING_VISITOR_TEMPLATE_KEY;
      expect(isReturningEnrollmentAvailable()).toBe(false);

      process.env.RETURNING_VISITOR_TEMPLATE_KEY = 'short-key';
      expect(isReturningEnrollmentAvailable()).toBe(false);
    });

    it('blocks verification if match token secret is missing even if threshold exists', () => {
      delete process.env.RETURNING_MATCH_TOKEN_SECRET;
      expect(isReturningEnrollmentAvailable()).toBe(false);
      expect(isReturningVisitorAvailable()).toBe(false);
    });
  });

  // =========================================================================
  // 2. RETURNING VISITOR CANDIDATE LOOKUP & PRIVACY MASKING
  // =========================================================================
  describe('2. Candidate Discovery & Privacy Masking Contract', () => {
    it('returns privacy-masked candidate data without exposing full PII', async () => {
      vi.spyOn(actorsModule, 'getVerifiedSessionContext').mockResolvedValue({
        actorId,
        role: 'visitor',
        isAnonymous: true,
        isRecoverySession: false,
        user: { id: actorId },
        identity: 'anon-user',
        email: null,
      } as any);

      const mockQuery = {
        ilike: vi.fn().mockReturnThis(),
        gt: vi.fn().mockReturnThis(),
        is: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue({
          data: [
            {
              id: profileId,
              first_name: 'Juan',
              middle_name: 'Santos',
              last_name: 'Dela Cruz',
              contact_number_e164: '+639171234567',
              psgc_city_municipality_name: 'City of Manila',
              psgc_barangay_name: 'Barangay 856',
              psgc_province_name: null,
              psgc_region_name: 'National Capital Region (NCR)',
            },
          ],
          error: null,
        }),
      };

      const mockAdmin = {
        schema: vi.fn().mockReturnValue({
          rpc: vi.fn().mockResolvedValue({ data: true, error: null }),
        }),
        from: vi.fn().mockReturnValue({
          select: vi.fn().mockReturnValue(mockQuery),
        }),
      };

      vi.spyOn(supabaseModule, 'getServerSupabaseClients').mockReturnValue({
        admin: mockAdmin as any,
        client: {} as any,
      });

      const req = new Request('http://localhost/api/passes/lookup-returning', {
        method: 'POST',
        headers: {
          authorization: 'Bearer dummy-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          firstName: 'Juan',
          lastName: 'Dela Cruz',
          contactNumber: '09171234567',
          captchaToken: 'cf-turnstile-provisional-test',
        }),
      });

      const res = await lookupReturningHandler.fetch(req);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.found).toBe(true);
      expect(json.candidates).toHaveLength(1);
      const candidate = json.candidates[0];

      // Profile ID is exposed for 1:1 selection
      expect(candidate.profileId).toBe(profileId);
      // PII is masked (last name and phone number)
      expect(candidate.maskedName).toBe('Juan S. D****');
      expect(candidate.maskedContact).toBe('+639***4567');
      expect(candidate.partialLocality).toBe('Barangay 856, City of Manila');
      // Full raw phone or last name is NEVER returned
      expect(JSON.stringify(json)).not.toContain('09171234567');
    });
  });

  // =========================================================================
  // 3. 1:1 BIOMETRIC VERIFICATION EVALUATION
  // =========================================================================
  describe('3. 1:1 Biometric Verification Outcomes', () => {
    function setupAuthAndPhotoMocks(queryDesc: Float32Array) {
      vi.spyOn(actorsModule, 'getVerifiedSessionContext').mockResolvedValue({
        actorId,
        role: 'visitor',
        isAnonymous: true,
        isRecoverySession: false,
        user: { id: actorId },
        identity: 'anon-user',
        email: null,
      } as any);

      vi.spyOn(verifyIdentityModule, 'inspectAndDownloadUpload').mockResolvedValue({
        buffer: Buffer.from('dummy-photo-buffer'),
        contentType: 'image/jpeg',
        byteSize: 1024,
      });

      vi.spyOn(faceEngine, 'analyzeFaceImage').mockResolvedValue({
        quality: { passed: true, code: 'ok', message: 'ok' },
        faces: [],
        dominantFace: null,
        descriptor: queryDesc,
        modelName: 'opencv_zoo_yunet_sface',
        modelVersion: 'yunet_2023mar_sface_2021dec',
      });
    }

    function createMockAdmin(profileData: any) {
      return {
        schema: vi.fn().mockReturnValue({
          rpc: vi.fn().mockResolvedValue({ data: true, error: null }),
        }),
        from: vi.fn((table: string) => {
          if (table === 'returning_visitor_profiles') {
            return {
              select: vi.fn().mockReturnThis(),
              eq: vi.fn().mockReturnThis(),
              maybeSingle: vi.fn().mockResolvedValue({
                data: profileData,
                error: null,
              }),
            };
          }
          if (table === 'visitors') {
            return {
              select: vi.fn().mockReturnThis(),
              eq: vi.fn().mockResolvedValue({
                data: [{ id: 'vis-1' }],
                error: null,
              }),
            };
          }
          if (table === 'visitor_evidence') {
            return {
              select: vi.fn().mockReturnThis(),
              in: vi.fn().mockReturnThis(),
              eq: vi.fn().mockReturnThis(),
              is: vi.fn().mockReturnThis(),
              order: vi.fn().mockReturnThis(),
              limit: vi.fn().mockReturnThis(),
              maybeSingle: vi.fn().mockResolvedValue({
                data: {
                  bucket_id: 'pass-portraits',
                  object_path: 'portraits/orig.jpg',
                  created_at: '2026-01-01T00:00:00Z',
                },
                error: null,
              }),
            };
          }
          if (table === 'returning_identity_attempts') {
            return {
              insert: vi.fn().mockResolvedValue({ error: null }),
            };
          }
          if (table === 'returning_visitor_vehicles') {
            return {
              select: vi.fn().mockReturnThis(),
              eq: vi.fn().mockReturnThis(),
              is: vi.fn().mockResolvedValue({ data: [], error: null }),
            };
          }
          return {};
        }),
        storage: {
          from: vi.fn().mockReturnValue({
            download: vi.fn().mockResolvedValue({
              data: new Blob([Buffer.from('dummy-reference-portrait')]),
              error: null,
            }),
          }),
        },
      };
    }

    it('matches when 1:1 cosine similarity exceeds provisional threshold 0.363', async () => {
      const genuineDesc = makeDescriptor(1.0);
      setupAuthAndPhotoMocks(genuineDesc);

      const mockAdmin = createMockAdmin({
        id: profileId,
        first_name: 'Juan',
        middle_name: null,
        last_name: 'Cruz',
        contact_number_e164: '+639171234567',
        home_address: '123 Rizal St',
        expires_at: '2099-01-01T00:00:00Z',
        revoked_at: null,
      });

      vi.spyOn(supabaseModule, 'getServerSupabaseClients').mockReturnValue({
        admin: mockAdmin as any,
        client: {} as any,
      });

      const req = new Request('http://localhost/api/passes/identify-returning', {
        method: 'POST',
        headers: {
          authorization: 'Bearer dummy-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ requestId, profileId, photoBase64 }),
      });

      const res = await identifyReturningHandler.fetch(req);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.matched).toBe(true);
      expect(typeof json.matchToken).toBe('string');
      expect(json.matchToken).toHaveLength(64); // 32 bytes hex
      expect(json.profile.id).toBe(profileId);
      expect(json.profile.firstName).toBe('Juan');
    });

    it('rejects with matched=false when different person has similarity below 0.363', async () => {
      const genuineDesc = makeDescriptor(1.0);
      const impostorDesc = makeDescriptor(99.0); // Different face vector
      
      // Live selfie gets impostorDesc, reference portrait gets genuineDesc
      vi.spyOn(actorsModule, 'getVerifiedSessionContext').mockResolvedValue({
        actorId,
        role: 'visitor',
        isAnonymous: true,
        isRecoverySession: false,
        user: { id: actorId },
        identity: 'anon-user',
        email: null,
      } as any);

      vi.spyOn(verifyIdentityModule, 'inspectAndDownloadUpload').mockResolvedValue({
        buffer: Buffer.from('dummy-photo-buffer'),
        contentType: 'image/jpeg',
        byteSize: 1024,
      });

      let callCount = 0;
      vi.spyOn(faceEngine, 'analyzeFaceImage').mockImplementation(async () => {
        callCount++;
        return {
          quality: { passed: true, code: 'ok', message: 'ok' },
          faces: [],
          dominantFace: null,
          descriptor: callCount === 1 ? impostorDesc : genuineDesc,
          modelName: 'opencv_zoo_yunet_sface',
          modelVersion: 'yunet_2023mar_sface_2021dec',
        };
      });

      const mockAdmin = createMockAdmin({
        id: profileId,
        first_name: 'Juan',
        middle_name: null,
        last_name: 'Cruz',
        contact_number_e164: '+639171234567',
        home_address: '123 Rizal St',
        expires_at: '2099-01-01T00:00:00Z',
        revoked_at: null,
      });

      vi.spyOn(supabaseModule, 'getServerSupabaseClients').mockReturnValue({
        admin: mockAdmin as any,
        client: {} as any,
      });

      const req = new Request('http://localhost/api/passes/identify-returning', {
        method: 'POST',
        headers: {
          authorization: 'Bearer dummy-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ requestId, profileId, photoBase64 }),
      });

      const res = await identifyReturningHandler.fetch(req);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.matched).toBe(false);
      expect(json.matchToken).toBeUndefined();
      expect(json.message).toContain('Photo did not match');
    });

    it('rejects low-quality, no-face, or multiple-faces with 422 before template decryption', async () => {
      vi.spyOn(actorsModule, 'getVerifiedSessionContext').mockResolvedValue({
        actorId,
        role: 'visitor',
        isAnonymous: true,
        isRecoverySession: false,
        user: { id: actorId },
        identity: 'anon-user',
        email: null,
      } as any);

      vi.spyOn(verifyIdentityModule, 'inspectAndDownloadUpload').mockResolvedValue({
        buffer: Buffer.from('dummy-photo-buffer'),
        contentType: 'image/jpeg',
        byteSize: 1024,
      });

      // Quality rejected: no face detected
      vi.spyOn(faceEngine, 'analyzeFaceImage').mockResolvedValue({
        quality: { passed: false, code: 'no_face', message: 'No face detected' },
        faces: [],
        dominantFace: null,
        descriptor: null,
        modelName: 'opencv_zoo_yunet_sface',
        modelVersion: 'yunet_2023mar_sface_2021dec',
      });

      const mockAdmin = {
        schema: vi.fn().mockReturnValue({
          rpc: vi.fn().mockResolvedValue({ data: true, error: null }),
        }),
        from: vi.fn(),
      };

      vi.spyOn(supabaseModule, 'getServerSupabaseClients').mockReturnValue({
        admin: mockAdmin as any,
        client: {} as any,
      });

      const req = new Request('http://localhost/api/passes/identify-returning', {
        method: 'POST',
        headers: {
          authorization: 'Bearer dummy-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ requestId, profileId, photoBase64 }),
      });

      const res = await identifyReturningHandler.fetch(req);
      expect(res.status).toBe(422);
      const json = await res.json();
      expect(json.error).toBe('quality_rejected');
      expect(json.reasonCode).toBe('no_face');
    });

    it('rejects expired or revoked profiles with 422', async () => {
      const genuineDesc = makeDescriptor(1.0);
      setupAuthAndPhotoMocks(genuineDesc);

      const mockAdmin = {
        schema: vi.fn().mockReturnValue({
          rpc: vi.fn().mockResolvedValue({ data: true, error: null }),
        }),
        from: vi.fn((table: string) => {
          if (table === 'returning_visitor_profiles') {
            return {
              select: vi.fn().mockReturnThis(),
              eq: vi.fn().mockReturnThis(),
              maybeSingle: vi.fn().mockResolvedValue({
                data: {
                  id: profileId,
                  first_name: 'Juan',
                  last_name: 'Cruz',
                  contact_number_e164: '+639171234567',
                  // Expired in 2020
                  expires_at: '2020-01-01T00:00:00Z',
                  revoked_at: null,
                },
                error: null,
              }),
            };
          }
          return {};
        }),
      };

      vi.spyOn(supabaseModule, 'getServerSupabaseClients').mockReturnValue({
        admin: mockAdmin as any,
        client: {} as any,
      });

      const req = new Request('http://localhost/api/passes/identify-returning', {
        method: 'POST',
        headers: {
          authorization: 'Bearer dummy-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ requestId, profileId, photoBase64 }),
      });

      const res = await identifyReturningHandler.fetch(req);
      expect(res.status).toBe(422);
      const json = await res.json();
      expect(json.matched).toBe(false);
      expect(json.message).toContain('expired or been revoked');
    });
  });
});
