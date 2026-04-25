import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { trackEvent } from '../lib/analytics';

/**
 * Home — public landing page.
 * Sends retailers to /claim to enter their invite code, or into the flow
 * via /onboarding if they're already authenticated.
 */
export default function Home() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();

  const toggleLang = () => {
    const next = i18n.language.startsWith('es') ? 'en' : 'es';
    i18n.changeLanguage(next);
    trackEvent('home.language_toggled', { to: next });
  };

  const handleClaim = () => {
    trackEvent('home.claim_clicked', { lang: i18n.language });
    navigate('/claim');
  };

  return (
    <main style={{ minHeight: '100vh', padding: 'var(--space-8) 0' }}>
      <div className="container" style={{ maxWidth: '640px' }}>
        <header className="stack stack-sm" style={{ marginBottom: 'var(--space-8)' }}>
          <div className="text-muted text-sm">National Secure Transport</div>
          <h1>{t('home.title', 'NST Retailer Onboarding')}</h1>
          <p className="text-muted">
            {t(
              'home.subtitle',
              'Your self-serve setup starts here. Claim your account to begin — most retailers finish in about 20 minutes.'
            )}
          </p>
        </header>

        <div className="card stack stack-md">
          <div className="stack stack-xs">
            <div className="text-sm">
              {t(
                'home.body',
                "We'll confirm your storefront details, collect banking info, and schedule your first pickup. You can save and come back anytime."
              )}
            </div>
            <div className="text-xs text-muted">
              {t('home.secure_note', 'All inputs are encrypted at rest. NST never stores full safe combinations.')}
            </div>
          </div>

          <div className="row row-sm">
            <button type="button" className="btn btn-primary" onClick={handleClaim}>
              {t('home.claim_cta', 'Claim your account')}
            </button>
            <Link to="/login" className="btn btn-secondary">
              {t('home.preview_cta', 'Preview the flow')}
            </Link>
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
