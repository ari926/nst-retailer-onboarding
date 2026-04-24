import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright config — full E2E coverage (PR #13).
 *
 * Strategy:
 *   - Run against the production build (`vite preview` on :4173) so the
 *     tests catch any prod-only issues (env vars, code splitting, etc).
 *   - Mock-auth mode is forced on — every spec seeds its own state via
 *     `seedMockAuth` / `seedOnboardingState` helpers in fixtures.ts.
 *   - One global setup project builds the app once before running the
 *     suite; the dev server is not used.
 */
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: [['list'], ['html', { open: 'never' }]],
  timeout: 30_000,
  expect: { timeout: 5_000 },
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:4173',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'mobile',
      use: { ...devices['Pixel 7'] },
      grep: /@mobile/,
    },
  ],
  webServer: {
    // Build first, then preview. Build is a no-op if dist/ is fresh.
    command: 'npm run build && npm run preview -- --port 4173 --host 0.0.0.0',
    url: 'http://localhost:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    env: {
      VITE_MOCK_AUTH: 'true',
    },
  },
});
