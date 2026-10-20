import { describe, expect, it } from 'vitest';
import React from 'react';
import { render } from '@react-email/render';
import { VerificationCodeEmail, PassIssuedEmail } from '../server/templates/index.js';

describe('EMAIL-ARCH-01: React Email Templates', () => {
  it('renders VerificationCodeEmail with EARIST branding, 6-digit code, and expiry text', async () => {
    const html = await render(
      React.createElement(VerificationCodeEmail, {
        fullName: 'Juan Dela Cruz',
        code: '849201',
        expiresInMinutes: 10,
      })
    );

    expect(html).toContain('EARIST E-GatePass');
    expect(html).toContain('Juan Dela Cruz');
    expect(html).toContain('849201');
    expect(html).toContain('10 minutes');
    expect(html).toContain('#800000'); // Maroon branding
  });

  it('escapes malicious markup in visitor name in VerificationCodeEmail', async () => {
    const html = await render(
      React.createElement(VerificationCodeEmail, {
        fullName: '<script>alert("xss")</script> & Juan',
        code: '123456',
      })
    );

    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('renders PassIssuedEmail with visitor details and security notice', async () => {
    const html = await render(
      React.createElement(PassIssuedEmail, {
        fullName: 'Maria Santos',
        visitDate: '2026-10-20',
        purpose: 'Registrar Transcript Request',
        publicReference: 'GP-20261020-0888',
      })
    );

    expect(html).toContain('EARIST E-GatePass');
    expect(html).toContain('Maria Santos');
    expect(html).toContain('GP-20261020-0888');
    expect(html).toContain('2026-10-20');
    expect(html).toContain('Registrar Transcript Request');
    expect(html).toContain('earist-gate-pass-qr.png');
    expect(html).toContain('Security Notice');
  });

  it('escapes malicious markup in purpose in PassIssuedEmail', async () => {
    const html = await render(
      React.createElement(PassIssuedEmail, {
        fullName: 'Maria Santos',
        visitDate: '2026-10-20',
        purpose: '<img src=x onerror=alert(1)>',
        publicReference: 'GP-20261020-0888',
      })
    );

    expect(html).not.toContain('<img src=x onerror=alert(1)>');
  });
});
