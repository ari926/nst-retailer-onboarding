import { NavLink } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Check, Circle, Lock } from 'lucide-react';
import { STEPS, type StepId } from '../../types/onboarding';
import { useOnboardingStore } from '../../stores/onboardingStore';

/**
 * Step navigation sidebar — 7 steps, status-aware.
 * Completed steps are clickable (to review). Locked steps are not.
 */
export function Sidebar() {
  const { t } = useTranslation();
  // Subscribe to the slices we actually depend on so the component re-renders
  // on state changes. Computing status inline (instead of calling the stable
  // `getStepStatus` selector) ensures every render reads the latest values —
  // earlier versions had a bug where the sidebar never advanced past Step 1
  // because the selector reference never changed.
  const currentStep = useOnboardingStore((s) => s.currentStep);
  const completedSteps = useOnboardingStore((s) => s.completedSteps);

  const statusFor = (stepId: StepId): 'completed' | 'in_progress' | 'available' | 'locked' => {
    if (completedSteps.includes(stepId)) return 'completed';
    if (stepId === currentStep) return 'in_progress';
    const previous = STEPS.filter((s) => s.id < stepId).map((s) => s.id);
    const allPreviousDone = previous.every((id) => completedSteps.includes(id));
    return allPreviousDone ? 'available' : 'locked';
  };

  return (
    <nav className="app-sidebar" aria-label="Onboarding steps">
      <ol className="step-list">
        {STEPS.map((step) => {
          const status = statusFor(step.id);
          const disabled = status === 'locked';
          const StepIcon =
            status === 'completed' ? Check :
            status === 'locked' ? Lock :
            Circle;

          return (
            <li key={step.id} className={`step-item step-item--${status}`}>
              <NavLink
                to={disabled ? '#' : step.path}
                aria-disabled={disabled}
                onClick={(e) => { if (disabled) e.preventDefault(); }}
                className={({ isActive }) =>
                  `step-item__link${isActive && !disabled ? ' is-active' : ''}`
                }
                title={
                  status === 'locked'
                    ? t('global.sidebar.status_locked')
                    : status === 'completed'
                      ? t('global.sidebar.status_done')
                      : t('global.sidebar.status_current')
                }
              >
                <span className={`step-item__icon step-item__icon--${status}`} aria-hidden="true">
                  <StepIcon size={14} strokeWidth={status === 'completed' ? 3 : 2} />
                </span>
                <span className="step-item__number">{step.id}</span>
                <span className="step-item__label">{t(step.titleKey)}</span>
              </NavLink>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
