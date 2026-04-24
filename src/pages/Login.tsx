import { useState } from 'react';
import { useNavigate, useLocation, Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { supabase } from '../lib/supabase';
import { mockSignIn, MOCK_AUTH_ENABLED } from '../hooks/useAuth';

/**
 * Login — normal "returning user" sign-in.
 * New retailers go to /claim first (deep-linked from the claim email).
 *
 * In mock mode (VITE_MOCK_AUTH=true) any email logs you in with a fake session
 * so the flow is demoable before Salesforce seeds real accounts.
 */
export default function Login() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as { from?: string } | null)?.from || '/onboarding';

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);

    try {
      if (MOCK_AUTH_ENABLED) {
        mockSignIn(email);
        navigate(from, { replace: true });
        return;
      }

      const { error: signInError } = await supabase.auth.signInWithPassword({
        email,
        password,
      });
      if (signInError) throw signInError;
      navigate(from, { replace: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : t('global.errors.generic');
      setError(message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main style={{ minHeight: '100vh', padding: 'var(--space-8) 0' }}>
      <div className="container" style={{ maxWidth: '440px' }}>
        <header className="stack stack-sm" style={{ marginBottom: 'var(--space-6)' }}>
          <div className="text-muted text-sm">National Secure Transport</div>
          <h1>{t('login.title', 'Sign in')}</h1>
          <p className="text-muted">
            {t('login.subtitle', 'New to NST? Use the link in your welcome email to claim your account.')}
          </p>
        </header>

        <form onSubmit={handleSubmit} className="card stack stack-md" noValidate>
          <div className="field">
            <label htmlFor="email" className="field-label field-required">
              {t('login.email', 'Email')}
            </label>
            <input
              id="email"
              type="email"
              className="input"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoComplete="email"
            />
          </div>

          {!MOCK_AUTH_ENABLED && (
            <div className="field">
              <label htmlFor="password" className="field-label field-required">
                {t('login.password', 'Password')}
              </label>
              <input
                id="password"
                type="password"
                className="input"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                autoComplete="current-password"
                minLength={12}
              />
            </div>
          )}

          {MOCK_AUTH_ENABLED && (
            <div className="banner banner-info text-sm">
              <span>Mock auth is on. Any email signs you in.</span>
            </div>
          )}

          {error && (
            <div className="banner banner-error" role="alert">
              <span>{error}</span>
            </div>
          )}

          <button type="submit" className="btn btn-primary btn-block" disabled={submitting}>
            {submitting ? <span className="spinner" aria-hidden /> : t('login.submit', 'Sign in')}
          </button>

          <div className="text-sm text-muted" style={{ textAlign: 'center' }}>
            <Link to="/claim" style={{ color: 'var(--nst-teal)' }}>
              {t('login.new_account', 'New account? Claim it here')}
            </Link>
          </div>
        </form>
      </div>
    </main>
  );
}
