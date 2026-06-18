// supabase/functions/send-kickoff-email/index.ts
//
// Sends the post-Step-1 kickoff email to a retailer. Triggered server-side
// from the email_queue table (populated by a DB trigger on step_submissions
// when step_number=1). pg_cron drains the queue every minute, same pattern
// as sf-sync.
//
// Auth model: deployed with verify_jwt=false (matches sf-sync). This
// function is invoked server-side by pg_cron via pg_net.http_post with
// no auth header. Optionally, callers may include a shared
// X-Internal-Secret header matched against KICKOFF_INTERNAL_SECRET; if
// set, the header is required. The function never reflects user input
// beyond what's in retailer_onboardings, which is itself populated
// only by service-role inserts.
//
// Env vars (Supabase function secrets):
//   - RESEND_API_KEY                Resend secret key
//   - RESEND_FROM_EMAIL             "NST Operations <onboarding@nationalsecuretransport.com>"
//   - RESEND_REPLY_TO               "onboarding@nationalsecuretransport.com"
//   - PORTAL_BASE_URL               "https://onboard.nationalsecuretransport.com"
//   - KICKOFF_INTERNAL_SECRET       (optional) shared secret if you want auth
//   - SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY  (auto-injected)
//
// Request shapes supported:
//   POST {}                        — drain mode, picks up to 10 queued rows
//   POST { onboardingId: "uuid" }  — single-shot mode (manual replay / testing)
//
// Response: { processed: number, results: Array<{ id, status, error? }> }

// deno-lint-ignore-file no-explicit-any
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { renderKickoff, type KickoffVars } from '../_shared/email-templates/render.ts';

const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY') ?? '';
const FROM_EMAIL =
  Deno.env.get('RESEND_FROM_EMAIL') ??
  'NST Operations <onboarding@nationalsecuretransport.com>';
const REPLY_TO =
  Deno.env.get('RESEND_REPLY_TO') ?? 'onboarding@nationalsecuretransport.com';
const PORTAL_BASE_URL =
  Deno.env.get('PORTAL_BASE_URL') ?? 'https://onboard.nationalsecuretransport.com';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const INTERNAL_SECRET = Deno.env.get('KICKOFF_INTERNAL_SECRET') ?? '';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

interface OnboardingRow {
  id: string;
  retailer_email: string;
  retailer_first_name: string | null;
  retailer_last_name: string | null;
  store_name: string | null;
  language: string | null;
  current_step: number | null;
  status: string | null;
}

interface QueueRow {
  id: string;
  onboarding_id: string;
  template_key: string;
  status: string;
  attempts: number;
  max_attempts: number;
  next_run_at: string;
}

/**
 * Earliest pickup date = today + 10 calendar days, formatted in the
 * retailer's locale. Mirrors the floor enforced in Step 7's date picker.
 */
function earliestPickupHuman(language: 'en' | 'es'): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 10);
  const locale = language === 'es' ? 'es-US' : 'en-US';
  return d.toLocaleDateString(locale, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    timeZone: 'America/New_York',
  });
}

function buildKickoffVars(o: OnboardingRow): KickoffVars {
  const language: 'en' | 'es' = o.language === 'es' ? 'es' : 'en';
  const firstName = (o.retailer_first_name ?? '').trim() || 'there';
  const storefrontName = (o.store_name ?? '').trim() || 'your store';
  return {
    contactFirstName: firstName,
    storefrontName,
    resumeUrl: `${PORTAL_BASE_URL}/`,
    earliestPickupHuman: earliestPickupHuman(language),
    supportPhone: undefined, // wire when ops gives us a real number
    language,
  };
}

async function sendOne(
  admin: ReturnType<typeof createClient>,
  queueId: string,
  onboardingId: string,
): Promise<{ id: string; status: 'sent' | 'failed' | 'skipped'; error?: string }> {
  // Mark running so concurrent drains don't double-send. We do a
  // read-then-CAS-style update keyed on status='pending' so a second
  // worker that beat us to the row is a no-op.
  const { data: claimed } = await admin
    .from('email_queue')
    .select('attempts')
    .eq('id', queueId)
    .eq('status', 'pending')
    .maybeSingle();
  if (!claimed) {
    return { id: queueId, status: 'skipped', error: 'already_claimed' };
  }
  const nextAttempts = ((claimed.attempts as number | undefined) ?? 0) + 1;
  const { error: claimErr } = await admin
    .from('email_queue')
    .update({ status: 'running', attempts: nextAttempts })
    .eq('id', queueId)
    .eq('status', 'pending');
  if (claimErr) {
    return { id: queueId, status: 'skipped', error: 'claim_failed' };
  }

  // Load the onboarding.
  const { data: onb, error: onbErr } = await admin
    .from('retailer_onboardings')
    .select(
      'id, retailer_email, retailer_first_name, retailer_last_name, store_name, language, current_step, status',
    )
    .eq('id', onboardingId)
    .maybeSingle<OnboardingRow>();

  if (onbErr || !onb) {
    await admin
      .from('email_queue')
      .update({
        status: 'failed',
        last_error: `onboarding_not_found: ${onbErr?.message ?? 'no row'}`,
      })
      .eq('id', queueId);
    return { id: queueId, status: 'failed', error: 'onboarding_not_found' };
  }

  if (!onb.retailer_email) {
    await admin
      .from('email_queue')
      .update({ status: 'failed', last_error: 'missing_retailer_email' })
      .eq('id', queueId);
    return { id: queueId, status: 'failed', error: 'missing_retailer_email' };
  }

  const vars = buildKickoffVars(onb);
  const { subject, html } = renderKickoff(vars);

  // Audit row up-front so we have a record even if Resend hangs.
  const { data: logRow, error: logErr } = await admin
    .from('email_log')
    .insert({
      onboarding_id: onb.id,
      recipient_email: onb.retailer_email,
      template_key: 'kickoff_step1',
      subject,
      language: vars.language,
      status: 'pending',
    })
    .select('id')
    .single();
  if (logErr) {
    console.error('[send-kickoff-email] email_log insert failed', logErr);
  }
  const logId = logRow?.id as string | undefined;

  let resendId: string | null = null;
  let errorReason: string | null = null;

  try {
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${RESEND_API_KEY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        from: FROM_EMAIL,
        to: [onb.retailer_email],
        reply_to: REPLY_TO,
        subject,
        html,
        tags: [
          { name: 'category', value: 'kickoff_step1' },
          { name: 'onboarding_id', value: onb.id },
          { name: 'language', value: vars.language },
        ],
      }),
    });
    const respBody: any = await resp.json().catch(() => ({}));
    if (resp.ok && respBody.id) {
      resendId = respBody.id as string;
    } else {
      const reason: string = respBody?.name ?? respBody?.message ?? 'unknown';
      errorReason = reason.toLowerCase().includes('invalid')
        ? 'invalid_email'
        : reason.toLowerCase().includes('bounce')
          ? 'mailbox_does_not_exist'
          : `provider_error:${reason.slice(0, 80)}`;
    }
  } catch (e) {
    errorReason = `network_error:${(e as Error).message?.slice(0, 80) ?? 'unknown'}`;
    console.error('[send-kickoff-email] resend call failed', e);
  }

  const accepted = resendId !== null;
  const sentAt = new Date().toISOString();

  if (logId) {
    await admin
      .from('email_log')
      .update({
        resend_message_id: resendId,
        status: accepted ? 'sent' : 'failed',
        bounced_reason: errorReason,
        sent_at: accepted ? sentAt : null,
      })
      .eq('id', logId);
  }

  if (accepted) {
    await admin
      .from('email_queue')
      .update({ status: 'succeeded', last_error: null })
      .eq('id', queueId);
    return { id: queueId, status: 'sent' };
  } else {
    // Retry up to max_attempts; otherwise mark failed.
    const { data: cur } = await admin
      .from('email_queue')
      .select('attempts, max_attempts')
      .eq('id', queueId)
      .maybeSingle();
    const attempts = (cur?.attempts as number | undefined) ?? 1;
    const maxAttempts = (cur?.max_attempts as number | undefined) ?? 5;
    const nextStatus = attempts >= maxAttempts ? 'failed' : 'pending';
    const backoffSec = Math.min(60 * Math.pow(2, attempts), 3600);
    await admin
      .from('email_queue')
      .update({
        status: nextStatus,
        last_error: errorReason,
        next_run_at: new Date(Date.now() + backoffSec * 1000).toISOString(),
      })
      .eq('id', queueId);
    return { id: queueId, status: 'failed', error: errorReason ?? 'unknown' };
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return json(204, {});
  if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' });

  // Optional shared-secret gate. Match sf-sync's open posture by default;
  // if KICKOFF_INTERNAL_SECRET is set in function env, require it.
  if (INTERNAL_SECRET) {
    const provided = req.headers.get('x-internal-secret') ?? '';
    if (provided !== INTERNAL_SECRET) {
      return json(403, { error: 'forbidden' });
    }
  }

  if (!RESEND_API_KEY) {
    return json(500, { error: 'missing_resend_api_key' });
  }

  const admin = createClient(SUPABASE_URL, SERVICE_KEY);

  let body: { onboardingId?: string } = {};
  try {
    const text = await req.text();
    if (text) body = JSON.parse(text);
  } catch {
    return json(400, { error: 'invalid_json' });
  }

  // Single-shot mode: synthesize a queue row for an onboardingId.
  if (body.onboardingId) {
    const { data: existing } = await admin
      .from('email_queue')
      .select('id')
      .eq('onboarding_id', body.onboardingId)
      .eq('template_key', 'kickoff_step1')
      .in('status', ['pending', 'running'])
      .maybeSingle();

    let queueId: string;
    if (existing?.id) {
      queueId = existing.id as string;
    } else {
      const { data: ins, error: insErr } = await admin
        .from('email_queue')
        .insert({
          onboarding_id: body.onboardingId,
          template_key: 'kickoff_step1',
          status: 'pending',
        })
        .select('id')
        .single();
      if (insErr || !ins) {
        return json(500, { error: 'enqueue_failed', detail: insErr?.message });
      }
      queueId = ins.id as string;
    }

    const result = await sendOne(admin, queueId, body.onboardingId);
    return json(result.status === 'sent' ? 200 : 502, {
      processed: 1,
      results: [result],
    });
  }

  // Drain mode: pick up to 10 due, ready rows.
  const { data: due, error: dueErr } = await admin
    .from('email_queue')
    .select('id, onboarding_id, template_key, status, attempts, max_attempts, next_run_at')
    .eq('template_key', 'kickoff_step1')
    .eq('status', 'pending')
    .lte('next_run_at', new Date().toISOString())
    .order('next_run_at', { ascending: true })
    .limit(10);

  if (dueErr) {
    return json(500, { error: 'queue_read_failed', detail: dueErr.message });
  }

  const rows = (due ?? []) as QueueRow[];
  const results: Array<Awaited<ReturnType<typeof sendOne>>> = [];
  for (const r of rows) {
    results.push(await sendOne(admin, r.id, r.onboarding_id));
  }

  return json(200, { processed: results.length, results });
});
