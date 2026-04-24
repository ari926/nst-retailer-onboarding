import { useTranslation } from 'react-i18next';
import { Info } from 'lucide-react';

/**
 * Persistent banner shown until the retailer's launch date is confirmed.
 * Explains why their account is in "setup mode".
 */
export function LockedBanner() {
  const { t } = useTranslation();
  return (
    <div className="banner banner-info" role="status">
      <Info size={18} aria-hidden="true" style={{ flexShrink: 0, marginTop: 2 }} />
      <span>{t('global.locked_banner')}</span>
    </div>
  );
}
