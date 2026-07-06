/**
 * Reset all persisted onboarding client state.
 *
 * The portal mirrors a lot of state into localStorage for autosave, offline
 * responsiveness, and mock-auth demos:
 *   - `nst_onboarding_state` (Zustand persist for the store)
 *   - `nst_mock_step_draft_{stepId}` (autosaved form drafts)
 *   - `nst_mock_step_submission_{stepId}` (client-mirrored submissions)
 *   - `nst_mock_sf_sync_status` (per-onboarding SF sync map)
 *   - `nst_mock_invoice_samples` (email service mock)
 *   - `nst_kickoff_token` (sessionStorage token cache)
 *
 * When an admin hops between customers, or the resolved token points at a
 * different SF Account than what's cached, we need to purge all of the above
 * so Customer B doesn't inherit Customer A's completedSteps, address draft,
 * or storefront name.
 *
 * This is a UI-layer safety net only — real truth lives in Supabase
 * (step_submissions, step_drafts) and Salesforce.
 */
export function resetOnboardingClientState() {
  try {
    // Zustand persist store
    localStorage.removeItem('nst_onboarding_state');

    // Mock-namespace draft/submission entries. Iterate defensively because
    // step ids are 0..7 and future steps could be added.
    const keysToRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (!key) continue;
      if (
        key.startsWith('nst_mock_step_') ||
        key === 'nst_mock_sf_sync_status' ||
        key === 'nst_mock_invoice_samples'
      ) {
        keysToRemove.push(key);
      }
    }
    keysToRemove.forEach((k) => localStorage.removeItem(k));

    // Token session cache (URL is source of truth; drop the sessionStorage
    // mirror so a new token isn't shadowed by a stale one).
    sessionStorage.removeItem('nst_kickoff_token');
  } catch (err) {
    // localStorage may throw in private-mode Safari or when disk is full.
    // Best-effort — swallow so we don't block the resolve flow.
    // eslint-disable-next-line no-console
    console.warn('[resetOnboardingClientState] failed to clear storage', err);
  }
}
