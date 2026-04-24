import { useTranslation } from 'react-i18next';

/**
 * Home — minimal landing for PR #1 scaffold.
 * Will be replaced in PR #3 by auth gate → redirect to /onboarding.
 */
export default function Home() {
  const { t, i18n } = useTranslation();

  const toggleLang = () => {
    const next = i18n.language.startsWith('es') ? 'en' : 'es';
    i18n.changeLanguage(next);
  };

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
              PR #1 scaffold
            </div>
            <p className="text-sm text-muted">
              This is the repo scaffold only. Auth, layout, and step screens land in PR #2 and #3.
            </p>
          </div>

          <div className="row row-sm">
            <button type="button" className="btn btn-primary" disabled>
              {t('home.claim_cta', 'Claim your account')}
            </button>
            <a href="/onboarding" className="btn btn-secondary">
              {t('home.preview_cta', 'Preview the flow')}
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
