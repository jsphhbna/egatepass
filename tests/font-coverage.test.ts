import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { resolveBundledFontsDir, ensureServerFonts } from '../server/lib/server-fonts';

describe('Workstream B: Bundled Noto Sans Font Coverage Contract', () => {
  it('bundles official NotoSans-Regular.ttf and NotoSans-Bold.ttf in public/fonts', () => {
    const regularPath = path.resolve(process.cwd(), 'public/fonts/NotoSans-Regular.ttf');
    const boldPath = path.resolve(process.cwd(), 'public/fonts/NotoSans-Bold.ttf');
    const licensePath = path.resolve(process.cwd(), 'public/fonts/OFL.txt');

    expect(fs.existsSync(regularPath), 'Missing NotoSans-Regular.ttf').toBe(true);
    expect(fs.existsSync(boldPath), 'Missing NotoSans-Bold.ttf').toBe(true);
    expect(fs.existsSync(licensePath), 'Missing OFL.txt').toBe(true);

    const regStat = fs.statSync(regularPath);
    const boldStat = fs.statSync(boldPath);
    expect(regStat.size).toBeGreaterThan(500000);
    expect(boldStat.size).toBeGreaterThan(500000);

    const licenseContent = fs.readFileSync(licensePath, 'utf8');
    expect(licenseContent).toContain('SIL OPEN FONT LICENSE');
  });

  it('server fontconfig initializes correctly and configures FONTCONFIG_FILE', async () => {
    const fontsDir = resolveBundledFontsDir();
    expect(fontsDir).not.toBeNull();
    expect(fs.existsSync(fontsDir!)).toBe(true);

    await ensureServerFonts();

    expect(process.env.FONTCONFIG_FILE).toBeDefined();
    expect(fs.existsSync(process.env.FONTCONFIG_FILE!)).toBe(true);

    const confXml = fs.readFileSync(process.env.FONTCONFIG_FILE!, 'utf8');
    expect(confXml).toContain('<fontconfig>');
    expect(confXml).toContain('Noto Sans');
    expect(confXml).toContain('Egatepass Noto Sans');
  });
});
