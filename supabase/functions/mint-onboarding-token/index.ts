// Edge Function: mint-onboarding-token
//
// Called by HQ (Lovable) when an ops user clicks "Send introduction email"
// on the NST Onboarding detail page. HQ signs the request with
// PORTAL_WEBHOOK_SECRET; we verify in constant time before minting.
//
// Behavior:
//   1. Verify x-hq-signature header against raw body using PORTAL_WEBHOOK_SECRET.
//   2. Look up existing non-revoked token for this (account, opportunity, contact).
//      If one exists AND source matches, return it (resend-with-same-token
//      behavior — confirmed with Ari 2026-06-11 to keep things simple for
//      retailers who hand the email off internally).
//      Admin-source tokens always mint fresh — short-lived, never reused.
//   3. Otherwise mint a fresh token, insert into onboarding_tokens, return it.
//
// Auth: deployed with verify_jwt=false. The HMAC signature is the auth.
//
// Input:  { salesforce_account_id, salesforce_opportunity_id,
//           salesforce_contact_id, contact_email,
//           source?: 'intro_email' | 'admin_access',
//           acting_admin_email?: string,
//           expires_in_days?: number }
// Output: { token, expires_at, portal_url, reused: boolean, source }

// deno-lint-ignore-file no-explicit-any
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { hmacVerify } from '../_shared/hmac.ts';

const PORTAL_BASE_URL =
  Deno.env.get('PORTAL_BASE_URL') ?? 'https://onboard.nationalsecuretransport.com';
const CUSTOMER_TOKEN_TTL_DAYS = 60; // intro-email tokens are long-lived; retailers
                                    // sometimes take weeks to come back.
const ADMIN_TOKEN_TTL_DAYS = 1;     // admin "view as customer" tokens are short-lived.
                                    // Admins are expected to use & discard within hours.

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
  const source = (body?.source as string | undefined) ?? 'intro_email';
  const actingAdminEmail = body?.acting_admin_email as string | undefined;
  const expiresInDays = typeof body?.expires_in_days === 'number'
    ? body.expires_in_days
    : source === 'admin_access' ? ADMIN_TOKEN_TTL_DAYS : CUSTOMER_TOKEN_TTL_DAYS;

  if (!accountId || !opportunityId) {
    return json(400, { error: 'missing_ids' });
  }

  if (source !== 'intro_email' && source !== 'admin_access') {
    return json(400, { error: 'invalid_source' });
  }

  if (source === 'admin_access' && !actingAdminEmail) {
    return json(400, { error: 'admin_email_required' });
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  // Existing-token lookup — only reuse customer-facing tokens.
  // Admin tokens always mint fresh so each admin session is independently revocable
  // and short-lived. (We don't want two admins sharing the same token URL.)
  if (source === 'intro_email') {
    const { data: existing } = await supabase
      .from('onboarding_tokens')
      .select('token, expires_at')
      .eq('sfdc_account_id', accountId)
      .eq('sfdc_opportunity_id', opportunityId)
      .eq('source', 'intro_email')
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
        source: 'intro_email',
      });
    }
  }

  // Mint fresh
  const token = randomToken();
  const expiresAt = new Date(
    Date.now() + expiresInDays * 24 * 60 * 60 * 1000,
  ).toISOString();

  const { error: insertErr } = await supabase.from('onboarding_tokens').insert({
    token,
    sfdc_account_id: accountId,
    sfdc_opportunity_id: opportunityId,
    sfdc_contact_id: contactId ?? null,
    contact_email: contactEmail ?? null,
    expires_at: expiresAt,
    source,
    acting_admin_email: actingAdminEmail ?? null,
    hq_minted_at: new Date().toISOString(),
    hq_minted_by_signature: sig.slice(0, 16), // first 16 chars of sig for trace
  });

  if (insertErr) {
    return json(500, { error: 'token_insert_failed', detail: insertErr.message });
  }

  // --- Provision retailer_onboardings row -----------------------------------
  // step_submissions / step_drafts logically belong to a retailer_onboardings
  // row keyed by (sfdc_account_id, sfdc_opportunity_id). Without this row,
  // submit-step returns 404 onboarding_not_found and get-onboarding-context
  // returns { onboarding: null } so the portal sits on "Loading your
  // onboarding…" forever (or, if it does render, Confirm & continue 404s
  // silently). Provision it here on first mint.
  //
  // Idempotent: ignoreDuplicates leaves any in-flight progress untouched on
  // resend (we should never reach this branch on a token reuse anyway, since
  // reuse hits the early-return above, but defense in depth).
  //
  // Non-fatal: if this errors we still return the token. HQ's email send must
  // not be blocked by a portal-side write failure.
  try {
    const { error: provErr } = await supabase
      .from('retailer_onboardings')
      .upsert(
        {
          sfdc_account_id: accountId,
          sfdc_opportunity_id: opportunityId,
          retailer_email: contactEmail ?? null,
          retailer_first_name: null,
          retailer_last_name: null,
          store_name: null,
          language: 'en',
          current_step: 1,
          status: 'in_progress',
        },
        { onConflict: 'sfdc_account_id', ignoreDuplicates: true },
      );
    if (provErr) {
      console.error(
        '[mint-onboarding-token] retailer_onboardings provision failed',
        provErr,
      );
    }
  } catch (e) {
    console.error(
      '[mint-onboarding-token] retailer_onboardings provision threw',
      e,
    );
  }
  // --- end provision -------------------------------------------------------

  return json(200, {
    token,
    expires_at: expiresAt,
    portal_url: `${PORTAL_BASE_URL}/?t=${token}`,
    reused: false,
    source,
  });
});
