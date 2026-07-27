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
 *
 * Superseded 2026-07-21 by firstMondayAtLeastTenDaysOut() below, since
 * Step 7 now requires Monday-only dates within a timing window. Kept as a
 * comment for historical reference.
 */

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
  owner: {
    name: 'Ari Demo',
    email: 'demo@example.com',
    phone: '2155551234',
  },
  primaryContact: {
    name: 'Ari Demo',
    email: 'demo@example.com',
    phone: '2155551234',
  },
  primaryContactSameAsOwner: true,
  additionalContacts: [
    { name: 'Alex Manager', role: 'general_manager', email: 'alex.gm@example.com', phone: '2155559999' },
  ],
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
  // safeSerial removed 2026-07-26 (Amanda + Doug change set)
  dashboardConnection: '',
  storageMethod: 'under_counter',
  storageMethodOther: '',
  keyHolders: [
    { name: 'Ari Demo', role: 'Owner' },
    { name: 'Pat Demo', role: 'Manager' },
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

// Updated 2026-07-21 per Amanda: Step 4 now uses CIT ticket fields; Step 5
// uses Cash Services unit-based change order.
const demoStep4: Step4Values = {
  bagNumber: 'DEMO-001',
  preparedBy: 'Ari Demo',
  businessDate: new Date().toISOString().split('T')[0],
  verifiedBy: 'Pat Demo',
  registerId: 'REG-01',
  departureDate: new Date().toISOString().split('T')[0],
  shiftNumber: '1',
  totalCurrency: 100,
  totalCoin: 0,
  useCurrencyBreakdown: true,
  useCoinBreakdown: false,
  // 5 twenties = $100 — matches totalCurrency
  currencyBreakdown: { hundred: 0, fifty: 0, twenty: 5, ten: 0, five: 0, one: 0 },
  coinBreakdown: {
    dollarCoins: 0, halfDollars: 0, quarters: 0, dimes: 0, nickels: 0, pennies: 0,
  },
  comments: 'Demo dry-run deposit',
};

// Pick next Wed for the demo change order arrival date.
function nextWednesdayIso(): string {
  const d = new Date();
  const daysToWed = (3 - d.getDay() + 7) % 7 || 7;
  d.setDate(d.getDate() + daysToWed);
  return d.toISOString().split('T')[0];
}
void deliveryDateFiveDaysOut; // kept for reference; new demo uses Wed arrival

const demoStep5: Step5Values = {
  arrivalDate: nextWednesdayIso(),
  units: { ones: 1, fives: 0, tens: 0, twenties: 0, quarters: 1, dimes: 0, nickels: 0 },
  comments: 'Demo change order (1 unit of $1 bills = $100; 1 quarter unit = $500)',
};

const demoStep6: Step6Values = {
  contactName: 'Ari Demo',
  contactEmail: 'demo.billing@example.com',
};

/** Nearest Monday >= 10 calendar days from now — valid for the new Step 7 near-term picker. */
function firstMondayAtLeastTenDaysOut(): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + 10);
  while (d.getDay() !== 1) d.setDate(d.getDate() + 1);
  return d.toISOString().split('T')[0];
}

const demoStep7: Step7Values = {
  deferred: false,
  serviceStartTiming: '0_3mo',
  preferredDate: firstMondayAtLeastTenDaysOut(),
  checkBackCadence: '',
  serviceDays: ['mon', 'wed', 'fri'],
  timeWindow: '',
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
