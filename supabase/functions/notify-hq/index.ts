// Edge Function: notify-hq
//
// Drains hq_sync_outbox and pushes events to HQ's portal-progress-webhook.
// Runs on a 30-second pg_cron and is also invocable ad-hoc to flush after
// a step submission. Outbox model (vs. firing inline) means a slow or down
// HQ never blocks a retailer's step submission, and we get free retry +
// dead-letter handling.
//
// Auth: deployed with verify_jwt=false. Cron jobs send `x-cron-secret`
// against the existing SALESFORCE_CRON_SECRET (we reuse the same secret
// since it's the same trust boundary — server-side cron driver).

// deno-lint-ignore-file no-explicit-any
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { hmacSign } from '../_shared/hmac.ts';

const HQ_WEBHOOK_URL = Deno.env.get('HQ_PROGRESS_WEBHOOK_URL'); // set by Lovable
const PORTAL_WEBHOOK_SECRET = Deno.env.get('PORTAL_WEBHOOK_SECRET');

const BATCH_SIZE = 25;
const BACKOFF_SECONDS = [30, 120, 600, 1800, 3600]; // 30s → 2m → 10m → 30m → 1h

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

/**
 * Build the masked field snapshot for a given step submission. Banking step (3)
 * is the sensitive one — we explicitly never include full routing/account
 * numbers; only `*_last_4` derived columns.
 */
function buildFieldSnapshot(stepId: number, payload: any): Record<string, unknown> {
  switch (stepId) {
    case 1:
      return {
        legal_entity_name: payload.legalEntityName ?? payload.storefrontName ?? null,
        dba: payload.dba ?? null,
        storefront_name: payload.storefrontName ?? null,
        address_line_1: payload.addressLine1 ?? null,
        address_line_2: payload.addressLine2 ?? null,
        city: payload.city ?? null,
        state: payload.state ?? null,
        zip: payload.zip ?? null,
        phone: payload.phone ?? null,
        website: payload.website ?? null,
        hours: payload.hours ?? {},
        owner_contact: payload.ownerContact ?? null,
        manager_contact: payload.managerContact ?? null,
      };
    case 2:
      return {
        safe_type: payload.safeType ?? null,
        safe_make: payload.safeMake ?? null,
        safe_model: payload.safeModel ?? null,
        safe_location: payload.safeLocation ?? null,
        provisional_credit_eligible: !!payload.provisionalCredit,
        key_holders: payload.keyHolders ?? [],
        // Combo is never in the payload — confirmed on-site only.
      };
    case 3: {
      // MASKED. Last-4 only. If the payload accidentally contains full
      // numbers (it shouldn't — the submit-step function masks before
      // persisting), derive last-4 here and drop the rest.
      const fullAccount =
        payload.accountNumber ?? payload.account_number ?? null;
      const fullRouting =
        payload.routingNumber ?? payload.routing_number ?? null;
      const accountLast4 =
        payload.accountLast4 ??
        (fullAccount ? String(fullAccount).slice(-4) : null);
      const routingLast4 =
        payload.routingLast4 ??
        (fullRouting ? String(fullRouting).slice(-4) : null);
      return {
        bank_name: payload.bankName ?? null,
        account_type: payload.accountType ?? null,
        name_on_account: payload.nameOnAccount ?? null,
        routing_last_4: routingLast4,
        account_last_4: accountLast4,
      };
    }
    case 4:
      return {
        sample_deposit: {
          date: payload.date ?? null,
          bag_number: payload.bagNumber ?? null,
          total: payload.total ?? null,
          denominations: payload.denominations ?? {},
        },
      };
    case 5:
      return {
        sample_change_order: {
          delivery_date: payload.deliveryDate ?? null,
          total: payload.total ?? null,
          rolls: payload.rolls ?? {},
          bills: payload.bills ?? {},
        },
      };
    case 6:
      return {
        invoicing_contact: {
          name: payload.contactName ?? null,
          email: payload.contactEmail ?? null,
        },
      };
    case 7:
      return {
        first_pickup: {
          deferred: !!payload.deferred,
          preferred_date: payload.deferred ? null : (payload.preferredDate ?? null),
          service_days: payload.serviceDays ?? [],
          frequency: payload.frequency ?? null,
          time_window: payload.timeWindow ?? null,
          driver_notes: payload.driverNotes ?? null,
        },
      };
    default:
      return {};
  }
}

const STEP_NAMES: Record<number, string> = {
  1: 'profile',
  2: 'safe',
  3: 'banking',
  4: 'deposit',
  5: 'change_order',
  6: 'invoicing',
  7: 'first_pickup',
};

Deno.serve(async (req) => {
  if (!HQ_WEBHOOK_URL || !PORTAL_WEBHOOK_SECRET) {
    return json(500, { error: 'env_not_configured' });
  }

  const startedAt = Date.now();
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  // Claim a batch of due, non-dead jobs.
  const { data: jobs, error: claimErr } = await supabase
    .from('hq_sync_outbox')
    .update({ status: 'sending' })
    .lte('next_run_at', new Date().toISOString())
    .in('status', ['pending', 'failed'])
    .select('*')
    .limit(BATCH_SIZE);

  if (claimErr) {
    return json(500, { error: claimErr.message });
  }
  if (!jobs || jobs.length === 0) {
    return json(200, { processed: 0, duration_ms: Date.now() - startedAt });
  }

  const results: Array<{ id: string; status: string }> = [];

  for (const job of jobs) {
    const attemptStartedAt = Date.now();
    let fieldSnapshot: Record<string, unknown> = {};
    let completion = { current_step: 0, completed_steps: [] as number[], status: 'in_progress' };

    // For step_submitted events, hydrate field_snapshot + completion from
    // the submission + the latest state.
    if (job.event === 'step_submitted' && job.step_id) {
      const { data: sub } = await supabase
        .from('step_submissions')
        .select('payload, submitted_at')
        .eq('id', job.payload.submission_id)
        .maybeSingle();

      if (sub) {
        fieldSnapshot = buildFieldSnapshot(job.step_id, sub.payload ?? {});
      }

      // Compute completion summary from all step_submissions for this account
      const { data: allSubs } = await supabase
        .from('step_submissions')
        .select('step_id')
        .eq('sfdc_account_id', job.sfdc_account_id);

      const completedSteps = Array.from(
        new Set((allSubs ?? []).map((s) => s.step_id)),
      ).sort((a, b) => a - b);
      const maxStep = completedSteps.length ? Math.max(...completedSteps) : 0;
      completion = {
        current_step: Math.min(maxStep + 1, 7),
        completed_steps: completedSteps,
        status: completedSteps.length >= 7 ? 'completed' : 'in_progress',
      };
    }

    const body = JSON.stringify({
      event: job.event,
      salesforce_opportunity_id: job.sfdc_opportunity_id,
      salesforce_account_id: job.sfdc_account_id,
      salesforce_contact_id: job.sfdc_contact_id,
      step_id: job.step_id,
      step_name: job.step_id ? STEP_NAMES[job.step_id] : null,
      submitted_at: job.payload?.submitted_at ?? new Date().toISOString(),
      field_snapshot: fieldSnapshot,
      completion,
    });

    const signature = await hmacSign(PORTAL_WEBHOOK_SECRET, body);

    try {
      const resp = await fetch(HQ_WEBHOOK_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-portal-signature': signature,
        },
        body,
      });

      const durationMs = Date.now() - attemptStartedAt;

      if (resp.ok) {
        await supabase
          .from('hq_sync_outbox')
          .update({
            status: 'succeeded',
            succeeded_at: new Date().toISOString(),
            last_error: null,
          })
          .eq('id', job.id);

        await supabase.from('hq_sync_log').insert({
          outbox_id: job.id,
          event: job.event,
          sfdc_opportunity_id: job.sfdc_opportunity_id,
          attempt: job.attempts + 1,
          http_status: resp.status,
          ok: true,
          duration_ms: durationMs,
        });

        results.push({ id: job.id, status: 'succeeded' });
      } else {
        const text = await resp.text();
        throw new Error(`HQ ${resp.status}: ${text.slice(0, 300)}`);
      }
    } catch (err) {
      const nextAttempt = job.attempts + 1;
      const dead = nextAttempt >= job.max_attempts;
      const backoffSec =
        BACKOFF_SECONDS[Math.min(nextAttempt - 1, BACKOFF_SECONDS.length - 1)];

      await supabase
        .from('hq_sync_outbox')
        .update({
          status: dead ? 'dead' : 'failed',
          attempts: nextAttempt,
          last_error: (err as Error).message.slice(0, 2000),
          next_run_at: dead
            ? new Date().toISOString()
            : new Date(Date.now() + backoffSec * 1000).toISOString(),
        })
        .eq('id', job.id);

      await supabase.from('hq_sync_log').insert({
        outbox_id: job.id,
        event: job.event,
        sfdc_opportunity_id: job.sfdc_opportunity_id,
        attempt: nextAttempt,
        ok: false,
        error: (err as Error).message.slice(0, 2000),
        duration_ms: Date.now() - attemptStartedAt,
      });

      results.push({ id: job.id, status: dead ? 'dead' : 'failed' });
    }
  }

  return json(200, {
    processed: jobs.length,
    results,
    duration_ms: Date.now() - startedAt,
  });
});
