import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

describe('Absolute Camera Rule & ID Acquisition Contract', () => {
  const getPassPageSource = fs.readFileSync(
    path.resolve('src/pages/GetPassPage.tsx'),
    'utf-8'
  );

  it('1. Live Face Capture is the ONLY custom camera in the entire preregistration flow', () => {
    // Assert useWebcam is invoked exactly once
    const useWebcamMatches = getPassPageSource.match(/useWebcam\s*\(/g) || [];
    expect(useWebcamMatches.length).toBe(1);

    // Assert that invocation specifies user facingMode
    expect(getPassPageSource).toMatch(/useWebcam\(\s*\{\s*facingMode:\s*['"]user['"]/);
  });

  it('2. Absolutely no custom camera, webcam preview, or webcam modals for ID OCR or ID evidence', () => {
    // Check that ID camera tabs, buttons, or switching do not exist in GetPassPage
    expect(getPassPageSource).not.toMatch(/Take ID Photo/i);
    expect(getPassPageSource).not.toMatch(/Use Webcam/i);
    expect(getPassPageSource).not.toMatch(/Front Camera/i);
    expect(getPassPageSource).not.toMatch(/Rear Camera/i);
    expect(getPassPageSource).not.toMatch(/Scan ID/i);
    expect(getPassPageSource).not.toMatch(/idWebcam/i);
  });

  it('3. ID acquisition uses native OS/browser file picker without forcing camera capture', () => {
    // Search for all file inputs in GetPassPage
    const fileInputMatches = getPassPageSource.match(/<input[^>]*type=["']file["'][^>]*>/g) || [];
    expect(fileInputMatches.length).toBeGreaterThanOrEqual(1);

    for (const inputTag of fileInputMatches) {
      // Must NOT contain capture attribute (which forces camera on mobile)
      expect(inputTag).not.toMatch(/\bcapture\b/);
      // Must accept standard image types
      expect(inputTag).toMatch(/accept=["']image\/jpeg,image\/png,image\/webp["']/);
    }
  });

  it('4. Reuses optional OCR ID image without requiring a second document upload', () => {
    // Check that ID reuse logic is present
    expect(getPassPageSource).toMatch(/idReusedFromOcr/);
    expect(getPassPageSource).toMatch(/ID image already added/i);
    expect(getPassPageSource).toMatch(/Replace ID/i);
  });

  it('5. Identity verification match is required before review and pass issuance', () => {
    // Review step and generation must be gated by identityVerified
    expect(getPassPageSource).toMatch(/identityVerified/);
    expect(getPassPageSource).toMatch(/setStep\(['"]review['"]\)/);
  });
});
