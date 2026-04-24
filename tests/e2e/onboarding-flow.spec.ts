import { test, expect } from '@playwright/test';
import { seedMockAuth, seedOnboardingState } from './fixtures';

/**
 * High-value structural checks across the seven-step flow:
 *   - Progress bar percentage matches completed-step count
 *   - Locked future steps cannot be navigated to
 *
 * Per-step submission tests are covered in their dedicated specs
 * (step6-invoicing.spec.ts, step7-pickup.spec.ts).
 */

test.describe('Onboarding flow — structure', () => {
  test.beforeEach(async ({ page }) => {
    await seedMockAuth(page);
  });

  test('progress bar advances correctly as steps complete', async ({ page }) => {
    // 0/7 done
    await seedOnboardingState(page, {
      storefrontName: 'Corner Bodega',
      currentStep: 1,
      completedSteps: [0],
    });
    await page.goto('/onboarding');
    await expect(page.locator('.progress__label')).toContainText(/0% to launch/);

    // 3/7 done
    await seedOnboardingState(page, {
      storefrontName: 'Corner Bodega',
      currentStep: 4,
      completedSteps: [0, 1, 2, 3],
    });
    await page.goto('/onboarding');
    await expect(page.locator('.progress__label')).toContainText(/43% to launch/);

    // 7/7 done
    await seedOnboardingState(page, {
      storefrontName: 'Corner Bodega',
      currentStep: 7,
      completedSteps: [0, 1, 2, 3, 4, 5, 6, 7],
    });
    await page.goto('/onboarding');
    await expect(page.locator('.progress__label')).toContainText(/100% to launch/);
  });

  test('locked sidebar items are not clickable', async ({ page }) => {
    await seedOnboardingState(page, {
      storefrontName: 'Corner Bodega',
      currentStep: 3,
      completedSteps: [0, 1, 2],
    });
    await page.goto('/onboarding/banking');
    // Step 7 should be locked because we haven't reached it yet.
    const step7 = page.locator('.step-item__link', { hasText: 'First pickup' });
    await expect(step7).toHaveAttribute('aria-disabled', 'true');
  });
});
