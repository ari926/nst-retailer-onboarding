import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import en from '../i18n/en.json';
import es from '../i18n/es.json';

/**
 * i18n setup — EN/ES with informal "tú" in Spanish.
 * Language preference is persisted in localStorage under 'nst_lang'.
 */
i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      en: { translation: en },
      es: { translation: es },
    },
    fallbackLng: 'en',
    supportedLngs: ['en', 'es'],
    interpolation: {
      escapeValue: false,
      // Translation files use ICU-ish single-brace placeholders (e.g. {current}).
      // Override i18next's default {{var}} syntax to match.
      prefix: '{',
      suffix: '}',
    },
    detection: {
      order: ['localStorage', 'navigator'],
      lookupLocalStorage: 'nst_lang',
      caches: ['localStorage'],
    },
  });

export default i18n;
