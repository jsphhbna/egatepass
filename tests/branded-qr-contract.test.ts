import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import jsQR from 'jsqr';
import { PNG } from 'pngjs';
import { QR_BRANDED_CONFIG, generateBrandedQrDataUrl } from '@/lib/brandedQr';
import { SERVER_QR_CONFIG, generateBrandedQrPngBuffer } from '../server/brandedQr';

describe('FEATURE 3 CONTRACT: EARIST Branded QR Code and Scanner Decoding', () => {
  const getPassSrc = readFileSync('src/pages/GetPassPage.tsx', 'utf8');
  const kioskSrc = readFileSync('src/pages/KioskPage.tsx', 'utf8');
  const emailSrc = readFileSync('server/email.ts', 'utf8');

  it('configures High Error Correction (H) across both client and server branding configs', () => {
    expect(QR_BRANDED_CONFIG.errorCorrectionLevel).toBe('H');
    expect(SERVER_QR_CONFIG.errorCorrectionLevel).toBe('H');
  });

  it('restricts logo overlay ratio to safe bounds (15-18% of QR width)', () => {
    expect(QR_BRANDED_CONFIG.logoRatio).toBeGreaterThanOrEqual(0.15);
    expect(QR_BRANDED_CONFIG.logoRatio).toBeLessThanOrEqual(0.18);
    expect(SERVER_QR_CONFIG.logoRatio).toBeGreaterThanOrEqual(0.15);
    expect(SERVER_QR_CONFIG.logoRatio).toBeLessThanOrEqual(0.18);
  });

  it('defines white backing padding and proper quiet zone margins', () => {
    expect(QR_BRANDED_CONFIG.logoPadding).toBeGreaterThan(0);
    expect(QR_BRANDED_CONFIG.margin).toBeGreaterThanOrEqual(2);
    expect(SERVER_QR_CONFIG.logoPadding).toBeGreaterThan(0);
    expect(SERVER_QR_CONFIG.margin).toBeGreaterThanOrEqual(2);
  });

  it('uses generateBrandedQrDataUrl in GetPassPage and KioskPage for visitor QR rendering', () => {
    expect(getPassSrc).toContain('generateBrandedQrDataUrl');
    expect(kioskSrc).toContain('generateBrandedQrDataUrl');
  });

  it('uses generateBrandedQrPngBuffer in server/email.ts for email attachment', () => {
    expect(emailSrc).toContain('generateBrandedQrPngBuffer');
  });

  it('preserves exact raw bearer token without mutation during server branded QR generation', async () => {
    const rawToken = 'v1.test-bearer-token.sha256-signature-12345';
    const buf = await generateBrandedQrPngBuffer(rawToken);
    const png = PNG.sync.read(buf);
    const code = jsQR(new Uint8ClampedArray(png.data), png.width, png.height);

    expect(code).not.toBeNull();
    expect(code!.data).toBe(rawToken);
  });

  it('reliably decodes branded QR with complex realistic pass tokens', async () => {
    const complexToken = 'v1.4a8b7c9d-1111-2222-3333-444455556666.sig_abc123XYZ_789';
    const buf = await generateBrandedQrPngBuffer(complexToken);
    const png = PNG.sync.read(buf);
    const code = jsQR(new Uint8ClampedArray(png.data), png.width, png.height);

    expect(code).not.toBeNull();
    expect(code!.data).toBe(complexToken);
  });
});
