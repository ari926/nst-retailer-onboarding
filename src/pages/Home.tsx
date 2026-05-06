import { useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { mockSignIn, MOCK_AUTH_ENABLED } from '../hooks/useAuth';
import { useOnboardingStore } from '../stores/onboardingStore';

/**
 * Home — public landing.
 *
 * If we arrive with a kickoff token (`?t=<token>`) — the link the retailer
 * receives in their welcome email — we seed a mock session (current testing
 * mode) and redirect straight to the Step 1 review screen so they don't have
 * to re-enter info we already have on file in Salesforce.
 *
 * If no token is present, we show the simple landing CTA.
 */
export default function Home() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const setOnboarding = useOnboardingStore((s) => s.setOnboarding);

  const token = params.get('t');

  useEffect(() => {
    if (!token) return;
    // Mock auth banner stays ON during testing — seed a placeholder session
    // so ProtectedRoute lets us through. The real prefill (legal name, address,
    // contact, etc.) is fetched server-side from Salesforce via the token in
    // get-onboarding-context.
    if (MOCK_AUTH_ENABLED) {
      try {
        mockSignIn('retailer@onboarding.local', 'TOKEN');
      } catch {
        // already mock-signed-in, ignore
      }
    }
    setOnboarding({ currentStep: 1 });
    navigate(`/onboarding/profile?t=${encodeURIComponent(token)}`, { replace: true });
  }, [token, navigate, setOnboarding]);

  const toggleLang = () => {
    const next = i18n.language.startsWith('es') ? 'en' : 'es';
    i18n.changeLanguage(next);
  };

  if (token) {
    // While the redirect runs
    return (
      <main style={{ minHeight: '100vh', padding: 'var(--space-8) 0' }}>
        <div className="container" style={{ maxWidth: '480px', textAlign: 'center' }}>
          <p className="text-muted">Loading your onboarding…</p>
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
