// Edge Function: sf-webhook
//
// Inbound webhook called by Salesforce Flows for events that affect the
// retailer portal. Verified with an HMAC-SHA256 signature header.
//
// Supported events:
//   launch_date_confirmed    — ops set a launch date. Unlock the account.
//   launch_rescheduled       — ops changed the date. Update launch_status.
//   launch_cancelled         — ops cancelled. Move back to in_setup / churned.
//   nudge_sent               — biweekly nudge email was dispatched to a
//                              deferred Step 7 retailer. Increment counter.
//   step_reopened            — ops reopened a step for edits (e.g. after
//                              failed sample deposit). Removes completion marker.
//
// Security: every request must include `X-NST-Signature: sha256=<hex>` where
// the hex is HMAC-SHA256 of the raw body using the `SF_WEBHOOK_SECRET` env.
// Uses a constant-time compare to avoid timing attacks.

// deno-lint-ignore-file no-explicit-any
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';

type WebhookEvent =
  | 'launch_date_confirmed'
  | 'launch_rescheduled'
  | 'launch_cancelled'
  | 'nudge_sent'
  | 'step_reopened';

interface WebhookPayload {
  event: WebhookEvent;
  sfdc_account_id: string;
  launch_date?: string; // YYYY-MM-DD
  step_id?: number;
  actor_email?: string;
  reason?: string;
  metadata?: Record<string, unknown>;
}

async function verifySignature(
  rawBody: string,
  headerValue: string | null,
  secret: string,
): Promise<boolean> {
  if (!headerValue?.startsWith('sha256=')) return false;
  const expectedHex = headerValue.slice('sha256='.length);

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(rawBody),
  );
  const computedHex = Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  // Constant-time compare.
  if (computedHex.length !== expectedHex.length) return false;
  let diff = 0;
  for (let i = 0; i < computedHex.length; i++) {
    diff |= computedHex.charCodeAt(i) ^ expectedHex.charCodeAt(i);
  }
  return diff === 0;
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') {
    return new Response('method not allowed', { status: 405 });
  }

  const secret = Deno.env.get('SF_WEBHOOK_SECRET');
  if (!secret) {
    return new Response('misconfigured', { status: 500 });
  }

  const raw = await req.text();
  const sigHeader = req.headers.get('X-NST-Signature');
  const ok = await verifySignature(raw, sigHeader, secret);
  if (!ok) {
    return new Response('invalid signature', { status: 401 });
  }

  let body: WebhookPayload;
  try {
    body = JSON.parse(raw);
  } catch {
    return new Response('invalid json', { status: 400 });
  }
  if (!body.event || !body.sfdc_account_id) {
    return new Response('missing fields', { status: 400 });
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  const accountId = body.sfdc_account_id;

  switch (body.event) {
    case 'launch_date_confirmed': {
      if (!body.launch_date) {
        return new Response('missing launch_date', { status: 400 });
      }
      await supabase.from('launch_status').upsert(
        {
          sfdc_account_id: accountId,
          status: 'launch_scheduled',
          launch_date: body.launch_date,
          locked: false,
        },
        { onConflict: 'sfdc_account_id' },
      );
      break;
    }

    case 'launch_rescheduled': {
      if (!body.launch_date) {
        return new Response('missing launch_date', { status: 400 });
      }
      await supabase
        .from('launch_status')
        .update({
          launch_date: body.launch_date,
          status: 'launch_scheduled',
        })
        .eq('sfdc_account_id', accountId);
      break;
    }

    case 'launch_cancelled': {
      await supabase
        .from('launch_status')
        .update({
          launch_date: null,
          status: 'in_setup',
          locked: true,
        })
        .eq('sfdc_account_id', accountId);
      break;
    }

    case 'nudge_sent': {
      // RPC-free UPSERT: increment nudge_count and stamp last_nudge_sent_at.
      await supabase.rpc('increment_nudge', { p_account_id: accountId });
      break;
    }

    case 'step_reopened': {
      if (body.step_id == null) {
        return new Response('missing step_id', { status: 400 });
      }
      // We don't delete the submission — just remove the completion marker
      // on the client side by emitting an audit event the app will observe.
      // The next retailer load re-reads step_submissions and draft state.
      break;
    }

    default:
      return new Response('unknown event', { status: 400 });
  }

  await supabase.from('audit_log').insert({
    sfdc_account_id: accountId,
    actor_type: 'sfdc',
    action: body.event,
    metadata: {
      actor_email: body.actor_email,
      reason: body.reason,
      ...(body.metadata ?? {}),
      launch_date: body.launch_date,
      step_id: body.step_id,
    },
  });

  return new Response(JSON.stringify({ ok: true }), {
    headers: { 'Content-Type': 'application/json' },
  });
});
