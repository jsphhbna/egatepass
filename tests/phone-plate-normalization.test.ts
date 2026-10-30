import { describe, it, expect } from 'vitest';
import { normalizePhMobile, validatePhMobile } from '../src/lib/phPhone';
import { normalizePlateNumber, VEHICLE_TYPES } from '../src/lib/vehiclePlate';

describe('Philippine Mobile Number Normalization & Validation Contract', () => {
  it('accepts valid 11-digit local format starting with 09 and normalizes to canonical +639', () => {
    expect(normalizePhMobile('09171234567')).toBe('+639171234567');
    expect(normalizePhMobile('09987654321')).toBe('+639987654321');
  });

  it('accepts 63 format without leading plus and normalizes to canonical +639', () => {
    expect(normalizePhMobile('639171234567')).toBe('+639171234567');
  });

  it('accepts full international +63 format and preserves canonical +639', () => {
    expect(normalizePhMobile('+639171234567')).toBe('+639171234567');
  });

  it('tolerates ordinary spaces, dashes, and parentheses', () => {
    expect(normalizePhMobile('0917 123 4567')).toBe('+639171234567');
    expect(normalizePhMobile('+63 917 123 4567')).toBe('+639171234567');
    expect(normalizePhMobile('(0917) 123-4567')).toBe('+639171234567');
    expect(normalizePhMobile('63-917-123-4567')).toBe('+639171234567');
  });

  it('rejects malformed 6309 format', () => {
    expect(normalizePhMobile('6309171234567')).toBeNull();
    expect(normalizePhMobile('+6309171234567')).toBeNull();

    const validation = validatePhMobile('6309171234567');
    expect(validation.valid).toBe(false);
    expect(validation.error).toContain('do not combine 63 with 09');
  });

  it('rejects numbers starting directly with 917 without leading 0 or 63', () => {
    expect(normalizePhMobile('9171234567')).toBeNull();
    const validation = validatePhMobile('9171234567');
    expect(validation.valid).toBe(false);
    expect(validation.error).toContain('leading 0');
  });

  it('rejects wrong length numbers (too short or too long)', () => {
    expect(normalizePhMobile('0917123456')).toBeNull(); // 10 digits
    expect(normalizePhMobile('091712345678')).toBeNull(); // 12 digits
    expect(normalizePhMobile('63917123456')).toBeNull();
    expect(normalizePhMobile('+6391712345678')).toBeNull();
  });

  it('rejects other country codes', () => {
    expect(normalizePhMobile('+12345678901')).toBeNull();
    expect(normalizePhMobile('+447911123456')).toBeNull();
    const validation = validatePhMobile('+12345678901');
    expect(validation.valid).toBe(false);
    expect(validation.error).toContain('Only Philippine mobile numbers');
  });

  it('provides formatted display string for human review', () => {
    const res = validatePhMobile('09171234567');
    expect(res.valid).toBe(true);
    expect(res.canonical).toBe('+639171234567');
    expect(res.formatted).toBe('+63 917 123 4567');
  });
});

describe('Vehicle Plate Normalization Contract', () => {
  it('normalizes plate display and extracts uppercase alphanumeric key', () => {
    const res = normalizePlateNumber('abc-1234');
    expect(res.valid).toBe(true);
    expect(res.displayPlate).toBe('ABC 1234');
    expect(res.plateKey).toBe('ABC1234');
  });

  it('handles spaces, dashes, and lowercase characters correctly', () => {
    const res1 = normalizePlateNumber('ncr 9876');
    expect(res1.valid).toBe(true);
    expect(res1.displayPlate).toBe('NCR 9876');
    expect(res1.plateKey).toBe('NCR9876');

    const res2 = normalizePlateNumber('1234-AB');
    expect(res2.valid).toBe(true);
    expect(res2.plateKey).toBe('1234AB');
  });

  it('supports motorcycle and legacy plates', () => {
    const moto = normalizePlateNumber('123 ABC');
    expect(moto.valid).toBe(true);
    expect(moto.plateKey).toBe('123ABC');

    const moto2 = normalizePlateNumber('12345A');
    expect(moto2.valid).toBe(true);
    expect(moto2.plateKey).toBe('12345A');
  });

  it('rejects empty, too short, or too long plates', () => {
    expect(normalizePlateNumber('').valid).toBe(false);
    expect(normalizePlateNumber('  ').valid).toBe(false);
    expect(normalizePlateNumber('AB').valid).toBe(false); // < 3 chars
    expect(normalizePlateNumber('ABCDEFGHIJK').valid).toBe(false); // > 10 chars
  });

  it('exports canonical vehicle types', () => {
    expect(VEHICLE_TYPES).toContain('Car');
    expect(VEHICLE_TYPES).toContain('Motorcycle');
    expect(VEHICLE_TYPES).toContain('Van');
    expect(VEHICLE_TYPES).toContain('Pickup');
    expect(VEHICLE_TYPES).toContain('Other');
  });
});
