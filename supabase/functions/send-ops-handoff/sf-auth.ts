// supabase/functions/send-ops-handoff/sf-auth.ts
//
// Salesforce JWT Bearer auth — same flow as sf-sync. Extracted into a small
// helper so we don't duplicate the WebCrypto signing dance across functions.
//
// In V2, when we have more than two SF-touching functions, we should move this
// to supabase/functions/_shared/sf-auth.ts. Keeping it local for now to avoid
// disturbing the deployed sf-sync function.

export interface SfToken {
  access_token: string;
  instance_url: string;
}

const SF_API_VERSION = 'v61.0';

export async function getSalesforceAccessToken(): Promise<SfToken> {
  const clientId = Deno.env.get('SF_CLIENT_ID');
  const username = Deno.env.get('SF_USERNAME');
  const privateKey = Deno.env.get('SF_PRIVATE_KEY');
  const loginUrl = Deno.env.get('SF_LOGIN_URL') ?? 'https://login.salesforce.com';

  if (!clientId || !username || !privateKey) {
    throw new Error('SF credentials missing from env');
  }

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

/** Plain JSON SF REST call (GET/POST/PATCH/DELETE). Throws on non-2xx. */
export async function sfRequest(
  token: SfToken,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
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
  if (resp.status === 204) return null;
  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`SF ${method} ${path} → ${resp.status}: ${text.slice(0, 600)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export { SF_API_VERSION };
