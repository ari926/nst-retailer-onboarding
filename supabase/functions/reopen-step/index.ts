// Edge Function: reopen-step
//
// Called by HQ when an ops user clicks "Reopen step" on the NST Onboarding
// detail page. Marks a step as reopened in step_submissions, fires the
// step_reopened email template to the retailer, and enqueues a webhook
// back to HQ so the HQ stepper UI reflects the reopen.
//
// Auth: HMAC over body using PORTAL_WEBHOOK_SECRET. Deployed verify_jwt=false.
//
// Input:  { salesforce_opportunity_id, step_id, reason, requested_by }
// Output: { ok: true }

// deno-lint-ignore-file no-explicit-any
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { hmacVerify } from '../_shared/hmac.ts';
import { renderStepReopened } from '../_shared/email-templates/render.ts';

const PORTAL_BASE_URL =
  Deno.env.get('PORTAL_BASE_URL') ?? 'https://onboard.nationalsecuretransport.com';
const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY'); // assumed already configured
const FROM_ADDRESS = 'onboarding@nationalsecuretransport.com';

const STEP_NAMES: Record<number, string> = {
  1: 'Profile',
  2: 'Safe & keys',
  3: 'Banking',
  4: 'Sample deposit',
  5: 'Change order',
  6: 'Invoicing',
  7: 'First pickup',
};

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

  let body: any;
  try { body = JSON.parse(rawBody); } catch { return json(400, { error: 'invalid_json' }); }

  const opportunityId = body?.salesforce_opportunity_id as string;
  const stepId = body?.step_id as number;
  const reason = (body?.reason as string ?? '').trim();
  const requestedBy = body?.requested_by as string | undefined;

  if (!opportunityId || !stepId || stepId < 1 || stepId > 7) {
    return json(400, { error: 'invalid_params' });
  }
  if (reason.length < 10) {
    return json(400, { error: 'reason_too_short', detail: 'min 10 chars' });
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  // Find the account + token for this opportunity
  const { data: tokenRow } = await supabase
    .from('onboarding_tokens')
    .select('token, sfdc_account_id, contact_email')
    .eq('sfdc_opportunity_id', opportunityId)
    .is('revoked_at', null)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!tokenRow) return json(404, { error: 'no_active_token' });

  // Find the most recent submission for this step + account
  const { data: sub } = await supabase
    .from('step_submissions')
    .select('id, payload')
    .eq('sfdc_account_id', tokenRow.sfdc_account_id)
    .eq('step_id', stepId)
    .order('submitted_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  // Insert audit row
  await supabase.from('audit_log').insert({
    sfdc_account_id: tokenRow.sfdc_account_id,
    actor_type: 'ops',
    action: `step_${stepId}_reopened`,
    metadata: { reason, requested_by: requestedBy, submission_id: sub?.id ?? null },
  });

  // Enqueue webhook back to HQ so the stepper updates
  await supabase.from('hq_sync_outbox').insert({
    event: 'step_reopened',
    sfdc_account_id: tokenRow.sfdc_account_id,
    sfdc_opportunity_id: opportunityId,
    step_id: stepId,
    payload: { reason, requested_by: requestedBy },
  });

  // Send retailer notification email
  if (RESEND_API_KEY && tokenRow.contact_email) {
    const contactFirstName =
      ((sub?.payload as any)?.ownerContact?.name ?? '').split(' ')[0] ||
      'there';
    const storefrontName =
      ((sub?.payload as any)?.storefrontName as string) ?? 'your store';
    const html = renderStepReopened({
      contactFirstName,
      storefrontName,
      stepName: STEP_NAMES[stepId],
      reason,
      resumeUrl: `${PORTAL_BASE_URL}/?t=${tokenRow.token}&step=${stepId}`,
    });

    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        from: FROM_ADDRESS,
        to: tokenRow.contact_email,
        subject: `Action needed: ${STEP_NAMES[stepId]}`,
        html,
      }),
    });
  }

  return json(200, { ok: true });
});
