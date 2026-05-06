// Edge Function: get-onboarding-context
//
// Public, token-gated endpoint. Called by the SPA on portal load when a
// kickoff/resume token is present in the URL (?t=<token>). Returns:
//   - the retailer_onboardings row this token is bound to (so the SPA
//     knows which step to resume on)
//   - SF Account prefill data so Step 1 can render a "review what we
//     have on file" UI without the user re-typing what we already know
//   - the SF Contact (primary) so the contact section can pre-populate
//
// The SPA never trusts client-side input for SFDC ids; it always re-derives
// them from the server response. The token is the only auth on this route.
//
// Token redemption side-effects:
//   - bumps redeem_count, last_redeemed_at, last_used_ip, last_user_agent
//   - revoked tokens return 401
//
// Auth: deployed with verify_jwt=false. The token in the request body is
// the auth.

// deno-lint-ignore-file no-explicit-any
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const SF_LOGIN_URL = Deno.env.get('SF_LOGIN_URL') ?? 'https://login.salesforce.com';
const SF_API_VERSION = 'v61.0';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'POST, OPTIONS',
      'access-control-allow-headers': 'content-type, authorization',
    },
  });

interface SfToken {
  access_token: string;
  instance_url: string;
}

async function getSalesforceAccessToken(): Promise<SfToken> {
  const clientId = Deno.env.get('SF_CLIENT_ID');
  const username = Deno.env.get('SF_USERNAME');
  const privateKey = Deno.env.get('SF_PRIVATE_KEY');
  if (!clientId || !username || !privateKey) {
    throw new Error('SF credentials missing from env');
  }
  const header = { alg: 'RS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const claims = { iss: clientId, sub: username, aud: SF_LOGIN_URL, exp: now + 180 };
  const encode = (obj: unknown) =>
    btoa(JSON.stringify(obj))
      .replace(/=/g, '')
      .replace(/\+/g, '-')
      .replace(/\//g, '_');
  const toSign = `${encode(header)}.${encode(claims)}`;
  const keyData = pemToArrayBuffer(privateKey);
  const key = await crypto.subtle.importKey(
    'pkcs8',
    keyData,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    new TextEncoder().encode(toSign),
  );
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
  const assertion = `${toSign}.${sigB64}`;
  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion,
  });
  const resp = await fetch(`${SF_LOGIN_URL}/services/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!resp.ok) throw new Error(`SF token exchange failed: ${resp.status} ${await resp.text()}`);
  return (await resp.json()) as SfToken;
}

function pemToArrayBuffer(pem: string): ArrayBuffer {
  const b64 = pem
    .replace(/-----BEGIN PRIVATE KEY-----/g, '')
    .replace(/-----END PRIVATE KEY-----/g, '')
    .replace(/\s+/g, '');
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf.buffer;
}

interface SfQueryResult {
  records: Record<string, unknown>[];
  totalSize?: number;
  done?: boolean;
}

async function sfQuery(token: SfToken, soql: string): Promise<SfQueryResult> {
  const url = `${token.instance_url}/services/data/${SF_API_VERSION}/query?q=${encodeURIComponent(soql)}`;
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${token.access_token}` },
  });
  if (!resp.ok) throw new Error(`SF query failed: ${resp.status} ${(await resp.text()).slice(0, 400)}`);
  return await resp.json();
}

const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers': 'content-type, authorization',
  'access-control-max-age': '86400',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' });

  let body: { token?: string } = {};
  try {
    const text = await req.text();
    if (text) body = JSON.parse(text);
  } catch {
    return json(400, { error: 'invalid_json' });
  }
  const token = (body.token ?? '').trim();
  if (!token) return json(400, { error: 'missing_token' });

  const admin = createClient(SUPABASE_URL, SERVICE_KEY);

  // Look up token + onboarding in one shot.
  const { data: tokRow, error: tokErr } = await admin
    .from('onboarding_tokens')
    .select('token, sfdc_account_id, sfdc_opportunity_id, sfdc_contact_id, recipient_email, recipient_first_name, account_name, revoked_at, redeem_count')
    .eq('token', token)
    .maybeSingle();

  if (tokErr) return json(500, { error: 'token_lookup_failed', detail: tokErr.message });
  if (!tokRow) return json(401, { error: 'invalid_token' });
  if (tokRow.revoked_at) return json(401, { error: 'token_revoked' });

  const { data: onbRow, error: onbErr } = await admin
    .from('retailer_onboardings')
    .select('id, sfdc_account_id, sfdc_opportunity_id, retailer_email, retailer_first_name, retailer_last_name, store_name, language, current_step, status, completed_at')
    .eq('sfdc_account_id', tokRow.sfdc_account_id)
    .eq('sfdc_opportunity_id', tokRow.sfdc_opportunity_id)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (onbErr) return json(500, { error: 'onboarding_lookup_failed', detail: onbErr.message });

  // Pull SF Account + Contact prefill in parallel with the redemption update.
  let prefill: { account: unknown; contact: unknown } | null = null;
  let sfWarning: string | null = null;
  try {
    const sfToken = await getSalesforceAccessToken();
    const acctSoql = `SELECT Id, Name, BillingStreet, BillingCity, BillingState, BillingPostalCode, BillingCountry, Phone, Website FROM Account WHERE Id = '${tokRow.sfdc_account_id}' LIMIT 1`;
    const contactSoql = tokRow.sfdc_contact_id
      ? `SELECT Id, FirstName, LastName, Email, Phone, MobilePhone, Title FROM Contact WHERE Id = '${tokRow.sfdc_contact_id}' LIMIT 1`
      : null;
    const [acctRes, contactRes] = await Promise.all([
      sfQuery(sfToken, acctSoql),
      contactSoql ? sfQuery(sfToken, contactSoql) : Promise.resolve({ records: [] } as SfQueryResult),
    ]);
    const account = acctRes?.records?.[0] ?? null;
    const contact = contactRes?.records?.[0] ?? null;
    prefill = { account, contact };
  } catch (e) {
    sfWarning = (e as Error).message?.slice(0, 200) ?? 'unknown';
    console.error('[get-onboarding-context] SF fetch failed', e);
  }

  // Best-effort redemption stamp. Don't fail the request if this errors.
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || null;
  const ua = req.headers.get('user-agent') || null;
  const redeemCount = ((tokRow.redeem_count as number | undefined) ?? 0) + 1;
  void admin
    .from('onboarding_tokens')
    .update({
      redeem_count: redeemCount,
      last_redeemed_at: new Date().toISOString(),
      first_redeemed_at: redeemCount === 1 ? new Date().toISOString() : undefined,
      last_used_ip: ip,
      last_user_agent: ua,
    })
    .eq('token', token)
    .then(() => {}, (e) => console.error('[get-onboarding-context] redemption stamp failed', e));

  return json(200, {
    token: {
      sfdc_account_id: tokRow.sfdc_account_id,
      sfdc_opportunity_id: tokRow.sfdc_opportunity_id,
      sfdc_contact_id: tokRow.sfdc_contact_id,
      recipient_email: tokRow.recipient_email,
      recipient_first_name: tokRow.recipient_first_name,
      account_name: tokRow.account_name,
    },
    onboarding: onbRow,
    prefill,
    sf_warning: sfWarning,
  });
});
