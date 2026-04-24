import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { useOnboardingStore } from '../stores/onboardingStore';
import { STEPS } from '../types/onboarding';

/**
 * /onboarding landing — routes user to their current step.
 * Also acts as a dashboard when all steps are done (shown briefly before launch).
 */
export default function OnboardingIndex() {
  const { t } = useTranslation();
  const currentStep = useOnboardingStore((s) => s.currentStep);
  const completedSteps = useOnboardingStore((s) => s.completedSteps);
  const nextStep = STEPS.find((s) => s.id === currentStep) || STEPS[0];
  const allDone = completedSteps.length === STEPS.length;

  return (
    <section className="stack stack-md">
      <div className="step-header">
        <div className="step-header__eyebrow">
          {t('onboarding.overview_eyebrow', 'Setup overview')}
        </div>
        <h1>
          {allDone
            ? t('onboarding.all_done_title', 'Nice — you\'re ready to launch.')
            : t('onboarding.welcome_title', 'Let\'s get your store set up.')}
        </h1>
        <p className="step-header__subtitle">
          {allDone
            ? t('onboarding.all_done_subtitle', 'Your operations team will confirm your launch date shortly.')
            : t('onboarding.welcome_subtitle', 'Seven quick steps. You can save and come back anytime.')}
        </p>
      </div>

      <div className="step-card">
        <div className="stack stack-sm">
          <div className="text-xs text-muted" style={{ textTransform: 'uppercase', letterSpacing: '0.08em' }}>
            {t('onboarding.next_up', 'Next up')}
          </div>
          <div className="row row-sm" style={{ justifyContent: 'space-between' }}>
            <div>
              <div style={{ fontWeight: 'var(--fw-semibold)' }}>
                Step {nextStep.id} — {t(nextStep.titleKey)}
              </div>
            </div>
            <Link to={nextStep.path} className="btn btn-primary">
              {t('global.buttons.continue')}
            </Link>
          </div>
        </div>
      </div>
    </section>
  );
}
