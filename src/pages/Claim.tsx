import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useTranslation } from 'react-i18next';
import { supabase } from '../lib/supabase';
import { mockSignIn, MOCK_AUTH_ENABLED } from '../hooks/useAuth';
import { useOnboardingStore } from '../stores/onboardingStore';
import { LanguageToggle } from '../components/layout/LanguageToggle';
import { Logo } from '../components/layout/Logo';

/**
 * Step 0 — Claim account.
 *
 * The retailer arrives here via a deep link from the welcome email:
 *   /claim?email=<email>&code=<temp_code>&first_name=<first_name>&sfdc=<sfdc_id>
 *
 * They:
 *   1. Confirm their email (read-only, from the deep link)
 *   2. Paste the temporary code (prefilled from the deep link but they can retype)
 *   3. Pick a new password
 *   4. Pick an MFA method (SMS or authenticator app)
 *
 * On success, MFA enrollment kicks off. In PR #3 we stub the MFA enrollment —
 * SMS flow needs Twilio or Supabase phone auth enabled, TOTP flow uses
 * supabase.auth.mfa.enroll(). Real wiring lands alongside PR #11 (SFDC sync)
 * when we know the final shape of the Welcome Email → deep link contract.
 */

const claimSchema = z
  .object({
    email: z.string().email(),
    tempCode: z.string().min(6, 'Code must be at least 6 characters'),
    newPassword: z
      .string()
      .min(12, 'Password must be at least 12 characters')
      .regex(/[A-Z]/, 'Include an uppercase letter')
      .regex(/[0-9]/, 'Include a number')
      .regex(/[^A-Za-z0-9]/, 'Include a symbol'),
    confirmPassword: z.string(),
    mfaMethod: z.enum(['sms', 'totp']),
  })
  .refine((data) => data.newPassword === data.confirmPassword, {
    message: 'Passwords do not match',
    path: ['confirmPassword'],
  });

type ClaimFormValues = z.infer<typeof claimSchema>;

export default function Claim() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const setOnboarding = useOnboardingStore((s) => s.setOnboarding);

  const emailFromLink = params.get('email') || '';
  const codeFromLink = params.get('code') || '';
  const firstName = params.get('first_name') || '';
  const sfdcAccountId = params.get('sfdc') || '';

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<ClaimFormValues>({
    resolver: zodResolver(claimSchema),
    defaultValues: {
      email: emailFromLink,
      tempCode: codeFromLink,
      newPassword: '',
      confirmPassword: '',
      mfaMethod: 'sms',
    },
  });

  const onSubmit = async (values: ClaimFormValues) => {
    setSubmitting(true);
    setError(null);
    try {
      if (MOCK_AUTH_ENABLED) {
        mockSignIn(values.email, sfdcAccountId || 'MOCK-001');
      } else {
        // Real flow — verify the one-time code, then set the password.
        // Supabase sends a recovery/verify email; the 'code' is the token.
        const { error: verifyError } = await supabase.auth.verifyOtp({
          email: values.email,
          token: values.tempCode,
          type: 'email',
        });
        if (verifyError) throw verifyError;

        const { error: updateError } = await supabase.auth.updateUser({
          password: values.newPassword,
        });
        if (updateError) throw updateError;

        // TODO (PR #3 follow-up): enroll MFA based on values.mfaMethod.
        // For SMS: supabase.auth.mfa.enroll({ factorType: 'phone', phone })
        // For TOTP: supabase.auth.mfa.enroll({ factorType: 'totp' })
        // We'll surface the QR code / SMS verification inline once we finalize
        // the SFDC → welcome email → deep link contract.
      }

      // Seed the store with what we know about this retailer
      setOnboarding({
        sfdcAccountId: sfdcAccountId || null,
        storefrontName: null, // will be hydrated from SFDC in PR #4
        currentStep: 1,
      });

      navigate('/onboarding', { replace: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : t('global.errors.generic');
      setError(message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main style={{ minHeight: '100vh', padding: 'var(--space-6) 0' }}>
      <header style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        padding: '0 var(--space-6)',
        marginBottom: 'var(--space-8)',
      }}>
        <Logo />
        <LanguageToggle />
      </header>

      <div className="container" style={{ maxWidth: '520px' }}>
        <header className="stack stack-sm" style={{ marginBottom: 'var(--space-6)' }}>
          <div className="text-muted text-sm">
            {t('nav.step_of', 'Step {current} of {total}', { current: 0, total: 7 })}
          </div>
          <h1>
            {firstName
              ? t('step_0_claim.title', 'Welcome to NST, {firstName}.', { firstName })
              : t('step_0_claim.title_no_name', 'Welcome to NST.')}
          </h1>
          <p className="text-muted">{t('step_0_claim.subtitle')}</p>
        </header>

        <form onSubmit={handleSubmit(onSubmit)} className="card stack stack-md" noValidate>
          {/* Email (read-only from deep link) */}
          <div className="field">
            <label htmlFor="email" className="field-label">
              {t('step_0_claim.fields.email_label')}
            </label>
            <input
              id="email"
              type="email"
              className="input"
              {...register('email')}
              readOnly={!!emailFromLink}
              disabled={!!emailFromLink}
              autoComplete="email"
            />
            {errors.email && <span className="field-error">{errors.email.message}</span>}
          </div>

          {/* Temporary code */}
          <div className="field">
            <label htmlFor="tempCode" className="field-label field-required">
              {t('step_0_claim.fields.temp_code_label')}
            </label>
            <input
              id="tempCode"
              type="text"
              className="input mono"
              {...register('tempCode')}
              autoComplete="one-time-code"
              inputMode="text"
            />
            {errors.tempCode && <span className="field-error">{errors.tempCode.message}</span>}
          </div>

          {/* New password */}
          <div className="field">
            <label htmlFor="newPassword" className="field-label field-required">
              {t('step_0_claim.fields.new_password_label')}
            </label>
            <input
              id="newPassword"
              type="password"
              className="input"
              {...register('newPassword')}
              autoComplete="new-password"
              minLength={12}
            />
            <span className="field-hint">
              {t('global.validation.password_weak')}
            </span>
            {errors.newPassword && <span className="field-error">{errors.newPassword.message}</span>}
          </div>

          {/* Confirm password */}
          <div className="field">
            <label htmlFor="confirmPassword" className="field-label field-required">
              {t('step_0_claim.fields.confirm_password_label')}
            </label>
            <input
              id="confirmPassword"
              type="password"
              className="input"
              {...register('confirmPassword')}
              autoComplete="new-password"
            />
            {errors.confirmPassword && <span className="field-error">{errors.confirmPassword.message}</span>}
          </div>

          {/* MFA choice */}
          <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
            <legend className="field-label field-required">
              {t('step_0_claim.fields.mfa_label')}
            </legend>
            <div className="stack stack-xs" style={{ marginTop: 'var(--space-2)' }}>
              <label className="row row-sm" style={{ cursor: 'pointer' }}>
                <input type="radio" value="sms" className="radio" {...register('mfaMethod')} />
                <span>{t('step_0_claim.fields.mfa_sms')}</span>
              </label>
              <label className="row row-sm" style={{ cursor: 'pointer' }}>
                <input type="radio" value="totp" className="radio" {...register('mfaMethod')} />
                <span>{t('step_0_claim.fields.mfa_totp')}</span>
              </label>
            </div>
          </fieldset>

          {error && (
            <div className="banner banner-error" role="alert">
              <span>{error}</span>
            </div>
          )}

          <button type="submit" className="btn btn-primary btn-block" disabled={submitting}>
            {submitting ? <span className="spinner" aria-hidden /> : t('step_0_claim.submit')}
          </button>
        </form>
      </div>
    </main>
  );
}
