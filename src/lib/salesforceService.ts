import { supabase } from './supabase';
import type { StepId } from '../types/onboarding';

/**
 * Client-side Salesforce sync status helpers.
 *
 * The actual push to Salesforce happens server-side:
 *   step_submissions INSERT → trigger enqueue_sf_sync() → sf_sync_queue →
 *   Edge Function sf-sync (pg_cron every 60s) → SF Apex REST.
 *
 * This module exposes:
 *   - getSyncStatus(accountId) — what the UI shows in the activation panel
 *   - recordMockSync(stepId, payload) — in mock-auth mode, simulate the queue
 *     so demos can show "Synced with Salesforce" without real SFDC creds.
 */

const MOCK_AUTH_ENABLED = import.meta.env.VITE_MOCK_AUTH === 'true';
const MOCK_SYNC_KEY = 'nst_mock_sf_sync_status';

export type SyncState = 'pending' | 'running' | 'succeeded' | 'failed' | 'dead';

export interface StepSyncRow {
  step_id: StepId;
  sync_status: SyncState;
  sf_object_id: string | null;
  last_error: string | null;
  attempts: number;
}

export interface SfSyncSummary {
  rows: StepSyncRow[];
  /** All 7 flow steps have sync_status='succeeded' */
  allSynced: boolean;
  /** Any row in failed or dead state */
  hasFailures: boolean;
  /** True when at least one row is still in pending/running */
  inProgress: boolean;
}

/** Mock-mode: immediately mark a step as "succeeded" and store a fake SF id. */
export function recordMockSync(stepId: StepId): void {
  if (!MOCK_AUTH_ENABLED) return;
  const raw = localStorage.getItem(MOCK_SYNC_KEY);
  const map: Record<string, StepSyncRow> = raw ? JSON.parse(raw) : {};
  // Fake SF id — mirrors the 18-char SF object id shape (prefixed with
  // "a00" for custom objects in demo mode).
  const fakeId = 'a00' + Math.random().toString(36).slice(2, 17).toUpperCase();
  map[String(stepId)] = {
    step_id: stepId,
    sync_status: 'succeeded',
    sf_object_id: fakeId,
    last_error: null,
    attempts: 1,
  };
  localStorage.setItem(MOCK_SYNC_KEY, JSON.stringify(map));
}

function summarize(rows: StepSyncRow[]): SfSyncSummary {
  // Only flow steps (1..7) count toward allSynced.
  const flowSteps = [1, 2, 3, 4, 5, 6, 7] as const;
  const byStep = new Map(rows.map((r) => [r.step_id, r]));
  const flowRows = flowSteps
    .map((s) => byStep.get(s as StepId))
    .filter((r): r is StepSyncRow => !!r);

  const allSynced =
    flowRows.length === flowSteps.length &&
    flowRows.every((r) => r.sync_status === 'succeeded');
  const hasFailures = rows.some(
    (r) => r.sync_status === 'failed' || r.sync_status === 'dead',
  );
  const inProgress = rows.some(
    (r) => r.sync_status === 'pending' || r.sync_status === 'running',
  );
  return { rows, allSynced, hasFailures, inProgress };
}

/** Fetches the current sync status for the signed-in retailer. */
export async function getSyncStatus(
  accountId: string | null,
): Promise<SfSyncSummary> {
  if (!accountId) {
    return { rows: [], allSynced: false, hasFailures: false, inProgress: false };
  }

  if (MOCK_AUTH_ENABLED) {
    const raw = localStorage.getItem(MOCK_SYNC_KEY);
    const map: Record<string, StepSyncRow> = raw ? JSON.parse(raw) : {};
    return summarize(Object.values(map));
  }

  const { data, error } = await supabase.rpc('sf_sync_status_summary', {
    p_account_id: accountId,
  });
  if (error) throw error;
  return summarize((data ?? []) as StepSyncRow[]);
}

/**
 * One-shot helper: poll the sync status until all steps are succeeded or a
 * timeout / failure is hit. Used on the activation panel to show live status.
 */
export async function pollSyncUntilReady(
  accountId: string | null,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<SfSyncSummary> {
  const deadline = Date.now() + (opts.timeoutMs ?? 30_000);
  const interval = opts.intervalMs ?? 2_000;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const summary = await getSyncStatus(accountId);
    if (summary.allSynced || summary.hasFailures) return summary;
    if (Date.now() > deadline) return summary;
    await new Promise((r) => setTimeout(r, interval));
  }
}
