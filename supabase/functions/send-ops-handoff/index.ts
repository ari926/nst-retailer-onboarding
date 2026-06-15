// supabase/functions/send-ops-handoff/index.ts
//
// v10 (2026-06-14): Email delivery moved to HQ (Gmail via onboarding@).
// Kept: PDF render + SF ContentVersion upload (the PDF is the source of
// truth; HQ pulls the file id for the email attachment via the payload).
// Removed: sendOpsHandoffEmail (SF EmailMessage path).
//
// Drains ops_handoff_jobs (kind='step7_commit_v1'). For each job:
//   1. Load the onboarding row + all step submissions (steps 1–7).
//   2. Render the ops handoff PDF (server-side port of handoffPdf.ts).
//   3. Upload the PDF to SF as a ContentVersion, attached to the Opportunity.
//   4. POST 'ops_handoff_requested' to HQ portal-progress-webhook with the
//      rendered HTML body, subject, recipient/cc, and the PDF (base64) +
//      filename so HQ can attach it to the Gmail send.
//   5. Update the queue row → 'succeeded' with sfdc_content_version_id and
//      the HQ log id (stuffed into sfdc_email_message_id for backward compat),
//      and emit an audit_log row.
//
// Triggered by pg_cron every minute via pg_net.http_post (see migration 0008).
// Also supports POST { onboardingId } for manual replay / E2E testing.
//
// Env vars (Supabase function secrets):
//   - SF_CLIENT_ID, SF_USERNAME, SF_PRIVATE_KEY, SF_LOGIN_URL  (PDF upload)
//   - SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY                  (auto-injected)
//   - HQ_PROGRESS_WEBHOOK_URL                                  HQ webhook URL
//   - PORTAL_WEBHOOK_SECRET                                    shared HMAC secret
//   - OPS_HANDOFF_TO_EMAIL          default 'operations@nationalsecuretransport.com'
//   - OPS_HANDOFF_INTERNAL_SECRET   (optional) shared secret gate

// deno-lint-ignore-file no-explicit-any
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { getSalesforceAccessToken, sfRequest } from './sf-auth.ts';
import { uploadHandoffPdf, getOpportunityOwner } from './sf-attach.ts';
import {
  renderHandoffPdf,
  buildPdfFilename,
  type SubmissionsMap,
} from './render-pdf.ts';
import { postToHq } from '../_shared/hq-bridge.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const TO_EMAIL =
  Deno.env.get('OPS_HANDOFF_TO_EMAIL') ?? 'operations@nationalsecuretransport.com';
const INTERNAL_SECRET = Deno.env.get('OPS_HANDOFF_INTERNAL_SECRET') ?? '';

const BACKOFF_SECONDS = [60, 300, 1200, 3600, 7200]; // 1m → 5m → 20m → 1h → 2h
const BATCH_SIZE = 5;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

interface JobRow {
  id: string;
  onboarding_id: string;
  submission_id: string | null;
  kind: string;
  status: string;
  attempts: number;
  max_attempts: number;
  sfdc_content_version_id: string | null;
  sfdc_content_document_id: string | null;
}

const JOB_SELECT =
  'id, onboarding_id, submission_id, kind, status, attempts, max_attempts, sfdc_content_version_id, sfdc_content_document_id';

interface OnboardingRow {
  id: string;
  sfdc_account_id: string;
  sfdc_opportunity_id: string | null;
  retailer_email: string | null;
  retailer_first_name: string | null;
  retailer_last_name: string | null;
  store_name: string | null;
}

function buildEmailHtml(args: {
  storefrontName: string;
  retailerName: string;
  sfdcAccountId: string;
  opportunityId: string;
  pickupSummary: string;
}): string {
  const teal = '#01696F';
  const ink = '#28251D';
  const muted = '#7A7974';
  const border = '#D4D1CA';
  const bg = '#F9F8F5';

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:${bg};font-family:Helvetica,Arial,sans-serif;color:${ink};">
  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${bg};padding:24px 0;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" border="0" style="background:#ffffff;border:1px solid ${border};border-radius:6px;overflow:hidden;">
        <tr>
          <td style="background:${teal};padding:20px 28px;color:#ffffff;">
            <div style="font-size:11px;letter-spacing:1.5px;text-transform:uppercase;opacity:0.85;">NST Operations</div>
            <div style="font-size:22px;font-weight:bold;margin-top:4px;">New Store Ready for Setup</div>
          </td>
        </tr>
        <tr>
          <td style="padding:28px;">
            <p style="margin:0 0 14px;font-size:15px;line-height:1.55;">
              <strong>${escapeHtml(args.storefrontName)}</strong> has finished onboarding and is ready for the route + safe setup.
              The full handoff packet is attached as a PDF.
            </p>
            <p style="margin:0 0 16px;font-size:14px;line-height:1.55;color:${muted};">
              Submitted by ${escapeHtml(args.retailerName)} · SFDC Account
              <span style="font-family:monospace;font-size:13px;">${escapeHtml(args.sfdcAccountId)}</span>
            </p>

            <div style="border:1px solid ${border};border-radius:5px;padding:16px 18px;margin:18px 0;background:#FAFAF7;">
              <div style="font-size:12px;letter-spacing:1px;text-transform:uppercase;color:${teal};font-weight:bold;margin-bottom:6px;">First pickup</div>
              <div style="font-size:14px;line-height:1.5;color:${ink};">${escapeHtml(args.pickupSummary)}</div>
            </div>

            <div style="font-size:13px;line-height:1.6;color:${ink};">
              <strong style="color:${teal};">What's in the PDF</strong>
              <ul style="margin:6px 0 0;padding-left:18px;color:${ink};">
                <li>Store profile, address, hours, access notes</li>
                <li>Owner + BOH manager contacts</li>
                <li>Safe spec + key-holder list (combo confirmed in person)</li>
                <li>Banking last-4 (full numbers stay in vault)</li>
                <li>Sample deposit + sample change order results</li>
                <li>Invoicing contact + cadence</li>
                <li>First pickup schedule + driver notes</li>
              </ul>
            </div>

            <p style="margin:24px 0 0;font-size:12px;color:${muted};line-height:1.5;">
              Logged on Opportunity <span style="font-family:monospace;">${escapeHtml(args.opportunityId)}</span>.
              Reply-all to loop the rep in. Safe combinations and full banking
              numbers are intentionally never printed.
            </p>
          </td>
        </tr>
      </table>
      <div style="font-size:11px;color:${muted};margin-top:14px;">National Secure Transport · Confidential</div>
    </td></tr>
  </table>
</body></html>`;
}

function escapeHtml(s: string): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildPickupSummary(s7: any | undefined): string {
  if (!s7) return 'Schedule not submitted.';
  if (s7.deferred) return 'Deferred — retailer will confirm date later.';
  const date = s7.preferredDate
    ? new Date(s7.preferredDate).toLocaleDateString('en-US', {
        weekday: 'long',
        month: 'long',
        day: 'numeric',
      })
    : '—';
  const window = s7.timeWindow ?? 'TBD';
  const freq = s7.frequency ?? 'TBD';
  return `${date} · ${window} window · ${freq} ongoing`;
}

/** Base64-encode a Uint8Array (the PDF bytes) for JSON transport. */
function b64encode(bytes: Uint8Array): string {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

async function processJob(
  admin: ReturnType<typeof createClient>,
  job: JobRow,
): Promise<{ id: string; status: string; error?: string }> {
  const nextAttempts = (job.attempts ?? 0) + 1;
  const { error: claimErr } = await admin
    .from('ops_handoff_jobs')
    .update({ status: 'running', attempts: nextAttempts })
    .eq('id', job.id)
    .eq('status', 'pending');
  if (claimErr) {
    return { id: job.id, status: 'skipped', error: 'claim_failed' };
  }

  try {
    // 1) Load onboarding.
    const { data: onb, error: onbErr } = await admin
      .from('retailer_onboardings')
      .select(
        'id, sfdc_account_id, sfdc_opportunity_id, retailer_email, retailer_first_name, retailer_last_name, store_name',
      )
      .eq('id', job.onboarding_id)
      .maybeSingle<OnboardingRow>();
    if (onbErr || !onb) {
      throw new Error(`onboarding_not_found: ${onbErr?.message ?? 'no row'}`);
    }
    if (!onb.sfdc_opportunity_id) {
      throw new Error('opportunity_id_missing');
    }

    // 2) Load all 7 step submissions for this onboarding (latest per step).
    const { data: subs, error: subErr } = await admin
      .from('step_submissions')
      .select('step_number, submitted_data, submitted_at')
      .eq('onboarding_id', job.onboarding_id)
      .order('submitted_at', { ascending: false });
    if (subErr) throw new Error(`step_submissions_read_failed: ${subErr.message}`);

    const submissions: SubmissionsMap = {};
    for (const row of subs ?? []) {
      const step = row.step_number as 1 | 2 | 3 | 4 | 5 | 6 | 7;
      if (submissions[step] === undefined && step >= 1 && step <= 7) {
        (submissions as any)[step] = row.submitted_data ?? {};
      }
    }

    // 3) Render PDF.
    const storefrontName =
      (onb.store_name ?? '').trim() ||
      (submissions[1]?.storefrontName ?? submissions[1]?.legalName ?? '').trim() ||
      'New Store';
    const pdf = renderHandoffPdf(
      {
        storefrontName,
        sfdcAccountId: onb.sfdc_account_id,
        sfdcOpportunityId: onb.sfdc_opportunity_id,
      },
      submissions,
    );
    const filename = buildPdfFilename(storefrontName);

    // 4) Auth to SF.
    const token = await getSalesforceAccessToken();

    // 5) Upload ContentVersion attached to the Opportunity (if not already done).
    let contentVersionId: string;
    let contentDocumentId: string;
    if (job.sfdc_content_document_id && job.sfdc_content_version_id) {
      contentVersionId = job.sfdc_content_version_id;
      contentDocumentId = job.sfdc_content_document_id;
    } else {
      const upload = await uploadHandoffPdf(
        token,
        onb.sfdc_opportunity_id,
        pdf,
        filename,
        `Ops Handoff — ${storefrontName}`,
      );
      contentVersionId = upload.contentVersionId;
      contentDocumentId = upload.contentDocumentId;

      await admin
        .from('ops_handoff_jobs')
        .update({
          sfdc_content_version_id: contentVersionId,
          sfdc_content_document_id: contentDocumentId,
          pdf_byte_size: pdf.byteLength,
        })
        .eq('id', job.id);
    }

    // 6) Look up Opp owner to CC them.
    const owner = await getOpportunityOwner(token, onb.sfdc_opportunity_id);
    const ccList = owner.email ? [owner.email] : [];

    // 7) POST to HQ with the rendered email + PDF attachment.
    const retailerName =
      [onb.retailer_first_name, onb.retailer_last_name]
        .filter(Boolean)
        .join(' ')
        .trim() || (onb.retailer_email ?? 'retailer');

    const subject = `[NST Ops] New store ready — ${storefrontName}`;
    const htmlBody = buildEmailHtml({
      storefrontName,
      retailerName,
      sfdcAccountId: onb.sfdc_account_id,
      opportunityId: onb.sfdc_opportunity_id,
      pickupSummary: buildPickupSummary(submissions[7]),
    });

    const hqResp = await postToHq({
      event: 'ops_handoff_requested',
      salesforce_account_id: onb.sfdc_account_id,
      salesforce_opportunity_id: onb.sfdc_opportunity_id,
      submitted_at: new Date().toISOString(),
      ops_handoff: {
        storefront_name: storefrontName,
        retailer_name: retailerName,
        subject,
        body_html: htmlBody,
        to_address: TO_EMAIL,
        cc_addresses: ccList,
        sfdc_content_version_id: contentVersionId,
        sfdc_content_document_id: contentDocumentId,
        pdf_filename: filename,
        pdf_base64: b64encode(pdf),
        pdf_byte_size: pdf.byteLength,
      },
    });

    if (!hqResp.ok) {
      throw new Error(
        `hq_post_failed:${hqResp.status}:${hqResp.error ?? hqResp.body.slice(0, 200)}`,
      );
    }

    let hqLogId: string | null = null;
    try {
      const parsed = JSON.parse(hqResp.body) as { log_id?: string; outcome?: string };
      hqLogId = parsed.log_id ?? null;
      if (parsed.outcome && parsed.outcome !== 'sent') {
        throw new Error(`hq_outcome:${parsed.outcome}`);
      }
    } catch (e) {
      // Non-fatal JSON parse — HQ returned 200 so trust it.
      if ((e as Error).message?.startsWith('hq_outcome')) throw e;
    }

    // 8) Mark succeeded.
    await admin
      .from('ops_handoff_jobs')
      .update({
        status: 'succeeded',
        sfdc_email_message_id: hqLogId, // repurposed: HQ log_id (was SF EmailMessage Id)
        last_error: null,
      })
      .eq('id', job.id);

    await admin.from('audit_log').insert({
      onboarding_id: onb.id,
      actor_type: 'system',
      event_type: 'ops_handoff_succeeded',
      event_data: {
        sfdc_account_id: onb.sfdc_account_id,
        opportunity_id: onb.sfdc_opportunity_id,
        content_version_id: contentVersionId,
        content_document_id: contentDocumentId,
        hq_log_id: hqLogId,
        pdf_byte_size: pdf.byteLength,
        cc: ccList,
      },
    });

    return { id: job.id, status: 'succeeded' };
  } catch (err) {
    const errorMessage = (err as Error).message ?? 'unknown';

    const { data: cur } = await admin
      .from('ops_handoff_jobs')
      .select('attempts, max_attempts, onboarding_id')
      .eq('id', job.id)
      .maybeSingle();
    const attempts = (cur?.attempts as number | undefined) ?? nextAttempts;
    const maxAttempts = (cur?.max_attempts as number | undefined) ?? 5;
    const dead = attempts >= maxAttempts;
    const backoffSec =
      BACKOFF_SECONDS[Math.min(attempts - 1, BACKOFF_SECONDS.length - 1)];

    await admin
      .from('ops_handoff_jobs')
      .update({
        status: dead ? 'dead' : 'failed',
        last_error: errorMessage.slice(0, 2000),
        next_run_at: dead
          ? new Date().toISOString()
          : new Date(Date.now() + backoffSec * 1000).toISOString(),
      })
      .eq('id', job.id);

    const { data: onb2 } = await admin
      .from('retailer_onboardings')
      .select('sfdc_account_id')
      .eq('id', job.onboarding_id)
      .maybeSingle();
    await admin.from('audit_log').insert({
      onboarding_id: job.onboarding_id,
      actor_type: 'system',
      event_type: dead ? 'ops_handoff_dead' : 'ops_handoff_failed',
      event_data: {
        sfdc_account_id: onb2?.sfdc_account_id ?? null,
        job_id: job.id,
        error: errorMessage,
        attempt: attempts,
      },
    });

    console.error('[send-ops-handoff] job failed', {
      job_id: job.id,
      attempt: attempts,
      error: errorMessage,
    });
    return { id: job.id, status: dead ? 'dead' : 'failed', error: errorMessage };
  }
}

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

  // Ping mode — verify SF auth + HQ bridge env presence.
  if (body.mode === 'ping') {
    try {
      const token = await getSalesforceAccessToken();
      const ok = await sfRequest(token, 'GET', '/sobjects/ContentVersion/describe')
        .then(() => true)
        .catch(() => false);
      return json(200, {
        ok: true,
        instance_url: token.instance_url,
        token_present: !!token.access_token,
        content_version_describe_ok: ok,
        hq_url_present: !!Deno.env.get('HQ_PROGRESS_WEBHOOK_URL'),
        webhook_secret_present: !!Deno.env.get('PORTAL_WEBHOOK_SECRET'),
        duration_ms: Date.now() - startedAt,
      });
    } catch (err) {
      return json(502, { ok: false, error: (err as Error).message });
    }
  }

  const admin = createClient(SUPABASE_URL, SERVICE_KEY);

  // Single-shot mode.
  if (body.onboardingId) {
    const { data: existing } = await admin
      .from('ops_handoff_jobs')
      .select(JOB_SELECT)
      .eq('onboarding_id', body.onboardingId)
      .eq('kind', 'step7_commit_v1')
      .maybeSingle<JobRow>();

    let job: JobRow | null = existing ?? null;
    if (!job) {
      const { data: ins, error: insErr } = await admin
        .from('ops_handoff_jobs')
        .insert({
          onboarding_id: body.onboardingId,
          kind: 'step7_commit_v1',
          status: 'pending',
        })
        .select(JOB_SELECT)
        .single<JobRow>();
      if (insErr || !ins) {
        return json(500, { error: 'enqueue_failed', detail: insErr?.message });
      }
      job = ins;
    } else if (job.status === 'succeeded') {
      await admin
        .from('ops_handoff_jobs')
        .update({ status: 'pending', attempts: 0, last_error: null })
        .eq('id', job.id);
      job.status = 'pending';
      job.attempts = 0;
    }

    const result = await processJob(admin, job);
    return json(result.status === 'succeeded' ? 200 : 502, {
      processed: 1,
      results: [result],
      duration_ms: Date.now() - startedAt,
    });
  }

  // Drain mode.
  const { data: due, error: dueErr } = await admin
    .from('ops_handoff_jobs')
    .select(JOB_SELECT)
    .eq('kind', 'step7_commit_v1')
    .eq('status', 'pending')
    .lte('next_run_at', new Date().toISOString())
    .order('next_run_at', { ascending: true })
    .limit(BATCH_SIZE);
  if (dueErr) return json(500, { error: 'queue_read_failed', detail: dueErr.message });

  const rows = (due ?? []) as JobRow[];
  const results: Array<Awaited<ReturnType<typeof processJob>>> = [];
  for (const r of rows) {
    results.push(await processJob(admin, r));
  }

  return json(200, {
    processed: results.length,
    results,
    duration_ms: Date.now() - startedAt,
  });
});
