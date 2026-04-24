import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { FormProvider, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';

import { StepShell } from '../../components/ui/StepShell';
import { HoursGrid } from '../../components/steps/HoursGrid';
import { useOnboardingStore } from '../../stores/onboardingStore';
import { loadDraft, saveDraft, submitStep } from '../../lib/stepService';
import { useScrollToFirstError } from '../../hooks/useScrollToFirstError';
import {
  step1Schema,
  step1Defaults,
  US_STATES,
  type Step1Values,
} from './Step1Profile.schema';

/**
 * Step 1 — Store profile.
 *   legal name + DBA, address, operating hours (day grid),
 *   access notes, primary contact, optional BOH manager.
 *
 * Autosaves a draft every 1.5s after changes. On submit, writes to
 * step_submissions, marks the step complete, and navigates to step 2.
 */
export default function Step1Profile() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const markStepCompleted = useOnboardingStore((s) => s.markStepCompleted);
  const setCurrentStep = useOnboardingStore((s) => s.setCurrentStep);
  const setOnboarding = useOnboardingStore((s) => s.setOnboarding);

  const [submitting, setSubmitting] = useState(false);
  const [draftLoaded, setDraftLoaded] = useState(false);

  const methods = useForm<Step1Values>({
    resolver: zodResolver(step1Schema),
    defaultValues: step1Defaults,
    mode: 'onBlur',
  });

  const { register, handleSubmit, watch, reset, formState: { errors } } = methods;

  // Load draft once on mount
  useEffect(() => {
    let mounted = true;
    (async () => {
      const draft = await loadDraft<Step1Values>(1);
      if (mounted && draft) reset(draft);
      setDraftLoaded(true);
    })();
    return () => { mounted = false; };
  }, [reset]);

  // Autosave after 1.5s of no changes
  useEffect(() => {
    if (!draftLoaded) return;
    const subscription = watch((values) => {
      const handle = setTimeout(() => {
        void saveDraft(1, values);
      }, 1500);
      return () => clearTimeout(handle);
    });
    return () => subscription.unsubscribe();
  }, [watch, draftLoaded]);

  const onSubmit = async (values: Step1Values) => {
    setSubmitting(true);
    try {
      await submitStep(1, values);
      setOnboarding({ storefrontName: values.storefrontName });
      markStepCompleted(1);
      setCurrentStep(2);
      toast.success(t('step_1_profile.saved', 'Profile saved.'));
      navigate('/onboarding/safe');
    } catch (err) {
      const msg = err instanceof Error ? err.message : t('global.errors.generic');
      toast.error(msg);
    } finally {
      setSubmitting(false);
    }
  };

  const onInvalid = useScrollToFirstError<Step1Values>();

  return (
    <FormProvider {...methods}>
      <form id="step-form" onSubmit={handleSubmit(onSubmit, onInvalid)} noValidate>
        <StepShell
          stepId={1}
          titleKey="step_1_profile.title"
          subtitleKey="step_1_profile.subtitle"
          submitting={submitting}
        >
          <div className="step-card stack stack-md">
            {/* Legal + DBA */}
            <div className="grid-2">
              <div className="field">
                <label htmlFor="legalName" className="field-label field-required">
                  {t('step_1_profile.fields.legal_name')}
                </label>
                <input id="legalName" className="input" {...register('legalName')} />
                {errors.legalName && <span className="field-error">{errors.legalName.message}</span>}
              </div>
              <div className="field">
                <label htmlFor="storefrontName" className="field-label field-required">
                  {t('step_1_profile.fields.storefront_name')}
                </label>
                <input id="storefrontName" className="input" {...register('storefrontName')} />
                {errors.storefrontName && <span className="field-error">{errors.storefrontName.message}</span>}
              </div>
            </div>

            {/* Address */}
            <div className="field">
              <label htmlFor="street" className="field-label field-required">
                {t('step_1_profile.fields.street')}
              </label>
              <input id="street" className="input" {...register('street')} autoComplete="address-line1" />
              {errors.street && <span className="field-error">{errors.street.message}</span>}
            </div>

            <div className="grid-2">
              <div className="field">
                <label htmlFor="suite" className="field-label">
                  {t('step_1_profile.fields.suite')}
                </label>
                <input id="suite" className="input" {...register('suite')} autoComplete="address-line2" />
              </div>
              <div className="field">
                <label htmlFor="city" className="field-label field-required">
                  {t('step_1_profile.fields.city')}
                </label>
                <input id="city" className="input" {...register('city')} autoComplete="address-level2" />
                {errors.city && <span className="field-error">{errors.city.message}</span>}
              </div>
            </div>

            <div className="grid-2">
              <div className="field">
                <label htmlFor="state" className="field-label field-required">
                  {t('step_1_profile.fields.state')}
                </label>
                <select id="state" className="select" {...register('state')}>
                  {US_STATES.map((s) => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
                {errors.state && <span className="field-error">{errors.state.message}</span>}
              </div>
              <div className="field">
                <label htmlFor="zip" className="field-label field-required">
                  {t('step_1_profile.fields.zip')}
                </label>
                <input
                  id="zip"
                  className="input"
                  {...register('zip')}
                  autoComplete="postal-code"
                  inputMode="numeric"
                  maxLength={10}
                />
                {errors.zip && <span className="field-error">{errors.zip.message}</span>}
              </div>
            </div>

            {/* Operating hours */}
            <HoursGrid />

            {/* Access notes */}
            <div className="field">
              <label htmlFor="accessNotes" className="field-label">
                {t('step_1_profile.fields.access_notes')}
              </label>
              <textarea
                id="accessNotes"
                className="textarea"
                rows={3}
                {...register('accessNotes')}
              />
            </div>

            <hr className="divider" />

            {/* Primary contact */}
            <div className="stack stack-sm">
              <h3 style={{ margin: 0 }}>
                {t('step_1_profile.fields.primary_contact_section')}
              </h3>

              <div className="grid-2">
                <div className="field">
                  <label htmlFor="pc-name" className="field-label field-required">
                    {t('step_1_profile.fields.contact_name')}
                  </label>
                  <input id="pc-name" className="input" {...register('primaryContact.name')} autoComplete="name" />
                  {errors.primaryContact?.name && (
                    <span className="field-error">{errors.primaryContact.name.message}</span>
                  )}
                </div>
                <div className="field">
                  <label htmlFor="pc-email" className="field-label field-required">
                    {t('step_1_profile.fields.contact_email')}
                  </label>
                  <input
                    id="pc-email"
                    type="email"
                    className="input"
                    {...register('primaryContact.email')}
                    autoComplete="email"
                  />
                  {errors.primaryContact?.email && (
                    <span className="field-error">{errors.primaryContact.email.message}</span>
                  )}
                </div>
              </div>

              <div className="field">
                <label htmlFor="pc-phone" className="field-label field-required">
                  {t('step_1_profile.fields.contact_phone')}
                </label>
                <input
                  id="pc-phone"
                  type="tel"
                  className="input"
                  {...register('primaryContact.phone')}
                  autoComplete="tel"
                  placeholder="(215) 555-0123"
                />
                {errors.primaryContact?.phone && (
                  <span className="field-error">{errors.primaryContact.phone.message}</span>
                )}
              </div>
            </div>

            <hr className="divider" />

            {/* BOH manager (optional) */}
            <div className="stack stack-sm">
              <h3 style={{ margin: 0 }}>
                {t('step_1_profile.fields.boh_section')}
              </h3>

              <div className="grid-2">
                <div className="field">
                  <label htmlFor="boh-name" className="field-label">
                    {t('step_1_profile.fields.contact_name')}
                  </label>
                  <input id="boh-name" className="input" {...register('bohManager.name')} />
                </div>
                <div className="field">
                  <label htmlFor="boh-email" className="field-label">
                    {t('step_1_profile.fields.contact_email')}
                  </label>
                  <input
                    id="boh-email"
                    type="email"
                    className="input"
                    {...register('bohManager.email')}
                  />
                  {errors.bohManager?.email && (
                    <span className="field-error">{errors.bohManager.email.message}</span>
                  )}
                </div>
              </div>

              <div className="field">
                <label htmlFor="boh-phone" className="field-label">
                  {t('step_1_profile.fields.contact_phone')}
                </label>
                <input
                  id="boh-phone"
                  type="tel"
                  className="input"
                  {...register('bohManager.phone')}
                />
              </div>
            </div>
          </div>
        </StepShell>
      </form>
    </FormProvider>
  );
}
