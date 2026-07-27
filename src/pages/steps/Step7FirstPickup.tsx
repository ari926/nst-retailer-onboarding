import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { FormProvider, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { CheckCircle2, CalendarClock } from 'lucide-react';

import { StepShell } from '../../components/ui/StepShell';
import { useAuth } from '../../hooks/useAuth';
import { useOnboardingStore } from '../../stores/onboardingStore';
import { loadDraft, saveDraft, submitStep } from '../../lib/stepService';
import {
  step7Schema,
  step7Defaults,
  earliestPickupDate,
  toIsoDate,
  FREQUENCIES,
  SERVICE_START_TIMINGS,
  NEAR_TERM_TIMINGS,
  FAR_OUT_TIMINGS,
  CHECK_BACK_CADENCES,
  nextMondays,
  type Step7Values,
  type ServiceStartTiming,
} from './Step7FirstPickup.schema';

/**
 * Step 7 — First pickup request + ongoing service spec.
 *
 * Two modes toggled by the `deferred` radio:
 *   - Commit: pick a preferred date (>=10 calendar days out), service days,
 *     frequency, time window, driver notes → submitStep → activation.
 *   - Defer: "I'm not sure yet" → skip validation, persist intent, show
 *     success-deferred copy explaining the biweekly nudge loop.
 */
export default function Step7FirstPickup() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { user } = useAuth();
  const email = user?.email ?? null;
  const markStepCompleted = useOnboardingStore((s) => s.markStepCompleted);

  const [submitting, setSubmitting] = useState(false);
  const [draftLoaded, setDraftLoaded] = useState(false);
  const [successMode, setSuccessMode] = useState<
    'none' | 'committed' | 'deferred'
  >('none');
  const [submittedEmail, setSubmittedEmail] = useState('');

  const earliestStr = useMemo(() => toIsoDate(earliestPickupDate()), []);

  const methods = useForm<Step7Values>({
    resolver: zodResolver(step7Schema),
    defaultValues: step7Defaults,
    mode: 'onBlur',
    shouldUnregister: false, // keep field values when sub-editors unmount
  });

  const {
    register,
    handleSubmit,
    watch,
    reset,
    setValue,
    formState: { errors },
  } = methods;

  const deferred = watch('deferred');
  const serviceStartTiming = watch('serviceStartTiming') as
    | ServiceStartTiming
    | ''
    | undefined;

  const isNearTerm =
    !!serviceStartTiming &&
    (NEAR_TERM_TIMINGS as readonly string[]).includes(serviceStartTiming);
  const isFarOut =
    !!serviceStartTiming &&
    (FAR_OUT_TIMINGS as readonly string[]).includes(serviceStartTiming);

  // Precompute the valid Monday options for the near-term date picker.
  // Recomputed only when the timing changes.
  const mondayOptions = useMemo(
    () =>
      isNearTerm && serviceStartTiming
        ? nextMondays(serviceStartTiming as ServiceStartTiming, 26)
        : [],
    [isNearTerm, serviceStartTiming],
  );

  useEffect(() => {
    let mounted = true;
    (async () => {
      const draft = await loadDraft<Step7Values>(7);
      if (mounted && draft) reset(draft);
      setDraftLoaded(true);
    })();
    return () => {
      mounted = false;
    };
  }, [reset]);

  useEffect(() => {
    if (!draftLoaded) return;
    let handle: ReturnType<typeof setTimeout> | null = null;
    const subscription = watch((values) => {
      if (handle) clearTimeout(handle);
      handle = setTimeout(() => {
        void saveDraft(7, values);
      }, 1500);
    });
    return () => {
      if (handle) clearTimeout(handle);
      subscription.unsubscribe();
    };
  }, [watch, draftLoaded]);

  const onSubmit = async (values: Step7Values) => {
    setSubmitting(true);
    try {
      await submitStep(7, values);
      markStepCompleted(7);
      setSubmittedEmail(email ?? '');
      setSuccessMode(values.deferred ? 'deferred' : 'committed');
    } catch (err) {
      const msg = err instanceof Error ? err.message : t('global.errors.generic');
      toast.error(msg);
    } finally {
      setSubmitting(false);
    }
  };

  const goToActivation = () => {
    navigate('/onboarding');
  };

  // Success state — either committed or deferred
  if (successMode !== 'none') {
    const key = successMode === 'committed'
      ? 'step_7_launch.success_with_date'
      : 'step_7_launch.success_deferred';
    return (
      <section className="stack stack-lg">
        <div className="step-header">
          <div className="step-header__eyebrow">
            {t('nav.step_of', 'Step {current} of {total}', { current: 7, total: 7 })}
          </div>
          <h1>{t('step_7_launch.title')}</h1>
        </div>
        <div className="callout callout--success">
          <CheckCircle2 size={20} />
          <div>
            <strong>{t(key, { email: submittedEmail })}</strong>
          </div>
        </div>
        <div className="step-footer">
          <div />
          <div className="step-footer__actions">
            <button
              type="button"
              className="btn btn-primary"
              onClick={goToActivation}
            >
              {t('global.buttons.done', 'Done')}
            </button>
          </div>
        </div>
      </section>
    );
  }

  return (
    <FormProvider {...methods}>
      <form
        id="step-form"
        onSubmit={handleSubmit(onSubmit, (errors) => {
          console.warn('[step submit] validation errors', errors);
          toast.error(t('common.fix_highlighted_fields', 'Please fix the highlighted fields before continuing.'));
        })}
        noValidate
      >
        <StepShell
          stepId={7}
          titleKey="step_7_launch.title"
          subtitleKey="step_7_launch.subtitle"
          submitting={submitting}
          submitLabelKey={
            deferred
              ? 'step_7_launch.submit_deferred'
              : 'step_7_launch.submit_with_date'
          }
        >
          {/* Earliest date callout */}
          <div className="sample-callout">
            <CalendarClock size={16} style={{ marginRight: 6 }} />
            <span>
              {t('step_7_launch.earliest_callout', {
                earliestDate: earliestStr,
              })}
            </span>
          </div>

          {/* Mode toggle — commit vs defer */}
          <div className="field">
            <div className="radio-group">
              <label className="radio-option">
                <input
                  type="radio"
                  value="false"
                  checked={!deferred}
                  onChange={() => setValue('deferred', false, { shouldDirty: true })}
                />
                <span>
                  <strong>{t('step_7_launch.mode_commit')}</strong>
                </span>
              </label>
              <label className="radio-option">
                <input
                  type="radio"
                  value="true"
                  checked={deferred === true}
                  onChange={() => setValue('deferred', true, { shouldDirty: true })}
                />
                <span>
                  <strong>{t('step_7_launch.fields.not_sure_yet')}</strong>
                  <p className="radio-option__sub">
                    {t('step_7_launch.fields.not_sure_subcopy')}
                  </p>
                </span>
              </label>
            </div>
          </div>

          {/*
           * Frequency FIRST — always shown, whether deferred or not.
           * Per Amanda 2026-07-21: ops needs frequency locked in before the
           * date conversation happens.
           */}
          <div className="field">
            <label htmlFor="frequency" className="field-label field-required">
              {t('step_7_launch.fields.frequency', 'Pickup frequency')}
            </label>
            <select
              id="frequency"
              className="input"
              {...register('frequency')}
            >
              <option value="">
                {t('step_7_launch.fields.select_placeholder', '— Select —')}
              </option>
              {FREQUENCIES.map((f) => (
                <option key={f} value={f}>
                  {t(`step_7_launch.frequencies.${f}`)}
                </option>
              ))}
            </select>
            {errors.frequency && (
              <span className="field-error">
                {errors.frequency.message as string}
              </span>
            )}
          </div>

          {/*
           * Service start timing — committed mode only. The "not sure yet"
           * radio at the top already communicates that intent for deferred
           * customers, so we don't ask timing separately there.
           */}
          {!deferred && (
            <div className="field">
              <label
                htmlFor="serviceStartTiming"
                className="field-label field-required"
              >
                {t(
                  'step_7_launch.fields.service_start_timing',
                  'When do you wish to begin service?',
                )}
              </label>
              <select
                id="serviceStartTiming"
                className="input"
                {...register('serviceStartTiming')}
              >
                <option value="">
                  {t('step_7_launch.fields.select_placeholder', '— Select —')}
                </option>
                {SERVICE_START_TIMINGS.map((opt) => (
                  <option key={opt} value={opt}>
                    {t(
                      `step_7_launch.fields.service_start_options.${opt}`,
                      // Fallback human labels if i18n key isn't defined yet.
                      opt === 'asap'
                        ? 'ASAP'
                        : opt === '0_3mo'
                          ? '0–3 months'
                          : opt === '3_6mo'
                            ? '3–6 months'
                            : opt === '6_9mo'
                              ? '6–9 months'
                              : '9–12 months',
                    )}
                  </option>
                ))}
              </select>
              {errors.serviceStartTiming && (
                <span className="field-error">
                  {errors.serviceStartTiming.message as string}
                </span>
              )}
            </div>
          )}

          {/*
           * Near-term timings (ASAP / 0–3 / 3–6) — pick the WEEK to start.
           *
           * 2026-07-26 change set (Amanda + Doug):
           *   The old copy said "Preferred start date (Mondays only)" and
           *   promised routing on Mondays. Doug pushed back — routing picks
           *   the actual day-of-week per store, not the customer. So we now:
           *     - Relabel the field "Preferred week of start"
           *     - Present the same list of Mondays (each Monday is the
           *       anchor of a calendar week) but describe them as weeks
           *     - Rewrite the hint so routing owns the day-of-week decision
           *   Internal storage stays as an ISO Monday date for compat.
           */}
          {!deferred && isNearTerm && (
            <div className="field">
              <label
                htmlFor="preferredDate"
                className="field-label field-required"
              >
                {t(
                  'step_7_launch.fields.preferred_week',
                  'Preferred week of start',
                )}
              </label>
              <select
                id="preferredDate"
                className="input"
                {...register('preferredDate')}
              >
                <option value="">
                  {t('step_7_launch.fields.select_placeholder', '— Select —')}
                </option>
                {mondayOptions.map((iso) => {
                  const [y, m, d] = iso.split('-').map(Number);
                  const dt = new Date(y, m - 1, d);
                  // Show as "Week of Mon, Aug 3, 2026" — the Monday is the
                  // anchor of the calendar week, not the guaranteed pickup day.
                  const anchor = dt.toLocaleDateString(undefined, {
                    weekday: 'short',
                    month: 'short',
                    day: 'numeric',
                    year: 'numeric',
                  });
                  return (
                    <option key={iso} value={iso}>
                      {t('step_7_launch.fields.week_of_prefix', 'Week of')} {anchor}
                    </option>
                  );
                })}
              </select>
              <p className="field-hint">
                {t(
                  'step_7_launch.fields.week_hint',
                  'Our routing / onboarding team will be in touch to let you know the day of the week your service will begin. Earliest available week starts {earliestDate}.',
                  { earliestDate: earliestStr },
                )}
              </p>
              {errors.preferredDate && (
                <span className="field-error">
                  {errors.preferredDate.message as string}
                </span>
              )}
            </div>
          )}

          {/*
           * Check-back cadence — shown when the customer is either far-out
           * (6–9 / 9–9) OR chose "not sure yet" at the top. Same 3 options
           * in both cases per Amanda 2026-07-21.
           */}
          {(deferred || (!deferred && isFarOut)) && (
            <div className="field">
              <label
                htmlFor="checkBackCadence"
                className="field-label field-required"
              >
                {t(
                  'step_7_launch.fields.check_back_cadence',
                  'How often should we check back in?',
                )}
              </label>
              <select
                id="checkBackCadence"
                className="input"
                {...register('checkBackCadence')}
              >
                <option value="">
                  {t('step_7_launch.fields.select_placeholder', '— Select —')}
                </option>
                {CHECK_BACK_CADENCES.map((opt) => (
                  <option key={opt} value={opt}>
                    {t(
                      `step_7_launch.fields.check_back_options.${opt}`,
                      opt === 'every_2_weeks'
                        ? 'Every 2 weeks'
                        : opt === 'monthly'
                          ? 'Monthly'
                          : 'They’ll reach out when they’re ready',
                    )}
                  </option>
                ))}
              </select>
              {errors.checkBackCadence && (
                <span className="field-error">
                  {errors.checkBackCadence.message as string}
                </span>
              )}
            </div>
          )}

          {/* Driver notes — always available in committed mode. */}
          {!deferred && (
            <div className="field">
              <label htmlFor="driverNotes" className="field-label">
                {t('step_7_launch.fields.access_notes')}
              </label>
              <textarea
                id="driverNotes"
                className="input"
                rows={3}
                {...register('driverNotes')}
              />
            </div>
          )}
        </StepShell>
      </form>
    </FormProvider>
  );
}
