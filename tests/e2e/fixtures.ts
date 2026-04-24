import type { Page } from '@playwright/test';

/**
 * Test fixtures for the NST onboarding E2E suite.
 *
 * Every spec starts from a clean localStorage and seeds exactly the
 * keys it needs. We never share state between specs because Playwright
 * runs them in parallel by default.
 *
 * The keys here mirror what the app reads at runtime — keep them in
 * sync with src/hooks/useAuth.ts and src/stores/onboardingStore.ts.
 */

export interface MockUser {
  id: string;
  email: string;
  sfdcAccountId: string;
  firstName?: string;
}

export interface OnboardingSeed {
  storefrontName: string;
  /** 1..7 */
  currentStep: number;
  /** 0..7 */
  completedSteps: number[];
  locked?: boolean;
}

export const DEFAULT_USER: MockUser = {
  id: 'mock-user-1',
  email: 'ari@talaria.com',
  sfdcAccountId: 'SFDC-MOCK-001',
  firstName: 'Ari',
};

/**
 * Seeds the mock-auth user before any page navigation. Call this once
 * per test in beforeEach (or use the higher-level `seedFullyOnboarded`).
 */
export async function seedMockAuth(
  page: Page,
  user: Partial<MockUser> = {},
): Promise<void> {
  const merged = { ...DEFAULT_USER, ...user };
  // We need a page context to call evaluate — visit the root first.
  await page.goto('/');
  await page.evaluate((u) => {
    localStorage.setItem(
      'nst_mock_user',
      JSON.stringify({
        id: u.id,
        email: u.email,
        sfdc_account_id: u.sfdcAccountId,
        first_name: u.firstName,
      }),
    );
  }, merged);
}

export async function seedOnboardingState(
  page: Page,
  seed: OnboardingSeed,
  user: MockUser = DEFAULT_USER,
): Promise<void> {
  await page.evaluate(
    ({ s, u }) => {
      localStorage.setItem(
        'nst_onboarding_state',
        JSON.stringify({
          state: {
            onboardingId: 'ob-1',
            sfdcAccountId: u.sfdcAccountId,
            storefrontName: s.storefrontName,
            currentStep: s.currentStep,
            completedSteps: s.completedSteps,
            locked: !!s.locked,
          },
          version: 1,
        }),
      );
      // Seed step submissions for any completed flow step so the
      // store thinks we have data on disk.
      for (const id of s.completedSteps) {
        if (id === 0) continue;
        localStorage.setItem(
          `nst_mock_step_submission_${id}`,
          JSON.stringify({
            payload: { ok: true },
            submitted_at: new Date().toISOString(),
          }),
        );
      }
    },
    { s: seed, u: user },
  );
}

/** Convenience: drop the user straight onto the activation panel. */
export async function seedFullyOnboarded(
  page: Page,
  user: MockUser = DEFAULT_USER,
): Promise<void> {
  await seedMockAuth(page, user);
  await seedOnboardingState(
    page,
    {
      storefrontName: 'Corner Bodega',
      currentStep: 7,
      completedSteps: [0, 1, 2, 3, 4, 5, 6, 7],
      locked: true,
    },
    user,
  );
  // Seed Salesforce sync as all-succeeded so the indicator shows green.
  await page.evaluate(() => {
    const map: Record<string, unknown> = {};
    for (let i = 1; i <= 7; i++) {
      map[i] = {
        step_id: i,
        sync_status: 'succeeded',
        sf_object_id: `a00MOCK${i}XYZ`,
        last_error: null,
        attempts: 1,
      };
    }
    localStorage.setItem('nst_mock_sf_sync_status', JSON.stringify(map));
  });
}

/**
 * Force a specific UI language. Note this writes to `nst_lang`, not
 * `i18nextLng` — see the persistent-store key map in CONTEXT.md.
 */
export async function setLanguage(
  page: Page,
  lang: 'en' | 'es',
): Promise<void> {
  await page.evaluate((l) => localStorage.setItem('nst_lang', l), lang);
}
