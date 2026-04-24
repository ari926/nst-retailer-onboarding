import { supabase } from './supabase';
import { recordMockSync } from './salesforceService';
import { trackEvent } from './analytics';
import type { StepId } from '../types/onboarding';

/**
 * Generic helpers for reading drafts and writing submissions.
 *
 * Schema reminder (from supabase/migrations/):
 *   step_drafts       — autosaved state per (sfdc_account_id, step_id). UPSERT.
 *   step_submissions  — finalized data per (sfdc_account_id, step_id). INSERT.
 *   audit_log         — one row per write for traceability.
 *
 * In mock-auth mode we bypass Supabase entirely and use localStorage so the
 * flow is demoable without real RLS / JWT. PR #11 will remove this fallback
 * once SFDC seeds accounts and real auth JWTs are in play.
 */

const MOCK_AUTH_ENABLED = import.meta.env.VITE_MOCK_AUTH === 'true';
const MOCK_NS = 'nst_mock_step_';

function mockKey(stepId: StepId, kind: 'draft' | 'submission') {
  return `${MOCK_NS}${kind}_${stepId}`;
}

export async function saveDraft<T>(stepId: StepId, payload: T): Promise<void> {
  if (MOCK_AUTH_ENABLED) {
    localStorage.setItem(mockKey(stepId, 'draft'), JSON.stringify(payload));
    return;
  }

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error('No authenticated user');
  const sfdcAccountId = (user.user_metadata?.sfdc_account_id as string) || null;

  const { error } = await supabase.from('step_drafts').upsert(
    {
      sfdc_account_id: sfdcAccountId,
      step_id: stepId,
      payload,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'sfdc_account_id,step_id' },
  );
  if (error) throw error;
}

export async function loadDraft<T>(stepId: StepId): Promise<T | null> {
  if (MOCK_AUTH_ENABLED) {
    const raw = localStorage.getItem(mockKey(stepId, 'draft'));
    if (!raw) return null;
    try { return JSON.parse(raw) as T; } catch { return null; }
  }

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const sfdcAccountId = (user.user_metadata?.sfdc_account_id as string) || null;

  const { data, error } = await supabase
    .from('step_drafts')
    .select('payload')
    .eq('sfdc_account_id', sfdcAccountId)
    .eq('step_id', stepId)
    .maybeSingle();
  if (error) throw error;
  return (data?.payload as T) ?? null;
}

export async function submitStep<T>(stepId: StepId, payload: T): Promise<void> {
  trackEvent('step.submitted', { stepId });

  if (MOCK_AUTH_ENABLED) {
    localStorage.setItem(mockKey(stepId, 'submission'), JSON.stringify({
      payload,
      submitted_at: new Date().toISOString(),
    }));
    // Simulate the async Salesforce sync happening in the background.
    // Real mode: the DB trigger enqueues sf_sync_queue and the Edge Function
    // drains it. Mock mode stamps success immediately for demo continuity.
    recordMockSync(stepId);
    return;
  }

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error('No authenticated user');
  const sfdcAccountId = (user.user_metadata?.sfdc_account_id as string) || null;

  const { error } = await supabase.from('step_submissions').insert({
    sfdc_account_id: sfdcAccountId,
    step_id: stepId,
    payload,
    submitted_at: new Date().toISOString(),
  });
  if (error) throw error;

  // Fire-and-forget audit entry. Not blocking.
  void supabase.from('audit_log').insert({
    sfdc_account_id: sfdcAccountId,
    actor_type: 'retailer',
    action: `step_${stepId}_submitted`,
    metadata: { step_id: stepId },
  });
}
