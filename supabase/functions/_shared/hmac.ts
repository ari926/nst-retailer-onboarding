// Shared HMAC-SHA256 sign/verify helpers used by the HQ ↔ portal bridge.
//
// The HQ Lovable app and this portal share a secret `PORTAL_WEBHOOK_SECRET`.
// Every cross-system request is signed with this secret so each side can
// verify the other before trusting the payload.
//
// Directions:
//   - HQ → portal: HQ signs with `x-hq-signature` (mint-onboarding-token,
//     validate-token, reopen-step). Portal verifies.
//   - portal → HQ: portal signs with `x-portal-signature` on the
//     portal-progress-webhook. HQ verifies.

export async function hmacSign(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(body),
  );
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Constant-time comparison. Returns true iff the signature matches. */
export async function hmacVerify(
  secret: string,
  body: string,
  signature: string,
): Promise<boolean> {
  if (!signature) return false;
  const expected = await hmacSign(secret, body);
  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  }
  return diff === 0;
}
