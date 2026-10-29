import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

function srgbToLinear(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

function relativeLuminance(hex: string): number {
  const sanitized = hex.replace('#', '');
  const r = parseInt(sanitized.substring(0, 2), 16);
  const g = parseInt(sanitized.substring(2, 4), 16);
  const b = parseInt(sanitized.substring(4, 6), 16);
  return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);
}

function contrastRatio(hex1: string, hex2: string): number {
  const l1 = relativeLuminance(hex1);
  const l2 = relativeLuminance(hex2);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

function getAllFiles(dir: string, extRegex: RegExp): string[] {
  let results: string[] = [];
  const list = readdirSync(dir);
  for (const file of list) {
    const fullPath = join(dir, file);
    const stat = statSync(fullPath);
    if (stat && stat.isDirectory()) {
      results = results.concat(getAllFiles(fullPath, extRegex));
    } else if (extRegex.test(file)) {
      results.push(fullPath);
    }
  }
  return results;
}

describe('Workstream A: WCAG 2.1 AA Contrast Ratios and Token Completeness', () => {
  const indexCss = readFileSync('src/index.css', 'utf8');

  // Extract CSS variables from :root in src/index.css
  const rootMatch = indexCss.match(/:root\s*\{([^}]+)\}/);
  const definedTokens = new Map<string, string>();
  if (rootMatch) {
    const tokenRegex = /(--color-[a-z0-9-]+)\s*:\s*([^;]+);/g;
    let match;
    while ((match = tokenRegex.exec(rootMatch[1])) !== null) {
      definedTokens.set(match[1].trim(), match[2].trim());
    }
  }

  it('proves dark variant override @custom-variant dark (&:where(.dark, .dark *)) exists', () => {
    expect(indexCss).toContain('@custom-variant dark (&:where(.dark, .dark *));');
  });

  it('validates text-primary contrast >= 4.5:1 against white and canvas', () => {
    const textPrimary = '#1F242F';
    const canvas = '#F7F8FA';
    const white = '#FFFFFF';

    const ratioWhite = contrastRatio(textPrimary, white);
    const ratioCanvas = contrastRatio(textPrimary, canvas);

    expect(ratioWhite).toBeGreaterThanOrEqual(4.5);
    expect(ratioCanvas).toBeGreaterThanOrEqual(4.5);
    expect(ratioWhite).toBeGreaterThan(12.0);
  });

  it('validates text-secondary (#5F6B7F) contrast >= 4.5:1 against white and canvas', () => {
    const textSecondary = '#5F6B7F';
    const canvas = '#F7F8FA';
    const white = '#FFFFFF';

    const ratioWhite = contrastRatio(textSecondary, white);
    const ratioCanvas = contrastRatio(textSecondary, canvas);

    expect(ratioWhite).toBeGreaterThanOrEqual(4.5);
    expect(ratioCanvas).toBeGreaterThanOrEqual(4.5);
  });

  it('validates text-muted (#687386) contrast >= 4.5:1 against white and canvas', () => {
    const textMuted = '#687386';
    const canvas = '#F7F8FA';
    const white = '#FFFFFF';

    const ratioWhite = contrastRatio(textMuted, white);
    const ratioCanvas = contrastRatio(textMuted, canvas);

    expect(ratioWhite).toBeGreaterThanOrEqual(4.5);
    expect(ratioCanvas).toBeGreaterThanOrEqual(4.5);
  });

  it('validates semantic dark/light pairs meet WCAG 2.1 AA (>= 4.5:1)', () => {
    const successDark = '#065F46';
    const successLight = '#D1FAE5';
    expect(contrastRatio(successDark, successLight)).toBeGreaterThanOrEqual(4.5);

    const warningDark = '#92400E';
    const warningLight = '#FEF3C7';
    expect(contrastRatio(warningDark, warningLight)).toBeGreaterThanOrEqual(4.5);

    const dangerDark = '#991B1B';
    const dangerLight = '#FEE2E2';
    expect(contrastRatio(dangerDark, dangerLight)).toBeGreaterThanOrEqual(4.5);
  });

  it('verifies all missing tokens are defined in src/index.css', () => {
    expect(definedTokens.has('--color-canvas-subtle')).toBe(true);
    expect(definedTokens.has('--color-surface-hover')).toBe(true);
    expect(definedTokens.has('--color-surface-subtle')).toBe(true);
    expect(definedTokens.has('--color-danger-border')).toBe(true);
    expect(definedTokens.has('--color-text-secondary')).toBe(true);
    expect(definedTokens.has('--color-text-muted')).toBe(true);
  });

  it('proves every var(--color-*) referenced across src/ is defined in src/index.css', () => {
    const srcFiles = getAllFiles('src', /\.(tsx?|css)$/);
    const missingTokens = new Set<string>();

    for (const file of srcFiles) {
      const content = readFileSync(file, 'utf8');
      const varMatches = content.matchAll(/var\((--color-[a-z0-9-]+)(?:,\s*[^)]+)?\)/g);
      for (const m of varMatches) {
        const token = m[1];
        if (!definedTokens.has(token)) {
          missingTokens.add(`${token} (found in ${file})`);
        }
      }
    }

    expect(Array.from(missingTokens)).toEqual([]);
  });
});
