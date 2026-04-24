import { test, expect } from '@playwright/test';

test.describe('Home (unauthenticated)', () => {
  test('shows the NST landing page with claim CTA', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: /NST Retailer Onboarding/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /claim your account/i })).toBeVisible();
    await expect(page.getByRole('link', { name: /preview the flow/i })).toBeVisible();
  });

  test('language toggle switches between EN and ES @mobile', async ({ page }) => {
    await page.goto('/');
    // Default is EN — claim CTA reads "Claim your account"
    await expect(page.getByRole('button', { name: /claim your account/i })).toBeVisible();
    // Click ES toggle
    await page.getByRole('button', { name: /^ES$/ }).click();
    await expect(page.getByRole('button', { name: /activar mi cuenta/i })).toBeVisible();
    // Persists across reload
    await page.reload();
    await expect(page.getByRole('button', { name: /activar mi cuenta/i })).toBeVisible();
  });
});
