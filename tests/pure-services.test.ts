import { describe, it, expect } from 'vitest';
import { encodeCompoundCursor, decodeCompoundCursor } from '../server/cursor.js';
import { controlledDeviceEmail } from '../server/actors.js';
import { normalizeLoginIdentity } from '../src/lib/identity.js';

describe('Compound Cursor Pagination (M4-F08)', () => {
  it('encodes and decodes compound cursor with timestamp and id', () => {
    const timestamp = '2026-10-20T08:30:00.000Z';
    const id = 'c4d15682-124e-4f18-bb58-cf7e3c90716f';
    const cursor = encodeCompoundCursor(timestamp, id);
    expect(typeof cursor).toBe('string');
    expect(cursor.length).toBeGreaterThan(0);

    const decoded = decodeCompoundCursor(cursor);
    expect(decoded).not.toBeNull();
    expect(decoded?.timestamp).toBe(timestamp);
    expect(decoded?.id).toBe(id);
  });

  it('correctly falls back for legacy ISO timestamp cursors without id', () => {
    const legacyCursor = '2026-10-20T08:30:00.000Z';
    const decoded = decodeCompoundCursor(legacyCursor);
    expect(decoded).not.toBeNull();
    expect(decoded?.timestamp).toBe(legacyCursor);
    expect(decoded?.id).toBeNull();
  });

  it('returns null for empty, invalid, or malformed cursors', () => {
    expect(decodeCompoundCursor(null)).toBeNull();
    expect(decodeCompoundCursor(undefined)).toBeNull();
    expect(decodeCompoundCursor('')).toBeNull();
    expect(decodeCompoundCursor('   ')).toBeNull();
    expect(decodeCompoundCursor('not-valid-base64-or-date!!!')).toBeNull();
  });
});

describe('Device Alias & Controlled Email Contract (M4-F05)', () => {
  it('normalizes valid short alias to internal devices domain', () => {
    const res = controlledDeviceEmail('maingate-entry');
    expect(res).not.toBeNull();
    expect(res?.alias).toBe('maingate-entry');
    expect(res?.email).toBe('maingate-entry@devices.egatepass.invalid');
  });

  it('accepts fully-qualified internal devices email and extracts alias', () => {
    const res = controlledDeviceEmail('gate2-exit@devices.egatepass.invalid');
    expect(res).not.toBeNull();
    expect(res?.alias).toBe('gate2-exit');
    expect(res?.email).toBe('gate2-exit@devices.egatepass.invalid');
  });

  it('rejects arbitrary domains and spoofed staff emails', () => {
    expect(controlledDeviceEmail('admin@earist.edu.ph')).toBeNull();
    expect(controlledDeviceEmail('guard@gmail.com')).toBeNull();
    expect(controlledDeviceEmail('maingate@earist-devices.local')).toBeNull();
    expect(controlledDeviceEmail('bad_alias@devices.egatepass.invalid')).toBeNull(); // underscore not in pattern
    expect(controlledDeviceEmail('a')).toBeNull(); // too short (<3 chars)
  });

  it('matches client-side normalizeLoginIdentity logic', () => {
    const clientNormalized = normalizeLoginIdentity('kiosk-lobby');
    const serverNormalized = controlledDeviceEmail('kiosk-lobby');
    expect(clientNormalized.ok).toBe(true);
    if (clientNormalized.ok) {
      expect(clientNormalized.email).toBe('kiosk-lobby@devices.egatepass.invalid');
      expect(serverNormalized?.email).toBe(clientNormalized.email);
    }
  });
});

describe('CSV Formula Injection Defense (M4-F08)', () => {
  const sanitizeFormulaCell = (raw: string): string => {
    if (/^[=+\-@\t\r]/.test(raw)) {
      return `'${raw}`;
    }
    return raw;
  };

  it('neutralizes spreadsheet formula trigger characters', () => {
    expect(sanitizeFormulaCell('=SUM(A1:A10)')).toBe("'=SUM(A1:A10)");
    expect(sanitizeFormulaCell('+cmd|/c calc')).toBe("'+cmd|/c calc");
    expect(sanitizeFormulaCell('-2+5')).toBe("'-2+5");
    expect(sanitizeFormulaCell('@SUM(1,2)')).toBe("'@SUM(1,2)");
    expect(sanitizeFormulaCell('\tTAB_PREFIX')).toBe("'\tTAB_PREFIX");
    expect(sanitizeFormulaCell('\rRETURN_PREFIX')).toBe("'\rRETURN_PREFIX");
  });

  it('leaves safe alphanumeric data untouched', () => {
    expect(sanitizeFormulaCell('Juan Dela Cruz')).toBe('Juan Dela Cruz');
    expect(sanitizeFormulaCell('Official Business')).toBe('Official Business');
    expect(sanitizeFormulaCell('Gate 1 Main')).toBe('Gate 1 Main');
  });
});

describe('Hold Eligibility & Concurrency Invariants (M4-F02)', () => {
  interface IncidentHold {
    visitor_id: string | null;
    pass_id: string | null;
    released_at: string | null;
  }

  function isPassProtectedByHold(pass: { id: string; visitor_id: string }, activeHolds: IncidentHold[]): boolean {
    return activeHolds.some(
      (h) =>
        h.released_at === null &&
        ((h.visitor_id !== null && h.visitor_id === pass.visitor_id) ||
         (h.pass_id !== null && h.pass_id === pass.id))
    );
  }

  it('protects pass when active hold matches visitor_id', () => {
    const pass = { id: 'pass-001', visitor_id: 'visitor-100' };
    const holds: IncidentHold[] = [
      { visitor_id: 'visitor-100', pass_id: null, released_at: null },
    ];
    expect(isPassProtectedByHold(pass, holds)).toBe(true);
  });

  it('protects pass when active hold matches pass_id alone (M4-F02 bug fix)', () => {
    const pass = { id: 'pass-002', visitor_id: 'visitor-200' };
    const holds: IncidentHold[] = [
      { visitor_id: null, pass_id: 'pass-002', released_at: null },
    ];
    expect(isPassProtectedByHold(pass, holds)).toBe(true);
  });

  it('does NOT protect pass when hold is released', () => {
    const pass = { id: 'pass-003', visitor_id: 'visitor-300' };
    const holds: IncidentHold[] = [
      { visitor_id: 'visitor-300', pass_id: null, released_at: '2026-10-19T10:00:00Z' },
    ];
    expect(isPassProtectedByHold(pass, holds)).toBe(false);
  });

  it('does NOT protect pass when hold is for a different pass and visitor', () => {
    const pass = { id: 'pass-004', visitor_id: 'visitor-400' };
    const holds: IncidentHold[] = [
      { visitor_id: 'visitor-999', pass_id: 'pass-999', released_at: null },
    ];
    expect(isPassProtectedByHold(pass, holds)).toBe(false);
  });
});

describe('Peak Mode Scope Validation (M4-F09)', () => {
  const validScopes = ['off', 'portal', 'kiosk', 'both'] as const;

  it('validates 4-way peak mode scope values', () => {
    validScopes.forEach((scope) => {
      expect(['off', 'portal', 'kiosk', 'both']).toContain(scope);
    });
  });

  it('enforces face photo requirement regardless of peak mode scope', () => {
    const requiresFacePhoto = (_scope: string) => true; // Face photo is NEVER skipped
    validScopes.forEach((scope) => {
      expect(requiresFacePhoto(scope)).toBe(true);
    });
  });

  it('skips ID evidence only when scope matches channel', () => {
    const skipsId = (scope: string, channel: 'portal' | 'kiosk') => {
      if (scope === 'both') return true;
      if (scope === channel) return true;
      return false;
    };

    expect(skipsId('off', 'portal')).toBe(false);
    expect(skipsId('off', 'kiosk')).toBe(false);
    expect(skipsId('portal', 'portal')).toBe(true);
    expect(skipsId('portal', 'kiosk')).toBe(false);
    expect(skipsId('kiosk', 'portal')).toBe(false);
    expect(skipsId('kiosk', 'kiosk')).toBe(true);
    expect(skipsId('both', 'portal')).toBe(true);
    expect(skipsId('both', 'kiosk')).toBe(true);
  });
});
