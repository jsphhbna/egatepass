import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'node:crypto';
import {
  verifyCalibrationArtifact,
  signCalibrationArtifact,
  CalibrationArtifactData,
  PINNED_CALIBRATION_PUBLIC_KEY,
} from '../server/lib/calibration-verifier.js';
import identifyReturningHandler, {
  getThresholdMode,
  getResolvedCosineThreshold,
  SFACE_PROVISIONAL_COSINE_THRESHOLD,
} from '../server/routes/passes/identify-returning.js';
import returningPhotoPreviewHandler from '../server/routes/passes/returning-photo-preview.js';
import returningIdPreviewHandler from '../server/routes/passes/returning-id-preview.js';
import * as supabaseModule from '../server/supabase.js';
import * as actorsModule from '../server/actors.js';

describe('Calibration Artifact Cryptographic Verifier & Provisional Mode Boundary', () => {
  const originalEnv = { ...process.env };
  const mockActorId = '11111111-1111-4111-8111-111111111111';
  const mockProfileId = '22222222-2222-4222-8222-222222222222';
  const mockRequestId = '33333333-3333-4333-8333-333333333333';
  const mockSecret = 'test-token-secret-must-be-at-least-32-chars-long!';

  // Generate ephemeral test keypair for test signing
  let testKeyPair: crypto.KeyPairSyncResult<string, string>;

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      RETURNING_MATCH_TOKEN_SECRET: mockSecret,
      RATE_LIMIT_HMAC_SECRET: mockSecret,
      RETURNING_FACE_THRESHOLD_MODE: 'provisional',
    };
    testKeyPair = crypto.generateKeyPairSync('ed25519', {
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    vi.restoreAllMocks();
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  const validArtifactTemplate: CalibrationArtifactData = {
    schemaVersion: '1.0.0',
    issuer: 'EARIST_BIOMETRICS_CALIBRATION_AUTHORITY',
    calibrationVersion: '2026.11.01-earist-v1',
    model: 'yunet_sface',
    engine: 'onnxruntime-node',
    minCosineThreshold: 0.42,
    minMargin: 0.05,
    dataset: {
      population: 'EARIST student and faculty cohort',
      sampleSize: 500,
      falseAcceptRate: 0.001,
      falseRejectRate: 0.015,
    },
    issuedAt: new Date(Date.now() - 86400000).toISOString(),
    expiresAt: new Date(Date.now() + 86400000 * 30).toISOString(),
    revokedVersions: [],
  };

  describe('1. Cryptographic Envelope & Field Verification', () => {
    it('fails closed when artifact is missing or empty', () => {
      expect(verifyCalibrationArtifact(null).error).toBe('missing_calibration_artifact');
      expect(verifyCalibrationArtifact('').error).toBe('missing_calibration_artifact');
      expect(verifyCalibrationArtifact('   ').error).toBe('missing_calibration_artifact');
    });

    it('fails closed when input is not valid JSON (e.g. plain version string or raw text)', () => {
      const res = verifyCalibrationArtifact('v1.0.0');
      expect(res.valid).toBe(false);
      expect(res.error).toBe('invalid_artifact_json');
    });

    it('fails closed when JSON does not conform to SignedCalibrationEnvelopeSchema', () => {
      const bareObject = JSON.stringify({ version: '1.0.0', threshold: 0.42 });
      const res = verifyCalibrationArtifact(bareObject);
      expect(res.valid).toBe(false);
      expect(res.error).toBe('invalid_schema');
    });

    it('rejects untrusted calibration issuer', () => {
      const invalidIssuerArtifact: CalibrationArtifactData = {
        ...validArtifactTemplate,
        issuer: 'UNTRUSTED_THIRD_PARTY' as any,
      };
      const signedJson = signCalibrationArtifact(invalidIssuerArtifact, testKeyPair.privateKey);
      const res = verifyCalibrationArtifact(signedJson, 'yunet_sface', 'onnxruntime-node', testKeyPair.publicKey);
      expect(res.valid).toBe(false);
      expect(res.error).toBe('invalid_schema'); // Zod schema enforces literal
    });

    it('rejects model mismatch', () => {
      const wrongModelArtifact: CalibrationArtifactData = {
        ...validArtifactTemplate,
        model: 'yunet_sface',
      };
      const signedJson = signCalibrationArtifact(wrongModelArtifact, testKeyPair.privateKey);
      const res = verifyCalibrationArtifact(signedJson, 'facenet512', 'onnxruntime-node', testKeyPair.publicKey);
      expect(res.valid).toBe(false);
      expect(res.error).toBe('wrong_model');
    });

    it('rejects engine mismatch', () => {
      const signedJson = signCalibrationArtifact(validArtifactTemplate, testKeyPair.privateKey);
      const res = verifyCalibrationArtifact(signedJson, 'yunet_sface', 'tensorrt', testKeyPair.publicKey);
      expect(res.valid).toBe(false);
      expect(res.error).toBe('wrong_engine');
    });

    it('rejects expired calibration artifact', () => {
      const expiredArtifact: CalibrationArtifactData = {
        ...validArtifactTemplate,
        expiresAt: new Date(Date.now() - 3600000).toISOString(), // Expired 1 hour ago
      };
      const signedJson = signCalibrationArtifact(expiredArtifact, testKeyPair.privateKey);
      const res = verifyCalibrationArtifact(signedJson, 'yunet_sface', 'onnxruntime-node', testKeyPair.publicKey);
      expect(res.valid).toBe(false);
      expect(res.error).toBe('expired_artifact');
    });

    it('rejects revoked calibration version', () => {
      const revokedArtifact: CalibrationArtifactData = {
        ...validArtifactTemplate,
        calibrationVersion: 'v1.0-revoked',
        revokedVersions: ['v1.0-revoked', 'v0.9-alpha'],
      };
      const signedJson = signCalibrationArtifact(revokedArtifact, testKeyPair.privateKey);
      const res = verifyCalibrationArtifact(signedJson, 'yunet_sface', 'onnxruntime-node', testKeyPair.publicKey);
      expect(res.valid).toBe(false);
      expect(res.error).toBe('revoked_artifact');
    });

    it('rejects tampered threshold (digital signature mismatch)', () => {
      const signedJson = signCalibrationArtifact(validArtifactTemplate, testKeyPair.privateKey);
      const parsed = JSON.parse(signedJson);

      // Malicious attacker tampers with threshold to make face matching artificially easy
      parsed.artifact.minCosineThreshold = 0.10;

      const tamperedJson = JSON.stringify(parsed);
      const res = verifyCalibrationArtifact(tamperedJson, 'yunet_sface', 'onnxruntime-node', testKeyPair.publicKey);
      expect(res.valid).toBe(false);
      expect(res.error).toBe('invalid_signature');
    });

    it('successfully verifies authentic signed envelope with matching public key', () => {
      const signedJson = signCalibrationArtifact(validArtifactTemplate, testKeyPair.privateKey);
      const res = verifyCalibrationArtifact(signedJson, 'yunet_sface', 'onnxruntime-node', testKeyPair.publicKey);
      expect(res.valid).toBe(true);
      expect(res.artifact?.minCosineThreshold).toBe(0.42);
      expect(res.artifact?.calibrationVersion).toBe('2026.11.01-earist-v1');
    });
  });

  describe('2. Runtime Calibrated vs Provisional Biometric Safety Boundaries', () => {
    it('enforces provisional mode by default with cosine threshold 0.363', () => {
      delete process.env.RETURNING_FACE_THRESHOLD_MODE;
      delete process.env.RETURNING_FACE_MIN_COSINE;
      process.env.RETURNING_FACE_THRESHOLD_MODE = 'provisional';

      expect(getThresholdMode()).toBe('provisional');
      expect(getResolvedCosineThreshold()).toBe(SFACE_PROVISIONAL_COSINE_THRESHOLD);
      expect(SFACE_PROVISIONAL_COSINE_THRESHOLD).toBe(0.363);
    });

    it('fails closed gracefully if explicit calibrated mode lacks authentic signed artifact', async () => {
      process.env.RETURNING_FACE_THRESHOLD_MODE = 'calibrated';
      delete process.env.RETURNING_FACE_CALIBRATION_ARTIFACT;
      delete process.env.RETURNING_FACE_MIN_COSINE;

      vi.spyOn(actorsModule, 'getVerifiedSessionContext').mockResolvedValue({
        actorId: mockActorId,
        role: 'visitor',
        isAnonymous: true,
        isRecoverySession: false,
        user: { id: mockActorId },
        identity: 'test-user',
      } as any);

      vi.spyOn(supabaseModule, 'getServerSupabaseClients').mockReturnValue({
        admin: {} as any,
        anon: {} as any,
        client: {} as any,
      });

      const req = new Request('http://localhost/api/passes/identify-returning', {
        method: 'POST',
        headers: {
          authorization: 'Bearer token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          requestId: mockRequestId,
          profileId: mockProfileId,
          photoIntentId: '44444444-4444-4444-8444-444444444444',
        }),
      });

      const res = await identifyReturningHandler.fetch(req);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.available).toBe(false);
      expect(json.matched).toBe(false);
    });

    it('strictly denies historical ID preview access in provisional mode on returning-photo-preview', async () => {
      vi.spyOn(actorsModule, 'getVerifiedSessionContext').mockResolvedValue({
        actorId: mockActorId,
        role: 'visitor',
        isAnonymous: true,
        isRecoverySession: false,
        user: { id: mockActorId },
        identity: 'test-user',
      } as any);

      const mockAdmin = {
        from: vi.fn().mockImplementation((table: string) => {
          if (table === 'returning_identity_attempts') {
            return {
              select: vi.fn().mockReturnThis(),
              eq: vi.fn().mockReturnThis(),
              gt: vi.fn().mockReturnThis(),
              order: vi.fn().mockReturnThis(),
              limit: vi.fn().mockReturnThis(),
              maybeSingle: vi.fn().mockResolvedValue({
                data: {
                  id: 'attempt-prov',
                  owner_id: mockActorId,
                  matched_profile_id: mockProfileId,
                  outcome: 'provisional_matched',
                  threshold_mode: 'provisional',
                  expires_at: new Date(Date.now() + 300000).toISOString(),
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

      const req = new Request(
        `http://localhost/api/passes/returning-photo-preview?profileId=${mockProfileId}&token=test-match-token&kind=id`,
        {
          method: 'GET',
          headers: {
            authorization: 'Bearer token',
          },
        }
      );

      const res = await returningPhotoPreviewHandler.fetch(req);
      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.error).toBe('provisional_mode_cannot_authorize_id_access');
    });

    it('strictly denies historical ID preview access in provisional mode on returning-id-preview', async () => {
      vi.spyOn(actorsModule, 'getVerifiedSessionContext').mockResolvedValue({
        actorId: mockActorId,
        role: 'visitor',
        isAnonymous: true,
        isRecoverySession: false,
        user: { id: mockActorId },
        identity: 'test-user',
      } as any);

      const mockAdmin = {
        from: vi.fn().mockImplementation((table: string) => {
          if (table === 'returning_identity_attempts') {
            return {
              select: vi.fn().mockReturnThis(),
              eq: vi.fn().mockReturnThis(),
              gt: vi.fn().mockReturnThis(),
              order: vi.fn().mockReturnThis(),
              limit: vi.fn().mockReturnThis(),
              maybeSingle: vi.fn().mockResolvedValue({
                data: {
                  id: 'attempt-prov',
                  owner_id: mockActorId,
                  matched_profile_id: mockProfileId,
                  outcome: 'provisional_matched',
                  threshold_mode: 'provisional',
                  expires_at: new Date(Date.now() + 300000).toISOString(),
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

      const req = new Request(
        `http://localhost/api/passes/returning-id-preview?profileId=${mockProfileId}&requestId=${mockRequestId}&matchToken=test-match-token`,
        {
          method: 'GET',
          headers: {
            authorization: 'Bearer token',
          },
        }
      );

      const res = await returningIdPreviewHandler.fetch(req);
      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.error).toBe('provisional_mode_cannot_authorize_id_access');
    });
  });
});
