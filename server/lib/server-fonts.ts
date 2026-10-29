import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

let initPromise: Promise<void> | null = null;

export function resolveBundledFontsDir(): string | null {
  const candidates = [
    path.resolve(process.cwd(), 'public/fonts'),
    path.resolve(process.cwd(), 'dist/fonts'),
    path.resolve(__dirname, '../../public/fonts'),
    path.resolve(__dirname, '../public/fonts'),
  ];

  for (const candidate of candidates) {
    if (
      fs.existsSync(candidate) &&
      fs.existsSync(path.join(candidate, 'NotoSans-Regular.ttf'))
    ) {
      return candidate;
    }
  }

  return null;
}

export async function ensureServerFonts(): Promise<void> {
  if (initPromise) {
    return initPromise;
  }

  initPromise = (async () => {
    try {
      const fontsDir = resolveBundledFontsDir();
      if (!fontsDir) {
        console.warn('[server-fonts] Bundled fonts directory not found in candidate paths.');
        return;
      }

      const tempDir = fs.existsSync('/tmp') ? '/tmp' : os.tmpdir();
      const confPath = path.join(tempDir, 'fonts.conf');
      const cacheDir = path.join(tempDir, 'fontconfig-cache');

      if (!fs.existsSync(cacheDir)) {
        try {
          fs.mkdirSync(cacheDir, { recursive: true });
        } catch {
          // ignore directory creation error
        }
      }

      const xml = `<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "fonts.dtd">
<fontconfig>
  <dir>${fontsDir.replace(/\\/g, '/')}</dir>
  <match target="pattern">
    <test qual="any" name="family"><string>Egatepass Noto Sans</string></test>
    <edit name="family" mode="assign" binding="same"><string>Noto Sans</string></edit>
  </match>
  <cachedir>${cacheDir.replace(/\\/g, '/')}</cachedir>
  <config></config>
</fontconfig>`;

      fs.writeFileSync(confPath, xml, 'utf8');

      process.env.FONTCONFIG_FILE = confPath;
      process.env.FONTCONFIG_PATH = tempDir;
    } catch (err) {
      console.warn('[server-fonts] Failed to initialize server fontconfig:', err);
    }
  })();

  return initPromise;
}
