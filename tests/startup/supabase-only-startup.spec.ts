import { expect, test } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

const environmentCase = process.env.STARTUP_ENV_CASE ?? 'configured';
const serverMode = process.env.STARTUP_SERVER_MODE ?? 'dev';
const evidenceDir = path.resolve('docs/evidence/p0-white-screen');
const updateEvidence = process.env.UPDATE_STARTUP_EVIDENCE === 'true';

test('renders the original landing page with Supabase-only browser configuration', async ({ page }, testInfo) => {
  const diagnostics = {
    consoleErrors: [] as string[],
    pageErrors: [] as string[],
    failedRequests: [] as Array<{ path: string; error: string | null }>,
    moduleResponses: [] as Array<{ path: string; status: number; contentType: string }>,
  };

  page.on('console', (message) => {
    if (message.type() === 'error') diagnostics.consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => diagnostics.pageErrors.push(error.message));
  page.on('requestfailed', (request) => {
    diagnostics.failedRequests.push({
      path: new URL(request.url()).pathname,
      error: request.failure()?.errorText ?? null,
    });
  });
  page.on('response', (response) => {
    const path = new URL(response.url()).pathname;
    if (path.startsWith('/src/') || path.endsWith('.tsx') || path.endsWith('.js')) {
      diagnostics.moduleResponses.push({
        path,
        status: response.status(),
        contentType: response.headers()['content-type'] ?? '',
      });
    }
  });

  await page.goto('/');
  await page.waitForLoadState('networkidle');
  const screenshotDir = updateEvidence ? evidenceDir : testInfo.outputPath('screenshots');
  await mkdir(screenshotDir, { recursive: true });

  const root = page.locator('#root');
  const rootState = await root.evaluate((element) => ({
    childCount: element.childElementCount,
    htmlLength: element.innerHTML.length,
    text: element.textContent?.trim().slice(0, 200) ?? '',
  }));

  await testInfo.attach('startup-diagnostics.json', {
    body: JSON.stringify({ rootState, ...diagnostics }, null, 2),
    contentType: 'application/json',
  });
  await page.screenshot({ path: path.join(screenshotDir, `after-${serverMode}-${environmentCase}-desktop.png`), fullPage: true });

  expect(rootState.childCount, 'React should mount visible content into #root').toBeGreaterThan(0);
  await expect(page.getByRole('heading', { name: 'E-GatePass', exact: true }).first()).toBeVisible();
  await expect(page.getByRole('link', { name: 'Get Your Gate Pass', exact: true }).first()).toBeVisible();
  const successfulJavaScript = diagnostics.moduleResponses.filter(({ status, contentType }) => status === 200 && contentType.includes('javascript'));
  expect(successfulJavaScript.length, 'The browser must load an executable JavaScript entrypoint').toBeGreaterThan(0);
  if (serverMode === 'dev') {
    expect(successfulJavaScript.some(({ path }) => path === '/src/main.tsx'), 'Vite dev must serve /src/main.tsx').toBe(true);
  }

  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: path.join(screenshotDir, `after-${serverMode}-${environmentCase}-390px.png`), fullPage: true });
  const viewport = await page.evaluate(() => ({ width: window.innerWidth, scrollWidth: document.documentElement.scrollWidth }));
  expect(viewport.scrollWidth, 'The landing page must not clip horizontally at 390px').toBeLessThanOrEqual(viewport.width);

  if (environmentCase === 'missing' || environmentCase === 'malformed') {
    await page.goto('/login');
    await expect(page.getByRole('heading', { name: 'Sign In' })).toBeVisible();
    await expect(page.getByRole('status')).toContainText(environmentCase === 'missing' ? 'not configured' : 'configuration is invalid');
    await expect(page.getByRole('button', { name: 'Sign In' })).toBeDisabled();
  }

  await page.goto('/reset-password');
  await expect(page.getByRole('heading', { name: 'Create New Password' })).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('invalid or has expired');

  expect(diagnostics.pageErrors, 'No uncaught page errors are allowed during startup routes').toEqual([]);
  expect(diagnostics.consoleErrors, 'No console errors are allowed during startup routes').toEqual([]);
});
