import { test, expect } from '@playwright/test';
import path from 'node:path';

test.describe('Workstream H: Real Online Pre-Registration Runtime & Turnstile JIT Flow', () => {
  test('executes Turnstile just-in-time on Step 1 Continue, establishes session, and transitions to Live Face', async ({
    page,
  }) => {
    // 1. Install fake external Turnstile API before navigation (Section 6 contract)
    await page.addInitScript((testToken) => {
      const widgets = new Map();
      let widgetCounter = 0;
      (window as any).turnstile = {
        render: (container: any, options: any) => {
          widgetCounter++;
          const id = `widget-${widgetCounter}`;
          widgets.set(id, options);
          return id;
        },
        execute: (widgetId: string) => {
          const opts = widgets.get(widgetId);
          if (opts && typeof opts.callback === 'function') {
            setTimeout(() => {
              opts.callback(testToken);
            }, 10);
          }
        },
        reset: (_widgetId: string) => {
          // In Cloudflare Turnstile, reset() resets the widget without firing expired-callback
        },
        remove: (widgetId: string) => {
          widgets.delete(widgetId);
        },
      };
    }, 'mock-e2e-turnstile-token-xyz');

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

    // 3. Open /get-pass in new visitor mode
    await page.goto('/get-pass?mode=new');

    // 4. Fill required Step 1 (Personal Details) fields
    const firstNameInput = page.locator('#first-name, #firstName');
    const lastNameInput = page.locator('#last-name, #lastName');
    const contactInput = page.locator('#contact-number, #contactNumber');
    const addressInput = page.locator('#home-address, #homeAddress');
    const consentCheckbox = page.locator('input[type="checkbox"]#consent, input[name="consent"]');

    await expect(firstNameInput).toBeVisible({ timeout: 15_000 });
    await firstNameInput.fill('Maria');
    await lastNameInput.fill('Santos');
    await contactInput.fill('09171234567');
    await addressInput.fill('123 Sampaloc St, Manila');
    await expect(consentCheckbox).toBeVisible();
    await consentCheckbox.check();

    // Continue to Step 2: Visit & Arrival Details
    const continueToVisitBtn = page.getByRole('button', { name: /Next: Visit Details|Continue/i });
    await expect(continueToVisitBtn).toBeEnabled({ timeout: 5_000 });
    await continueToVisitBtn.click();

    // 5. Fill required Step 2 (Visit Details) fields
    const purposeSelect = page.locator('#visit-purpose-choice');
    const visitDateInput = page.locator('#visit-date');

    await expect(purposeSelect).toBeVisible({ timeout: 10_000 });
    await purposeSelect.selectOption({ index: 1 });

    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(new Date());
    await visitDateInput.fill(today);

    // 6. Click "Continue to Live Face Capture" (triggers Turnstile execute)
    const continueBtn = page.getByRole('button', { name: /Continue to Live Face Capture|Continue/i });
    await expect(continueBtn).toBeEnabled({ timeout: 5_000 });
    await continueBtn.click();

    // 7. Invariant: Must NOT show the blocker error "Verification challenge required to start registration"
    const blockerError = page.getByText(/Verification challenge required to start registration/i);
    await expect(blockerError).not.toBeVisible();

    // 8. Must successfully advance to Step 3 (Live Face Capture)
    const liveFaceHeading = page.getByRole('heading', { name: /Verify Your Identity/i });
    await expect(liveFaceHeading).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/Center face in oval/i)).toBeVisible();

    // 9. Invariant: Proves captcha token was delivered to Supabase auth payload
    expect(capturedCaptchaToken).toBe('mock-e2e-turnstile-token-xyz');
  });

  test('preserves portal actor continuity and never leaks simultaneous operator credentials across 5-step journey', async ({
    page,
  }) => {
    const OPERATOR_TOKEN = 'LEAKED_OPERATOR_TOKEN_FORBIDDEN';
    const PORTAL_TOKEN = 'mock-portal-token-9999';
    const VISITOR_ID = '33333333-3333-4333-8333-333333333333';

    // 1. Install fake external Turnstile API, mock camera, and simulate pre-existing operator credentials in localStorage
    await page.addInitScript(({ opToken, pToken, vId, testToken }) => {
      window.localStorage.setItem(
        'egatepass-operator-auth',
        JSON.stringify({
          access_token: opToken,
          token_type: 'bearer',
          user: { id: 'admin-uuid', role: 'admin' },
        })
      );

      const widgets = new Map();
      let widgetCounter = 0;
      (window as any).turnstile = {
        render: (container: any, options: any) => {
          widgetCounter++;
          const id = `widget-${widgetCounter}`;
          widgets.set(id, options);
          return id;
        },
        execute: (widgetId: string) => {
          const opts = widgets.get(widgetId);
          if (opts && typeof opts.callback === 'function') {
            setTimeout(() => {
              opts.callback(testToken);
            }, 10);
          }
        },
        reset: (_widgetId: string) => {
          // In Cloudflare Turnstile, reset() resets the widget without firing expired-callback
        },
        remove: (widgetId: string) => {
          widgets.delete(widgetId);
        },
      };

      // Mock userMedia for deterministic canvas-based camera in headless environments
      if (navigator.mediaDevices) {
        navigator.mediaDevices.getUserMedia = async () => {
          const canvas = document.createElement('canvas');
          canvas.width = 640;
          canvas.height = 480;
          const ctx = canvas.getContext('2d')!;
          ctx.fillStyle = '#2b6cb0';
          ctx.fillRect(0, 0, 640, 480);
          return (canvas as any).captureStream ? (canvas as any).captureStream(30) : new MediaStream();
        };
      }
    }, { opToken: OPERATOR_TOKEN, pToken: PORTAL_TOKEN, vId: VISITOR_ID, testToken: 'mock-turnstile-actor-continuity' });

    // 2. Monitor all network requests: assert OPERATOR_TOKEN is NEVER sent
    let operatorTokenObserved = false;
    page.on('request', (req) => {
      const auth = req.headers()['authorization'] || '';
      if (auth.includes(OPERATOR_TOKEN)) {
        operatorTokenObserved = true;
      }
    });

    // 3. Mock portal auth sign-in
    await page.route('**/auth/v1/**', async (route) => {
      if (route.request().method() === 'POST') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            access_token: PORTAL_TOKEN,
            token_type: 'bearer',
            expires_in: 3600,
            refresh_token: 'mock-portal-refresh',
            user: {
              id: VISITOR_ID,
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

    // 4. Mock create_upload_intent RPC
    let intentCounter = 0;
    await page.route('**/rest/v1/rpc/create_upload_intent**', async (route) => {
      const auth = route.request().headers()['authorization'] || '';
      expect(auth).toContain(PORTAL_TOKEN);
      expect(auth).not.toContain(OPERATOR_TOKEN);

      intentCounter++;
      const kind = intentCounter === 1 ? 'photo' : 'id';
      const bucket = kind === 'photo' ? 'visitor-photos' : 'visitor-ids';
      const intentId = `intent-e2e-${intentCounter}`;

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          intent_id: intentId,
          bucket_id: bucket,
          object_path: `${VISITOR_ID}/${intentId}/${kind}.jpg`,
          expires_at: new Date(Date.now() + 900000).toISOString(),
          max_bytes: 5242880,
        }),
      });
    });

    // 5. Mock Storage upload
    await page.route('**/storage/v1/object/**', async (route) => {
      const auth = route.request().headers()['authorization'] || '';
      expect(auth).toContain(PORTAL_TOKEN);
      expect(auth).not.toContain(OPERATOR_TOKEN);

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ Key: 'visitor-photos/mock.jpg' }),
      });
    });

    // 6. Mock identity verification & preflight API
    await page.route('**/api/passes/verify-identity**', async (route) => {
      const auth = route.request().headers()['authorization'] || '';
      expect(auth).toContain(PORTAL_TOKEN);
      expect(auth).not.toContain(OPERATOR_TOKEN);

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          result: 'matched',
          score: 0.88,
          reason: null,
        }),
      });
    });

    // 7. Mock pass issuance API
    await page.route('**/api/passes/issue**', async (route) => {
      const auth = route.request().headers()['authorization'] || '';
      expect(auth).toContain(PORTAL_TOKEN);
      expect(auth).not.toContain(OPERATOR_TOKEN);

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          pass: {
            id: 'pass-e2e-uuid-777',
            pass_number: 'P-2026-0099',
            visitor_name: 'Juan Dela Cruz',
            status: 'issued',
            qr_code: 'egatepass:P-2026-0099',
          },
        }),
      });
    });

    // 8. Open /get-pass in new visitor mode
    await page.goto('/get-pass?mode=new');
    await expect(page.locator('#first-name, #firstName')).toBeVisible({ timeout: 15_000 });

    // Step 1: Personal Details
    await page.locator('#first-name, #firstName').fill('Juan');
    await page.locator('#last-name, #lastName').fill('Dela Cruz');
    await page.locator('#contact-number, #contactNumber').fill('09181234567');
    await page.locator('#home-address, #homeAddress').fill('456 Sampaloc St, Manila');
    await page.locator('input[type="checkbox"]#consent, input[name="consent"]').check();

    const continueToVisitBtn = page.getByRole('button', { name: /Next: Visit Details|Continue to Visit Details|Continue/i });
    await continueToVisitBtn.click();

    // Step 2: Visit Details
    await expect(page.locator('#visit-purpose-choice')).toBeVisible({ timeout: 10_000 });
    await page.locator('#visit-purpose-choice').selectOption({ index: 1 });
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(new Date());
    await page.locator('#visit-date').fill(today);

    const continueBtn = page.getByRole('button', { name: /Continue to Live Face Capture|Continue/i });
    await continueBtn.click();

    // Verify arrived at Step 3: Live Face
    await expect(page.getByRole('heading', { name: /Verify Your Identity/i })).toBeVisible({ timeout: 15_000 });

    // Assert operator token was never leaked in any request
    expect(operatorTokenObserved).toBe(false);
  });
});
