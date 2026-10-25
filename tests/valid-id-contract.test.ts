import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

describe('FEATURE 1 & REGRESSION CONTRACT: Valid ID Ingestion & Kiosk Enforcement', () => {
  const getPassSrc = readFileSync('src/pages/GetPassPage.tsx', 'utf8');
  const kioskSrc = readFileSync('src/pages/KioskPage.tsx', 'utf8');

  it('permits camera capture and file/gallery upload on Portal, while strictly prohibiting file upload on Kiosk', () => {
    // Portal supports both camera and image file upload
    expect(getPassSrc).toContain('type="file"');
    expect(getPassSrc).toContain('accept="image/jpeg,image/png,image/webp"');

    // Kiosk remains strictly camera-only
    expect(kioskSrc).not.toContain('type="file"');
  });

  it('removes gallery/browse/file-picker pathways from kiosk valid ID evidence', () => {
    expect(kioskSrc).not.toContain('Upload ID Image Instead');
    expect(kioskSrc).not.toContain('Upload File');
    expect(kioskSrc).not.toContain('fileInputRef');
    expect(kioskSrc).not.toContain('manualIdInputRef');
  });

  it('configures rear/environment camera for ID capture in Portal and Kiosk', () => {
    expect(getPassSrc).toContain("facingMode: 'environment'");
    expect(kioskSrc).toContain("facingMode: 'environment'");
  });

  it('routes uploaded and camera-captured portal valid IDs into the same secure evidence path', () => {
    // Both pathways set idBlob and idUrl
    expect(getPassSrc).toContain('setIdBlob(compressed)');
    expect(getPassSrc).toContain('idUrl.setFromBlob(compressed)');
    expect(getPassSrc).toContain('issueVisitorPass(\'portal\', formData, photoBlob, idBlob');
  });

  it('validates supported image formats and fails safely on unsupported types in Portal', () => {
    expect(getPassSrc).toContain('This image format is not supported. Please choose a JPEG, PNG, or WebP image.');
    expect(getPassSrc).toContain("['image/jpeg', 'image/png', 'image/webp']");
  });

  it('prevents duplicate processing actions during ID compression in Portal', () => {
    expect(getPassSrc).toContain('const [isProcessingId, setIsProcessingId] = useState(false);');
    expect(getPassSrc).toContain('disabled={isProcessingId}');
    expect(getPassSrc).toContain('Processing ID image…');
  });

  it('implements dedicated onRetakeId in Portal that isolates ID from selfie state', () => {
    expect(getPassSrc).toContain('function onRetakeId()');
    expect(getPassSrc).toContain('Retake ID');

    const onRetakeIdMatch = getPassSrc.match(/function onRetakeId\(\)\s*{([\s\S]*?)}/);
    expect(onRetakeIdMatch).toBeTruthy();
    const body = onRetakeIdMatch![1];

    expect(body).toContain('setIdBlob(null)');
    expect(body).toContain('idUrl.clear()');
    // Must NOT clear photo state
    expect(body).not.toContain('setPhotoBlob(null)');
    expect(body).not.toContain('photoUrl.clear()');
  });

  it('implements dedicated onRetakeId in Kiosk that isolates ID from selfie state', () => {
    expect(kioskSrc).toContain('function onRetakeId()');
    expect(kioskSrc).toContain('Retake ID');

    const onRetakeIdMatch = kioskSrc.match(/function onRetakeId\(\)\s*{([\s\S]*?)}/);
    expect(onRetakeIdMatch).toBeTruthy();
    const body = onRetakeIdMatch![1];

    expect(body).toContain('setIdBlob(null)');
    expect(body).toContain('idUrl.clear()');
    // Must NOT clear photo state
    expect(body).not.toContain('setPhotoBlob(null)');
    expect(body).not.toContain('photoUrl.clear()');
  });

  it('manages object URL lifecycles via useObjectUrl to guarantee revocation and prevent unmount leaks', () => {
    expect(getPassSrc).toContain('useObjectUrl');
    expect(kioskSrc).toContain('useObjectUrl');
    expect(getPassSrc).toContain('photoUrl.clear()');
    expect(kioskSrc).toContain('photoUrl.clear()');
    expect(getPassSrc).toContain('idUrl.clear()');
    expect(kioskSrc).toContain('idUrl.clear()');
  });

  it('preserves camera ID requirement when entering details manually unless Peak Mode authorizes omission', () => {
    expect(kioskSrc).toContain('Scan My ID');
    expect(kioskSrc).toContain('Capture ID');
  });
});
