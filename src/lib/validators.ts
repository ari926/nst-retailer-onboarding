/**
 * validators.ts
 *
 * Client-side input normalization + light validation. The server-side
 * Edge Functions do the authoritative checks (USPS Address API, SendGrid
 * MX lookup, Twilio number lookup); these helpers exist so retailers get
 * fast feedback while typing and so we don't bounce on trivial typos.
 *
 * Deliberately dependency-free — no libphonenumber, no commons-validator.
 * V1 traffic is 100% US, so we keep the surface area small.
 */

// ---------------------------------------------------------------------------
// Phone — E.164 normalization for US numbers
// ---------------------------------------------------------------------------

export type PhoneNormalizeResult =
  | { ok: true; e164: string; display: string }
  | { ok: false; reason: 'empty' | 'too_short' | 'too_long' | 'invalid_chars' };

/**
 * Accept common US input shapes and produce +1XXXXXXXXXX.
 *   "(212) 555-0100"  → +12125550100
 *   "212-555-0100"    → +12125550100
 *   "2125550100"      → +12125550100
 *   "+1 212 555 0100" → +12125550100
 *
 * Rejects anything that isn't 10 digits (or 11 with a leading 1).
 * International numbers are out of scope for V1 — ops will catch them
 * during the SFDC review.
 */
export function normalizePhoneUS(raw: string): PhoneNormalizeResult {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return { ok: false, reason: 'empty' };

  // Strip everything except digits and a possible leading +.
  const cleaned = trimmed.replace(/[^\d+]/g, '');
  if (/[^\d+]/.test(cleaned)) return { ok: false, reason: 'invalid_chars' };

  let digits = cleaned.replace(/^\+/, '');
  if (digits.length === 11 && digits.startsWith('1')) {
    digits = digits.slice(1);
  }

  if (digits.length < 10) return { ok: false, reason: 'too_short' };
  if (digits.length > 10) return { ok: false, reason: 'too_long' };

  const e164 = `+1${digits}`;
  const display = `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  return { ok: true, e164, display };
}

// ---------------------------------------------------------------------------
// Address — light format check; USPS Address API is authoritative server-side
// ---------------------------------------------------------------------------

export interface USAddress {
  line1: string;
  line2?: string;
  city: string;
  state: string; // 2-letter
  zip: string; // 5 or 9 digits
}

const US_STATES = new Set([
  'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA',
  'KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ',
  'NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT',
  'VA','WA','WV','WI','WY','DC','PR',
]);

export function validateAddressShape(addr: Partial<USAddress>): {
  ok: boolean;
  errors: Partial<Record<keyof USAddress, string>>;
} {
  const errors: Partial<Record<keyof USAddress, string>> = {};
  if (!addr.line1 || addr.line1.trim().length < 3) {
    errors.line1 = 'Street address is required';
  }
  if (!addr.city || addr.city.trim().length < 2) {
    errors.city = 'City is required';
  }
  if (!addr.state || !US_STATES.has(addr.state.toUpperCase())) {
    errors.state = 'Use a 2-letter US state code';
  }
  if (!addr.zip || !/^\d{5}(-?\d{4})?$/.test(addr.zip.trim())) {
    errors.zip = 'ZIP must be 5 digits (or ZIP+4)';
  }
  return { ok: Object.keys(errors).length === 0, errors };
}

/**
 * POST to our /usps-validate Edge Function. Returns the USPS-canonical
 * address on success, or null on any error so the caller can fall back
 * to the user-typed value with a soft warning.
 *
 * V1 implementation is a stub — the real USPS Web Tools call lands in
 * the same Edge Function once NST ops provisions a USERID. The shape
 * of this function is what the UI will call against.
 */
export async function verifyAddressUSPS(addr: USAddress): Promise<USAddress | null> {
  try {
    // Real implementation: supabase.functions.invoke('usps-validate', { body: addr })
    // For V1 we just uppercase the state + trim the line1 so the shape
    // is stable. The server call is wired but returns `{ ok: false }` until
    // the USPS USERID is set.
    const normalized: USAddress = {
      line1: addr.line1.trim().toUpperCase(),
      line2: addr.line2?.trim().toUpperCase(),
      city: addr.city.trim().toUpperCase(),
      state: addr.state.toUpperCase(),
      zip: addr.zip.replace(/[^\d]/g, '').slice(0, 5),
    };
    return normalized;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Email — RFC-light regex + MX lookup via Edge Function
// ---------------------------------------------------------------------------

// Pragmatic regex: rejects obvious garbage without being a full RFC 5322 impl.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function isEmailShape(email: string): boolean {
  return EMAIL_RE.test((email ?? '').trim());
}

/**
 * Light MX cache so typing e.g. "jane@gmial.com" doesn't hammer the
 * Edge Function on every keystroke. TTL is process-lifetime.
 */
const mxCache = new Map<string, boolean>();

/**
 * Ask the /mx-check Edge Function whether a domain has any MX or A records.
 * Returns `true` for deliverable, `false` for a definite no, and `null`
 * when the check itself fails (network, rate limit) — callers should
 * treat `null` as "let it through, SFDC ops will catch it".
 *
 * The Edge Function is intentionally forgiving: it returns `true` on
 * any lookup success so corporate domains with only A records still work.
 */
export async function mxCheck(email: string): Promise<boolean | null> {
  const trimmed = (email ?? '').trim().toLowerCase();
  if (!isEmailShape(trimmed)) return false;
  const domain = trimmed.split('@')[1];
  if (!domain) return false;
  if (mxCache.has(domain)) return mxCache.get(domain)!;

  try {
    const res = await fetch(`/api/mx-check?domain=${encodeURIComponent(domain)}`, {
      method: 'GET',
      // 1.5s hard cap — we never want MX check to block a save
      signal: AbortSignal.timeout?.(1500),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { deliverable?: boolean };
    const ok = body.deliverable !== false;
    mxCache.set(domain, ok);
    return ok;
  } catch {
    // Network error / timeout — don't block the retailer.
    return null;
  }
}
