/**
 * Email service — sample invoice send.
 *
 * The sample-invoice send is fully owned by HQ as of June 2026.
 * Portal calls HQ's `hq-send-sample-invoice` edge function with the
 * onboarding id + magic-link token, and HQ does everything:
 *   - resolves the token
 *   - loads customer info from the HQ customers table
 *   - fetches the static sample PDF from HQ storage
 *   - renders the email body
 *   - sends via HQ Gmail OAuth
 *   - writes the Salesforce Task on the Opportunity
 *   - audits to HQ `sample_invoice_sends`
 *
 * Mock mode (VITE_MOCK_AUTH=true) still simulates a local send so the UI
 * can be exercised without hitting HQ.
 *
 * The legacy portal-side `send-sample-invoice` edge function is being
 * deprecated; once this PR ships and is stable we'll delete it.
 */

import { MOCK_AUTH_ENABLED } from '../hooks/useAuth';
import { supabase } from './supabase';
import { readTokenSession } from './tokenSession';

const HQ_FUNCTIONS_BASE =
  import.meta.env.VITE_HQ_FUNCTIONS_BASE ??
  'https://ygcpcefwtrcdutrjkfik.supabase.co/functions/v1';

export interface SampleInvoicePayload {
  sfdcAccountId: string;
  storefrontName: string;
  contactName: string;
  contactEmail: string;
  /** Portal retailer_onboardings.id — required for the real HQ path. */
  onboardingId?: string | null;
}

export interface SampleInvoiceResult {
  /** Gmail messageId (mock: `mock-{timestamp}`). */
  messageId: string;
  /** True if HQ accepted the send and Gmail returned an id. */
  accepted: boolean;
  /** Failure reason if accepted=false. */
  errorReason?: string;
  /** RFC3339 timestamp. */
  sentAt: string;
  /** HQ-generated sample invoice number, e.g. NST-SAMPLE-6QP5TX. */
  sampleNumber?: string;
}

const MOCK_KEY = 'nst_mock_invoice_samples';

interface MockRow extends SampleInvoiceResult {
  storefrontName: string;
  contactName: string;
  contactEmail: string;
}

function readMockRows(): Record<string, MockRow[]> {
  const raw = localStorage.getItem(MOCK_KEY);
  return raw ? (JSON.parse(raw) as Record<string, MockRow[]>) : {};
}

function writeMockRow(sfdcAccountId: string, row: MockRow): void {
  const all = readMockRows();
  const list = all[sfdcAccountId] ?? [];
  list.unshift(row);
  all[sfdcAccountId] = list.slice(0, 10); // keep last 10
  localStorage.setItem(MOCK_KEY, JSON.stringify(all));
}

/**
 * Send a sample NST invoice via HQ.
 *
 * In mock mode, email addresses ending in "@bounce.test" are rejected;
 * everything else succeeds after 700 ms.
 *
 * In real mode, POSTs `{onboardingId, token}` to HQ's
 * `hq-send-sample-invoice` and returns the HQ response shape, normalised
 * to {messageId, accepted, sentAt, sampleNumber}.
 */
export async function sendSampleInvoice(
  payload: SampleInvoicePayload,
): Promise<SampleInvoiceResult> {
  if (MOCK_AUTH_ENABLED) {
    await new Promise((r) => setTimeout(r, 700));
    const sentAt = new Date().toISOString();
    const isBounce = payload.contactEmail.toLowerCase().endsWith('@bounce.test');
    const result: SampleInvoiceResult = isBounce
      ? {
          messageId: `mock-bounce-${Date.now()}`,
          accepted: false,
          errorReason: 'mailbox_does_not_exist',
          sentAt,
        }
      : {
          messageId: `mock-${Date.now()}`,
          accepted: true,
          sentAt,
          sampleNumber: `NST-SAMPLE-MOCK${Date.now().toString(36).slice(-4).toUpperCase()}`,
        };
    writeMockRow(payload.sfdcAccountId, {
      ...result,
      storefrontName: payload.storefrontName,
      contactName: payload.contactName,
      contactEmail: payload.contactEmail,
    });
    return result;
  }

  // Real path — HQ owns this. Portal only forwards the token + onboarding id.
  const session = readTokenSession();
  if (!session?.token) {
    throw new Error('email_failed:missing_portal_token');
  }
  if (!payload.onboardingId) {
    throw new Error('email_failed:missing_onboarding_id');
  }

  let res: Response;
  try {
    res = await fetch(`${HQ_FUNCTIONS_BASE}/hq-send-sample-invoice`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        onboardingId: payload.onboardingId,
        token: session.token,
      }),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'network_error';
    throw new Error(`email_failed:${msg}`);
  }

  let body: {
    ok?: boolean;
    error?: string;
    sampleNumber?: string;
    messageId?: string;
    sentAt?: string;
  } = {};
  try {
    body = (await res.json()) as typeof body;
  } catch {
    throw new Error(`email_failed:hq_bad_json_${res.status}`);
  }

  if (!res.ok || !body.ok) {
    const reason = body.error ?? `hq_${res.status}`;
    throw new Error(`email_failed:${reason}`);
  }

  return {
    messageId: body.messageId ?? '',
    accepted: true,
    sentAt: body.sentAt ?? new Date().toISOString(),
    sampleNumber: body.sampleNumber,
  };
}

/**
 * Returns the most recent sample invoice attempt for the current
 * retailer, or null if none has been sent yet. Used by Step 6 to show
 * "Last sent: 5 minutes ago" so the retailer doesn't spam the button.
 *
 * Still reads from the portal `v_latest_invoice_sample` view for now —
 * the legacy portal-side audit row is written during the migration
 * window. Once we cut over fully, this will read from an HQ-backed
 * endpoint instead.
 */
export async function getLatestSampleInvoice(
  sfdcAccountId: string,
): Promise<SampleInvoiceResult | null> {
  if (MOCK_AUTH_ENABLED) {
    const rows = readMockRows()[sfdcAccountId] ?? [];
    return rows[0] ?? null;
  }

  const { data, error } = await supabase
    .from('v_latest_invoice_sample')
    .select('contact_email, accepted, error_reason, sent_at, resend_id')
    .eq('sfdc_account_id', sfdcAccountId)
    .maybeSingle();
  if (error) {
    console.warn('[emailService] getLatestSampleInvoice failed', error);
    return null;
  }
  if (!data) return null;
  return {
    messageId: data.resend_id ?? '',
    accepted: !!data.accepted,
    errorReason: data.error_reason ?? undefined,
    sentAt: data.sent_at,
  };
}
