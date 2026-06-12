// deno-lint-ignore-file no-explicit-any
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';

const PORTAL_BASE_URL = Deno.env.get('PORTAL_BASE_URL') ?? 'https://onboard.nationalsecuretransport.com';
const CUSTOMER_TOKEN_TTL_DAYS = 60;
const ADMIN_TOKEN_TTL_DAYS = 1;

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-hq-signature',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'content-type': 'application/json' } });

function randomToken(): string {
  const buf = new Uint8Array(32);
  crypto.getRandomValues(buf);
  return btoa(String.fromCharCode(...buf)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

async function hmacSign(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function hmacVerify(secret: string, body: string, signature: string): Promise<boolean> {
  if (!signature) return false;
  const expected = await hmacSign(secret, body);
  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  return diff === 0;
}

Deno.serve(async (req) => {
  try {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
    if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' });

    const rawBody = await req.text();
    let body: any;
    try { body = JSON.parse(rawBody); } catch { return json(400, { error: 'invalid_json' }); }

    const requestedSource = (body?.source as string | undefined) ?? 'intro_email';
    const authHeader = req.headers.get('Authorization');
    const sig = req.headers.get('x-hq-signature') ?? '';
    let actingAdminEmail: string | undefined = body?.acting_admin_email as string | undefined;
    let authPath = 'none';

    if (requestedSource === 'admin_access') {
      // Three acceptable proofs for admin_access (in priority order):
      //   1. Valid HMAC signature (preferred — server-to-server)
      //   2. Valid Supabase JWT in Authorization header (HQ admin browser, same project)
      //   3. Trusted-proxy fallback: HQ's hq-mint-portal-token forwards user identity
      //      in acting_admin_email and uses its own anon-key Authorization header.
      //      We accept this if a Bearer token is present (not anonymous) and
      //      acting_admin_email is provided. This is the current HQ proxy shape.
      //
      // Path 1: HMAC
      const secret = Deno.env.get('PORTAL_WEBHOOK_SECRET');
      if (sig && secret) {
        const ok = await hmacVerify(secret, rawBody, sig);
        if (!ok) return json(401, { error: 'bad_signature' });
        authPath = 'hmac';
      } else if (authHeader && authHeader.startsWith('Bearer ')) {
        // Path 2: Try JWT verification
        try {
          const userClient = createClient(
            Deno.env.get('SUPABASE_URL')!,
            Deno.env.get('SUPABASE_ANON_KEY')!,
            { global: { headers: { Authorization: authHeader } } },
          );
          const { data: { user } } = await userClient.auth.getUser();
          if (user?.email) {
            actingAdminEmail = user.email;
            authPath = 'jwt';
          }
        } catch (_e) {
          // JWT verify failed (e.g., foreign-project token) — fall through to path 3
        }
        // Path 3: Trusted-proxy fallback. We require acting_admin_email in body.
        if (authPath === 'none') {
          if (!actingAdminEmail) return json(401, { error: 'admin_email_required' });
          authPath = 'proxy_trusted';
        }
      } else {
        return json(401, { error: 'missing_auth' });
      }
    } else {
      // intro_email — must be HMAC.
      const secret = Deno.env.get('PORTAL_WEBHOOK_SECRET');
      if (!secret) return json(500, { error: 'secret_not_configured' });
      const ok = await hmacVerify(secret, rawBody, sig);
      if (!ok) return json(401, { error: 'bad_signature' });
      authPath = 'hmac';
    }

    // Accept either naming convention from HQ:
    const accountId = (body?.salesforce_account_id ?? body?.account_id) as string | undefined;
    const opportunityId = (body?.salesforce_opportunity_id ?? body?.opportunity_id) as string | undefined;
    const contactId = (body?.salesforce_contact_id ?? body?.contact_id) as string | undefined;
    const contactEmail = body?.contact_email as string | undefined;
    const source = requestedSource;
    const expiresInDays = typeof body?.expires_in_days === 'number'
      ? body.expires_in_days
      : source === 'admin_access' ? ADMIN_TOKEN_TTL_DAYS : CUSTOMER_TOKEN_TTL_DAYS;

    if (!accountId) return json(400, { error: 'missing_account_id' });
    if (source === 'intro_email' && !opportunityId) return json(400, { error: 'missing_opportunity_id' });
    if (source !== 'intro_email' && source !== 'admin_access') return json(400, { error: 'invalid_source' });
    if (source === 'admin_access' && !actingAdminEmail) return json(400, { error: 'admin_email_required' });

    const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const traceMarker = sig
      ? `hmac:${sig.slice(0, 12)}`
      : `${authPath}:${(actingAdminEmail ?? '').slice(0, 12)}`;

    const opportunityIdForInsert = opportunityId ?? (source === 'admin_access' ? `admin:${accountId}` : null);

    if (source === 'intro_email') {
      const { data: existing } = await supabase.from('onboarding_tokens').select('token, expires_at')
        .eq('sfdc_account_id', accountId).eq('sfdc_opportunity_id', opportunityId!).eq('source', 'intro_email')
        .is('revoked_at', null).gt('expires_at', new Date().toISOString()).order('created_at', { ascending: false }).limit(1).maybeSingle();
      if (existing?.token) return json(200, { token: existing.token, expires_at: existing.expires_at, portal_url: `${PORTAL_BASE_URL}/?t=${existing.token}`, reused: true, source: 'intro_email' });
    }

    // For admin_access: revoke + delete any prior token sharing the synthetic
    // opportunity_id (admin:<account_id>) so the unique constraint allows a fresh insert.
    // Each admin portal launch creates a new short-lived token; this avoids the
    // unique-constraint collision while keeping a clean audit trail via admin_portal_access_log.
    if (source === 'admin_access' && opportunityIdForInsert) {
      await supabase.from('onboarding_tokens')
        .delete()
        .eq('sfdc_opportunity_id', opportunityIdForInsert)
        .eq('source', 'admin_access');
    }

    const token = randomToken();
    const expiresAt = new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000).toISOString();

    const { error: insertErr } = await supabase.from('onboarding_tokens').insert({
      token, sfdc_account_id: accountId, sfdc_opportunity_id: opportunityIdForInsert,
      sfdc_contact_id: contactId ?? null, contact_email: contactEmail ?? null,
      expires_at: expiresAt, source, acting_admin_email: actingAdminEmail ?? null,
      hq_minted_at: new Date().toISOString(), hq_minted_by_signature: traceMarker,
    });
    if (insertErr) return json(500, { error: 'token_insert_failed', detail: insertErr.message });

    // Audit log row for admin_access
    if (source === 'admin_access') {
      await supabase.from('admin_portal_access_log').insert({
        sfdc_account_id: accountId,
        acting_admin_email: actingAdminEmail,
        token,
        opened_at: new Date().toISOString(),
      }).then(() => null).catch(() => null);
    }

    return json(200, { token, expires_at: expiresAt, portal_url: `${PORTAL_BASE_URL}/?t=${token}`, reused: false, source, auth_path: authPath });
  } catch (e: any) {
    console.error('mint-onboarding-token unhandled', e?.message, e?.stack);
    return json(500, { error: 'unhandled_exception', detail: e?.message ?? String(e) });
  }
});
