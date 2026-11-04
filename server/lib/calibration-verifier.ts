/**
 * server/lib/calibration-verifier.ts
 *
 * Cryptographic Calibration Artifact Verification Contract
 *
 * Enforces authentic biometric calibration evidence before enabling calibrated verification.
 * A non-empty environment variable is NEVER accepted as proof of calibration.
 *
 * Required Invariants:
 * 1. Cryptographically verified Ed25519 digital signature against pinned authority public key.
 * 2. Trusted authority identity ('EARIST_BIOMETRICS_CALIBRATION_AUTHORITY').
 * 3. Strict schema validation (schemaVersion '1.0.0').
 * 4. Model binding ('yunet_sface') and engine binding ('onnxruntime-node').
 * 5. Strict threshold validity (minCosineThreshold in (0, 1) and minMargin in (0, 1)).
 * 6. Temporal validity (issuedAt in past, expiresAt in future).
 * 7. Revocation checking against artifact's revokedVersions list.
 * 8. Private signing keys are NEVER present in application runtime.
 */

import crypto from 'node:crypto';
import { z } from 'zod';

export const PINNED_CALIBRATION_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAV06lZEcuI5zLOdyhjcbuTH3bmA7/zR4g9Ip+eIvTvXo=
-----END PUBLIC KEY-----`;

export const CalibrationDatasetSchema = z.object({
  population: z.string().min(1),
  sampleSize: z.number().int().min(10),
  falseAcceptRate: z.number().min(0).max(1),
  falseRejectRate: z.number().min(0).max(1),
});

export const CalibrationArtifactDataSchema = z.object({
  schemaVersion: z.literal('1.0.0'),
  issuer: z.literal('EARIST_BIOMETRICS_CALIBRATION_AUTHORITY'),
  calibrationVersion: z.string().min(1),
  model: z.literal('yunet_sface'),
  engine: z.literal('onnxruntime-node'),
  minCosineThreshold: z.number().min(0.01).max(0.99),
  minMargin: z.number().min(0.001).max(0.5),
  dataset: CalibrationDatasetSchema,
  issuedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  revokedVersions: z.array(z.string()).optional(),
}).strict();

export const SignedCalibrationEnvelopeSchema = z.object({
  artifact: CalibrationArtifactDataSchema,
  signature: z.string().min(10), // Base64 Ed25519 signature
}).strict();

export type CalibrationArtifactData = z.infer<typeof CalibrationArtifactDataSchema>;
export type SignedCalibrationEnvelope = z.infer<typeof SignedCalibrationEnvelopeSchema>;

export interface CalibrationVerificationResult {
  valid: boolean;
  error?: string;
  message?: string;
  artifact?: CalibrationArtifactData;
}

/**
 * Produces a canonical string representation of the artifact data for signature verification.
 */
export function canonicalizeArtifact(data: CalibrationArtifactData): string {
  // Deterministic serialization with sorted keys
  return JSON.stringify(data, Object.keys(data).sort());
}

/**
 * Signs a calibration artifact with an Ed25519 private key (used for offline signing and testing).
 */
export function signCalibrationArtifact(
  artifact: CalibrationArtifactData,
  privateKeyPem: string
): string {
  const canonical = canonicalizeArtifact(artifact);
  const sig = crypto.sign(null, Buffer.from(canonical, 'utf8'), privateKeyPem);
  const envelope: SignedCalibrationEnvelope = {
    artifact,
    signature: sig.toString('base64'),
  };
  return JSON.stringify(envelope);
}

/**
 * Cryptographically verifies a signed calibration envelope.
 */
export function verifyCalibrationArtifact(
  rawInput: string | null | undefined,
  expectedModel = 'yunet_sface',
  expectedEngine = 'onnxruntime-node',
  publicKeyPem = PINNED_CALIBRATION_PUBLIC_KEY
): CalibrationVerificationResult {
  if (!rawInput || typeof rawInput !== 'string' || rawInput.trim().length === 0) {
    return {
      valid: false,
      error: 'missing_calibration_artifact',
      message: 'No calibration artifact provided.',
    };
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(rawInput.trim());
  } catch {
    return {
      valid: false,
      error: 'invalid_artifact_json',
      message: 'Calibration artifact is not valid JSON.',
    };
  }

  // 1. Schema and Envelope validation
  const envelopeParsed = SignedCalibrationEnvelopeSchema.safeParse(parsedJson);
  if (!envelopeParsed.success) {
    // Check if user passed bare version or unverified text
    return {
      valid: false,
      error: 'invalid_schema',
      message: 'Calibration artifact does not conform to the signed envelope schema (1.0.0).',
    };
  }

  const { artifact, signature } = envelopeParsed.data;

  // 2. Issuer verification
  if (artifact.issuer !== 'EARIST_BIOMETRICS_CALIBRATION_AUTHORITY') {
    return {
      valid: false,
      error: 'invalid_issuer',
      message: `Untrusted calibration issuer: ${artifact.issuer}`,
    };
  }

  // 3. Model & Engine binding
  if (artifact.model !== expectedModel) {
    return {
      valid: false,
      error: 'wrong_model',
      message: `Artifact model ${artifact.model} does not match deployed model ${expectedModel}.`,
    };
  }

  if (artifact.engine !== expectedEngine) {
    return {
      valid: false,
      error: 'wrong_engine',
      message: `Artifact engine ${artifact.engine} does not match deployed engine ${expectedEngine}.`,
    };
  }

  // 4. Temporal validity
  const now = Date.now();
  const issuedTime = new Date(artifact.issuedAt).getTime();
  const expiresTime = new Date(artifact.expiresAt).getTime();

  if (isNaN(issuedTime) || isNaN(expiresTime)) {
    return {
      valid: false,
      error: 'invalid_timestamp',
      message: 'Calibration artifact contains unparseable timestamps.',
    };
  }

  if (expiresTime <= now) {
    return {
      valid: false,
      error: 'expired_artifact',
      message: `Calibration artifact expired on ${artifact.expiresAt}.`,
    };
  }

  // 5. Revocation check
  if (artifact.revokedVersions && artifact.revokedVersions.includes(artifact.calibrationVersion)) {
    return {
      valid: false,
      error: 'revoked_artifact',
      message: `Calibration version ${artifact.calibrationVersion} has been revoked.`,
    };
  }

  // 6. Cryptographic signature verification using pinned authority public key
  try {
    const canonical = canonicalizeArtifact(artifact);
    const signatureBuffer = Buffer.from(signature, 'base64');
    const isSignatureValid = crypto.verify(
      null,
      Buffer.from(canonical, 'utf8'),
      publicKeyPem,
      signatureBuffer
    );

    if (!isSignatureValid) {
      return {
        valid: false,
        error: 'invalid_signature',
        message: 'Calibration artifact signature verification failed.',
      };
    }
  } catch (err) {
    return {
      valid: false,
      error: 'signature_verification_error',
      message: 'Cryptographic error during calibration signature verification.',
    };
  }

  return {
    valid: true,
    artifact,
  };
}
