import { describe, expect, it } from 'vitest';
import { parseAddressFromOcr } from '../src/lib/addressOcr';

describe('Address OCR Extraction Unit Tests', () => {
  it('returns null for empty or invalid raw address', () => {
    expect(parseAddressFromOcr('')).toBeNull();
    expect(parseAddressFromOcr('   ')).toBeNull();
    expect(parseAddressFromOcr('abc')).toBeNull();
  });

  it('correctly parses Manila district address with postal code stripped and barangay matched', () => {
    const raw = '123 Valencia St., Brgy. 408, Sampaloc, Manila 1008';
    const parsed = parseAddressFromOcr(raw);

    expect(parsed).not.toBeNull();
    expect(parsed?.city).toBe('City of Manila');
    expect(parsed?.cityCode).toBe('1380600000');
    expect(parsed?.barangay).toBe('408');
    expect((parsed as any)?.postalCode).toBeUndefined();
    expect(parsed?.street).not.toContain('1008');
  });

  it('correctly parses provincial city address with postal code stripped', () => {
    const raw = 'Block 5 Lot 12, Brgy. San Jose, Angeles City, Pampanga 2009';
    const parsed = parseAddressFromOcr(raw);

    expect(parsed).not.toBeNull();
    expect(parsed?.province).toBe('Pampanga');
    expect(parsed?.city).toBe('City of Angeles');
    expect(parsed?.barangay).toBe('San Jose');
    expect((parsed as any)?.postalCode).toBeUndefined();
    expect(parsed?.street).not.toContain('2009');
  });
});
