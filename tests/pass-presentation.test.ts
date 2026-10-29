import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  createPassPresentation,
  formatPassVisitorName,
  formatPassVisitDate,
  formatPassReference,
  renderPassCardToDataUrl,
} from '@/lib/passPresentation';

describe('Phase 1: Institutional Visitor Pass Presentation Contract', () => {
  const samplePass = {
    id: 'b8a2c1d3-4567-89ab-cdef-0123456789ab',
    visitorName: 'Juan Dela Cruz',
    visitDate: '2026-10-27',
    passReference: 'EG-8A2C1D34',
    qrToken: 'egp_opaque_token_hash_digest_1234567890abcdef',
  };

  it('1.1. creates canonical PassPresentation from pass data', () => {
    const presentation = createPassPresentation(samplePass);

    expect(presentation.institutionName).toBe('EARIST E-GATEPASS');
    expect(presentation.systemTitle).toBe('CAMPUS VISITOR PASS');
    expect(presentation.visitorName).toBe('JUAN DELA CRUZ');
    expect(presentation.visitDate).toContain('Oct 27, 2026');
    expect(presentation.passReference).toBe('EG-8A2C1D34');
    expect(presentation.qrToken).toBe('egp_opaque_token_hash_digest_1234567890abcdef');
  });

  it('1.2. formats visitor names into uppercase standard institutional format', () => {
    expect(formatPassVisitorName({ firstName: 'Maria', lastName: 'Santos' })).toBe('MARIA SANTOS');
    expect(
      formatPassVisitorName({
        firstName: 'Maria',
        middleName: 'Clara',
        lastName: 'Santos',
      })
    ).toBe('MARIA CLARA SANTOS');
    expect(formatPassVisitorName({ visitorName: 'Pedro Penduko' })).toBe('PEDRO PENDUKO');
  });

  it('1.3. formats visit date in Asia/Manila timezone format', () => {
    const formatted = formatPassVisitDate('2026-10-27');
    expect(formatted).toBe('Oct 27, 2026');
  });

  it('1.4. formats pass reference with institutional Ref: EG- prefix', () => {
    expect(formatPassReference('EG-12345678')).toBe('EG-12345678');
    expect(formatPassReference('12345678-abcd-ef01-2345-6789abcdef01')).toBe('EG-12345678');
  });

  it('1.5. Invariant: Raw QR token is never rendered as human-readable pass reference', () => {
    const presentation = createPassPresentation(samplePass);
    expect(presentation.passReference).not.toContain(presentation.qrToken);
    expect(presentation.passReference).toMatch(/^EG-[A-Z0-9]{8}$/);
  });

  it('1.6. Invariant: QR payload contains only raw opaque bearer token, no visitor PII', () => {
    const presentation = createPassPresentation(samplePass);
    // Ensure the QR payload is the opaque token
    expect(presentation.qrToken).not.toContain(samplePass.visitorName);
    expect(presentation.qrToken).not.toContain(samplePass.visitDate);
    expect(presentation.qrToken).not.toContain('@');
  });

  it('1.7. renders pass card to data URL for complete download', async () => {
    const presentation = createPassPresentation(samplePass);
    // In jsdom environment, create a mock canvas element if document is available
    if (typeof document !== 'undefined') {
      const dataUrl = await renderPassCardToDataUrl(presentation);
      expect(dataUrl).toMatch(/^data:image\/png;base64,/);
    }
  });

  it('1.8. Invariant: passPresentation missing after issuance displays controlled recovery state and suppresses raw standalone QR and raw passId', () => {
    const getPassSrc = readFileSync('src/pages/GetPassPage.tsx', 'utf8');

    // Asserts canonical presentation or controlled recovery state
    expect(getPassSrc).toContain('qrDataUrl && passPresentation ? (');
    expect(getPassSrc).toContain('<InstitutionalPassCard');
    expect(getPassSrc).toContain('Your E-GatePass was issued, but the visual pass could not be prepared. Please retry or ask the Guard for assistance.');

    // Asserts NO raw QR fallback or raw passId fallback on success screen
    expect(getPassSrc).not.toContain('alt="Visitor Gate Pass QR Code"');
    expect(getPassSrc).not.toContain('{passId}');
  });
});
