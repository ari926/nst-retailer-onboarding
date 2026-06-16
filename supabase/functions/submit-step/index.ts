// Edge Function: submit-step
//
// Public, token-gated endpoint. Called by the SPA when a retailer hits
// "Confirm & continue" on any step (1..7). Validates the token, resolves
// the retailer_onboardings row, and:
//   - upserts the autosaved draft into step_drafts (kind='draft'), OR
//   - inserts a finalized submission into step_submissions (kind='submit')
//
// For each step ('submit' only), additionally pushes relevant payload fields
// back to Salesforce. All SF writes are best-effort — never fail the user's
// submission if SF is briefly unavailable.
//
// Auth: deployed with verify_jwt=false. The token in the request body is
// the auth, exactly like get-onboarding-context.

// deno-lint-ignore-file no-explicit-any
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const SF_LOGIN_URL = Deno.env.get('SF_LOGIN_URL') ?? 'https://login.salesforce.com';
const SF_API_VERSION = 'v61.0';

const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers': 'content-type, authorization',
  'access-control-max-age': '86400',
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...CORS_HEADERS },
  });

interface SfToken {
  access_token: string;
  instance_url: string;
}

async function getSalesforceAccessToken(): Promise<SfToken> {
  const clientId = Deno.env.get('SF_CLIENT_ID');
  const username = Deno.env.get('SF_USERNAME');
  const privateKey = Deno.env.get('SF_PRIVATE_KEY');
  if (!clientId || !username || !privateKey) {
    throw new Error('SF credentials missing from env');
  }
  const header = { alg: 'RS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const claims = { iss: clientId, sub: username, aud: SF_LOGIN_URL, exp: now + 180 };
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
  const resp = await fetch(`${SF_LOGIN_URL}/services/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!resp.ok) throw new Error(`SF token exchange failed: ${resp.status} ${await resp.text()}`);
  return (await resp.json()) as SfToken;
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

async function sfPatch(
  token: SfToken,
  sobject: string,
  id: string,
  fields: Record<string, unknown>,
): Promise<{ ok: boolean; status: number; body: string }> {
  const url = `${token.instance_url}/services/data/${SF_API_VERSION}/sobjects/${sobject}/${id}`;
  const resp = await fetch(url, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${token.access_token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(fields),
  });
  // SF PATCH returns 204 on success.
  return { ok: resp.ok, status: resp.status, body: resp.ok ? '' : (await resp.text()).slice(0, 400) };
}

/**
 * GET a single Salesforce record and return its parsed JSON body.
 * Returns an empty object on any error so callers can safely destructure.
 */
async function sfGet(
  token: SfToken,
  sobject: string,
  id: string,
  fields: string[],
): Promise<Record<string, unknown>> {
  try {
    const url =
      `${token.instance_url}/services/data/${SF_API_VERSION}/sobjects/${sobject}/${id}` +
      `?fields=${fields.join(',')}`;
    const resp = await fetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token.access_token}` },
    });
    if (!resp.ok) return {};
    return (await resp.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * Decode HTML entities that Salesforce injects into Rich Text Area fields
 * (Onboarding_Notes__c is a richtextarea, so SF returns &quot; / &amp; etc.
 * on read even though we wrote plain JSON). Strip <br>/<p> tags too —
 * SF wraps long text in <p>...</p> when 'Display lines' > 1.
 */
function decodeHtmlEntities(s: string): string {
  return s
    .replace(/<br\s*\/?>/gi, '')
    .replace(/<\/?p>/gi, '')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

/**
 * Read the existing Onboarding_Notes__c JSON string, parse it (default {}),
 * set/overwrite the given stepKey, JSON.stringify, and truncate to 30 000
 * chars to stay safely under Salesforce's 32 K textarea limit.
 */
function mergeNotes(existingRaw: string | null | undefined, stepKey: string, value: unknown): string {
  let parsed: Record<string, unknown> = {};
  if (existingRaw) {
    const decoded = decodeHtmlEntities(existingRaw);
    try {
      const candidate = JSON.parse(decoded);
      if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
        parsed = candidate as Record<string, unknown>;
      }
    } catch {
      // not valid JSON — start fresh
    }
  }
  parsed[stepKey] = value;
  const str = JSON.stringify(parsed);
  return str.length > 30000 ? str.slice(0, 30000) : str;
}

interface Step1Payload {
  legalName?: string;
  storefrontName?: string;
  street?: string;
  suite?: string | null;
  city?: string;
  state?: string;
  zip?: string;
  primaryContact?: { name?: string; email?: string; phone?: string };
  bohManager?: { name?: string | null; email?: string | null; phone?: string | null } | null;
  hours?: unknown;
}

function splitName(full: string): { first: string; last: string } {
  const trimmed = (full || '').trim();
  if (!trimmed) return { first: '', last: '' };
  const parts = trimmed.split(/\s+/);
  if (parts.length === 1) return { first: parts[0], last: '' };
  return { first: parts[0], last: parts.slice(1).join(' ') };
}

// ---------------------------------------------------------------------------
// Frequency / time-window / day maps for Step 7
// ---------------------------------------------------------------------------

const FREQUENCY_MAP: Record<string, string> = {
  weekly: '1x weekly',
  twice_weekly: '2x weekly',
  thrice_weekly: '1x weekly', // closest available
  daily: '1x weekly',         // closest available
  biweekly: 'EOW',
};

const TIME_WINDOW_MAP: Record<string, string | null> = {
  am: 'Morning (6am–11am)',
  pm: 'Afternoon (11am–3pm)',
  flexible: null, // skip — no SF value
};

const VALID_SF_DAYS = new Set(['MON', 'TUE', 'WED', 'THU', 'FRI']);

// ---------------------------------------------------------------------------
// SfWriteback type
// ---------------------------------------------------------------------------

interface SfCallResult {
  ok: boolean;
  status: number;
  body?: string;
}

interface SfWriteback {
  account?: SfCallResult;
  contact?: SfCallResult;
  opportunity?: SfCallResult;
  notes?: SfCallResult;
  error?: string;
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' });

  let body: { token?: string; step_number?: number; kind?: 'draft' | 'submit'; payload?: unknown } = {};
  try {
    const text = await req.text();
    if (text) body = JSON.parse(text);
  } catch {
    return json(400, { error: 'invalid_json' });
  }

  const token = (body.token ?? '').trim();
  const stepNumber = body.step_number;
  const kind = body.kind ?? 'submit';
  const payload = body.payload;

  if (!token) return json(400, { error: 'missing_token' });
  if (typeof stepNumber !== 'number' || stepNumber < 1 || stepNumber > 7) {
    return json(400, { error: 'invalid_step_number' });
  }
  if (kind !== 'draft' && kind !== 'submit') return json(400, { error: 'invalid_kind' });
  if (!payload || typeof payload !== 'object') return json(400, { error: 'missing_payload' });

  const admin = createClient(SUPABASE_URL, SERVICE_KEY);

  const { data: tokRow, error: tokErr } = await admin
    .from('onboarding_tokens')
    .select('token, sfdc_account_id, sfdc_opportunity_id, sfdc_contact_id, revoked_at')
    .eq('token', token)
    .maybeSingle();

  if (tokErr) return json(500, { error: 'token_lookup_failed', detail: tokErr.message });
  if (!tokRow) return json(401, { error: 'invalid_token' });
  if (tokRow.revoked_at) return json(401, { error: 'token_revoked' });

  const { data: onbRow, error: onbErr } = await admin
    .from('retailer_onboardings')
    .select('id, sfdc_account_id, sfdc_opportunity_id, current_step')
    .eq('sfdc_account_id', tokRow.sfdc_account_id)
    .eq('sfdc_opportunity_id', tokRow.sfdc_opportunity_id)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (onbErr) return json(500, { error: 'onboarding_lookup_failed', detail: onbErr.message });
  if (!onbRow) return json(404, { error: 'onboarding_not_found' });

  // Draft path — upsert into step_drafts.
  if (kind === 'draft') {
    const { error: draftErr } = await admin
      .from('step_drafts')
      .upsert(
        {
          onboarding_id: onbRow.id,
          step_number: stepNumber,
          draft_data: payload,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'onboarding_id,step_number' },
      );
    if (draftErr) return json(500, { error: 'draft_save_failed', detail: draftErr.message });
    return json(200, { ok: true });
  }

  // Submit path — upsert step_submissions, advance current_step, then push
  // to Salesforce (best-effort for every step).
  //
  // UPSERT (not INSERT) because retailers can navigate back to a previously
  // submitted step and re-submit with edits. step_submissions has a UNIQUE
  // constraint on (onboarding_id, step_number); a plain INSERT on the second
  // submit returned 23505 duplicate-key, which the SPA surfaced as a generic
  // toast ("submission_failed"). Using onConflict reapplies the latest values
  // and refreshes submitted_at so audit history reflects the most recent edit.
  // The synced_to_sfdc_at flag is reset to NULL so sf-sync re-pushes the new
  // values (best-effort writeback below also runs every submit).
  const { error: subErr } = await admin
    .from('step_submissions')
    .upsert(
      {
        onboarding_id: onbRow.id,
        step_number: stepNumber,
        submitted_data: payload,
        submitted_at: new Date().toISOString(),
        synced_to_sfdc_at: null,
      },
      { onConflict: 'onboarding_id,step_number' },
    );
  if (subErr) return json(500, { error: 'submission_failed', detail: subErr.message });

  // Advance current_step on retailer_onboardings if this is the highest step
  // they've completed so far. Await so the update actually flushes before the
  // edge function returns and Deno tears the request down.
  const nextStep = Math.max((onbRow.current_step ?? 0) + 1, stepNumber + 1);
  const { error: advErr } = await admin
    .from('retailer_onboardings')
    .update({
      current_step: Math.min(nextStep, 7),
      status: stepNumber >= 7 ? 'completed' : 'in_progress',
      last_activity_at: new Date().toISOString(),
    })
    .eq('id', onbRow.id);
  if (advErr) console.error('[submit-step] advance current_step failed', advErr);

  // ---------------------------------------------------------------------------
  // SF write-back — best-effort for each step (1-7).
  // Each step is wrapped in its own try/catch so a single SF failure never
  // breaks another step's writes or the overall response.
  // ---------------------------------------------------------------------------

  let sfWriteback: SfWriteback | null = null;

  // ---- Step 1 ---------------------------------------------------------------
  // IMPORTANT: the existing account + contact logic is preserved exactly.
  // Additions: Hours_of_Operation_JSON__c, Onboarding_Status__c, Onboarding_Notes__c.
  if (stepNumber === 1) {
    try {
      const p = payload as Step1Payload;
      const sfToken = await getSalesforceAccessToken();
      const acctFields: Record<string, unknown> = {};
      if (p.legalName) acctFields.Name = p.legalName;
      if (p.street) acctFields.BillingStreet = [p.street, p.suite].filter(Boolean).join(', ');
      if (p.city) acctFields.BillingCity = p.city;
      if (p.state) acctFields.BillingState = p.state;
      if (p.zip) acctFields.BillingPostalCode = p.zip;
      if (p.primaryContact?.phone) acctFields.Phone = p.primaryContact.phone;
      // NEW: hours JSON and onboarding status
      if (p.hours != null) acctFields.Hours_of_Operation_JSON__c = JSON.stringify(p.hours);
      acctFields.Onboarding_Status__c = 'Profile Complete';

      if (Object.keys(acctFields).length > 0 && tokRow.sfdc_account_id) {
        const r = await sfPatch(sfToken, 'Account', tokRow.sfdc_account_id, acctFields);
        sfWriteback = { ...(sfWriteback ?? {}), account: r };
      }

      // Onboarding_Notes__c lives on Opportunity (NOT Account in this org)
      if (tokRow.sfdc_opportunity_id) {
        const existing = await sfGet(sfToken, 'Opportunity', tokRow.sfdc_opportunity_id, ['Onboarding_Notes__c']);
        const notesStr = mergeNotes(existing.Onboarding_Notes__c as string | null, 'step1', p);
        const r = await sfPatch(sfToken, 'Opportunity', tokRow.sfdc_opportunity_id, { Onboarding_Notes__c: notesStr });
        sfWriteback = { ...(sfWriteback ?? {}), opportunity: r };
      }

      if (tokRow.sfdc_contact_id && p.primaryContact) {
        const { first, last } = splitName(p.primaryContact.name ?? '');
        const contactFields: Record<string, unknown> = {};
        if (first) contactFields.FirstName = first;
        if (last) contactFields.LastName = last;
        if (p.primaryContact.email) contactFields.Email = p.primaryContact.email;
        if (p.primaryContact.phone) contactFields.Phone = p.primaryContact.phone;
        if (Object.keys(contactFields).length > 0) {
          const r = await sfPatch(sfToken, 'Contact', tokRow.sfdc_contact_id, contactFields);
          sfWriteback = { ...(sfWriteback ?? {}), contact: r };
        }
      }
    } catch (e) {
      console.error('[submit-step] SF write-back step 1 failed', e);
      sfWriteback = { account: { ok: false, status: 0, body: (e as Error).message?.slice(0, 200) } };
    }
  }

  // ---- Step 2 (Safe & keys) -------------------------------------------------
  if (stepNumber === 2) {
    try {
      const p = payload as Record<string, unknown>;
      const sfToken = await getSalesforceAccessToken();
      if (tokRow.sfdc_account_id) {
        const r = await sfPatch(sfToken, 'Account', tokRow.sfdc_account_id, {
          Onboarding_Status__c: 'Setup Complete',
        });
        sfWriteback = { ...(sfWriteback ?? {}), account: r };
      }
      // Notes -> Opportunity
      if (tokRow.sfdc_opportunity_id) {
        const existing = await sfGet(sfToken, 'Opportunity', tokRow.sfdc_opportunity_id, ['Onboarding_Notes__c']);
        const notesStr = mergeNotes(existing.Onboarding_Notes__c as string | null, 'step2', p);
        const r = await sfPatch(sfToken, 'Opportunity', tokRow.sfdc_opportunity_id, { Onboarding_Notes__c: notesStr });
        sfWriteback = { ...(sfWriteback ?? {}), opportunity: r };
      }
    } catch (e) {
      console.error('[submit-step] SF write-back step 2 failed', e);
      sfWriteback = { error: (e as Error).message?.slice(0, 200) };
    }
  }

  // ---- Step 3 (Banking) -----------------------------------------------------
  if (stepNumber === 3) {
    try {
      const p = payload as {
        bankName?: string;
        accountLast4?: string;
        routingNumber?: string;
        signerName?: string;
        matches?: unknown;
        mismatchNotes?: string;
        source?: string;
        [key: string]: unknown;
      };
      const sfToken = await getSalesforceAccessToken();

      // Opportunity PATCH
      if (tokRow.sfdc_opportunity_id) {
        const oppFields: Record<string, unknown> = {};
        if (p.bankName) oppFields.Bank_Name__c = p.bankName;
        if (p.accountLast4) oppFields.Bank_Account_Number__c = '****' + p.accountLast4;
        if (Object.keys(oppFields).length > 0) {
          const r = await sfPatch(sfToken, 'Opportunity', tokRow.sfdc_opportunity_id, oppFields);
          sfWriteback = { ...(sfWriteback ?? {}), opportunity: r };
        }
      }

      // Account PATCH (Bank_Account_Last_4__c + status)
      if (tokRow.sfdc_account_id) {
        const acctFields: Record<string, unknown> = {
          Onboarding_Status__c: 'Setup Complete',
        };
        if (p.accountLast4) acctFields.Bank_Account_Last_4__c = p.accountLast4;
        const r = await sfPatch(sfToken, 'Account', tokRow.sfdc_account_id, acctFields);
        sfWriteback = { ...(sfWriteback ?? {}), account: r };
      }
      // Notes -> Opportunity
      if (tokRow.sfdc_opportunity_id) {
        const existing = await sfGet(sfToken, 'Opportunity', tokRow.sfdc_opportunity_id, ['Onboarding_Notes__c']);
        const notesPayload = {
          routingNumber: p.routingNumber,
          signerName: p.signerName,
          matches: p.matches,
          mismatchNotes: p.mismatchNotes,
          source: p.source,
        };
        const notesStr = mergeNotes(existing.Onboarding_Notes__c as string | null, 'step3', notesPayload);
        const r = await sfPatch(sfToken, 'Opportunity', tokRow.sfdc_opportunity_id, { Onboarding_Notes__c: notesStr });
        // don't overwrite the opp PATCH from above — merge
        sfWriteback = { ...(sfWriteback ?? {}), opportunity: r };
      }
    } catch (e) {
      console.error('[submit-step] SF write-back step 3 failed', e);
      sfWriteback = { error: (e as Error).message?.slice(0, 200) };
    }
  }

  // ---- Step 4 (Sample deposit) ----------------------------------------------
  if (stepNumber === 4) {
    try {
      const p = payload as Record<string, unknown>;
      const sfToken = await getSalesforceAccessToken();
      if (tokRow.sfdc_account_id) {
        const r = await sfPatch(sfToken, 'Account', tokRow.sfdc_account_id, {
          Onboarding_Status__c: 'Trained',
        });
        sfWriteback = { ...(sfWriteback ?? {}), account: r };
      }
      if (tokRow.sfdc_opportunity_id) {
        const existing = await sfGet(sfToken, 'Opportunity', tokRow.sfdc_opportunity_id, ['Onboarding_Notes__c']);
        const notesStr = mergeNotes(existing.Onboarding_Notes__c as string | null, 'step4', { ...p, completedAt: new Date().toISOString() });
        const r = await sfPatch(sfToken, 'Opportunity', tokRow.sfdc_opportunity_id, { Onboarding_Notes__c: notesStr });
        sfWriteback = { ...(sfWriteback ?? {}), opportunity: r };
      }
    } catch (e) {
      console.error('[submit-step] SF write-back step 4 failed', e);
      sfWriteback = { error: (e as Error).message?.slice(0, 200) };
    }
  }

  // ---- Step 5 (Sample change order) ----------------------------------------
  if (stepNumber === 5) {
    try {
      const p = payload as Record<string, unknown>;
      const sfToken = await getSalesforceAccessToken();
      if (tokRow.sfdc_account_id) {
        const r = await sfPatch(sfToken, 'Account', tokRow.sfdc_account_id, {
          Onboarding_Status__c: 'Trained',
        });
        sfWriteback = { ...(sfWriteback ?? {}), account: r };
      }
      if (tokRow.sfdc_opportunity_id) {
        const existing = await sfGet(sfToken, 'Opportunity', tokRow.sfdc_opportunity_id, ['Onboarding_Notes__c']);
        const notesStr = mergeNotes(existing.Onboarding_Notes__c as string | null, 'step5', { ...p, completedAt: new Date().toISOString() });
        const r = await sfPatch(sfToken, 'Opportunity', tokRow.sfdc_opportunity_id, { Onboarding_Notes__c: notesStr });
        sfWriteback = { ...(sfWriteback ?? {}), opportunity: r };
      }
    } catch (e) {
      console.error('[submit-step] SF write-back step 5 failed', e);
      sfWriteback = { error: (e as Error).message?.slice(0, 200) };
    }
  }

  // ---- Step 6 (Invoicing contact) ------------------------------------------
  if (stepNumber === 6) {
    try {
      const p = payload as {
        contactName?: string;
        contactEmail?: string;
        sampleSent?: unknown;
        [key: string]: unknown;
      };
      const sfToken = await getSalesforceAccessToken();
      if (tokRow.sfdc_account_id) {
        const { first, last } = splitName(p.contactName ?? '');
        const acctFields: Record<string, unknown> = {
          Onboarding_Status__c: 'Invoicing Configured',
        };
        if (p.contactEmail) acctFields.AVSFQB__Email__c = p.contactEmail;
        if (first) acctFields.AVSFQB__First_Name__c = first;
        if (last) acctFields.AVSFQB__Last_Name__c = last;

        const r = await sfPatch(sfToken, 'Account', tokRow.sfdc_account_id, acctFields);
        sfWriteback = { ...(sfWriteback ?? {}), account: r };
      }
      if (tokRow.sfdc_opportunity_id) {
        const existing = await sfGet(sfToken, 'Opportunity', tokRow.sfdc_opportunity_id, ['Onboarding_Notes__c']);
        const notesStr = mergeNotes(existing.Onboarding_Notes__c as string | null, 'step6', {
          contactName: p.contactName,
          contactEmail: p.contactEmail,
          sampleSent: p.sampleSent,
          completedAt: new Date().toISOString(),
        });
        const r = await sfPatch(sfToken, 'Opportunity', tokRow.sfdc_opportunity_id, { Onboarding_Notes__c: notesStr });
        sfWriteback = { ...(sfWriteback ?? {}), opportunity: r };
      }
    } catch (e) {
      console.error('[submit-step] SF write-back step 6 failed', e);
      sfWriteback = { error: (e as Error).message?.slice(0, 200) };
    }
  }

  // ---- Step 7 (First pickup + service spec) ---------------------------------
  if (stepNumber === 7) {
    try {
      const p = payload as {
        preferredDate?: string;
        deferred?: boolean;
        deferralReason?: string;
        serviceDays?: string[];
        timeWindow?: string;
        frequency?: string;
        [key: string]: unknown;
      };
      const sfToken = await getSalesforceAccessToken();

      // --- Account PATCH ---
      if (tokRow.sfdc_account_id) {
        const acctFields: Record<string, unknown> = {
          Onboarding_Status__c: 'Awaiting Pickup',
        };

        // First pickup date — only if not deferred and date is provided
        if (!p.deferred && p.preferredDate) {
          acctFields.First_pick_up_date__c = p.preferredDate;
        }

        // Frequency mapping
        if (p.frequency && FREQUENCY_MAP[p.frequency] !== undefined) {
          acctFields.Pick_up_frequency__c = FREQUENCY_MAP[p.frequency];
        }

        // Time window mapping — skip null (flexible)
        if (p.timeWindow && TIME_WINDOW_MAP[p.timeWindow] !== undefined) {
          const mappedWindow = TIME_WINDOW_MAP[p.timeWindow];
          if (mappedWindow !== null) {
            acctFields.Pickup_Window__c = mappedWindow;
          }
        }

        const r = await sfPatch(sfToken, 'Account', tokRow.sfdc_account_id, acctFields);
        sfWriteback = { ...(sfWriteback ?? {}), account: r };
      }

      // --- Opportunity PATCH (Pick_up_day__c multipicklist + Onboarding_Notes__c) ---
      if (tokRow.sfdc_opportunity_id) {
        const oppFields: Record<string, unknown> = {};
        if (p.serviceDays && p.serviceDays.length > 0) {
          const filteredDays = p.serviceDays
            .map((d: string) => d.toUpperCase())
            .filter((d: string) => VALID_SF_DAYS.has(d));
          if (filteredDays.length > 0) oppFields.Pick_up_day__c = filteredDays.join(';');
        }
        const existing = await sfGet(sfToken, 'Opportunity', tokRow.sfdc_opportunity_id, ['Onboarding_Notes__c']);
        oppFields.Onboarding_Notes__c = mergeNotes(existing.Onboarding_Notes__c as string | null, 'step7', {
          preferredDate: p.preferredDate,
          deferred: p.deferred,
          deferralReason: p.deferralReason,
          days: p.serviceDays,
          window: p.timeWindow,
          frequency: p.frequency,
          completedAt: new Date().toISOString(),
        });
        const r = await sfPatch(sfToken, 'Opportunity', tokRow.sfdc_opportunity_id, oppFields);
        sfWriteback = { ...(sfWriteback ?? {}), opportunity: r };
      }
    } catch (e) {
      console.error('[submit-step] SF write-back step 7 failed', e);
      sfWriteback = { error: (e as Error).message?.slice(0, 200) };
    }
  }

  // Audit row — await so it actually lands before the response returns.
  const { error: auditErr } = await admin.from('audit_log').insert({
    onboarding_id: onbRow.id,
    actor_type: 'retailer',
    event_type: `step_${stepNumber}_submitted`,
    event_data: { step_number: stepNumber, sf_writeback: sfWriteback },
    ip_address: req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || null,
    user_agent: req.headers.get('user-agent') || null,
  });
  if (auditErr) console.error('[submit-step] audit_log insert failed', auditErr);

  // Fire-and-forget: kick notify-hq so the HQ portal-progress-widget updates
  // within seconds instead of waiting for the next 30s pg_cron tick. The
  // trigger on step_submissions has already enqueued the outbox row; this
  // call just drains it now. We do NOT await the response — the HMAC POST
  // can take 200-500ms and there's no value to the retailer in blocking.
  try {
    const projectUrl = Deno.env.get('SUPABASE_URL');
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (projectUrl && serviceKey) {
      fetch(`${projectUrl}/functions/v1/notify-hq`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${serviceKey}`,
        },
        body: JSON.stringify({ source: 'submit-step', step_number: stepNumber }),
      }).catch((e) => console.error('[submit-step] notify-hq kick failed', e));
    }
  } catch (e) {
    console.error('[submit-step] notify-hq kick threw', e);
  }

  return json(200, { ok: true, sf_writeback: sfWriteback });
});
