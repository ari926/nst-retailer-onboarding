// supabase/functions/mint-onboarding-token/index.ts
//
// Idempotently mints (or returns existing) magic-link token for an Opportunity.
// Called by Salesforce Flow B via an Apex @InvocableMethod HTTP callout.
//
// POST body:
//   {
//     "sfdc_account_id":     "001TN00000nYfsaYAC",
//     "sfdc_opportunity_id": "006TN00002XJxDGYA1",
//     "sfdc_contact_id":     "003TN00000o4wWvYAI",   (optional)
//     "recipient_email":     "ari@talaria.com",       (optional)
//     "recipient_first_name":"Ari",                   (optional)
//     "account_name":        "Acme Retail"            (optional)
//   }
//
// Response:
//   { "token": "abc...", "url": "https://onboarding.nst.../onboarding/start?token=abc..." }
//
// Auth: requires service-role JWT in Authorization header (set on Supabase
// Named Credential in Salesforce).

// deno-lint-ignore-file no-explicit-any

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

const ONBOARDING_BASE_URL =
  Deno.env.get('ONBOARDING_BASE_URL') ??
  'https://ari926.github.io/nst-retailer-onboarding';

interface MintRequest {
  sfdc_account_id: string;
  sfdc_opportunity_id: string;
  sfdc_contact_id?: string | null;
  recipient_email?: string | null;
  recipient_first_name?: string | null;
  account_name?: string | null;
}

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

  let body: MintRequest;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: 'invalid JSON body' }, 400);
  }

  if (!body.sfdc_account_id || !body.sfdc_opportunity_id) {
    return jsonResponse(
      { error: 'sfdc_account_id and sfdc_opportunity_id are required' },
      400
    );
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !serviceKey) {
    return jsonResponse({ error: 'supabase env not configured' }, 500);
  }

  const supabase = createClient(supabaseUrl, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data, error } = await supabase.rpc('mint_onboarding_token', {
    p_sfdc_account_id: body.sfdc_account_id,
    p_sfdc_opportunity_id: body.sfdc_opportunity_id,
    p_sfdc_contact_id: body.sfdc_contact_id ?? null,
    p_recipient_email: body.recipient_email ?? null,
    p_recipient_first_name: body.recipient_first_name ?? null,
    p_account_name: body.account_name ?? null,
  });

  if (error) {
    return jsonResponse(
      { error: 'mint failed', detail: error.message },
      500
    );
  }

  const token = data as string;
  const url = `${ONBOARDING_BASE_URL}/#/onboarding/start?token=${encodeURIComponent(token)}`;

  return jsonResponse({ token, url });
});
