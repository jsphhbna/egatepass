import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

let initPromise: Promise<void> | null = null;

/**
 * Resolves the directory containing both mandatory institutional font files:
 * - NotoSans-Regular.ttf
 * - NotoSans-Bold.ttf
 *
 * Uses explicit deployment roots, avoiding fragile CommonJS globals in ESM.
 */
export function resolveBundledFontsDir(): string | null {
  const candidates = [
    path.resolve(process.cwd(), 'public/fonts'),
    path.resolve(process.cwd(), 'dist/fonts'),
    '/var/task/public/fonts',
  ];

  for (const candidate of candidates) {
    if (
      fs.existsSync(candidate) &&
      fs.existsSync(path.join(candidate, 'NotoSans-Regular.ttf')) &&
      fs.existsSync(path.join(candidate, 'NotoSans-Bold.ttf'))
    ) {
      return candidate;
    }
  }

  return null;
}

/**
 * Ensures deterministic server fontconfig is initialized for Sharp SVG-to-PNG rasterization.
 * Fails closed: if mandatory font files or fontconfig setup cannot be verified, throws an
 * authoritative error rather than allowing silent fallback to arbitrary environment fonts.
 */
export async function ensureServerFonts(): Promise<void> {
  if (initPromise) {
    return initPromise;
  }

  initPromise = (async () => {
    const fontsDir = resolveBundledFontsDir();
    if (!fontsDir) {
      throw new Error('server_font_initialization_failed: mandatory bundled fonts (NotoSans-Regular.ttf, NotoSans-Bold.ttf) not found');
    }

    const tempDir = fs.existsSync('/tmp') ? '/tmp' : os.tmpdir();
    const confPath = path.join(tempDir, 'fonts.conf');
    const cacheDir = path.join(tempDir, 'fontconfig-cache');

    try {
      if (!fs.existsSync(cacheDir)) {
        fs.mkdirSync(cacheDir, { recursive: true });
      }

      const escapedFontsDir = fontsDir.replace(/\\/g, '/');
      const escapedCacheDir = cacheDir.replace(/\\/g, '/');

      // Fontconfig configuration mapping institutional 'Egatepass Noto Sans'
      // to bundled Noto Sans for both Regular (400) and Bold (700) weights.
      const xml = `<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "fonts.dtd">
<fontconfig>
  <dir>${escapedFontsDir}</dir>
  <cachedir>${escapedCacheDir}</cachedir>
  <match target="pattern">
    <test qual="any" name="family"><string>Egatepass Noto Sans</string></test>
    <edit name="family" mode="assign" binding="same"><string>Noto Sans</string></edit>
  </match>
  <config></config>
</fontconfig>`;

      fs.writeFileSync(confPath, xml, 'utf8');

      process.env.FONTCONFIG_FILE = confPath;
      process.env.FONTCONFIG_PATH = tempDir;
    } catch (err) {
      throw new Error('server_font_initialization_failed: failed to write fontconfig or configure environment: ' + (err instanceof Error ? err.message : String(err)));
    }
  })();

  return initPromise;
}

/**
 * Test-only hook to reset the cached initialization promise and font environment variables.
 * Enables regression tests to simulate missing fonts or initialization failures.
 * Never to be invoked in production application runtime.
 */
export function __resetServerFontInitializationForTests(): void {
  initPromise = null;
  delete process.env.FONTCONFIG_FILE;
  delete process.env.FONTCONFIG_PATH;
}
