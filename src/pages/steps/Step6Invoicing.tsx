import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { FormProvider, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { FileText } from 'lucide-react';

import { StepShell } from '../../components/ui/StepShell';
import { useOnboardingStore } from '../../stores/onboardingStore';
import { loadDraft, saveDraft, submitStep } from '../../lib/stepService';
import {
  step6Schema,
  step6Defaults,
  type Step6Values,
} from './Step6Invoicing.schema';

/**
 * Step 6 — Invoicing contact + sample invoice preview.
 *
 * Captures the weekly-billing contact. A "Preview Sample Invoice" button
 * opens the static sample PDF inline so the retailer can see what the
 * real weekly invoices will look like. No email is sent from this step;
 * the live weekly invoices are driven by the SFDC Scheduled Flow.
 *
 * Flow:
 *   1. Collect billing contact name + email
 *   2. (Optional) Click "Preview Sample Invoice" → opens /sample-invoice.pdf
 *   3. On Continue → write contact to Supabase via submitStep(6, values)
 *   4. Advance to Step 7
 */
export default function Step6Invoicing() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const markStepCompleted = useOnboardingStore((s) => s.markStepCompleted);
  const setCurrentStep = useOnboardingStore((s) => s.setCurrentStep);

  const [submitting, setSubmitting] = useState(false);
  const [draftLoaded, setDraftLoaded] = useState(false);

  const methods = useForm<Step6Values>({
    resolver: zodResolver(step6Schema),
    defaultValues: step6Defaults,
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
      const draft = await loadDraft<Step6Values>(6);
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
        void saveDraft(6, values);
      }, 1500);
      return () => clearTimeout(handle);
    });
    return () => subscription.unsubscribe();
  }, [watch, draftLoaded]);

  const onSubmit = async (values: Step6Values) => {
    setSubmitting(true);
    try {
      await submitStep(6, values);
      markStepCompleted(6);
      setCurrentStep(7);
      navigate('/onboarding/launch');
    } catch (err) {
      const msg = err instanceof Error ? err.message : '';
      toast.error(msg || t('global.errors.generic'));
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
          stepId={6}
          titleKey="step_6_invoicing.title"
          subtitleKey="step_6_invoicing.subtitle"
          submitting={submitting}
          submitLabelKey="step_6_invoicing.submit"
        >
          <div className="sample-callout">
            <p>
              <strong>{t('step_6_invoicing.cadence_heading')}</strong>
            </p>
            <ul>
              <li>{t('step_6_invoicing.cadence_bullet_1')}</li>
              <li>{t('step_6_invoicing.cadence_bullet_2')}</li>
              <li>{t('step_6_invoicing.cadence_bullet_3')}</li>
            </ul>
          </div>

          <div className="sample-preview-row" style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', background: '#f7f8fa', border: '1px solid #e3e6ec', borderRadius: 8, margin: '8px 0 16px' }}>
            <FileText size={20} aria-hidden="true" />
            <div style={{ flex: 1 }}>
              <strong style={{ display: 'block' }}>
                {t('step_6_invoicing.preview_heading', 'See a sample invoice')}
              </strong>
              <span style={{ fontSize: 13, color: '#5b6472' }}>
                {t('step_6_invoicing.preview_subcopy', 'Opens the PDF in a new tab so you know what to expect each week.')}
              </span>
            </div>
            <a
              href="/sample-invoice.pdf"
              target="_blank"
              rel="noopener noreferrer"
              className="btn btn-secondary"
              data-testid="preview-sample-invoice"
            >
              {t('step_6_invoicing.preview_button', 'Preview Sample Invoice')}
            </a>
          </div>

          <div className="field-row">
            <div className="field">
              <label htmlFor="contactName" className="field-label">
                {t('step_6_invoicing.fields.contact_name')}
              </label>
              <input
                id="contactName"
                className="input"
                type="text"
                autoComplete="name"
                {...register('contactName')}
              />
              {errors.contactName && (
                <span className="field-error">
                  {errors.contactName.message}
                </span>
              )}
            </div>

            <div className="field">
              <label htmlFor="contactEmail" className="field-label">
                {t('step_6_invoicing.fields.contact_email')}
              </label>
              <input
                id="contactEmail"
                className="input"
                type="email"
                autoComplete="email"
                {...register('contactEmail')}
              />
              {errors.contactEmail && (
                <span className="field-error">
                  {errors.contactEmail.message}
                </span>
              )}
            </div>
          </div>
        </StepShell>
      </form>
    </FormProvider>
  );
}
