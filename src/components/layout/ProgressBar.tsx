import { useTranslation } from 'react-i18next';
import { useOnboardingStore } from '../../stores/onboardingStore';
import { TOTAL_STEPS } from '../../types/onboarding';

/**
 * Slim progress bar in the top-right of the header.
 * Shows "Step N of 7 — X% to launch".
 */
export function ProgressBar() {
  const { t } = useTranslation();
  const currentStep = useOnboardingStore((s) => s.currentStep);
  const getProgress = useOnboardingStore((s) => s.getProgress);
  const pct = getProgress();

  return (
    <div className="progress" aria-live="polite">
      <div className="progress__label">
        {t('global.header.progress', {
          current: currentStep,
          total: TOTAL_STEPS,
          percent: pct,
        })}
      </div>
      <div
        className="progress__track"
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div className="progress__fill" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
