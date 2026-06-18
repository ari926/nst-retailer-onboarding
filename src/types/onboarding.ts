/**
 * Core onboarding domain types (V2 — 6 steps, banking removed).
 * These mirror (loosely) the Supabase schema in supabase/migrations/
 * but live separately from generated DB types in src/types/database.ts.
 */

export type StepId = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export type StepStatus = 'locked' | 'available' | 'in_progress' | 'completed';

export interface StepDefinition {
  id: StepId;
  slug: string;
  titleKey: string;          // i18n key
  path: string;              // route path
}

/**
 * Canonical order and routing for the 6-step onboarding flow.
 * Step 0 is claim/MFA and lives outside the sidebar (pre-flow).
 *
 * V2 changes:
 *   - Removed Step 3 (Banking) entirely.
 *   - Renumbered Steps 4-7 down by one (deposit becomes 3, etc.).
 *   - Slugs are kept stable so existing magic links and bookmarks still resolve;
 *     only the displayed step number and STEPS index changed.
 */
export const STEPS: StepDefinition[] = [
  { id: 1, slug: 'profile',       titleKey: 'nav.step_1_short', path: '/onboarding/profile' },
  { id: 2, slug: 'safe',          titleKey: 'nav.step_2_short', path: '/onboarding/safe' },
  { id: 3, slug: 'deposit',       titleKey: 'nav.step_3_short', path: '/onboarding/deposit' },
  { id: 4, slug: 'change-order',  titleKey: 'nav.step_4_short', path: '/onboarding/change-order' },
  { id: 5, slug: 'invoicing',     titleKey: 'nav.step_5_short', path: '/onboarding/invoicing' },
  { id: 6, slug: 'launch',        titleKey: 'nav.step_6_short', path: '/onboarding/launch' },
];

export const TOTAL_STEPS = STEPS.length;

export interface OnboardingState {
  onboardingId: string | null;
  sfdcAccountId: string | null;
  storefrontName: string | null;
  currentStep: StepId;
  completedSteps: StepId[];
  locked: boolean; // account in "setup mode" — always true until launch is confirmed
}
