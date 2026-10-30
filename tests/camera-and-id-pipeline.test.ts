// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { normalizeIdentityDocumentImage, compressImageToWebP } from '../src/lib/imageProcessing.js';

describe('Camera Mirroring & High-Resolution ID Pipeline', () => {
  const getPassSource = fs.readFileSync(
    path.resolve('src/pages/GetPassPage.tsx'),
    'utf-8'
  );

  it('1. Live Face camera configures unmirrored biometric capture while allowing mirrored preview', () => {
    // WebCam initialized with allowCaptureMirroring: false
    expect(getPassSource).toMatch(/useWebcam\(\{\s*facingMode:\s*['"]user['"],\s*width:\s*640,\s*height:\s*480,\s*allowCaptureMirroring:\s*false\s*\}\)/);
    // Capture explicitly disables capture mirroring
    expect(getPassSource).toMatch(/faceWebcam\.capture\(\{\s*mirror:\s*false\s*\}\)/);
  });

  it('2. GetPassPage uses normalizeIdentityDocumentImage for both OCR and Valid ID uploads', () => {
    // Both OCR file selection and ID file upload call normalizeIdentityDocumentImage
    const matches = [...getPassSource.matchAll(/normalizeIdentityDocumentImage\(file\)/g)];
    expect(matches.length).toBeGreaterThanOrEqual(2);

    // Old 1024px compressor must not be called on the ID in GetPassPage
    expect(getPassSource).not.toMatch(/compressImageToWebP\(file\)/);
  });

  it('3. OCR-provided ID is flagged for reuse and not re-requested from visitor', () => {
    expect(getPassSource).toMatch(/setIdReusedFromOcr\(true\)/);
    expect(getPassSource).toMatch(/✓ ID image already added from earlier autofill upload/);
  });

  it('4. normalizeIdentityDocumentImage bounds dimensions up to 2000px without upscaling smaller images', async () => {
    // Mock Image and Canvas in DOM environment
    const originalImage = global.Image;
    const originalCreateElement = document.createElement.bind(document);

    try {
      let drawnWidth = 0;
      let drawnHeight = 0;
      let requestedQuality = 0;

      // Mock image loader
      class MockImage {
        width = 3000;
        height = 2000;
        onload: (() => void) | null = null;
        onerror: (() => void) | null = null;
        set src(_v: string) {
          setTimeout(() => this.onload?.(), 10);
        }
      }
      // @ts-expect-error Mock Image
      global.Image = MockImage;

      // Mock canvas
      vi.spyOn(document, 'createElement').mockImplementation((tagName: string) => {
        if (tagName === 'canvas') {
          return {
            width: 0,
            height: 0,
            getContext: () => ({
              drawImage: (_img: any, _sx: number, _sy: number, w: number, h: number) => {
                drawnWidth = w;
                drawnHeight = h;
              },
            }),
            toBlob: (cb: (b: Blob | null) => void, _type: string, quality: number) => {
              requestedQuality = quality;
              cb(new Blob(['mock-webp'], { type: 'image/webp' }));
            },
          } as unknown as HTMLElement;
        }
        return originalCreateElement(tagName);
      });

      // Test scaling on 3000x2000 image (max dimension 3000 > 2000)
      const mockFile = new Blob(['sample-id'], { type: 'image/jpeg' });
      await normalizeIdentityDocumentImage(mockFile);

      // Long edge should scale down to 2000 (scale = 2000 / 3000 = 0.6667)
      expect(drawnWidth).toBe(2000);
      expect(drawnHeight).toBe(1333);
      expect(requestedQuality).toBe(0.92);

      // Test smaller image (e.g. 1200x800) does not get upscaled
      class SmallerMockImage {
        width = 1200;
        height = 800;
        onload: (() => void) | null = null;
        set src(_v: string) {
          setTimeout(() => this.onload?.(), 10);
        }
      }
      // @ts-expect-error Mock Image
      global.Image = SmallerMockImage;

      await normalizeIdentityDocumentImage(mockFile);
      expect(drawnWidth).toBe(1200);
      expect(drawnHeight).toBe(800);
      expect(requestedQuality).toBe(0.92);
    } finally {
      global.Image = originalImage;
      vi.restoreAllMocks();
    }
  });
});
