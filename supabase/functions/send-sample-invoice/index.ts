// supabase/functions/send-sample-invoice/index.ts
//
// v14 (2026-06-14): All customer email now sends from HQ (awesome-agent-logic)
// via Gmail (onboarding@nationalsecuretransport.com). This function still
// renders the sample invoice HTML and does the bank-on-file lookup, then
// hands off to HQ via the HMAC-signed portal-progress-webhook with event
// 'sample_invoice_requested'. HQ owns delivery + activity logging.
//
// Removed (vs v13): SF EmailTemplate PATCH, emailSimple call, EmailMessage
// mirror — all of that now lives behind a single HQ function. Kept: contact
// lookup (so HQ knows which Contact to log the Task against), bank-on-file
// merge, audit row.
//
// Per-send mechanics:
//   1) Auth to SF for read-only lookups (Opp resolution, bank-on-file, Contact).
//   2) Render the invoice HTML locally.
//   3) POST event=sample_invoice_requested to HQ portal-progress-webhook with
//      HMAC signature; include subject, rendered HTML, recipient, SF ids.
//   4) Write an invoice_samples audit row; status reflects the HQ POST.
//
// Auth model: invoked from the browser with the user's JWT. We pull
// sfdc_account_id from the JWT claims rather than trusting the client.
//
// Mock-auth mode: when sfdcAccountId begins with 'mock-' (or claim is
// missing), we fall back to the test fixtures. Same as v13.
//
// Env vars (Supabase function secrets):
//   - SF_CLIENT_ID, SF_USERNAME, SF_PRIVATE_KEY, SF_LOGIN_URL  (SOQL lookups only)
//   - HQ_PROGRESS_WEBHOOK_URL                                  HQ webhook URL
//   - PORTAL_WEBHOOK_SECRET                                    shared HMAC secret
//   - SF_MOCK_ACCOUNT_ID                                       default '001TN00000oHF7ZYAW'
//   - SF_MOCK_OPPORTUNITY_ID                                   default '006TN00002aaAPiYAM'
//   - SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY                  (auto-injected)
//
// Returns:
//   { messageId, accepted, errorReason?, sentAt }
//   (messageId now reflects the HQ-side log row id, not an SF EmailMessage Id.)

// deno-lint-ignore-file no-explicit-any
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { renderSampleInvoice } from './render.ts';
import { getSalesforceAccessToken, sfRequest, type SfToken } from './sf-auth.ts';
import { postToHq } from '../_shared/hq-bridge.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';

const MOCK_ACCOUNT_ID =
  Deno.env.get('SF_MOCK_ACCOUNT_ID') ?? '001TN00000oHF7ZYAW';
const MOCK_OPPORTUNITY_ID =
  Deno.env.get('SF_MOCK_OPPORTUNITY_ID') ?? '006TN00002aaAPiYAM';

interface RequestBody {
  storefrontName: string;
  contactName: string;
  contactEmail: string;
  storefrontLocation?: string;
  currency?: 'USD';
  sfdcAccountIdOverride?: string;
  sfdcOpportunityIdOverride?: string;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'authorization, content-type, x-test-secret',
      'access-control-allow-methods': 'POST, OPTIONS',
    },
  });

function isEmail(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

async function sha256(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Fetch the bank-on-file fields confirmed in Step 3. Failure is non-fatal:
 * the renderer falls back to a neutral confirmation message.
 */
async function fetchBankOnFile(
  token: SfToken,
  accountId: string,
  opportunityId: string,
): Promise<{ bankName?: string; bankAccountLast4?: string }> {
  try {
    const acctSoql = `SELECT Bank_Account_Last_4__c FROM Account WHERE Id = '${accountId}' LIMIT 1`;
    const oppSoql = `SELECT Bank_Name__c FROM Opportunity WHERE Id = '${opportunityId}' LIMIT 1`;
    const [acctRes, oppRes] = await Promise.all([
      sfRequest(token, 'GET', `/query?q=${encodeURIComponent(acctSoql)}`) as Promise<
        { records?: Array<{ Bank_Account_Last_4__c?: string | null }> }
      >,
      sfRequest(token, 'GET', `/query?q=${encodeURIComponent(oppSoql)}`) as Promise<
        { records?: Array<{ Bank_Name__c?: string | null }> }
      >,
    ]);
    const last4 = acctRes.records?.[0]?.Bank_Account_Last_4__c ?? undefined;
    const bankName = oppRes.records?.[0]?.Bank_Name__c ?? undefined;
    return {
      bankName: bankName ?? undefined,
      bankAccountLast4: last4 ?? undefined,
    };
  } catch (e) {
    console.error('[send-sample-invoice] bank-on-file lookup failed', e);
    return {};
  }
}

/**
 * Resolve a Contact Id on the SF Account so HQ can log the Task against
 * the right contact (Recipient.* equivalent). Not strictly required —
 * HQ will fall back to OpportunityContactRole if we don't supply one.
 */
async function resolveContactId(
  token: SfToken,
  accountId: string,
  email: string,
): Promise<string | null> {
  const escaped = email.replace(/'/g, "\\'");
  const byEmail = `SELECT Id FROM Contact WHERE AccountId = '${accountId}' AND Email = '${escaped}' ORDER BY CreatedDate DESC LIMIT 1`;
  try {
    const r1 = await sfRequest(
      token,
      'GET',
      `/query?q=${encodeURIComponent(byEmail)}`,
    ) as { records?: Array<{ Id: string }> };
    if (r1.records?.[0]?.Id) return r1.records[0].Id;

    const anyContact = `SELECT Id FROM Contact WHERE AccountId = '${accountId}' ORDER BY CreatedDate DESC LIMIT 1`;
    const r2 = await sfRequest(
      token,
      'GET',
      `/query?q=${encodeURIComponent(anyContact)}`,
    ) as { records?: Array<{ Id: string }> };
    return r2.records?.[0]?.Id ?? null;
  } catch (e) {
    console.error('[send-sample-invoice] contact lookup failed', e);
    return null;
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return json(204, {});
  if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' });

  const authHeader = req.headers.get('authorization') ?? '';
  if (!authHeader.startsWith('Bearer ')) {
    return json(401, { error: 'missing_jwt' });
  }
  const bearer = authHeader.slice('Bearer '.length).trim();

  let sfdcAccountId: string | null = null;

  // Smoke-test bypass.
  const TEST_SECRET = Deno.env.get('SAMPLE_INVOICE_TEST_SECRET') ?? 'nst-smoke-2026-04-27';
  const testHeader = req.headers.get('x-test-secret') ?? '';
  const isTestBypass = testHeader === TEST_SECRET;

  if (isTestBypass || bearer === SERVICE_KEY) {
    sfdcAccountId = null; // forces mock-mode fallback below
  } else {
    const userClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { authorization: authHeader } },
    });
    const { data: userData, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userData.user) return json(401, { error: 'invalid_jwt' });

    sfdcAccountId =
      (userData.user.user_metadata as any)?.sfdc_account_id ??
      (userData.user.app_metadata as any)?.sfdc_account_id ??
      null;
  }

  let mockMode = false;
  if (!sfdcAccountId || sfdcAccountId.startsWith('mock-')) {
    mockMode = true;
    sfdcAccountId = MOCK_ACCOUNT_ID;
  }
  let sfOpportunityId = MOCK_OPPORTUNITY_ID;

  let body: RequestBody;
  try {
    body = (await req.json()) as RequestBody;
  } catch {
    return json(400, { error: 'invalid_json' });
  }

  if (mockMode) {
    const isSfId = (s: string | undefined): s is string =>
      typeof s === 'string' && /^[a-zA-Z0-9]{15,18}$/.test(s);
    if (isSfId(body.sfdcAccountIdOverride) && body.sfdcAccountIdOverride.startsWith('001')) {
      sfdcAccountId = body.sfdcAccountIdOverride;
    }
    if (isSfId(body.sfdcOpportunityIdOverride) && body.sfdcOpportunityIdOverride.startsWith('006')) {
      sfOpportunityId = body.sfdcOpportunityIdOverride;
    }
  }

  const { storefrontName, contactName, contactEmail, storefrontLocation } = body;
  if (!storefrontName || !contactName || !contactEmail) {
    return json(400, { error: 'missing_required_fields' });
  }
  if (!isEmail(contactEmail)) {
    return json(400, { error: 'invalid_email' });
  }

  const sentAt = new Date().toISOString();
  const invoiceSuffix = sfdcAccountId.slice(-6).toUpperCase();
  const sampleInvoiceNumber = `NST-SAMPLE-${invoiceSuffix}`;

  let sfToken: SfToken;
  try {
    sfToken = await getSalesforceAccessToken();
  } catch (err) {
    console.error('[send-sample-invoice] sf auth failed', err);
    return json(502, { error: 'sf_auth_failed', detail: (err as Error).message });
  }

  if (!mockMode) {
    try {
      const oppSoql =
        `SELECT Id FROM Opportunity WHERE AccountId = '${sfdcAccountId}' ` +
        `ORDER BY CreatedDate DESC LIMIT 1`;
      const r = await sfRequest(
        sfToken,
        'GET',
        `/query?q=${encodeURIComponent(oppSoql)}`,
      ) as { records?: Array<{ Id: string }> };
      if (r.records?.[0]?.Id) sfOpportunityId = r.records[0].Id;
    } catch (e) {
      console.error('[send-sample-invoice] opp lookup failed', e);
    }
  }

  const bankOnFile = await fetchBankOnFile(sfToken, sfdcAccountId, sfOpportunityId);

  const html = renderSampleInvoice({
    storefrontName,
    storefrontLocation,
    contactName,
    contactEmail,
    sampleInvoiceNumber,
    sentAt,
    bankName: bankOnFile.bankName,
    bankAccountLast4: bankOnFile.bankAccountLast4,
  });
  const subject = `Sample invoice — ${storefrontName} (${sampleInvoiceNumber})`;

  // Best-effort contact lookup for HQ to attach the Task to.
  const sfContactId = await resolveContactId(sfToken, sfdcAccountId, contactEmail);

  const adminClient = createClient(SUPABASE_URL, SERVICE_KEY);

  let hqLogId: string | null = null;
  let accepted = false;
  let errorReason: string | null = null;

  // POST to HQ. HQ verifies HMAC, sends via Gmail, writes SF Task, returns
  // its own log id as messageId.
  try {
    const hqResp = await postToHq({
      event: 'sample_invoice_requested',
      salesforce_account_id: sfdcAccountId,
      salesforce_opportunity_id: sfOpportunityId,
      salesforce_contact_id: sfContactId,
      submitted_at: sentAt,
      sample_invoice: {
        invoice_number: sampleInvoiceNumber,
        storefront_name: storefrontName,
        storefront_location: storefrontLocation ?? null,
        contact_name: contactName,
        contact_email: contactEmail,
        subject,
        body_html: html,
        bank_name: bankOnFile.bankName ?? null,
        bank_account_last_4: bankOnFile.bankAccountLast4 ?? null,
      },
    });

    if (hqResp.ok) {
      try {
        const parsed = JSON.parse(hqResp.body) as { log_id?: string; outcome?: string };
        hqLogId = parsed.log_id ?? null;
        accepted = parsed.outcome === 'sent';
        if (!accepted) errorReason = `hq_outcome:${parsed.outcome ?? 'unknown'}`;
      } catch {
        // 200 with no parseable body — treat as accepted.
        accepted = true;
      }
    } else {
      errorReason = `hq_post_failed:${hqResp.status}:${hqResp.error ?? hqResp.body.slice(0, 200)}`;
      console.error('[send-sample-invoice] HQ POST failed', hqResp);
    }
  } catch (e) {
    errorReason = `hq_post_threw: ${(e as Error).message?.slice(0, 200) ?? 'unknown'}`;
    console.error('[send-sample-invoice] HQ POST threw', e);
  }

  // Audit row — same shape as v13 so downstream dashboards keep working.
  const renderedHash = await sha256(html);
  const { error: insertErr } = await adminClient.from('invoice_samples').insert({
    sfdc_account_id: sfdcAccountId,
    storefront_name: storefrontName,
    contact_name: contactName,
    contact_email: contactEmail,
    resend_id: hqLogId, // now: HQ log_id (was: SF EmailMessage Id)
    accepted,
    error_reason: errorReason,
    sent_at: sentAt,
    rendered_html_sha256: renderedHash,
  });
  if (insertErr) {
    console.error('[send-sample-invoice] audit write failed', insertErr);
  }

  return json(accepted ? 200 : 502, {
    messageId: hqLogId ?? `error-${Date.now()}`,
    accepted,
    errorReason: errorReason ?? undefined,
    sentAt,
  });
});
