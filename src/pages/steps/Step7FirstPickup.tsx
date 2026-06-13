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
  SERVICE_DAYS,
  TIME_WINDOWS,
  FREQUENCIES,
  type Step7Values,
  type ServiceDay,
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
  const serviceDays = watch('serviceDays') ?? [];

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
    const subscription = watch((values) => {
      const handle = setTimeout(() => {
        void saveDraft(7, values);
      }, 1500);
      return () => clearTimeout(handle);
    });
    return () => subscription.unsubscribe();
  }, [watch, draftLoaded]);

  const toggleDay = (day: ServiceDay) => {
    const current = serviceDays;
    const next = current.includes(day)
      ? current.filter((d) => d !== day)
      : [...current, day];
    setValue('serviceDays', next, { shouldDirty: true, shouldValidate: true });
  };

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

          {/* Commit path fields */}
          {!deferred && (
            <>
              <div className="field">
                <label htmlFor="preferredDate" className="field-label">
                  {t('step_7_launch.fields.preferred_date')}
                </label>
                <input
                  id="preferredDate"
                  className="input"
                  type="date"
                  min={earliestStr}
                  {...register('preferredDate')}
                />
                {errors.preferredDate && (
                  <span className="field-error">
                    {errors.preferredDate.message as string}
                  </span>
                )}
              </div>

              <div className="field">
                <span className="field-label">
                  {t('step_7_launch.fields.service_days')}
                </span>
                <div className="chip-row">
                  {SERVICE_DAYS.map((day) => (
                    <button
                      type="button"
                      key={day}
                      className={`chip ${serviceDays.includes(day) ? 'chip--active' : ''}`}
                      onClick={() => toggleDay(day)}
                      aria-pressed={serviceDays.includes(day)}
                    >
                      {t(`step_7_launch.day_short.${day}`)}
                    </button>
                  ))}
                </div>
                {errors.serviceDays && (
                  <span className="field-error">
                    {errors.serviceDays.message as string}
                  </span>
                )}
              </div>

              <div className="field-row">
                <div className="field">
                  <label htmlFor="frequency" className="field-label">
                    {t('step_7_launch.fields.frequency')}
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

                <div className="field">
                  <label htmlFor="timeWindow" className="field-label">
                    {t('step_7_launch.fields.time_window')}
                  </label>
                  <select
                    id="timeWindow"
                    className="input"
                    {...register('timeWindow')}
                  >
                    <option value="">
                      {t('step_7_launch.fields.select_placeholder', '— Select —')}
                    </option>
                    {TIME_WINDOWS.map((tw) => (
                      <option key={tw} value={tw}>
                        {t(`step_7_launch.fields.time_options.${tw}`)}
                      </option>
                    ))}
                  </select>
                  {errors.timeWindow && (
                    <span className="field-error">
                      {errors.timeWindow.message as string}
                    </span>
                  )}
                </div>
              </div>

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
            </>
          )}
        </StepShell>
      </form>
    </FormProvider>
  );
}
