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
  const next = STEPS.find((s) => s.id === stepId + 1);

  // Preserve the ?t=<token> query param across SPA navigations so the admin
  // session keeps hydrating on every step (react-router strips search by default).
  const tokenParam = typeof window !== 'undefined'
    ? new URLSearchParams(window.location.search).get('t')
    : null;
  const withToken = (path: string) =>
    tokenParam ? `${path}?t=${encodeURIComponent(tokenParam)}` : path;

  const handleBack = () => {
    if (onBack) return onBack();
    if (prev) navigate(withToken(prev.path));
    else navigate(withToken('/onboarding'));
  };

  // Admin "view as customer" mode: view-only walk-through. The admin can page
  // forward and back through every step to inspect what the customer has filled
  // in, but inputs are disabled and the submit path never fires. Forward
  // navigation goes straight to the next step's route (no API call).
  const isAdminPreview = isAdminSession;
  const handleAdminNext = () => {
    if (next) navigate(withToken(next.path));
  };

  return (
    <section className="stack stack-lg">
      <div className="step-header">
        <div className="step-header__eyebrow">
          {t('nav.step_of', 'Step {current} of {total}', { current: stepId, total: STEPS.length })}
        </div>
        <h1>{t(titleKey)}</h1>
        {subtitleKey && <p className="step-header__subtitle">{t(subtitleKey)}</p>}
      </div>

      {/* Wrapping in a disabled fieldset makes every form input inside
          non-editable for admin preview, without touching each step component. */}
      <fieldset
        disabled={isAdminPreview}
        style={isAdminPreview ? { border: 'none', padding: 0, margin: 0, minWidth: 0 } : { border: 'none', padding: 0, margin: 0, minWidth: 0 }}
      >
        {children}
      </fieldset>

      {isAdminPreview && (
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
            'admin_banner.preview_walkthrough',
            'Admin preview — fields are read-only. Use Next / Back to walk through the customer’s onboarding without saving any changes.',
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
          {isAdminPreview ? (
            <button
              type="button"
              className="btn btn-primary"
              onClick={handleAdminNext}
              disabled={!next}
              title={!next ? t('admin_banner.last_step', 'Last step') : undefined}
            >
              {t('admin_banner.next_step', 'Next step →')}
            </button>
          ) : (
            <button type="submit" form="step-form" className="btn btn-primary" disabled={submitting}>
              {submitting ? <span className="spinner" aria-hidden /> : t(submitLabelKey)}
            </button>
          )}
        </div>
      </div>
    </section>
  );
}
