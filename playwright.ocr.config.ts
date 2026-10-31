import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  timeout: 90_000,
  testDir: './tests/e2e',
  testMatch: /.*\.spec\.ts/,
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  workers: 1,
  reporter: [['list']],
  outputDir: 'test-results/ocr',
  use: {
    baseURL: 'http://127.0.0.1:4176',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
    actionTimeout: 45_000,
    navigationTimeout: 25_000,
  },
  projects: [
    {
      name: 'edge',
      testIgnore: /.*webkit\.spec\.ts/,
      use: {
        ...devices['Desktop Edge'],
        channel: 'msedge',
      },
    },
    {
      name: 'webkit-iphone',
      testMatch: /.*webkit\.spec\.ts/,
      use: {
        ...devices['iPhone 12'],
        browserName: 'webkit',
      },
    },
  ],
  webServer: {
    command: 'npm run preview -- --host 127.0.0.1 --port 4176 --strictPort',
    url: 'http://127.0.0.1:4176',
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
