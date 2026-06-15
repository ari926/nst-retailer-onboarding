/**
 * Email service — sends transactional emails via Resend.
 *
 * Mock mode (VITE_MOCK_AUTH=true): writes to localStorage and pretends
 * to send. A retailer email ending in "@bounce.test" simulates a bounce
 * so we can exercise the failure path in the UI.
 *
 * Real mode: invokes the Supabase Edge Function `send-sample-invoice`
 * (PR #12) which calls Resend and writes the delivery result to the
 * `invoice_samples` table.
 *
 * The Supabase `retailers` table owns the durable invoicing contact;
 * the SFDC Flow templates (in supabase/functions/_shared/email-templates)
 * handle the production weekly invoice cadence — not this app.
 */

import { MOCK_AUTH_ENABLED } from '../hooks/useAuth';
import { supabase } from './supabase';
import { readTokenSession } from './tokenSession';

export interface SampleInvoicePayload {
  sfdcAccountId: string;
  storefrontName: string;
  contactName: string;
  contactEmail: string;
}

export interface SampleInvoiceResult {
  /** Resend message id (mock: `mock-{timestamp}`). */
  messageId: string;
  /** True if the provider accepted the message for delivery. */
  accepted: boolean;
  /** Bounce / block reason if accepted=false. */
  errorReason?: string;
  /** RFC3339 timestamp. */
  sentAt: string;
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
 * Send a sample NST invoice. In mock mode, email addresses ending in
 * "@bounce.test" are rejected; everything else succeeds after 700 ms.
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
        };
    writeMockRow(payload.sfdcAccountId, {
      ...result,
      storefrontName: payload.storefrontName,
      contactName: payload.contactName,
      contactEmail: payload.contactEmail,
    });
    return result;
  }

  // Real path — Supabase Edge Function. Portal users authenticate via the
  // magic-link token (NOT Supabase Auth), so we forward the token from
  // localStorage. The edge function looks up `onboarding_tokens` to resolve
  // the SF account/opportunity/contact ids server-side.
  const session = readTokenSession();
  if (!session) {
    throw new Error('email_failed:missing_portal_token');
  }

  const { data, error } = await supabase.functions.invoke<SampleInvoiceResult>(
    'send-sample-invoice',
    {
      body: {
        token: session.token,
        storefrontName: payload.storefrontName,
        contactName: payload.contactName,
        contactEmail: payload.contactEmail,
      },
    },
  );
  if (error) {
    // Edge Function returns 502 on send failure; functions.invoke
    // surfaces that as an error but still includes the JSON body so we
    // can show the precise reason.
    const detail = (error as unknown as { context?: { errorReason?: string } })
      .context?.errorReason;
    throw new Error(detail ? `email_failed:${detail}` : 'email_failed');
  }
  if (!data) throw new Error('email_failed:empty_response');
  if (!data.accepted) {
    throw new Error(`email_failed:${data.errorReason ?? 'unknown'}`);
  }
  return data;
}

/**
 * Returns the most recent sample invoice attempt for the current
 * retailer, or null if none has been sent yet. Used by Step 6 to show
 * "Last sent: 5 minutes ago" so the retailer doesn't spam the button.
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
