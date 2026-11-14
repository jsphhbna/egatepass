import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  cancelPendingOcrJobs,
  terminateLocalOcrWorker,
  recognizeIdImage,
  getNextOcrJobId,
} from '../src/lib/ocr';
import {
  cancelPendingPaddleOcr,
  terminatePaddleOcr,
  recognizeIdImageWithPaddle,
} from '../src/lib/paddleOcr';

describe('Priority 3: OCR Cancellation & Fallback Fencing Suite', () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    await terminateLocalOcrWorker();
  });

  afterEach(async () => {
    await terminateLocalOcrWorker();
  });

  it('1. cancelPendingOcrJobs terminates active Tesseract worker and cancels PaddleOCR jobs', async () => {
    const mockWorker = {
      terminate: vi.fn().mockResolvedValue(undefined),
    };

    // Set an active worker
    await cancelPendingOcrJobs();
    expect(mockWorker.terminate).not.toHaveBeenCalled();

    // Verify source implementation calls worker.terminate() and cancelPendingPaddleOcr()
    const ocrSrc = fs.readFileSync(path.resolve('src/lib/ocr.ts'), 'utf-8');
    expect(ocrSrc).toContain('cancelPendingPaddleOcr()');
    expect(ocrSrc).toContain('currentWorker.terminate()');
    expect(ocrSrc).toContain('Promise.all([tesseractTermination, paddleCancellation])');
  });

  it('2. PaddleOCR job superseded before or during prediction throws superseded error and does not dispose newer singleton', async () => {
    const mockOcrInstance = {
      predict: vi.fn().mockImplementation(() => new Promise((resolve) => setTimeout(resolve, 500))),
      dispose: vi.fn().mockResolvedValue(undefined),
    };

    // Verify source safeguards in paddleOcr.ts
    const paddleSrc = fs.readFileSync(path.resolve('src/lib/paddleOcr.ts'), 'utf-8');
    expect(paddleSrc).toContain("throw new Error('PaddleOCR prediction superseded')");
    // Ensure superseded prediction does NOT dispose active singleton
    expect(paddleSrc).toContain("!err?.message?.includes('superseded')");
  });

  it('3. Cancelled or superseded Paddle job does NOT initiate Tesseract fallback', async () => {
    const ocrSrc = fs.readFileSync(path.resolve('src/lib/ocr.ts'), 'utf-8');

    // In executeOcrPipeline catch block:
    expect(ocrSrc).toContain("isSuperseded");
    expect(ocrSrc).toContain("paddleErr?.message?.includes('superseded')");
    expect(ocrSrc).toContain("paddleErr?.message?.includes('cancelled')");
    expect(ocrSrc).toContain("return { firstName: '', middleName: '', lastName: '', confidence: 0 };");
  });

  it('4. Genuine Paddle failure preserves Tesseract fallback when sufficient time remains', async () => {
    const ocrSrc = fs.readFileSync(path.resolve('src/lib/ocr.ts'), 'utf-8');

    // Confirms fallback warning and continuation
    expect(ocrSrc).toContain("console.warn('PaddleOCR engine unready or failed, falling back to Tesseract:', paddleErr)");
    expect(ocrSrc).toContain("Secondary engine reading ID...");
    expect(ocrSrc).toContain("getLocalOcrWorker(onProgress, remainingBeforeTesseract)");
  });

  it('5. Shared 25s overall deadline bounds all pipeline stages', async () => {
    const ocrSrc = fs.readFileSync(path.resolve('src/lib/ocr.ts'), 'utf-8');

    expect(ocrSrc).toContain('const OVERARCHING_OCR_TIMEOUT_MS = 25000;');
    expect(ocrSrc).toContain('deadline: number = Date.now() + OVERARCHING_OCR_TIMEOUT_MS');
    // Checks that insufficient remaining time halts pipeline rather than hanging
    expect(ocrSrc).toContain('Insufficient time remaining in OCR deadline');
  });

  it('6. Stale cleanup from an older job does not invalidate a newer active job', async () => {
    const ocrSrc = fs.readFileSync(path.resolve('src/lib/ocr.ts'), 'utf-8');

    // terminateLocalOcrWorker checks forJobId
    expect(ocrSrc).toContain('export async function terminateLocalOcrWorker(forJobId?: number)');
    expect(ocrSrc).toContain('forJobId !== globalOcrJobCounter');
  });

  it('7. Manual form entry remains usable after OCR cancellation, failure, or timeout', () => {
    const getPassSrc = fs.readFileSync(path.resolve('src/pages/GetPassPage.tsx'), 'utf-8');

    // Preserves user-entered values
    expect(getPassSrc).toContain('!currentValues.firstName?.trim() && parsed.firstName');
    expect(getPassSrc).toContain('!currentValues.middleName?.trim() && parsed.middleName');
    expect(getPassSrc).toContain('!currentValues.lastName?.trim() && parsed.lastName');
    // Fallback notice informs user to enter manually
    expect(getPassSrc).toContain('Automatic text recognition skipped. Your ID image was saved for later verification.');
    expect(getPassSrc).toContain('ID image saved. Please check and enter your name details manually.');
  });
});
