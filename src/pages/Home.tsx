import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { mockSignIn, MOCK_AUTH_ENABLED } from '../hooks/useAuth';
import { useOnboardingStore } from '../stores/onboardingStore';
import { resolveAndStoreToken } from '../lib/tokenSession';
import { SUPABASE_PROJECT_URL } from '../lib/supabase';
import { isDemoMode } from '../lib/demoMode';

type TokenStatus = 'idle' | 'resolving' | 'invalid' | 'expired' | 'revoked' | 'error';

/**
 * Home — public landing.
 *
 * If we arrive with a kickoff token (`?t=<token>`) — either the customer's
 * intro-email link or an HQ admin's "view as customer" link — we resolve
 * the token via the resolve-token edge function, persist the session, and
 * redirect into the onboarding flow.
 *
 * Customer tokens (source = 'intro_email') and admin tokens (source =
 * 'admin_access') land here the same way; the difference shows up in the
 * AdminModeBanner inside AppLayout once the session is hydrated.
 *
 * If no token is present, we show the simple landing CTA.
 */
export default function Home() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const setOnboarding = useOnboardingStore((s) => s.setOnboarding);

  const token = params.get('t');
  const demo = isDemoMode();
  const [status, setStatus] = useState<TokenStatus>(token ? 'resolving' : 'idle');
  const [errorDetail, setErrorDetail] = useState<string | null>(null);

  // Demo mode — jump straight into the onboarding flow with the demo flag
  // preserved in the URL so deep links and refreshes stay in demo mode.
  useEffect(() => {
    if (demo) {
      setOnboarding({ currentStep: 1 });
      navigate('/onboarding/profile?demo=1', { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [demo]);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;

    (async () => {
      // Mock auth path — kept so existing local-dev workflows don't break.
      if (MOCK_AUTH_ENABLED) {
        try {
          mockSignIn('retailer@onboarding.local', 'TOKEN');
        } catch {
          // already mock-signed-in, ignore
        }
        setOnboarding({ currentStep: 1 });
        navigate(`/onboarding/profile?t=${encodeURIComponent(token)}`, { replace: true });
        return;
      }

      // Real path — resolve the opaque token against the portal database.
      const result = await resolveAndStoreToken(token, SUPABASE_PROJECT_URL);
      if (cancelled) return;

      if ('error' in result) {
        const reason = result.error;
        if (reason === 'expired') setStatus('expired');
        else if (reason === 'revoked') setStatus('revoked');
        else if (reason === 'not_found') setStatus('invalid');
        else {
          setStatus('error');
          setErrorDetail(reason);
        }
        return;
      }

      setOnboarding({
        sfdcAccountId: result.sfdc_account_id,
        currentStep: 1,
      });
      navigate(`/onboarding/profile?t=${encodeURIComponent(token)}`, { replace: true });
    })();

    return () => {
      cancelled = true;
    };
  }, [token, navigate, setOnboarding]);

  const toggleLang = () => {
    const next = i18n.language.startsWith('es') ? 'en' : 'es';
    i18n.changeLanguage(next);
  };

  if (token) {
    // Token landing states
    const errorMessage =
      status === 'expired'
        ? t('home.token_expired', 'This onboarding link has expired. Contact your NST representative for a new one.')
        : status === 'revoked'
        ? t('home.token_revoked', 'This onboarding link has been revoked. Contact your NST representative.')
        : status === 'invalid'
        ? t('home.token_invalid', 'This onboarding link is not valid. Double-check the URL or contact NST.')
        : status === 'error'
        ? t('home.token_error', 'We hit a problem opening this link. Please try again in a moment.') +
          (errorDetail ? ` (${errorDetail})` : '')
        : null;

    return (
      <main style={{ minHeight: '100vh', padding: 'var(--space-8) 0' }}>
        <div className="container" style={{ maxWidth: '480px', textAlign: 'center' }}>
          {status === 'resolving' && (
            <p className="text-muted">{t('home.token_loading', 'Loading your onboarding…')}</p>
          )}
          {errorMessage && (
            <div className="card stack stack-md">
              <div className="banner banner-error" role="alert">
                <span>{errorMessage}</span>
              </div>
              <a href="/login" className="btn btn-secondary">
                {t('home.signin_cta', 'Sign in')}
              </a>
            </div>
          )}
        </div>
      </main>
    );
  }

  return (
    <main style={{ minHeight: '100vh', padding: 'var(--space-8) 0' }}>
      <div className="container" style={{ maxWidth: '640px' }}>
        <header className="stack stack-sm" style={{ marginBottom: 'var(--space-8)' }}>
          <div className="text-muted text-sm">National Secure Transport</div>
          <h1>NST Retailer Onboarding</h1>
          <p className="text-muted">
            {t('home.subtitle', 'Your self-serve setup starts here. Claim your account to begin.')}
          </p>
        </header>

        <div className="card stack stack-md">
          <div className="stack stack-xs">
            <div className="text-xs text-muted" style={{ textTransform: 'uppercase', letterSpacing: '0.08em' }}>
              {t('home.eyebrow', 'Welcome')}
            </div>
            <p className="text-sm text-muted">
              {t('home.hint', 'Use the link from your welcome email to start onboarding.')}
            </p>
          </div>

          <div className="row row-sm">
            <a href="/login" className="btn btn-secondary">
              {t('home.signin_cta', 'Sign in')}
            </a>
            <button type="button" className="btn btn-ghost" onClick={toggleLang}>
              {i18n.language.startsWith('es') ? 'EN' : 'ES'}
            </button>
          </div>
        </div>

        <footer className="text-xs text-muted" style={{ marginTop: 'var(--space-8)' }}>
          © {new Date().getFullYear()} National Secure Transport
        </footer>
      </div>
    </main>
  );
}
