// supabase/functions/resolve-onboarding-token/index.ts
//
// Trades a magic-link token for:
//   1. A live SFDC prefill bundle (Account + Opportunity + Primary Contact)
//   2. A scoped Supabase access token with sfdc_account_id custom claim
//      so retailer-facing RLS on step_drafts/step_submissions works
//
// POST body: { "token": "abc..." }
// Response:
//   {
//     "ok": true,
//     "session": { "access_token": "...", "expires_in": 3600 },
//     "prefill": {
//       "account":     { sfdc_id, name, dba, billing_address, ... },
//       "opportunity": { sfdc_id, name, stage, close_date, owner: {...} },
//       "primary_contact": { sfdc_id, first_name, last_name, email, phone, title }
//     }
//   }
//
// Auth: public endpoint (token IS the auth). verify_jwt=false on deploy.

// deno-lint-ignore-file no-explicit-any

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';
import { create as createJwt, getNumericDate } from 'https://deno.land/x/djwt@v3.0.2/mod.ts';

interface ResolveRequest { token: string }

interface SfToken { access_token: string; instance_url: string }

// ---------------------------------------------------------------------------
// SF JWT auth (mirrors sf-deploy-flow / sf-sync pattern)
// ---------------------------------------------------------------------------
function pemToArrayBuffer(pem: string): ArrayBuffer {
  const b64 = pem.replace(/-----BEGIN PRIVATE KEY-----/g, '')
    .replace(/-----END PRIVATE KEY-----/g, '').replace(/\s+/g, '');
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf.buffer;
}

async function getSfToken(): Promise<SfToken> {
  const clientId = Deno.env.get('SF_CLIENT_ID');
  const username = Deno.env.get('SF_USERNAME');
  const privateKey = Deno.env.get('SF_PRIVATE_KEY');
  const loginUrl = Deno.env.get('SF_LOGIN_URL') ?? 'https://login.salesforce.com';
  if (!clientId || !username || !privateKey) throw new Error('SF credentials missing');
  const header = { alg: 'RS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const claims = { iss: clientId, sub: username, aud: loginUrl, exp: now + 180 };
  const enc = (o: unknown) =>
    btoa(JSON.stringify(o)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  const toSign = `${enc(header)}.${enc(claims)}`;
  const key = await crypto.subtle.importKey('pkcs8', pemToArrayBuffer(privateKey),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(toSign));
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion: `${toSign}.${sigB64}`,
  });
  const resp = await fetch(`${loginUrl}/services/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!resp.ok) throw new Error(`SF token: ${resp.status} ${await resp.text()}`);
  return await resp.json();
}

async function sfQuery(sf: SfToken, soql: string): Promise<any> {
  const r = await fetch(
    `${sf.instance_url}/services/data/v60.0/query/?q=${encodeURIComponent(soql)}`,
    { headers: { Authorization: `Bearer ${sf.access_token}` } }
  );
  if (!r.ok) throw new Error(`SF SOQL ${r.status}: ${await r.text()}`);
  return await r.json();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'POST, OPTIONS',
      'access-control-allow-headers': 'authorization, content-type',
    },
  });
}

function clientIp(req: Request): string {
  return req.headers.get('cf-connecting-ip')
    ?? req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    ?? 'unknown';
}

// ---------------------------------------------------------------------------
// Custom-claim Supabase JWT — minted with the project's JWT secret so that
// retailer-facing RLS policies can read sfdc_account_id from auth.jwt().
// ---------------------------------------------------------------------------
async function mintScopedJwt(sfdcAccountId: string, tokenId: string): Promise<{
  access_token: string;
  expires_in: number;
}> {
  const secret =
    Deno.env.get('SUPABASE_JWT_SECRET') ??
    Deno.env.get('JWT_SECRET') ??
    Deno.env.get('SUPABASE_AUTH_JWT_SECRET');
  if (!secret) throw new Error('SUPABASE_JWT_SECRET not set');
  const ttlSeconds = 60 * 60; // 1 hour — app refreshes on re-mount via re-resolve

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  );

  const payload = {
    aud: 'authenticated',
    role: 'authenticated',
    sub: `onboarding:${tokenId}`,
    sfdc_account_id: sfdcAccountId,
    onboarding_token: tokenId,
    iat: getNumericDate(0),
    exp: getNumericDate(ttlSeconds),
  };

  const access_token = await createJwt({ alg: 'HS256', typ: 'JWT' }, payload, key);
  return { access_token, expires_in: ttlSeconds };
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------
Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', {
      headers: {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'POST, OPTIONS',
        'access-control-allow-headers': 'authorization, content-type',
      },
    });
  }

  if (req.method !== 'POST') {
    return jsonResponse({ error: 'POST required' }, 405);
  }

  let body: ResolveRequest;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: 'invalid JSON body' }, 400);
  }

  if (!body.token) return jsonResponse({ error: 'token required' }, 400);

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !serviceKey) {
    return jsonResponse({ error: 'supabase env not configured' }, 500);
  }

  const supabase = createClient(supabaseUrl, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // 1. Look up the token
  const { data: tokenRow, error: lookupErr } = await supabase
    .from('onboarding_tokens')
    .select('*')
    .eq('token', body.token)
    .is('revoked_at', null)
    .maybeSingle();

  if (lookupErr) {
    return jsonResponse({ error: 'token lookup failed', detail: lookupErr.message }, 500);
  }
  if (!tokenRow) {
    return jsonResponse({ error: 'token invalid or revoked' }, 404);
  }

  // 2. Pull live data from Salesforce
  let prefill: any = null;
  try {
    const sf = await getSfToken();
    const accountId = tokenRow.sfdc_account_id;
    const oppId     = tokenRow.sfdc_opportunity_id;
    const contactId = tokenRow.sfdc_contact_id;

    const accountSoql = `
      SELECT Id, Name, Phone, Website, Industry, NumberOfEmployees,
             BillingStreet, BillingCity, BillingState, BillingPostalCode, BillingCountry,
             ShippingStreet, ShippingCity, ShippingState, ShippingPostalCode, ShippingCountry,
             Onboarding_Status__c, Legal_Name__c, Account_Number__c, Customer_ID__c,
             Bank_Account_Last_4__c, Hours_of_Operation_JSON__c, Loading_Dock_Notes__c,
             Pickup_Window__c, Pick_up_frequency__c, Store_Type__c, Launch_Date__c,
             Owner.Id, Owner.FirstName, Owner.LastName, Owner.Email
      FROM Account WHERE Id = '${accountId}' LIMIT 1
    `;

    const oppSoql = `
      SELECT Id, Name, StageName, Amount, CloseDate,
             Owner.Id, Owner.FirstName, Owner.LastName, Owner.Email
      FROM Opportunity WHERE Id = '${oppId}' LIMIT 1
    `;

    const promises: Promise<any>[] = [
      sfQuery(sf, accountSoql),
      sfQuery(sf, oppSoql),
    ];
    if (contactId) {
      promises.push(sfQuery(sf, `
        SELECT Id, FirstName, LastName, Name, Email, Phone, MobilePhone, Title
        FROM Contact WHERE Id = '${contactId}' LIMIT 1
      `));
    }

    const [acctRes, oppRes, contactRes] = await Promise.all(promises);

    const a = acctRes.records?.[0];
    const o = oppRes.records?.[0];
    const c = contactRes?.records?.[0];

    prefill = {
      account: a ? {
        sfdc_id: a.Id,
        name: a.Name,
        legal_name: a.Legal_Name__c ?? a.Name,
        account_number: a.Account_Number__c,
        customer_id: a.Customer_ID__c,
        phone: a.Phone,
        website: a.Website,
        industry: a.Industry,
        employee_count: a.NumberOfEmployees,
        bank_account_last4: a.Bank_Account_Last_4__c,
        hours_of_operation_json: a.Hours_of_Operation_JSON__c,
        loading_dock_notes: a.Loading_Dock_Notes__c,
        pickup_window: a.Pickup_Window__c,
        pickup_frequency: a.Pick_up_frequency__c,
        store_type: a.Store_Type__c,
        launch_date: a.Launch_Date__c,
        onboarding_status: a.Onboarding_Status__c,
        billing_address: {
          street:  a.BillingStreet,
          city:    a.BillingCity,
          state:   a.BillingState,
          zip:     a.BillingPostalCode,
          country: a.BillingCountry,
        },
        shipping_address: {
          street:  a.ShippingStreet,
          city:    a.ShippingCity,
          state:   a.ShippingState,
          zip:     a.ShippingPostalCode,
          country: a.ShippingCountry,
        },
        owner: a.Owner ? {
          sfdc_id:    a.Owner.Id,
          first_name: a.Owner.FirstName,
          last_name:  a.Owner.LastName,
          email:      a.Owner.Email,
        } : null,
      } : null,
      opportunity: o ? {
        sfdc_id:    o.Id,
        name:       o.Name,
        stage:      o.StageName,
        amount:     o.Amount,
        close_date: o.CloseDate,
        owner: o.Owner ? {
          sfdc_id:    o.Owner.Id,
          first_name: o.Owner.FirstName,
          last_name:  o.Owner.LastName,
          email:      o.Owner.Email,
        } : null,
      } : null,
      primary_contact: c ? {
        sfdc_id:    c.Id,
        first_name: c.FirstName,
        last_name:  c.LastName,
        full_name:  c.Name,
        email:      c.Email,
        phone:      c.Phone ?? c.MobilePhone,
        title:      c.Title,
      } : null,
    };
  } catch (e) {
    // SFDC fetch failed — degrade gracefully with token-row metadata
    prefill = {
      account: { sfdc_id: tokenRow.sfdc_account_id, name: tokenRow.account_name },
      opportunity: { sfdc_id: tokenRow.sfdc_opportunity_id },
      primary_contact: tokenRow.sfdc_contact_id ? {
        sfdc_id: tokenRow.sfdc_contact_id,
        email: tokenRow.recipient_email,
        first_name: tokenRow.recipient_first_name,
      } : null,
      _sfdc_error: e instanceof Error ? e.message : String(e),
    };
  }

  // 3. Mint a scoped Supabase JWT (best-effort — app falls back to anon key)
  let session: { access_token: string; expires_in: number } | null = null;
  try {
    session = await mintScopedJwt(tokenRow.sfdc_account_id, tokenRow.token);
  } catch (_e) {
    // JWT secret not configured — proceed without scoped session.
    // The onboarding app uses the anon key + sfdc_account_id from prefill
    // bundle for its writes; RLS policies key off row sfdc_account_id values
    // rather than auth.jwt() claims.
    session = null;
  }

  // 4. Audit redemption
  await supabase.rpc('record_token_redemption', {
    p_token: body.token,
    p_ip: clientIp(req),
    p_user_agent: req.headers.get('user-agent') ?? null,
  });

  return jsonResponse({
    ok: true,
    session,
    prefill,
    sfdc_account_id: tokenRow.sfdc_account_id,
    sfdc_opportunity_id: tokenRow.sfdc_opportunity_id,
  });
});
