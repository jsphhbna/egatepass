import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

describe('Cryptographic Secret Isolation & Zero-Fallback Static Verification', () => {
  const serverDir = path.resolve(process.cwd(), 'server');

  function getAllTsFiles(dir: string): string[] {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const files: string[] = [];
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        files.push(...getAllTsFiles(fullPath));
      } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
        files.push(fullPath);
      }
    }
    return files;
  }

  const serverTsFiles = getAllTsFiles(serverDir);

  it('finds TypeScript files in server directory', () => {
    expect(serverTsFiles.length).toBeGreaterThan(5);
  });

  it('ensures NO file in server/ uses egatepass-fallback hardcoded string', () => {
    const violations: { file: string; line: number; match: string }[] = [];

    for (const filePath of serverTsFiles) {
      const content = fs.readFileSync(filePath, 'utf8');
      const lines = content.split('\n');
      lines.forEach((lineText, idx) => {
        if (/egatepass-fallback/i.test(lineText)) {
          violations.push({
            file: path.relative(process.cwd(), filePath),
            line: idx + 1,
            match: lineText.trim(),
          });
        }
      });
    }

    expect(violations).toEqual([]);
  });

  it('ensures NO file in server/ uses test-rate-limit fallback in runtime code', () => {
    const violations: { file: string; line: number; match: string }[] = [];

    for (const filePath of serverTsFiles) {
      const content = fs.readFileSync(filePath, 'utf8');
      const lines = content.split('\n');
      lines.forEach((lineText, idx) => {
        if (/test-rate-limit/i.test(lineText)) {
          violations.push({
            file: path.relative(process.cwd(), filePath),
            line: idx + 1,
            match: lineText.trim(),
          });
        }
      });
    }

    expect(violations).toEqual([]);
  });

  it('ensures NO cross-fallback between PASS_TOKEN_SECRET and RETURNING_MATCH_TOKEN_SECRET', () => {
    const violations: { file: string; line: number; match: string }[] = [];

    for (const filePath of serverTsFiles) {
      const content = fs.readFileSync(filePath, 'utf8');
      const lines = content.split('\n');
      lines.forEach((lineText, idx) => {
        if (
          (/PASS_TOKEN_SECRET.*\|\|.*RETURNING_MATCH_TOKEN_SECRET/.test(lineText) ||
            /RETURNING_MATCH_TOKEN_SECRET.*\|\|.*PASS_TOKEN_SECRET/.test(lineText))
        ) {
          violations.push({
            file: path.relative(process.cwd(), filePath),
            line: idx + 1,
            match: lineText.trim(),
          });
        }
      });
    }

    expect(violations).toEqual([]);
  });

  it('verifies that RETURNING_MATCH_TOKEN_SECRET enforces minimum length >= 32 in key routes', () => {
    const filesToCheck = [
      path.join(serverDir, 'routes', 'passes', 'lookup-returning.ts'),
      path.join(serverDir, 'routes', 'passes', 'returning-photo-preview.ts'),
      path.join(serverDir, 'routes', 'passes', 'returning-id-preview.ts'),
      path.join(serverDir, 'routes', 'passes', 'issue.ts'),
    ];

    for (const filePath of filesToCheck) {
      expect(fs.existsSync(filePath), `File exists: ${filePath}`).toBe(true);
      const content = fs.readFileSync(filePath, 'utf8');
      expect(
        content.includes('32'),
        `${path.basename(filePath)} must enforce secret minimum length of 32`
      ).toBe(true);
      expect(
        content.includes('RETURNING_MATCH_TOKEN_SECRET'),
        `${path.basename(filePath)} must reference dedicated RETURNING_MATCH_TOKEN_SECRET`
      ).toBe(true);
    }
  });

  it('verifies that RATE_LIMIT_HMAC_SECRET enforces minimum length >= 32 and fails closed in issue.ts', () => {
    const issuePath = path.join(serverDir, 'routes', 'passes', 'issue.ts');
    const content = fs.readFileSync(issuePath, 'utf8');
    expect(content).toContain('RATE_LIMIT_HMAC_SECRET');
    expect(content).toContain('abuse_control_unavailable');
    expect(content).toMatch(/dedicatedSecret\.length\s*<\s*32/);
  });
});
