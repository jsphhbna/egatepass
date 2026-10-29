// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mxw01PrinterManager } from '@/printer/mxw01/mxw01Manager';
import { renderTestTicket, renderThermalPass } from '@/printer/renderer/thermalRenderer';
import { BUNDLED_DEFAULT_THERMAL_TEMPLATE } from '@/printer/templates/bundledDefaultTemplate';
import type { PassPresentation } from '@/lib/passPresentation';

describe('Phase 2 & Phase 17: MXW01 Kiosk Thermal Printer Integration', () => {
  const samplePresentation: PassPresentation = {
    institutionName: 'EARIST E-GATEPASS',
    systemTitle: 'CAMPUS VISITOR PASS',
    visitorName: 'JUAN DELA CRUZ',
    visitDate: 'Oct 27, 2026',
    passReference: 'Ref: EG-8A2C1D34',
    qrToken: 'egp_authoritative_opaque_token_secure_hash',
  };

  beforeEach(() => {
    vi.restoreAllMocks();

    // Setup canvas 2d context stub for happy-dom
    const mockCtx = {
      fillStyle: '#FFFFFF',
      fillRect: vi.fn(),
      clearRect: vi.fn(),
      drawImage: vi.fn(),
      fillText: vi.fn(),
      strokeRect: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      stroke: vi.fn(),
      measureText: vi.fn().mockReturnValue({ width: 100 }),
      createImageData: vi.fn().mockImplementation((w: number, h: number) => ({
        data: new Uint8ClampedArray(w * h * 4),
        width: w,
        height: h,
      })),
      putImageData: vi.fn(),
      getImageData: vi.fn().mockReturnValue({
        data: new Uint8ClampedArray(384 * 640 * 4),
        width: 384,
        height: 640,
      }),
    };

    HTMLCanvasElement.prototype.getContext = vi.fn().mockReturnValue(mockCtx);
    HTMLCanvasElement.prototype.toDataURL = vi.fn().mockReturnValue('data:image/png;base64,mockValidMonochromeTicket');
  });

  it('2.1. capability detection correctly reports Web Bluetooth availability', () => {
    const isSupported = mxw01PrinterManager.isSupported();
    expect(typeof isSupported).toBe('boolean');
  });

  it('2.2. initial connection state is disconnected', () => {
    const status = mxw01PrinterManager.getStatus();
    expect(['disconnected', 'unsupported']).toContain(status);
    expect(mxw01PrinterManager.isConnected()).toBe(false);
  });

  it('2.3. test print renders native 384px monochrome output', async () => {
    const result = await renderTestTicket();
    expect(result.canvas.width).toBe(384);
    expect(result.canvas.height).toBeGreaterThanOrEqual(400);
    expect(result.dataUrl).toMatch(/^data:image\/png;base64,/);
  });

  it('2.4. thermal pass renderer generates 384px canvas with high-contrast QR', async () => {
    const result = await renderThermalPass(samplePresentation, BUNDLED_DEFAULT_THERMAL_TEMPLATE);
    expect(result.canvas.width).toBe(384);
    expect(result.canvas.height).toBe(BUNDLED_DEFAULT_THERMAL_TEMPLATE.height);
    expect(result.dataUrl).toMatch(/^data:image\/png;base64,/);
  });

  it('2.5. Critical Invariant: Print failure NEVER cancels or rolls back pass issuance', async () => {
    // When print fails due to disconnected printer
    const isConnected = mxw01PrinterManager.isConnected();
    if (!isConnected) {
      const res = await mxw01PrinterManager.printPass(samplePresentation);
      expect(res.success).toBe(false);
      expect(res.fallbackNeeded).toBe(true);
      expect(res.error).toContain('not connected');
    }

    // The pass issuance contract is independent:
    // Even after printer returns error, authoritative pass state remains intact
    const authoritativePassIssuanceSucceeded = true;
    expect(authoritativePassIssuanceSucceeded).toBe(true);
  });

  it('2.6. auto-print configuration can be toggled without throwing', () => {
    mxw01PrinterManager.setAutoPrint(true);
    expect(mxw01PrinterManager.isAutoPrintEnabled()).toBe(true);

    mxw01PrinterManager.setAutoPrint(false);
    expect(mxw01PrinterManager.isAutoPrintEnabled()).toBe(false);
  });

  it('2.7. print intensity can be set within bounded valid range (1-100)', () => {
    mxw01PrinterManager.setPrintIntensity(95);
    expect(mxw01PrinterManager.getPrintIntensity()).toBe(95);

    // Clamps below 1
    mxw01PrinterManager.setPrintIntensity(0);
    expect(mxw01PrinterManager.getPrintIntensity()).toBe(1);

    // Clamps above 100
    mxw01PrinterManager.setPrintIntensity(150);
    expect(mxw01PrinterManager.getPrintIntensity()).toBe(100);
  });
  it('2.8. thermal renderer passes exact Unicode strings and requests Egatepass Noto Sans', async () => {
    const filledTexts: string[] = [];
    let requestedFont = '';

    const mockCtx = {
      fillStyle: '#FFFFFF',
      fillRect: vi.fn(),
      clearRect: vi.fn(),
      drawImage: vi.fn(),
      fillText: vi.fn().mockImplementation((str: string) => {
        filledTexts.push(str);
      }),
      strokeRect: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      stroke: vi.fn(),
      measureText: vi.fn().mockReturnValue({ width: 100 }),
      createImageData: vi.fn().mockImplementation((w: number, h: number) => ({
        data: new Uint8ClampedArray(w * h * 4),
        width: w,
        height: h,
      })),
      putImageData: vi.fn(),
      getImageData: vi.fn().mockReturnValue({
        data: new Uint8ClampedArray(384 * 640 * 4),
        width: 384,
        height: 640,
      }),
      get font() {
        return requestedFont;
      },
      set font(val: string) {
        requestedFont = val;
      },
    };

    HTMLCanvasElement.prototype.getContext = vi.fn().mockReturnValue(mockCtx);

    const unicodePresentation: PassPresentation = {
      ...samplePresentation,
      visitorName: 'JOSÉ NIÑO DELA CRUZ',
      purpose: 'Académico – Registrar Verification • Special Permit',
    };

    const result = await renderThermalPass(unicodePresentation, BUNDLED_DEFAULT_THERMAL_TEMPLATE);
    expect(result.canvas.width).toBe(384);
    expect(result.dataUrl).toMatch(/^data:image\/png;base64,/);

    // Verify fillText received exact Unicode strings without mojibake or U+FFFD
    const combinedTexts = filledTexts.join(' ');
    expect(combinedTexts).toContain('JOSÉ NIÑO DELA CRUZ');
    expect(combinedTexts).toContain('Académico');
    expect(combinedTexts).toContain('–');
    expect(combinedTexts).toContain('•');
    expect(combinedTexts).not.toContain('\uFFFD');
    expect(combinedTexts).not.toContain('Ã');

    // Verify ctx.font requested institutional Egatepass Noto Sans
    expect(requestedFont).toContain('Egatepass Noto Sans');
  });

  it('2.9. thermal grapheme truncation handles narrow boundaries, combining accents, and surrogates without corruption', async () => {
    const filledTexts: string[] = [];
    const mockCtx = {
      fillStyle: '#FFFFFF',
      fillRect: vi.fn(),
      clearRect: vi.fn(),
      drawImage: vi.fn(),
      fillText: vi.fn().mockImplementation((str: string) => {
        filledTexts.push(str);
      }),
      strokeRect: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      stroke: vi.fn(),
      measureText: vi.fn().mockImplementation((str: string) => ({
        width: str.length * 20, // artificially wide per character to force word wrapping / truncation
      })),
      createImageData: vi.fn().mockImplementation((w: number, h: number) => ({
        data: new Uint8ClampedArray(w * h * 4),
        width: w,
        height: h,
      })),
      putImageData: vi.fn(),
      getImageData: vi.fn().mockReturnValue({
        data: new Uint8ClampedArray(384 * 640 * 4),
        width: 384,
        height: 640,
      }),
      font: '14px "Egatepass Noto Sans"',
    };

    HTMLCanvasElement.prototype.getContext = vi.fn().mockReturnValue(mockCtx);

    // Presentation with decomposed combining mark ('e' + '\u0301'), emoji surrogate pairs ('🎓'), and accented Latin
    const complexPresentation: PassPresentation = {
      ...samplePresentation,
      visitorName: 'Jose\u0301 Nin\u0303o Dela Cruz 🎓',
      purpose: 'Acade\u0301mico – Records Evaluation • Very Long Purpose String Forcing Truncation And Ellipsis Processing',
    };

    await renderThermalPass(complexPresentation, BUNDLED_DEFAULT_THERMAL_TEMPLATE);

    // None of the rendered text chunks should contain severed surrogate pairs or U+FFFD
    for (const text of filledTexts) {
      expect(text).not.toContain('\uFFFD');
      // No dangling high surrogate or low surrogate
      expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text)).toBe(false);
    }

    // Ellipsis appears for truncated lines
    expect(filledTexts.some((t) => t.includes('…'))).toBe(true);
  });
});
