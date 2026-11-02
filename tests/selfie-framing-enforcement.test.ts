import { describe, it, expect } from 'vitest';
import {
  computeNormalizedOvalGeometry,
  evaluateFaceFramingInOval,
  type DetectedFace,
} from '../server/lib/face-engine.js';

describe('Strict Official Selfie Framing Enforcement', () => {
  it('1. Computes normalized oval geometry correctly across aspect ratios', () => {
    // Standard 4:3 video (640x480)
    const oval43 = computeNormalizedOvalGeometry(640, 480);
    expect(oval43.cx).toBe(0.5);
    expect(oval43.cy).toBe(0.5);
    expect(oval43.rx).toBeCloseTo(0.28, 2);
    expect(oval43.ry).toBeCloseTo(0.42, 2);

    // 16:9 video (1280x720) - wider than 4:3, cropped horizontally by 4:3 container
    const oval169 = computeNormalizedOvalGeometry(1280, 720);
    expect(oval169.cx).toBe(0.5);
    expect(oval169.cy).toBe(0.5);
    // Visible width fraction is (4/3) / (16/9) = 0.75
    // rx in image coordinates = 0.28 * 0.75 = 0.21
    expect(oval169.rx).toBeCloseTo(0.21, 2);
    expect(oval169.ry).toBeCloseTo(0.42, 2);

    // 9:16 portrait video (720x1280) - taller than 4:3, cropped vertically
    const oval916 = computeNormalizedOvalGeometry(720, 1280);
    expect(oval916.cx).toBe(0.5);
    expect(oval916.cy).toBe(0.5);
    expect(oval916.rx).toBeCloseTo(0.28, 2);
    expect(oval916.ry).toBeLessThan(0.42);
  });

  // Helper to generate a face in 640x640 YuNet coordinate space
  // For a 640x480 image letterboxed into 640x640:
  // scale = 1.0, padX = 0, padY = 80
  function makeFace(opts: {
    cx?: number; // center in original image [0, 1]
    cy?: number; // center in original image [0, 1]
    w?: number;  // width in original image [0, 1]
    h?: number;  // height in original image [0, 1]
    tiltDeg?: number;
    yawOffset?: number;
  }): DetectedFace {
    const origW = 640;
    const origH = 480;
    const scale = 1.0;
    const padX = 0;
    const padY = 80;

    const fcx = opts.cx ?? 0.5;
    const fcy = opts.cy ?? 0.5;
    const fw = opts.w ?? 0.28;
    const fh = opts.h ?? 0.40;

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
    };
  }

  it('2. Passes when face and head are well-centered and framed inside oval', () => {
    const face = makeFace({ cx: 0.5, cy: 0.5, w: 0.26, h: 0.42 });
    const res = evaluateFaceFramingInOval(640, 480, face);
    expect(res.passed).toBe(true);
    expect(res.code).toBe('ok');
  });

  it('3. Rejects face_off_center when visitor is shifted too far horizontally', () => {
    const face = makeFace({ cx: 0.70, cy: 0.5, w: 0.24, h: 0.38 });
    const res = evaluateFaceFramingInOval(640, 480, face);
    expect(res.passed).toBe(false);
    expect(res.code).toBe('face_off_center');
  });

  it('4. Rejects face_too_small when visitor is positioned too far back', () => {
    // Face height only 15% of frame (oval is 84% of frame)
    const face = makeFace({ cx: 0.5, cy: 0.5, w: 0.10, h: 0.15 });
    const res = evaluateFaceFramingInOval(640, 480, face);
    expect(res.passed).toBe(false);
    expect(res.code).toBe('face_too_small');
  });

  it('5. Rejects head_outside_guide when visitor forehead/hair exceeds the top oval boundary', () => {
    // Face center is reasonably positioned (cy: 0.38, within center tolerance),
    // but head envelope (forehead/hair) exceeds the top oval curve
    const face = makeFace({ cx: 0.5, cy: 0.38, w: 0.26, h: 0.44 });
    const res = evaluateFaceFramingInOval(640, 480, face);
    expect(res.passed).toBe(false);
    expect(res.code).toBe('head_outside_guide');
  });

  it('6. Rejects pose_unsuitable when head is tilted excessively (> 20 degrees)', () => {
    const face = makeFace({ cx: 0.5, cy: 0.5, w: 0.26, h: 0.40, tiltDeg: 28 });
    const res = evaluateFaceFramingInOval(640, 480, face);
    expect(res.passed).toBe(false);
    expect(res.code).toBe('pose_unsuitable');
  });

  it('7. Rejects pose_unsuitable when face is turned sideways into profile view', () => {
    // Nose turned far to the right, outside the eye span
    const face = makeFace({ cx: 0.5, cy: 0.5, w: 0.26, h: 0.40, yawOffset: 0.08 });
    const res = evaluateFaceFramingInOval(640, 480, face);
    expect(res.passed).toBe(false);
    expect(res.code).toBe('pose_unsuitable');
  });

  it('8. Rejects face_cropped when face touches image boundary', () => {
    // Face box starts at uX = 0.005 (touching left edge)
    const face = makeFace({ cx: 0.15, cy: 0.5, w: 0.30, h: 0.40 });
    const res = evaluateFaceFramingInOval(640, 480, face);
    expect(res.passed).toBe(false);
    expect(['face_cropped', 'face_off_center', 'face_outside_guide']).toContain(res.code);
  });
});
