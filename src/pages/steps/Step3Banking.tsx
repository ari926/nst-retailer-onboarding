import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { FormProvider, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { Info } from 'lucide-react';

import { StepShell } from '../../components/ui/StepShell';
import { useOnboardingStore } from '../../stores/onboardingStore';
import { loadDraft, saveDraft, submitStep } from '../../lib/stepService';
import {
  step3Schema,
  step3Defaults,
  type Step3Values,
} from './Step3Banking.schema';

/**
 * Step 3 — Banking confirmation.
 *
 * 2026-07-26 (Amanda's change set): OCR path removed. There is no upstream
 * pipeline delivering the signed cash info form to us today (no S3 bucket, no
 * SF Files integration, no Textract function). Every retailer was seeing the
 * red "We couldn't read your form automatically" banner because the client
 * was invoking a Supabase Edge Function (`ocr-banking`) that was never
 * deployed. Per Ari, we ship a clean manual-entry mode now; when the OCR
 * pipeline is built later we'll flip back to auto-fill.
 */
export default function Step3Banking() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const markStepCompleted = useOnboardingStore((s) => s.markStepCompleted);
  const setCurrentStep = useOnboardingStore((s) => s.setCurrentStep);

  const [submitting, setSubmitting] = useState(false);
  const [draftLoaded, setDraftLoaded] = useState(false);

  const methods = useForm<Step3Values>({
    resolver: zodResolver(step3Schema),
    defaultValues: step3Defaults,
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

  // On mount: load any saved draft. Always start in manual-entry mode
  // (source='manual', matches=true). See file-header comment for why the OCR
  // path is disabled.
  useEffect(() => {
    let mounted = true;
    (async () => {
      const draft = await loadDraft<Step3Values>(3);
      if (!mounted) return;

      if (draft && draft.bankName) {
        // Force source=manual on legacy drafts so review-mode read-only
        // inputs don't lock out edits.
        reset({ ...draft, source: 'manual', matches: true });
      } else {
        setValue('source', 'manual');
        setValue('matches', true);
      }
      setDraftLoaded(true);
    })();
    return () => { mounted = false; };
  }, [reset, setValue]);

  // Autosave
  useEffect(() => {
    if (!draftLoaded) return;
    let handle: ReturnType<typeof setTimeout> | null = null;
    const subscription = watch((values) => {
      if (handle) clearTimeout(handle);
      handle = setTimeout(() => {
        void saveDraft(3, values);
      }, 1500);
    });
    return () => {
      if (handle) clearTimeout(handle);
      subscription.unsubscribe();
    };
  }, [watch, draftLoaded]);

  const onSubmit = async (values: Step3Values) => {
    setSubmitting(true);
    try {
      await submitStep(3, values);
      markStepCompleted(3);
      setCurrentStep(4);
      toast.success(t('step_3_banking.saved', 'Banking details confirmed.'));
      navigate('/onboarding/deposit');
    } catch (err) {
      const msg = err instanceof Error ? err.message : t('global.errors.generic');
      toast.error(msg);
    } finally {
      setSubmitting(false);
    }
  };

  // Manual entry only — no review/read-only mode until the OCR pipeline exists.
  const reviewMode = false;

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
          stepId={3}
          titleKey="step_3_banking.title"
          subtitleKey="step_3_banking.subtitle"
          submitting={submitting}
        >
          <div className="step-card stack stack-md">
            <div className="banner banner--info">
              <Info size={18} aria-hidden />
              <span>{t('step_3_banking.manual_intro')}</span>
            </div>

            <div className="grid-2">
                  <div className="field">
                    <label htmlFor="bankName" className="field-label field-required">
                      {t('step_3_banking.fields.bank_name')}
                    </label>
                    <input
                      id="bankName"
                      className="input"
                      readOnly={reviewMode}
                      {...register('bankName')}
                    />
                    {errors.bankName && (
                      <span className="field-error">{errors.bankName.message}</span>
                    )}
                  </div>
                  <div className="field">
                    <label
                      htmlFor="signerName"
                      className="field-label field-required"
                    >
                      {t('step_3_banking.fields.signer_name')}
                    </label>
                    <input
                      id="signerName"
                      className="input"
                      readOnly={reviewMode}
                      {...register('signerName')}
                    />
                    {errors.signerName && (
                      <span className="field-error">{errors.signerName.message}</span>
                    )}
                  </div>
                </div>

                <div className="grid-2">
                  <div className="field">
                    <label
                      htmlFor="accountLast4"
                      className="field-label field-required"
                    >
                      {t('step_3_banking.fields.account_last4')}
                    </label>
                    <input
                      id="accountLast4"
                      className="input"
                      inputMode="numeric"
                      maxLength={4}
                      readOnly={reviewMode}
                      {...register('accountLast4')}
                    />
                    {errors.accountLast4 && (
                      <span className="field-error">
                        {errors.accountLast4.message}
                      </span>
                    )}
                  </div>
                  <div className="field">
                    <label
                      htmlFor="routingNumber"
                      className="field-label field-required"
                    >
                      {t('step_3_banking.fields.routing_number')}
                    </label>
                    <input
                      id="routingNumber"
                      className="input"
                      inputMode="numeric"
                      maxLength={9}
                      readOnly={reviewMode}
                      {...register('routingNumber')}
                    />
                    {errors.routingNumber && (
                      <span className="field-error">
                        {errors.routingNumber.message}
                      </span>
                    )}
                  </div>
                </div>

          </div>
        </StepShell>
      </form>
    </FormProvider>
  );
}
