import { test, expect } from '@playwright/test';
import { seedMockAuth, seedOnboardingState } from './fixtures';

/**
 * Step 6 has the most branching of any step: happy send, opt-out skip,
 * bounce + retry, and "last sent N mins ago" line. Cover all four.
 */

test.describe('Step 6 — sample invoice', () => {
  test.beforeEach(async ({ page }) => {
    await seedMockAuth(page);
    await seedOnboardingState(page, {
      storefrontName: 'Corner Bodega',
      currentStep: 6,
      completedSteps: [0, 1, 2, 3, 4, 5],
    });
    await page.goto('/onboarding/invoicing');
  });

  test('sends a sample invoice on happy path', async ({ page }) => {
    await page.getByLabel(/billing contact name/i).fill('Maria Lopez');
    await page.getByLabel(/billing email/i).fill('maria@cornerbodega.com');
    // Checkbox is on by default
    await page.getByRole('button', { name: /confirm and send sample/i }).click();
    // Confirmation page — "I got the sample" CTA
    await expect(page.getByText(/sample invoice on the way to maria@cornerbodega\.com/i)).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole('button', { name: /i got the sample/i })).toBeVisible();
  });

  test('shows bounce banner when email ends in @bounce.test', async ({ page }) => {
    await page.getByLabel(/billing contact name/i).fill('Maria');
    await page.getByLabel(/billing email/i).fill('maria@bounce.test');
    await page.getByRole('button', { name: /confirm and send sample/i }).click();
    // Form stays editable and we get a bounce callout. The text appears
    // in both the inline alert and the toast — match the first.
    await expect(page.getByText(/your email bounced/i).first()).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/mailbox_does_not_exist/)).toBeVisible();
    // The form is still there
    await expect(page.getByLabel(/billing email/i)).toBeVisible();
  });

  test('opt-out path skips the send and advances', async ({ page }) => {
    await page.getByLabel(/billing contact name/i).fill('Maria');
    await page.getByLabel(/billing email/i).fill('maria@cornerbodega.com');
    // Uncheck "Email me a sample invoice now"
    await page.getByRole('checkbox', { name: /email me a sample invoice now/i }).uncheck();
    await page.getByRole('button', { name: /confirm and send sample/i }).click();
    // Should jump straight to /onboarding/launch
    await expect(page).toHaveURL(/onboarding\/launch/, { timeout: 10_000 });
  });

  test('"last sent" line appears after a previous send', async ({ page }) => {
    // Seed a prior successful send 8 minutes ago
    await page.evaluate(() => {
      const sentAt = new Date(Date.now() - 8 * 60_000).toISOString();
      localStorage.setItem(
        'nst_mock_invoice_samples',
        JSON.stringify({
          'SFDC-MOCK-001': [
            {
              messageId: 'mock-prev',
              accepted: true,
              sentAt,
              storefrontName: 'Corner Bodega',
              contactName: 'Maria',
              contactEmail: 'maria@cornerbodega.com',
            },
          ],
        }),
      );
    });
    await page.reload();
    await expect(page.locator('.sample-callout__last')).toContainText(/last sample sent/i);
    await expect(page.locator('.sample-callout__last')).toContainText(/8 mins ago/);
  });
});
