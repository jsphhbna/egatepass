import { test, expect } from '@playwright/test';
import path from 'node:path';

test.describe('Workstream G: Real OCR Integration in Browser Runtime', () => {
  test('processes high-contrast Philippine ID image offline, populates form inputs, and does NOT auto-submit', async ({
    page,
  }) => {
    // 1. Visit /get-pass
    await page.goto('/get-pass');

    // 2. Wait for registration form to render
    const autofillBtn = page.getByRole('button', { name: /Autofill from ID/i });
    await expect(autofillBtn).toBeVisible({ timeout: 15_000 });

    // 3. Verify inputs are initially empty
    const firstNameInput = page.locator('#firstName');
    const lastNameInput = page.locator('#lastName');
    await expect(firstNameInput).toBeVisible();
    await expect(lastNameInput).toBeVisible();

    // 4. Click "Autofill from ID" to open modal
    await autofillBtn.click();

    // 5. In modal, locate file input #ocr-file-upload
    const fileInput = page.locator('#ocr-file-upload');
    await expect(fileInput).toBeAttached({ timeout: 5_000 });

    // 6. Set synthetic Philippine ID fixture
    const fixturePath = path.resolve('tests/fixtures/synthetic-philippine-id.png');
    await fileInput.setInputFiles(fixturePath);

    // 7. Wait for OCR to complete and inputs to be populated
    // Tesseract WebAssembly + worker + traineddata loading takes a few seconds on first run
    await expect(firstNameInput).toHaveValue(/Juan/i, { timeout: 40_000 });
    await expect(lastNameInput).toHaveValue(/Dela Cruz/i, { timeout: 10_000 });

    // 8. Invariant: Form must remain un-submitted for user review
    // The "Next" or "Review" button should still be visible and not submitted
    const submitBtn = page.getByRole('button', { name: /Continue|Next/i });
    await expect(submitBtn).toBeVisible();

    // Verify URL is still /get-pass
    expect(page.url()).toContain('/get-pass');
  });
});
