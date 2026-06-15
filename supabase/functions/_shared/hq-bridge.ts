// supabase/functions/_shared/hq-bridge.ts
//
// Portal → HQ webhook bridge. Posts HMAC-SHA256–signed JSON to the HQ
// portal-progress-webhook endpoint. HQ verifies the signature against
// PORTAL_WEBHOOK_SECRET (shared with the portal as PORTAL_WEBHOOK_SECRET).
//
// Mirrors the HQ-side helper at awesome-agent-logic/supabase/functions/_shared/hmac.ts
// so signatures match byte-for-byte.
//
// Env vars (Supabase function secrets):
//   - HQ_PROGRESS_WEBHOOK_URL   e.g. https://ygcpcefwtrcdutrjkfik.supabase.co/functions/v1/portal-progress-webhook
//   - PORTAL_WEBHOOK_SECRET     shared secret with HQ (HMAC body auth)
//   - HQ_ANON_KEY               HQ project anon/publishable JWT — required
//                               to pass HQ's Supabase API gateway. The
//                               gateway demands a valid project apikey on
//                               every call, even when verify_jwt=false at
//                               the function level. HMAC over body remains
//                               the actual auth for our function body.
//                               Discovered 2026-06-14 during smoke test —
//                               without this header the gateway returned
//                               UNAUTHORIZED_NO_AUTH_HEADER before the
//                               function ever ran.

// deno-lint-ignore-file no-explicit-any

const HQ_URL = Deno.env.get('HQ_PROGRESS_WEBHOOK_URL') ?? '';
const SECRET = Deno.env.get('PORTAL_WEBHOOK_SECRET') ?? '';
const HQ_ANON_KEY = Deno.env.get('HQ_ANON_KEY') ?? '';

async function hmacSign(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export interface HqBridgeResult {
  ok: boolean;
  status: number;
  body: string;
  error?: string;
}

/**
 * POST a signed JSON payload to the HQ portal-progress-webhook.
 * Returns {ok:false} with diagnostic info on any failure — caller decides retry.
 *
 * Required env: HQ_PROGRESS_WEBHOOK_URL, PORTAL_WEBHOOK_SECRET, HQ_ANON_KEY.
 */
export async function postToHq(payload: Record<string, unknown>): Promise<HqBridgeResult> {
  if (!HQ_URL) return { ok: false, status: 0, body: '', error: 'HQ_PROGRESS_WEBHOOK_URL not set' };
  if (!SECRET) return { ok: false, status: 0, body: '', error: 'PORTAL_WEBHOOK_SECRET not set' };
  if (!HQ_ANON_KEY) return { ok: false, status: 0, body: '', error: 'HQ_ANON_KEY not set' };

  const raw = JSON.stringify(payload);
  const sig = await hmacSign(SECRET, raw);

  try {
    const resp = await fetch(HQ_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // HMAC over the raw body — HQ's real auth check.
        'x-portal-signature': sig,
        // Required by HQ's Supabase API gateway even with verify_jwt=false.
        // Both headers needed: Supabase accepts either, but some configs
        // require apikey AND a Bearer Authorization. Sending both is safe.
        'apikey': HQ_ANON_KEY,
        'Authorization': `Bearer ${HQ_ANON_KEY}`,
      },
      body: raw,
    });
    const text = await resp.text();
    return { ok: resp.ok, status: resp.status, body: text };
  } catch (e) {
    return { ok: false, status: 0, body: '', error: (e as Error).message ?? 'fetch_failed' };
  }
}
