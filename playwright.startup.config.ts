import { defineConfig, devices } from '@playwright/test';

const environmentCase = process.env.STARTUP_ENV_CASE ?? 'configured';
const serverMode = process.env.STARTUP_SERVER_MODE ?? 'dev';
const supabaseOverrides = environmentCase === 'missing'
  ? { VITE_SUPABASE_URL: '', VITE_SUPABASE_PUBLISHABLE_KEY: '' }
  : environmentCase === 'malformed'
    ? { VITE_SUPABASE_URL: 'not-a-valid-url', VITE_SUPABASE_PUBLISHABLE_KEY: 'synthetic-public-test-key' }
    : {};

export default defineConfig({
  testDir: './tests/startup',
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  workers: 1,
  reporter: [['list']],
  outputDir: 'test-results/startup',
  use: {
    baseURL: 'http://127.0.0.1:4174',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
    actionTimeout: 10_000,
    navigationTimeout: 15_000,
  },
  projects: [
    {
      name: 'edge',
      use: {
        ...devices['Desktop Edge'],
        channel: 'msedge',
      },
    },
  ],
  webServer: {
    command: `npm run ${serverMode === 'preview' ? 'preview' : 'dev'} -- --host 127.0.0.1 --port 4174 --strictPort`,
    url: 'http://127.0.0.1:4174',
    reuseExistingServer: false,
    timeout: 60_000,
    env: {
      ...process.env,
      ...supabaseOverrides,
    },
  },
});
