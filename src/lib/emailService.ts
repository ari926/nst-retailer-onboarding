/**
 * Email service — sends transactional emails via Resend.
 *
 * V1: mock implementation that pretends to send and always succeeds.
 * In mock mode, a retailer email ending in "@bounce.test" simulates a
 * bounce so we can exercise the failure path in the UI.
 *
 * Real integration lands in PR #12 — the Supabase Edge Function
 * `send-sample-invoice` calls Resend and writes the delivery result to
 * the `invoice_samples` table.
 *
 * The Supabase `retailers` table owns the durable invoicing contact;
 * the SFDC Flow templates in PR #12 handle the production weekly
 * invoice cadence (not this app).
 */

import { MOCK_AUTH_ENABLED } from '../hooks/useAuth';

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

/**
 * Send a sample NST invoice. In mock mode, email addresses ending in
 * "@bounce.test" are rejected; everything else succeeds after 700 ms.
 */
export async function sendSampleInvoice(
  payload: SampleInvoicePayload,
): Promise<SampleInvoiceResult> {
  if (MOCK_AUTH_ENABLED) {
    await new Promise((r) => setTimeout(r, 700));
    if (payload.contactEmail.toLowerCase().endsWith('@bounce.test')) {
      return {
        messageId: `mock-bounce-${Date.now()}`,
        accepted: false,
        errorReason: 'mailbox_does_not_exist',
        sentAt: new Date().toISOString(),
      };
    }
    return {
      messageId: `mock-${Date.now()}`,
      accepted: true,
      sentAt: new Date().toISOString(),
    };
  }

  // Real path — calls the Supabase Edge Function which wraps Resend.
  // Implemented in PR #12.
  const resp = await fetch('/functions/v1/send-sample-invoice', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!resp.ok) {
    throw new Error(`Failed to send sample invoice: ${resp.status}`);
  }
  return (await resp.json()) as SampleInvoiceResult;
}
