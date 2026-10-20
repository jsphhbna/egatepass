import { spawnSync } from 'node:child_process';
import path from 'node:path';

const playwrightCli = path.resolve('node_modules/@playwright/test/cli.js');
const cases = [
  { environment: 'configured', server: 'dev' },
  { environment: 'missing', server: 'dev' },
  { environment: 'malformed', server: 'dev' },
  { environment: 'configured', server: 'preview' },
];

for (const testCase of cases) {
  console.log(`\nStartup browser case: ${testCase.server}/${testCase.environment}`);
  const result = spawnSync(
    process.execPath,
    [playwrightCli, 'test', '--config=playwright.startup.config.ts'],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        STARTUP_ENV_CASE: testCase.environment,
        STARTUP_SERVER_MODE: testCase.server,
      },
      stdio: 'inherit',
    },
  );

  if (result.status !== 0) process.exit(result.status ?? 1);
}
