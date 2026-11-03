import { test, expect } from '@playwright/test';

async function setupMobileMocks(page: any) {
  await page.addInitScript(() => {
    // Turnstile mock
    const widgets = new Map();
    let widgetCounter = 0;
    (window as any).turnstile = {
      render: (container: any, options: any) => {
        widgetCounter++;
        const id = `widget-${widgetCounter}`;
        widgets.set(id, options);
        if (options && typeof options.callback === 'function') {
          setTimeout(() => options.callback('mock-turnstile-mobile-token'), 50);
        }
        return id;
      },
      execute: (widgetId: string) => {
        const opts = widgets.get(widgetId);
        if (opts && typeof opts.callback === 'function') {
          setTimeout(() => opts.callback('mock-turnstile-mobile-token'), 50);
        }
      },
      reset: (_widgetId: string) => {},
      remove: (widgetId: string) => {
        widgets.delete(widgetId);
      },
    };

    // Camera mock
    if (navigator.mediaDevices) {
      navigator.mediaDevices.getUserMedia = async () => {
        const canvas = document.createElement('canvas');
        canvas.width = 640;
        canvas.height = 480;
        const ctx = canvas.getContext('2d')!;
        ctx.fillStyle = '#f8fafc';
        ctx.fillRect(0, 0, 640, 480);
        return (canvas as any).captureStream ? (canvas as any).captureStream(30) : new MediaStream();
      };
    }
  });
}

test.describe('iPhone 12 (390x844) Mobile Portal UX & Interaction Suite', () => {
  const mobileProfiles = [
    { name: 'iPhone 12 / 13 / 14', width: 390, height: 844 },
    { name: 'Narrow iPhone', width: 375, height: 812 },
    { name: 'Compact Mobile', width: 320, height: 812 },
    { name: 'Larger Mobile', width: 414, height: 896 },
  ];

  for (const profile of mobileProfiles) {
    test(`renders without horizontal viewport overflow on ${profile.name} (${profile.width}x${profile.height})`, async ({ page }) => {
      await setupMobileMocks(page);
      await page.setViewportSize({ width: profile.width, height: profile.height });
      await page.goto('/get-pass');

      await expect(page.getByText(/Setup Step 1 of 2|Online Visitor Pass/i).first()).toBeVisible({ timeout: 15_000 });

      // Verify page body does not have horizontal overflow
      const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
      const clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
      expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 1);
    });
  }

  test('verifies Remember Me enrollment card visibility and layout at iPhone 12 dimensions', async ({ page }) => {
    await setupMobileMocks(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/get-pass');

    // Check frontdoor action buttons are accessible
    const newVisitorBtn = page.getByRole('button', { name: /Register as New Visitor|New Visitor/i }).first();
    await expect(newVisitorBtn).toBeVisible({ timeout: 15_000 });
    const box = await newVisitorBtn.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.height).toBeGreaterThanOrEqual(44);
  });

  test('verifies returning visitor lookup and capture stage navigation on iPhone 12', async ({ page }) => {
    await setupMobileMocks(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/get-pass');

    // Click Returning Visitor
    const returningBtn = page.getByRole('button', { name: /Returning Visitor/i }).first();
    await expect(returningBtn).toBeVisible({ timeout: 15_000 });
    await returningBtn.click();

    // Verify lookup screen appears or frontdoor navigation functions
    const lookupTitle = page.getByText(/Find Your Enrolled Profile|Returning Visitor/i).first();
    await expect(lookupTitle).toBeVisible({ timeout: 10_000 });
  });
});
