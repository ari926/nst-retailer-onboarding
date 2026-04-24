import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { FormProvider, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { Mail, CheckCircle2, AlertCircle } from 'lucide-react';

import { StepShell } from '../../components/ui/StepShell';
import { useOnboardingStore } from '../../stores/onboardingStore';
import { loadDraft, saveDraft, submitStep } from '../../lib/stepService';
import { sendSampleInvoice } from '../../lib/emailService';
import {
  step6Schema,
  step6Defaults,
  type Step6Values,
} from './Step6Invoicing.schema';

/**
 * Step 6 — Invoicing contact + sample invoice.
 *
 * Captures the weekly-billing contact and (optionally) fires a sample
 * invoice email so the retailer knows what the real ones will look like.
 *
 * Flow:
 *   1. Collect name + email + opt-in checkbox
 *   2. On submit → write contact to Supabase via submitStep(6, values)
 *   3. If sendSample=true → call emailService.sendSampleInvoice
 *      - accepted=true → confirmation state with "I got the sample" ack
 *      - accepted=false → show bounce banner, keep form editable
 *   4. Ack → navigate to /onboarding/launch
 */
export default function Step6Invoicing() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const sfdcAccountId = useOnboardingStore((s) => s.sfdcAccountId);
  const storefrontName = useOnboardingStore((s) => s.storefrontName);
  const markStepCompleted = useOnboardingStore((s) => s.markStepCompleted);
  const setCurrentStep = useOnboardingStore((s) => s.setCurrentStep);

  const [submitting, setSubmitting] = useState(false);
  const [draftLoaded, setDraftLoaded] = useState(false);
  const [sampleState, setSampleState] = useState<
    'idle' | 'sending' | 'sent' | 'bounced'
  >('idle');
  const [sentToEmail, setSentToEmail] = useState('');
  const [bounceReason, setBounceReason] = useState('');

  const methods = useForm<Step6Values>({
    resolver: zodResolver(step6Schema),
    defaultValues: step6Defaults,
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
    setBounceReason('');
    try {
      await submitStep(6, values);

      if (values.sendSample) {
        setSampleState('sending');
        const result = await sendSampleInvoice({
          sfdcAccountId: sfdcAccountId ?? 'UNKNOWN',
          storefrontName: storefrontName ?? 'your store',
          contactName: values.contactName,
          contactEmail: values.contactEmail,
        });

        if (!result.accepted) {
          setSampleState('bounced');
          setBounceReason(result.errorReason ?? 'unknown');
          toast.error(t('step_6_invoicing.bounce_error'));
          return; // keep form editable
        }

        setSentToEmail(values.contactEmail);
        setSampleState('sent');
      } else {
        // No sample requested — complete and move on
        markStepCompleted(6);
        setCurrentStep(7);
        navigate('/onboarding/launch');
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : t('global.errors.generic');
      toast.error(msg);
    } finally {
      setSubmitting(false);
    }
  };

  const acknowledgeSample = () => {
    markStepCompleted(6);
    setCurrentStep(7);
    navigate('/onboarding/launch');
  };

  // Sent confirmation state
  if (sampleState === 'sent') {
    return (
      <section className="stack stack-lg">
        <div className="step-header">
          <div className="step-header__eyebrow">
            {t('nav.step_of', 'Step {current} of {total}', { current: 6, total: 7 })}
          </div>
          <h1>{t('step_6_invoicing.title')}</h1>
        </div>
        <div className="callout callout--success">
          <CheckCircle2 size={20} />
          <div>
            <strong>
              {t('step_6_invoicing.sent_message', { email: sentToEmail })}
            </strong>
            <p className="callout__sub">{t('step_6_invoicing.sent_subcopy')}</p>
          </div>
        </div>
        <div className="step-footer">
          <div />
          <div className="step-footer__actions">
            <button
              type="button"
              className="btn btn-primary"
              onClick={acknowledgeSample}
            >
              {t('step_6_invoicing.ack_button')}
            </button>
          </div>
        </div>
      </section>
    );
  }

  return (
    <FormProvider {...methods}>
      <form id="step-form" onSubmit={handleSubmit(onSubmit)} noValidate>
        <StepShell
          stepId={6}
          titleKey="step_6_invoicing.title"
          subtitleKey="step_6_invoicing.subtitle"
          submitting={submitting || sampleState === 'sending'}
          submitLabelKey="step_6_invoicing.submit"
        >
          {sampleState === 'bounced' && (
            <div className="callout callout--error" role="alert">
              <AlertCircle size={20} />
              <div>
                <strong>{t('step_6_invoicing.bounce_error')}</strong>
                {bounceReason && (
                  <p className="callout__sub">
                    {t('step_6_invoicing.bounce_reason_prefix')}{' '}
                    <code>{bounceReason}</code>
                  </p>
                )}
              </div>
            </div>
          )}

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

          <label className="checkbox-row">
            <input type="checkbox" {...register('sendSample')} />
            <span>
              <Mail size={14} style={{ marginRight: 6 }} />
              {t('step_6_invoicing.fields.send_sample_checkbox')}
            </span>
          </label>
        </StepShell>
      </form>
    </FormProvider>
  );
}
