import { useTranslation } from 'react-i18next';

/**
 * EN / ES segmented toggle.
 * Language choice is persisted by i18next (localStorage key: nst_lang).
 */
export function LanguageToggle() {
  const { i18n } = useTranslation();
  const current = i18n.language.startsWith('es') ? 'es' : 'en';

  const setLang = (lang: 'en' | 'es') => {
    if (current === lang) return;
    void i18n.changeLanguage(lang);
  };

  return (
    <div className="lang-toggle" role="group" aria-label="Language">
      <button
        type="button"
        className={`lang-toggle__btn ${current === 'en' ? 'is-active' : ''}`}
        onClick={() => setLang('en')}
        aria-pressed={current === 'en'}
      >
        EN
      </button>
      <button
        type="button"
        className={`lang-toggle__btn ${current === 'es' ? 'is-active' : ''}`}
        onClick={() => setLang('es')}
        aria-pressed={current === 'es'}
      >
        ES
      </button>
    </div>
  );
}
