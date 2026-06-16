// Edge Function: notify-hq
//
// Drains hq_sync_outbox and pushes events to HQ's portal-progress-webhook.
// Runs on a 30-second pg_cron and is also invocable ad-hoc to flush after
// a step submission. Outbox model (vs. firing inline) means a slow or down
// HQ never blocks a retailer's step submission, and we get free retry +
// dead-letter handling.
//
// Auth: verify_jwt=false. The trust boundary is the HMAC signature we
// produce on every outbound POST, plus the fact that this only drains
// outbox rows that the trigger already gated on a real submission.
//
// Wire schema (matches HQ's portal-progress-webhook expectations):
//   - x-portal-signature: hex(HMAC-SHA256(PORTAL_WEBHOOK_SECRET, rawBody))
//   - body: { event, salesforce_opportunity_id, salesforce_account_id,
//            salesforce_contact_id, step_id, step_name, submitted_at,
//            field_snapshot: {...per-step keys HQ knows...},
//            completion: { current_step, completed_steps, status } }

// deno-lint-ignore-file no-explicit-any
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { hmacSign } from '../_shared/hmac.ts';

const HQ_WEBHOOK_URL = Deno.env.get('HQ_PROGRESS_WEBHOOK_URL');
const PORTAL_WEBHOOK_SECRET = Deno.env.get('PORTAL_WEBHOOK_SECRET');

const BATCH_SIZE = 25;
const BACKOFF_SECONDS = [30, 120, 600, 1800, 3600]; // 30s → 2m → 10m → 30m → 1h

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

/**
 * Build the per-step field snapshot HQ's portal-progress-webhook expects.
 * Step keys mirror what HQ's SCALAR_FIELDS/JSONB_FIELDS map handles. Banking
 * (step 3) is masked: last-4 only — never full numbers.
 */
function buildFieldSnapshot(stepNumber: number, p: any): Record<string, unknown> {
  if (!p || typeof p !== 'object') return {};
  switch (stepNumber) {
    case 1: {
      const primary = p.primaryContact ?? {};
      const boh = p.bohManager ?? {};
      return {
        legal_entity_name: p.legalName ?? p.storefrontName ?? null,
        storefront_name: p.storefrontName ?? null,
        dba: p.dba ?? p.storefrontName ?? null,
        address_line_1: p.street ?? null,
        address_line_2: p.suite ?? null,
        city: p.city ?? null,
        state: p.state ?? null,
        zip: p.zip ?? null,
        phone: primary.phone ?? null,
        website: p.website ?? null,
        hours: p.hours ?? {},
        owner_contact: primary && (primary.name || primary.email || primary.phone)
          ? { name: primary.name ?? null, email: primary.email ?? null, phone: primary.phone ?? null }
          : null,
        manager_contact: boh && (boh.name || boh.email || boh.phone)
          ? { name: boh.name ?? null, email: boh.email ?? null, phone: boh.phone ?? null }
          : null,
      };
    }
    case 2:
      return {
        safe_type: p.hasSmartSafe === 'yes' ? 'smart_safe' : (p.storageMethod ?? null),
        safe_make: p.safeMake ?? null,
        safe_model: p.safeModel ?? null,
        safe_location: p.storageMethodOther || p.storageMethod || null,
        provisional_credit_eligible:
          p.provisionalCredit === true || p.provisionalCredit === 'yes',
        key_holders: p.keyHolders ?? [],
      };
    case 3: {
      // MASKED: never include full account/routing in the snapshot.
      const fullAccount = p.accountNumber ?? p.account_number ?? null;
      const fullRouting = p.routingNumber ?? p.routing_number ?? null;
      const accountLast4 =
        p.accountLast4 ?? (fullAccount ? String(fullAccount).slice(-4) : null);
      const routingLast4 =
        p.routingLast4 ?? (fullRouting ? String(fullRouting).slice(-4) : null);
      return {
        bank_name: p.bankName ?? null,
        account_type: p.accountType ?? null,
        name_on_account: p.signerName ?? p.nameOnAccount ?? null,
        routing_last_4: routingLast4,
        account_last_4: accountLast4,
      };
    }
    case 4:
      return {
        sample_deposit: {
          date: p.date ?? null,
          bag_number: p.bagNumber ?? null,
          total: p.amount ?? p.total ?? null,
          denominations: p.denominations ?? {},
        },
      };
    case 5:
      return {
        sample_change_order: {
          delivery_date: p.deliveryDate ?? null,
          total: p.total ?? null,
          rolls: p.rolls ?? {},
          bills: p.bills ?? {},
        },
      };
    case 6:
      return {
        invoicing_contact: {
          name: p.contactName ?? null,
          email: p.contactEmail ?? null,
        },
      };
    case 7:
      return {
        first_pickup: {
          deferred: !!p.deferred,
          preferred_date: p.deferred ? null : (p.preferredDate ?? null),
          service_days: p.serviceDays ?? [],
          frequency: p.frequency ?? null,
          time_window: p.timeWindow ?? null,
          driver_notes: p.driverNotes ?? null,
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

Deno.serve(async (_req) => {
  if (!HQ_WEBHOOK_URL || !PORTAL_WEBHOOK_SECRET) {
    return json(500, {
      error: 'env_not_configured',
      hq_url_present: !!HQ_WEBHOOK_URL,
      secret_present: !!PORTAL_WEBHOOK_SECRET,
    });
  }

  const startedAt = Date.now();
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  // Claim a batch of due, non-dead jobs by flipping status -> 'sending'.
  // We claim, then re-select with the new status to dodge anyone else doing the same.
  const { data: claimed, error: claimErr } = await supabase
    .from('hq_sync_outbox')
    .update({ status: 'sending' })
    .lte('next_run_at', new Date().toISOString())
    .in('status', ['pending', 'failed'])
    .select('*')
    .limit(BATCH_SIZE);

  if (claimErr) {
    return json(500, { error: claimErr.message });
  }
  const jobs = claimed ?? [];
  if (jobs.length === 0) {
    return json(200, { processed: 0, duration_ms: Date.now() - startedAt });
  }

  const results: Array<{ id: string; status: string; error?: string }> = [];

  for (const job of jobs) {
    const attemptStartedAt = Date.now();
    let fieldSnapshot: Record<string, unknown> = {};
    let completion = {
      current_step: 0,
      completed_steps: [] as number[],
      status: 'in_progress' as string,
    };

    if (job.event === 'step_submitted' && job.step_id) {
      // Hydrate snapshot from the original step_submissions row.
      const subId = (job.payload as any)?.submission_id as string | undefined;
      if (subId) {
        const { data: sub } = await supabase
          .from('step_submissions')
          .select('submitted_data, onboarding_id')
          .eq('id', subId)
          .maybeSingle();
        if (sub) {
          fieldSnapshot = buildFieldSnapshot(job.step_id, sub.submitted_data ?? {});
        }
      }

      // Completion summary: read all submissions for this onboarding.
      const onboardingId = (job.payload as any)?.onboarding_id as string | undefined;
      if (onboardingId) {
        const { data: allSubs } = await supabase
          .from('step_submissions')
          .select('step_number')
          .eq('onboarding_id', onboardingId);
        const completedSteps = Array.from(
          new Set((allSubs ?? []).map((s: any) => s.step_number as number)),
        ).sort((a, b) => a - b);
        const maxStep = completedSteps.length ? Math.max(...completedSteps) : 0;
        completion = {
          current_step: Math.min(maxStep + 1, 7),
          completed_steps: completedSteps,
          status: completedSteps.length >= 7 ? 'completed' : 'in_progress',
        };
      }
    } else if (job.event === 'onboarding_completed') {
      // Pull final completed_steps from step_submissions.
      const onboardingId = (job.payload as any)?.onboarding_id as string | undefined;
      if (onboardingId) {
        const { data: allSubs } = await supabase
          .from('step_submissions')
          .select('step_number')
          .eq('onboarding_id', onboardingId);
        const completedSteps = Array.from(
          new Set((allSubs ?? []).map((s: any) => s.step_number as number)),
        ).sort((a, b) => a - b);
        completion = {
          current_step: 7,
          completed_steps: completedSteps,
          status: 'completed',
        };
      }
    }

    const body = JSON.stringify({
      event: job.event,
      salesforce_opportunity_id: job.sfdc_opportunity_id,
      salesforce_account_id: job.sfdc_account_id,
      salesforce_contact_id: job.sfdc_contact_id,
      step_id: job.step_id,
      step_name: job.step_id ? STEP_NAMES[job.step_id] : null,
      submitted_at:
        (job.payload as any)?.submitted_at ?? new Date().toISOString(),
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
            attempts: (job.attempts ?? 0) + 1,
          })
          .eq('id', job.id);

        await supabase.from('hq_sync_log').insert({
          outbox_id: job.id,
          event: job.event,
          sfdc_opportunity_id: job.sfdc_opportunity_id,
          attempt: (job.attempts ?? 0) + 1,
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
      const nextAttempt = (job.attempts ?? 0) + 1;
      const dead = nextAttempt >= (job.max_attempts ?? 5);
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

      results.push({
        id: job.id,
        status: dead ? 'dead' : 'failed',
        error: (err as Error).message.slice(0, 200),
      });
    }
  }

  return json(200, {
    processed: jobs.length,
    results,
    duration_ms: Date.now() - startedAt,
  });
});
