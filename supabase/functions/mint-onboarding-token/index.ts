// Edge Function: mint-onboarding-token
//
// Called by HQ (Lovable) when an ops user clicks "Send introduction email"
// on the NST Onboarding detail page. HQ signs the request with
// PORTAL_WEBHOOK_SECRET; we verify in constant time before minting.
//
// Behavior:
//   1. Verify x-hq-signature header against raw body using PORTAL_WEBHOOK_SECRET.
//   2. Look up existing non-revoked token for this (account, opportunity, contact).
//      If one exists, return it (resend-with-same-token behavior — confirmed
//      with Ari 2026-06-11 to keep things simple for retailers who hand the
//      email off internally).
//   3. Otherwise mint a fresh token, insert into onboarding_tokens, return it.
//
// Auth: deployed with verify_jwt=false. The HMAC signature is the auth.
//
// Input:  { salesforce_account_id, salesforce_opportunity_id,
//           salesforce_contact_id, contact_email }
// Output: { token, expires_at, portal_url, reused: boolean }

// deno-lint-ignore-file no-explicit-any
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { hmacVerify } from '../_shared/hmac.ts';

const PORTAL_BASE_URL =
  Deno.env.get('PORTAL_BASE_URL') ?? 'https://onboard.nationalsecuretransport.com';
const TOKEN_TTL_DAYS = 60; // tokens are intentionally long-lived; retailers
                           // sometimes take weeks to come back. Revocation is
                           // explicit via the reopen-step / revoke flows.

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

function randomToken(): string {
  // 32 bytes → 43-char base64url
  const buf = new Uint8Array(32);
  crypto.getRandomValues(buf);
  return btoa(String.fromCharCode(...buf))
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' });

  const secret = Deno.env.get('PORTAL_WEBHOOK_SECRET');
  if (!secret) return json(500, { error: 'secret_not_configured' });

  const rawBody = await req.text();
  const sig = req.headers.get('x-hq-signature') ?? '';
  const ok = await hmacVerify(secret, rawBody, sig);
  if (!ok) return json(401, { error: 'bad_signature' });

  let body: any;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return json(400, { error: 'invalid_json' });
  }

  const accountId = body?.salesforce_account_id as string | undefined;
  const opportunityId = body?.salesforce_opportunity_id as string | undefined;
  const contactId = body?.salesforce_contact_id as string | undefined;
  const contactEmail = body?.contact_email as string | undefined;

  if (!accountId || !opportunityId) {
    return json(400, { error: 'missing_ids' });
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  // Existing-token lookup (same account + opportunity, not revoked, not expired)
  const { data: existing } = await supabase
    .from('onboarding_tokens')
    .select('token, expires_at')
    .eq('sfdc_account_id', accountId)
    .eq('sfdc_opportunity_id', opportunityId)
    .is('revoked_at', null)
    .gt('expires_at', new Date().toISOString())
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (existing?.token) {
    return json(200, {
      token: existing.token,
      expires_at: existing.expires_at,
      portal_url: `${PORTAL_BASE_URL}/?t=${existing.token}`,
      reused: true,
    });
  }

  // Mint fresh
  const token = randomToken();
  const expiresAt = new Date(
    Date.now() + TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();

  const { error: insertErr } = await supabase.from('onboarding_tokens').insert({
    token,
    sfdc_account_id: accountId,
    sfdc_opportunity_id: opportunityId,
    sfdc_contact_id: contactId ?? null,
    contact_email: contactEmail ?? null,
    expires_at: expiresAt,
    hq_minted_at: new Date().toISOString(),
    hq_minted_by_signature: sig.slice(0, 16), // first 16 chars of sig for trace
  });

  if (insertErr) {
    return json(500, { error: 'token_insert_failed', detail: insertErr.message });
  }

  return json(200, {
    token,
    expires_at: expiresAt,
    portal_url: `${PORTAL_BASE_URL}/?t=${token}`,
    reused: false,
  });
});
