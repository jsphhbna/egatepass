import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  parseTemplateKey,
  encryptFaceTemplate,
  decryptFaceTemplate,
  computeCosineSimilarity,
} from '../server/lib/face-engine.js';
import {
  isReturningVisitorAvailable,
  computeMatchTokenDigest,
} from '../server/routes/passes/identify-returning.js';
import capabilitiesHandler from '../server/routes/passes/capabilities.js';

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
      delete process.env.RETURNING_FACE_MIN_MARGIN;
      delete process.env.RETURNING_VISITOR_TEMPLATE_KEY;
      delete process.env.RETURNING_MATCH_TOKEN_SECRET;

      expect(isReturningVisitorAvailable()).toBe(false);

      const req = new Request('http://localhost/api/passes/capabilities', { method: 'GET' });
      const res = await capabilitiesHandler.fetch(req);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.returningVisitorAvailable).toBe(false);
      expect(data.facialRecognitionConfigured).toBe(false);
    });

    it('rejects invalid or unsafe calibration values', () => {
      // Incomplete configuration
      process.env.RETURNING_FACE_MIN_COSINE = '0.45';
      delete process.env.RETURNING_FACE_MIN_MARGIN;
      expect(isReturningVisitorAvailable()).toBe(false);

      // Negative or out of bounds threshold
      process.env.RETURNING_FACE_MIN_COSINE = '-0.1';
      process.env.RETURNING_FACE_MIN_MARGIN = '0.05';
      process.env.RETURNING_VISITOR_TEMPLATE_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
      process.env.RETURNING_MATCH_TOKEN_SECRET = 'super-secret-match-token-secret-123';
      expect(isReturningVisitorAvailable()).toBe(false);

      // Short template key (< 32 chars)
      process.env.RETURNING_FACE_MIN_COSINE = '0.45';
      process.env.RETURNING_VISITOR_TEMPLATE_KEY = 'short-key';
      expect(isReturningVisitorAvailable()).toBe(false);

      // Valid configuration
      process.env.RETURNING_VISITOR_TEMPLATE_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
      expect(isReturningVisitorAvailable()).toBe(true);
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
});
