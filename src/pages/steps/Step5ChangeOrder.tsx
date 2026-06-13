import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { FormProvider, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';

import { StepShell } from '../../components/ui/StepShell';
import { useOnboardingStore } from '../../stores/onboardingStore';
import { loadDraft, saveDraft, submitStep } from '../../lib/stepService';
import {
  step5Schema,
  step5Defaults,
  COIN_DENOMINATIONS,
  BILL_DENOMINATIONS,
  ROLL_COUNTS,
  addBusinessDays,
  type Step5Values,
} from './Step5ChangeOrder.schema';

/**
 * Step 5 — Sample change order dry-run.
 *
 * Retailer submits a sample request for $50 in quarters ($10 × 5 rolls)
 * so they know how to do this when they need change post-launch.
 */
export default function Step5ChangeOrder() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const markStepCompleted = useOnboardingStore((s) => s.markStepCompleted);
  const setCurrentStep = useOnboardingStore((s) => s.setCurrentStep);

  const [submitting, setSubmitting] = useState(false);
  const [draftLoaded, setDraftLoaded] = useState(false);

  const methods = useForm<Step5Values>({
    resolver: zodResolver(step5Schema),
    defaultValues: step5Defaults,
    mode: 'onBlur',
    shouldUnregister: false, // keep field values when sub-editors unmount
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
      const draft = await loadDraft<Step5Values>(5);
      if (mounted && draft) reset(draft);
      setDraftLoaded(true);
    })();
    return () => { mounted = false; };
  }, [reset]);

  useEffect(() => {
    if (!draftLoaded) return;
    const subscription = watch((values) => {
      const handle = setTimeout(() => {
        void saveDraft(5, values);
      }, 1500);
      return () => clearTimeout(handle);
    });
    return () => subscription.unsubscribe();
  }, [watch, draftLoaded]);

  const rolls = watch('rolls');
  const bills = watch('bills');

  // Inline calc — useMemo with [rolls, bills] deps misses nested mutations
  // because react-hook-form mutates objects in place (same reference).
  const coinTotal = COIN_DENOMINATIONS.reduce((sum, d) => {
    const count = Number(rolls?.[d.key]) || 0;
    return sum + count * ROLL_COUNTS[d.key] * d.value;
  }, 0);
  const billTotal = BILL_DENOMINATIONS.reduce((sum, d) => {
    const count = Number(bills?.[d.key]) || 0;
    return sum + count * d.value;
  }, 0);
  const calculatedTotal = coinTotal + billTotal;

  const minDateStr = useMemo(() => {
    const d = addBusinessDays(new Date(), 2);
    return d.toISOString().split('T')[0];
  }, []);

  const onSubmit = async (values: Step5Values) => {
    setSubmitting(true);
    try {
      await submitStep(5, values);
      markStepCompleted(5);
      setCurrentStep(6);
      toast.success(t('step_5_change_order.success'));
      navigate('/onboarding/invoicing');
    } catch (err) {
      const msg = err instanceof Error ? err.message : t('global.errors.generic');
      toast.error(msg);
    } finally {
      setSubmitting(false);
    }
  };

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
          stepId={5}
          titleKey="step_5_change_order.title"
          subtitleKey="step_5_change_order.subtitle"
          submitting={submitting}
          submitLabelKey="step_5_change_order.submit"
        >
          <div className="step-card stack stack-md">
            <div className="sample-callout">
              <strong>{t('step_5_change_order.instructions_lead')}</strong>
              <ul>
                <li>{t('step_5_change_order.fields.delivery_date_hint')}</li>
                <li>{t('step_5_change_order.fields.denominations_hint')}</li>
              </ul>
            </div>

            <div className="field">
              <label htmlFor="deliveryDate" className="field-label field-required">
                {t('step_5_change_order.fields.delivery_date')}
              </label>
              <input
                id="deliveryDate"
                className="input"
                type="date"
                min={minDateStr}
                {...register('deliveryDate')}
              />
              {errors.deliveryDate && (
                <span className="field-error">{errors.deliveryDate.message}</span>
              )}
            </div>

            <hr className="divider" />

            <div className="field">
              <h3 className="section-heading">{t('step_5_change_order.fields.coin_rolls_heading')}</h3>
              <div className="denom-grid">
                <div className="denom-grid__head">
                  <span />
                  <span>{t('step_5_change_order.fields.rolls_column')}</span>
                  <span>{t('step_5_change_order.fields.subtotal_column')}</span>
                </div>
                {COIN_DENOMINATIONS.map((d) => {
                  const count = Number(rolls?.[d.key]) || 0;
                  const subtotal = count * ROLL_COUNTS[d.key] * d.value;
                  return (
                    <div key={d.key} className="denom-grid__row">
                      <label
                        htmlFor={`roll-${d.key}`}
                        className="denom-grid__label"
                      >
                        {t('step_5_change_order.fields.roll_label', {
                          name: t(`step_5_change_order.fields.coin_${d.key}`),
                          amount: (ROLL_COUNTS[d.key] * d.value).toFixed(2),
                        })}
                      </label>
                      <input
                        id={`roll-${d.key}`}
                        className="input"
                        type="number"
                        min="0"
                        {...register(`rolls.${d.key}` as const)}
                      />
                      <span className="denom-grid__subtotal">
                        ${subtotal.toFixed(2)}
                      </span>
                    </div>
                  );
                })}
              </div>
              {errors.rolls && (
                <span className="field-error">{errors.rolls.message as string}</span>
              )}
            </div>

            <div className="field">
              <h3 className="section-heading">{t('step_5_change_order.fields.loose_bills_heading')}</h3>
              <div className="denom-grid">
                <div className="denom-grid__head">
                  <span />
                  <span>{t('step_5_change_order.fields.count_column')}</span>
                  <span>{t('step_5_change_order.fields.subtotal_column')}</span>
                </div>
                {BILL_DENOMINATIONS.map((d) => {
                  const count = Number(bills?.[d.key]) || 0;
                  return (
                    <div key={d.key} className="denom-grid__row">
                      <label htmlFor={`bill-${d.key}`} className="denom-grid__label">
                        {t('step_5_change_order.fields.bills_label', { value: d.value })}
                      </label>
                      <input
                        id={`bill-${d.key}`}
                        className="input"
                        type="number"
                        min="0"
                        {...register(`bills.${d.key}` as const)}
                      />
                      <span className="denom-grid__subtotal">
                        ${(count * d.value).toFixed(2)}
                      </span>
                    </div>
                  );
                })}
                <div className="denom-grid__total">
                  <span>{t('step_5_change_order.fields.total_label')}</span>
                  <strong>${calculatedTotal.toFixed(2)}</strong>
                </div>
              </div>
            </div>

            <div className="field">
              <label htmlFor="notes" className="field-label">
                {t('step_5_change_order.fields.delivery_notes')}
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
