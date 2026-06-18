// Activate a Salesforce Flow's latest version via Tooling API.
// POST { developerName: "NST_Send_Kickoff_On_Closed_Won" }

const SF_API_VERSION = 'v60.0';

interface SfToken { access_token: string; instance_url: string; }

function pemToArrayBuffer(pem: string): ArrayBuffer {
  const b64 = pem.replace(/-----BEGIN PRIVATE KEY-----/g, '')
    .replace(/-----END PRIVATE KEY-----/g, '').replace(/\s+/g, '');
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf.buffer;
}

async function getToken(): Promise<SfToken> {
  const clientId = Deno.env.get('SF_CLIENT_ID');
  const username = Deno.env.get('SF_USERNAME');
  const privateKey = Deno.env.get('SF_PRIVATE_KEY');
  const loginUrl = Deno.env.get('SF_LOGIN_URL') ?? 'https://login.salesforce.com';
  if (!clientId || !username || !privateKey) throw new Error('SF credentials missing');
  const header = { alg: 'RS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const claims = { iss: clientId, sub: username, aud: loginUrl, exp: now + 180 };
  const enc = (o: unknown) => btoa(JSON.stringify(o)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  const toSign = `${enc(header)}.${enc(claims)}`;
  const key = await crypto.subtle.importKey('pkcs8', pemToArrayBuffer(privateKey),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(toSign));
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion: `${toSign}.${sigB64}`,
  });
  const r = await fetch(`${loginUrl}/services/oauth2/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body,
  });
  if (!r.ok) throw new Error(`SF token: ${r.status} ${await r.text()}`);
  return await r.json();
}

async function tooling(tok: SfToken, method: string, path: string, body?: object): Promise<any> {
  const url = `${tok.instance_url}/services/data/${SF_API_VERSION}/tooling${path}`;
  const r = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${tok.access_token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`Tooling ${method} ${path} ${r.status}: ${text.slice(0, 800)}`);
  try { return JSON.parse(text); } catch { return text; }
}

Deno.serve(async (req: Request) => {
  try {
    if (req.method !== 'POST') {
      return new Response(JSON.stringify({ error: 'POST { developerName }' }),
        { status: 405, headers: { 'content-type': 'application/json' } });
    }
    const { developerName } = await req.json();
    if (!developerName) {
      return new Response(JSON.stringify({ error: 'developerName required' }),
        { status: 400, headers: { 'content-type': 'application/json' } });
    }
    const tok = await getToken();

    // 1. Find the FlowDefinition + its latest Flow version
    const defQ = encodeURIComponent(
      `SELECT Id, DeveloperName, ActiveVersionId, LatestVersionId FROM FlowDefinition WHERE DeveloperName = '${developerName}'`
    );
    const defResp = await tooling(tok, 'GET', `/query/?q=${defQ}`);
    if (!defResp.records || defResp.records.length === 0) {
      return new Response(JSON.stringify({ error: 'FlowDefinition not found' }),
        { status: 404, headers: { 'content-type': 'application/json' } });
    }
    const def = defResp.records[0];

    // 2. Find latest version number from Flow object
    const flowQ = encodeURIComponent(
      `SELECT Id, VersionNumber, Status FROM Flow WHERE DefinitionId = '${def.Id}' ORDER BY VersionNumber DESC LIMIT 1`
    );
    const flowResp = await tooling(tok, 'GET', `/query/?q=${flowQ}`);
    if (!flowResp.records || flowResp.records.length === 0) {
      return new Response(JSON.stringify({ error: 'No Flow versions found', def }),
        { status: 404, headers: { 'content-type': 'application/json' } });
    }
    const latest = flowResp.records[0];

    // 3. Activate by PATCHing FlowDefinition with ActiveVersionNumber
    await tooling(tok, 'PATCH', `/sobjects/FlowDefinition/${def.Id}`, {
      Metadata: { activeVersionNumber: latest.VersionNumber },
    });

    // 4. Verify
    const verifyResp = await tooling(tok, 'GET', `/query/?q=${defQ}`);
    return new Response(JSON.stringify({
      ok: true,
      definition: def,
      activatedVersion: latest,
      after: verifyResp.records?.[0],
    }, null, 2), { status: 200, headers: { 'content-type': 'application/json' } });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }),
      { status: 500, headers: { 'content-type': 'application/json' } });
  }
});
