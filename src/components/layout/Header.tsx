import { useTranslation } from 'react-i18next';
import { Logo } from './Logo';
import { LanguageToggle } from './LanguageToggle';
import { ProgressBar } from './ProgressBar';
import { useOnboardingStore } from '../../stores/onboardingStore';

/**
 * Top bar for onboarding flow.
 * Left: logo + store name pill.
 * Center: progress bar.
 * Right: save-later, support, language toggle.
 */
export function Header() {
  const { t } = useTranslation();
  const storefrontName = useOnboardingStore((s) => s.storefrontName);

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
      </div>
    </header>
  );
}
