import { NavLink } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Check, Circle, Lock } from 'lucide-react';
import { STEPS } from '../../types/onboarding';
import { useOnboardingStore } from '../../stores/onboardingStore';

/**
 * Step navigation sidebar — 7 steps, status-aware.
 * Completed steps are clickable (to review). Locked steps are not.
 */
export function Sidebar() {
  const { t } = useTranslation();
  // Subscribe to the underlying state, not just `getStepStatus` (a stable
  // function reference would never trigger a re-render on state changes).
  useOnboardingStore((s) => s.currentStep);
  useOnboardingStore((s) => s.completedSteps);
  const getStepStatus = useOnboardingStore((s) => s.getStepStatus);

  return (
    <nav className="app-sidebar" aria-label="Onboarding steps">
      <ol className="step-list">
        {STEPS.map((step) => {
          const status = getStepStatus(step.id);
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
