// supabase/functions/sf-deploy-flow/index.ts
// One-shot Metadata API deployer. POST { zip_base64 } -> deploy via SOAP, poll.
// Reuses SF_CLIENT_ID / SF_USERNAME / SF_PRIVATE_KEY / SF_LOGIN_URL env vars.

// deno-lint-ignore-file no-explicit-any

const META_API_VERSION = '60.0';

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
  const resp = await fetch(`${loginUrl}/services/oauth2/token`,
    { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  if (!resp.ok) throw new Error(`SF token: ${resp.status} ${await resp.text()}`);
  return await resp.json();
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

async function metaSoap(instanceUrl: string, token: string, action: string, body: string): Promise<string> {
  const env = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:met="http://soap.sforce.com/2006/04/metadata">
  <soapenv:Header><met:SessionHeader><met:sessionId>${xmlEscape(token)}</met:sessionId></met:SessionHeader></soapenv:Header>
  <soapenv:Body>${body}</soapenv:Body>
</soapenv:Envelope>`;
  const r = await fetch(`${instanceUrl}/services/Soap/m/${META_API_VERSION}`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/xml; charset=UTF-8', 'SOAPAction': action },
    body: env,
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`SOAP ${action} ${r.status}: ${text.slice(0, 1500)}`);
  return text;
}

function pick(xml: string, tag: string): string | null {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`));
  return m ? m[1] : null;
}

Deno.serve(async (req: Request) => {
  try {
    if (req.method !== 'POST') {
      return new Response(JSON.stringify({ error: 'POST { zip_base64 }' }),
        { status: 405, headers: { 'content-type': 'application/json' } });
    }
    const { zip_base64, check_only } = await req.json();
    if (!zip_base64) {
      return new Response(JSON.stringify({ error: 'zip_base64 required' }),
        { status: 400, headers: { 'content-type': 'application/json' } });
    }
    const tok = await getToken();

    const deployBody = `<met:deploy>
      <met:ZipFile>${zip_base64}</met:ZipFile>
      <met:DeployOptions>
        <met:allowMissingFiles>false</met:allowMissingFiles>
        <met:autoUpdatePackage>false</met:autoUpdatePackage>
        <met:checkOnly>${check_only ? 'true' : 'false'}</met:checkOnly>
        <met:ignoreWarnings>false</met:ignoreWarnings>
        <met:performRetrieve>false</met:performRetrieve>
        <met:purgeOnDelete>false</met:purgeOnDelete>
        <met:rollbackOnError>true</met:rollbackOnError>
        <met:singlePackage>true</met:singlePackage>
      </met:DeployOptions></met:deploy>`;
    const dr = await metaSoap(tok.instance_url, tok.access_token, 'deploy', deployBody);
    const asyncId = pick(dr, 'id');
    if (!asyncId) {
      return new Response(JSON.stringify({ error: 'no async id', raw: dr.slice(0, 1500) }),
        { status: 500, headers: { 'content-type': 'application/json' } });
    }

    const started = Date.now();
    let last = '';
    let done = false;
    while (Date.now() - started < 90_000) {
      await new Promise((r) => setTimeout(r, 3000));
      const checkBody = `<met:checkDeployStatus><met:asyncProcessId>${asyncId}</met:asyncProcessId><met:includeDetails>true</met:includeDetails></met:checkDeployStatus>`;
      last = await metaSoap(tok.instance_url, tok.access_token, 'checkDeployStatus', checkBody);
      if (pick(last, 'done') === 'true') { done = true; break; }
    }

    const failures: string[] = [];
    const re = /<componentFailures>([\s\S]*?)<\/componentFailures>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(last)) !== null) {
      failures.push(`${pick(m[1], 'fullName') ?? ''}: ${pick(m[1], 'problem') ?? ''}`);
    }

    return new Response(JSON.stringify({
      asyncProcessId: asyncId,
      done,
      status: pick(last, 'status'),
      success: pick(last, 'success'),
      numberComponentErrors: pick(last, 'numberComponentErrors'),
      failures,
      raw_tail: last.slice(-1500),
    }, null, 2), { status: 200, headers: { 'content-type': 'application/json' } });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }),
      { status: 500, headers: { 'content-type': 'application/json' } });
  }
});
