import { describe, it, expect } from 'vitest';
import {
  computeNormalizedOvalGeometry,
  evaluateFaceFramingInOval,
  type DetectedFace,
} from '../server/lib/face-engine.js';
import {
  SELFIE_TARGET_ASPECT_RATIO,
  SELFIE_OVAL_RADIUS_X,
  SELFIE_OVAL_RADIUS_Y,
} from '../src/lib/selfieFramingContract.js';

describe('Strict Official Selfie Framing Enforcement', () => {
  it('1. Computes normalized oval geometry correctly across aspect ratios', () => {
    // 3:4 portrait (720x960) - exact target aspect ratio
    const oval34 = computeNormalizedOvalGeometry(720, 960);
    expect(oval34.cx).toBe(0.5);
    expect(oval34.cy).toBe(0.5);
    expect(oval34.rx).toBeCloseTo(SELFIE_OVAL_RADIUS_X, 3);
    expect(oval34.ry).toBeCloseTo(SELFIE_OVAL_RADIUS_Y, 3);

    // Standard 4:3 video (640x480) - wider than 3:4, cropped horizontally by 3:4 container
    const oval43 = computeNormalizedOvalGeometry(640, 480);
    expect(oval43.cx).toBe(0.5);
    expect(oval43.cy).toBe(0.5);
    // Visible width fraction is (3/4) / (4/3) = 0.5625
    // rx in image coordinates = 0.31 * 0.5625 = 0.174375
    expect(oval43.rx).toBeCloseTo(0.174, 2);
    expect(oval43.ry).toBeCloseTo(0.35, 2);

    // 16:9 video (1280x720) - wider than 3:4, cropped horizontally by 3:4 container
    const oval169 = computeNormalizedOvalGeometry(1280, 720);
    expect(oval169.cx).toBe(0.5);
    expect(oval169.cy).toBe(0.5);
    // Visible width fraction is (3/4) / (16/9) = 0.421875
    // rx in image coordinates = 0.31 * 0.421875 = 0.13078
    expect(oval169.rx).toBeCloseTo(0.131, 2);
    expect(oval169.ry).toBeCloseTo(0.35, 2);

    // 9:16 portrait video (720x1280) - taller than 3:4, cropped vertically by 3:4 container
    const oval916 = computeNormalizedOvalGeometry(720, 1280);
    expect(oval916.cx).toBe(0.5);
    expect(oval916.cy).toBe(0.5);
    expect(oval916.rx).toBeCloseTo(0.31, 2);
    // Visible height fraction is (9/16) / (3/4) = 0.75
    // ry in image coordinates = 0.35 * 0.75 = 0.2625
    expect(oval916.ry).toBeCloseTo(0.263, 2);
  });

  // Helper to generate a face in 640x640 YuNet coordinate space
  function makeFace(opts: {
    origW?: number;
    origH?: number;
    cx?: number; // center in original image [0, 1]
    cy?: number; // center in original image [0, 1]
    w?: number;  // width in original image [0, 1]
    h?: number;  // height in original image [0, 1]
    tiltDeg?: number;
    yawOffset?: number;
  }): { face: DetectedFace; origW: number; origH: number } {
    const origW = opts.origW ?? 720;
    const origH = opts.origH ?? 960;
    const scale = Math.min(640 / origW, 640 / origH);
    const padX = (640 - origW * scale) / 2;
    const padY = (640 - origH * scale) / 2;

    const fcx = opts.cx ?? 0.5;
    const fcy = opts.cy ?? 0.5;
    const fw = opts.w ?? 0.32;
    const fh = opts.h ?? 0.38;

    const uX = fcx - fw / 2;
    const vY = fcy - fh / 2;

    const x = uX * origW * scale + padX;
    const y = vY * origH * scale + padY;
    const w = fw * origW * scale;
    const h = fh * origH * scale;

    // Landmarks in original normalized coords
    const tilt = ((opts.tiltDeg ?? 0) * Math.PI) / 180;
    const eyeHalfDist = 0.06;
    const reX = fcx - eyeHalfDist * Math.cos(tilt);
    const reY = (fcy - 0.08) - eyeHalfDist * Math.sin(tilt);
    const leX = fcx + eyeHalfDist * Math.cos(tilt);
    const leY = (fcy - 0.08) + eyeHalfDist * Math.sin(tilt);

    const noseX = fcx + (opts.yawOffset ?? 0);
    const noseY = fcy;

    const rmX = fcx - 0.04;
    const rmY = fcy + 0.10;
    const lmX = fcx + 0.04;
    const lmY = fcy + 0.10;

    const to640 = (u: number, v: number): [number, number] => [
      u * origW * scale + padX,
      v * origH * scale + padY,
    ];

    return {
      origW,
      origH,
      face: {
        x,
        y,
        w,
        h,
        score: 0.95,
        landmarks: [
          to640(reX, reY),
          to640(leX, leY),
          to640(noseX, noseY),
          to640(rmX, rmY),
          to640(lmX, lmY),
        ],
      },
    };
  }

  it('2. Passes when face and head are well-centered and framed inside 3:4 portrait oval', () => {
    const { face, origW, origH } = makeFace({ cx: 0.5, cy: 0.5, w: 0.32, h: 0.38 });
    const res = evaluateFaceFramingInOval(origW, origH, face);
    expect(res.passed).toBe(true);
    expect(res.code).toBe('ok');
  });

  it('3. Rejects face_off_center when visitor is shifted too far horizontally', () => {
    const { face, origW, origH } = makeFace({ cx: 0.70, cy: 0.5, w: 0.26, h: 0.36 });
    const res = evaluateFaceFramingInOval(origW, origH, face);
    expect(res.passed).toBe(false);
    expect(res.code).toBe('face_off_center');
  });

  it('4. Rejects face_too_small when visitor is positioned too far back', () => {
    // Face height only 15% of frame (oval vertical diameter is 70%)
    const { face, origW, origH } = makeFace({ cx: 0.5, cy: 0.5, w: 0.12, h: 0.15 });
    const res = evaluateFaceFramingInOval(origW, origH, face);
    expect(res.passed).toBe(false);
    expect(res.code).toBe('face_too_small');
  });

  it('5. Rejects head_outside_guide when visitor forehead/hair exceeds the top oval boundary', () => {
    // Face itself is inside oval (vY = 0.16, direct face top dist < 1.0),
    // but head envelope (forehead/hair) exceeds the top oval boundary (dist > 1.06)
    const { face, origW, origH } = makeFace({ cx: 0.5, cy: 0.40, w: 0.30, h: 0.48 });
    const res = evaluateFaceFramingInOval(origW, origH, face);
    expect(res.passed).toBe(false);
    expect(res.code).toBe('head_outside_guide');
  });

  it('6. Rejects pose_unsuitable when head is tilted excessively (> 20 degrees)', () => {
    const { face, origW, origH } = makeFace({ cx: 0.5, cy: 0.5, w: 0.30, h: 0.38, tiltDeg: 28 });
    const res = evaluateFaceFramingInOval(origW, origH, face);
    expect(res.passed).toBe(false);
    expect(res.code).toBe('pose_unsuitable');
  });

  it('7. Rejects pose_unsuitable when face is turned sideways into profile view', () => {
    // Nose turned far to the right, outside the eye span
    const { face, origW, origH } = makeFace({ cx: 0.5, cy: 0.5, w: 0.30, h: 0.38, yawOffset: 0.08 });
    const res = evaluateFaceFramingInOval(origW, origH, face);
    expect(res.passed).toBe(false);
    expect(res.code).toBe('pose_unsuitable');
  });

  it('8. Rejects face_cropped when face touches image boundary', () => {
    // Face box starts at uX = 0.005 (touching left edge)
    const { face, origW, origH } = makeFace({ cx: 0.15, cy: 0.5, w: 0.30, h: 0.40 });
    const res = evaluateFaceFramingInOval(origW, origH, face);
    expect(res.passed).toBe(false);
    expect(['face_cropped', 'face_off_center', 'face_outside_guide']).toContain(res.code);
  });

  it('9. Properly admits natural head variance without false hairline rejections', () => {
    // Normal head slightly high in oval (cy = 0.46) with 0.42 height
    // Under previous 30% jump, headTop reached 0.46 - 0.21 - 0.30*0.42 = 0.124 which was rejected.
    // Under calibrated HEAD_TOP_EXPANSION_RATIO (0.14) and tolerance (1.06), it passes naturally.
    const { face, origW, origH } = makeFace({ cx: 0.5, cy: 0.46, w: 0.34, h: 0.42 });
    const res = evaluateFaceFramingInOval(origW, origH, face);
    expect(res.passed).toBe(true);
    expect(res.code).toBe('ok');
  });
});
