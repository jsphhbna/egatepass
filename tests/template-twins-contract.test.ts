import { describe, expect, it } from 'vitest';
import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

describe('FIX GROUP K: Duplicate Email Template Source Files Contract', () => {
  const templatesDir = join(process.cwd(), 'server', 'templates');

  it('guarantees that no .tsx email template has a duplicate .js sibling file in server/templates/', () => {
    const files = readdirSync(templatesDir);
    const tsxTemplates = files.filter((f) => f.endsWith('.tsx'));

    expect(tsxTemplates.length).toBeGreaterThan(0);

    const staleTwins: string[] = [];
    for (const tsxFile of tsxTemplates) {
      const jsTwin = tsxFile.replace(/\.tsx$/, '.js');
      if (existsSync(join(templatesDir, jsTwin))) {
        staleTwins.push(jsTwin);
      }
    }

    expect(staleTwins).toEqual([]);
  });

  it('ensures .tsx email templates are the single source of truth', () => {
    const files = readdirSync(templatesDir);
    const expectedTsxFiles = [
      'SignupConfirmationEmail.tsx',
      'PasswordResetEmail.tsx',
      'StaffInviteEmail.tsx',
      'EmailChangeEmail.tsx',
      'VerificationCodeEmail.tsx',
      'PassIssuedEmail.tsx',
      'MagicLinkEmail.tsx',
      'ReauthenticationEmail.tsx',
      'SecurityNotificationEmail.tsx',
    ];

    for (const file of expectedTsxFiles) {
      expect(files).toContain(file);
      // Ensure no compiled twin exists
      expect(files).not.toContain(file.replace('.tsx', '.js'));
    }
  });
});
