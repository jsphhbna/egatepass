import { test, expect } from '@playwright/test';

test.describe('Mobile Stepper Geometry & WebKit Viewport Contract (Sections 47-48)', () => {
  const mobileViewports = [
    { width: 320, height: 568, name: 'SE 1st Gen' },
    { width: 375, height: 667, name: 'iPhone SE 2nd/3rd' },
    { width: 390, height: 844, name: 'iPhone 12/13/14' },
    { width: 393, height: 852, name: 'iPhone 14/15/16 Pro' },
    { width: 414, height: 896, name: 'iPhone XR/11/Plus' },
    { width: 430, height: 932, name: 'iPhone 14/15/16 Pro Max' },
  ];

  for (const vp of mobileViewports) {
    test(`guarantees circle centerY equality and horizontal spacing on ${vp.name} (${vp.width}x${vp.height})`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto('/get-pass?mode=new');

      const stepperNav = page.locator('nav[aria-label="Progress"]');
      await expect(stepperNav).toBeVisible({ timeout: 15_000 });

      // Find all 6 step circles
      const circles = stepperNav.locator('ol > li > div:first-child > div.rounded-full');
      await expect(circles).toHaveCount(6);

      const circleBoxes = [];
      for (let i = 0; i < 6; i++) {
        const box = await circles.nth(i).boundingBox();
        expect(box).not.toBeNull();
        circleBoxes.push(box!);
      }

      // 1. Verify circle centerY equality across all 6 step markers
      const firstCenterY = circleBoxes[0].y + circleBoxes[0].height / 2;
      for (let i = 1; i < 6; i++) {
        const centerY = circleBoxes[i].y + circleBoxes[i].height / 2;
        // Allow at most 1px delta for subpixel rendering
        expect(Math.abs(centerY - firstCenterY)).toBeLessThanOrEqual(1.0);
      }

      // 2. Verify horizontal spacing equality
      const deltas = [];
      for (let i = 0; i < 5; i++) {
        const c1X = circleBoxes[i].x + circleBoxes[i].width / 2;
        const c2X = circleBoxes[i + 1].x + circleBoxes[i + 1].width / 2;
        deltas.push(c2X - c1X);
      }
      const avgDelta = deltas.reduce((a, b) => a + b, 0) / deltas.length;
      for (const d of deltas) {
        // Delta between centers must be within 2px of average (grid column rounding)
        expect(Math.abs(d - avgDelta)).toBeLessThanOrEqual(2.0);
      }

      // 3. Verify connectors line up with circle center line
      const connectors = stepperNav.locator('ol > li > div:first-child > div.h-0\\.5');
      await expect(connectors).toHaveCount(5);

      for (let i = 0; i < 5; i++) {
        const connBox = await connectors.nth(i).boundingBox();
        expect(connBox).not.toBeNull();
        const connCenterY = connBox!.y + connBox!.height / 2;
        expect(Math.abs(connCenterY - firstCenterY)).toBeLessThanOrEqual(1.5);
      }
    });
  }
});
