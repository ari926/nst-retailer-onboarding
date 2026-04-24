import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import type { StepId } from '../types/onboarding';
import { STEPS } from '../types/onboarding';
import { useOnboardingStore } from '../stores/onboardingStore';

/**
 * Placeholder for steps whose real forms haven't been built yet.
 * Each step screen in PR #4-#9 replaces this with a real form.
 * Leaving the shell intact means the router + layout + store are all testable
 * even before step content exists.
 */
export default function StepPlaceholder({
  stepId,
  titleKey,
  subtitleKey,
}: {
  stepId: StepId;
  titleKey: string;
  subtitleKey?: string;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const markStepCompleted = useOnboardingStore((s) => s.markStepCompleted);
  const setCurrentStep = useOnboardingStore((s) => s.setCurrentStep);

  const next = STEPS.find((s) => s.id === stepId + 1);

  const handleContinue = () => {
    markStepCompleted(stepId);
    if (next) {
      setCurrentStep(next.id as StepId);
      navigate(next.path);
    } else {
      navigate('/onboarding');
    }
  };

  const prev = STEPS.find((s) => s.id === stepId - 1);

  return (
    <section className="stack stack-lg">
      <div className="step-header">
        <div className="step-header__eyebrow">
          {t('nav.step_of', 'Step {current} of {total}', { current: stepId, total: STEPS.length })}
        </div>
        <h1>{t(titleKey)}</h1>
        {subtitleKey && <p className="step-header__subtitle">{t(subtitleKey)}</p>}
      </div>

      <div className="step-card">
        <div className="banner banner-info" role="status">
          <span>
            Placeholder — the real form for this step lands in a later PR. Continue to simulate completion.
          </span>
        </div>
      </div>

      <div className="step-footer">
        <div>
          {prev && (
            <button type="button" className="btn btn-secondary" onClick={() => navigate(prev.path)}>
              {t('global.buttons.back')}
            </button>
          )}
        </div>
        <div className="step-footer__actions">
          <button type="button" className="btn btn-primary" onClick={handleContinue}>
            {next ? t('global.buttons.save_and_continue') : t('global.buttons.submit')}
          </button>
        </div>
      </div>
    </section>
  );
}
