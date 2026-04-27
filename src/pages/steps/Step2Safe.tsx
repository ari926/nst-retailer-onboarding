import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { FormProvider, useFieldArray, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { Plus, Trash2 } from 'lucide-react';

import { StepShell } from '../../components/ui/StepShell';
import { useOnboardingStore } from '../../stores/onboardingStore';
import { loadDraft, saveDraft, submitStep } from '../../lib/stepService';
import { getPrefill } from '../../lib/onboardingToken';
import { mapPrefillToStep2 } from '../../lib/prefillMapping';
import {
  step2Schema,
  step2Defaults,
  STORAGE_METHODS,
  DASHBOARD_OPTIONS,
  PROVISIONAL_OPTIONS,
  type Step2Values,
} from './Step2Safe.schema';

/**
 * Step 2 — Safe & keys (V2).
 *
 * Branches on "Is there a Smart Safe on site?":
 *   - yes -> make/model/serial + dashboard connection
 *            + key holders (≥1) + provisional credit (Yes/No)
 *   - no  -> storage method ONLY (key holders + provisional credit hidden)
 */
export default function Step2Safe() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const markStepCompleted = useOnboardingStore((s) => s.markStepCompleted);
  const setCurrentStep = useOnboardingStore((s) => s.setCurrentStep);

  const [submitting, setSubmitting] = useState(false);
  const [draftLoaded, setDraftLoaded] = useState(false);

  const methods = useForm<Step2Values>({
    resolver: zodResolver(step2Schema),
    defaultValues: step2Defaults,
    mode: 'onBlur',
  });

  const {
    register,
    handleSubmit,
    watch,
    reset,
    control,
    formState: { errors },
  } = methods;

  const { fields, append, remove } = useFieldArray({ control, name: 'keyHolders' });

  const hasSmartSafe = watch('hasSmartSafe');
  const storageMethod = watch('storageMethod');

  useEffect(() => {
    let mounted = true;
    (async () => {
      const draft = await loadDraft<Step2Values>(2);
      if (!mounted) return;
      if (draft) {
        reset(draft);
      } else {
        const prefill = mapPrefillToStep2(getPrefill());
        if (Object.keys(prefill).length > 0) {
          reset({ ...step2Defaults, ...prefill });
        }
      }
      setDraftLoaded(true);
    })();
    return () => { mounted = false; };
  }, [reset]);

  useEffect(() => {
    if (!draftLoaded) return;
    const subscription = watch((values) => {
      const handle = setTimeout(() => {
        void saveDraft(2, values);
      }, 1500);
      return () => clearTimeout(handle);
    });
    return () => subscription.unsubscribe();
  }, [watch, draftLoaded]);

  const onSubmit = async (values: Step2Values) => {
    setSubmitting(true);
    try {
      // Strip irrelevant branch fields before persisting so the server
      // payload matches whichever path the retailer chose.
      const sanitized: Step2Values =
        values.hasSmartSafe === 'yes'
          ? {
              ...values,
              storageMethod: undefined,
              storageMethodOther: '',
            }
          : {
              ...values,
              safeMake: '',
              safeModel: '',
              safeSerial: '',
              dashboardConnection: undefined,
              keyHolders: undefined,
              provisionalCredit: undefined,
            };

      await submitStep(2, sanitized);
      markStepCompleted(2);
      setCurrentStep(3);
      toast.success(t('step_2_safe.saved', 'Safe details saved.'));
      navigate('/onboarding/deposit');
    } catch (err) {
      const msg = err instanceof Error ? err.message : t('global.errors.generic');
      toast.error(msg);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <FormProvider {...methods}>
      <form id="step-form" onSubmit={handleSubmit(onSubmit)} noValidate>
        <StepShell
          stepId={2}
          titleKey="step_2_safe.title"
          subtitleKey="step_2_safe.subtitle"
          submitting={submitting}
        >
          <div className="step-card stack stack-md">
            {/* Smart safe yes/no */}
            <div className="field">
              <label className="field-label field-required">
                {t('step_2_safe.fields.has_smart_safe_question')}
              </label>
              <div className="radio-row">
                <label className="radio-option">
                  <input type="radio" value="yes" {...register('hasSmartSafe')} />
                  <span>{t('step_2_safe.fields.yes')}</span>
                </label>
                <label className="radio-option">
                  <input type="radio" value="no" {...register('hasSmartSafe')} />
                  <span>{t('step_2_safe.fields.no')}</span>
                </label>
              </div>
              {errors.hasSmartSafe && (
                <span className="field-error">{errors.hasSmartSafe.message as string}</span>
              )}
            </div>

            {/* Smart-safe branch */}
            {hasSmartSafe === 'yes' && (
              <>
                <hr className="divider" />
                <div className="grid-2">
                  <div className="field">
                    <label htmlFor="safeMake" className="field-label field-required">
                      {t('step_2_safe.fields.safe_make')}
                    </label>
                    <input id="safeMake" className="input" {...register('safeMake')} />
                    {errors.safeMake && (
                      <span className="field-error">{errors.safeMake.message as string}</span>
                    )}
                  </div>
                  <div className="field">
                    <label htmlFor="safeModel" className="field-label field-required">
                      {t('step_2_safe.fields.safe_model')}
                    </label>
                    <input id="safeModel" className="input" {...register('safeModel')} />
                    {errors.safeModel && (
                      <span className="field-error">{errors.safeModel.message as string}</span>
                    )}
                  </div>
                </div>

                <div className="field">
                  <label htmlFor="safeSerial" className="field-label field-required">
                    {t('step_2_safe.fields.safe_serial')}
                  </label>
                  <input id="safeSerial" className="input" {...register('safeSerial')} />
                  {errors.safeSerial && (
                    <span className="field-error">{errors.safeSerial.message as string}</span>
                  )}
                </div>

                <div className="field">
                  <label className="field-label field-required">
                    {t('step_2_safe.fields.dashboard_question')}
                  </label>
                  <div className="radio-col">
                    {DASHBOARD_OPTIONS.map((opt) => (
                      <label key={opt} className="radio-option">
                        <input type="radio" value={opt} {...register('dashboardConnection')} />
                        <span>{t(`step_2_safe.fields.dashboard_options.${opt}`)}</span>
                      </label>
                    ))}
                  </div>
                  {errors.dashboardConnection && (
                    <span className="field-error">
                      {errors.dashboardConnection.message as string}
                    </span>
                  )}
                </div>

                <hr className="divider" />

                {/* Key holders — only when Smart Safe = yes */}
                <div className="field">
                  <h3 className="section-heading">
                    {t('step_2_safe.fields.key_holder_section')}
                  </h3>
                  <div className="stack stack-md">
                    {fields.map((field, idx) => (
                      <div key={field.id} className="key-holder-card">
                        <div className="grid-2">
                          <div className="field">
                            <label
                              htmlFor={`kh-name-${idx}`}
                              className="field-label field-required"
                            >
                              {t('step_2_safe.fields.key_holder_name')}
                            </label>
                            <input
                              id={`kh-name-${idx}`}
                              className="input"
                              {...register(`keyHolders.${idx}.name` as const)}
                            />
                            {errors.keyHolders?.[idx]?.name && (
                              <span className="field-error">
                                {errors.keyHolders[idx]?.name?.message as string}
                              </span>
                            )}
                          </div>
                          <div className="field">
                            <label htmlFor={`kh-role-${idx}`} className="field-label">
                              {t('step_2_safe.fields.key_holder_role')}
                            </label>
                            <input
                              id={`kh-role-${idx}`}
                              className="input"
                              {...register(`keyHolders.${idx}.role` as const)}
                            />
                          </div>
                        </div>
                        <div className="field">
                          <label
                            htmlFor={`kh-loc-${idx}`}
                            className="field-label field-required"
                          >
                            {t('step_2_safe.fields.key_holder_location')}
                          </label>
                          <input
                            id={`kh-loc-${idx}`}
                            className="input"
                            {...register(`keyHolders.${idx}.location` as const)}
                          />
                          {errors.keyHolders?.[idx]?.location && (
                            <span className="field-error">
                              {errors.keyHolders[idx]?.location?.message as string}
                            </span>
                          )}
                        </div>
                        {fields.length > 1 && (
                          <button
                            type="button"
                            className="btn-ghost btn-ghost--danger"
                            onClick={() => remove(idx)}
                          >
                            <Trash2 size={14} aria-hidden /> Remove
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                  <button
                    type="button"
                    className="btn-ghost"
                    onClick={() => append({ name: '', role: '', location: '' })}
                  >
                    <Plus size={14} aria-hidden /> {t('step_2_safe.fields.add_key_holder')}
                  </button>
                </div>

                <hr className="divider" />

                {/* Provisional credit — only when Smart Safe = yes */}
                <div className="field">
                  <label className="field-label field-required">
                    {t('step_2_safe.fields.provisional_credit_question')}
                  </label>
                  <div className="radio-col">
                    {PROVISIONAL_OPTIONS.map((opt) => (
                      <label key={opt} className="radio-option">
                        <input type="radio" value={opt} {...register('provisionalCredit')} />
                        <span>{t(`step_2_safe.fields.provisional_options.${opt}`)}</span>
                      </label>
                    ))}
                  </div>
                  {errors.provisionalCredit && (
                    <span className="field-error">
                      {errors.provisionalCredit.message as string}
                    </span>
                  )}
                </div>
              </>
            )}

            {/* No-smart-safe branch — storage method ONLY */}
            {hasSmartSafe === 'no' && (
              <>
                <hr className="divider" />
                <div className="field">
                  <label className="field-label field-required">
                    {t('step_2_safe.fields.storage_method_question')}
                  </label>
                  <div className="radio-col">
                    {STORAGE_METHODS.map((opt) => (
                      <label key={opt} className="radio-option">
                        <input type="radio" value={opt} {...register('storageMethod')} />
                        <span>{t(`step_2_safe.fields.storage_options.${opt}`)}</span>
                      </label>
                    ))}
                  </div>
                  {errors.storageMethod && (
                    <span className="field-error">{errors.storageMethod.message as string}</span>
                  )}
                </div>

                {storageMethod === 'other' && (
                  <div className="field">
                    <input
                      className="input"
                      placeholder={t('step_2_safe.fields.storage_options.other')}
                      {...register('storageMethodOther')}
                    />
                    {errors.storageMethodOther && (
                      <span className="field-error">
                        {errors.storageMethodOther.message as string}
                      </span>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        </StepShell>
      </form>
    </FormProvider>
  );
}
