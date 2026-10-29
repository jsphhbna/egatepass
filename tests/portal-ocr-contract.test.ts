import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

describe('FEATURE 2 CONTRACT: Optional Portal OCR & Kiosk Boundary', () => {
  const getPassSrc = readFileSync('src/pages/GetPassPage.tsx', 'utf8');
  const kioskSrc = readFileSync('src/pages/KioskPage.tsx', 'utf8');

  it('provides a subtle optional OCR CTA near the personal details section', () => {
    expect(getPassSrc).toContain('Want to fill in faster?');
    expect(getPassSrc).toContain('Scan your ID to autofill your information.');
    expect(getPassSrc).toContain('Autofill from ID');
  });

  it('keeps manual registration form fully usable without selecting OCR', () => {
    // Form submit relies on standard form handlers and inputs
    expect(getPassSrc).toContain("onSubmit={handleSubmit(onFormNext)}");
    expect(getPassSrc).toContain("{...register('firstName')}");
    expect(getPassSrc).toContain("{...register('lastName')}");
  });

  it('uses browser-local recognizeIdImage without third-party cloud OCR services', () => {
    expect(getPassSrc).toMatch(/import\s*\{[^}]*recognizeIdImage[^}]*\}\s*from\s*'@\/lib\/ocr'/);
    expect(getPassSrc).toContain('await recognizeIdImage(source)');
    // Preserves local privacy boundary
    expect(getPassSrc).not.toContain('google-cloud-vision');
    expect(getPassSrc).not.toContain('aws-rekognition');
  });

  it('extracts only supported name fields and preserves existing user-entered text', () => {
    expect(getPassSrc).toContain('!currentValues.firstName?.trim() && parsed.firstName');
    expect(getPassSrc).toContain('!currentValues.middleName?.trim() && parsed.middleName');
    expect(getPassSrc).toContain('!currentValues.lastName?.trim() && parsed.lastName');
  });

  it('does NOT automatically submit upon OCR completion, keeping values user-reviewed and editable', () => {
    // Does not invoke onSubmit or issueVisitorPass inside processOcrImage
    const processOcrMatch = getPassSrc.match(/async function processOcrImage[\s\S]*?finally/);
    expect(processOcrMatch).toBeTruthy();
    const ocrFn = processOcrMatch![0];

    expect(ocrFn).not.toContain('onSubmit()');
    expect(ocrFn).not.toContain('issueVisitorPass(');
    expect(ocrFn).not.toContain("setStep('generating')");
    expect(ocrFn).not.toContain("setStep('done')");
  });

  it('handles OCR failure gracefully without discarding valid ID image evidence', () => {
    const processOcrMatch = getPassSrc.match(/async function processOcrImage[\s\S]*?finally/);
    expect(processOcrMatch).toBeTruthy();
    const ocrFn = processOcrMatch![0];

    // Image is stored before OCR parsing
    expect(ocrFn).toContain('setIdBlob(compressed)');
    expect(ocrFn).toContain('idUrl.setFromBlob(compressed)');
    // Failure shows user-facing manual entry fallback without clearing idBlob
    expect(ocrFn).toContain('Automatic ID reading is unavailable right now. Your ID was still added successfully.');
  });

  it('reuses ID evidence in later Valid ID step if captured during OCR', () => {
    expect(getPassSrc).toContain("idPreview ? 'Valid ID Added' : 'Capture Valid ID'");
    expect(getPassSrc).toContain('ID image attached and saved for registration.');
    expect(getPassSrc).toContain('Retake ID');
    expect(getPassSrc).toContain("setStep('review')");
  });

  it('preserves existing OCR-first physical kiosk workflow unchanged', () => {
    expect(kioskSrc).toContain('recognizeIdImage');
    expect(kioskSrc).toContain('Scan My ID');
    expect(kioskSrc).toContain('Position Your ID in the Frame');
  });

  it('PATCH 7: terminates OCR worker on unmount and reset, and prevents stale writes with generation check', () => {
    // 7A: imports terminateLocalOcrWorker
    expect(getPassSrc).toMatch(/import\s*\{[^}]*terminateLocalOcrWorker[^}]*\}\s*from\s*'@\/lib\/ocr'/);

    // 7B: unmount cleanup
    expect(getPassSrc).toContain('void terminateLocalOcrWorker()');

    // 7D: ocrGenerationRef tracking and stale write guard
    expect(getPassSrc).toContain('const ocrGenerationRef = useRef(0)');
    expect(getPassSrc).toContain('const generation = ++ocrGenerationRef.current');
    expect(getPassSrc).toContain('if (generation !== ocrGenerationRef.current) return');

    // Reset and ID invalidation increment generation
    expect(getPassSrc).toContain('function resetRegistrationFlow()');
  });

  it('PATCH 11: rejects raw ID upload files larger than 10 MiB before decode/compression', () => {
    expect(getPassSrc).toContain('const MAX_RAW_ID_FILE_BYTES = 10 * 1024 * 1024');
    expect(getPassSrc).toContain('file.size > MAX_RAW_ID_FILE_BYTES');
    expect(getPassSrc).toContain(
      'This image is too large to process safely. Please choose an image 10 MB or smaller.',
    );
  });
});
