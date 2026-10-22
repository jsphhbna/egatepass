import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

describe('FIX GROUP C: Valid ID Camera Flow & Retake Isolation', () => {
  const getPassSrc = readFileSync('src/pages/GetPassPage.tsx', 'utf8');
  const kioskSrc = readFileSync('src/pages/KioskPage.tsx', 'utf8');

  it('prohibits type="file" inputs in both Portal and Kiosk registration pages', () => {
    expect(getPassSrc).not.toContain('type="file"');
    expect(kioskSrc).not.toContain('type="file"');
  });

  it('removes gallery/browse/file-picker pathways from valid ID evidence', () => {
    expect(kioskSrc).not.toContain('Upload ID Image Instead');
    expect(kioskSrc).not.toContain('Upload File');
    expect(kioskSrc).not.toContain('fileInputRef');
    expect(kioskSrc).not.toContain('manualIdInputRef');
    expect(getPassSrc).not.toContain('idFileInputRef');
  });

  it('configures rear/environment camera for ID capture in Portal and Kiosk', () => {
    expect(getPassSrc).toContain("facingMode: 'environment'");
    expect(kioskSrc).toContain("facingMode: 'environment'");
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
