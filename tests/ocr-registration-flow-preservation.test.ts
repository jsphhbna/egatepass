// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { handlePreloadError, PRELOAD_RECOVERY_KEY } from '../src/lib/preloadRecovery.js';

describe('OCR Registration-State Preservation & Preload Failure Resilience Suite', () => {
  const getPassSrc = readFileSync('src/pages/GetPassPage.tsx', 'utf8');
  const paddleOcrSrc = readFileSync('src/lib/paddleOcr.ts', 'utf8');
  const preloadRecoverySrc = readFileSync('src/lib/preloadRecovery.ts', 'utf8');

  // ==========================================================================
  // 1. SUPPRESSION OF AUTO-RELOAD ON /GET-PASS
  // ==========================================================================
  describe('1. Preload Error Recovery Suppression on /get-pass', () => {
    let originalLocation: Location;

    beforeEach(() => {
      originalLocation = window.location;
      sessionStorage.clear();
    });

    afterEach(() => {
      Object.defineProperty(window, 'location', {
        value: originalLocation,
        writable: true,
      });
      sessionStorage.clear();
    });

    it('suppresses auto-reload when user is on /get-pass path', () => {
      // Mock window.location.pathname to /get-pass
      delete (window as unknown as { location?: unknown }).location;
      window.location = {
        pathname: '/get-pass',
        reload: vi.fn(),
      } as unknown as Location;

      const reload = vi.fn();
      const preventDefault = vi.fn();

      const recovered = handlePreloadError(
        { preventDefault },
        { isOnline: true, now: () => 100000, reload, storage: sessionStorage }
      );

      // Must return false, must not reload, must not record recovery timestamp
      expect(recovered).toBe(false);
      expect(preventDefault).not.toHaveBeenCalled();
      expect(reload).not.toHaveBeenCalled();
      expect(sessionStorage.getItem(PRELOAD_RECOVERY_KEY)).toBeNull();
    });

    it('suppresses auto-reload when user is on subpath of /get-pass (e.g. /get-pass/express)', () => {
      delete (window as unknown as { location?: unknown }).location;
      window.location = {
        pathname: '/get-pass/express',
        reload: vi.fn(),
      } as unknown as Location;

      const reload = vi.fn();
      const preventDefault = vi.fn();

      const recovered = handlePreloadError(
        { preventDefault },
        { isOnline: true, now: () => 100000, reload, storage: sessionStorage }
      );

      expect(recovered).toBe(false);
      expect(reload).not.toHaveBeenCalled();
    });

    it('permits normal auto-reload on non-registration routes (e.g. /admin, /guard, /)', () => {
      delete (window as unknown as { location?: unknown }).location;
      window.location = {
        pathname: '/guard',
        reload: vi.fn(),
      } as unknown as Location;

      const reload = vi.fn();
      const preventDefault = vi.fn();

      const recovered = handlePreloadError(
        { preventDefault },
        { isOnline: true, now: () => 100000, reload, storage: sessionStorage }
      );

      expect(recovered).toBe(true);
      expect(preventDefault).toHaveBeenCalledTimes(1);
      expect(reload).toHaveBeenCalledTimes(1);
      expect(sessionStorage.getItem(PRELOAD_RECOVERY_KEY)).toBe('100000');
    });

    it('verifies explicit guard clause exists in src/lib/preloadRecovery.ts', () => {
      expect(preloadRecoverySrc).toContain("window.location.pathname.startsWith('/get-pass')");
      expect(preloadRecoverySrc).toContain('Suppressing auto-reload on /get-pass to preserve active visitor registration state');
    });
  });

  // ==========================================================================
  // 2. PADDLEOCR WORKER CONFIGURATION & VITE BUNDLE INTEGRITY
  // ==========================================================================
  describe('2. PaddleOCR In-Thread Execution Contract (Worker 404 Prevention)', () => {
    it('configures PaddleOCR.create with worker: false to prevent unhashed asset 404', () => {
      // In production Vite bundles, worker-entry-C9UNuyOJ.js was requested directly by PaddleOCR
      // instead of its hashed bundle name, resulting in 404 and vite:preloadError.
      // Running in-thread (worker: false) avoids this runtime failure entirely.
      expect(paddleOcrSrc).toContain('worker: false');
      expect(paddleOcrSrc).not.toContain('worker: isWorkerSupported');
    });

    it('maintains WebGPU acceleration with WASM fallback (ortOptions backend: auto)', () => {
      expect(paddleOcrSrc).toContain("backend: 'auto'");
    });

    it('preserves Tagalog (tl) language and PP-OCRv6 model configurations', () => {
      expect(paddleOcrSrc).toContain("ocrVersion: 'PP-OCRv6'");
      expect(paddleOcrSrc).toContain("lang: 'tl'");
    });
  });

  // ==========================================================================
  // 3. GETPASS OCR FILE INPUT EVENT BUBBLING & SUBMISSION PREVENTION
  // ==========================================================================
  describe('3. Event Bubbling & Form Submission Prevention in GetPassPage', () => {
    it('stops event propagation on file input click and change handlers', () => {
      expect(getPassSrc).toContain('ref={ocrFileInputRef}');
      expect(getPassSrc).toContain('onClick={(e) => e.stopPropagation()}');
      expect(getPassSrc).toMatch(/onChange=\{\(e\)\s*=>\s*\{\s*e\.stopPropagation\(\);\s*void handleOcrFileSelected\(e\);\s*\}\}/);
    });

    it('stops event propagation and prevents default form submission on trigger button', () => {
      const buttonSection = getPassSrc.slice(
        getPassSrc.indexOf('ocrFileInputRef.current?.click()') - 150,
        getPassSrc.indexOf('ocrFileInputRef.current?.click()') + 150
      );
      expect(buttonSection).toContain('e.preventDefault()');
      expect(buttonSection).toContain('e.stopPropagation()');
    });

    it('calls e.stopPropagation() inside handleOcrFileSelected implementation', () => {
      const handlerSection = getPassSrc.slice(
        getPassSrc.indexOf('async function handleOcrFileSelected'),
        getPassSrc.indexOf('async function handleOcrFileSelected') + 200
      );
      expect(handlerSection).toContain('e.stopPropagation()');
    });
  });

  // ==========================================================================
  // 4. NON-NEGOTIABLE OCR STATE PRESERVATION CONTRACT
  // ==========================================================================
  describe('4. Registration State Preservation Contract on OCR Execution', () => {
    it('immediately sets idBlob, idUrl, and idReusedFromOcr upon file selection regardless of OCR result', () => {
      const handlerBody = getPassSrc.slice(
        getPassSrc.indexOf('async function handleOcrFileSelected'),
        getPassSrc.indexOf('async function handleOcrFileSelected') + 1400
      );

      // Previews and blob must be set BEFORE OCR processing begins
      expect(handlerBody).toContain('setIdBlob(normalized)');
      expect(handlerBody).toContain('idUrl.setFromBlob(normalized)');
      expect(handlerBody).toContain('setIdReusedFromOcr(true)');
    });

    it('clears file input value to allow re-selecting the same file if needed', () => {
      const handlerBody = getPassSrc.slice(
        getPassSrc.indexOf('async function handleOcrFileSelected'),
        getPassSrc.indexOf('async function handleOcrFileSelected') + 300
      );
      expect(handlerBody).toContain("e.target.value = ''");
    });

    it('never alters step or resets registrationMode in handleOcrFileSelected', () => {
      const handlerBody = getPassSrc.slice(
        getPassSrc.indexOf('async function handleOcrFileSelected'),
        getPassSrc.indexOf('async function handleOcrFileSelected') + 3500
      );

      expect(handlerBody).not.toContain("setStep('frontdoor')");
      expect(handlerBody).not.toContain('setStep(');
      expect(handlerBody).not.toContain('setRegistrationMode(');
    });

    it('gracefully handles OCR processing error without clearing idBlob or idUrl', () => {
      const catchSection = getPassSrc.slice(
        getPassSrc.indexOf('OCR processing failure:'),
        getPassSrc.indexOf('OCR processing failure:') + 300
      );

      // Catch block shows informative toast but does NOT nullify idBlob or idUrl
      expect(catchSection).not.toContain('setIdBlob(null)');
      expect(catchSection).not.toContain('setIdUrl(null)');
      expect(catchSection).toContain('Automatic text recognition skipped. Your ID image was saved for later verification.');
    });
  });
});
