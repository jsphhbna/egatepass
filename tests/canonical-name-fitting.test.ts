import { describe, it, expect } from 'vitest';
import { fitCanonicalVisitorName, generateCanonicalDigitalPassSvg } from '@/lib/digitalPassArtifact';
import { splitGraphemes, graphemeLength, truncateGraphemes } from '@/lib/textGraphemes';
import { createPassPresentation } from '@/lib/passPresentation';

describe('Workstream B: Canonical Name Fitting & Grapheme Integrity', () => {
  it('correctly calculates grapheme length and splits complex diacritics without corrupting clusters', () => {
    const complexName = 'José Niño Dela Cruz';
    expect(splitGraphemes(complexName).length).toBe(19);
    expect(graphemeLength(complexName)).toBe(19);

    // Combining acute accent: 'e' + '\u0301' is 1 grapheme
    const decomposed = 'Jose\u0301';
    expect(decomposed.length).toBe(5); // 5 code units
    expect(splitGraphemes(decomposed).length).toBe(4); // 4 graphemes
    expect(graphemeLength(decomposed)).toBe(4);

    // Truncation never slices across combining mark
    const truncated = truncateGraphemes(decomposed, 4);
    expect(truncated).toBe(decomposed);
  });

  it('formats short names (<= 24 chars) on a single line at y=125 with size 22', () => {
    const layout = fitCanonicalVisitorName('Juan Dela Cruz');
    expect(layout.isTwoLines).toBe(false);
    expect(layout.line1).toBe('Juan Dela Cruz');
    expect(layout.line1Y).toBe(125);
    expect(layout.fontSize).toBe(22);
    expect(layout.dateY).toBe(150);
    expect(layout.validityY).toBe(170);
  });

  it('formats long names (> 24 chars) across two lines with balanced word breaks', () => {
    const longName = 'Maria Concepcion Dela Cruz Hernandez';
    const layout = fitCanonicalVisitorName(longName);
    expect(layout.isTwoLines).toBe(true);
    expect(layout.line1).toBe('Maria Concepcion');
    expect(layout.line2).toBe('Dela Cruz Hernandez');
    expect(layout.line1Y).toBe(112);
    expect(layout.line2Y).toBe(136);
    expect(layout.fontSize).toBe(18);
    expect(layout.dateY).toBe(158);
    expect(layout.validityY).toBe(176);
  });

  it('applies textLength="420" lengthAdjust="spacingAndGlyphs" when line length exceeds bounds', () => {
    const longSingleLine = 'VeryLongFirstNameWithoutSpacesExceedingThreshold';
    const layout = fitCanonicalVisitorName(longSingleLine);
    expect(layout.isTwoLines).toBe(true);
    expect(layout.line1Attrs).toContain('textLength="420"');
    expect(layout.line1Attrs).toContain('lengthAdjust="spacingAndGlyphs"');
  });

  it('generates canonical SVG with Egatepass Noto Sans font stack and properly positioned 2-line layout', () => {
    const presentation = createPassPresentation({
      id: 'uuid-1234',
      visitorName: 'Maria Concepcion Dela Cruz Hernandez',
      visitDate: '2026-10-30',
      passReference: 'EG-12345678',
      qrToken: 'test-token',
      validityWindow: '8:00 AM – 5:00 PM',
      purpose: 'Consultation • Academic Records Evaluation and Processing',
    });

    const qrDataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    const svg = generateCanonicalDigitalPassSvg(presentation, qrDataUrl);

    // Font stack check
    expect(svg).toContain('font-family="\'Egatepass Noto Sans\', \'Noto Sans\', Arial, sans-serif"');
    expect(svg).toContain('font-family="\'SFMono-Regular\', Consolas, \'Liberation Mono\', Menlo, monospace"');

    // 2-line positioning check
    expect(svg).toContain('y="112"');
    expect(svg).toContain('y="136"');
    expect(svg).toContain('MARIA CONCEPCION');
    expect(svg).toContain('DELA CRUZ HERNANDEZ');

    // Date and validity positions fit above QR box (which starts at y=182)
    expect(svg).toContain('y="158"');
    expect(svg).toContain('y="176"');

    // Purpose grapheme-safe truncation with ellipsis
    expect(svg).toContain('Consultation • Academic Records Evalu...');
  });
});
