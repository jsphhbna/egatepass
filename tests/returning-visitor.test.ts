import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  parseTemplateKey,
  encryptFaceTemplate,
  decryptFaceTemplate,
  computeCosineSimilarity,
  SFACE_COSINE_THRESHOLD,
  SFACE_REFERENCE_LANDMARKS,
} from '../server/lib/face-engine.js';
import {
  isReturningVisitorAvailable,
  isReturningEnrollmentAvailable,
  isTemplateKeyConfigured,
  isReturningCryptoConfigured,
  isThresholdConfigured,
  getThresholdMode,
  getResolvedCosineThreshold,
  isReturningCalibrationConfigured,
  computeMatchTokenDigest,
  SFACE_PROVISIONAL_COSINE_THRESHOLD,
} from '../server/routes/passes/identify-returning.js';
import capabilitiesHandler from '../server/routes/passes/capabilities.js';
import {
  generateCryptoSecrets,
  maskSecretSummary,
  updateEnvLocalFile,
} from '../scripts/generate-returning-secrets.mjs';

describe('Returning Visitor Biometrics & Safety Gate Contract', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe('1. Safety Gate & Capabilities Configuration', () => {
    it('reports returning visitor unavailable when env vars are missing', async () => {
      delete process.env.RETURNING_FACE_MIN_COSINE;
      delete process.env.RETURNING_FACE_THRESHOLD_MODE;
      delete process.env.RETURNING_FACE_MIN_MARGIN;
      delete process.env.RETURNING_VISITOR_TEMPLATE_KEY;
      delete process.env.RETURNING_MATCH_TOKEN_SECRET;

      expect(isReturningVisitorAvailable()).toBe(false);
      expect(isReturningEnrollmentAvailable()).toBe(false);
      expect(isThresholdConfigured()).toBe(false);
      expect(getThresholdMode()).toBe('unconfigured');

      const req = new Request('http://localhost/api/passes/capabilities', { method: 'GET' });
      const res = await capabilitiesHandler.fetch(req);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.returningVisitorAvailable).toBe(false);
      expect(data.returningEnrollmentAvailable).toBe(false);
      expect(data.returningCryptoConfigured).toBe(false);
      expect(data.thresholdConfigured).toBe(false);
      expect(data.thresholdMode).toBe('unconfigured');
      expect(data.returningCalibrationConfigured).toBe(false);
      // facialRecognitionConfigured is independent of returning visitor env vars (reflects 1:1 model files on disk)
      expect(typeof data.facialRecognitionConfigured).toBe('boolean');

      // Crucial: capabilities endpoint NEVER exposes secrets, keys, or similarity scores
      expect(data.RETURNING_VISITOR_TEMPLATE_KEY).toBeUndefined();
      expect(data.RETURNING_MATCH_TOKEN_SECRET).toBeUndefined();
      expect(data.minCosine).toBeUndefined();
      expect(data.score).toBeUndefined();
    });

    it('decouples enrollment readiness from verification threshold readiness (Priority 3)', async () => {
      // Step A: Configure template key only (no match token secret, no threshold)
      process.env.RETURNING_VISITOR_TEMPLATE_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
      delete process.env.RETURNING_MATCH_TOKEN_SECRET;
      delete process.env.RETURNING_FACE_MIN_COSINE;
      delete process.env.RETURNING_FACE_THRESHOLD_MODE;

      expect(isTemplateKeyConfigured()).toBe(true);
      expect(isReturningEnrollmentAvailable()).toBe(true); // Enrollment is ready!
      expect(isReturningCryptoConfigured()).toBe(false); // Verification crypto is incomplete
      expect(isThresholdConfigured()).toBe(false);
      expect(isReturningVisitorAvailable()).toBe(false); // Verification gate remains closed

      const req = new Request('http://localhost/api/passes/capabilities', { method: 'GET' });
      const res = await capabilitiesHandler.fetch(req);
      const data = await res.json();
      expect(data.returningEnrollmentAvailable).toBe(true);
      expect(data.returningVisitorAvailable).toBe(false);
      expect(data.thresholdMode).toBe('unconfigured');
    });

    it('supports provisional threshold mode with OpenCV SFace reference value 0.363 (Priority 2 & 5)', async () => {
      process.env.RETURNING_VISITOR_TEMPLATE_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
      process.env.RETURNING_MATCH_TOKEN_SECRET = 'super-secret-match-token-secret-123';
      process.env.RETURNING_FACE_MIN_COSINE = '0.363';
      process.env.RETURNING_FACE_THRESHOLD_MODE = 'provisional';

      expect(isReturningCryptoConfigured()).toBe(true);
      expect(isThresholdConfigured()).toBe(true);
      expect(getThresholdMode()).toBe('provisional');
      expect(getResolvedCosineThreshold()).toBe(0.363);
      expect(isReturningVisitorAvailable()).toBe(true);

      const req = new Request('http://localhost/api/passes/capabilities', { method: 'GET' });
      const res = await capabilitiesHandler.fetch(req);
      const data = await res.json();
      expect(data.returningVisitorAvailable).toBe(true);
      expect(data.returningEnrollmentAvailable).toBe(true);
      expect(data.returningCryptoConfigured).toBe(true);
      expect(data.thresholdConfigured).toBe(true);
      expect(data.thresholdMode).toBe('provisional');
    });

    it('distinguishes provisional vs calibrated threshold modes cleanly', () => {
      // 1. Explicit calibrated mode
      process.env.RETURNING_FACE_MIN_COSINE = '0.45';
      process.env.RETURNING_FACE_THRESHOLD_MODE = 'calibrated';
      expect(getThresholdMode()).toBe('calibrated');
      expect(getResolvedCosineThreshold()).toBe(0.45);

      // 2. Provisional mode via env flag without explicit numeric cosine
      delete process.env.RETURNING_FACE_MIN_COSINE;
      process.env.RETURNING_FACE_THRESHOLD_MODE = 'provisional';
      expect(getThresholdMode()).toBe('provisional');
      expect(getResolvedCosineThreshold()).toBe(SFACE_PROVISIONAL_COSINE_THRESHOLD);
      expect(isThresholdConfigured()).toBe(true);

      // 3. Unconfigured mode
      delete process.env.RETURNING_FACE_THRESHOLD_MODE;
      expect(getThresholdMode()).toBe('unconfigured');
      expect(getResolvedCosineThreshold()).toBeNull();
      expect(isThresholdConfigured()).toBe(false);
    });

    it('rejects invalid or unsafe calibration values', () => {
      // Incomplete configuration (missing matchSecret)
      process.env.RETURNING_FACE_MIN_COSINE = '0.45';
      process.env.RETURNING_VISITOR_TEMPLATE_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
      delete process.env.RETURNING_MATCH_TOKEN_SECRET;
      expect(isReturningVisitorAvailable()).toBe(false);

      // Negative or out of bounds threshold
      process.env.RETURNING_FACE_MIN_COSINE = '-0.1';
      process.env.RETURNING_MATCH_TOKEN_SECRET = 'super-secret-match-token-secret-123';
      expect(isReturningVisitorAvailable()).toBe(false);

      // Threshold >= 1.0
      process.env.RETURNING_FACE_MIN_COSINE = '1.05';
      expect(isReturningVisitorAvailable()).toBe(false);

      // Short template key (< 32 chars)
      process.env.RETURNING_FACE_MIN_COSINE = '0.45';
      process.env.RETURNING_VISITOR_TEMPLATE_KEY = 'short-key';
      expect(isReturningVisitorAvailable()).toBe(false);

      // Valid configuration
      process.env.RETURNING_FACE_THRESHOLD_MODE = 'provisional';
      process.env.RETURNING_FACE_MIN_COSINE = '0.363';
      process.env.RETURNING_VISITOR_TEMPLATE_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
      expect(isReturningVisitorAvailable()).toBe(true);
    });
  });

  describe('2. OpenCV SFace Reference Specification Parity (Section 2)', () => {
    it('verifies exact reference cosine threshold and 112x112 chip reference landmarks', () => {
      // OpenCV Zoo reference cosine threshold for SFace is 0.363
      expect(SFACE_COSINE_THRESHOLD).toBe(0.363);
      expect(SFACE_PROVISIONAL_COSINE_THRESHOLD).toBe(0.363);

      // 5 canonical 2D facial landmarks on 112x112 aligned face chip
      expect(SFACE_REFERENCE_LANDMARKS).toHaveLength(5);
      expect(SFACE_REFERENCE_LANDMARKS[0]).toEqual([38.2946, 51.6963]); // right eye
      expect(SFACE_REFERENCE_LANDMARKS[1]).toEqual([73.5318, 51.5014]); // left eye
      expect(SFACE_REFERENCE_LANDMARKS[2]).toEqual([56.0252, 71.7366]); // nose tip
      expect(SFACE_REFERENCE_LANDMARKS[3]).toEqual([41.5493, 92.3655]); // right mouth corner
      expect(SFACE_REFERENCE_LANDMARKS[4]).toEqual([70.7299, 92.2041]); // left mouth corner
    });
  });

  describe('2. Biometric Template AES-256-GCM Encryption / Decryption', () => {
    const testSecret = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

    it('parses 64-char hex, 32-byte raw, or hashes fallback key', () => {
      const hexKey = parseTemplateKey(testSecret);
      expect(hexKey.length).toBe(32);

      const rawKey = parseTemplateKey('12345678901234567890123456789012');
      expect(rawKey.length).toBe(32);

      const fallbackKey = parseTemplateKey('any-other-random-passphrase');
      expect(fallbackKey.length).toBe(32);
    });

    it('encrypts and decrypts 128-d Float32Array embedding with exact fidelity', () => {
      // Generate synthetic 128-element face embedding
      const originalEmbedding = new Float32Array(128);
      for (let i = 0; i < 128; i++) {
        originalEmbedding[i] = (i - 64) * 0.0123;
      }

      const encrypted = encryptFaceTemplate(originalEmbedding, testSecret, 'v1');
      expect(encrypted.keyVersion).toBe('v1');
      expect(typeof encrypted.encryptedEmbedding).toBe('string');
      expect(encrypted.iv.length).toBe(24); // 12 bytes = 24 hex chars
      expect(encrypted.authTag.length).toBe(32); // 16 bytes = 32 hex chars

      const decrypted = decryptFaceTemplate(
        encrypted.encryptedEmbedding,
        encrypted.iv,
        encrypted.authTag,
        testSecret
      );

      expect(decrypted.length).toBe(128);
      for (let i = 0; i < 128; i++) {
        expect(Math.abs(decrypted[i]! - originalEmbedding[i]!)).toBeLessThan(1e-6);
      }
    });

    it('fails decryption closed if ciphertext or auth tag is tampered', () => {
      const originalEmbedding = new Float32Array([0.1, 0.2, 0.3, 0.4]);
      const encrypted = encryptFaceTemplate(originalEmbedding, testSecret);

      // Tamper ciphertext
      const tamperedCiphertext =
        encrypted.encryptedEmbedding.slice(0, -2) +
        (encrypted.encryptedEmbedding.slice(-2) === 'aa' ? 'bb' : 'aa');

      expect(() => {
        decryptFaceTemplate(tamperedCiphertext, encrypted.iv, encrypted.authTag, testSecret);
      }).toThrow();

      // Tamper auth tag
      const tamperedTag =
        encrypted.authTag.slice(0, -2) +
        (encrypted.authTag.slice(-2) === 'aa' ? 'bb' : 'aa');

      expect(() => {
        decryptFaceTemplate(encrypted.encryptedEmbedding, encrypted.iv, tamperedTag, testSecret);
      }).toThrow();
    });
  });

  describe('3. Cosine Similarity & Match Digest Math', () => {
    it('computes expected similarity values', () => {
      const vecA = new Float32Array([1, 0, 0]);
      const vecB = new Float32Array([1, 0, 0]);
      const vecC = new Float32Array([0, 1, 0]);
      const vecD = new Float32Array([-1, 0, 0]);

      // Identical
      expect(computeCosineSimilarity(vecA, vecB)).toBeCloseTo(1.0, 5);

      // Orthogonal
      expect(computeCosineSimilarity(vecA, vecC)).toBeCloseTo(0.0, 5);

      // Opposite
      expect(computeCosineSimilarity(vecA, vecD)).toBeCloseTo(-1.0, 5);
    });

    it('computes deterministic match token digest', () => {
      const token = 'test-token-12345';
      const secret = 'test-secret-67890';
      const digest1 = computeMatchTokenDigest(token, secret);
      const digest2 = computeMatchTokenDigest(token, secret);
      expect(digest1).toBe(digest2);
      expect(digest1.length).toBe(64); // SHA-256 hex
    });
  });

  describe('4. Guard Feed Context Key & Manila Business Date Contract', () => {
    it('computes Manila business date across UTC day boundaries', async () => {
      const { getManilaBusinessDate, getManilaDayBounds } = await import(
        '../server/routes/gate/guard-station-feed.js'
      );

      // 2026-11-02 16:30:00 UTC is 2026-11-03 00:30:00 in UTC+8 (Manila)
      const lateUtc = new Date('2026-11-02T16:30:00.000Z');
      expect(getManilaBusinessDate(lateUtc)).toBe('2026-11-03');

      // 2026-11-02 02:00:00 UTC is 2026-11-02 10:00:00 in UTC+8 (Manila)
      const morningUtc = new Date('2026-11-02T02:00:00.000Z');
      expect(getManilaBusinessDate(morningUtc)).toBe('2026-11-02');

      const bounds = getManilaDayBounds(morningUtc);
      expect(bounds.startUtc).toBe('2026-11-01T16:00:00.000Z'); // 00:00:00 Manila
      expect(bounds.endUtc).toBe('2026-11-02T15:59:59.999Z'); // 23:59:59.999 Manila
    });

    it('builds authoritative context key that detects station, gate, or business date switch', async () => {
      const { buildFeedContextKey } = await import('../src/pages/GuardPage.js');

      const key1 = buildFeedContextKey('stn-1', 'Main Gate', '2026-11-02');
      const key2 = buildFeedContextKey('stn-1', 'Main Gate', '2026-11-02');
      expect(key1).toBe(key2);
      expect(key1).toBe('stn-1:Main Gate:2026-11-02');

      // Changing gate invalidates key
      const keyGateChanged = buildFeedContextKey('stn-1', 'Service Gate', '2026-11-02');
      expect(keyGateChanged).not.toBe(key1);

      // Changing station invalidates key
      const keyStationChanged = buildFeedContextKey('stn-2', 'Main Gate', '2026-11-02');
      expect(keyStationChanged).not.toBe(key1);

      // Rollover to next business date invalidates key and forces pagination reset
      const keyDateChanged = buildFeedContextKey('stn-1', 'Main Gate', '2026-11-03');
      expect(keyDateChanged).not.toBe(key1);

      // Empty or null values are handled gracefully
      expect(buildFeedContextKey(null, null, null)).toBe('::');
    });
  });

  describe('5. Biometric Gallery Range Pagination & Safety Cap Contract', () => {
    it('simulates range pagination in 500-item chunks and enforces 5,000 item safety ceiling', () => {
      const PAGE_SIZE = 500;
      const MAX_GALLERY_TEMPLATES = 5000;

      // Simulate gallery database of 6,200 templates
      const totalDbTemplates = 6200;
      const mockDatabase = Array.from({ length: totalDbTemplates }, (_, idx) => ({
        id: `tpl-${idx + 1}`,
        profile_id: `prof-${idx + 1}`,
      }));

      // Emulate the exact query pagination loop used in identify-returning.ts
      let from = 0;
      let hasMore = true;
      const loadedTemplates: typeof mockDatabase = [];

      while (hasMore && loadedTemplates.length < MAX_GALLERY_TEMPLATES) {
        const remainingCapacity = MAX_GALLERY_TEMPLATES - loadedTemplates.length;
        const currentLimit = Math.min(PAGE_SIZE, remainingCapacity);
        const to = from + currentLimit - 1;

        const pageData = mockDatabase.slice(from, to + 1);

        if (!pageData || pageData.length === 0) {
          hasMore = false;
          break;
        }

        loadedTemplates.push(...pageData);
        if (pageData.length < currentLimit) {
          hasMore = false;
          break;
        }
        from += currentLimit;
      }

      // Assert loaded exactly safety ceiling, not unbounded memory consumption
      expect(loadedTemplates.length).toBe(MAX_GALLERY_TEMPLATES);
      expect(loadedTemplates[0]!.id).toBe('tpl-1');
      expect(loadedTemplates[4999]!.id).toBe('tpl-5000');
    });
  });

  describe('6. Identify Returning Endpoint Contract', () => {
    it('rejects non-POST HTTP methods with 405 Method Not Allowed', async () => {
      const identifyHandler = (await import('../server/routes/passes/identify-returning.js')).default;
      const getReq = new Request('http://localhost/api/passes/identify-returning', {
        method: 'GET',
      });
      const res = await identifyHandler.fetch(getReq);
      expect(res.status).toBe(405);
      const json = await res.json();
      expect(json.error).toBe('method_not_allowed');
    });

    it('rejects unauthenticated requests with 401', async () => {
      const identifyHandler = (await import('../server/routes/passes/identify-returning.js')).default;
      const unauthReq = new Request('http://localhost/api/passes/identify-returning', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          requestId: 'b0e00000-0000-4000-8000-000000000001',
          photoIntentId: 'b0e00000-0000-4000-8000-000000000002',
        }),
      });
      const res = await identifyHandler.fetch(unauthReq);
      expect(res.status).toBe(401);
      const json = await res.json();
      expect(json.error).toBe('authentication_required');
    });

    it('rejects invalid JSON or malformed schema with 400', async () => {
      const identifyHandler = (await import('../server/routes/passes/identify-returning.js')).default;
      const malformedReq = new Request('http://localhost/api/passes/identify-returning', {
        method: 'POST',
        headers: {
          authorization: 'Bearer dummy-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          requestId: 'not-a-uuid',
        }),
      });
      const res = await identifyHandler.fetch(malformedReq);
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toBe('invalid_request');
    });
  });

  describe('6. 1:1 Biometric Pairwise Calibration Contract', () => {
    it('computes 1:1 pairwise genuine and impostor distributions, FAR, FRR, and EER correctly', async () => {
      const {
        computeCosineSimilarity: calCosine,
        computeDistributionStats,
        evaluatePairwiseMetrics,
      } = await import('../scripts/calibrate-returning-face.mjs');

      // Test identical vector
      const v1 = new Float32Array([1, 0, 0]);
      const v2 = new Float32Array([1, 0, 0]);
      expect(calCosine(v1, v2)).toBeCloseTo(1.0, 4);

      // Test orthogonal vector
      const v3 = new Float32Array([0, 1, 0]);
      expect(calCosine(v1, v3)).toBeCloseTo(0.0, 4);

      // Test distribution stats
      const scores = [0.4, 0.5, 0.6, 0.7, 0.8];
      const stats = computeDistributionStats(scores);
      expect(stats.count).toBe(5);
      expect(stats.mean).toBe(0.6);
      expect(stats.min).toBe(0.4);
      expect(stats.max).toBe(0.8);
      expect(stats.p50).toBe(0.6);

      // Test pairwise FAR/FRR sweep with clear separation
      const genuine = [0.55, 0.60, 0.65, 0.70];
      const impostor = [0.10, 0.15, 0.20, 0.25];
      const evaluation = evaluatePairwiseMetrics(genuine, impostor);
      expect(evaluation.table.length).toBeGreaterThan(0);
      // EER threshold should lie between highest impostor (0.25) and lowest genuine (0.55)
      expect(evaluation.eerThreshold).toBeGreaterThanOrEqual(0.30);
      expect(evaluation.eerThreshold).toBeLessThanOrEqual(0.56);
    });
  });

  describe('7. Secrets Generator and Safe Masking Contract (Priority 4)', () => {
    it('generates 32-byte 64-char hex cryptographically random keys and secrets', () => {
      const secrets = generateCryptoSecrets();
      expect(secrets.templateKey).toHaveLength(64);
      expect(/^[0-9a-f]{64}$/.test(secrets.templateKey)).toBe(true);

      expect(secrets.matchSecret).toHaveLength(64);
      expect(/^[0-9a-f]{64}$/.test(secrets.matchSecret)).toBe(true);

      expect(secrets.minCosine).toBe('0.363');
      expect(secrets.thresholdMode).toBe('provisional');
      expect(secrets.keyVersion).toBe('v1');

      // Two consecutive generations must produce distinct keys (entropy check)
      const second = generateCryptoSecrets();
      expect(secrets.templateKey).not.toBe(second.templateKey);
      expect(secrets.matchSecret).not.toBe(second.matchSecret);
    });

    it('masks secret summaries safely without printing raw key bytes', () => {
      const summary = maskSecretSummary('0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef');
      expect(summary).toContain('length=64');
      expect(summary).toContain('sha256_prefix=');
      expect(summary).not.toContain('0123456789abcdef');

      expect(maskSecretSummary(undefined)).toBe('missing');
    });
  });
});
