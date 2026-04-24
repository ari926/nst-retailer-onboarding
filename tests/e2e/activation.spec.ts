import { test, expect } from '@playwright/test';
import { seedFullyOnboarded, setLanguage } from './fixtures';

/**
 * Activation panel — what the retailer sees after all 7 steps. Covers:
 *   - "Nice — you're ready to launch" headline
 *   - Salesforce sync indicator (synced state)
 *   - Ops summary PDF download triggers a file
 *   - ES translation
 */

test.describe('Activation panel', () => {
  test('shows synced state and download CTA', async ({ page }) => {
    await seedFullyOnboarded(page);
    await page.goto('/onboarding');
    await expect(page.getByRole('heading', { name: /you're ready to launch/i })).toBeVisible();
    await expect(page.getByText(/all 7 steps submitted/i)).toBeVisible();
    // Sync indicator (--ok variant)
    await expect(page.locator('.sync-indicator--ok')).toBeVisible({ timeout: 6_000 });
    await expect(page.getByText(/synced with NST operations/i)).toBeVisible();
  });

  test('Download ops summary triggers a PDF download', async ({ page }) => {
    await seedFullyOnboarded(page);
    await page.goto('/onboarding');
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 15_000 }),
      page.getByRole('button', { name: /download ops summary/i }).click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/^nst-ops-handoff-.+\.pdf$/);
  });

  test('renders correctly in Spanish', async ({ page }) => {
    await seedFullyOnboarded(page);
    await setLanguage(page, 'es');
    await page.goto('/onboarding');
    await expect(page.getByRole('heading', { name: /listo.*ya puedes lanzar/i })).toBeVisible();
    await expect(page.getByText(/los 7 pasos enviados/i)).toBeVisible();
    await expect(page.getByText(/sincronizado con operaciones/i)).toBeVisible();
  });
});
