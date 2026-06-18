/**
 * Onboarding magic-link token client.
 *
 * Flow:
 *   1. User clicks the link in the kickoff email:
 *        https://ari926.github.io/nst-retailer-onboarding/#/onboarding/start?token=XYZ
 *   2. The /onboarding/start route component calls resolveOnboardingToken(token).
 *   3. We POST to the resolve-onboarding-token edge function which returns:
 *        { ok, prefill: { account, opportunity, primary_contact }, sfdc_account_id, ... }
 *   4. We persist the prefill bundle to localStorage so Step1/Step2/Step3 can
 *      merge it into form defaults when no draft exists yet.
 *   5. We mock-sign-in with the recipient's email + the token's sfdc_account_id
 *      so ProtectedRoute passes and stepService keys drafts under the right
 *      account.
 */

import { mockSignIn } from '../hooks/useAuth';

const RESOLVE_URL =
  (import.meta.env.VITE_SUPABASE_URL as string ||
    'https://rqmtikbgkplxmmchyujo.supabase.co') +
  '/functions/v1/resolve-onboarding-token';

const PREFILL_KEY = 'nst_onboarding_prefill';
const TOKEN_KEY = 'nst_onboarding_token';

export interface PrefillAddress {
  street: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  country: string | null;
}

export interface PrefillAccount {
  sfdc_id: string;
  name: string | null;
  legal_name: string | null;
  account_number: string | null;
  customer_id: string | null;
  phone: string | null;
  website: string | null;
  industry: string | null;
  employee_count: number | null;
  bank_account_last4: string | null;
  hours_of_operation_json: string | null;
  loading_dock_notes: string | null;
  pickup_window: string | null;
  pickup_frequency: string | null;
  store_type: string | null;
  launch_date: string | null;
  onboarding_status: string | null;
  billing_address: PrefillAddress | null;
  shipping_address: PrefillAddress | null;
  owner: {
    sfdc_id: string;
    first_name: string | null;
    last_name: string | null;
    email: string | null;
  } | null;
}

export interface PrefillOpportunity {
  sfdc_id: string;
  name: string | null;
  stage: string | null;
  amount: number | null;
  close_date: string | null;
  owner: {
    sfdc_id: string;
    first_name: string | null;
    last_name: string | null;
    email: string | null;
  } | null;
}

export interface PrefillContact {
  sfdc_id: string;
  first_name: string | null;
  last_name: string | null;
  full_name: string | null;
  email: string | null;
  phone: string | null;
  title: string | null;
}

export interface PrefillBundle {
  account: PrefillAccount | null;
  opportunity: PrefillOpportunity | null;
  primary_contact: PrefillContact | null;
  _resolved_at?: string;
  _sfdc_error?: string;
}

export interface ResolveResponse {
  ok: boolean;
  prefill: PrefillBundle | null;
  sfdc_account_id: string | null;
  sfdc_opportunity_id: string | null;
  session: { access_token: string; expires_in: number } | null;
  error?: string;
}

/**
 * Call the resolve-onboarding-token edge function and persist the prefill
 * bundle to localStorage. Throws on network or token-invalid errors.
 */
export async function resolveOnboardingToken(token: string): Promise<ResolveResponse> {
  const resp = await fetch(RESOLVE_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
  });

  // resolve-onboarding-token deploys with verify_jwt=false, so no Auth header needed.
  let body: ResolveResponse | { error: string };
  try {
    body = (await resp.json()) as ResolveResponse;
  } catch {
    throw new Error(`resolve token: ${resp.status} (non-JSON response)`);
  }

  if (!resp.ok || !('ok' in body) || !body.ok) {
    const msg =
      'error' in body && body.error
        ? body.error
        : `resolve token failed (${resp.status})`;
    throw new Error(msg);
  }

  // Persist for downstream steps.
  const enriched: PrefillBundle = {
    ...(body.prefill ?? { account: null, opportunity: null, primary_contact: null }),
    _resolved_at: new Date().toISOString(),
  };
  localStorage.setItem(PREFILL_KEY, JSON.stringify(enriched));
  localStorage.setItem(TOKEN_KEY, token);

  return body;
}

/**
 * Read the cached prefill bundle from localStorage.
 * Returns null if no token has been resolved yet.
 */
export function getPrefill(): PrefillBundle | null {
  try {
    const raw = localStorage.getItem(PREFILL_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as PrefillBundle;
  } catch {
    return null;
  }
}

/**
 * Clear the cached prefill — used on sign-out.
 */
export function clearPrefill(): void {
  localStorage.removeItem(PREFILL_KEY);
  localStorage.removeItem(TOKEN_KEY);
}

/**
 * Sign the recipient in via the existing mock-auth path so the rest of the
 * onboarding app (ProtectedRoute, stepService draft keying) keeps working
 * without a full Supabase auth integration.
 *
 * Uses the contact's email + the account's SFDC id from the token bundle.
 */
export function signInFromPrefill(prefill: PrefillBundle, sfdcAccountId: string): void {
  const email =
    prefill.primary_contact?.email ||
    prefill.account?.owner?.email ||
    'retailer@nst-onboarding';
  mockSignIn(email, sfdcAccountId);
}
