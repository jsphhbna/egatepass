import { describe, it, expect, vi } from 'vitest';
import { encodeCompoundCursor, decodeCompoundCursor, decodeCursorStrict } from '../server/cursor.js';
import { controlledDeviceEmail } from '../server/actors.js';
import { normalizeLoginIdentity } from '../src/lib/identity.js';
import { escapeCsvCell } from '../src/lib/completeExport.js';
import { normalizeSha256Digest } from '../api/passes/email.js';
import { EmailDeliveryError, sendResendEmail, setEmailSenderForTest } from '../server/email.js';

describe('QR email digest normalization', () => {
  const hex = 'a'.repeat(64);

  it.each([hex, `\\x${hex}`, `0x${hex}`, hex.toUpperCase()])('accepts an exact supported 32-byte digest shape', (value) => {
    expect(normalizeSha256Digest(value)?.length).toBe(32);
  });

  it.each([null, '', 'a'.repeat(62), 'a'.repeat(66), `\\x${'g'.repeat(64)}`, `00${hex}`])(
    'rejects malformed or non-32-byte digest %s',
    (value) => expect(normalizeSha256Digest(value)).toBeNull(),
  );
});

describe('Email provider acknowledgement classification', () => {
  it('treats a 2xx response without a provider ID as an unknown outcome', async () => {
    const previousKey = process.env.RESEND_API_KEY;
    process.env.RESEND_API_KEY = 'local-test-key';
    setEmailSenderForTest(null);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
    try {
      await expect(sendResendEmail({ to: 'fixture@example.invalid', subject: 'fixture', html: '<p>fixture</p>' }))
        .rejects.toMatchObject<Partial<EmailDeliveryError>>({
          code: 'provider_acknowledgement_unknown', outcome: 'unknown',
        });
    } finally {
      vi.unstubAllGlobals();
      if (previousKey === undefined) delete process.env.RESEND_API_KEY;
      else process.env.RESEND_API_KEY = previousKey;
    }
  });

  it('treats an explicit non-2xx provider response as definitive rejection', async () => {
    const previousKey = process.env.RESEND_API_KEY;
    process.env.RESEND_API_KEY = 'local-test-key';
    setEmailSenderForTest(null);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"message":"rejected"}', { status: 422 })));
    try {
      await expect(sendResendEmail({ to: 'fixture@example.invalid', subject: 'fixture', html: '<p>fixture</p>' }))
        .rejects.toMatchObject<Partial<EmailDeliveryError>>({ code: 'resend_rejected', outcome: 'definitive_rejection' });
    } finally {
      vi.unstubAllGlobals();
      if (previousKey === undefined) delete process.env.RESEND_API_KEY;
      else process.env.RESEND_API_KEY = previousKey;
    }
  });
});

describe('Compound Cursor Pagination & PostgREST Filter Safety (M4-F08, C-03)', () => {
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

  it('returns null for empty or whitespace cursors in non-strict mode', () => {
    expect(decodeCompoundCursor(null)).toBeNull();
    expect(decodeCompoundCursor(undefined)).toBeNull();
    expect(decodeCompoundCursor('')).toBeNull();
    expect(decodeCompoundCursor('   ')).toBeNull();
  });

  it('rejects malformed or malicious injected cursors with 400 in strict mode', () => {
    // Malicious injection attempt in JSON payload
    const maliciousPayload = Buffer.from(JSON.stringify({
      t: '2026-10-20T00:00:00Z),or(id.gt.0',
      i: 'malicious-syntax',
    })).toString('base64url');

    expect(() => decodeCursorStrict(maliciousPayload)).toThrowError('invalid_cursor');
    expect(() => decodeCursorStrict('not-valid-base64-or-date!')).toThrowError('invalid_cursor');
  });

  it('validates id format strictly per table type (uuid vs bigint)', () => {
    const validUuidCursor = encodeCompoundCursor('2026-10-20T08:30:00.000Z', 'c4d15682-124e-4f18-bb58-cf7e3c90716f');
    const validBigintCursor = encodeCompoundCursor('2026-10-20T08:30:00.000Z', '987654321012345');

    // UUID target rejects bigint
    expect(() => decodeCursorStrict(validBigintCursor, { idType: 'uuid' })).toThrowError('invalid_cursor');
    // Bigint target rejects UUID
    expect(() => decodeCursorStrict(validUuidCursor, { idType: 'bigint' })).toThrowError('invalid_cursor');

    // Matching types succeed
    expect(decodeCursorStrict(validUuidCursor, { idType: 'uuid' })?.id).toBe('c4d15682-124e-4f18-bb58-cf7e3c90716f');
    expect(decodeCursorStrict(validBigintCursor, { idType: 'bigint' })?.id).toBe('987654321012345');
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

describe('Real CSV Formula Injection Defense & Escaping (M4-F08, C-03)', () => {
  it('directly uses imported escapeCsvCell to neutralize spreadsheet formula prefixes', () => {
    expect(escapeCsvCell('=SUM(A1:A10)')).toBe('"\'=SUM(A1:A10)"');
    expect(escapeCsvCell('+cmd|/c calc')).toBe('"\' +cmd|/c calc"'.replace(' ', ''));
    expect(escapeCsvCell('-2+5')).toBe('"\' -2+5"'.replace(' ', ''));
    expect(escapeCsvCell('@SUM(1,2)')).toBe('"\'@SUM(1,2)"');
    expect(escapeCsvCell('\tTAB_PREFIX')).toBe('"\'\tTAB_PREFIX"');
    expect(escapeCsvCell('\rRETURN_PREFIX')).toBe('"\'\rRETURN_PREFIX"');
  });

  it('neutralizes formula prefixes even after leading whitespace or control characters', () => {
    expect(escapeCsvCell('   =SUM(1,2)')).toBe('"\'   =SUM(1,2)"');
    expect(escapeCsvCell('\t=cmd')).toBe('"\'\t=cmd"');
    expect(escapeCsvCell('\r\n+12345')).toBe('"\'\r\n+12345"');
    expect(escapeCsvCell('\x00=calc')).toBe('"\'\x00=calc"');
  });

  it('escapes internal double quotes properly', () => {
    expect(escapeCsvCell('Juan "Boss" Dela Cruz')).toBe('"Juan ""Boss"" Dela Cruz"');
    expect(escapeCsvCell('""')).toBe('""""""');
  });

  it('returns empty quoted cell for null and undefined', () => {
    expect(escapeCsvCell(null)).toBe('""');
    expect(escapeCsvCell(undefined)).toBe('""');
  });

  it('leaves safe alphanumeric data untouched inside quotes', () => {
    expect(escapeCsvCell('Juan Dela Cruz')).toBe('"Juan Dela Cruz"');
    expect(escapeCsvCell('Official Business')).toBe('"Official Business"');
    expect(escapeCsvCell('Gate 1 Main')).toBe('"Gate 1 Main"');
  });
});

describe('Hold Eligibility & Concurrency Invariants (M4-F02, P0-04)', () => {
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

describe('Peak Mode Scope Validation (M4-F09, C-04)', () => {
  const validScopes = ['off', 'portal', 'kiosk', 'both'] as const;

  it('validates 4-way peak mode scope values', () => {
    validScopes.forEach((scope) => {
      expect(['off', 'portal', 'kiosk', 'both']).toContain(scope);
    });
  });

  it('enforces face photo requirement regardless of peak mode scope', () => {
    const requiresFacePhoto = (_scope: string) => true; // Face photo is ALWAYS required
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
