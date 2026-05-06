import { supabase } from './supabase';
import { recordMockSync } from './salesforceService';
import type { StepId } from '../types/onboarding';

/**
 * Generic helpers for reading drafts and writing submissions.
 *
 * Schema reminder (from supabase/migrations/):
 *   step_drafts       — autosaved state per (onboarding_id, step_number). UPSERT.
 *   step_submissions  — finalized data per (onboarding_id, step_number). INSERT.
 *   audit_log         — one row per write for traceability.
 *
 * Token-driven mode (current testing setup): the kickoff token in the URL
 * (`?t=<token>`) is the auth. Reads/writes go through edge functions that
 * resolve the token → onboarding_id and use the service role to bypass RLS.
 * Drafts also mirror to localStorage for instant autosave responsiveness;
 * the server-side upsert happens in the background.
 *
 * Once real Supabase auth is wired (magic link to recipient_email) we can
 * keep the token path as the unauth'd kickoff entry and route already-signed-in
 * retailers through the original `supabase.from(...)` queries.
 */

const FUNCTIONS_URL =
  import.meta.env.VITE_SUPABASE_URL?.replace(/\/$/, '') ||
  'https://rqmtikbgkplxmmchyujo.supabase.co';

const MOCK_AUTH_ENABLED = import.meta.env.VITE_MOCK_AUTH === 'true';
const MOCK_NS = 'nst_mock_step_';

function mockKey(stepId: StepId, kind: 'draft' | 'submission') {
  return `${MOCK_NS}${kind}_${stepId}`;
}

/**
 * Best-effort token reader. We first check the URL (so deep links and
 * back/forward nav stay correct); if the token is present we persist it to
 * sessionStorage so later SPA navigations that drop the query string still
 * find it. React-router navigate('/onboarding/safe') does NOT carry the `?t=`
 * param forward by default, so without this fallback submitStep silently
 * lands on the mock-auth branch and never calls the backend.
 */
const TOKEN_STORAGE_KEY = 'nst_kickoff_token';

function readToken(): string | null {
  if (typeof window === 'undefined') return null;
  const params = new URLSearchParams(window.location.search);
  const fromUrl = params.get('t');
  if (fromUrl && fromUrl.length > 0) {
    try { sessionStorage.setItem(TOKEN_STORAGE_KEY, fromUrl); } catch { /* ignore */ }
    return fromUrl;
  }
  try {
    const stashed = sessionStorage.getItem(TOKEN_STORAGE_KEY);
    if (stashed && stashed.length > 0) return stashed;
  } catch { /* ignore */ }
  return null;
}

async function callSubmitStep(stepNumber: number, kind: 'draft' | 'submit', payload: unknown) {
  const token = readToken();
  if (!token) {
    // No token — we're not in token-kickoff mode. Caller should fall back.
    throw new Error('no_token');
  }
  const resp = await fetch(`${FUNCTIONS_URL}/functions/v1/submit-step`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token, step_number: stepNumber, kind, payload }),
  });
  if (!resp.ok) {
    let detail = `http_${resp.status}`;
    try {
      const j = await resp.json();
      detail = j?.error ?? detail;
    } catch { /* ignore */ }
    throw new Error(detail);
  }
  return await resp.json().catch(() => ({}));
}

export async function saveDraft<T>(stepId: StepId, payload: T): Promise<void> {
  // Always mirror to localStorage for instant restore on page reload.
  if (MOCK_AUTH_ENABLED) {
    try {
      localStorage.setItem(mockKey(stepId, 'draft'), JSON.stringify(payload));
    } catch { /* quota / private mode — ignore */ }
  }

  // Try server-side upsert via token. Fire-and-forget so autosave never
  // blocks the UI on a slow round-trip.
  if (readToken()) {
    void callSubmitStep(stepId, 'draft', payload).catch((e) => {
      console.warn('[stepService] draft upsert failed', e);
    });
    return;
  }

  // Fallback: real-auth path (kept for future).
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return;
  // (Schema notes above flag this as needing migration; not used in token mode.)
}

export async function loadDraft<T>(stepId: StepId): Promise<T | null> {
  if (MOCK_AUTH_ENABLED) {
    const raw = localStorage.getItem(mockKey(stepId, 'draft'));
    if (raw) {
      try { return JSON.parse(raw) as T; } catch { /* fall through */ }
    }
  }
  // (Server-side draft hydration via token is a future enhancement; right
  // now the prefill path covers fresh sessions and localStorage covers reloads.)
  return null;
}

export async function submitStep<T>(stepId: StepId, payload: T): Promise<void> {
  // Token-driven submit (current testing mode). This writes to step_submissions
  // server-side via the edge function and, for step 1, pushes corrections back
  // to Salesforce.
  if (readToken()) {
    await callSubmitStep(stepId, 'submit', payload);

    // Mirror to localStorage so the local stepper UI reflects completion
    // even before the next page load.
    if (MOCK_AUTH_ENABLED) {
      try {
        localStorage.setItem(mockKey(stepId, 'submission'), JSON.stringify({
          payload,
          submitted_at: new Date().toISOString(),
        }));
      } catch { /* ignore */ }
    }
    recordMockSync(stepId);
    return;
  }

  // Fallback: legacy mock-auth path with no token (kept for safety).
  if (MOCK_AUTH_ENABLED) {
    localStorage.setItem(mockKey(stepId, 'submission'), JSON.stringify({
      payload,
      submitted_at: new Date().toISOString(),
    }));
    recordMockSync(stepId);
    return;
  }

  throw new Error('No authenticated session and no kickoff token in URL');
}
