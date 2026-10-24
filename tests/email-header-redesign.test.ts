import { describe, expect, it } from 'vitest';
import { existsSync, statSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import React from 'react';
import { render } from '@react-email/render';
import {
  EARIST_LOGO_URL,
  EARIST_BUILDING_EMAIL_URL,
} from '../server/templates/branding.js';
import {
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
    const logoPath = join(publicDir, 'earist-logo-email.png');
    const buildingPath = join(publicDir, 'earist-building-email-header.jpg');

    it('earist-logo-email.png exists and complies with email delivery size budget (<= 60 KB)', () => {
      expect(existsSync(logoPath)).toBe(true);
      const stats = statSync(logoPath);
      // Hard budget <= 60 KB, ideal <= 40 KB
      expect(stats.size).toBeLessThanOrEqual(60 * 1024);
      expect(stats.size).toBeGreaterThan(1000); // Non-empty valid image
    });

    it('earist-building-email-header.jpg exists and complies with email delivery size budget (<= 120 KB)', () => {
      expect(existsSync(buildingPath)).toBe(true);
      const stats = statSync(buildingPath);
      // Hard budget <= 120 KB, ideal <= 100 KB
      expect(stats.size).toBeLessThanOrEqual(120 * 1024);
      expect(stats.size).toBeGreaterThan(5000); // Non-empty photographic asset
    });

    it('combined decorative header payload is well within the 160 KB budget', () => {
      const logoStats = statSync(logoPath);
      const buildingStats = statSync(buildingPath);
      const combined = logoStats.size + buildingStats.size;
      expect(combined).toBeLessThanOrEqual(160 * 1024);
    });

    it('preserves the original website logo public/earist-logo.png without replacement', () => {
      const origLogoPath = join(publicDir, 'earist-logo.png');
      expect(existsSync(origLogoPath)).toBe(true);
      const stats = statSync(origLogoPath);
      expect(stats.size).toBeGreaterThan(500 * 1024); // Original high-res asset preserved
    });
  });

  describe('2. Branding Helper Contract', () => {
    it('resolves EARIST_LOGO_URL to /earist-logo-email.png and NOT /earist-logo.png', () => {
      expect(EARIST_LOGO_URL).toContain('/earist-logo-email.png');
      expect(EARIST_LOGO_URL).not.toMatch(/\/earist-logo\.png$/);
    });

    it('resolves EARIST_BUILDING_EMAIL_URL to /earist-building-email-header.jpg', () => {
      expect(EARIST_BUILDING_EMAIL_URL).toContain('/earist-building-email-header.jpg');
    });

    it('source file branding.ts does not hardcode /earist-logo.png for transactional emails', () => {
      const brandingSrc = readFileSync(join(templatesDir, 'branding.ts'), 'utf8');
      expect(brandingSrc).toContain('/earist-logo-email.png');
      expect(brandingSrc).toContain('/earist-building-email-header.jpg');
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

    it.each(templates)('renders $name with complete institutional header and authentic assets', async ({ component, props }) => {
      const html = await render(React.createElement(component as any, props));

      // 1. Logo
      expect(html).toContain('earist-logo-email.png');
      expect(html).toContain('alt="EARIST seal"');

      // 2. Title & Subtitle
      expect(html).toContain('EARIST E-GatePass');
      expect(html).toContain('Eulogio &quot;Amang&quot; Rodriguez Institute of Science and Technology');

      // 3. Building photo
      expect(html).toContain('earist-building-email-header.jpg');
      expect(html).toContain('alt="EARIST Main Campus building"');

      // 4. Dimensions to prevent layout jumps
      expect(html).toContain('width="64"');
      expect(html).toContain('height="64"');
      expect(html).toContain('width="504"');
      expect(html).toContain('height="155"');

      // 5. Maroon divider
      expect(html).toContain('#800000');

      // 6. Never old logo
      expect(html).not.toContain('/earist-logo.png');
    });

    it('verifies the building image is positioned inside the header section and ends before the body', async () => {
      const html = await render(React.createElement(StaffInviteEmail, {
        email: 'staff@earist.edu.ph',
        inviteUrl: 'https://egatepass.tech/invite?token=123',
      }));

      const headerStart = html.indexOf('border-bottom:2px solid #800000');
      expect(headerStart).toBeGreaterThan(-1);
      const headerSnippet = html.slice(headerStart);

      const logoIdx = headerSnippet.indexOf('earist-logo-email.png');
      const titleIdx = headerSnippet.indexOf('EARIST E-GatePass');
      const subtitleIdx = headerSnippet.indexOf('Eulogio &quot;Amang&quot; Rodriguez Institute of Science and Technology');
      const buildingIdx = headerSnippet.indexOf('earist-building-email-header.jpg');
      const greetingIdx = headerSnippet.indexOf('Hello,');

      expect(logoIdx).toBeGreaterThan(-1);
      expect(titleIdx).toBeGreaterThan(logoIdx);
      expect(subtitleIdx).toBeGreaterThan(titleIdx);
      expect(buildingIdx).toBeGreaterThan(subtitleIdx);
      expect(greetingIdx).toBeGreaterThan(buildingIdx);
    });
  });

  describe('4. Forbidden Background Treatment Defense', () => {
    it('verifies that no template uses CSS backgroundImage or background-image for the building', () => {
      const tsxFiles = readdirSync(templatesDir).filter(f => f.endsWith('.tsx'));
      for (const file of tsxFiles) {
        const src = readFileSync(join(templatesDir, file), 'utf8');
        expect(src).not.toContain('backgroundImage');
        expect(src).not.toContain('background-image');
        expect(src).not.toContain('background: url');
      }

      // Also check components/EmailHeader.tsx
      const headerSrc = readFileSync(join(templatesDir, 'components', 'EmailHeader.tsx'), 'utf8');
      expect(headerSrc).not.toContain('backgroundImage');
      expect(headerSrc).not.toContain('background-image');
      expect(headerSrc).not.toContain('background: url');
    });
  });
});
