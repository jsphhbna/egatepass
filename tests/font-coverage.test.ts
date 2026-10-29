import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  resolveBundledFontsDir,
  ensureServerFonts,
  __resetServerFontInitializationForTests,
} from '../server/lib/server-fonts';
import { renderDigitalPassPngBuffer } from '../server/lib/render-digital-pass';

/**
 * Lightweight TTF cmap subtable format 4 parser.
 * Reads the TrueType offset table and directory, locates the Unicode/Windows BMP cmap subtable,
 * and looks up the glyph index mapped to the given Unicode code point.
 */
function getCmapGlyphIndex(fontBuffer: Buffer, charCode: number): number {
  const numTables = fontBuffer.readUInt16BE(4);
  let cmapOffset = 0;

  for (let i = 0; i < numTables; i++) {
    const tag = fontBuffer.toString('ascii', 12 + i * 16, 12 + i * 16 + 4);
    if (tag === 'cmap') {
      cmapOffset = fontBuffer.readUInt32BE(12 + i * 16 + 8);
      break;
    }
  }

  if (!cmapOffset) return 0;

  const numSubtables = fontBuffer.readUInt16BE(cmapOffset + 2);
  let subtableOffset = 0;

  for (let i = 0; i < numSubtables; i++) {
    const platformId = fontBuffer.readUInt16BE(cmapOffset + 4 + i * 8);
    const encodingId = fontBuffer.readUInt16BE(cmapOffset + 4 + i * 8 + 2);
    // Platform 0 (Unicode) or Platform 3 (Windows Unicode BMP)
    if ((platformId === 0 && (encodingId === 3 || encodingId === 4)) || (platformId === 3 && encodingId === 1)) {
      subtableOffset = cmapOffset + fontBuffer.readUInt32BE(cmapOffset + 4 + i * 8 + 4);
      break;
    }
  }

  if (!subtableOffset) return 0;

  const format = fontBuffer.readUInt16BE(subtableOffset);
  if (format !== 4) return 0;

  const segCountX2 = fontBuffer.readUInt16BE(subtableOffset + 6);
  const segCount = segCountX2 / 2;
  const endCodeOffset = subtableOffset + 14;
  const startCodeOffset = endCodeOffset + segCountX2 + 2;
  const idDeltaOffset = startCodeOffset + segCountX2;
  const idRangeOffsetOffset = idDeltaOffset + segCountX2;

  for (let i = 0; i < segCount; i++) {
    const endCode = fontBuffer.readUInt16BE(endCodeOffset + i * 2);
    const startCode = fontBuffer.readUInt16BE(startCodeOffset + i * 2);
    if (startCode <= charCode && charCode <= endCode) {
      const idDelta = fontBuffer.readInt16BE(idDeltaOffset + i * 2);
      const idRangeOffset = fontBuffer.readUInt16BE(idRangeOffsetOffset + i * 2);
      if (idRangeOffset === 0) {
        return (charCode + idDelta) & 0xffff;
      }
      const glyphIndexOffset = idRangeOffsetOffset + i * 2 + idRangeOffset + (charCode - startCode) * 2;
      return fontBuffer.readUInt16BE(glyphIndexOffset);
    }
  }

  return 0;
}

describe('Workstream B: Bundled Noto Sans Font Coverage & Fail-Closed Contract', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    __resetServerFontInitializationForTests();
  });

  const REGRESSION_CHARSET = [
    // Standard Latin uppercase & lowercase
    ...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz',
    // Filipino & Spanish accented Latin vowels & consonants
    'Ñ', 'ñ', 'É', 'é', 'Á', 'á', 'Ü', 'ü', 'Ç', 'ç',
    // Punctuation and typographical symbols
    '•', '–', '—', '’', '“', '”',
  ];

  it('proves NotoSans-Regular.ttf contains verified cmap glyph mappings for all regression characters', () => {
    const regularPath = path.resolve(process.cwd(), 'public/fonts/NotoSans-Regular.ttf');
    expect(fs.existsSync(regularPath), 'Missing NotoSans-Regular.ttf').toBe(true);
    const buffer = fs.readFileSync(regularPath);

    for (const char of REGRESSION_CHARSET) {
      const code = char.charCodeAt(0);
      const glyphId = getCmapGlyphIndex(buffer, code);
      expect(glyphId, `Regular font missing cmap glyph for character "${char}" (U+${code.toString(16).padStart(4, '0')})`).toBeGreaterThan(0);
    }
  });

  it('proves NotoSans-Bold.ttf contains verified cmap glyph mappings for all regression characters', () => {
    const boldPath = path.resolve(process.cwd(), 'public/fonts/NotoSans-Bold.ttf');
    expect(fs.existsSync(boldPath), 'Missing NotoSans-Bold.ttf').toBe(true);
    const buffer = fs.readFileSync(boldPath);

    for (const char of REGRESSION_CHARSET) {
      const code = char.charCodeAt(0);
      const glyphId = getCmapGlyphIndex(buffer, code);
      expect(glyphId, `Bold font missing cmap glyph for character "${char}" (U+${code.toString(16).padStart(4, '0')})`).toBeGreaterThan(0);
    }
  });

  it('server fontconfig initializes correctly and configures FONTCONFIG_FILE with both regular and bold mapped', async () => {
    const fontsDir = resolveBundledFontsDir();
    expect(fontsDir).not.toBeNull();
    expect(fs.existsSync(fontsDir!)).toBe(true);

    await ensureServerFonts();

    expect(process.env.FONTCONFIG_FILE).toBeDefined();
    expect(fs.existsSync(process.env.FONTCONFIG_FILE!)).toBe(true);

    const confXml = fs.readFileSync(process.env.FONTCONFIG_FILE!, 'utf8');
    expect(confXml).toContain('<fontconfig>');
    expect(confXml).toContain('Noto Sans');
    expect(confXml).toContain('Egatepass Noto Sans');
  });

  it('fails closed: ensureServerFonts rejects and prevents PNG rendering when mandatory font assets are missing', async () => {
    __resetServerFontInitializationForTests();

    // Mock fs.existsSync to simulate missing font assets
    const originalExistsSync = fs.existsSync;
    vi.spyOn(fs, 'existsSync').mockImplementation((p: fs.PathLike) => {
      const str = String(p);
      if (str.includes('NotoSans-Regular.ttf') || str.includes('NotoSans-Bold.ttf')) {
        return false;
      }
      return originalExistsSync(p);
    });

    // 1. ensureServerFonts must reject with authoritative error
    await expect(ensureServerFonts()).rejects.toThrow('server_font_initialization_failed');

    // 2. renderDigitalPassPngBuffer must reject without producing any buffer
    await expect(renderDigitalPassPngBuffer({
      fullName: 'Fail Closed Visitor',
      visitDate: '2026-10-30',
      publicReference: 'EG-FAIL0001',
      qrToken: 'test-fail-token',
    })).rejects.toThrow('server_font_initialization_failed');
  });

  it('browser global stylesheet index.css registers @font-face for Egatepass Noto Sans with local bundled assets', () => {
    const cssPath = path.resolve(process.cwd(), 'src/index.css');
    expect(fs.existsSync(cssPath), 'Missing src/index.css').toBe(true);

    const cssContent = fs.readFileSync(cssPath, 'utf8');

    // Asserts @font-face declarations for both normal (400) and bold (700) weights
    expect(cssContent).toContain('@font-face');
    expect(cssContent).toContain('font-family: "Egatepass Noto Sans"');
    expect(cssContent).toContain('/fonts/NotoSans-Regular.ttf');
    expect(cssContent).toContain('/fonts/NotoSans-Bold.ttf');
    expect(cssContent).toContain('font-weight: 400');
    expect(cssContent).toContain('font-weight: 700');

    // No external Google fonts in the stylesheet
    expect(cssContent).not.toContain('fonts.googleapis.com');
  });
});
