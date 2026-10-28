import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

describe('Group F: Professional System-Wide Wording & Terminology Contract', () => {
  const rootDir = path.resolve(__dirname, '..');

  it('checks core user-facing UI pages for consistent canonical terminology', () => {
    const filesToCheck = [
      'src/pages/GetPassPage.tsx',
      'src/pages/KioskPage.tsx',
      'src/pages/AdminRecords.tsx',
      'src/pages/AdminUsers.tsx',
      'src/pages/AdminSettings.tsx',
      'src/lib/digitalPassArtifact.ts',
    ];

    for (const relPath of filesToCheck) {
      const fullPath = path.join(rootDir, relPath);
      expect(fs.existsSync(fullPath), `File ${relPath} should exist`).toBe(true);
      const content = fs.readFileSync(fullPath, 'utf-8');

      // Check that "Super Admin" is properly capitalized in user-facing texts
      // (avoid lowercase superadmin in UI labels/headings)
      expect(content).not.toMatch(/>\s*superadmin\s*</i);

      // Check that "E-GatePass" is properly hyphenated and capitalized in prominent headers
      expect(content).not.toMatch(/>\s*Gatepass\s*</);
      expect(content).not.toMatch(/>\s*gatepass\s*</);
    }
  });

  it('verifies canonical digital pass artifact uses institutional title EARIST E-GATEPASS', () => {
    const artifactPath = path.join(rootDir, 'src/lib/digitalPassArtifact.ts');
    const content = fs.readFileSync(artifactPath, 'utf-8');

    expect(content).toContain('EARIST E-GATEPASS');
    expect(content).toContain('OFFICIAL CAMPUS VISITOR ACCESS PASS');
  });

  it('verifies pass email subject is canonical: Your EARIST E-GatePass', () => {
    const emailTemplatePath = path.join(rootDir, 'server/templates/PassIssuedEmail.tsx');
    const content = fs.readFileSync(emailTemplatePath, 'utf-8');

    expect(content).toContain('Your EARIST E-GatePass');
    expect(content).toContain('egatepass-');
  });
});
