import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { FormProvider, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';

import { StepShell } from '../../components/ui/StepShell';
import { useOnboardingStore } from '../../stores/onboardingStore';
import { loadDraft, saveDraft, submitStep } from '../../lib/stepService';
import { makeInvalidHandler } from '../../lib/formErrors';
import {
  step5Schema,
  step5Defaults,
  BUNDLE_DENOMINATIONS,
  COIN_BOX_DENOMINATIONS,
  addBusinessDays,
  type Step5Values,
} from './Step5ChangeOrder.schema';

/**
 * Step 4 (formerly Step 5) — Sample change order dry-run.
 *
 * V2: change orders are denominated as currency bundles + coin boxes only.
 * Users enter the *number of bundles/boxes*; the form multiplies each entry
 * by the per-bundle / per-box value to compute live subtotals and grand total.
 *
 * File name kept Step5ChangeOrder for stability — stepId is now 4 across the
 * store / nav / draft persistence.
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
      const draft = await loadDraft<Step5Values>(4);
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

  const bundles = watch('bundles');
  const coinBoxes = watch('coinBoxes');

  const calculatedTotal = useMemo(() => {
    const bundleTotal = BUNDLE_DENOMINATIONS.reduce((sum, d) => {
      const count = Number(bundles?.[d.key]) || 0;
      return sum + count * d.mult;
    }, 0);
    const boxTotal = COIN_BOX_DENOMINATIONS.reduce((sum, d) => {
      const count = Number(coinBoxes?.[d.key]) || 0;
      return sum + count * d.mult;
    }, 0);
    return bundleTotal + boxTotal;
  }, [bundles, coinBoxes]);

  const minDateStr = useMemo(() => {
    const d = addBusinessDays(new Date(), 2);
    return d.toISOString().split('T')[0];
  }, []);

  const onSubmit = async (values: Step5Values) => {
    setSubmitting(true);
    try {
      await submitStep(4, values);
      markStepCompleted(4);
      setCurrentStep(5);
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
      <form id="step-form" onSubmit={handleSubmit(onSubmit, makeInvalidHandler(t))} noValidate>
        <StepShell
          stepId={4}
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
                <li>{t('step_5_change_order.fields.bundles_hint')}</li>
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

            {/* Currency bundles */}
            <div className="field">
              <h3 className="section-heading">
                {t('step_5_change_order.fields.bundles_heading')}
              </h3>
              <p className="text-muted text-sm" style={{ marginBottom: 8 }}>
                {t('step_5_change_order.fields.bundles_subhead')}
              </p>
              <div className="denom-grid">
                <div className="denom-grid__head">
                  <span>{t('step_5_change_order.fields.denomination_column')}</span>
                  <span>{t('step_5_change_order.fields.bundles_column')}</span>
                  <span>{t('step_5_change_order.fields.subtotal_column')}</span>
                </div>
                {BUNDLE_DENOMINATIONS.map((d) => {
                  const count = Number(bundles?.[d.key]) || 0;
                  const subtotal = count * d.mult;
                  return (
                    <div key={d.key} className="denom-grid__row">
                      <label
                        htmlFor={`bundle-${d.key}`}
                        className="denom-grid__label"
                      >
                        {t('step_5_change_order.fields.bundle_label', {
                          value: d.value,
                          mult: d.mult.toLocaleString('en-US'),
                        })}
                      </label>
                      <input
                        id={`bundle-${d.key}`}
                        className="input"
                        type="number"
                        min="0"
                        {...register(`bundles.${d.key}` as const)}
                      />
                      <span className="denom-grid__subtotal">
                        ${subtotal.toLocaleString('en-US', {
                          minimumFractionDigits: 2,
                          maximumFractionDigits: 2,
                        })}
                      </span>
                    </div>
                  );
                })}
              </div>
              {errors.bundles && (
                <span className="field-error">
                  {errors.bundles.message as string}
                </span>
              )}
            </div>

            {/* Coin boxes */}
            <div className="field">
              <h3 className="section-heading">
                {t('step_5_change_order.fields.coin_boxes_heading')}
              </h3>
              <p className="text-muted text-sm" style={{ marginBottom: 8 }}>
                {t('step_5_change_order.fields.coin_boxes_subhead')}
              </p>
              <div className="denom-grid">
                <div className="denom-grid__head">
                  <span>{t('step_5_change_order.fields.denomination_column')}</span>
                  <span>{t('step_5_change_order.fields.boxes_column')}</span>
                  <span>{t('step_5_change_order.fields.subtotal_column')}</span>
                </div>
                {COIN_BOX_DENOMINATIONS.map((d) => {
                  const count = Number(coinBoxes?.[d.key]) || 0;
                  const subtotal = count * d.mult;
                  return (
                    <div key={d.key} className="denom-grid__row">
                      <label
                        htmlFor={`box-${d.key}`}
                        className="denom-grid__label"
                      >
                        {t('step_5_change_order.fields.box_label', {
                          name: t(`step_5_change_order.fields.coin_${d.key}`),
                          mult: d.mult.toLocaleString('en-US'),
                        })}
                      </label>
                      <input
                        id={`box-${d.key}`}
                        className="input"
                        type="number"
                        min="0"
                        {...register(`coinBoxes.${d.key}` as const)}
                      />
                      <span className="denom-grid__subtotal">
                        ${subtotal.toLocaleString('en-US', {
                          minimumFractionDigits: 2,
                          maximumFractionDigits: 2,
                        })}
                      </span>
                    </div>
                  );
                })}
                <div className="denom-grid__total">
                  <span>{t('step_5_change_order.fields.total_label')}</span>
                  <strong>
                    ${calculatedTotal.toLocaleString('en-US', {
                      minimumFractionDigits: 2,
                      maximumFractionDigits: 2,
                    })}
                  </strong>
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
