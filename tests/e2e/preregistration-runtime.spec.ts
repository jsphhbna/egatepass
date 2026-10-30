import { test, expect } from '@playwright/test';

test.describe('Workstream H: Real Online Pre-Registration Runtime & Turnstile JIT Flow', () => {
  test('executes Turnstile just-in-time on Step 1 Continue, establishes session, and transitions to Live Face', async ({
    page,
  }) => {
    // 1. Install mock Turnstile token hook before navigation
    await page.addInitScript(() => {
      (window as any).__MOCK_TURNSTILE_TOKEN__ = 'mock-e2e-turnstile-token-xyz';
    });

    // 2. Mock Supabase anonymous sign-in endpoint for offline preview server testing
    let capturedCaptchaToken: string | null = null;
    await page.route('**/auth/v1/**', async (route) => {
      const request = route.request();
      if (request.method() === 'POST') {
        try {
          const body = JSON.parse(request.postData() || '{}');
          capturedCaptchaToken = body.gotrue_meta_security?.captcha_token || null;
        } catch {
          // ignore parsing error
        }
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            access_token: 'mock-portal-access-token',
            token_type: 'bearer',
            expires_in: 3600,
            refresh_token: 'mock-portal-refresh-token',
            user: {
              id: '11111111-2222-3333-4444-555555555555',
              aud: 'authenticated',
              role: 'authenticated',
              is_anonymous: true,
            },
          }),
        });
        return;
      }
      await route.continue();
    });

    // 3. Open /get-pass
    await page.goto('/get-pass');

    // 4. Fill required visitor form fields
    const firstNameInput = page.locator('#first-name, #firstName');
    const lastNameInput = page.locator('#last-name, #lastName');
    const contactInput = page.locator('#contact-number, #contactNumber');
    const purposeSelect = page.locator('#visit-purpose-choice');
    const visitDateInput = page.locator('#visit-date');
    const consentCheckbox = page.locator('input[type="checkbox"]#consent, input[name="consent"]');

    await expect(firstNameInput).toBeVisible({ timeout: 15_000 });
    await firstNameInput.fill('Maria');
    await lastNameInput.fill('Santos');
    await contactInput.fill('09171234567');

    await expect(purposeSelect).toBeVisible();
    await purposeSelect.selectOption({ index: 1 });

    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(new Date());
    await visitDateInput.fill(today);

    await expect(consentCheckbox).toBeVisible();
    await consentCheckbox.check();

    // 5. Click "Continue to Live Face Capture"
    const continueBtn = page.getByRole('button', { name: /Continue to Live Face Capture|Continue/i });
    await expect(continueBtn).toBeEnabled({ timeout: 5_000 });
    await continueBtn.click();

    // 6. Invariant: Must NOT show the blocker error "Verification challenge required to start registration"
    const blockerError = page.getByText(/Verification challenge required to start registration/i);
    await expect(blockerError).not.toBeVisible();

    // 7. Must successfully advance to Step 2 (Live Face Capture)
    const liveFaceHeading = page.getByRole('heading', { name: /Verify Your Identity/i });
    await expect(liveFaceHeading).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/Center face in oval/i)).toBeVisible();

    // 8. Invariant: Proves captcha token was delivered to Supabase auth payload
    expect(capturedCaptchaToken).toBe('mock-e2e-turnstile-token-xyz');
  });
});
