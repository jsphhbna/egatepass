import { spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

const fixturePath = path.resolve('tests/fixtures/synthetic-philippine-id.png');
if (!fs.existsSync(fixturePath)) {
  console.log('[OCR-E2E] Generating synthetic ID fixture...');
  const genResult = spawnSync(process.execPath, ['scripts/generate-synthetic-id.mjs'], {
    cwd: process.cwd(),
    stdio: 'inherit',
  });
  if (genResult.status !== 0) {
    console.error('[OCR-E2E] Failed to generate fixture');
    process.exit(1);
  }
}

const playwrightCli = path.resolve('node_modules/@playwright/test/cli.js');
console.log('\n[OCR-E2E] Running real browser OCR integration test...');

const result = spawnSync(
  process.execPath,
  [playwrightCli, 'test', '--config=playwright.ocr.config.ts'],
  {
    cwd: process.cwd(),
    env: {
      ...process.env,
    },
    stdio: 'inherit',
  },
);

if (result.status !== 0) {
  console.error(`[OCR-E2E] Test run failed with status ${result.status}`);
  process.exit(result.status ?? 1);
}

console.log('[OCR-E2E] Real browser OCR integration test passed successfully.');
