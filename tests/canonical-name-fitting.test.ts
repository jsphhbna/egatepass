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

    // Geometry check: single line does not overlap date (125 < 150), date does not overlap validity (150 < 170), validity < QR (170 < 182)
    expect(layout.line1Y).toBeLessThan(layout.dateY);
    expect(layout.dateY).toBeLessThan(layout.validityY);
    expect(layout.validityY).toBeLessThan(182);
  });

  it('formats typical extended names across two balanced lines without ellipsis', () => {
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

    // Neither line should have ellipsis
    expect(layout.line1).not.toContain('…');
    expect(layout.line2).not.toContain('…');

    // Vertical geometry preservation: line1 (112) < line2 (136) < date (158) < validity (176) < QR (182)
    expect(layout.line1Y).toBeLessThan(layout.line2Y!);
    expect(layout.line2Y!).toBeLessThan(layout.dateY);
    expect(layout.dateY).toBeLessThan(layout.validityY);
    expect(layout.validityY).toBeLessThan(182);
  });

  it('handles extremely long valid names approaching registration limits with second-line grapheme-safe ellipsis', () => {
    const extremeName = 'Maria Concepcion Esperanza Dela Cruz Hernandez De Los Santos Vallejo';
    const layout = fitCanonicalVisitorName(extremeName);

    expect(layout.isTwoLines).toBe(true);
    expect(layout.line1).toBeDefined();
    expect(layout.line2).toBeDefined();
    // Line 2 ends with grapheme-safe ellipsis
    expect(layout.line2!.endsWith('…')).toBe(true);
    // Bounded grapheme budget: max 26 graphemes per line
    expect(graphemeLength(layout.line1)).toBeLessThanOrEqual(26);
    expect(graphemeLength(layout.line2!)).toBeLessThanOrEqual(26);
    // No replacement characters or surrogate corruption
    expect(layout.line1).not.toContain('\uFFFD');
    expect(layout.line2).not.toContain('\uFFFD');

    // Reasonable textLength application
    expect(layout.line1Attrs).toContain('textLength="420"');
    expect(layout.line2Attrs).toContain('textLength="420"');
  });

  it('handles unbroken long single-token strings with grapheme-safe split and ellipsis', () => {
    const longSingleToken = 'SupercalifragilisticexpialidociousLongTokenExceedingThreshold';
    const layout = fitCanonicalVisitorName(longSingleToken);

    expect(layout.isTwoLines).toBe(true);
    expect(layout.line1).toBeDefined();
    expect(layout.line2).toBeDefined();
    expect(graphemeLength(layout.line1)).toBeLessThanOrEqual(26);
    expect(graphemeLength(layout.line2!)).toBeLessThanOrEqual(26);
    expect(layout.line2!.endsWith('…')).toBe(true);
    expect(layout.line1).not.toContain('\uFFFD');
    expect(layout.line2).not.toContain('\uFFFD');
  });

  it('generates canonical SVG where pass reference uses Egatepass Noto Sans with bold weight', () => {
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

    // Font stack check: uses Egatepass Noto Sans for all text including pass reference
    expect(svg).toContain('font-family="\'Egatepass Noto Sans\', \'Noto Sans\', Arial, sans-serif"');

    // Monospace environment font stack is completely removed
    expect(svg).not.toContain('SFMono-Regular');
    expect(svg).not.toContain('Consolas');
    expect(svg).not.toContain('Liberation Mono');
    expect(svg).not.toContain('Menlo');
    expect(svg).not.toContain('monospace');

    // Pass reference element verification
    expect(svg).toContain('data-testid="canonical-pass-reference"');
    expect(svg).toContain('Ref: EG-12345678');
    expect(svg).toContain('font-weight="bold"');

    // Date and validity positions fit above QR outer container (starts at y=182, image at y=190)
    expect(svg).toContain('y="158"');
    expect(svg).toContain('y="176"');
    expect(svg).toContain('y="182"');
    expect(svg).toContain('y="190"');

    // Purpose grapheme-safe truncation with ellipsis
    expect(svg).toContain('Consultation • Academic Records Evalu...');
  });
});
