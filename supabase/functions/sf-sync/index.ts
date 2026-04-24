// Edge Function: sf-sync
//
// Drains sf_sync_queue and pushes step submissions into Salesforce custom
// objects via Apex REST. Runs on a pg_cron schedule (every 60s) and is also
// invocable ad-hoc for retries.
//
// Auth model: JWT Bearer flow with a connected app. The private key is stored
// as an Edge secret (`SF_PRIVATE_KEY`) and used to sign a JWT assertion
// exchanged for an access token against `https://login.salesforce.com/services/oauth2/token`.
//
// Step-to-object mapping (SFDC Custom Objects, managed package `nst_onboarding__`):
//   1 → nst_onboarding__Store_Profile__c
//   2 → nst_onboarding__Safe_Setup__c
//   3 → nst_onboarding__Banking__c
//   4 → nst_onboarding__Sample_Deposit__c
//   5 → nst_onboarding__Sample_Change_Order__c
//   6 → nst_onboarding__Invoicing_Contact__c
//   7 → nst_onboarding__Pickup_Schedule__c
//
// Security: redact sensitive fields (safe combo NEVER leaves our DB; full
// routing/account numbers hashed before transmission).

// deno-lint-ignore-file no-explicit-any
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';

type StepId = 1 | 2 | 3 | 4 | 5 | 6 | 7;

const STEP_TO_SF_OBJECT: Record<StepId, string> = {
  1: 'nst_onboarding__Store_Profile__c',
  2: 'nst_onboarding__Safe_Setup__c',
  3: 'nst_onboarding__Banking__c',
  4: 'nst_onboarding__Sample_Deposit__c',
  5: 'nst_onboarding__Sample_Change_Order__c',
  6: 'nst_onboarding__Invoicing_Contact__c',
  7: 'nst_onboarding__Pickup_Schedule__c',
};

const BATCH_SIZE = 25;
const BACKOFF_SECONDS = [30, 120, 600, 1800, 3600]; // 30s → 2m → 10m → 30m → 1h

// ---- SF Access Token (cached in-memory per invocation) ---------------------

async function getSalesforceAccessToken(): Promise<{
  access_token: string;
  instance_url: string;
}> {
  const clientId = Deno.env.get('SF_CLIENT_ID');
  const username = Deno.env.get('SF_USERNAME');
  const privateKey = Deno.env.get('SF_PRIVATE_KEY');
  const loginUrl =
    Deno.env.get('SF_LOGIN_URL') ?? 'https://login.salesforce.com';

  if (!clientId || !username || !privateKey) {
    throw new Error('SF credentials missing from env');
  }

  // JWT Bearer assertion (RS256). Uses WebCrypto SubtleCrypto.
  const header = { alg: 'RS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss: clientId,
    sub: username,
    aud: loginUrl,
    exp: now + 180,
  };

  const encode = (obj: unknown) =>
    btoa(JSON.stringify(obj))
      .replace(/=/g, '')
      .replace(/\+/g, '-')
      .replace(/\//g, '_');

  const toSign = `${encode(header)}.${encode(claims)}`;
  const keyData = pemToArrayBuffer(privateKey);
  const key = await crypto.subtle.importKey(
    'pkcs8',
    keyData,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    new TextEncoder().encode(toSign),
  );
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
  const assertion = `${toSign}.${sigB64}`;

  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion,
  });
  const resp = await fetch(`${loginUrl}/services/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`SF token exchange failed: ${resp.status} ${text}`);
  }
  return (await resp.json()) as { access_token: string; instance_url: string };
}

function pemToArrayBuffer(pem: string): ArrayBuffer {
  const b64 = pem
    .replace(/-----BEGIN PRIVATE KEY-----/g, '')
    .replace(/-----END PRIVATE KEY-----/g, '')
    .replace(/\s+/g, '');
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf.buffer;
}

// ---- Payload transforms ----------------------------------------------------

/**
 * Transform retailer-facing payload shapes into SFDC field names.
 * NB: redact secrets here. Safe combos are never in the DB anyway, but we
 * also hash banking account numbers to last-4 before sending to SFDC.
 */
function transformForSf(stepId: StepId, payload: any, accountId: string): any {
  const base = {
    nst_onboarding__Account__c: accountId,
    nst_onboarding__Step_Id__c: stepId,
  };

  switch (stepId) {
    case 1:
      return {
        ...base,
        Name: payload.storefrontName ?? 'Untitled',
        nst_onboarding__DBA__c: payload.dba ?? null,
        nst_onboarding__Address_Line_1__c: payload.addressLine1 ?? null,
        nst_onboarding__Address_Line_2__c: payload.addressLine2 ?? null,
        nst_onboarding__City__c: payload.city ?? null,
        nst_onboarding__State__c: payload.state ?? null,
        nst_onboarding__Zip__c: payload.zip ?? null,
        nst_onboarding__Hours_JSON__c: JSON.stringify(payload.hours ?? {}),
        nst_onboarding__Owner_Name__c: payload.ownerContact?.name ?? null,
        nst_onboarding__Owner_Email__c: payload.ownerContact?.email ?? null,
        nst_onboarding__Owner_Phone__c: payload.ownerContact?.phone ?? null,
        nst_onboarding__Manager_Name__c: payload.managerContact?.name ?? null,
        nst_onboarding__Manager_Email__c: payload.managerContact?.email ?? null,
        nst_onboarding__Manager_Phone__c: payload.managerContact?.phone ?? null,
      };
    case 2:
      return {
        ...base,
        nst_onboarding__Safe_Type__c: payload.safeType ?? null,
        nst_onboarding__Safe_Make__c: payload.safeMake ?? null,
        nst_onboarding__Safe_Model__c: payload.safeModel ?? null,
        nst_onboarding__Safe_Location__c: payload.safeLocation ?? null,
        nst_onboarding__Provisional_Credit_Eligible__c:
          !!payload.provisionalCredit,
        nst_onboarding__Key_Holders_JSON__c: JSON.stringify(
          payload.keyHolders ?? [],
        ),
        // combo is NEVER sent — confirmed in person on site visit
      };
    case 3:
      return {
        ...base,
        nst_onboarding__Bank_Name__c: payload.bankName ?? null,
        nst_onboarding__Account_Type__c: payload.accountType ?? null,
        nst_onboarding__Name_On_Account__c: payload.nameOnAccount ?? null,
        // Only last-4 cross the wire. Full number stays in Supabase vault (PR #14).
        nst_onboarding__Routing_Last_4__c: payload.routingLast4 ?? null,
        nst_onboarding__Account_Last_4__c: payload.accountLast4 ?? null,
      };
    case 4:
      return {
        ...base,
        nst_onboarding__Deposit_Date__c: payload.date ?? null,
        nst_onboarding__Bag_Number__c: payload.bagNumber ?? null,
        nst_onboarding__Total_Amount__c: payload.total ?? null,
        nst_onboarding__Denominations_JSON__c: JSON.stringify(
          payload.denominations ?? {},
        ),
      };
    case 5:
      return {
        ...base,
        nst_onboarding__Delivery_Date__c: payload.deliveryDate ?? null,
        nst_onboarding__Total_Amount__c: payload.total ?? null,
        nst_onboarding__Rolls_JSON__c: JSON.stringify(payload.rolls ?? {}),
        nst_onboarding__Bills_JSON__c: JSON.stringify(payload.bills ?? {}),
      };
    case 6:
      return {
        ...base,
        nst_onboarding__Contact_Name__c: payload.contactName ?? null,
        nst_onboarding__Contact_Email__c: payload.contactEmail ?? null,
      };
    case 7:
      return {
        ...base,
        nst_onboarding__Deferred__c: !!payload.deferred,
        nst_onboarding__Preferred_Date__c: payload.deferred
          ? null
          : (payload.preferredDate ?? null),
        nst_onboarding__Service_Days__c: (payload.serviceDays ?? []).join(';'),
        nst_onboarding__Frequency__c: payload.frequency ?? null,
        nst_onboarding__Time_Window__c: payload.timeWindow ?? null,
        nst_onboarding__Driver_Notes__c: payload.driverNotes ?? null,
      };
  }
}

// ---- Main handler ----------------------------------------------------------

Deno.serve(async (req) => {
  const startedAt = Date.now();
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  // Claim a batch of runnable jobs (SKIP LOCKED prevents parallel workers
  // from picking the same rows).
  const { data: jobs, error: claimErr } = await supabase.rpc('sf_sync_claim', {
    batch_size: BATCH_SIZE,
  });
  if (claimErr) {
    return new Response(
      JSON.stringify({ error: claimErr.message }),
      { status: 500 },
    );
  }
  if (!jobs || jobs.length === 0) {
    return new Response(
      JSON.stringify({ processed: 0, duration_ms: Date.now() - startedAt }),
      { headers: { 'Content-Type': 'application/json' } },
    );
  }

  let token: { access_token: string; instance_url: string };
  try {
    token = await getSalesforceAccessToken();
  } catch (err) {
    // Push all jobs back to pending with error; they'll retry next cycle.
    await supabase
      .from('sf_sync_queue')
      .update({
        status: 'failed',
        last_error: (err as Error).message,
        next_run_at: new Date(Date.now() + 60_000).toISOString(),
      })
      .in(
        'id',
        jobs.map((j: any) => j.id),
      );
    return new Response(
      JSON.stringify({ error: 'sf_auth_failed', detail: (err as Error).message }),
      { status: 502 },
    );
  }

  const results = [] as Array<{ id: string; status: string }>;

  for (const job of jobs) {
    const stepId = job.step_id as StepId;
    const sfObject = STEP_TO_SF_OBJECT[stepId];
    if (!sfObject) {
      await supabase
        .from('sf_sync_queue')
        .update({
          status: 'dead',
          last_error: `Unknown step_id=${stepId}`,
        })
        .eq('id', job.id);
      results.push({ id: job.id, status: 'dead' });
      continue;
    }

    const body = transformForSf(stepId, job.payload, job.sfdc_account_id);
    const url = `${token.instance_url}/services/data/v61.0/sobjects/${sfObject}`;

    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token.access_token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });
      if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`SF ${resp.status}: ${text.slice(0, 300)}`);
      }
      const parsed = (await resp.json()) as { id: string };

      await supabase
        .from('sf_sync_queue')
        .update({
          status: 'succeeded',
          sf_object_id: parsed.id,
          last_error: null,
        })
        .eq('id', job.id);

      await supabase
        .from('step_submissions')
        .update({
          sf_object_id: parsed.id,
          sf_synced_at: new Date().toISOString(),
        })
        .eq('id', job.submission_id);

      await supabase.from('audit_log').insert({
        sfdc_account_id: job.sfdc_account_id,
        actor_type: 'system',
        action: `sf_sync_step_${stepId}_succeeded`,
        metadata: { sf_object_id: parsed.id, sf_object: sfObject },
      });

      results.push({ id: job.id, status: 'succeeded' });
    } catch (err) {
      const nextAttempt = job.attempts + 1;
      const dead = nextAttempt >= job.max_attempts;
      const backoffSec =
        BACKOFF_SECONDS[Math.min(nextAttempt - 1, BACKOFF_SECONDS.length - 1)];
      await supabase
        .from('sf_sync_queue')
        .update({
          status: dead ? 'dead' : 'failed',
          attempts: nextAttempt,
          last_error: (err as Error).message.slice(0, 2000),
          next_run_at: dead
            ? new Date().toISOString()
            : new Date(Date.now() + backoffSec * 1000).toISOString(),
        })
        .eq('id', job.id);

      await supabase.from('audit_log').insert({
        sfdc_account_id: job.sfdc_account_id,
        actor_type: 'system',
        action: `sf_sync_step_${stepId}_${dead ? 'dead' : 'failed'}`,
        metadata: { error: (err as Error).message, attempt: nextAttempt },
      });

      // TODO(ops): when dead, fire Slack alert via ops webhook.
      results.push({ id: job.id, status: dead ? 'dead' : 'failed' });
    }
  }

  return new Response(
    JSON.stringify({
      processed: jobs.length,
      results,
      duration_ms: Date.now() - startedAt,
    }),
    { headers: { 'Content-Type': 'application/json' } },
  );
});
