import { useEffect, useState } from 'react';
import type { Session, User } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';

/**
 * useAuth — wraps the Supabase session listener.
 *
 * In dev / scaffolding, VITE_MOCK_AUTH=true lets us bypass real Supabase auth
 * and treat any local 'nst_mock_user' localStorage entry as an authenticated user.
 * This lets the team click through the flow end-to-end before Salesforce is
 * wired up to seed real accounts (PR #11).
 */
export interface AuthContextValue {
  user: User | MockUser | null;
  session: Session | null;
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

export function useAuth(): AuthContextValue {
  const [user, setUser] = useState<User | MockUser | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [initialized, setInitialized] = useState(false);

  useEffect(() => {
    let mounted = true;

    // Hydrate from mock first if enabled
    const mock = readMockUser();
    if (mock) {
      setUser(mock);
      setLoading(false);
      setInitialized(true);
      return;
    }

    // Real Supabase session
    supabase.auth.getSession().then(({ data }) => {
      if (!mounted) return;
      setSession(data.session);
      setUser(data.session?.user ?? null);
      setLoading(false);
      setInitialized(true);
    });

    const { data: sub } = supabase.auth.onAuthStateChange((_evt, nextSession) => {
      if (!mounted) return;
      setSession(nextSession);
      setUser(nextSession?.user ?? null);
    });

    return () => {
      mounted = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  return { user, session, loading, initialized };
}

/**
 * Sign out from both mock and real Supabase auth.
 */
export async function signOut() {
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
