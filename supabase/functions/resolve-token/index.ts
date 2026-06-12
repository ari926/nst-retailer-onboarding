// Edge Function: resolve-token
//
// Public endpoint called by the portal browser when a user lands on `/?t=<token>`.
// Resolves an opaque kickoff token into the session info the SPA needs:
// account/opportunity IDs, contact email, source (intro_email vs admin_access),
// and acting_admin_email (when applicable).
//
// Auth: NONE — this is intentionally a public endpoint, gated only by the
// secret token itself. The token is the bearer credential. Deployed with
// verify_jwt=false.
//
// Security model:
//   - Token is 256-bit (32 bytes) random, base64url-encoded → 43 chars.
//   - Tokens are server-validated against onboarding_tokens (revoked_at, expires_at).
//   - No data is returned beyond what the SPA needs to render: SF IDs (which the
//     SPA already knows post-validation are bound to this token), source flag,
//     and acting_admin_email. Customer PII (banking, license, full address) is
//     fetched separately via get-onboarding-context which keeps the same gate.
//   - Admin opens are logged to admin_portal_access_log for audit.
//
// Input:  POST { token: string }
// Output: 200 { ok: true, sfdc_account_id, sfdc_opportunity_id, sfdc_contact_id,
//                contact_email, source, acting_admin_email, expires_at }
//         410 { ok: false, reason: 'not_found' | 'revoked' | 'expired' }

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';

const corsHeaders = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'content-type',
  'access-control-allow-methods': 'POST, OPTIONS',
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...corsHeaders },
  });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' });

  let body: { token?: string };
  try {
    body = await req.json();
  } catch {
    return json(400, { error: 'invalid_json' });
  }

  const token = body.token?.trim();
  if (!token) return json(400, { error: 'missing_token' });

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  const { data, error } = await supabase
    .from('onboarding_tokens')
    .select(
      'sfdc_account_id, sfdc_opportunity_id, sfdc_contact_id, contact_email, source, acting_admin_email, expires_at, revoked_at',
    )
    .eq('token', token)
    .maybeSingle();

  if (error) {
    return json(500, { ok: false, error: 'lookup_failed', detail: error.message });
  }
  if (!data) return json(410, { ok: false, reason: 'not_found' });
  if (data.revoked_at) return json(410, { ok: false, reason: 'revoked' });
  if (new Date(data.expires_at) <= new Date()) {
    return json(410, { ok: false, reason: 'expired' });
  }

  // Audit admin opens — fire-and-forget; don't block the response on log failure.
  if (data.source === 'admin_access' && data.acting_admin_email) {
    const userAgent = req.headers.get('user-agent') ?? null;
    const forwardedFor = req.headers.get('x-forwarded-for') ?? null;
    const ipAddress = forwardedFor?.split(',')[0]?.trim() ?? null;

    supabase
      .from('admin_portal_access_log')
      .insert({
        token,
        sfdc_account_id: data.sfdc_account_id,
        sfdc_opportunity_id: data.sfdc_opportunity_id,
        acting_admin_email: data.acting_admin_email,
        user_agent: userAgent,
        ip_address: ipAddress,
      })
      .then(({ error: logErr }) => {
        if (logErr) {
          console.error('admin_portal_access_log insert failed:', logErr.message);
        }
      });
  }

  return json(200, {
    ok: true,
    sfdc_account_id: data.sfdc_account_id,
    sfdc_opportunity_id: data.sfdc_opportunity_id,
    sfdc_contact_id: data.sfdc_contact_id,
    contact_email: data.contact_email,
    source: data.source ?? 'intro_email',
    acting_admin_email: data.acting_admin_email,
    expires_at: data.expires_at,
  });
});
