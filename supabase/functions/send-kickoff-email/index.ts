// supabase/functions/send-kickoff-email/index.ts
//
// v12 (2026-06-14): DECOMMISSIONED. The kickoff email no longer fires from
// Step 1 submission. HQ now owns the intro/kickoff email — admin clicks
// "Send Intro Email" inside the HQ console, which calls intro-email-send
// (Gmail via onboarding@nationalsecuretransport.com).
//
// This stub still drains email_queue rows for template_key='kickoff_step1'
// by marking them 'cancelled' so the table doesn't keep accumulating
// pending rows from the Step 1 DB trigger (the trigger is being removed in
// the same migration that ships this function).
//
// Endpoints:
//   POST {}                  drain mode — marks up to 50 pending kickoff
//                            rows as 'cancelled' and returns the count.
//   POST { mode: "ping" }    health check — always returns ok.
//   POST { onboardingId }    single-shot — refuses (returns 410 Gone) so
//                            any caller still hitting this learns it's dead.
//
// All SF / Resend / template machinery has been removed.

// deno-lint-ignore-file no-explicit-any
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const INTERNAL_SECRET = Deno.env.get('KICKOFF_INTERNAL_SECRET') ?? '';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

Deno.serve(async (req) => {
  const startedAt = Date.now();
  if (req.method === 'OPTIONS') return json(204, {});
  if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' });

  if (INTERNAL_SECRET) {
    const provided = req.headers.get('x-internal-secret') ?? '';
    if (provided !== INTERNAL_SECRET) return json(403, { error: 'forbidden' });
  }

  let body: { mode?: string; onboardingId?: string } = {};
  try {
    const text = await req.text();
    if (text) body = JSON.parse(text);
  } catch {
    return json(400, { error: 'invalid_json' });
  }

  if (body.mode === 'ping') {
    return json(200, {
      ok: true,
      decommissioned: true,
      note: 'kickoff email moved to HQ intro-email-send; this function only cancels stale queue rows',
      duration_ms: Date.now() - startedAt,
    });
  }

  if (body.onboardingId) {
    return json(410, {
      error: 'kickoff_email_decommissioned',
      detail:
        "Portal no longer sends kickoff emails. Trigger the intro email from HQ (NST → Pending → Send Intro Email).",
    });
  }

  // Drain mode — flush stale pending kickoff rows so they don't sit forever.
  // 'dead' is the terminal-failure value in email_queue_status
  // (enum is pending|running|succeeded|failed|dead — no 'cancelled').
  const admin = createClient(SUPABASE_URL, SERVICE_KEY);
  const { data: cancelled, error: cancelErr } = await admin
    .from('email_queue')
    .update({
      status: 'dead',
      last_error: 'decommissioned_2026-06-14: kickoff moved to HQ intro-email-send',
    })
    .eq('template_key', 'kickoff_step1')
    .in('status', ['pending', 'failed'])
    .select('id')
    .limit(50);
  if (cancelErr) {
    console.error('[send-kickoff-email] cancel sweep failed', cancelErr);
    return json(500, { error: 'cancel_failed', detail: cancelErr.message });
  }

  return json(200, {
    processed: cancelled?.length ?? 0,
    decommissioned: true,
    duration_ms: Date.now() - startedAt,
  });
});
