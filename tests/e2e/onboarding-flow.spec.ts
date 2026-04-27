import { test, expect } from '@playwright/test';
import { seedMockAuth, seedOnboardingState } from './fixtures';

/**
 * High-value structural checks across the six-step V2 flow:
 *   - Progress bar percentage matches completed-step count
 *   - Locked future steps cannot be navigated to
 *   - Smart-Safe conditional logic shows/hides the right fields
 *   - Pickup contact is required in BOTH commit and deferred branches
 *   - Legacy /onboarding/banking redirects to /onboarding/deposit
 *
 * Per-step submission tests are covered in their dedicated specs.
 */

test.describe('Onboarding flow — structure (V2, 6 steps)', () => {
  test.beforeEach(async ({ page }) => {
    await seedMockAuth(page);
  });

  test('progress bar advances correctly as steps complete', async ({ page }) => {
    // 0/6 done
    await seedOnboardingState(page, {
      storefrontName: 'Corner Bodega',
      currentStep: 1,
      completedSteps: [0],
    });
    await page.goto('/onboarding');
    await expect(page.locator('.progress__label')).toContainText(/0% to launch/);

    // 3/6 done
    await seedOnboardingState(page, {
      storefrontName: 'Corner Bodega',
      currentStep: 4,
      completedSteps: [0, 1, 2, 3],
    });
    await page.goto('/onboarding');
    await expect(page.locator('.progress__label')).toContainText(/50% to launch/);

    // 6/6 done
    await seedOnboardingState(page, {
      storefrontName: 'Corner Bodega',
      currentStep: 6,
      completedSteps: [0, 1, 2, 3, 4, 5, 6],
    });
    await page.goto('/onboarding');
    await expect(page.locator('.progress__label')).toContainText(/100% to launch/);
  });

  test('legacy /onboarding/banking redirects to /onboarding/deposit', async ({ page }) => {
    await seedOnboardingState(page, {
      storefrontName: 'Corner Bodega',
      currentStep: 3,
      completedSteps: [0, 1, 2],
    });
    await page.goto('/onboarding/banking');
    await expect(page).toHaveURL(/\/onboarding\/deposit$/);
  });

  test('locked sidebar items are not clickable', async ({ page }) => {
    await seedOnboardingState(page, {
      storefrontName: 'Corner Bodega',
      currentStep: 3,
      completedSteps: [0, 1, 2],
    });
    await page.goto('/onboarding/deposit');
    // First pickup is the last step; it should be locked here.
    const lastStep = page.locator('.step-item__link', { hasText: 'First pickup' });
    await expect(lastStep).toHaveAttribute('aria-disabled', 'true');
  });
});

test.describe('Smart Safe conditional logic (Step 2)', () => {
  test.beforeEach(async ({ page }) => {
    await seedMockAuth(page);
    await seedOnboardingState(page, {
      storefrontName: 'Corner Bodega',
      currentStep: 2,
      completedSteps: [0, 1],
    });
  });

  test('selecting Yes reveals key holders and provisional credit', async ({ page }) => {
    await page.goto('/onboarding/safe');
    // Pick "Yes" for Smart Safe
    await page.getByLabel(/Yes/, { exact: true }).first().check();
    await expect(
      page.getByText(/Who holds the keys/i).first(),
    ).toBeVisible();
    await expect(
      page.getByText(/Provisional credit/i).first(),
    ).toBeVisible();
  });

  test('selecting No hides key holders and shows storage method', async ({ page }) => {
    await page.goto('/onboarding/safe');
    await page.getByLabel(/No/, { exact: true }).first().check();
    await expect(
      page.getByText(/How is cash stored/i).first(),
    ).toBeVisible();
    await expect(page.getByText(/Who holds the keys/i)).toHaveCount(0);
    await expect(page.getByText(/Provisional credit/i)).toHaveCount(0);
  });
});

test.describe('Pickup contact (Step 6) — required in both branches', () => {
  test.beforeEach(async ({ page }) => {
    await seedMockAuth(page);
    await seedOnboardingState(page, {
      storefrontName: 'Corner Bodega',
      currentStep: 6,
      completedSteps: [0, 1, 2, 3, 4, 5],
    });
  });

  test('shows pickup contact section in both modes', async ({ page }) => {
    await page.goto('/onboarding/launch');
    await expect(
      page.getByText(/Who do we contact on day of pickup/i),
    ).toBeVisible();

    // Toggle to deferred — section should still be visible
    await page.getByText(/I'?m not sure yet/i).first().click();
    await expect(
      page.getByText(/Who do we contact on day of pickup/i),
    ).toBeVisible();
  });

  test('blocks submit when pickup contact is empty (deferred branch)', async ({ page }) => {
    await page.goto('/onboarding/launch');
    await page.getByText(/I'?m not sure yet/i).first().click();
    // Try to submit without filling pickup contact
    await page.locator('form#step-form button[type="submit"]').click();
    // Stays on the same page (validation blocks)
    await expect(page).toHaveURL(/\/onboarding\/launch$/);
  });
});
