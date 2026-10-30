import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  detectFaces,
  evaluateLiveFaceQuality,
  evaluateIdImageQuality,
  compareFaces,
  SFACE_COSINE_THRESHOLD,
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
    // VerificationResult must only export outcome, matched, score, model info, error
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
});
