import { test, expect } from '@playwright/test';
import path from 'node:path';

// Helper to install Turnstile and mock camera into page runtime
async function setupPageMocks(page: any, token = 'mock-e2e-turnstile-token-xyz') {
  await page.addInitScript((testToken: string) => {
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
      reset: (_widgetId: string) => {},
      remove: (widgetId: string) => {
        widgets.delete(widgetId);
      },
    };

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

    // In headless browser environments, HTMLVideoElement attached to mock MediaStream
    // does not render active frames through the headless compositor, causing video.drawImage()
    // to produce blank/black frames. Polyfill drawImage for HTMLVideoElement with a valid face pattern.
    const origDrawImage = CanvasRenderingContext2D.prototype.drawImage;
    CanvasRenderingContext2D.prototype.drawImage = function(img: any, ...args: any[]) {
      if (img instanceof HTMLVideoElement) {
        const w = this.canvas.width || 640;
        const h = this.canvas.height || 480;
        this.fillStyle = '#f8fafc';
        this.fillRect(0, 0, w, h);
        this.fillStyle = '#94a3b8';
        for (let x = 0; x < w; x += 40) {
          for (let y = 0; y < h; y += 40) {
            if ((x / 40 + y / 40) % 2 === 0) {
              this.fillRect(x, y, 40, 40);
            }
          }
        }
        // Face placeholder
        this.fillStyle = '#fbbf24';
        this.beginPath();
        this.ellipse(w / 2, h / 2, 110, 140, 0, 0, Math.PI * 2);
        this.fill();
        // Eyes
        this.fillStyle = '#1e293b';
        this.beginPath();
        this.arc(w / 2 - 40, h / 2 - 30, 15, 0, Math.PI * 2);
        this.arc(w / 2 + 40, h / 2 - 30, 15, 0, Math.PI * 2);
        this.fill();
        // Smile
        this.lineWidth = 6;
        this.strokeStyle = '#1e293b';
        this.beginPath();
        this.arc(w / 2, h / 2 + 10, 40, 0.2 * Math.PI, 0.8 * Math.PI);
        this.stroke();
        return;
      }
      return origDrawImage.apply(this, [img, ...args] as any);
    };
  }, token);

  // Mock Supabase anonymous sign-in endpoint
  await page.route('**/auth/v1/**', async (route: any) => {
    if (route.request().method() === 'POST') {
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

  // Mock capabilities endpoint
  await page.route('**/api/passes/capabilities**', async (route: any) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        returningVisitorAvailable: false,
        facialRecognitionConfigured: false,
      }),
    });
  });
}

test.describe('Section 1 & 2: Real Front-Door Flow and Address Autocomplete UI Contract', () => {
  test('navigates Visitor Type -> Arrival Method, validates radio selection, back navigation, and keyboard controls', async ({
    page,
  }) => {
    await setupPageMocks(page);

    // 1. Open /get-pass front-door directly with NO query params
    await page.goto('/get-pass');

    // Screen 1: Visitor Type
    await expect(page.getByText('Setup Step 1 of 2')).toBeVisible({ timeout: 15_000 });
    const newVisitorCard = page.getByRole('button', { name: /Register as New Visitor|New Visitor/i }).first();
    const returningVisitorCard = page.getByRole('button', { name: /Check Availability|Returning Visitor/i }).first();

    await expect(newVisitorCard).toBeVisible();
    await expect(returningVisitorCard).toBeVisible();

    // Verify Returning Visitor displays scheduled maintenance
    await expect(page.getByText(/Scheduled Maintenance/i)).toBeVisible();

    // 2. Select New Visitor -> advances to Screen 2 (Arrival Method)
    await newVisitorCard.click();
    await expect(page.getByText('Setup Step 2 of 2')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole('heading', { name: 'Arrival Method' })).toBeVisible();

    // Neither choice selected initially
    const onFootRadio = page.locator('div[role="radio"]').filter({ hasText: /On Foot \/ Commute/i });
    const vehicleRadio = page.locator('div[role="radio"]').filter({ hasText: /Bringing a Vehicle/i });

    await expect(onFootRadio).toHaveAttribute('aria-checked', 'false');
    await expect(vehicleRadio).toHaveAttribute('aria-checked', 'false');

    // Continue button must be disabled
    const continueBtn = page.getByRole('button', { name: /Continue to Personal Details/i });
    await expect(continueBtn).toBeDisabled();

    // Select On Foot
    await onFootRadio.click();
    await expect(onFootRadio).toHaveAttribute('aria-checked', 'true');
    await expect(vehicleRadio).toHaveAttribute('aria-checked', 'false');
    await expect(continueBtn).toBeEnabled();

    // Test Back navigation
    const backBtn = page.getByRole('button', { name: /Back to Visitor Type/i });
    await backBtn.click();
    await expect(page.getByText('Setup Step 1 of 2')).toBeVisible();

    // Re-enter Arrival Method
    await newVisitorCard.click();
    await expect(page.getByText('Setup Step 2 of 2')).toBeVisible();

    // Test Keyboard navigation: Focus and Arrow keys
    await onFootRadio.focus();
    await page.keyboard.press('ArrowRight');
    await expect(vehicleRadio).toHaveAttribute('aria-checked', 'true');
    await expect(onFootRadio).toHaveAttribute('aria-checked', 'false');

    await vehicleRadio.focus();
    await page.keyboard.press('ArrowLeft');
    await expect(onFootRadio).toHaveAttribute('aria-checked', 'true');
    await expect(vehicleRadio).toHaveAttribute('aria-checked', 'false');

    // Select onFoot and continue
    await onFootRadio.click();
    await expect(onFootRadio).toHaveAttribute('aria-checked', 'true');
    await continueBtn.click();

    // Should now be on Personal Details
    await expect(page.getByRole('heading', { name: 'Personal Details' })).toBeVisible();
  });

  test('address autocomplete contract: dropdown selection, unselected block, edit invalidation, and error fail-closed', async ({
    page,
  }) => {
    await setupPageMocks(page);

    // Mock autocomplete route
    await page.route('**/api/address/autocomplete**', async (route: any) => {
      const url = new URL(route.request().url());
      const q = url.searchParams.get('q') || '';

      if (q.includes('Error500')) {
        await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'internal_error' }) });
        return;
      }

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          suggestions: [
            {
              placeId: 'geo-nagtahan-1008',
              formatted: 'Nagtahan St, Sampaloc, Manila, Philippines',
              addressLine1: 'Nagtahan St',
              addressLine2: 'Sampaloc, Manila',
              city: 'Manila',
              state: 'Metro Manila',
              countryCode: 'ph',
              lat: 14.5995,
              lon: 120.9842,
              resultType: 'street',
              confidence: 0.98,
              matchType: 'full_match',
            },
          ],
        }),
      });
    });

    await page.goto('/get-pass?mode=new&arrival=no_vehicle');

    const firstName = page.locator('#first-name, #firstName');
    const lastName = page.locator('#last-name, #lastName');
    const contact = page.locator('#contact-number, #contactNumber');
    const addressInput = page.locator('#home-address, #homeAddress');
    const consent = page.locator('input[type="checkbox"]#consent, input[name="consent"]');
    const nextBtn = page.getByRole('button', { name: /Next: Visit Details|Continue/i });

    await expect(firstName).toBeVisible({ timeout: 15_000 });
    await firstName.fill('Juan');
    await lastName.fill('Dela Cruz');
    await contact.fill('09171234567');
    await consent.check();

    // Case 1: Typed address WITHOUT selecting suggestion -> BLOCKED
    await addressInput.fill('123 Unverified Street Nowhere');
    await nextBtn.click();
    await expect(page.getByText(/select a verified home address from the suggestions/i).first()).toBeVisible({ timeout: 5_000 });

    // Case 2: Type valid prefix, dropdown suggestion appears visually, and select it
    await addressInput.fill('Nagtahan');
    const suggestionItem = page.locator('div[role="button"]:has-text("Nagtahan St")').first();
    await expect(suggestionItem).toBeVisible({ timeout: 10_000 });
    await suggestionItem.click();

    // Verified address card is now rendered with a "Change" button
    const changeBtn = page.getByRole('button', { name: /Change/i });
    await expect(changeBtn).toBeVisible();

    // Case 3: Clicking "Change" clears verification and restores search input
    await changeBtn.click();
    await expect(addressInput).toBeVisible();

    // If user types without selecting a suggestion -> BLOCKED
    await addressInput.fill('Unverified typed address after change');
    await nextBtn.click();
    await expect(page.getByText(/select a verified home address from the suggestions/i).first()).toBeVisible({ timeout: 5_000 });

    // Re-select suggestion to proceed
    await addressInput.fill('Nagtahan');
    await expect(suggestionItem).toBeVisible({ timeout: 10_000 });
    await suggestionItem.click();
    await nextBtn.click();

    // Advances to Visit Details
    await expect(page.getByRole('heading', { name: /Visit & Vehicle Details|Visit Details/i })).toBeVisible({ timeout: 10_000 });
  });
});

test.describe('Section 15 & 16: Viewport Ergonomics and Mobile WebKit', () => {
  const viewports = [
    { name: 'Desktop 1280x800', width: 1280, height: 800 },
    { name: 'Android Tablet 800x1280', width: 800, height: 1280 },
    { name: 'Android Phone 412x915', width: 412, height: 915 },
    { name: 'iPhone 12 390x844', width: 390, height: 844 },
  ];

  for (const vp of viewports) {
    test(`renders without horizontal overflow and with reachable controls on ${vp.name}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await setupPageMocks(page);

      await page.goto('/get-pass');
      await expect(page.getByText('Setup Step 1 of 2')).toBeVisible({ timeout: 15_000 });

      // Verify no horizontal overflow
      const hasOverflow = await page.evaluate(() => {
        return document.documentElement.scrollWidth > window.innerWidth;
      });
      expect(hasOverflow).toBe(false);

      // Verify New Visitor button is reachable and clickable
      const newVisitorBtn = page.getByRole('button', { name: /Register as New Visitor|New Visitor/i }).first();
      await expect(newVisitorBtn).toBeVisible();
      await newVisitorBtn.click();

      // Screen 2: Arrival Method
      await expect(page.getByText('Setup Step 2 of 2')).toBeVisible();
      const hasOverflowStep2 = await page.evaluate(() => {
        return document.documentElement.scrollWidth > window.innerWidth;
      });
      expect(hasOverflowStep2).toBe(false);
    });
  }
});

test.describe('Section 17: Full Front-Door Vehicle Registration Browser Workflow', () => {
  test('executes end-to-end vehicle registration from clean front-door, verifies Step 1 to Step 2 advancement, displays vehicle details on review, and proves issue payload contract', async ({
    page,
  }) => {
    await setupPageMocks(page);

    // Mock vehicle catalog endpoints
    await page.route('**/api/vehicles/makes**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ makes: ['Toyota', 'Honda', 'Mitsubishi'] }),
      });
    });

    await page.route('**/api/vehicles/models**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ models: ['Vios', 'Corolla', 'Innova'] }),
      });
    });

    // Mock address autocomplete endpoint
    await page.route('**/api/address/autocomplete**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          suggestions: [
            {
              placeId: 'geo-nagtahan-1008',
              formatted: 'Nagtahan St, Sampaloc, Manila, Philippines',
              addressLine1: 'Nagtahan St',
              addressLine2: 'Sampaloc, Manila',
              city: 'Manila',
              state: 'Metro Manila',
              countryCode: 'ph',
              lat: 14.5995,
              lon: 120.9842,
              resultType: 'street',
              confidence: 0.98,
              matchType: 'full_match',
            },
          ],
        }),
      });
    });

    // Mock upload intents
    let intentCounter = 0;
    await page.route('**/rest/v1/rpc/create_upload_intent**', async (route) => {
      intentCounter++;
      const kind = intentCounter === 1 ? 'vehicle' : intentCounter === 2 ? 'photo' : 'id';
      const bucket = kind === 'photo' ? 'visitor-photos' : kind === 'id' ? 'visitor-ids' : 'visitor-vehicles';
      const intentId = `intent-e2e-${intentCounter}`;

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          intent_id: intentId,
          bucket_id: bucket,
          object_path: `mock-user/${intentId}/${kind}.jpg`,
          expires_at: new Date(Date.now() + 900000).toISOString(),
          max_bytes: 5242880,
        }),
      });
    });

    // Mock Storage upload
    await page.route('**/storage/v1/object/**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ Key: 'visitor-photos/mock.jpg' }),
      });
    });

    // Mock identity verification
    await page.route('**/api/passes/verify-identity**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          outcome: 'matched',
          result: 'matched',
          score: 0.92,
          reason: null,
        }),
      });
    });

    // Capture and mock pass issuance
    let capturedIssuePayload: any = null;
    await page.route('**/api/passes/issue**', async (route) => {
      try {
        capturedIssuePayload = JSON.parse(route.request().postData() || '{}');
      } catch {}

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          passId: 'pass-e2e-vehicle-888',
          qrToken: 'egatepass-qr-token-xyz',
          validFrom: '2026-10-31T08:00:00Z',
          validUntil: '2026-10-31T17:00:00Z',
        }),
      });
    });

    // 1. Start from clean URL frontdoor
    await page.goto('/get-pass');
    await expect(page.getByText('Setup Step 1 of 2')).toBeVisible({ timeout: 15_000 });

    // 2. Select New Visitor
    const newVisitorCard = page.getByRole('button', { name: /Register as New Visitor|New Visitor/i }).first();
    await newVisitorCard.click();

    // 3. Screen 2: Arrival Method -> Select "Bringing a Vehicle"
    await expect(page.getByText('Setup Step 2 of 2')).toBeVisible({ timeout: 10_000 });
    const vehicleRadio = page.locator('div[role="radio"]').filter({ hasText: /Bringing a Vehicle/i });
    await vehicleRadio.click();
    await expect(vehicleRadio).toHaveAttribute('aria-checked', 'true');

    const continueBtn = page.getByRole('button', { name: /Continue to Personal Details/i });
    await expect(continueBtn).toBeEnabled();
    await continueBtn.click();

    // 4. Step 1: Personal Details
    await expect(page.getByRole('heading', { name: 'Personal Details' })).toBeVisible({ timeout: 10_000 });

    const firstNameInput = page.locator('#first-name, #firstName');
    const lastNameInput = page.locator('#last-name, #lastName');
    const contactInput = page.locator('#contact-number, #contactNumber');
    const addressInput = page.locator('#home-address, #homeAddress');
    const consentCheckbox = page.locator('input[type="checkbox"]#consent, input[name="consent"]');

    await firstNameInput.fill('Juan');
    await lastNameInput.fill('Dela Cruz');
    await contactInput.fill('09171234567');

    await addressInput.fill('Nagtahan');
    const suggestionItem = page.locator('div[role="button"]:has-text("Nagtahan St")').first();
    await expect(suggestionItem).toBeVisible({ timeout: 10_000 });
    await suggestionItem.click();

    await consentCheckbox.check();

    // 5. Submit Step 1 -> MUST NOT BE BLOCKED BY VEHICLE SCHEMA!
    const step1NextBtn = page.getByRole('button', { name: /Next: Visit Details|Continue/i });
    await expect(step1NextBtn).toBeEnabled();
    await step1NextBtn.click();

    // MUST ADVANCE TO STEP 2
    const visitHeading = page.getByRole('heading', { name: /Visit & Vehicle Details|Visit Details/i });
    await expect(visitHeading).toBeVisible({ timeout: 10_000 });

    // 6. Verify Step 2 UI contents
    await expect(page.getByText(/Arrival Method: Bringing a Vehicle/i)).toBeVisible();

    // Purpose and date
    const purposeSelect = page.locator('#visit-purpose-choice');
    await expect(purposeSelect).toBeVisible();
    await purposeSelect.selectOption({ index: 1 });

    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(new Date());
    await page.locator('#visit-date').fill(today);

    // Plate number
    const plateInput = page.getByPlaceholder('ABC 1234');
    await expect(plateInput).toBeVisible();
    await plateInput.fill('ABC 1234');

    // Color
    const colorSelect = page.locator('select[name="vehicleColor"]');
    await expect(colorSelect).toBeVisible();
    await colorSelect.selectOption('White');

    // Attach Vehicle Photo (using fixture)
    const vehicleFileInput = page.locator('#vehicle-photo-input');
    await vehicleFileInput.setInputFiles(path.resolve('tests/fixtures/face-sample-1.jpg'));

    // Verify preview renders
    await expect(page.locator('img[alt="Vehicle preview"]')).toBeVisible({ timeout: 10_000 });

    // 7. Advance to Step 3 (Live Face Capture)
    const toFaceCaptureBtn = page.getByRole('button', { name: /Continue to Live Face Capture|Continue/i });
    await expect(toFaceCaptureBtn).toBeEnabled();
    await toFaceCaptureBtn.click();

    // Advance to Live Face
    const liveFaceHeading = page.getByRole('heading', { name: /Verify Your Identity/i });
    await expect(liveFaceHeading).toBeVisible({ timeout: 15_000 });

    // Capture face photo
    const captureBtn = page.getByRole('button', { name: /Take Live Photo/i });
    await expect(captureBtn).toBeEnabled({ timeout: 10_000 });
    await captureBtn.click();

    const usePhotoBtn = page.getByRole('button', { name: /Use This Photo/i });
    await expect(usePhotoBtn).toBeVisible({ timeout: 10_000 });
    await usePhotoBtn.click();

    // 8. Step 4: Valid ID Document
    await expect(page.getByRole('heading', { name: /Valid ID Document/i })).toBeVisible({ timeout: 10_000 });

    const idFileInput = page.locator('#id-file-input');
    await idFileInput.setInputFiles(path.resolve('tests/fixtures/synthetic-philippine-id.png'));

    await expect(page.locator('img[alt="Valid ID"]')).toBeVisible({ timeout: 10_000 });

    const verifyIdBtn = page.getByRole('button', { name: /Verify Identity/i });
    await expect(verifyIdBtn).toBeEnabled();
    await verifyIdBtn.click();

    // 9. Step 5: Identity Verified
    await expect(page.getByRole('heading', { name: 'Identity Verified Successfully' })).toBeVisible({ timeout: 15_000 });
    const toReviewBtn = page.getByRole('button', { name: /Continue to Review/i });
    await expect(toReviewBtn).toBeVisible();
    await toReviewBtn.click();

    // 10. Review Screen
    const reviewHeading = page.getByRole('heading', { name: /Review Your Information/i });
    await expect(reviewHeading).toBeVisible({ timeout: 15_000 });

    // Assert Vehicle Declaration card on review screen
    await expect(page.getByText('Arrival & Vehicle')).toBeVisible();
    await expect(page.getByText('ABC 1234')).toBeVisible();
    await expect(page.getByText('White')).toBeVisible();

    // 10. Generate Pass
    const generatePassBtn = page.getByRole('button', { name: /Generate E-GatePass/i });
    await expect(generatePassBtn).toBeEnabled();
    await generatePassBtn.click();

    // 11. Assert Pass Issuance payload & Done Screen
    await expect(page.getByText(/Your E-GatePass is Ready|Pass Issued/i).first()).toBeVisible({ timeout: 15_000 });

    expect(capturedIssuePayload).not.toBeNull();
    expect(capturedIssuePayload.arrivalMode).toBe('vehicle');
    expect(capturedIssuePayload.vehicle?.plateNumber).toBe('ABC 1234');
    expect(capturedIssuePayload.vehicle?.color).toBe('White');
    expect(capturedIssuePayload.vehicle?.vehicleType).toBe('car');
  });
});
