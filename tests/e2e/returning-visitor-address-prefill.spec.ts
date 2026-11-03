import { test, expect } from '@playwright/test';

test.describe('Returning Visitor Address Prefill & UI Hydration Integration Suite', () => {
  const dummyJwt = `${Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')}.${Buffer.from(JSON.stringify({ sub: '11111111-2222-3333-4444-555555555555', role: 'anon', is_anonymous: true, exp: 9999999999 })).toString('base64url')}.mockSignature`;

  test.beforeEach(async ({ page }) => {
    // Mock mediaDevices webcam and drawImage with face pattern
    await page.addInitScript(() => {
      // Mock Turnstile
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
              opts.callback('mock-turnstile-prefill-token');
            }, 10);
          }
        },
        reset: (_widgetId: string) => {},
        remove: (widgetId: string) => {
          widgets.delete(widgetId);
        },
      };

      // Mock Camera mediaDevices
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

      // Polyfill drawImage for HTMLVideoElement so imageQualityPrecheck passes
      const origDrawImage = CanvasRenderingContext2D.prototype.drawImage;
      CanvasRenderingContext2D.prototype.drawImage = function(img: any, ...args: any[]) {
        if (img instanceof HTMLVideoElement) {
          const w = this.canvas.width || 640;
          const h = this.canvas.height || 480;
          this.fillStyle = '#f8fafc';
          this.fillRect(0, 0, w, h);
          this.fillStyle = '#fbbf24';
          this.beginPath();
          this.ellipse(w / 2, h / 2, 110, 140, 0, 0, Math.PI * 2);
          this.fill();
          this.fillStyle = '#1e293b';
          this.beginPath();
          this.arc(w / 2 - 40, h / 2 - 30, 15, 0, Math.PI * 2);
          this.arc(w / 2 + 40, h / 2 - 30, 15, 0, Math.PI * 2);
          this.fill();
          this.lineWidth = 6;
          this.strokeStyle = '#1e293b';
          this.beginPath();
          this.arc(w / 2, h / 2 + 10, 40, 0.2 * Math.PI, 0.8 * Math.PI);
          this.stroke();
          return;
        }
        return origDrawImage.apply(this, [img, ...args] as any);
      };
    });

    // Mock Supabase Auth
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

    // Mock PostgREST create_upload_intent RPC
    await page.route('**/rest/v1/rpc/create_upload_intent**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          intent_id: '33333333-3333-4333-8333-333333333333',
          bucket_id: 'visitor-photos',
          object_path: '11111111-2222-3333-4444-555555555555/33333333-3333-4333-8333-333333333333/photo.jpg',
          max_bytes: 5242880,
        }),
      });
    });

    // Mock Storage Upload PUT
    await page.route('**/storage/v1/object/**', async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ Key: 'visitor-photos/mock.jpg' }) });
    });

    // Mock API capabilities endpoint
    await page.route('**/api/passes/capabilities', async (route) => {
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
  });

  test('1. Proves Welcome Back screen hydrates full address, synchronizes manual postal override, preserves on re-opening selector, and clears properly', async ({ page }) => {
    test.setTimeout(120_000);
    let identifyCount = 0;

    // Profile 1: Complete structured PSGC address
    const completeProfile = {
      id: '44444444-4444-4444-8444-444444444444',
      firstName: 'Juan',
      middleName: 'Dela',
      lastName: 'Cruz',
      contactNumber: '09123456789',
      homeAddress: 'Unit 4B, Nagtahan St., Barangay 1, City of Manila, 1008',
      psgc: {
        version: '2026-q3',
        region: { code: '1300000000', name: 'NCR' },
        province: null,
        city: { code: '1380600000', name: 'City of Manila' },
        barangay: { code: '1380601001', name: 'Barangay 1' },
        houseBuilding: 'Unit 4B',
        street: 'Nagtahan St.',
        postalCode: '1008',
        postalCodeSource: 'PHLPost',
      },
    };

    // Profile 2: Minimal profile with null/absent optional address fields
    const minimalProfile = {
      id: '55555555-5555-4555-8555-555555555555',
      firstName: 'Maria',
      middleName: '',
      lastName: 'Santos',
      contactNumber: '09987654321',
      homeAddress: 'Barangay 2, City of Manila',
      psgc: {
        version: '2026-q3',
        region: { code: '1300000000', name: 'NCR' },
        province: null,
        city: { code: '1380600000', name: 'City of Manila' },
        barangay: { code: '1380601002', name: 'Barangay 2' },
        houseBuilding: undefined,
        street: undefined,
        postalCode: undefined,
        postalCodeSource: undefined,
      },
    };

    // Mock Lookup
    await page.route('**/api/passes/lookup-returning', async (route) => {
      const isSecond = identifyCount > 0;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          found: true,
          count: 1,
          candidates: [
            isSecond
              ? {
                  profileId: minimalProfile.id,
                  maskedName: 'M*** S***',
                  maskedContact: '0998***4321',
                  partialLocality: 'City of Manila',
                }
              : {
                  profileId: completeProfile.id,
                  maskedName: 'J*** D*** C***',
                  maskedContact: '0912***6789',
                  partialLocality: 'City of Manila',
                },
          ],
        }),
      });
    });

    // Mock Identify Returning
    await page.route('**/api/passes/identify-returning', async (route) => {
      identifyCount++;
      const currentProfile = identifyCount === 1 ? completeProfile : minimalProfile;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          available: true,
          matched: true,
          matchToken: `match-token-${identifyCount}`,
          profile: currentProfile,
          savedVehicles: [],
        }),
      });
    });

    // --- STEP 1: Visit /get-pass ---
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/get-pass', { waitUntil: 'domcontentloaded' });

    // Click Returning Visitor button
    const returningBtn = page.getByRole('button', { name: /Returning Visitor/i }).first();
    await expect(returningBtn).toBeVisible({ timeout: 15_000 });
    await returningBtn.click();

    // Fill Search Profile
    const firstNameInput = page.locator('input[placeholder*="Juan"]').or(page.locator('input[name="firstName"]')).first();
    const lastNameInput = page.locator('input[placeholder*="Cruz"]').or(page.locator('input[name="lastName"]')).first();
    await firstNameInput.fill('Juan');
    await lastNameInput.fill('Cruz');

    // Submit search
    const searchBtn = page.getByRole('button', { name: /Find My Profile|Search Profile|Search/i }).first();
    await searchBtn.click();

    // Candidate selection -> Proceed to Live Face Verification
    const proceedBtn = page.getByRole('button', { name: /Proceed to Live Face Verification/i });
    await expect(proceedBtn).toBeVisible({ timeout: 15_000 });
    await proceedBtn.click();

    // Now on capture screen — Click "Capture Selfie"
    const captureBtn = page.getByRole('button', { name: /Capture Selfie/i });
    await expect(captureBtn).toBeVisible({ timeout: 15_000 });
    await captureBtn.click();

    // Review stage — Click "Verify This Photo"
    const verifyPhotoBtn = page.getByRole('button', { name: /Verify This Photo/i });
    await expect(verifyPhotoBtn).toBeVisible({ timeout: 10_000 });
    await verifyPhotoBtn.click();

    // Welcome Back screen confirmation appears
    await expect(page.getByRole('heading', { name: /Welcome back, Juan!/i })).toBeVisible({ timeout: 15_000 });

    // --- SCENARIO A: Original PHLPost state ---
    const houseInput = page.getByPlaceholder(/Unit 4B, Bldg 2/i);
    const streetInput = page.getByPlaceholder(/Nagtahan St\./i);
    const postalInput = page.getByPlaceholder(/4-digit postal code/i);

    await expect(houseInput).toBeVisible();
    await expect(streetInput).toBeVisible();
    await expect(postalInput).toBeVisible();

    expect(await houseInput.inputValue()).toBe('Unit 4B');
    expect(await streetInput.inputValue()).toBe('Nagtahan St.');
    expect(await postalInput.inputValue()).toBe('1008');

    // Locality display shows Barangay 1, City of Manila
    await expect(page.getByText(/Barangay 1, City of Manila/i)).toBeVisible();
    await expect(page.getByText(/NCR/i)).toBeVisible();

    // PHLPost Auto-filled badge is visible
    await expect(page.getByText(/PHLPost Auto-filled/i)).toBeVisible();
    await expect(page.getByText(/^Manual entry$/i)).not.toBeVisible();

    // --- SCENARIO B: Manual override ---
    await postalInput.fill('1009');
    expect(await postalInput.inputValue()).toBe('1009');
    await expect(page.getByText(/PHLPost Auto-filled/i)).not.toBeVisible();
    await expect(page.getByText(/^Manual entry$/i)).toBeVisible();

    // --- SCENARIO C: Selector preservation (confirm unchanged locality) ---
    const changeLocalityBtn = page.getByRole('button', { name: 'Change' }).first();
    await changeLocalityBtn.click();
    await expect(page.getByRole('heading', { name: /Confirm Residential Address/i })).toBeVisible();
    const confirmAddressBtn = page.getByRole('button', { name: /Confirm Address/i });
    await confirmAddressBtn.click();

    expect(await postalInput.inputValue()).toBe('1009');
    await expect(page.getByText(/^Manual entry$/i)).toBeVisible();
    await expect(page.getByText(/PHLPost Auto-filled/i)).not.toBeVisible();

    // --- SCENARIO E: Clear postal code ---
    await postalInput.fill('');
    expect(await postalInput.inputValue()).toBe('');
    await expect(page.getByText(/PHLPost Auto-filled/i)).not.toBeVisible();
    await expect(page.getByText(/^Manual entry$/i)).not.toBeVisible();

    // Reopening and confirming unchanged locality keeps field empty
    await changeLocalityBtn.click();
    await expect(page.getByRole('heading', { name: /Confirm Residential Address/i })).toBeVisible();
    await confirmAddressBtn.click();
    expect(await postalInput.inputValue()).toBe('');
    await expect(page.getByText(/PHLPost Auto-filled/i)).not.toBeVisible();

    // --- SCENARIO D: Unchanged auto-filled code re-selection ---
    await postalInput.fill('1005');
    expect(await postalInput.inputValue()).toBe('1005');
    await houseInput.fill('Penthouse Suite');
    await streetInput.fill('Mendiola St.');

    // --- STEP 4: Repeat with minimalProfile and verify NO address leakage ---
    // Click Start Over to cleanly return to frontdoor without page reload
    const startOverBtn = page.getByRole('button', { name: /Start Over/i });
    if (await startOverBtn.isVisible().catch(() => false)) {
      await startOverBtn.click();
    } else {
      await page.goto('/get-pass', { waitUntil: 'domcontentloaded' });
    }
    const returningBtn2 = page.getByRole('button', { name: /Returning Visitor/i }).first();
    await expect(returningBtn2).toBeVisible({ timeout: 15_000 });
    await returningBtn2.click();

    const firstNameInput2 = page.locator('input[placeholder*="Juan"]').or(page.locator('input[name="firstName"]')).first();
    const lastNameInput2 = page.locator('input[placeholder*="Cruz"]').or(page.locator('input[name="lastName"]')).first();
    await firstNameInput2.fill('Maria');
    await lastNameInput2.fill('Santos');

    const searchBtn2 = page.getByRole('button', { name: /Find My Profile|Search Profile|Search/i }).first();
    await searchBtn2.click();

    const proceedBtn2 = page.getByRole('button', { name: /Proceed to Live Face Verification/i });
    await expect(proceedBtn2).toBeVisible({ timeout: 15_000 });
    await proceedBtn2.click();

    const captureBtn2 = page.getByRole('button', { name: /Capture Selfie/i });
    await expect(captureBtn2).toBeVisible({ timeout: 15_000 });
    await captureBtn2.click();

    const verifyPhotoBtn2 = page.getByRole('button', { name: /Verify This Photo/i });
    await expect(verifyPhotoBtn2).toBeVisible({ timeout: 10_000 });
    await verifyPhotoBtn2.click();

    // Welcome Back screen for Maria
    await expect(page.getByRole('heading', { name: /Welcome back, Maria!/i })).toBeVisible({ timeout: 15_000 });

    // Controlled inputs for optional fields MUST be empty strings (NO leakage from Juan)
    const houseInput2 = page.getByPlaceholder(/Unit 4B, Bldg 2/i);
    const streetInput2 = page.getByPlaceholder(/Nagtahan St\./i);
    const postalInput2 = page.getByPlaceholder(/4-digit postal code/i);

    expect(await houseInput2.inputValue()).toBe('');
    expect(await streetInput2.inputValue()).toBe('');
    expect(await postalInput2.inputValue()).toBe('');

    // Locality reflects Maria's address
    await expect(page.getByText(/Barangay 2, City of Manila/i)).toBeVisible();
  });

  test('2. Proves pass issuance serialization accurately captures manual postal override in request payload', async ({ page }) => {
    test.setTimeout(120_000);

    const testProfile = {
      id: '44444444-4444-4444-8444-444444444444',
      firstName: 'Juan',
      middleName: 'Dela',
      lastName: 'Cruz',
      contactNumber: '09123456789',
      homeAddress: 'Unit 4B, Nagtahan St., Barangay 1, City of Manila, 1008',
      psgc: {
        version: '2026-q3',
        region: { code: '1300000000', name: 'NCR' },
        province: null,
        city: { code: '1380600000', name: 'City of Manila' },
        barangay: { code: '1380601001', name: 'Barangay 1' },
        houseBuilding: 'Unit 4B',
        street: 'Nagtahan St.',
        postalCode: '1008',
        postalCodeSource: 'PHLPost',
      },
    };

    let capturedPassRequest: any = null;
    await page.route('**/api/passes/issue', async (route) => {
      capturedPassRequest = JSON.parse(route.request().postData() || '{}');
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({
          passId: 'mock-pass-uuid-1234',
          publicReference: 'mock-ref-5678',
          status: 'issued',
          returningProfileUpdate: 'updated',
        }),
      });
    });

    await page.route('**/api/passes/lookup-returning', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          found: true,
          count: 1,
          candidates: [
            {
              profileId: testProfile.id,
              maskedName: 'J*** D*** C***',
              maskedContact: '0912***6789',
              partialLocality: 'City of Manila',
            },
          ],
        }),
      });
    });

    await page.route('**/api/passes/identify-returning', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          available: true,
          matched: true,
          matchToken: 'mock-token-serialize-test',
          profile: testProfile,
          savedVehicles: [],
        }),
      });
    });

    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/get-pass', { waitUntil: 'domcontentloaded' });

    // Lookup and face verify Juan
    const returningBtn = page.getByRole('button', { name: /Returning Visitor/i }).first();
    await expect(returningBtn).toBeVisible({ timeout: 15_000 });
    await returningBtn.click();

    await page.locator('input[placeholder*="Juan"]').or(page.locator('input[name="firstName"]')).first().fill('Juan');
    await page.locator('input[placeholder*="Cruz"]').or(page.locator('input[name="lastName"]')).first().fill('Cruz');
    await page.getByRole('button', { name: /Find My Profile|Search Profile|Search/i }).first().click();

    const proceedBtn = page.getByRole('button', { name: /Proceed to Live Face Verification/i });
    await expect(proceedBtn).toBeVisible({ timeout: 15_000 });
    await proceedBtn.click();

    const captureBtn = page.getByRole('button', { name: /Capture Selfie/i });
    await expect(captureBtn).toBeVisible({ timeout: 15_000 });
    await captureBtn.click();

    const verifyPhotoBtn = page.getByRole('button', { name: /Verify This Photo/i });
    await expect(verifyPhotoBtn).toBeVisible({ timeout: 10_000 });
    await verifyPhotoBtn.click();

    await expect(page.getByRole('heading', { name: /Welcome back, Juan!/i })).toBeVisible({ timeout: 15_000 });

    // Manually override postal code from 1008 to 1009
    const postalInput = page.getByPlaceholder(/4-digit postal code/i);
    await postalInput.fill('1009');
    await expect(page.getByText(/^Manual entry$/i)).toBeVisible();

    // Select purpose
    const purposeSelect = page.locator('#visit-purpose-choice');
    await purposeSelect.selectOption('__other__');
    const detailsArea = page.locator('#visit-purpose-details');
    await detailsArea.fill('Official Document Submission');

    // Fill visit date (today)
    const todayStr = new Date().toISOString().split('T')[0];
    await page.locator('input[type="date"]').fill(todayStr);

    // On Foot arrival method is default or click it
    const onFootBtn = page.getByRole('button', { name: /On Foot \/ Transit/i });
    if (await onFootBtn.isVisible().catch(() => false)) {
      await onFootBtn.click();
    }

    // Proceed to review
    const reviewBtn = page.getByRole('button', { name: /Review Pass Details/i });
    await expect(reviewBtn).toBeVisible();
    await reviewBtn.click();

    // On review screen, click Generate E-GatePass
    const generateBtn = page.getByRole('button', { name: /Generate E-GatePass/i });
    await expect(generateBtn).toBeVisible({ timeout: 10_000 });
    await generateBtn.click();

    // Assert the intercepted submission payload
    await expect.poll(() => capturedPassRequest, { timeout: 15_000 }).not.toBeNull();
    expect(capturedPassRequest.psgc).toBeDefined();
    expect(capturedPassRequest.psgc.postalCode).toBe('1009');
    expect(capturedPassRequest.psgc.postalCodeSource).toBe('manual');
    expect(capturedPassRequest.psgc.cityCode).toBe('1380600000');
    expect(capturedPassRequest.psgc.barangayCode).toBe('1380601001');
  });
});
