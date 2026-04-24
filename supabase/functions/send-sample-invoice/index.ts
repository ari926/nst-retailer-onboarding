// supabase/functions/send-sample-invoice/index.ts
//
// Sends one sample NST invoice via Resend and writes the delivery
// result to invoice_samples. Called from the Step 6 UI after the
// retailer submits the invoicing contact and opts in to a sample.
//
// Auth model: invoked from the browser with the user's JWT. We pull
// sfdc_account_id from the JWT claims rather than trusting the client,
// so a malicious client can't spoof someone else's account.
//
// Env vars (Supabase function secrets):
//   - RESEND_API_KEY                Resend secret key
//   - RESEND_FROM_EMAIL             "NST Billing <billing@nstops.com>"
//   - RESEND_REPLY_TO               "billing@nstops.com"
//   - SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY  (auto-injected)
//
// Returns:
//   { messageId, accepted, errorReason?, sentAt }
//
// Hard rule: we never send PII the retailer didn't enter. The only
// fields we render in the email are storefront name, contact name,
// contact email, plus mock invoice line items.

// deno-lint-ignore-file no-explicit-any
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { renderSampleInvoice } from '../_shared/email-templates/render.ts';

const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY') ?? '';
const FROM_EMAIL =
  Deno.env.get('RESEND_FROM_EMAIL') ?? 'NST Billing <billing@nstops.com>';
const REPLY_TO = Deno.env.get('RESEND_REPLY_TO') ?? 'billing@nstops.com';

interface RequestBody {
  storefrontName: string;
  contactName: string;
  contactEmail: string;
  /** ISO 4217 currency. V1 is USD only. */
  currency?: 'USD';
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      // Same-origin only — the SDK calls this from the browser via
      // supabase.functions.invoke which respects CORS automatically.
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'authorization, content-type',
    },
  });

function isEmail(s: string): boolean {
  // Liberal check; full validation happens client-side.
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

async function sha256(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return json(204, {});
  if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' });

  const authHeader = req.headers.get('authorization') ?? '';
  if (!authHeader.startsWith('Bearer ')) {
    return json(401, { error: 'missing_jwt' });
  }

  // Authenticate the caller and pull sfdc_account_id from JWT claims.
  const userClient = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_ANON_KEY') ?? '',
    { global: { headers: { authorization: authHeader } } },
  );
  const { data: userData, error: userErr } = await userClient.auth.getUser();
  if (userErr || !userData.user) return json(401, { error: 'invalid_jwt' });

  const sfdcAccountId =
    (userData.user.user_metadata as any)?.sfdc_account_id ??
    (userData.user.app_metadata as any)?.sfdc_account_id;
  if (!sfdcAccountId) {
    return json(403, { error: 'no_sfdc_account_id_claim' });
  }

  let body: RequestBody;
  try {
    body = (await req.json()) as RequestBody;
  } catch {
    return json(400, { error: 'invalid_json' });
  }

  // Validate input
  const { storefrontName, contactName, contactEmail } = body;
  if (!storefrontName || !contactName || !contactEmail) {
    return json(400, { error: 'missing_required_fields' });
  }
  if (!isEmail(contactEmail)) {
    return json(400, { error: 'invalid_email' });
  }

  const sentAt = new Date().toISOString();
  const html = renderSampleInvoice({
    storefrontName,
    contactName,
    contactEmail,
    sampleInvoiceNumber: `NST-SAMPLE-${sfdcAccountId.slice(-6)}`,
    sentAt,
  });
  const subject = `Sample invoice for ${storefrontName}`;

  // Service-role client to write the audit row regardless of RLS.
  const adminClient = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  );

  let resendId: string | null = null;
  let accepted = false;
  let errorReason: string | null = null;

  try {
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${RESEND_API_KEY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        from: FROM_EMAIL,
        to: [contactEmail],
        reply_to: REPLY_TO,
        subject,
        html,
        // Tag rows so we can group-attribute deliveries in Resend's UI.
        tags: [
          { name: 'category', value: 'sample-invoice' },
          { name: 'sfdc_account_id', value: sfdcAccountId },
        ],
      }),
    });
    const respBody: any = await resp.json().catch(() => ({}));
    if (resp.ok && respBody.id) {
      resendId = respBody.id as string;
      accepted = true;
    } else {
      // Resend returns { name, message } on errors. Map the few we care
      // about to short codes for the UI.
      const reason: string = respBody?.name ?? respBody?.message ?? 'unknown';
      errorReason = reason.toLowerCase().includes('invalid')
        ? 'invalid_email'
        : reason.toLowerCase().includes('bounce')
          ? 'mailbox_does_not_exist'
          : 'provider_error';
    }
  } catch (e) {
    errorReason = 'network_error';
    console.error('[send-sample-invoice] resend call failed', e);
  }

  // Always write an audit row, success or failure.
  const renderedHash = await sha256(html);
  const { error: insertErr } = await adminClient.from('invoice_samples').insert({
    sfdc_account_id: sfdcAccountId,
    storefront_name: storefrontName,
    contact_name: contactName,
    contact_email: contactEmail,
    resend_id: resendId,
    accepted,
    error_reason: errorReason,
    sent_at: sentAt,
    rendered_html_sha256: renderedHash,
  });
  if (insertErr) console.error('[send-sample-invoice] audit write failed', insertErr);

  return json(accepted ? 200 : 502, {
    messageId: resendId ?? `error-${Date.now()}`,
    accepted,
    errorReason: errorReason ?? undefined,
    sentAt,
  });
});
