import { describe, it, expect } from 'vitest';
import { generateCanonicalDigitalPassSvg, escapeXml } from '@/lib/digitalPassArtifact';
import { createPassPresentation } from '@/lib/passPresentation';
import { renderDigitalPassPngBuffer } from '../server/lib/render-digital-pass';

describe('Group D: Canonical Digital E-GatePass Contract & Parity', () => {
  const samplePass = {
    id: 'e5f6a7b8-1234-5678-9abc-def012345678',
    visitorName: 'Juan & Maria Dela <Cruz>',
    visitDate: '2026-10-28',
    passReference: 'EG-E5F6A7B8',
    qrToken: 'egp_opaque_token_canonical_digital_pass_987654321',
    validityWindow: 'Valid until 5:00 PM',
    purpose: 'Official Business "Meeting" & Consultation',
  };

  const sampleQrDataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

  it('escapes XML special characters to prevent SVG injection', () => {
    expect(escapeXml('<script>alert("xss")</script>')).toBe('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');
    expect(escapeXml("Juan & Maria's Pass")).toBe('Juan &amp; Maria&apos;s Pass');
  });

  it('generates canonical SVG with institutional brand and escaped fields', () => {
    const presentation = createPassPresentation(samplePass);
    const svg = generateCanonicalDigitalPassSvg(presentation, sampleQrDataUrl);

    // Fixed geometry
    expect(svg).toContain('viewBox="0 0 480 696"');
    expect(svg).toContain('width="480"');
    expect(svg).toContain('height="696"');

    // Institutional palette
    expect(svg).toContain('#800000'); // Maroon
    expect(svg).toContain('#DAA520'); // Gold

    // Institutional Header
    expect(svg).toContain('EARIST E-GATEPASS');
    expect(svg).toContain('OFFICIAL CAMPUS VISITOR ACCESS PASS');

    // Escaped visitor name and purpose
    expect(svg).toContain('JUAN &amp; MARIA DELA &lt;CRUZ&gt;');
    expect(svg).toContain('Official Business &quot;Meeting&quot; &amp; Consult');

    // Canonical pass reference
    expect(svg).toContain('EG-E5F6A7B8');

    // Embedded QR data URI
    expect(svg).toContain(sampleQrDataUrl);

    // Raw QR token is NEVER rendered as raw text in SVG
    expect(svg).not.toContain('egp_opaque_token_canonical_digital_pass_987654321');

    // Neutral institutional privacy wording (not legal compliance certification)
    expect(svg).toContain('Nagtahan, Sampaloc, Manila • Visitor information handled under EARIST privacy policy');
    expect(svg).not.toContain('Data Privacy Act Aligned');
  });

  it('proves browser and server QR generators share the exact same branded QR visual config', async () => {
    const { BRANDED_QR_CONFIG } = await import('@/lib/brandedQrConfig');
    expect(BRANDED_QR_CONFIG).toBeDefined();
    expect(BRANDED_QR_CONFIG.size).toBe(360);
    expect(BRANDED_QR_CONFIG.margin).toBe(2);
    expect(BRANDED_QR_CONFIG.errorCorrectionLevel).toBe('H');
    expect(BRANDED_QR_CONFIG.logoRatio).toBe(0.17);
    expect(BRANDED_QR_CONFIG.logoPadding).toBe(6);
    expect(BRANDED_QR_CONFIG.logoBackingRadius).toBe(6);
    expect(BRANDED_QR_CONFIG.canonicalLogoAsset).toBe('/earist-logo.png');
    expect(BRANDED_QR_CONFIG.darkColor).toBe('#000000');
    expect(BRANDED_QR_CONFIG.lightColor).toBe('#ffffff');
  });

  it('server rasterizer uses the shared canonical SVG and produces a valid PNG Buffer', async () => {
    const result = await renderDigitalPassPngBuffer({
      fullName: samplePass.visitorName,
      visitDate: samplePass.visitDate,
      publicReference: samplePass.passReference,
      qrToken: samplePass.qrToken,
      purpose: samplePass.purpose,
    });

    expect(result.filename).toBe('egatepass-EG-E5F6A7B8.png');
    expect(result.pngBuffer).toBeInstanceOf(Buffer);
    expect(result.pngBuffer.length).toBeGreaterThan(100);

    // PNG signature: 0x89, 0x50, 0x4E, 0x47
    expect(result.pngBuffer[0]).toBe(0x89);
    expect(result.pngBuffer[1]).toBe(0x50);
    expect(result.pngBuffer[2]).toBe(0x4e);
    expect(result.pngBuffer[3]).toBe(0x47);
  });

  it('email attachment filename conforms to canonical egatepass-EG-XXXXXXXX.png format (not bare QR)', () => {
    const presentation = createPassPresentation(samplePass);
    const expectedFilename = `egatepass-${presentation.passReference}.png`;
    expect(expectedFilename).toBe('egatepass-EG-E5F6A7B8.png');
    expect(expectedFilename).not.toBe('earist-gate-pass-qr.png');
  });
  it('server rasterizer renders Unicode glyphs (José Niño Dela Cruz, •, –) deterministically with sharp', async () => {
    const unicodePass = {
      fullName: 'José Niño Dela Cruz',
      visitDate: '2026-10-30',
      publicReference: 'EG-99998888',
      qrToken: 'egp_token_unicode_glyph_test',
      purpose: 'Académico – Registrar Verification • Compliance',
    };

    const result = await renderDigitalPassPngBuffer(unicodePass);
    expect(result.pngBuffer).toBeInstanceOf(Buffer);

    const { default: sharp } = await import('sharp');
    const metadata = await sharp(result.pngBuffer).metadata();
    expect(metadata.width).toBe(480);
    expect(metadata.height).toBe(696);
    expect(metadata.format).toBe('png');
    expect(result.presentation.visitorName).toBe('JOSÉ NIÑO DELA CRUZ');
  });
});
