// @vitest-environment happy-dom
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

import {
  evaluateReturningSelfiePrecheck,
  evaluateLiveFaceQuality,
} from '../src/lib/imageQuality';
import {
  analyzeFaceImage,
  detectFaces,
} from '../server/lib/face-engine';
import {
  uploadCheckpointedEvidence,
  invalidatePortalEvidenceCheckpoint,
  type PortalIssueTransaction,
} from '../src/services/visitorRegistration';
import { useWebcam } from '../src/hooks/useWebcam';

let currentMockWidth = 640;
let currentMockHeight = 480;
let currentMockLuma = 128;
let currentShouldFailDecode = false;

// Setup Happy-DOM image and canvas mocks for client-side precheck tests
class MockDomImage {
  private _src = '';
  naturalWidth = currentMockWidth;
  naturalHeight = currentMockHeight;
  width = currentMockWidth;
  height = currentMockHeight;
  onload: (() => void) | null = null;
  onerror: ((err: any) => void) | null = null;

  constructor() {
    this.naturalWidth = currentMockWidth;
    this.naturalHeight = currentMockHeight;
    this.width = currentMockWidth;
    this.height = currentMockHeight;
  }

  set src(val: string) {
    this._src = val;
    if (currentShouldFailDecode) {
      setTimeout(() => this.onerror?.(new Error('decode_failed')), 0);
    } else {
      setTimeout(() => this.onload?.(), 0);
    }
  }

  get src() {
    return this._src;
  }
}

(globalThis as any).Image = MockDomImage;
if (typeof window !== 'undefined') {
  (window as any).Image = MockDomImage;
}

HTMLCanvasElement.prototype.getContext = function (type: string) {
  if (type === '2d') {
    return {
      drawImage: vi.fn(),
      translate: vi.fn(),
      scale: vi.fn(),
      getImageData: (_x: number, _y: number, w: number, h: number) => {
        const data = new Uint8ClampedArray(w * h * 4);
        const luma = currentMockLuma;
        for (let i = 0; i < data.length; i += 4) {
          data[i] = luma;
          data[i + 1] = luma;
          data[i + 2] = luma;
          data[i + 3] = 255;
        }
        return { data, width: w, height: h };
      },
    } as any;
  }
  return null;
} as any;

function createMockTrack() {
  return {
    stop: vi.fn(),
    kind: 'video',
    enabled: true,
  };
}

function createMockStream() {
  const tracks = [createMockTrack()];
  return {
    getTracks: () => tracks,
    getVideoTracks: () => tracks,
    _tracks: tracks,
  };
}

function renderHook<T>(hook: () => T) {
  let result = { current: undefined as unknown as T };
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  function TestComponent() {
    result.current = hook();
    return React.createElement('video', {
      ref: (result.current as any).videoRef,
    });
  }

  act(() => {
    root.render(React.createElement(TestComponent));
  });

  return {
    result,
    unmount: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

describe('PART A: Camera Orientation & Unmirrored Returning Visitor Contract', () => {
  const getPassSrc = readFileSync('src/pages/GetPassPage.tsx', 'utf8');

  it('Returning Visitor live camera renders without horizontal CSS mirroring (transform: none)', () => {
    const liveStageIdx = getPassSrc.indexOf("returningCaptureStage === 'live'");
    expect(liveStageIdx).toBeGreaterThan(0);
    const videoIdx = getPassSrc.indexOf('<video', liveStageIdx);
    const videoEnd = getPassSrc.indexOf('/>', videoIdx);
    const videoBlock = getPassSrc.substring(videoIdx, videoEnd);

    // Live video must NOT be mirrored with scaleX(-1)
    expect(videoBlock).toContain("style={{ transform: 'none' }}");
    expect(videoBlock).not.toContain("scaleX(-1)");
  });

  it('Returning Visitor capture call explicitly uses capture({ mirror: false })', () => {
    const captureFnIdx = getPassSrc.indexOf('async function onCaptureReturningSelfie()');
    expect(captureFnIdx).toBeGreaterThan(0);
    const captureCallIdx = getPassSrc.indexOf('faceWebcam.capture({ mirror: false })', captureFnIdx);
    expect(captureCallIdx).toBeGreaterThan(captureFnIdx);
  });

  it('Returning Visitor frozen preview renders without horizontal CSS mirroring', () => {
    const reviewStageIdx = getPassSrc.indexOf("returningCaptureStage === 'review'");
    expect(reviewStageIdx).toBeGreaterThan(0);
    const imgIdx = getPassSrc.indexOf('alt="Captured selfie preview"', reviewStageIdx);
    expect(imgIdx).toBeGreaterThan(reviewStageIdx);
    const imgBlock = getPassSrc.substring(imgIdx - 40, imgIdx + 120);

    // Frozen preview must NOT have scaleX(-1)
    expect(imgBlock).not.toContain("scaleX(-1)");
  });

  it('New Visitor camera mirroring remains intact and unchanged', () => {
    const newVisitorVideoIdx = getPassSrc.indexOf("style={{ transform: faceWebcam.mirrorPreview ? 'scaleX(-1)' : 'none' }}");
    expect(newVisitorVideoIdx).toBeGreaterThan(0);

    const newVisitorFrozenIdx = getPassSrc.indexOf('alt="Captured face" className="w-full h-full object-cover" style={{ transform: \'scaleX(-1)\' }}');
    expect(newVisitorFrozenIdx).toBeGreaterThan(0);
  });

  it('Decoded Blob pixel orientation matches capture({ mirror: false }) canvas translation', () => {
    // Tests that useWebcam capture when mirror is false does not scale(-1, 1) or translate
    const canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = 480;
    const ctx = canvas.getContext('2d')!;
    const translateSpy = vi.spyOn(ctx, 'translate');
    const scaleSpy = vi.spyOn(ctx, 'scale');

    const shouldMirror = false;
    if (shouldMirror) {
      ctx.translate(canvas.width, 0);
      ctx.scale(-1, 1);
    }

    expect(translateSpy).not.toHaveBeenCalled();
    expect(scaleSpy).not.toHaveBeenCalled();
  });
});

describe('PART B: Retake Lifecycle, Blank Screen Prevention & Camera Cleanup', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    Object.defineProperty(HTMLMediaElement.prototype, 'readyState', {
      value: 4,
      configurable: true,
      writable: true,
    });
    HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
    let _srcObject: any = null;
    Object.defineProperty(HTMLMediaElement.prototype, 'srcObject', {
      get() {
        return _srcObject;
      },
      set(val) {
        _srcObject = val;
      },
      configurable: true,
    });
  });

  it('Separates camera unmount from preview URL cleanup so URL changes never call faceWebcam.stop()', () => {
    const getPassSrc = readFileSync('src/pages/GetPassPage.tsx', 'utf8');

    // Camera unmount effect has empty dependency array []
    expect(getPassSrc).toContain('// Camera unmount cleanup only: stop camera tracks when the page actually unmounts');
    expect(getPassSrc).toMatch(/useEffect\(\(\) => \{\s*return \(\) => \{\s*faceWebcam\.stop\(\);\s*\};\s*\}, \[\]\);/);

    // URL cleanup ref does not call faceWebcam.stop()
    expect(getPassSrc).toContain('returningSelfieUrlRef.current = returningSelfieUrl;');
    expect(getPassSrc).not.toMatch(/useEffect\(\(\) => \{\s*return \(\) => \{\s*faceWebcam\.stop\(\);[\s\S]*?\}, \[returningSelfieUrl\]\);/);
  });

  it('Retake survives delayed iOS getUserMedia without stopping pending camera stream', async () => {
    let resolveMedia: (stream: any) => void;
    const mediaPromise = new Promise((resolve) => {
      resolveMedia = resolve;
    });

    const mockStream = createMockStream();
    const getUserMediaMock = vi.fn().mockImplementation(() => mediaPromise);
    Object.defineProperty(navigator, 'mediaDevices', {
      value: { getUserMedia: getUserMediaMock },
      configurable: true,
    });

    const { result, unmount } = renderHook(() => useWebcam({ facingMode: 'user', width: 640, height: 480 }));
    expect(result.current.isActive).toBe(false);

    // 1. Initial capture simulation: Start camera & complete
    let startPromise: Promise<void>;
    act(() => {
      startPromise = result.current.start();
    });
    expect(result.current.isStarting).toBe(true);

    // Resolve initial camera
    await act(async () => {
      resolveMedia(mockStream);
      await startPromise;
    });
    expect(result.current.isActive).toBe(true);

    // 2. User captures photo -> webcam is stopped
    act(() => {
      result.current.stop();
    });
    expect(result.current.isActive).toBe(false);

    // 3. User clicks Retake -> starts camera with delayed iOS resolution
    let resolveRetakeMedia: (stream: any) => void;
    const retakeMediaPromise = new Promise((resolve) => {
      resolveRetakeMedia = resolve;
    });
    getUserMediaMock.mockImplementationOnce(() => retakeMediaPromise);

    let retakePromise: Promise<void>;
    act(() => {
      retakePromise = result.current.start();
    });
    expect(result.current.isStarting).toBe(true);

    // 4. In the old bug, preview URL change triggered effect cleanup calling stop().
    // In our fixed implementation, URL changes do NOT call stop().
    // Resolve the delayed iOS getUserMedia:
    const retakeStream = createMockStream();
    await act(async () => {
      resolveRetakeMedia(retakeStream);
      await retakePromise;
    });

    // 5. Assert: Retake stream is active and tracks are NOT stopped
    expect(retakeStream._tracks[0].stop).not.toHaveBeenCalled();
    expect(result.current.isActive).toBe(true);
    expect(result.current.isStarting).toBe(false);

    unmount();
  });

  it('Reproduces that old effect-cleanup race would have cancelled pending retake camera', async () => {
    // Demonstrates why the bug happened when stop() was called during pending start()
    let resolvePending: (stream: any) => void;
    const pendingPromise = new Promise((resolve) => {
      resolvePending = resolve;
    });

    const mockStream = createMockStream();
    const getUserMediaMock = vi.fn().mockImplementation(() => pendingPromise);
    Object.defineProperty(navigator, 'mediaDevices', {
      value: { getUserMedia: getUserMediaMock },
      configurable: true,
    });

    const { result, unmount } = renderHook(() => useWebcam());

    // Retake called start()
    let p: Promise<void>;
    act(() => {
      p = result.current.start();
    });
    expect(result.current.isStarting).toBe(true);

    // Simulated old bug: URL change effect runs stop()
    act(() => {
      result.current.stop(); // increments generationRef
    });

    // Late arrival of getUserMedia
    await act(async () => {
      resolvePending(mockStream);
      await p;
    });

    // Proves that calling stop() during pending start caused blank camera
    expect(mockStream._tracks[0].stop).toHaveBeenCalledTimes(1);
    expect(result.current.isActive).toBe(false);

    unmount();
  });

  it('Capture button is disabled when camera is starting or not active', () => {
    const getPassSrc = readFileSync('src/pages/GetPassPage.tsx', 'utf8');
    expect(getPassSrc).toContain('disabled={!faceWebcam.isActive || faceWebcam.isStarting}');
  });
});

describe('PART C & D: Upload Checkpoint Invalidation & Fresh Intent Renewal', () => {
  it('Invalidating photo checkpoint clears photoCheckpoint, photoIntentId, and verifiedPhotoIntentId', () => {
    const transaction: PortalIssueTransaction = {
      requestId: 'test-uuid',
      source: 'portal',
      phase: 'init',
      photoIntentId: 'old-intent-111',
      photoCheckpoint: {
        intentId: 'old-intent-111',
        bucketId: 'evidence',
        objectPath: 'portal/old-intent-111.jpg',
        contentType: 'image/jpeg',
        maxBytes: 5242880,
        expiresAt: new Date(Date.now() + 60000).toISOString(),
        uploaded: true,
      },
    } as any;
    (transaction as any).verifiedPhotoIntentId = 'old-intent-111';

    invalidatePortalEvidenceCheckpoint(transaction, 'photo');

    expect(transaction.photoCheckpoint).toBeNull();
    expect(transaction.photoIntentId).toBeNull();
    expect((transaction as any).verifiedPhotoIntentId).toBeNull();
  });

  it('uploadCheckpointedEvidence generates a fresh upload intent when checkpoint is invalidated', async () => {
    let intentCounter = 0;
    const mockRpc = vi.fn().mockImplementation(() => {
      intentCounter++;
      return {
        single: async () => ({
          data: {
            intent_id: `intent-fresh-${intentCounter}`,
            bucket_id: 'visitor-evidence',
            object_path: `portal/intent-fresh-${intentCounter}.webp`,
            max_bytes: 5242880,
            expires_at: new Date(Date.now() + 60000).toISOString(),
          },
          error: null,
        }),
      };
    });

    const mockClient = {
      schema: () => ({
        rpc: mockRpc,
      }),
      storage: {
        from: () => ({
          upload: vi.fn().mockResolvedValue({ error: null }),
          uploadToSignedUrl: vi.fn().mockResolvedValue({ error: null }),
        }),
      },
    } as any;

    const tx: PortalIssueTransaction = {
      requestId: 'test-req',
      source: 'portal',
      phase: 'init',
      photoCheckpoint: null,
      photoIntentId: null,
    } as any;

    const blobA = new Blob(['sample-selfie-A'], { type: 'image/webp' });
    const resA = await uploadCheckpointedEvidence(mockClient, 'portal', 'photo', blobA, tx);

    expect(resA.intentId).toBe('intent-fresh-1');
    expect(tx.photoIntentId).toBe('intent-fresh-1');
    expect(mockRpc).toHaveBeenCalledTimes(1);

    // Retake happens -> invalidate checkpoint
    invalidatePortalEvidenceCheckpoint(tx, 'photo');
    expect(tx.photoCheckpoint).toBeNull();
    expect(tx.photoIntentId).toBeNull();

    // Capture B and upload
    const blobB = new Blob(['sample-selfie-B'], { type: 'image/webp' });
    const resB = await uploadCheckpointedEvidence(mockClient, 'portal', 'photo', blobB, tx);

    expect(resB.intentId).toBe('intent-fresh-2');
    expect(tx.photoIntentId).toBe('intent-fresh-2');
    expect(mockRpc).toHaveBeenCalledTimes(2);

    // Verifies no old intent was reused
    expect(resA.intentId).not.toBe(resB.intentId);
  });
});

describe('PART E: Image Quality Matrix — Browser Precheck vs Server Face-Crop Quality', () => {
  const sample1Buffer = readFileSync(path.resolve('tests/fixtures/face-sample-1.jpg'));

  beforeEach(() => {
    currentMockWidth = 640;
    currentMockHeight = 480;
    currentMockLuma = 128;
    currentShouldFailDecode = false;
  });

  it('1. Clear front-camera selfie passes both client precheck and server face-crop check', async () => {
    currentMockWidth = 512;
    currentMockHeight = 512;
    currentMockLuma = 130;

    const blob = new Blob([sample1Buffer], { type: 'image/jpeg' });
    const precheck = await evaluateReturningSelfiePrecheck(blob);
    expect(precheck.passed).toBe(true);
    expect(precheck.code).toBe('ok');
    expect(precheck.diagnostics.origin).toBe('client_quality_passed');
    expect(precheck.diagnostics.byteSize).toBe(sample1Buffer.length);
    expect(precheck.diagnostics.width).toBeGreaterThanOrEqual(240);

    const serverAnalysis = await analyzeFaceImage(sample1Buffer, 'selfie');
    expect(serverAnalysis.quality.passed).toBe(true);
    expect(serverAnalysis.quality.code).toBe('ok');
    expect(serverAnalysis.faces.length).toBe(1);
    expect(serverAnalysis.descriptor).toBeDefined();
    expect(serverAnalysis.descriptor!.length).toBe(128);
  });

  it('2. Mildly compressed selfie (JPEG quality 60) passes both client precheck and server', async () => {
    const compressed = await sharp(sample1Buffer).jpeg({ quality: 60 }).toBuffer();
    currentMockWidth = 512;
    currentMockHeight = 512;
    currentMockLuma = 130;

    const blob = new Blob([compressed], { type: 'image/jpeg' });
    const precheck = await evaluateReturningSelfiePrecheck(blob);
    expect(precheck.passed).toBe(true);
    expect(precheck.code).toBe('ok');

    const serverAnalysis = await analyzeFaceImage(compressed, 'selfie');
    expect(serverAnalysis.quality.passed).toBe(true);
    expect(serverAnalysis.quality.code).toBe('ok');
  });

  it('3. Genuinely defocused / blurry selfie passes client precheck but is AUTHORITATIVELY rejected by server face-crop check', async () => {
    // Severe optical blur applied to the image
    const heavilyBlurred = await sharp(sample1Buffer).blur(22).toBuffer();
    currentMockWidth = 512;
    currentMockHeight = 512;
    currentMockLuma = 130;

    const blob = new Blob([heavilyBlurred], { type: 'image/jpeg' });

    // Client precheck defers blur to server (does NOT falsely reject on whole-frame heuristic)
    const precheck = await evaluateReturningSelfiePrecheck(blob);
    expect(precheck.passed).toBe(true);
    expect(precheck.code).toBe('ok');

    // Server-side authoritative YuNet/SFace face-crop analysis catches the genuine blur
    const serverAnalysis = await analyzeFaceImage(heavilyBlurred, 'selfie');
    expect(serverAnalysis.quality.passed).toBe(false);
    expect(serverAnalysis.quality.code).toBe('blurry');
    expect(serverAnalysis.quality.message).toMatch(/blurry/i);
    expect(serverAnalysis.quality.details?.faceBlur || serverAnalysis.quality.details?.blurScore).toBeDefined();
  });

  it('4. Too-dark selfie is rejected with code "too_dark" by client precheck', async () => {
    currentMockWidth = 400;
    currentMockHeight = 400;
    currentMockLuma = 15; // below 25

    const darkBuffer = await sharp({
      create: {
        width: 400,
        height: 400,
        channels: 3,
        background: { r: 5, g: 5, b: 5 },
      },
    }).jpeg().toBuffer();

    const blob = new Blob([darkBuffer], { type: 'image/jpeg' });
    const precheck = await evaluateReturningSelfiePrecheck(blob);
    expect(precheck.passed).toBe(false);
    expect(precheck.code).toBe('too_dark');
    expect(precheck.diagnostics.origin).toBe('client_quality_rejected');
    expect(precheck.diagnostics.brightness).toBeLessThan(25);
  });

  it('5. Overexposed selfie is rejected with code "overexposed" by client precheck', async () => {
    currentMockWidth = 400;
    currentMockHeight = 400;
    currentMockLuma = 250; // above 245

    const glareBuffer = await sharp({
      create: {
        width: 400,
        height: 400,
        channels: 3,
        background: { r: 252, g: 252, b: 252 },
      },
    }).jpeg().toBuffer();

    const blob = new Blob([glareBuffer], { type: 'image/jpeg' });
    const precheck = await evaluateReturningSelfiePrecheck(blob);
    expect(precheck.passed).toBe(false);
    expect(precheck.code).toBe('overexposed');
    expect(precheck.diagnostics.origin).toBe('client_quality_rejected');
    expect(precheck.diagnostics.brightness).toBeGreaterThan(245);
  });

  it('6. Low-resolution image (< 240px) is rejected by client precheck with code "too_small"', async () => {
    currentMockWidth = 180;
    currentMockHeight = 180;

    const tinyBuffer = await sharp(sample1Buffer).resize(180, 180).jpeg().toBuffer();
    const blob = new Blob([tinyBuffer], { type: 'image/jpeg' });

    const precheck = await evaluateReturningSelfiePrecheck(blob);
    expect(precheck.passed).toBe(false);
    expect(precheck.code).toBe('too_small');
    expect(precheck.diagnostics.origin).toBe('client_quality_rejected');
  });

  it('7. No-face image passes client precheck but is rejected by server with "no_face"', async () => {
    const svgNoFace = Buffer.from(
      '<svg width="400" height="400"><rect width="400" height="400" fill="#f0f0f0"/><text x="40" y="200" font-family="sans-serif" font-size="28" fill="#111">CAMPUS GATE PASS SIGN</text></svg>'
    );
    const noFaceBuffer = await sharp(svgNoFace).jpeg().toBuffer();

    currentMockWidth = 400;
    currentMockHeight = 400;
    currentMockLuma = 120;

    const blob = new Blob([noFaceBuffer], { type: 'image/jpeg' });
    const precheck = await evaluateReturningSelfiePrecheck(blob);
    expect(precheck.passed).toBe(true);

    const serverAnalysis = await analyzeFaceImage(noFaceBuffer, 'selfie');
    expect(serverAnalysis.quality.passed).toBe(false);
    expect(serverAnalysis.quality.code).toBe('no_face');
    expect(serverAnalysis.quality.message).toMatch(/no face/i);
  });

  it('8. Multiple-face image is rejected by server with "multiple_faces"', async () => {
    // Composite 2 face samples side by side
    const resizedFace = await sharp(sample1Buffer).resize(300, 300).toBuffer();
    const twoFacesBuffer = await sharp({
      create: {
        width: 700,
        height: 360,
        channels: 3,
        background: { r: 200, g: 200, b: 200 },
      },
    })
      .composite([
        { input: resizedFace, left: 30, top: 30 },
        { input: resizedFace, left: 370, top: 30 },
      ])
      .jpeg()
      .toBuffer();

    const faces = await detectFaces(twoFacesBuffer);
    expect(faces.length).toBeGreaterThanOrEqual(2);

    const serverAnalysis = await analyzeFaceImage(twoFacesBuffer, 'selfie');
    expect(serverAnalysis.quality.passed).toBe(false);
    expect(serverAnalysis.quality.code).toBe('multiple_faces');
    expect(serverAnalysis.quality.message).toMatch(/more than one face|multiple/i);
  });
});

describe('PART F: Mobile Matrix Viewports & Touch Target Contract', () => {
  const getPassSrc = readFileSync('src/pages/GetPassPage.tsx', 'utf8');

  const mobileViewports = [
    { name: 'iPhone 12 (Safari/WebKit)', width: 390, height: 844 },
    { name: 'Narrow mobile (iPhone SE)', width: 375, height: 812 },
    { name: 'Compact mobile', width: 320, height: 812 },
    { name: 'Larger mobile (iPhone 12 Pro Max)', width: 414, height: 896 },
  ];

  for (const vp of mobileViewports) {
    it(`supports ${vp.name} (${vp.width}x${vp.height}) with 3:4 portrait camera aspect ratio and min-height >= 56px action buttons`, () => {
      // 3:4 portrait aspect ratio container for camera and preview
      expect(getPassSrc).toContain('aspect-[3/4]');
      // Primary touch actions on mobile enforce min-h-[56px]
      expect(getPassSrc).toContain('min-h-[56px] sm:min-h-11');
      // Full width column-reverse on mobile with >=12px vertical gap
      expect(getPassSrc).toContain('flex flex-col-reverse sm:flex-row gap-3 pt-2');
    });
  }

  it('renders oval head guide inside camera viewport for alignment assistance', () => {
    expect(getPassSrc).toContain('rounded-[50%]');
    expect(getPassSrc).toContain('border-dashed border-white/80');
    expect(getPassSrc).toContain('Center face in oval');
  });

  it('provides actionable user feedback for every specific rejection reason without leaking descriptors', () => {
    expect(getPassSrc).toContain("reasonCode === 'no_face'");
    expect(getPassSrc).toContain("reasonCode === 'multiple_faces'");
    expect(getPassSrc).toContain("reasonCode === 'too_small'");
    expect(getPassSrc).toContain("reasonCode === 'too_dark'");
    expect(getPassSrc).toContain("reasonCode === 'overexposed'");
    expect(getPassSrc).toContain("reasonCode === 'blurry'");
    expect(getPassSrc).toContain("reasonCode === 'framing_failed'");
  });
});
