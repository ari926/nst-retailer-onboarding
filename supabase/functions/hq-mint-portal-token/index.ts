// Edge Function: hq-mint-portal-token
//
// Called by HQ (Lovable, hq.talaria.com) when an admin clicks
// "Open portal as customer" on the NST account detail page.
//
// Unlike mint-onboarding-token (HMAC-signed, called server-to-server from HQ
// for the customer intro-email flow), this function is called from the HQ
// browser frontend directly. The auth path is JWT — the admin is already
// signed into HQ via Supabase Auth on this same project, so we verify their
// JWT and extract their email as `acting_admin_email`.
//
// Behavior:
//   1. JWT verification ON (handled by Supabase before this code runs).
//   2. Pull caller email from auth context.
//   3. Always mint a fresh admin token (never reused — each click independent).
//   4. Insert row into onboarding_tokens with source='admin_access'.
//   5. Return { token, expires_at, portal_url }.
//
// Input:  { salesforce_account_id, salesforce_opportunity_id, expires_in_days? }
// Output: { token, expires_at, portal_url, source: 'admin_access' }

// deno-lint-ignore-file no-explicit-any
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';

const PORTAL_BASE_URL =
  Deno.env.get('PORTAL_BASE_URL') ?? 'https://onboard.nationalsecuretransport.com';
const ADMIN_TOKEN_TTL_DAYS = 1;

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'content-type': 'application/json' },
  });

function randomToken(): string {
  const buf = new Uint8Array(32);
  crypto.getRandomValues(buf);
  return btoa(String.fromCharCode(...buf))
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' });

  // Auth: caller must be a signed-in HQ user. Supabase verifies JWT before us
  // (verify_jwt=true in config). We use the user's JWT to call back into
  // supabase-js, which gives us .auth.getUser() → caller email.
  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return json(401, { error: 'missing_auth' });

  const userClient = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_ANON_KEY')!,
    { global: { headers: { Authorization: authHeader } } },
  );

  const { data: { user }, error: userErr } = await userClient.auth.getUser();
  if (userErr || !user?.email) {
    return json(401, { error: 'invalid_user', detail: userErr?.message });
  }
  const actingAdminEmail = user.email;

  let body: any;
  try {
    body = await req.json();
  } catch {
    return json(400, { error: 'invalid_json' });
  }

  const accountId = body?.salesforce_account_id as string | undefined;
  const opportunityId = body?.salesforce_opportunity_id as string | undefined;
  const expiresInDays = typeof body?.expires_in_days === 'number'
    ? body.expires_in_days
    : ADMIN_TOKEN_TTL_DAYS;

  if (!accountId || !opportunityId) {
    return json(400, { error: 'missing_ids', detail: 'salesforce_account_id and salesforce_opportunity_id required' });
  }

  // Always mint fresh — admin sessions never reuse.
  const token = randomToken();
  const expiresAt = new Date(
    Date.now() + expiresInDays * 24 * 60 * 60 * 1000,
  ).toISOString();

  const admin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  const { error: insertErr } = await admin.from('onboarding_tokens').insert({
    token,
    sfdc_account_id: accountId,
    sfdc_opportunity_id: opportunityId,
    sfdc_contact_id: body?.salesforce_contact_id ?? null,
    contact_email: body?.contact_email ?? null,
    expires_at: expiresAt,
    source: 'admin_access',
    acting_admin_email: actingAdminEmail,
    hq_minted_at: new Date().toISOString(),
    hq_minted_by_signature: `jwt:${user.id.slice(0, 8)}`, // trace marker; not a real sig
  });

  if (insertErr) {
    return json(500, { error: 'token_insert_failed', detail: insertErr.message });
  }

  return json(200, {
    token,
    expires_at: expiresAt,
    portal_url: `${PORTAL_BASE_URL}/?t=${token}`,
    source: 'admin_access',
  });
});
