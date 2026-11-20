import { test, expect } from '@playwright/test';

test.describe('Visitor Multi-Step Registration & Form Decoupling Regression Suite', () => {
  const dummyJwt = `${Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')}.${Buffer.from(JSON.stringify({ sub: '11111111-2222-3333-4444-555555555555', role: 'anon', is_anonymous: true, exp: 9999999999 })).toString('base64url')}.mockSignature`;

  test.beforeEach(async ({ page }) => {
    // 1. Install fake external Turnstile API before navigation
    await page.addInitScript((testToken) => {
      const widgets = new Map();
      let widgetCounter = 0;
      (window as any).turnstile = {
        render: (_container: any, options: any) => {
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
        reset: (_widgetId: string) => {},
        remove: (widgetId: string) => {
          widgets.delete(widgetId);
        },
      };
    }, 'mock-turnstile-registration-token');

    // 2. Mock Supabase Auth
    await page.route('**/auth/v1/**', async (route) => {
      if (route.request().method() === 'POST') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            access_token: dummyJwt,
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

    // 3. Mock API Office & Personnel endpoints
    await page.route('**/api/office/personnel*', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          offices: [
            { id: 'office-reg-001', name: 'Office of the Registrar', description: 'Academic records, credentials, and transcripts' },
            { id: 'office-adm-002', name: 'Admissions Office', description: 'Student application and enrollment processing' },
          ],
          personnel: [],
        }),
      });
    });

    // 4. Mock API Calendar schedules & system closures endpoints
    await page.route('**/api/office/calendar*', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ schedules: [] }),
      });
    });

    await page.route('**/api/system/calendar*', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ closures: [] }),
      });
    });

    // 5. Mock Returning Visitor candidate lookup (returns not found for fresh registration)
    await page.route('**/api/passes/candidate-lookup*', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ found: false, candidates: [] }),
      });
    });
    await page.route('**/api/passes/lookup-returning*', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ found: false, candidates: [] }),
      });
    });

    // 6. Mock OSM map tiles
    await page.route('**/tile.openstreetmap.org/**', async (route) => {
      const png1x1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
      await route.fulfill({
        status: 200,
        contentType: 'image/png',
        body: png1x1,
      });
    });

    // 7. Mock PostgREST app_settings endpoint
    await page.route('**/rest/v1/app_settings*', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          working_hours_start: '08:00:00',
          working_hours_end: '17:00:00',
          timezone: 'Asia/Manila',
          scheduling_days_ahead: 14,
          peak_mode: false,
          visit_purposes: [
            { label: 'Meeting', requiresDetails: false, detailPrompt: '' },
            { label: 'Document submission', requiresDetails: false, detailPrompt: '' },
            { label: 'Appointment', requiresDetails: false, detailPrompt: '' },
            { label: 'Delivery', requiresDetails: false, detailPrompt: '' },
            { label: 'Personal concern', requiresDetails: false, detailPrompt: '' },
          ],
          visitor_instructions: ['Follow campus policies', 'Bring valid ID'],
        }),
      });
    });

    // 8. Mock API capabilities endpoint
    await page.route('**/api/passes/capabilities*', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          returningVisitorAvailable: true,
          returningEnrollmentAvailable: true,
          returningCryptoConfigured: true,
          thresholdConfigured: true,
          thresholdMode: 'provisional',
        }),
      });
    });

    // 9. Mock PostgREST PSGC & Postal Reference to fall back cleanly to bundled datasets
    await page.route('**/rest/v1/psgc_locations*', async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
    });
    await page.route('**/rest/v1/postal_code_reference*', async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
    });

    // 10. Capture browser console and unhandled errors for deterministic CI diagnostics
    page.on('console', (msg) => {
      if (msg.type() === 'error') console.log(`[BROWSER ERROR] ${msg.text()}`);
    });
    page.on('pageerror', (err) => {
      console.log(`[BROWSER PAGEERROR] ${err.message}`);
    });
  });

  test('1. Submitting invalid Personal Details is properly blocked on Step 1 with error feedback', async ({ page }) => {
    await page.goto('/get-pass?mode=new&arrival=no_vehicle');

    // Verify Personal Details heading is present
    await expect(page.getByRole('heading', { name: /Personal Details/i })).toBeVisible({ timeout: 30_000 });

    const submitBtn = page.getByRole('button', { name: /Next: Visit Details/i });
    await expect(submitBtn).toBeVisible();

    // Fill invalid data: 1-character first name, invalid phone number, no consent, no address
    const firstNameInput = page.locator('#firstName, #first-name');
    const contactInput = page.locator('#contactNumber, #contact-number');

    await firstNameInput.fill('A');
    await contactInput.fill('09123456'); // 8 digits (fails validatePhMobile)

    // Attempt submission
    await submitBtn.click();

    // Invariant: Must remain on Step 1 (Personal Details)
    await expect(page.getByRole('heading', { name: /Personal Details/i })).toBeVisible();
    await expect(page.getByRole('heading', { name: /Visit & Vehicle Details/i })).not.toBeVisible();

    // Invariant: Validation errors must be displayed for invalid fields
    await expect(page.getByText(/First name must be at least 2 characters|minimum 2 characters/i).first()).toBeVisible();
    await expect(page.getByText(/valid Philippine mobile number/i).first()).toBeVisible();
    await expect(page.getByText(/Please select your sex/i).first()).toBeVisible();
    await expect(page.getByText(/You must accept the Data Privacy Act notice/i).first()).toBeVisible();
  });

  test('2. Submitting Personal Details succeeds with empty purpose, executes onFormNext, and advances to Visit Details', async ({ page }) => {
    await page.goto('/get-pass?mode=new&arrival=no_vehicle');

    await expect(page.getByRole('heading', { name: /Personal Details/i })).toBeVisible({ timeout: 30_000 });

    const firstNameInput = page.locator('#firstName, #first-name');
    const middleNameInput = page.locator('#middleName, #middle-name');
    const lastNameInput = page.locator('#lastName, #last-name');
    const contactInput = page.locator('#contactNumber, #contact-number');
    const consentCheckbox = page.locator('#consent, input[name="consent"]');

    // Fill valid personal details
    await firstNameInput.fill('Juan');
    await middleNameInput.fill('Mercado');
    await lastNameInput.fill('Dela Cruz');
    await contactInput.fill('09171234567');
    await page.getByText('Male', { exact: true }).click();

    // Select PSGC Residential Address via Modal
    const selectAddressBtn = page.getByRole('button', { name: /Select your barangay and city/i });
    await expect(selectAddressBtn).toBeVisible();
    await selectAddressBtn.click();

    // Address selector modal opens
    await expect(page.locator('#cascading-address-title')).toBeVisible();

    // Select Region: NCR
    const ncrOption = page.locator('.divide-y button', { hasText: /National Capital Region/i }).first();
    await expect(ncrOption).toBeVisible({ timeout: 10_000 });
    await ncrOption.click();

    // Select City: City of Manila
    const manilaOption = page.locator('.divide-y button', { hasText: /City of Manila/i }).first();
    await expect(manilaOption).toBeVisible({ timeout: 10_000 });
    await manilaOption.click();

    // Select Barangay: First available barangay
    const bgyOption = page.locator('.divide-y button').first();
    await expect(bgyOption).toBeVisible({ timeout: 10_000 });
    await bgyOption.click();

    // Confirm Address inside modal
    const confirmAddrBtn = page.getByRole('button', { name: /Confirm Address/i });
    await expect(confirmAddrBtn).toBeVisible();
    await confirmAddrBtn.click();

    // Check Data Privacy Consent
    await consentCheckbox.check();

    // Submitting Personal Details form:
    // Invariant: purpose is completely empty at this stage
    const submitBtn = page.getByRole('button', { name: /Next: Visit Details/i });
    await expect(submitBtn).toBeEnabled();
    await submitBtn.click();

    // Invariant: onFormNext executes, step advances to Step 2 (Visit & Vehicle Details)
    await expect(page.getByRole('heading', { name: /Visit & Vehicle Details/i })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('heading', { name: /Personal Details/i })).not.toBeVisible();
  });

  test('3. Purpose remains strictly mandatory on Visit Details step; submitting without purpose is blocked', async ({ page }) => {
    await page.goto('/get-pass?mode=new&arrival=no_vehicle');

    await expect(page.getByRole('heading', { name: /Personal Details/i })).toBeVisible({ timeout: 30_000 });

    // Fill valid Step 1
    await page.locator('#firstName, #first-name').fill('Maria');
    await page.locator('#lastName, #last-name').fill('Santos');
    await page.locator('#contactNumber, #contact-number').fill('09181234567');
    await page.getByText('Female', { exact: true }).click();

    // Select Address
    await page.getByRole('button', { name: /Select your barangay and city/i }).click();
    await page.locator('.divide-y button', { hasText: /National Capital Region/i }).first().click();
    await page.locator('.divide-y button', { hasText: /City of Manila/i }).first().click();
    await page.locator('.divide-y button').first().click();
    await page.getByRole('button', { name: /Confirm Address/i }).click();

    // Check consent and advance to Step 2
    await page.locator('#consent, input[name="consent"]').check();
    await page.getByRole('button', { name: /Next: Visit Details/i }).click();

    // On Step 2: Visit & Vehicle Details
    await expect(page.getByRole('heading', { name: /Visit & Vehicle Details/i })).toBeVisible({ timeout: 30_000 });

    // Select Destination Office
    const officeSelect = page.locator('#destination-office-select');
    await expect(officeSelect).toBeVisible();
    await officeSelect.selectOption('office-reg-001');

    // Select General Office Visit Type
    const generalVisitBtn = page.getByRole('button', { name: /The Office Itself/i });
    await expect(generalVisitBtn).toBeVisible();
    await generalVisitBtn.click();

    // Invariant: Leave purpose empty and attempt to advance to Step 3
    const continueToCaptureBtn = page.getByRole('button', { name: /Continue to Live Face Capture/i });
    await expect(continueToCaptureBtn).toBeVisible();
    await continueToCaptureBtn.click();

    // Invariant: Blocked from advancing to Step 3 (Live Face Capture)
    await expect(page.getByRole('heading', { name: /Verify Your Identity/i })).not.toBeVisible();
    await expect(page.getByRole('heading', { name: /Visit & Vehicle Details/i })).toBeVisible();
    await expect(page.getByText(/Please describe the purpose of your visit/i).first()).toBeVisible();

    // Now supply valid purpose through VisitPurposeField
    const purposeChoice = page.locator('#visit-purpose-choice');
    await expect(purposeChoice).toBeVisible();
    await purposeChoice.selectOption({ index: 1 });

    // Select an available visit date on calendar
    const openDateBtn = page.locator('button', { hasText: /Open/i }).first();
    await expect(openDateBtn).toBeVisible({ timeout: 10_000 });
    await openDateBtn.click();

    // Click Continue to Live Face Capture again
    await continueToCaptureBtn.click();

    // Invariant: Successfully advances to Step 3 (Live Face Capture)
    await expect(page.getByRole('heading', { name: /Verify Your Identity/i })).toBeVisible({ timeout: 30_000 });
  });

  test('4. Existing Data Privacy modal, address modal cancellation, and phone normalization remain intact', async ({ page }) => {
    await page.goto('/get-pass?mode=new&arrival=no_vehicle');

    await expect(page.getByRole('heading', { name: /Personal Details/i })).toBeVisible({ timeout: 30_000 });

    // 1. Data Privacy notice modal opens and dismisses
    const privacyNoticeBtn = page.getByRole('button', { name: /Read our Data Privacy Notice/i });
    await expect(privacyNoticeBtn).toBeVisible();
    await privacyNoticeBtn.click();
    await expect(page.getByRole('heading', { name: /Data Privacy Notice/i })).toBeVisible();
    const closePrivacyBtn = page.getByRole('button', { name: /Close|I Understand/i }).first();
    await closePrivacyBtn.click();
    await expect(page.getByRole('heading', { name: /Data Privacy Notice/i })).not.toBeVisible();

    // 2. Address selector modal cancellation with Escape
    const selectAddressBtn = page.getByRole('button', { name: /Select your barangay and city/i });
    await selectAddressBtn.click();
    await expect(page.locator('#cascading-address-title')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('#cascading-address-title')).not.toBeVisible();

    // 3. Contact number normalization test
    const contactInput = page.locator('#contactNumber, #contact-number');
    await contactInput.fill('+63 917 123 4567');
    await page.locator('#firstName, #first-name').fill('Clara');
    await page.locator('#lastName, #last-name').fill('Reyes');
    await page.getByText('Female', { exact: true }).click();

    // Select Address
    await selectAddressBtn.click();
    await page.locator('.divide-y button', { hasText: /National Capital Region/i }).first().click();
    await page.locator('.divide-y button', { hasText: /City of Manila/i }).first().click();
    await page.locator('.divide-y button').first().click();
    await page.getByRole('button', { name: /Confirm Address/i }).click();

    await page.locator('#consent, input[name="consent"]').check();
    await page.getByRole('button', { name: /Next: Visit Details/i }).click();

    // Advanced successfully to Visit Details
    await expect(page.getByRole('heading', { name: /Visit & Vehicle Details/i })).toBeVisible({ timeout: 30_000 });
  });
});
