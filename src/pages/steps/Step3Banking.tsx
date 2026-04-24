import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { FormProvider, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { AlertCircle, Loader2 } from 'lucide-react';

import { StepShell } from '../../components/ui/StepShell';
import { useOnboardingStore } from '../../stores/onboardingStore';
import { loadDraft, saveDraft, submitStep } from '../../lib/stepService';
import { fetchBankingOcr } from '../../lib/ocrService';
import {
  step3Schema,
  step3Defaults,
  type Step3Values,
} from './Step3Banking.schema';

/**
 * Step 3 — Banking confirmation.
 *
 * On mount: calls OCR service to pull values from the signed cash info form.
 *   - On success: populates form in "review" mode (fields disabled, "these
 *     match" checkbox + "flag for NST to update" button).
 *   - On failure: shows manual-entry mode with editable fields and a banner.
 */
export default function Step3Banking() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const sfdcAccountId = useOnboardingStore((s) => s.sfdcAccountId);
  const markStepCompleted = useOnboardingStore((s) => s.markStepCompleted);
  const setCurrentStep = useOnboardingStore((s) => s.setCurrentStep);

  const [submitting, setSubmitting] = useState(false);
  const [ocrLoading, setOcrLoading] = useState(true);
  const [ocrFailed, setOcrFailed] = useState(false);
  const [draftLoaded, setDraftLoaded] = useState(false);

  const methods = useForm<Step3Values>({
    resolver: zodResolver(step3Schema),
    defaultValues: step3Defaults,
    mode: 'onBlur',
  });

  const {
    register,
    handleSubmit,
    watch,
    reset,
    setValue,
    formState: { errors },
  } = methods;

  const source = watch('source');
  const matches = watch('matches');

  // On mount: try to load draft first; if none, run OCR
  useEffect(() => {
    let mounted = true;
    (async () => {
      const draft = await loadDraft<Step3Values>(3);
      if (!mounted) return;

      if (draft && draft.bankName) {
        // Draft exists — skip OCR, use stored values
        reset(draft);
        setOcrLoading(false);
        setOcrFailed(draft.source === 'manual');
      } else if (sfdcAccountId) {
        const result = await fetchBankingOcr(sfdcAccountId);
        if (!mounted) return;
        if (result.success) {
          reset({
            source: 'ocr',
            bankName: result.bankName,
            accountLast4: result.accountLast4,
            routingNumber: result.routingNumber,
            signerName: result.signerName,
            matches: true,
            mismatchNotes: '',
          });
        } else {
          setOcrFailed(true);
          setValue('source', 'manual');
        }
        setOcrLoading(false);
      } else {
        setOcrFailed(true);
        setValue('source', 'manual');
        setOcrLoading(false);
      }
      setDraftLoaded(true);
    })();
    return () => { mounted = false; };
  }, [reset, setValue, sfdcAccountId]);

  // Autosave
  useEffect(() => {
    if (!draftLoaded) return;
    const subscription = watch((values) => {
      const handle = setTimeout(() => {
        void saveDraft(3, values);
      }, 1500);
      return () => clearTimeout(handle);
    });
    return () => subscription.unsubscribe();
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

  const reviewMode = source === 'ocr' && !ocrFailed;

  return (
    <FormProvider {...methods}>
      <form id="step-form" onSubmit={handleSubmit(onSubmit)} noValidate>
        <StepShell
          stepId={3}
          titleKey="step_3_banking.title"
          subtitleKey="step_3_banking.subtitle"
          submitting={submitting}
        >
          <div className="step-card stack stack-md">
            {ocrLoading ? (
              <div className="ocr-loading">
                <Loader2 className="spinner" aria-hidden />
                <p>Reading your signed form...</p>
              </div>
            ) : (
              <>
                {ocrFailed && (
                  <div className="banner banner--warn">
                    <AlertCircle size={18} aria-hidden />
                    <span>{t('step_3_banking.ocr_fail_banner')}</span>
                  </div>
                )}

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

                {reviewMode && (
                  <>
                    <hr className="divider" />
                    <label className="checkbox-row">
                      <input type="checkbox" {...register('matches')} />
                      <span>{t('step_3_banking.fields.match_checkbox')}</span>
                    </label>
                    {!matches && (
                      <div className="field">
                        <label
                          htmlFor="mismatchNotes"
                          className="field-label field-required"
                        >
                          {t('step_3_banking.fields.mismatch_notes')}
                        </label>
                        <textarea
                          id="mismatchNotes"
                          className="textarea"
                          rows={3}
                          {...register('mismatchNotes')}
                        />
                        {errors.mismatchNotes && (
                          <span className="field-error">
                            {errors.mismatchNotes.message}
                          </span>
                        )}
                      </div>
                    )}
                  </>
                )}
              </>
            )}
          </div>
        </StepShell>
      </form>
    </FormProvider>
  );
}
