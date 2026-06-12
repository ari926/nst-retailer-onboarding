// Token session — client-side representation of an opaque kickoff token after
// it's been resolved by the portal's `resolve-token` edge function.
//
// Two sources of tokens:
//   1. intro_email — the long-lived (60d) token sent in the welcome email.
//                    Standard customer flow. No admin banner.
//   2. admin_access — short-lived (24h) HQ admin "view as customer" token.
//                     Shows the admin-mode banner. Every action logged.
//
// The session is persisted to localStorage under TOKEN_SESSION_KEY so
// refreshes preserve it. It's also kept in sessionStorage as `t` so the
// existing kickoff-token hooks (PR #16 fix `3e0444f`) keep working.

import { z } from 'zod';

export const TOKEN_SESSION_KEY = 'nst_token_session';
const KICKOFF_TOKEN_KEY = 'nst_kickoff_token'; // matches existing sessionStorage key

export const tokenSessionSchema = z.object({
  token: z.string().min(20),
  sfdc_account_id: z.string(),
  sfdc_opportunity_id: z.string(),
  sfdc_contact_id: z.string().nullable(),
  contact_email: z.string().nullable(),
  source: z.enum(['intro_email', 'admin_access']),
  acting_admin_email: z.string().nullable(),
  expires_at: z.string(), // ISO timestamp
  resolved_at: z.string(), // ISO timestamp — when the SPA last validated
});

export type TokenSession = z.infer<typeof tokenSessionSchema>;

/**
 * Read the current token session from localStorage, if any.
 * Returns null if missing, malformed, or expired.
 */
export function readTokenSession(): TokenSession | null {
  try {
    const raw = localStorage.getItem(TOKEN_SESSION_KEY);
    if (!raw) return null;
    const parsed = tokenSessionSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      clearTokenSession();
      return null;
    }
    if (new Date(parsed.data.expires_at) <= new Date()) {
      clearTokenSession();
      return null;
    }
    return parsed.data;
  } catch {
    return null;
  }
}

/**
 * Persist a token session. Also mirrors the raw token into sessionStorage so
 * the existing submitStep helpers (which look for `nst_kickoff_token`) keep
 * functioning without a refactor.
 */
export function writeTokenSession(session: TokenSession) {
  localStorage.setItem(TOKEN_SESSION_KEY, JSON.stringify(session));
  try {
    sessionStorage.setItem(KICKOFF_TOKEN_KEY, session.token);
  } catch {
    // sessionStorage may be unavailable in some embedded contexts; ignore.
  }
  // Same-tab listeners need a synthetic storage event since native ones only
  // fire on cross-tab writes.
  window.dispatchEvent(
    new StorageEvent('storage', { key: TOKEN_SESSION_KEY, newValue: JSON.stringify(session) }),
  );
}

export function clearTokenSession() {
  localStorage.removeItem(TOKEN_SESSION_KEY);
  try {
    sessionStorage.removeItem(KICKOFF_TOKEN_KEY);
  } catch {
    // ignore
  }
  window.dispatchEvent(
    new StorageEvent('storage', { key: TOKEN_SESSION_KEY, newValue: null }),
  );
}

/**
 * Convenience: is this an admin-mode session?
 */
export function isAdminSession(session: TokenSession | null): boolean {
  return !!session && session.source === 'admin_access';
}

/**
 * Resolve a raw token (from `?t=<token>` in the URL) by calling the portal's
 * resolve-token edge function. Stores the result on success.
 */
export async function resolveAndStoreToken(
  token: string,
  supabaseUrl: string,
): Promise<TokenSession | { error: string }> {
  const resp = await fetch(`${supabaseUrl}/functions/v1/resolve-token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
  });

  if (!resp.ok) {
    let reason = `http_${resp.status}`;
    try {
      const data = await resp.json();
      reason = data?.reason ?? data?.error ?? reason;
    } catch {
      // ignore
    }
    return { error: reason };
  }

  const data = await resp.json();
  if (!data?.ok) {
    return { error: data?.reason ?? 'invalid' };
  }

  const session: TokenSession = {
    token,
    sfdc_account_id: data.sfdc_account_id,
    sfdc_opportunity_id: data.sfdc_opportunity_id,
    sfdc_contact_id: data.sfdc_contact_id ?? null,
    contact_email: data.contact_email ?? null,
    source: data.source,
    acting_admin_email: data.acting_admin_email ?? null,
    expires_at: data.expires_at,
    resolved_at: new Date().toISOString(),
  };

  const validation = tokenSessionSchema.safeParse(session);
  if (!validation.success) {
    return { error: 'malformed_response' };
  }

  writeTokenSession(session);
  return session;
}
