import { createClient } from '@supabase/supabase-js';

// Portal Supabase project. Env-var-driven so we can override in local dev,
// but with real production fallbacks so `npm run build` on a fresh checkout
// (or a GH Actions build without secrets) still produces a working bundle.
//
// The anon key here is a public JWT — safe to embed in a client bundle.
const PROD_SUPABASE_URL = 'https://rqmtikbgkplxmmchyujo.supabase.co';
const PROD_SUPABASE_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJxbXRpa2Jna3BseG1tY2h5dWpvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY5OTk5MTYsImV4cCI6MjA5MjU3NTkxNn0.YyEDIMhHCSvX-LCnSNfjtpMRcITO62hMDyEXvsGanAE';

const SUPABASE_URL = (import.meta.env.VITE_SUPABASE_URL as string) || PROD_SUPABASE_URL;
const SUPABASE_ANON_KEY = (import.meta.env.VITE_SUPABASE_ANON_KEY as string) || PROD_SUPABASE_ANON_KEY;

export const SUPABASE_PROJECT_URL = SUPABASE_URL;
export const SUPABASE_PUBLIC_ANON_KEY = SUPABASE_ANON_KEY;

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
});

export type SupabaseClient = typeof supabase;
