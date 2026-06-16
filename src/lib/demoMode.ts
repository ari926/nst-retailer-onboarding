/**
 * Demo mode — click-through demo without typing or backend writes.
 *
 * Activated by adding `?demo=1` to ANY URL. Persists in sessionStorage so
 * react-router navigations (which drop the query string) stay in demo mode.
 *
 * When demo mode is on:
 *   - loadDraft() returns a pre-filled, schema-valid payload for the step
 *   - saveDraft() and submitStep() become no-ops (no Supabase writes, no HQ webhook fires)
 *   - ProtectedRoute is satisfied via a synthetic mock user (no kickoff token needed)
 *   - A bright yellow banner is shown at the top of every page
 *
 * Demo mode is purely client-side. Refreshing the page on `/onboarding/banking`
 * (without `?demo=1` in the URL) still works because of sessionStorage.
 * To exit demo mode, close the tab or call exitDemoMode().
 */

import type { StepId } from '../types/onboarding';
import type { Step1Values } from '../pages/steps/Step1Profile.schema';
import type { Step2Values } from '../pages/steps/Step2Safe.schema';
import type { Step3Values } from '../pages/steps/Step3Banking.schema';
import type { Step4Values } from '../pages/steps/Step4Deposit.schema';
import type { Step5Values } from '../pages/steps/Step5ChangeOrder.schema';
import type { Step6Values } from '../pages/steps/Step6Invoicing.schema';
import type { Step7Values } from '../pages/steps/Step7FirstPickup.schema';

const DEMO_KEY = 'nst_demo_mode';

/**
 * Check whether demo mode is active. Reads `?demo=1` from URL, persists to
 * sessionStorage, then falls back to sessionStorage on subsequent calls.
 */
export function isDemoMode(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const params = new URLSearchParams(window.location.search);
    if (params.get('demo') === '1') {
      try { sessionStorage.setItem(DEMO_KEY, '1'); } catch { /* ignore */ }
      return true;
    }
    return sessionStorage.getItem(DEMO_KEY) === '1';
  } catch {
    return false;
  }
}

export function exitDemoMode(): void {
  try { sessionStorage.removeItem(DEMO_KEY); } catch { /* ignore */ }
}

/**
 * Build a delivery date that's >= 2 business days out (for Step 5).
 * Padded to 5 days out so the demo is comfortably valid.
 */
function deliveryDateFiveDaysOut(): string {
  const d = new Date();
  d.setDate(d.getDate() + 5);
  return d.toISOString().split('T')[0];
}

/**
 * Build a first-pickup date >= 10 calendar days out (for Step 7).
 * Padded to 14 days for safety.
 */
function firstPickupDateTwoWeeksOut(): string {
  const d = new Date();
  d.setDate(d.getDate() + 14);
  return d.toISOString().split('T')[0];
}

const demoStep1: Step1Values = {
  legalName: 'ZZ TEAM DEMO LLC',
  storefrontName: 'ZZ Team Demo Storefront',
  street: '100 Demo Street',
  suite: 'Suite 200',
  city: 'Philadelphia',
  state: 'PA',
  zip: '19103',
  hours: {
    mon: { closed: false, open: '10:00', close: '18:00' },
    tue: { closed: false, open: '10:00', close: '18:00' },
    wed: { closed: false, open: '10:00', close: '18:00' },
    thu: { closed: false, open: '10:00', close: '18:00' },
    fri: { closed: false, open: '10:00', close: '20:00' },
    sat: { closed: false, open: '11:00', close: '17:00' },
    sun: { closed: true, open: '', close: '' },
  },
  accessNotes: 'Side entrance, ring buzzer marked "Demo".',
  primaryContact: {
    name: 'Ari Demo',
    email: 'demo@example.com',
    phone: '2155551234',
  },
  bohManager: {
    name: 'Pat Demo',
    email: 'pat.demo@example.com',
    phone: '2155555678',
  },
};

const demoStep2: Step2Values = {
  hasSmartSafe: 'no',
  safeMake: '',
  safeModel: '',
  safeSerial: '',
  dashboardConnection: undefined,
  storageMethod: 'under_counter',
  storageMethodOther: '',
  keyHolders: [
    { name: 'Ari Demo', role: 'Owner', location: 'Office desk drawer' },
    { name: 'Pat Demo', role: 'Manager', location: 'Locked cabinet near safe' },
  ],
  provisionalCredit: 'want_to_set',
};

const demoStep3: Step3Values = {
  source: 'manual',
  bankName: 'Demo Federal Bank',
  accountLast4: '9999',
  routingNumber: '021000021',
  signerName: 'Ari Demo',
  matches: true,
  mismatchNotes: '',
};

const demoStep4: Step4Values = {
  amount: 100,
  date: new Date().toISOString().split('T')[0],
  bagNumber: 'DEMO-001',
  // 5 twenties = $100 — matches amount exactly so superRefine passes
  denominations: { hundred: 0, fifty: 0, twenty: 5, ten: 0, five: 0, one: 0 },
  notes: 'Demo dry-run deposit',
};

const demoStep5: Step5Values = {
  deliveryDate: deliveryDateFiveDaysOut(),
  rolls: { quarters: 1, dimes: 0, nickels: 0, pennies: 0 },
  bills: { singles: 0, fives: 0, tens: 0, twenties: 0 },
  notes: 'Demo change order',
};

const demoStep6: Step6Values = {
  contactName: 'Ari Demo',
  contactEmail: 'demo.billing@example.com',
};

const demoStep7: Step7Values = {
  deferred: false,
  preferredDate: firstPickupDateTwoWeeksOut(),
  serviceDays: ['mon', 'wed', 'fri'],
  timeWindow: 'am',
  frequency: 'thrice_weekly',
  driverNotes: 'Demo pickup notes.',
};

/**
 * Return a fully-valid demo payload for the given step.
 * Used by loadDraft when demo mode is on.
 */
export function getDemoPayload<T>(stepId: StepId): T {
  switch (stepId) {
    case 1: return demoStep1 as unknown as T;
    case 2: return demoStep2 as unknown as T;
    case 3: return demoStep3 as unknown as T;
    case 4: return demoStep4 as unknown as T;
    case 5: return demoStep5 as unknown as T;
    case 6: return demoStep6 as unknown as T;
    case 7: return demoStep7 as unknown as T;
    default:
      throw new Error(`Unknown stepId for demo payload: ${stepId}`);
  }
}
