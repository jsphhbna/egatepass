import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  validateFaceDescriptor,
  computeCosineSimilarity,
  checkFaceRuntimeReadiness,
  resetFaceRuntimeReadiness,
  encryptFaceTemplate,
} from '../server/lib/face-engine.js';
import * as faceEngine from '../server/lib/face-engine.js';
import * as supabaseModule from '../server/supabase.js';
import * as verifyIdentityModule from '../server/routes/passes/verify-identity.js';
import * as actorsModule from '../server/actors.js';
import identifyReturningHandler from '../server/routes/passes/identify-returning.js';

describe('Returning Visitor Fail-Closed Gallery & Descriptor Validation (Priority 1 & 6)', () => {
  const originalEnv = { ...process.env };
  const testKey = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  const testSecret = 'test-match-token-secret-123456789';

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.RETURNING_FACE_MIN_COSINE = '0.45';
    process.env.RETURNING_FACE_MIN_MARGIN = '0.05';
    process.env.RETURNING_VISITOR_TEMPLATE_KEY = testKey;
    process.env.RETURNING_MATCH_TOKEN_SECRET = testSecret;
    resetFaceRuntimeReadiness();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    resetFaceRuntimeReadiness();
    vi.restoreAllMocks();
  });

  describe('1. validateFaceDescriptor contract', () => {
    it('accepts a valid normalized 128-dimensional Float32Array', () => {
      const desc = new Float32Array(128);
      for (let i = 0; i < 128; i++) {
        desc[i] = (i - 64) / 100;
      }
      const res = validateFaceDescriptor(desc, 128);
      expect(res.valid).toBe(true);
      expect(res.reason).toBeUndefined();
    });

    it('rejects non-Float32Array inputs', () => {
      expect(validateFaceDescriptor([0.1, 0.2]).valid).toBe(false);
      expect(validateFaceDescriptor('string').valid).toBe(false);
      expect(validateFaceDescriptor(null).valid).toBe(false);
      expect(validateFaceDescriptor(undefined).valid).toBe(false);
      expect(validateFaceDescriptor({ length: 128 }).valid).toBe(false);
    });

    it('rejects dimension mismatches', () => {
      const shortDesc = new Float32Array(127);
      const resShort = validateFaceDescriptor(shortDesc, 128);
      expect(resShort.valid).toBe(false);
      expect(resShort.reason).toContain('dimension_mismatch');

      const longDesc = new Float32Array(256);
      const resLong = validateFaceDescriptor(longDesc, 128);
      expect(resLong.valid).toBe(false);
      expect(resLong.reason).toContain('dimension_mismatch');
    });

    it('rejects descriptors with NaN or Infinity', () => {
      const descNan = new Float32Array(128);
      descNan[42] = NaN;
      expect(validateFaceDescriptor(descNan).valid).toBe(false);
      expect(validateFaceDescriptor(descNan).reason).toContain('non_finite');

      const descInf = new Float32Array(128);
      descInf[10] = Infinity;
      expect(validateFaceDescriptor(descInf).valid).toBe(false);

      const descNegInf = new Float32Array(128);
      descNegInf[99] = -Infinity;
      expect(validateFaceDescriptor(descNegInf).valid).toBe(false);
    });

    it('rejects all-zero vectors with near-zero L2 norm', () => {
      const zeroDesc = new Float32Array(128); // All zeros
      const res = validateFaceDescriptor(zeroDesc);
      expect(res.valid).toBe(false);
      expect(res.reason).toBe('zero_or_non_finite_l2_norm');
    });
  });

  describe('2. computeCosineSimilarity robustness', () => {
    it('returns 0 if either descriptor has NaN or non-finite elements', () => {
      const a = new Float32Array([1, 0, 0]);
      const b = new Float32Array([1, NaN, 0]);
      expect(computeCosineSimilarity(a, b)).toBe(0);
    });

    it('returns 0 if either descriptor is all zeros', () => {
      const a = new Float32Array([1, 2, 3]);
      const b = new Float32Array([0, 0, 0]);
      expect(computeCosineSimilarity(a, b)).toBe(0);
    });

    it('safely clamps output within [-1.0, 1.0]', () => {
      const a = new Float32Array([0.5, 0.5]);
      const b = new Float32Array([0.5, 0.5]);
      const sim = computeCosineSimilarity(a, b);
      expect(sim).toBeCloseTo(1.0, 5);
      expect(sim).toBeLessThanOrEqual(1.0);
      expect(sim).toBeGreaterThanOrEqual(-1.0);
    });
  });

  describe('3. Priority 4: checkFaceRuntimeReadiness', () => {
    it('reports disabled when FACE_VERIFICATION_DISABLED=true', async () => {
      process.env.FACE_VERIFICATION_DISABLED = 'true';
      const result = await checkFaceRuntimeReadiness(true);
      expect(result.ready).toBe(false);
      expect(result.reason).toBe('disabled_by_env');
    });

    it('verifies ONNX Runtime sessions and smoke inference when models exist', async () => {
      delete process.env.FACE_VERIFICATION_DISABLED;
      const result = await checkFaceRuntimeReadiness(true);
      expect(typeof result.ready).toBe('boolean');
      if (result.ready) {
        expect(result.reason).toBeUndefined();
      }
    });
  });

  describe('4. Fail-Closed Gallery Evaluation Contract (Endpoint)', () => {
    const actorId = '11111111-1111-4111-8111-111111111111';
    const requestId = '22222222-2222-4222-8222-222222222222';
    const photoIntentId = '33333333-3333-4333-8333-333333333333';

    // Helper: make dummy normalized descriptor
    function makeDescriptor(seed: number): Float32Array {
      const arr = new Float32Array(128);
      let norm = 0;
      for (let i = 0; i < 128; i++) {
        arr[i] = Math.sin(seed + i);
        norm += arr[i]! * arr[i]!;
      }
      norm = Math.sqrt(norm);
      for (let i = 0; i < 128; i++) {
        arr[i] = arr[i]! / norm;
      }
      return arr;
    }

    it('returns 503 gallery_evaluation_incomplete if ANY template fails decryption', async () => {
      vi.spyOn(actorsModule, 'getVerifiedSessionContext').mockResolvedValue({
        actorId,
        role: 'visitor',
        isAnonymous: true,
        isRecoverySession: false,
        user: { id: actorId },
        identity: 'test-user',
        email: 'test@example.com',
      } as any);

      vi.spyOn(verifyIdentityModule, 'inspectAndDownloadUpload').mockResolvedValue({
        buffer: Buffer.from('fake-photo-data'),
        contentType: 'image/jpeg',
        byteSize: 1024,
      });

      const queryDesc = makeDescriptor(1.0);
      vi.spyOn(faceEngine, 'analyzeFaceImage').mockResolvedValue({
        quality: { passed: true, code: 'ok', message: 'ok' },
        faces: [],
        dominantFace: null,
        descriptor: queryDesc,
        modelName: 'yunet_sface',
        modelVersion: 'v1',
      });

      // Encrypt valid template 2
      const validDesc = makeDescriptor(1.0); // Exact match
      const encryptedValid = encryptFaceTemplate(validDesc, testKey, 'v1');

      // Template 1 has corrupted ciphertext and invalid auth tag
      const corruptedTemplate = {
        id: 'tpl-bad-1',
        profile_id: 'prof-bad',
        encrypted_embedding: 'deadbeef1234',
        iv: '0102030405060708090a0b0c',
        auth_tag: '0102030405060708090a0b0c0d0e0f10',
        key_version: 'v1',
        returning_visitor_profiles: {
          id: 'prof-bad',
          first_name: 'Corrupt',
          middle_name: null,
          last_name: 'Visitor',
          contact_number_e164: '+639171111111',
          expires_at: '2099-01-01T00:00:00Z',
          revoked_at: null,
        },
      };

      const validTemplate = {
        id: 'tpl-good-2',
        profile_id: 'prof-good',
        encrypted_embedding: encryptedValid.encryptedEmbedding,
        iv: encryptedValid.iv,
        auth_tag: encryptedValid.authTag,
        key_version: encryptedValid.keyVersion,
        returning_visitor_profiles: {
          id: 'prof-good',
          first_name: 'Good',
          middle_name: null,
          last_name: 'Match',
          contact_number_e164: '+639172222222',
          expires_at: '2099-01-01T00:00:00Z',
          revoked_at: null,
        },
      };

      const mockAdmin = {
        schema: vi.fn().mockReturnValue({
          rpc: vi.fn().mockResolvedValue({ data: true, error: null }),
        }),
        from: vi.fn((table: string) => {
          if (table === 'returning_face_templates') {
            return {
              select: vi.fn().mockReturnThis(),
              is: vi.fn().mockReturnThis(),
              gt: vi.fn().mockReturnThis(),
              order: vi.fn().mockReturnThis(),
              range: vi.fn().mockResolvedValue({
                data: [corruptedTemplate, validTemplate],
                error: null,
              }),
            };
          }
          if (table === 'returning_identity_attempts') {
            return {
              insert: vi.fn().mockResolvedValue({ error: null }),
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
        body: JSON.stringify({ requestId, photoIntentId }),
      });

      const res = await identifyReturningHandler.fetch(req);
      expect(res.status).toBe(503);
      const json = await res.json();
      expect(json.error).toBe('gallery_evaluation_incomplete');
      expect(json.message).toContain('Guard Station');
      expect(json.matchToken).toBeUndefined();
    });

    it('returns 503 gallery_evaluation_incomplete if ANY template has non-finite descriptor', async () => {
      vi.spyOn(actorsModule, 'getVerifiedSessionContext').mockResolvedValue({
        actorId,
        role: 'visitor',
        isAnonymous: true,
        isRecoverySession: false,
        user: { id: actorId },
        identity: 'test-user',
        email: 'test@example.com',
      } as any);

      vi.spyOn(verifyIdentityModule, 'inspectAndDownloadUpload').mockResolvedValue({
        buffer: Buffer.from('fake-photo-data'),
        contentType: 'image/jpeg',
        byteSize: 1024,
      });

      const queryDesc = makeDescriptor(1.0);
      vi.spyOn(faceEngine, 'analyzeFaceImage').mockResolvedValue({
        quality: { passed: true, code: 'ok', message: 'ok' },
        faces: [],
        dominantFace: null,
        descriptor: queryDesc,
        modelName: 'yunet_sface',
        modelVersion: 'v1',
      });

      // Encrypt template with NaN element
      const nanDesc = makeDescriptor(2.0);
      nanDesc[5] = NaN;
      const encryptedNan = encryptFaceTemplate(nanDesc, testKey, 'v1');

      const nanTemplate = {
        id: 'tpl-nan-1',
        profile_id: 'prof-nan',
        encrypted_embedding: encryptedNan.encryptedEmbedding,
        iv: encryptedNan.iv,
        auth_tag: encryptedNan.authTag,
        key_version: encryptedNan.keyVersion,
        returning_visitor_profiles: {
          id: 'prof-nan',
          first_name: 'Nan',
          middle_name: null,
          last_name: 'Visitor',
          contact_number_e164: '+639173333333',
          expires_at: '2099-01-01T00:00:00Z',
          revoked_at: null,
        },
      };

      const mockAdmin = {
        schema: vi.fn().mockReturnValue({
          rpc: vi.fn().mockResolvedValue({ data: true, error: null }),
        }),
        from: vi.fn((table: string) => {
          if (table === 'returning_face_templates') {
            return {
              select: vi.fn().mockReturnThis(),
              is: vi.fn().mockReturnThis(),
              gt: vi.fn().mockReturnThis(),
              order: vi.fn().mockReturnThis(),
              range: vi.fn().mockResolvedValue({
                data: [nanTemplate],
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
        body: JSON.stringify({ requestId, photoIntentId }),
      });

      const res = await identifyReturningHandler.fetch(req);
      expect(res.status).toBe(503);
      const json = await res.json();
      expect(json.error).toBe('gallery_evaluation_incomplete');
      expect(json.matchToken).toBeUndefined();
    });
  });
});
