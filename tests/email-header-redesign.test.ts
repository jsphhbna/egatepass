import { describe, it, expect } from 'vitest';
import { existsSync, statSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import React from 'react';
import { render } from '@react-email/render';
import {
  EARIST_LOGO_URL,
  EARIST_BUILDING_EMAIL_URL,
  EARIST_EMAIL_HEADER_ART_URL,
  StaffInviteEmail,
  SignupConfirmationEmail,
  PasswordResetEmail,
  MagicLinkEmail,
  EmailChangeEmail,
  ReauthenticationEmail,
  VerificationCodeEmail,
  SecurityNotificationEmail,
  PassIssuedEmail,
} from '../server/templates/index.js';

describe('Institutional Transactional Email Header Redesign & Asset Optimization', () => {
  const root = process.cwd();
  const publicDir = join(root, 'public');
  const templatesDir = join(root, 'server', 'templates');

  describe('1. Asset Contract & File-Size Budgets', () => {
    const compositeArtPath = join(publicDir, 'earist-email-header-art.jpg');
    const logoSourcePath = join(publicDir, 'earist-logo-email.png');
    const buildingSourcePath = join(publicDir, 'earist-building-email-header.jpg');

    it('earist-email-header-art.jpg exists and complies with email delivery size budget (<= 100 KB, preferred 40-80 KB)', () => {
      expect(existsSync(compositeArtPath)).toBe(true);
      const stats = statSync(compositeArtPath);
      expect(stats.size).toBeLessThanOrEqual(100 * 1024);
      expect(stats.size).toBeGreaterThan(10 * 1024);
    });

    it('preserves existing source assets earist-logo-email.png and earist-building-email-header.jpg without deletion', () => {
      expect(existsSync(logoSourcePath)).toBe(true);
      expect(existsSync(buildingSourcePath)).toBe(true);
      const logoStats = statSync(logoSourcePath);
      const buildingStats = statSync(buildingSourcePath);
      expect(logoStats.size).toBeLessThanOrEqual(60 * 1024);
      expect(buildingStats.size).toBeLessThanOrEqual(120 * 1024);
    });

    it('preserves the original website logo public/earist-logo.png without replacement or modification', () => {
      const origLogoPath = join(publicDir, 'earist-logo.png');
      expect(existsSync(origLogoPath)).toBe(true);
      const stats = statSync(origLogoPath);
      expect(stats.size).toBeGreaterThan(500 * 1024);
    });
  });

  describe('2. Branding Helper Contract', () => {
    it('resolves EARIST_EMAIL_HEADER_ART_URL to /earist-email-header-art.jpg', () => {
      expect(EARIST_EMAIL_HEADER_ART_URL).toContain('/earist-email-header-art.jpg');
    });

    it('retains backward-compatible exports EARIST_LOGO_URL and EARIST_BUILDING_EMAIL_URL', () => {
      expect(EARIST_LOGO_URL).toContain('/earist-logo-email.png');
      expect(EARIST_BUILDING_EMAIL_URL).toContain('/earist-building-email-header.jpg');
    });

    it('source file branding.ts exposes EARIST_EMAIL_HEADER_ART_URL', () => {
      const brandingSrc = readFileSync(join(templatesDir, 'branding.ts'), 'utf8');
      expect(brandingSrc).toContain('/earist-email-header-art.jpg');
      expect(brandingSrc).toContain('EARIST_EMAIL_HEADER_ART_URL');
      expect(brandingSrc).not.toContain('/earist-logo.png');
    });
  });

  describe('3. Template Composition & Header Architecture Contract', () => {
    const templates = [
      {
        name: 'StaffInviteEmail',
        component: StaffInviteEmail,
        props: { email: 'staff@earist.edu.ph', inviteUrl: 'https://egatepass.tech/invite?token=123' },
      },
      {
        name: 'SignupConfirmationEmail',
        component: SignupConfirmationEmail,
        props: { email: 'user@earist.edu.ph', confirmationUrl: 'https://egatepass.tech/confirm?token=123' },
      },
      {
        name: 'PasswordResetEmail',
        component: PasswordResetEmail,
        props: { email: 'user@earist.edu.ph', resetUrl: 'https://egatepass.tech/reset?token=123' },
      },
      {
        name: 'MagicLinkEmail',
        component: MagicLinkEmail,
        props: { email: 'user@earist.edu.ph', magicUrl: 'https://egatepass.tech/magic?token=123' },
      },
      {
        name: 'EmailChangeEmail',
        component: EmailChangeEmail,
        props: { currentEmail: 'old@earist.edu.ph', newEmail: 'new@earist.edu.ph', changeUrl: 'https://egatepass.tech/change?token=123', targetAddress: 'new' as const },
      },
      {
        name: 'ReauthenticationEmail',
        component: ReauthenticationEmail,
        props: { email: 'user@earist.edu.ph', reauthUrl: 'https://egatepass.tech/reauth?token=123' },
      },
      {
        name: 'VerificationCodeEmail',
        component: VerificationCodeEmail,
        props: { fullName: 'Juan Dela Cruz', code: '654321', expiresInMinutes: 15 },
      },
      {
        name: 'SecurityNotificationEmail',
        component: SecurityNotificationEmail,
        props: { email: 'user@earist.edu.ph', actionType: 'password_changed_notification', title: 'Security Alert', description: 'Password changed' },
      },
      {
        name: 'PassIssuedEmail',
        component: PassIssuedEmail,
        props: { fullName: 'Maria Santos', visitDate: '2026-10-25', purpose: 'Campus Tour', publicReference: 'REF-PASS-123' },
      },
    ];

    it.each(templates)('renders $name with composite institutional header and real HTML typography', async ({ component, props }) => {
      const html = await render(React.createElement(component as any, props));

      // 1. Composite Header Artwork (contains seal + building + fade + swoosh)
      expect(html).toContain('earist-email-header-art.jpg');
      expect(html).toContain('alt="EARIST campus"');

      // 2. Explicit Dimensions
      expect(html).toContain('width="504"');
      expect(html).toContain('height="190"');

      // 3. Real HTML Title & Subtitle (never baked into raster artwork)
      expect(html).toContain('EARIST E-GatePass');
      expect(html).toContain('Eulogio &quot;Amang&quot; Rodriguez Institute of Science and Technology');

      // 4. Maroon Divider (#800000)
      expect(html).toContain('#800000');

      // 5. No duplicated standalone seal or standalone photo
      expect(html).not.toContain('earist-logo-email.png');
      expect(html).not.toContain('earist-building-email-header.jpg');
      expect(html).not.toContain('/earist-logo.png');
    });

    it('verifies the visual hierarchy: composite art -> real title -> real subtitle -> maroon divider -> body', async () => {
      const html = await render(React.createElement(StaffInviteEmail, {
        email: 'staff@earist.edu.ph',
        inviteUrl: 'https://egatepass.tech/invite?token=123',
      }));

      const headerStart = html.indexOf('border-bottom:2px solid #800000');
      expect(headerStart).toBeGreaterThan(-1);
      const headerSnippet = html.slice(headerStart);

      const headerArtIdx = headerSnippet.indexOf('earist-email-header-art.jpg');
      const titleIdx = headerSnippet.indexOf('EARIST E-GatePass');
      const subtitleIdx = headerSnippet.indexOf('Eulogio &quot;Amang&quot; Rodriguez Institute of Science and Technology');
      const greetingIdx = html.indexOf('Hello,');

      expect(headerArtIdx).toBeGreaterThan(-1);
      expect(titleIdx).toBeGreaterThan(headerArtIdx);
      expect(subtitleIdx).toBeGreaterThan(titleIdx);
      expect(greetingIdx).toBeGreaterThan(headerStart);
    });
  });

  describe('4. Forbidden Layering & Runtime CSS Defense', () => {
    it('verifies that no template uses CSS backgroundImage or background-image', () => {
      const tsxFiles = readdirSync(templatesDir).filter(f => f.endsWith('.tsx'));
      for (const file of tsxFiles) {
        const src = readFileSync(join(templatesDir, file), 'utf8');
        expect(src).not.toContain('backgroundImage');
        expect(src).not.toContain('background-image');
        expect(src).not.toContain('background: url');
      }

      const headerSrc = readFileSync(join(templatesDir, 'components', 'EmailHeader.tsx'), 'utf8');
      expect(headerSrc).not.toContain('backgroundImage');
      expect(headerSrc).not.toContain('background-image');
      expect(headerSrc).not.toContain('background: url');
      expect(headerSrc).not.toContain('position: absolute');
      expect(headerSrc).not.toContain('position:absolute');
      expect(headerSrc).not.toContain('z-index');
    });
  });
});
