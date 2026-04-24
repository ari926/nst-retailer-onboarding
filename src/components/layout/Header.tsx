import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { LogOut } from 'lucide-react';
import { Logo } from './Logo';
import { LanguageToggle } from './LanguageToggle';
import { ProgressBar } from './ProgressBar';
import { useOnboardingStore } from '../../stores/onboardingStore';
import { signOut } from '../../hooks/useAuth';

/**
 * Top bar for onboarding flow.
 * Left: logo + store name pill.
 * Center: progress bar.
 * Right: save-later, support, language toggle.
 */
export function Header() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const storefrontName = useOnboardingStore((s) => s.storefrontName);
  const reset = useOnboardingStore((s) => s.reset);

  const handleSignOut = async () => {
    await signOut();
    reset();
    navigate('/login', { replace: true });
  };

  return (
    <header className="app-header">
      <div className="app-header__left">
        <Logo />
        {storefrontName && (
          <>
            <span className="app-header__divider" aria-hidden="true">·</span>
            <span className="app-header__store">
              <span className="text-muted text-xs" style={{ marginRight: 'var(--space-1)' }}>
                {t('global.header.store_label')}
              </span>
              <span>{storefrontName}</span>
            </span>
          </>
        )}
      </div>

      <div className="app-header__center">
        <ProgressBar />
      </div>

      <div className="app-header__right">
        <button type="button" className="btn btn-ghost text-sm">
          {t('global.header.save_later')}
        </button>
        <button type="button" className="btn btn-ghost text-sm" aria-label="Contact support">
          {t('global.header.support_chip')}
        </button>
        <LanguageToggle />
        <button
          type="button"
          className="btn btn-ghost"
          onClick={handleSignOut}
          aria-label={t('global.header.sign_out', 'Sign out')}
          title={t('global.header.sign_out', 'Sign out')}
        >
          <LogOut size={16} aria-hidden="true" />
        </button>
      </div>
    </header>
  );
}
