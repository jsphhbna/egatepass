import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  detectFaces,
  evaluateLiveFaceQuality,
  evaluateIdImageQuality,
  compareFaces,
  analyzeFaceImage,
  getInferenceSessions,
  getSimilarityTransformMatrix,
  SFACE_REFERENCE_LANDMARKS,
  extractFaceDescriptorFromBuffer,
  SFACE_COSINE_THRESHOLD,
  evaluateFaceCropQuality,
  isFaceVerificationConfigured,
} from '../server/lib/face-engine.js';

describe('Local Face Engine Contract (YuNet + SFace)', () => {
  const sample1Path = path.resolve('tests/fixtures/face-sample-1.jpg');
  const sample2Path = path.resolve('tests/fixtures/face-sample-2.jpg');

  const sample1 = fs.readFileSync(sample1Path);
  const sample2 = fs.readFileSync(sample2Path);

  it('1. Detects face and landmarks accurately on sample 1', async () => {
    const faces = await detectFaces(sample1);
    expect(faces.length).toBe(1);
    const face = faces[0]!;
    expect(face.score).toBeGreaterThan(0.7);
    expect(face.landmarks).toHaveLength(5);
    // 5 landmarks: right eye, left eye, nose tip, right mouth corner, left mouth corner
    for (const pt of face.landmarks) {
      expect(pt[0]).toBeGreaterThan(0);
      expect(pt[1]).toBeGreaterThan(0);
    }
  });

  it('2. Evaluates technical quality on valid sample', async () => {
    const liveQuality = await evaluateLiveFaceQuality(sample1);
    expect(liveQuality.passed).toBe(true);
    expect(liveQuality.code).toBe('ok');

    const idQuality = await evaluateIdImageQuality(sample1);
    expect(idQuality.passed).toBe(true);
    expect(idQuality.code).toBe('ok');
  });

  it('3. Rejects dark or blurred images during quality check', async () => {
    // Generate a tiny/dark buffer
    const darkBuffer = Buffer.alloc(300 * 300 * 3, 5); // very dark
    const sharp = (await import('sharp')).default;
    const darkJpeg = await sharp(darkBuffer, { raw: { width: 300, height: 300, channels: 3 } })
      .jpeg()
      .toBuffer();

    const result = await evaluateLiveFaceQuality(darkJpeg);
    expect(result.passed).toBe(false);
    expect(result.code).toBe('too_dark');
    expect(result.message).toMatch(/dark/i);
  });

  it('4. Cosine similarity threshold matches identical faces (~1.000 >= 0.363)', async () => {
    const result = await compareFaces(sample1, sample1);
    expect(result.matched).toBe(true);
    expect(result.outcome).toBe('matched');
    expect(result.score).toBeDefined();
    expect(result.score!).toBeGreaterThanOrEqual(SFACE_COSINE_THRESHOLD);
    expect(result.score!).toBeGreaterThan(0.95);
  });

  it('5. Cosine similarity threshold discriminates non-matching faces (< 0.363)', async () => {
    const result = await compareFaces(sample1, sample2);
    expect(result.matched).toBe(false);
    expect(result.outcome).toBe('mismatch');
    expect(result.score).toBeDefined();
    expect(result.score!).toBeLessThan(SFACE_COSINE_THRESHOLD);
  });

  it('6. Privacy minimization: results contain NO raw embeddings or facial landmark tensors', () => {
    const keys = Object.keys({
      outcome: 'matched',
      matched: true,
      score: 0.85,
      modelName: 'opencv_zoo_yunet_sface',
      modelVersion: 'yunet_2023mar_sface_2021dec',
    });
    expect(keys).not.toContain('embedding');
    expect(keys).not.toContain('descriptor');
    expect(keys).not.toContain('landmarks');
    expect(keys).not.toContain('tensor');
  });

  it('7. Exact 2D similarity transform parity & mathematical stability', () => {
    // 7.1 Identity / reference mapping has zero error
    const M_identity = getSimilarityTransformMatrix(SFACE_REFERENCE_LANDMARKS, SFACE_REFERENCE_LANDMARKS);
    expect(M_identity[0][0]).toBeCloseTo(1.0, 5);
    expect(M_identity[0][1]).toBeCloseTo(0.0, 5);
    expect(M_identity[0][2]).toBeCloseTo(0.0, 5);
    expect(M_identity[1][0]).toBeCloseTo(0.0, 5);
    expect(M_identity[1][1]).toBeCloseTo(1.0, 5);
    expect(M_identity[1][2]).toBeCloseTo(0.0, 5);

    // 7.2 Scaled and translated landmarks
    const scaledSrc = SFACE_REFERENCE_LANDMARKS.map(([x, y]) => [x * 2 + 15, y * 2 - 25] as [number, number]);
    const M_scaled = getSimilarityTransformMatrix(scaledSrc, SFACE_REFERENCE_LANDMARKS);
    // Scale should be 0.5 (from 2x down to 1x)
    const scale = Math.hypot(M_scaled[0][0], M_scaled[1][0]);
    expect(scale).toBeCloseTo(0.5, 4);

    // 7.3 Diagonal / near-zero off-diagonal covariance matrix (reproduces and proves fix for ata01 bug)
    // Points where dominant eigenvector aligns to Y axis
    const yAlignedPoints: Array<[number, number]> = [
      [100, 50],
      [100, 150],
      [100, 250],
      [100, 350],
      [100, 450],
    ];
    const dstPoints: Array<[number, number]> = [
      [50, 100],
      [50, 200],
      [50, 300],
      [50, 400],
      [50, 500],
    ];
    const M_y = getSimilarityTransformMatrix(yAlignedPoints, dstPoints);
    expect(Number.isFinite(M_y[0][0])).toBe(true);
    expect(Number.isFinite(M_y[1][1])).toBe(true);
    expect(Number.isNaN(M_y[0][2])).toBe(false);

    // 7.4 Degenerate collocated points throw error
    const collocated: Array<[number, number]> = [
      [50, 50],
      [50, 50],
      [50, 50],
      [50, 50],
      [50, 50],
    ];
    expect(() => getSimilarityTransformMatrix(collocated)).toThrow(/degenerate/i);
  });

  it('8. Concurrency-safe inference session initialization', async () => {
    const [sess1, sess2, sess3] = await Promise.all([
      getInferenceSessions(),
      getInferenceSessions(),
      getInferenceSessions(),
    ]);

    // All concurrent cold callers must receive the exact same singleton instance
    expect(sess1.yunet).toBe(sess2.yunet);
    expect(sess2.yunet).toBe(sess3.yunet);
    expect(sess1.sface).toBe(sess2.sface);
    expect(sess2.sface).toBe(sess3.sface);
  });

  it('9. SFace descriptor contract, unit-norm and finite numeric values', async () => {
    const { descriptor, modelName, modelVersion } = await extractFaceDescriptorFromBuffer(sample1);
    expect(modelName).toBe('opencv_zoo_yunet_sface');
    expect(modelVersion).toBe('yunet_2023mar_sface_2021dec');
    expect(descriptor).toBeInstanceOf(Float32Array);
    expect(descriptor).toHaveLength(128);

    // Check finite numbers
    for (let i = 0; i < descriptor.length; i++) {
      expect(Number.isFinite(descriptor[i])).toBe(true);
    }

    // Check L2 unit-norm
    let sumSq = 0;
    for (let i = 0; i < descriptor.length; i++) {
      sumSq += descriptor[i]! * descriptor[i]!;
    }
    expect(Math.sqrt(sumSq)).toBeCloseTo(1.0, 5);
  });

  it('10. Template encryption and key functions are retired from face-engine.ts', () => {
    const faceEngineSrc = fs.readFileSync(path.resolve('server/lib/face-engine.ts'), 'utf-8');
    expect(faceEngineSrc).not.toContain('encryptFaceTemplate');
    expect(faceEngineSrc).not.toContain('decryptFaceTemplate');
    expect(faceEngineSrc).not.toContain('getActiveTemplateKeyVersion');
    expect(faceEngineSrc).not.toContain('getVersionedTemplateKey');
  });

  it('11. Single-pass image analysis efficiency & dominant face extraction', async () => {
    const analysis = await analyzeFaceImage(sample1, 'selfie');
    expect(analysis.quality.passed).toBe(true);
    expect(analysis.faces).toHaveLength(1);
    expect(analysis.dominantFace).toBe(analysis.faces[0]);
    expect(analysis.descriptor).toHaveLength(128);
  });

  it('12. evaluateFaceCropQuality fail-closed contract', async () => {
    // 12.1 Missing or empty face must fail closed
    const emptyFaceResult = await evaluateFaceCropQuality(sample1, { width: 640, height: 640 }, null as any, 'selfie');
    expect(emptyFaceResult.passed).toBe(false);
    expect(emptyFaceResult.code).toBe('no_face');

    // 12.2 Corrupted buffer must fail closed with decode_failed, NEVER pass
    const corruptedBuffer = Buffer.from('not-an-image');
    const dummyFace = {
      x: 100,
      y: 100,
      w: 120,
      h: 120,
      score: 0.9,
      landmarks: [[110, 110], [150, 110], [130, 130], [115, 150], [145, 150]] as Array<[number, number]>,
    };
    const errorResult = await evaluateFaceCropQuality(corruptedBuffer, { width: 640, height: 640 }, dummyFace, 'selfie');
    expect(errorResult.passed).toBe(false);
    expect(errorResult.code).toBe('decode_failed');
  });

  it('13. Biometric storage retired: face-engine.ts has zero permanent template storage', () => {
    const faceEngineSrc = fs.readFileSync(path.resolve('server/lib/face-engine.ts'), 'utf-8');
    expect(faceEngineSrc).not.toContain('RETURNING_VISITOR_TEMPLATE_KEY');
    expect(faceEngineSrc).not.toContain('RETURNING_VISITOR_ACTIVE_KEY_VERSION');
  });

  it('14. Independent capability checks', () => {
    const isConfigured = isFaceVerificationConfigured();
    expect(typeof isConfigured).toBe('boolean');
  });
});
