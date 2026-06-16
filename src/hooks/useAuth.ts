import { useEffect, useState } from 'react';
import type { Session, User } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';
import {
  readTokenSession,
  clearTokenSession,
  TOKEN_SESSION_KEY,
  type TokenSession,
} from '../lib/tokenSession';
import { isDemoMode } from '../lib/demoMode';

/**
 * useAuth — unified session source.
 *
 * Three flavors of "signed in":
 *   1. Token session   — HQ-minted opaque token (`?t=<token>`) resolved via
 *                        the resolve-token edge function. Used by both the
 *                        customer intro-email flow and the HQ admin
 *                        "view as customer" flow.
 *   2. Mock session    — VITE_MOCK_AUTH=true; click-through demo mode.
 *   3. Supabase auth   — returning user signed in with email + password.
 *
 * The token session is checked first so HQ admins and email-link visitors
 * never get redirected to /login.
 */
export interface AuthContextValue {
  user: User | MockUser | TokenUser | null;
  session: Session | null;
  /** Present when the active session is a token session (customer or admin). */
  tokenSession: TokenSession | null;
  /** True when source = 'admin_access' on the active token session. */
  isAdminSession: boolean;
  loading: boolean;
  /** True when we've finished the initial hydration. */
  initialized: boolean;
}

interface MockUser {
  id: string;
  email: string;
  _mock: true;
  user_metadata: Record<string, unknown>;
}

interface TokenUser {
  id: string;
  email: string | null;
  _token: true;
  user_metadata: {
    sfdc_account_id: string;
    sfdc_opportunity_id: string;
    source: 'intro_email' | 'admin_access';
    acting_admin_email: string | null;
  };
}

const MOCK_KEY = 'nst_mock_user';
const MOCK_AUTH_ENABLED = import.meta.env.VITE_MOCK_AUTH === 'true';

function readMockUser(): MockUser | null {
  if (!MOCK_AUTH_ENABLED) return null;
  try {
    const raw = localStorage.getItem(MOCK_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as MockUser;
  } catch {
    return null;
  }
}

function tokenSessionToUser(ts: TokenSession): TokenUser {
  return {
    id: `token-${ts.sfdc_account_id}`,
    email: ts.contact_email,
    _token: true,
    user_metadata: {
      sfdc_account_id: ts.sfdc_account_id,
      sfdc_opportunity_id: ts.sfdc_opportunity_id,
      source: ts.source,
      acting_admin_email: ts.acting_admin_email,
    },
  };
}

export function useAuth(): AuthContextValue {
  const [user, setUser] = useState<User | MockUser | TokenUser | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [tokenSession, setTokenSession] = useState<TokenSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [initialized, setInitialized] = useState(false);

  useEffect(() => {
    let mounted = true;

    // Demo mode — inject a synthetic mock user so ProtectedRoute lets the
    // visitor in without needing a real kickoff token. No backend calls.
    if (isDemoMode()) {
      const demoUser: MockUser = {
        id: 'demo-user',
        email: 'demo@nationalsecuretransport.com',
        _mock: true,
        user_metadata: { first_name: 'Demo', is_demo: true },
      };
      setUser(demoUser);
      setLoading(false);
      setInitialized(true);
      return () => { mounted = false; };
    }

    // Hydrate token session first — it wins over Supabase auth and mock.
    const ts = readTokenSession();
    if (ts) {
      setTokenSession(ts);
      setUser(tokenSessionToUser(ts));
      setLoading(false);
      setInitialized(true);
    } else {
      // No token session — try mock
      const mock = readMockUser();
      if (mock) {
        setUser(mock);
        setLoading(false);
        setInitialized(true);
      } else {
        // Real Supabase session
        supabase.auth.getSession().then(({ data }) => {
          if (!mounted) return;
          setSession(data.session);
          setUser(data.session?.user ?? null);
          setLoading(false);
          setInitialized(true);
        });
      }
    }

    // Listen for token session changes (writes from resolveAndStoreToken or
    // signOut). Same-tab writes dispatch a synthetic StorageEvent.
    const onStorage = (e: StorageEvent) => {
      if (e.key !== TOKEN_SESSION_KEY) return;
      const next = readTokenSession();
      setTokenSession(next);
      setUser(next ? tokenSessionToUser(next) : null);
      setInitialized(true);
    };
    window.addEventListener('storage', onStorage);

    const { data: sub } = supabase.auth.onAuthStateChange((_evt, nextSession) => {
      if (!mounted) return;
      // Don't overwrite a token session with a (likely null) Supabase session.
      if (readTokenSession()) return;
      setSession(nextSession);
      setUser(nextSession?.user ?? null);
    });

    return () => {
      mounted = false;
      window.removeEventListener('storage', onStorage);
      sub.subscription.unsubscribe();
    };
  }, []);

  return {
    user,
    session,
    tokenSession,
    isAdminSession: tokenSession?.source === 'admin_access',
    loading,
    initialized,
  };
}

/**
 * Sign out from token session, mock, and real Supabase auth.
 */
export async function signOut() {
  clearTokenSession();
  localStorage.removeItem(MOCK_KEY);
  await supabase.auth.signOut();
}

/**
 * Mock sign-in helper — only active when VITE_MOCK_AUTH=true.
 * Used by Step 0 in dev mode so the PR can be demoed without Salesforce.
 */
export function mockSignIn(email: string, sfdcAccountId = 'MOCK-001') {
  if (!MOCK_AUTH_ENABLED) {
    throw new Error('Mock auth disabled — set VITE_MOCK_AUTH=true in .env.local');
  }
  const mock: MockUser = {
    id: `mock-${Date.now()}`,
    email,
    _mock: true,
    user_metadata: {
      sfdc_account_id: sfdcAccountId,
      first_name: email.split('@')[0],
    },
  };
  localStorage.setItem(MOCK_KEY, JSON.stringify(mock));
  // Dispatch a storage event so useAuth re-reads on same tab.
  window.dispatchEvent(new StorageEvent('storage', { key: MOCK_KEY }));
  return mock;
}

export { MOCK_AUTH_ENABLED };
