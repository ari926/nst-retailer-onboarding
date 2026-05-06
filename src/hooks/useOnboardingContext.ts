import { useEffect, useState } from 'react';

/**
 * Calls the get-onboarding-context edge function to redeem a kickoff/resume
 * token and pull the SF Account + Contact prefill data we need for the
 * "review what we have on file" Step 1 UI.
 *
 * Returns null while loading. Returns { error } on failure.
 */

const FUNCTIONS_URL =
  import.meta.env.VITE_SUPABASE_URL?.replace(/\/$/, '') ||
  'https://rqmtikbgkplxmmchyujo.supabase.co';

export interface SfAccount {
  Id: string;
  Name: string | null;
  BillingStreet: string | null;
  BillingCity: string | null;
  BillingState: string | null;
  BillingPostalCode: string | null;
  BillingCountry: string | null;
  Phone: string | null;
  Website: string | null;
}

export interface SfContact {
  Id: string;
  FirstName: string | null;
  LastName: string | null;
  Email: string | null;
  Phone: string | null;
  MobilePhone: string | null;
  Title: string | null;
}

export interface OnboardingContext {
  token: {
    sfdc_account_id: string;
    sfdc_opportunity_id: string;
    sfdc_contact_id: string | null;
    recipient_email: string | null;
    recipient_first_name: string | null;
    account_name: string | null;
  };
  onboarding: {
    id: string;
    retailer_email: string;
    retailer_first_name: string | null;
    retailer_last_name: string | null;
    store_name: string | null;
    language: string | null;
    current_step: number | null;
    status: string | null;
  } | null;
  prefill: {
    account: SfAccount | null;
    contact: SfContact | null;
  } | null;
  sf_warning: string | null;
}

interface FetchState {
  loading: boolean;
  data: OnboardingContext | null;
  error: string | null;
}

export function useOnboardingContext(token: string | null) {
  const [state, setState] = useState<FetchState>(() => ({
    loading: !!token,
    data: null,
    error: null,
  }));

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    (async () => {
      try {
        const resp = await fetch(`${FUNCTIONS_URL}/functions/v1/get-onboarding-context`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ token }),
        });
        const json = await resp.json();
        if (cancelled) return;
        if (!resp.ok) {
          setState({ loading: false, data: null, error: json?.error ?? `http_${resp.status}` });
          return;
        }
        setState({ loading: false, data: json as OnboardingContext, error: null });
      } catch (e) {
        if (cancelled) return;
        setState({
          loading: false,
          data: null,
          error: e instanceof Error ? e.message : 'fetch_failed',
        });
      }
    })();
    return () => { cancelled = true; };
  }, [token]);

  return state;
}
