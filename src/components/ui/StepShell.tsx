import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import type { StepId } from '../../types/onboarding';
import { STEPS } from '../../types/onboarding';
import { useAuth } from '../../hooks/useAuth';

/**
 * Shared wrapper for every real step form.
 * Owns the step header + back/continue footer chrome so individual step
 * components only render their field blocks.
 *
 * The form element is owned by the caller (so RHF handleSubmit works);
 * this component renders chrome around {children}.
 */
export function StepShell({
  stepId,
  titleKey,
  subtitleKey,
  children,
  onBack,
  submitting = false,
  submitLabelKey = 'global.buttons.save_and_continue',
}: {
  stepId: StepId;
  titleKey: string;
  subtitleKey?: string;
  children: ReactNode;
  onBack?: () => void;
  submitting?: boolean;
  submitLabelKey?: string;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { isAdminSession } = useAuth();
  const prev = STEPS.find((s) => s.id === stepId - 1);

  const handleBack = () => {
    if (onBack) return onBack();
    if (prev) navigate(prev.path);
    else navigate('/onboarding');
  };

  // In admin "view as customer" mode, the portal is intentionally read-only.
  // Submitting steps would mutate the customer's onboarding record under the
  // admin's identity, which we don't want without an explicit override path.
  // We disable the submit button and surface a clear inline notice so admins
  // aren't left wondering why nothing happened.
  const adminReadOnly = isAdminSession;

  return (
    <section className="stack stack-lg">
      <div className="step-header">
        <div className="step-header__eyebrow">
          {t('nav.step_of', 'Step {current} of {total}', { current: stepId, total: STEPS.length })}
        </div>
        <h1>{t(titleKey)}</h1>
        {subtitleKey && <p className="step-header__subtitle">{t(subtitleKey)}</p>}
      </div>

      {children}

      {adminReadOnly && (
        <div
          role="note"
          style={{
            background: '#FFFBEB',
            border: '1px solid #F59E0B',
            borderRadius: 'var(--radius-md, 8px)',
            color: '#78350F',
            padding: 'var(--space-3, 12px) var(--space-4, 16px)',
            fontSize: '0.875rem',
            lineHeight: 1.5,
          }}
        >
          {t(
            'admin_banner.read_only_step',
            'Admin preview mode — submissions are disabled. Ask the customer to confirm this step from their portal link.',
          )}
        </div>
      )}

      <div className="step-footer">
        <div>
          <button type="button" className="btn btn-secondary" onClick={handleBack}>
            {t('global.buttons.back')}
          </button>
        </div>
        <div className="step-footer__actions">
          <button
            type="submit"
            form="step-form"
            className="btn btn-primary"
            disabled={submitting || adminReadOnly}
            title={adminReadOnly ? t('admin_banner.read_only_button_tooltip', 'Disabled in admin preview mode') : undefined}
          >
            {submitting ? <span className="spinner" aria-hidden /> : t(submitLabelKey)}
          </button>
        </div>
      </div>
    </section>
  );
}
