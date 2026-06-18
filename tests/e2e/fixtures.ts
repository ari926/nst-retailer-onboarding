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
 * Seeds the mock-auth user via addInitScript so the value is in
 * localStorage BEFORE any app JS runs. The shape mirrors what
 * src/hooks/useAuth.ts hydrates from MOCK_KEY — including
 * user_metadata, which downstream code (stepService, sidebar) reads.
 *
 * Call this in beforeEach BEFORE the first page.goto().
 */
export async function seedMockAuth(
  page: Page,
  user: Partial<MockUser> = {},
): Promise<void> {
  const merged = { ...DEFAULT_USER, ...user };
  await page.addInitScript((u) => {
    localStorage.setItem(
      'nst_mock_user',
      JSON.stringify({
        id: u.id,
        email: u.email,
        _mock: true,
        user_metadata: {
          sfdc_account_id: u.sfdcAccountId,
          first_name: u.firstName,
        },
      }),
    );
  }, merged);
}

export async function seedOnboardingState(
  page: Page,
  seed: OnboardingSeed,
  user: MockUser = DEFAULT_USER,
): Promise<void> {
  // Use addInitScript so the persisted store is present before zustand
  // hydrates on first render.
  await page.addInitScript(
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
          // Matches src/stores/onboardingStore.ts persist version.
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
      // V2: 6 flow steps (0..6 in completedSteps; currentStep advances to 6).
      currentStep: 6,
      completedSteps: [0, 1, 2, 3, 4, 5, 6],
      locked: true,
    },
    user,
  );
  // Seed Salesforce sync as all-succeeded so the indicator shows green.
  await page.addInitScript(() => {
    const map: Record<string, unknown> = {};
    for (let i = 1; i <= 6; i++) {
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
  await page.addInitScript((l) => localStorage.setItem('nst_lang', l), lang);
}
