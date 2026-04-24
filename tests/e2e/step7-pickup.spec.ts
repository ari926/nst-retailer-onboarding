import { test, expect } from '@playwright/test';
import { seedMockAuth, seedOnboardingState } from './fixtures';

/**
 * Step 7 has two big paths: commit (pick a date now) and deferred
 * (decide later, gets a biweekly nudge loop).
 *
 * The schema-resolver bug fixed in PR #9 (z.enum + empty string from
 * unmounted selects) is the reason this test exists — if it regresses,
 * the deferred submit will silently no-op and this test will catch it.
 */

test.describe('Step 7 — first pickup', () => {
  test.beforeEach(async ({ page }) => {
    await seedMockAuth(page);
    await seedOnboardingState(page, {
      storefrontName: 'Corner Bodega',
      currentStep: 7,
      completedSteps: [0, 1, 2, 3, 4, 5, 6],
    });
    await page.goto('/onboarding/launch');
  });

  test('deferred path: "decide later" submits without crashing', async ({ page }) => {
    // Switch to "I'll confirm later"
    await page.getByLabel(/I'm not sure yet/i).click();
    // Submit. In deferred mode the button copy changes; just click whatever
    // primary submit shows up.
    await page.locator('#step-form button[type="submit"]').first().click();
    // Confirmation copy mentions check-in / reminder / deferred
    await expect(
      page.getByText(/we'll check back|reminder|deferred|every 2 weeks/i),
    ).toBeVisible({ timeout: 10_000 });
  });

  test('rejects a date earlier than the 10-day minimum', async ({ page }) => {
    // 5 days from now should fail validation
    const tooSoon = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000);
    const iso = tooSoon.toISOString().slice(0, 10);
    await page.locator('input[type="date"]').fill(iso);
    // Tab off so onBlur validation runs
    await page.locator('input[type="date"]').blur();
    await page.getByRole('button', { name: /request launch/i }).click();
    // Stays on the form with at least one inline error
    await expect(page.locator('.field-error').first()).toBeVisible({ timeout: 5_000 });
  });
});
