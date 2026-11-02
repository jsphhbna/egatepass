import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import {
  evaluateFaceCropQuality,
  analyzeFaceImage,
  type DetectedFace,
} from '../server/lib/face-engine.js';

describe('EXIF Orientation Normalization & Bounds Correctness (Priority 5)', () => {
  // Helper to generate a solid image buffer with specified dimensions and EXIF orientation
  async function makeImageWithExif(width: number, height: number, orientation: number): Promise<Buffer> {
    return sharp({
      create: {
        width,
        height,
        channels: 3,
        background: { r: 128, g: 128, b: 128 },
      },
    })
      .jpeg()
      .withMetadata({ orientation })
      .toBuffer();
  }

  describe('1. EXIF orientation normalization across standard orientations (1, 3, 6, 8)', () => {
    it('normalizes EXIF orientation 6 (90 deg CW, height/width swapped)', async () => {
      // 300x500 image with orientation 6 -> normalized becomes 500x300
      const raw = await makeImageWithExif(300, 500, 6);
      const rotated = await sharp(raw).rotate().toBuffer();
      const meta = await sharp(rotated).metadata();
      expect(meta.width).toBe(500);
      expect(meta.height).toBe(300);

      // analyzeFaceImage normalizes orientation and decodes without decode_failed
      const analysis = await analyzeFaceImage(raw, 'selfie');
      expect(analysis.quality.code).not.toBe('decode_failed');
      expect(analysis.quality.code).not.toBe('unsupported_format');
    });

    it('normalizes EXIF orientation 8 (270 deg CW / 90 deg CCW)', async () => {
      const raw = await makeImageWithExif(300, 500, 8);
      const rotated = await sharp(raw).rotate().toBuffer();
      const meta = await sharp(rotated).metadata();
      expect(meta.width).toBe(500);
      expect(meta.height).toBe(300);

      const analysis = await analyzeFaceImage(raw, 'selfie');
      expect(analysis.quality.code).not.toBe('decode_failed');
    });

    it('normalizes EXIF orientation 3 (180 deg upside-down)', async () => {
      const raw = await makeImageWithExif(400, 400, 3);
      const analysis = await analyzeFaceImage(raw, 'selfie');
      expect(analysis.quality.code).not.toBe('decode_failed');
    });
  });

  describe('2. evaluateFaceCropQuality bounds clamping and safety', () => {
    it('safely handles and clamps partially off-canvas face box (negative x/y)', async () => {
      const buffer = await sharp({
        create: {
          width: 500,
          height: 500,
          channels: 3,
          background: { r: 100, g: 100, b: 100 },
        },
      })
        .jpeg()
        .toBuffer();

      const meta = await sharp(buffer).metadata();

      const offCanvasFace: DetectedFace = {
        x: -50,
        y: -30,
        w: 200,
        h: 200,
        score: 0.95,
        landmarks: [[20, 20], [80, 20], [50, 50], [30, 80], [70, 80]],
      };

      // Must NOT throw out-of-range extraction error
      const result = await evaluateFaceCropQuality(buffer, meta, offCanvasFace, 'selfie');
      expect(result).toBeDefined();
      expect(typeof result.passed).toBe('boolean');
    });

    it('safely handles and clamps face box exceeding image width/height', async () => {
      const buffer = await sharp({
        create: {
          width: 400,
          height: 400,
          channels: 3,
          background: { r: 100, g: 100, b: 100 },
        },
      })
        .jpeg()
        .toBuffer();

      const meta = await sharp(buffer).metadata();

      const exceedingFace: DetectedFace = {
        x: 350,
        y: 350,
        w: 200, // Extends beyond 400
        h: 200,
        score: 0.9,
        landmarks: [[360, 360], [390, 360], [375, 380], [365, 395], [385, 395]],
      };

      const result = await evaluateFaceCropQuality(buffer, meta, exceedingFace, 'selfie');
      expect(result).toBeDefined();
      expect(typeof result.passed).toBe('boolean');
    });

    it('safely rejects degenerate or non-finite face coordinates without throwing', async () => {
      const buffer = await sharp({
        create: {
          width: 400,
          height: 400,
          channels: 3,
          background: { r: 100, g: 100, b: 100 },
        },
      })
        .jpeg()
        .toBuffer();

      const meta = await sharp(buffer).metadata();

      const degenerateFace: DetectedFace = {
        x: NaN,
        y: Infinity,
        w: 0,
        h: 0,
        score: 0.1,
        landmarks: [],
      };

      const result = await evaluateFaceCropQuality(buffer, meta, degenerateFace, 'selfie');
      expect(result.passed).toBe(false);
      expect(result.code).toBe('no_face');
    });
  });
});
