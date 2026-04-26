// Edge Function: sf-sync
//
// Drains sf_sync_queue and pushes step submissions into Salesforce via the
// standard REST API (v61.0). Runs on a pg_cron schedule (every 60s) and is
// also invocable ad-hoc for retries.
//
// Auth model: JWT Bearer flow with a connected app. The private key is stored
// as an Edge secret (`SF_PRIVATE_KEY`) and used to sign a JWT assertion
// exchanged for an access token against `https://login.salesforce.com/services/oauth2/token`.
//
// Step-to-SF mapping (standard objects + custom fields, NO managed-package namespace):
//   1 → PATCH Account (Name, Hours_of_Operation_JSON__c, Timezone__c, Store_Type__c,
//         Loading_Dock_Notes__c, NST_Temp_Code__c, Onboarding_Status__c='In Progress')
//       + upsert Owner Contact (Title='Owner', Invoice_Contact__c=false)
//       + upsert Manager Contact (Title='Manager', Invoice_Contact__c=false)
//   2 → POST Safe_Setup__c (child object, Account__c = accountId).
//         Combo_Last_4__c is NEVER sent unless explicitly present. Serial must be unique.
//   3 → PATCH Account (Bank_Account_Last_4__c, Voided_Check_URL__c).
//         Full routing/account numbers are NEVER sent.
//   4 → PATCH Account (Onboarding_Status__c progress flag only)
//   5 → PATCH Account (Onboarding_Status__c progress flag only)
//   6 → POST or PATCH Contact (Invoice_Contact__c=true, FirstName, LastName, Email, AccountId).
//         Cadence NEVER goes to SF.
//   7 → PATCH Account (Pickup_Window__c, Loading_Dock_Notes__c, Onboarding_Status__c='Complete')
//
// Security:
//   - Safe combo (Combo_Last_4__c) is only forwarded if the user explicitly entered it.
//   - Full routing numbers and full bank account numbers are NEVER sent to SF.
//   - No field stripping is left to chance — each handler explicitly selects allowed fields.
//
// Idempotency:
//   - Account PATCHes are inherently idempotent.
//   - Safe_Setup__c and Contact: if step_submissions.sf_object_id is already populated
//     for this job's submission_id, we PATCH the existing SF record instead of POSTing.
//   - Contact upsert also queries by Email + AccountId to deduplicate across retries.

// deno-lint-ignore-file no-explicit-any
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';

type StepId = 1 | 2 | 3 | 4 | 5 | 6 | 7;

const BATCH_SIZE = 25;
const BACKOFF_SECONDS = [30, 120, 600, 1800, 3600]; // 30s → 2m → 10m → 30m → 1h
const SF_API_VERSION = 'v61.0';

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

// ---- SF HTTP helpers --------------------------------------------------------

/** Execute a single SF REST call. Throws on non-2xx. */
async function sfRequest(
  token: { access_token: string; instance_url: string },
  method: 'GET' | 'POST' | 'PATCH',
  path: string,
  body?: object,
): Promise<any> {
  const url = `${token.instance_url}/services/data/${SF_API_VERSION}${path}`;
  const resp = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token.access_token}`,
      'Content-Type': 'application/json',
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (resp.status === 204) return null; // PATCH success with no body
  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`SF ${method} ${path} → ${resp.status}: ${text.slice(0, 400)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// ---- Contact upsert helper --------------------------------------------------

/**
 * Find an existing Contact by Email + AccountId. If found, return its Id.
 * If not found, return null. Caller decides whether to POST or PATCH.
 */
async function findContact(
  token: { access_token: string; instance_url: string },
  email: string,
  accountId: string,
): Promise<string | null> {
  const soql = encodeURIComponent(
    `SELECT Id FROM Contact WHERE Email = '${email.replace(/'/g, "\\'")}' AND AccountId = '${accountId}' LIMIT 1`,
  );
  const result = await sfRequest(token, 'GET', `/query?q=${soql}`);
  if (result?.records?.length > 0) {
    return result.records[0].Id as string;
  }
  return null;
}

/**
 * Upsert a Contact: POST if not found (or no existingId provided), PATCH if found.
 * Returns the SF Contact Id.
 */
async function upsertContact(
  token: { access_token: string; instance_url: string },
  contactFields: {
    FirstName: string;
    LastName: string;
    Email: string;
    Phone?: string;
    Title?: string;
    AccountId: string;
    Invoice_Contact__c?: boolean;
  },
  existingId?: string | null,
): Promise<string> {
  if (existingId) {
    // PATCH existing record — idempotent
    await sfRequest(token, 'PATCH', `/sobjects/Contact/${existingId}`, contactFields);
    return existingId;
  }

  // Query for existing contact to avoid duplicates on retry
  const foundId = await findContact(token, contactFields.Email, contactFields.AccountId);
  if (foundId) {
    await sfRequest(token, 'PATCH', `/sobjects/Contact/${foundId}`, contactFields);
    return foundId;
  }

  // POST new contact
  const created = await sfRequest(token, 'POST', '/sobjects/Contact', contactFields);
  return created.id as string;
}

/** Split a full name string into { firstName, lastName }. */
function splitName(fullName: string): { firstName: string; lastName: string } {
  const parts = (fullName ?? '').trim().split(/\s+/);
  if (parts.length === 1) return { firstName: parts[0], lastName: '' };
  const firstName = parts.slice(0, -1).join(' ');
  const lastName = parts[parts.length - 1];
  return { firstName, lastName };
}

// ---- Payload normalizers (app-shape -> SF-shape) ---------------------------
//
// The frontend persists step submissions verbatim from the React forms.
// Field names there reflect product/UX needs (e.g. primaryContact, bohManager,
// accessNotes), not Salesforce schema. Each normalizer maps from one app
// payload shape to the SF-shaped payload that buildSfOperations consumes.
//
// Keep these PURE — no SF calls, no I/O. They only reshape the object.
// Anything missing from the app form should map to undefined so that PATCHes
// don't accidentally null-out existing SF data.

const US_STATE_TO_TZ: Record<string, string> = {
  AL: 'America/Chicago', AK: 'America/Anchorage', AZ: 'America/Phoenix',
  AR: 'America/Chicago', CA: 'America/Los_Angeles', CO: 'America/Denver',
  CT: 'America/New_York', DE: 'America/New_York', DC: 'America/New_York',
  FL: 'America/New_York', GA: 'America/New_York', HI: 'Pacific/Honolulu',
  ID: 'America/Boise', IL: 'America/Chicago', IN: 'America/Indiana/Indianapolis',
  IA: 'America/Chicago', KS: 'America/Chicago', KY: 'America/New_York',
  LA: 'America/Chicago', ME: 'America/New_York', MD: 'America/New_York',
  MA: 'America/New_York', MI: 'America/Detroit', MN: 'America/Chicago',
  MS: 'America/Chicago', MO: 'America/Chicago', MT: 'America/Denver',
  NE: 'America/Chicago', NV: 'America/Los_Angeles', NH: 'America/New_York',
  NJ: 'America/New_York', NM: 'America/Denver', NY: 'America/New_York',
  NC: 'America/New_York', ND: 'America/Chicago', OH: 'America/New_York',
  OK: 'America/Chicago', OR: 'America/Los_Angeles', PA: 'America/New_York',
  RI: 'America/New_York', SC: 'America/New_York', SD: 'America/Chicago',
  TN: 'America/Chicago', TX: 'America/Chicago', UT: 'America/Denver',
  VT: 'America/New_York', VA: 'America/New_York', WA: 'America/Los_Angeles',
  WV: 'America/New_York', WI: 'America/Chicago', WY: 'America/Denver',
  PR: 'America/Puerto_Rico', VI: 'America/St_Thomas', GU: 'Pacific/Guam',
  AS: 'Pacific/Pago_Pago', MP: 'Pacific/Saipan',
};

/**
 * Step 1 — Profile.
 * App shape: legalName, storefrontName, street, suite, city, state, zip,
 *   hours, accessNotes, primaryContact{name,email,phone}, bohManager{name,email,phone}.
 */
function normalizeStep1(p: any) {
  return {
    // Account.Name = the legal entity. Storefront name lives in DBA__c if needed.
    storefrontName: p.legalName ?? p.storefrontName,
    hours: p.hours,
    timezone: p.state ? US_STATE_TO_TZ[p.state] : undefined,
    storeType: undefined, // not collected on the form today
    loadingDockNotes: p.accessNotes,
    nstTempCode: undefined, // never re-PATCH the temp code; SF generated it
    ownerContact: p.primaryContact,
    managerContact: p.bohManager?.email ? p.bohManager : undefined,
  };
}

/**
 * Step 2 — Safe & keys.
 * App shape: hasSmartSafe ('yes'|'no'), safeMake/safeModel/safeSerial,
 *   storageMethod ('under_counter'|'drop_safe'|'vault'|'other'),
 *   storageMethodOther, keyHolders[]. No combo/photo collected today.
 *
 * Maps to SF Safe_Type__c picklist values:
 *   'Smart Safe (with bill validator)' | 'Drop Safe' | 'Combo Safe' |
 *   'Time-Delay Safe' | 'Other'
 */
function normalizeStep2(p: any) {
  let safeType: string | undefined;
  if (p.hasSmartSafe === 'yes') {
    safeType = 'Smart Safe (with bill validator)';
  } else if (p.hasSmartSafe === 'no') {
    safeType = p.storageMethod === 'drop_safe' ? 'Drop Safe' : 'Other';
  }

  return {
    safeMake: p.safeMake,
    safeModel: p.safeModel,
    safeSerial: p.safeSerial,
    safeType,
    keyHoldersCount: Array.isArray(p.keyHolders) ? p.keyHolders.length : undefined,
    backupKeyLocation: undefined, // not collected; key locations live per-holder
    safePhotoUrl: undefined,
    comboLast4: undefined, // not collected
  };
}

/**
 * Step 3 — Banking.
 * App shape: source, bankName, accountLast4, routingNumber, signerName,
 *   matches, mismatchNotes. Routing # never leaves our vault.
 */
function normalizeStep3(p: any) {
  return {
    accountLast4: p.accountLast4,
    voidedCheckUrl: undefined, // app does not currently capture an upload URL
  };
}

/** Step 6 — Invoicing contact. App shape: contactName, contactEmail, sendSample. */
function normalizeStep6(p: any) {
  return {
    contactName: p.contactName,
    contactEmail: p.contactEmail,
    contactPhone: undefined, // not collected on the form today
  };
}

/**
 * Step 7 — First pickup.
 * App shape: deferred, preferredDate, serviceDays[], timeWindow, frequency, driverNotes.
 * Concatenate days/window/frequency into a single Pickup_Window__c string.
 */
function normalizeStep7(p: any) {
  let pickupWindow: string | undefined;
  if (!p.deferred) {
    const parts: string[] = [];
    if (p.preferredDate) parts.push(`first=${p.preferredDate}`);
    if (Array.isArray(p.serviceDays) && p.serviceDays.length > 0) {
      parts.push(`days=${p.serviceDays.join(',')}`);
    }
    if (p.timeWindow) parts.push(`window=${p.timeWindow}`);
    if (p.frequency) parts.push(`freq=${p.frequency}`);
    pickupWindow = parts.length > 0 ? parts.join('; ') : undefined;
  } else {
    pickupWindow = 'deferred';
  }

  return {
    pickupWindow,
    driverNotes: p.driverNotes,
  };
}

function normalizePayload(stepId: StepId, payload: any): any {
  switch (stepId) {
    case 1: return normalizeStep1(payload);
    case 2: return normalizeStep2(payload);
    case 3: return normalizeStep3(payload);
    case 4: return payload;
    case 5: return payload;
    case 6: return normalizeStep6(payload);
    case 7: return normalizeStep7(payload);
    default: return payload;
  }
}

// ---- Per-step SF operation descriptors -------------------------------------

/**
 * Describes one or more SF operations to perform for a given job.
 * Each operation has a method, a path, and a body.
 * label is used for audit logging.
 */
type SfOperation = {
  method: 'POST' | 'PATCH';
  path: string;
  body: object;
  label: string;
  /** If true, the returned SF id is stored as the canonical sf_object_id for this job. */
  primary?: boolean;
};

/**
 * Build the list of SF operations for a given step.
 *
 * @param stepId - The onboarding step number.
 * @param payload - The raw step submission payload from the DB.
 * @param accountId - The Salesforce Account ID for this onboarding job.
 * @param existingSfObjectId - If already set on step_submissions, use for idempotent child-record ops.
 * @returns Array of SfOperation objects to execute in order.
 */
function buildSfOperations(
  stepId: StepId,
  payload: any,
  accountId: string,
  existingSfObjectId: string | null,
): SfOperation[] {
  switch (stepId) {
    case 1: {
      // Account PATCH (store profile fields + status)
      const accountOp: SfOperation = {
        method: 'PATCH',
        path: `/sobjects/Account/${accountId}`,
        body: {
          Name: payload.storefrontName ?? undefined,
          Hours_of_Operation_JSON__c: payload.hours
            ? JSON.stringify(payload.hours)
            : undefined,
          Timezone__c: payload.timezone ?? undefined,
          Store_Type__c: payload.storeType ?? undefined,
          Loading_Dock_Notes__c: payload.loadingDockNotes ?? undefined,
          NST_Temp_Code__c: payload.nstTempCode ?? undefined,
          Onboarding_Status__c: 'In Progress',
        },
        label: 'account_patch',
        primary: true,
      };

      // Owner Contact upsert (not Invoice_Contact__c — that's for billing contacts in step 6)
      const ownerOps: SfOperation[] = [];
      if (payload.ownerContact?.email) {
        const { firstName, lastName } = splitName(payload.ownerContact.name ?? '');
        ownerOps.push({
          method: 'POST', // upsertContact handles the find-first logic
          path: '/sobjects/Contact', // path overridden at runtime by upsertContact
          body: {
            FirstName: firstName,
            LastName: lastName,
            Email: payload.ownerContact.email,
            Phone: payload.ownerContact.phone ?? undefined,
            Title: 'Owner',
            AccountId: accountId,
            Invoice_Contact__c: false,
          },
          label: 'owner_contact_upsert',
        });
      }

      const managerOps: SfOperation[] = [];
      if (payload.managerContact?.email) {
        const { firstName, lastName } = splitName(payload.managerContact.name ?? '');
        managerOps.push({
          method: 'POST',
          path: '/sobjects/Contact',
          body: {
            FirstName: firstName,
            LastName: lastName,
            Email: payload.managerContact.email,
            Phone: payload.managerContact.phone ?? undefined,
            Title: 'Manager',
            AccountId: accountId,
            Invoice_Contact__c: false,
          },
          label: 'manager_contact_upsert',
        });
      }

      return [accountOp, ...ownerOps, ...managerOps];
    }

    case 2: {
      // Safe_Setup__c — POST on first run, PATCH on retry if sf_object_id already set.
      // SECURITY: Combo_Last_4__c is only included if the user explicitly provided it.
      const safeBody: Record<string, any> = {
        Account__c: accountId,
        Safe_Make__c: payload.safeMake ?? undefined,
        Safe_Model__c: payload.safeModel ?? undefined,
        Safe_Serial__c: payload.safeSerial ?? undefined,
        Safe_Type__c: payload.safeType ?? undefined,
        Key_Holders_Count__c: payload.keyHoldersCount ?? undefined,
        Backup_Key_Location__c: payload.backupKeyLocation ?? undefined,
        Safe_Photo_URL__c: payload.safePhotoUrl ?? undefined,
      };
      // Only forward Combo_Last_4__c if the payload explicitly contains it.
      // Never derive it from a full combo string — field must come pre-sliced.
      if (
        typeof payload.comboLast4 === 'string' &&
        payload.comboLast4.trim().length > 0
      ) {
        safeBody.Combo_Last_4__c = payload.comboLast4.trim().slice(-4);
      }

      if (existingSfObjectId) {
        return [{
          method: 'PATCH',
          path: `/sobjects/Safe_Setup__c/${existingSfObjectId}`,
          body: safeBody,
          label: 'safe_setup_patch',
          primary: true,
        }];
      }
      return [{
        method: 'POST',
        path: '/sobjects/Safe_Setup__c',
        body: safeBody,
        label: 'safe_setup_post',
        primary: true,
      }];
    }

    case 3: {
      // Account PATCH — bank fields only.
      // SECURITY: full routing number and full account number are NEVER sent.
      // Only the last-4 of the account number and the voided check URL are forwarded.
      return [{
        method: 'PATCH',
        path: `/sobjects/Account/${accountId}`,
        body: {
          // routingNumber is intentionally omitted — routing numbers never leave our vault.
          Bank_Account_Last_4__c: payload.accountLast4 ?? undefined,
          Voided_Check_URL__c: payload.voidedCheckUrl ?? undefined,
        },
        label: 'account_banking_patch',
        primary: true,
      }];
    }

    case 4: {
      // Account PATCH — progress flag only. Step 4 = sample deposit training; no data fields in SF.
      return [{
        method: 'PATCH',
        path: `/sobjects/Account/${accountId}`,
        body: {
          Onboarding_Status__c: 'In Progress',
        },
        label: 'account_step4_flag_patch',
        primary: true,
      }];
    }

    case 5: {
      // Account PATCH — progress flag only. Step 5 = sample change order training; no data fields in SF.
      return [{
        method: 'PATCH',
        path: `/sobjects/Account/${accountId}`,
        body: {
          Onboarding_Status__c: 'In Progress',
        },
        label: 'account_step5_flag_patch',
        primary: true,
      }];
    }

    case 6: {
      // Contact POST/PATCH — invoice contact.
      // SECURITY: cadence / delivery schedule does NOT go to SF (ops PDF only).
      const { firstName, lastName } = splitName(payload.contactName ?? '');
      const contactBody = {
        FirstName: firstName,
        LastName: lastName,
        Email: payload.contactEmail ?? undefined,
        Phone: payload.contactPhone ?? undefined,
        AccountId: accountId,
        Invoice_Contact__c: true,
        // cadence intentionally omitted — lives in ops PDF only
      };

      if (existingSfObjectId) {
        return [{
          method: 'PATCH',
          path: `/sobjects/Contact/${existingSfObjectId}`,
          body: contactBody,
          label: 'invoice_contact_patch',
          primary: true,
        }];
      }
      // Without existingSfObjectId, upsertContact logic runs in the main loop
      // (needs the token to query SF), so we use a special marker path.
      return [{
        method: 'POST',
        path: '/sobjects/Contact', // upsert logic handles dedup at runtime
        body: contactBody,
        label: 'invoice_contact_upsert',
        primary: true,
      }];
    }

    case 7: {
      // Account PATCH — pickup schedule + completion status.
      return [{
        method: 'PATCH',
        path: `/sobjects/Account/${accountId}`,
        body: {
          Pickup_Window__c: payload.pickupWindow ?? undefined,
          Loading_Dock_Notes__c: payload.driverNotes ?? undefined,
          Onboarding_Status__c: 'Complete',
        },
        label: 'account_pickup_complete_patch',
        primary: true,
      }];
    }

    default:
      throw new Error(`Unknown step_id=${stepId}`);
  }
}

// ---- Main handler ----------------------------------------------------------

Deno.serve(async (req) => {
  const startedAt = Date.now();

  // Connectivity probe: POST { mode: 'ping' } verifies SF auth + token without
  // touching the queue. Used by smoke tests / health checks. Safe to call any time.
  let mode: string | undefined;
  if (req.method === 'POST') {
    try {
      const body = await req.clone().json();
      mode = body?.mode;
    } catch {
      // ignore: empty body or non-JSON is fine for non-ping invocations
    }
  }
  if (mode === 'ping') {
    try {
      const token = await getSalesforceAccessToken();
      const describeOk = await sfRequest(token, 'GET', '/sobjects/Account/describe')
        .then(() => true)
        .catch(() => false);
      return new Response(
        JSON.stringify({
          ok: true,
          instance_url: token.instance_url,
          token_present: !!token.access_token,
          account_describe_ok: describeOk,
          duration_ms: Date.now() - startedAt,
        }),
        { headers: { 'Content-Type': 'application/json' } },
      );
    } catch (err) {
      return new Response(
        JSON.stringify({ ok: false, error: (err as Error).message }),
        { status: 502, headers: { 'Content-Type': 'application/json' } },
      );
    }
  }

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

    // Validate step_id early so we can dead-letter unknown steps cleanly.
    if (![1, 2, 3, 4, 5, 6, 7].includes(stepId)) {
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

    // Check whether we already have a SF object ID for idempotent child-record ops.
    // (Account PATCHes are inherently idempotent so the ID doesn't matter there.)
    let existingSfObjectId: string | null = job.sf_object_id ?? null;
    if (!existingSfObjectId && job.submission_id) {
      const { data: sub } = await supabase
        .from('step_submissions')
        .select('sf_object_id')
        .eq('id', job.submission_id)
        .single();
      existingSfObjectId = sub?.sf_object_id ?? null;
    }

    try {
      // Normalize the raw app-shaped payload into the SF-shaped one
      // that buildSfOperations expects.
      const normalized = normalizePayload(stepId, job.payload);
      const ops = buildSfOperations(
        stepId,
        normalized,
        job.sfdc_account_id,
        existingSfObjectId,
      );

      let primarySfId: string | null = existingSfObjectId;

      for (const op of ops) {
        let sfId: string | null = null;

        // Contact upserts (step 1 owner/manager, step 6 invoice) need a query-first
        // find-or-create pattern. Detect by label suffix.
        if (op.label.endsWith('_contact_upsert')) {
          const contactBody = op.body as any;
          sfId = await upsertContact(token, {
            FirstName: contactBody.FirstName ?? '',
            LastName: contactBody.LastName ?? '',
            Email: contactBody.Email ?? '',
            Phone: contactBody.Phone,
            Title: contactBody.Title,
            AccountId: contactBody.AccountId ?? job.sfdc_account_id,
            Invoice_Contact__c: contactBody.Invoice_Contact__c,
          });
        } else if (op.method === 'PATCH') {
          await sfRequest(token, 'PATCH', op.path, op.body);
          // PATCH on Account returns 204 — no new ID.
          // If PATCHing an existing child record, preserve the existing ID.
          sfId = op.path.includes('/sobjects/Safe_Setup__c/') ||
            op.path.includes('/sobjects/Contact/')
            ? op.path.split('/').pop() ?? null
            : accountIdFromPath(op.path, job.sfdc_account_id);
        } else {
          // POST — only for Safe_Setup__c (step 2 first run)
          const created = await sfRequest(token, 'POST', op.path, op.body);
          sfId = created?.id ?? null;
        }

        if (op.primary && sfId) {
          primarySfId = sfId;
        }
      }

      // Update queue row to succeeded.
      await supabase
        .from('sf_sync_queue')
        .update({
          status: 'succeeded',
          sf_object_id: primarySfId,
          last_error: null,
        })
        .eq('id', job.id);

      // Update step_submissions with SF object ID + sync timestamp.
      if (job.submission_id) {
        await supabase
          .from('step_submissions')
          .update({
            sf_object_id: primarySfId,
            sf_synced_at: new Date().toISOString(),
          })
          .eq('id', job.submission_id);
      }

      await supabase.from('audit_log').insert({
        sfdc_account_id: job.sfdc_account_id,
        actor_type: 'system',
        action: `sf_sync_step_${stepId}_succeeded`,
        metadata: {
          sf_object_id: primarySfId,
          ops: ops.map((o) => o.label),
        },
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

// ---- Utility ----------------------------------------------------------------

/**
 * For Account PATCH operations, the "SF object ID" for logging purposes is
 * the Account ID itself (extracted from the path).
 */
function accountIdFromPath(path: string, fallback: string): string {
  const match = path.match(/\/sobjects\/Account\/([^/]+)/);
  return match ? match[1] : fallback;
}
