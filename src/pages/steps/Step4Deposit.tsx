import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { FormProvider, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { Copy, Check } from 'lucide-react';

import { StepShell } from '../../components/ui/StepShell';
import { useOnboardingStore } from '../../stores/onboardingStore';
import { loadDraft, saveDraft, submitStep } from '../../lib/stepService';
import { useScrollToFirstError } from '../../hooks/useScrollToFirstError';
import {
  step4Schema,
  step4Defaults,
  DENOMINATIONS,
  type Step4Values,
} from './Step4Deposit.schema';

/**
 * Step 4 — Sample deposit walkthrough.
 *
 * Training simulation: retailer enters a fake $100 deposit (5 × $20 bills)
 * so they know what fields they'll see on day 1. Calculated total updates
 * live; must match stated amount to submit.
 */
export default function Step4Deposit() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const sfdcAccountId = useOnboardingStore((s) => s.sfdcAccountId);
  const markStepCompleted = useOnboardingStore((s) => s.markStepCompleted);
  const setCurrentStep = useOnboardingStore((s) => s.setCurrentStep);

  const [submitting, setSubmitting] = useState(false);
  const [draftLoaded, setDraftLoaded] = useState(false);
  const [copied, setCopied] = useState(false);

  const suggestedBag = useMemo(
    () => `TEST-${sfdcAccountId?.slice(-6) ?? 'RETAILER'}`,
    [sfdcAccountId],
  );

  // Schema input (form-state) and output (validated) types differ because of
  // empty-string-tolerant numeric fields. RHF only models one. Cast the
  // resolver to satisfy the output-typed generic; values are coerced on submit.
  const methods = useForm<Step4Values>({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    resolver: zodResolver(step4Schema) as any,
    defaultValues: step4Defaults,
    mode: 'onBlur',
  });

  const {
    register,
    handleSubmit,
    watch,
    reset,
    formState: { errors },
  } = methods;

  useEffect(() => {
    let mounted = true;
    (async () => {
      const draft = await loadDraft<Step4Values>(4);
      if (mounted && draft) reset(draft);
      setDraftLoaded(true);
    })();
    return () => { mounted = false; };
  }, [reset]);

  useEffect(() => {
    if (!draftLoaded) return;
    const subscription = watch((values) => {
      const handle = setTimeout(() => {
        void saveDraft(4, values);
      }, 1500);
      return () => clearTimeout(handle);
    });
    return () => subscription.unsubscribe();
  }, [watch, draftLoaded]);

  const denomValues = watch('denominations');
  const calculatedTotal = useMemo(() => {
    if (!denomValues) return 0;
    return DENOMINATIONS.reduce(
      (sum, d) => sum + (Number(denomValues[d.key]) || 0) * d.value,
      0,
    );
  }, [denomValues]);

  const onSubmit = async (values: Step4Values) => {
    setSubmitting(true);
    try {
      await submitStep(4, values);
      markStepCompleted(4);
      setCurrentStep(5);
      toast.success(t('step_4_deposit.success'));
      navigate('/onboarding/change-order');
    } catch (err) {
      const msg = err instanceof Error ? err.message : t('global.errors.generic');
      toast.error(msg);
    } finally {
      setSubmitting(false);
    }
  };

  const copyBag = async () => {
    await navigator.clipboard.writeText(suggestedBag);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const onInvalid = useScrollToFirstError<Step4Values>();

  return (
    <FormProvider {...methods}>
      <form id="step-form" onSubmit={handleSubmit(onSubmit, onInvalid)} noValidate>
        <StepShell
          stepId={4}
          titleKey="step_4_deposit.title"
          subtitleKey="step_4_deposit.subtitle"
          submitting={submitting}
          submitLabelKey="step_4_deposit.submit"
        >
          <div className="step-card stack stack-md">
            <div className="sample-callout">
              <strong>{t('step_4_deposit.instructions_lead')}</strong>
              <ul>
                <li>{t('step_4_deposit.fields.amount_hint')}</li>
                <li>
                  Bag: <code>{suggestedBag}</code>{' '}
                  <button
                    type="button"
                    className="btn-ghost btn-ghost--sm"
                    onClick={copyBag}
                  >
                    {copied ? <Check size={12} /> : <Copy size={12} />}{' '}
                    {copied ? t('step_4_deposit.fields.copied') : t('step_4_deposit.fields.copy_button')}
                  </button>
                </li>
                <li>{t('step_4_deposit.fields.denominations_hint')}</li>
              </ul>
            </div>

            <div className="grid-2">
              <div className="field">
                <label htmlFor="amount" className="field-label field-required">
                  {t('step_4_deposit.fields.amount')}
                </label>
                <input
                  id="amount"
                  className="input"
                  type="number"
                  step="0.01"
                  min="0"
                  {...register('amount')}
                />
                {errors.amount && (
                  <span className="field-error">{errors.amount.message}</span>
                )}
              </div>
              <div className="field">
                <label htmlFor="date" className="field-label field-required">
                  {t('step_4_deposit.fields.date')}
                </label>
                <input
                  id="date"
                  className="input"
                  type="date"
                  {...register('date')}
                />
                {errors.date && (
                  <span className="field-error">{errors.date.message}</span>
                )}
              </div>
            </div>

            <div className="field">
              <label htmlFor="bagNumber" className="field-label field-required">
                {t('step_4_deposit.fields.bag_number')}
              </label>
              <input
                id="bagNumber"
                className="input"
                {...register('bagNumber')}
              />
              {errors.bagNumber && (
                <span className="field-error">{errors.bagNumber.message}</span>
              )}
            </div>

            <hr className="divider" />

            <div className="field">
              <h3 className="section-heading">
                {t('step_4_deposit.fields.denominations_title')}
              </h3>
              <div className="denom-grid">
                <div className="denom-grid__head">
                  <span />
                  <span>{t('step_4_deposit.fields.denom_count')}</span>
                  <span>{t('step_4_deposit.fields.subtotal')}</span>
                </div>
                {DENOMINATIONS.map((d) => {
                  const count = Number(denomValues?.[d.key]) || 0;
                  return (
                    <div key={d.key} className="denom-grid__row">
                      <label htmlFor={`denom-${d.key}`} className="denom-grid__label">
                        {t('step_4_deposit.fields.bills_label', { value: d.value })}
                      </label>
                      <input
                        id={`denom-${d.key}`}
                        className="input"
                        type="number"
                        min="0"
                        {...register(`denominations.${d.key}` as const)}
                      />
                      <span className="denom-grid__subtotal">
                        ${(count * d.value).toFixed(2)}
                      </span>
                    </div>
                  );
                })}
                <div className="denom-grid__total">
                  <span>{t('step_4_deposit.fields.total_label')}</span>
                  <strong>${calculatedTotal.toFixed(2)}</strong>
                </div>
              </div>
              {errors.denominations && (
                <span className="field-error">
                  {errors.denominations.message as string}
                </span>
              )}
            </div>

            <div className="field">
              <label htmlFor="notes" className="field-label">
                {t('step_4_deposit.fields.notes')}
              </label>
              <textarea
                id="notes"
                className="textarea"
                rows={2}
                {...register('notes')}
              />
            </div>
          </div>
        </StepShell>
      </form>
    </FormProvider>
  );
}
