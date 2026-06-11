// Edge Function: validate-token
//
// Lightweight check used by HQ right before sending the introduction email.
// Confirms the token hasn't been revoked between minting and sending (rare,
// but possible if ops revoked it from a separate browser tab).
//
// Auth: HMAC signature in `x-hq-signature` over the raw body, same as
// mint-onboarding-token. Deployed with verify_jwt=false.
//
// Input:  { token }
// Output: 200 { ok: true, expires_at }  | 410 { ok: false, reason }

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { hmacVerify } from '../_shared/hmac.ts';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' });

  const secret = Deno.env.get('PORTAL_WEBHOOK_SECRET');
  if (!secret) return json(500, { error: 'secret_not_configured' });

  const rawBody = await req.text();
  const sig = req.headers.get('x-hq-signature') ?? '';
  if (!(await hmacVerify(secret, rawBody, sig))) {
    return json(401, { error: 'bad_signature' });
  }

  let body: { token?: string };
  try { body = JSON.parse(rawBody); } catch { return json(400, { error: 'invalid_json' }); }
  const token = body.token;
  if (!token) return json(400, { error: 'missing_token' });

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  const { data } = await supabase
    .from('onboarding_tokens')
    .select('revoked_at, expires_at')
    .eq('token', token)
    .maybeSingle();

  if (!data) return json(410, { ok: false, reason: 'not_found' });
  if (data.revoked_at) return json(410, { ok: false, reason: 'revoked' });
  if (new Date(data.expires_at) <= new Date()) {
    return json(410, { ok: false, reason: 'expired' });
  }
  return json(200, { ok: true, expires_at: data.expires_at });
});
