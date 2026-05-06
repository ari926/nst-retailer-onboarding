import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Controller, FormProvider, useForm, useFormContext } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';

import { StepShell } from '../../components/ui/StepShell';
import { useOnboardingStore } from '../../stores/onboardingStore';
import { loadDraft, saveDraft, submitStep } from '../../lib/stepService';
import { useOnboardingContext, type OnboardingContext } from '../../hooks/useOnboardingContext';
import {
  step1Schema,
  step1Defaults,
  US_STATES,
  type Step1Values,
} from './Step1Profile.schema';

/**
 * Step 1 — Confirm store profile (v2 review-card layout).
 *
 * The retailer arrives here from their kickoff email link `/?t=<token>`.
 * Home redirects to `/onboarding/profile?t=<token>`. We use the token to fetch
 * fresh prefill from Salesforce (Account.BillingStreet/City/State/PostalCode/
 * Phone/Website + the primary Contact) on first load and seed the form.
 *
 * UI is review-first: each card shows what we have on file with an Edit button
 * that flips just that card into edit mode. Default operating hours are
 * 10:00 AM – 6:00 PM × 7 days, which the retailer is asked to verify.
 *
 * Autosaves a draft every 1.5s after changes, and on submit writes to
 * step_submissions, marks the step complete, and navigates to step 2.
 */

const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
type DayKey = typeof DAYS[number];
const DAY_LABEL: Record<DayKey, string> = {
  mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun',
};

type EditKey = 'business' | 'address' | 'hours' | 'owner' | 'manager';

export default function Step1Profile() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const token = params.get('t');

  const markStepCompleted = useOnboardingStore((s) => s.markStepCompleted);
  const setCurrentStep = useOnboardingStore((s) => s.setCurrentStep);
  const setOnboarding = useOnboardingStore((s) => s.setOnboarding);

  const [submitting, setSubmitting] = useState(false);
  const [draftLoaded, setDraftLoaded] = useState(false);
  const [editing, setEditing] = useState<Record<EditKey, boolean>>({
    business: false, address: false, hours: false, owner: false, manager: false,
  });

  const ctx = useOnboardingContext(token);

  const methods = useForm<Step1Values>({
    resolver: zodResolver(step1Schema),
    defaultValues: step1Defaults,
    mode: 'onBlur',
  });
  const { handleSubmit, watch, reset, getValues } = methods;

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

  // Once SF prefill arrives, seed empty fields (don't clobber a draft the user
  // already typed into).
  useEffect(() => {
    if (!draftLoaded || !ctx.data) return;
    const current = getValues();
    const next = mergePrefill(current, ctx.data);
    if (next) reset(next, { keepDirty: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftLoaded, ctx.data]);

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

  const toggleEdit = (key: EditKey, on: boolean) =>
    setEditing((prev) => ({ ...prev, [key]: on }));

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

  return (
    <FormProvider {...methods}>
      <form id="step-form" onSubmit={handleSubmit(onSubmit)} noValidate>
        <StepShell
          stepId={1}
          titleKey="step_1_profile.title"
          subtitleKey="step_1_profile.subtitle"
          submitting={submitting}
          submitLabelKey="step_1_profile.confirm_continue"
        >
          <div className="review-page">
            <div className="review-banner" role="note">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <circle cx="12" cy="12" r="10" /><path d="M12 16v-4M12 8h.01" />
              </svg>
              <span>
                {t(
                  'step_1_profile.review_banner',
                  "Everything looks correct? Hit",
                )}{' '}
                <strong>{t('step_1_profile.confirm_continue', 'Confirm & continue')}</strong>{' '}
                {t(
                  'step_1_profile.review_banner_2',
                  "at the bottom. Otherwise, edit just the section that needs to change.",
                )}
              </span>
            </div>

            <div className="review-grid">
              <BusinessCard editing={editing.business} setEditing={(v) => toggleEdit('business', v)} />
              <AddressCard editing={editing.address} setEditing={(v) => toggleEdit('address', v)} />
              <HoursCard editing={editing.hours} setEditing={(v) => toggleEdit('hours', v)} />
              <OwnerCard editing={editing.owner} setEditing={(v) => toggleEdit('owner', v)} />
              <ManagerCard editing={editing.manager} setEditing={(v) => toggleEdit('manager', v)} />
            </div>
          </div>
        </StepShell>
      </form>
    </FormProvider>
  );
}

/* -------------------------------------------------------------------------
 * Prefill merge
 * ----------------------------------------------------------------------- */

function mergePrefill(current: Step1Values, ctx: OnboardingContext): Step1Values | null {
  const account = ctx.prefill?.account ?? null;
  const contact = ctx.prefill?.contact ?? null;
  const acctName = account?.Name ?? ctx.token.account_name ?? '';

  const next: Step1Values = {
    ...current,
    legalName: current.legalName || acctName,
    storefrontName: current.storefrontName || acctName,
    street: current.street || (account?.BillingStreet ?? ''),
    city: current.city || (account?.BillingCity ?? ''),
    state: (current.state || normalizeState(account?.BillingState)) as Step1Values['state'],
    zip: current.zip || (account?.BillingPostalCode ?? ''),
    primaryContact: {
      name: current.primaryContact.name || joinName(contact?.FirstName, contact?.LastName),
      email: current.primaryContact.email || (contact?.Email ?? ctx.token.recipient_email ?? ''),
      phone: current.primaryContact.phone ||
        (contact?.MobilePhone ?? contact?.Phone ?? account?.Phone ?? ''),
    },
  };
  // Cheap shallow change check
  const changed =
    next.legalName !== current.legalName ||
    next.storefrontName !== current.storefrontName ||
    next.street !== current.street ||
    next.city !== current.city ||
    next.state !== current.state ||
    next.zip !== current.zip ||
    next.primaryContact.name !== current.primaryContact.name ||
    next.primaryContact.email !== current.primaryContact.email ||
    next.primaryContact.phone !== current.primaryContact.phone;
  return changed ? next : null;
}

function joinName(first: string | null | undefined, last: string | null | undefined) {
  return [first, last].filter(Boolean).join(' ').trim();
}

function normalizeState(raw: string | null | undefined): string {
  if (!raw) return 'PA';
  const upper = raw.trim().toUpperCase();
  // SF can return either abbreviation or full name. Cover the common cases.
  const fullToAbbr: Record<string, string> = {
    PENNSYLVANIA: 'PA', 'NEW JERSEY': 'NJ', DELAWARE: 'DE', 'NEW YORK': 'NY',
    MARYLAND: 'MD', VIRGINIA: 'VA', OHIO: 'OH',
  };
  if (US_STATES.includes(upper as typeof US_STATES[number])) return upper;
  if (fullToAbbr[upper]) return fullToAbbr[upper];
  return 'PA';
}

/* -------------------------------------------------------------------------
 * Card primitives
 * ----------------------------------------------------------------------- */

function ReviewCard({
  id,
  icon,
  title,
  badge,
  badgeVariant = 'on-file',
  editLabel,
  editing,
  setEditing,
  span2 = false,
  view,
  edit,
  onSave,
}: {
  id: string;
  icon: React.ReactNode;
  title: string;
  badge: string;
  badgeVariant?: 'on-file' | 'warn' | 'optional';
  editLabel?: string;
  editing: boolean;
  setEditing: (v: boolean) => void;
  span2?: boolean;
  view: React.ReactNode;
  edit: React.ReactNode;
  onSave?: () => void;
}) {
  const badgeClass =
    badgeVariant === 'warn' ? 'review-card__badge review-card__badge--warn' :
    badgeVariant === 'optional' ? 'review-card__badge review-card__badge--neutral' :
    'review-card__badge';
  return (
    <section className={`review-card${editing ? ' editing' : ''}${span2 ? ' span-2' : ''}`} id={id}>
      <header className="review-card__head">
        <div className="review-card__icon">{icon}</div>
        <h2 className="review-card__title">{title}</h2>
        <span className={badgeClass}>{badge}</span>
        {!editing && (
          <button type="button" className="review-card__edit-btn" onClick={() => setEditing(true)}>
            {editLabel === 'Add' ? (
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M12 5v14M5 12h14" /></svg>
            ) : (
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M12 20h9M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4 12.5-12.5z" /></svg>
            )}
            {editLabel ?? 'Edit'}
          </button>
        )}
      </header>
      <div className="review-card__body">
        {!editing && view}
        {editing && (
          <>
            {edit}
            <div className="review-form-actions">
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => { onSave?.(); setEditing(false); }}
              >
                Save changes
              </button>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => setEditing(false)}
              >
                Cancel
              </button>
            </div>
          </>
        )}
      </div>
    </section>
  );
}

/* -------------------------------------------------------------------------
 * Business card
 * ----------------------------------------------------------------------- */

function BusinessCard(props: { editing: boolean; setEditing: (v: boolean) => void }) {
  const { register, watch } = useFormContext<Step1Values>();
  const legal = watch('legalName');
  const dba = watch('storefrontName');
  return (
    <ReviewCard
      id="card-business"
      icon={<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M3 21h18M5 21V7l7-4 7 4v14M9 9h.01M9 13h.01M9 17h.01M15 9h.01M15 13h.01M15 17h.01" /></svg>}
      title="Business"
      badge="On file"
      editing={props.editing}
      setEditing={props.setEditing}
      view={
        <dl className="kv">
          <dt>Legal entity</dt><dd>{legal || <span className="muted">—</span>}</dd>
          <dt>DBA / storefront</dt><dd>{dba || <span className="muted">—</span>}</dd>
        </dl>
      }
      edit={
        <div className="review-form-grid">
          <div className="field full">
            <label className="field-label">Legal entity</label>
            <input type="text" {...register('legalName')} />
          </div>
          <div className="field full">
            <label className="field-label">DBA / storefront</label>
            <input type="text" {...register('storefrontName')} />
          </div>
        </div>
      }
    />
  );
}

/* -------------------------------------------------------------------------
 * Address card
 * ----------------------------------------------------------------------- */

function AddressCard(props: { editing: boolean; setEditing: (v: boolean) => void }) {
  const { register, watch } = useFormContext<Step1Values>();
  const street = watch('street');
  const suite = watch('suite');
  const city = watch('city');
  const state = watch('state');
  const zip = watch('zip');
  return (
    <ReviewCard
      id="card-address"
      icon={<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" /><circle cx="12" cy="10" r="3" /></svg>}
      title="Address"
      badge="On file"
      editing={props.editing}
      setEditing={props.setEditing}
      view={
        <dl className="kv">
          <dt>Street</dt>
          <dd>{[street, suite].filter(Boolean).join(', ') || <span className="muted">—</span>}</dd>
          <dt>City, State</dt>
          <dd>{city || state ? `${city || ''}${city && state ? ', ' : ''}${state || ''}` : <span className="muted">—</span>}</dd>
          <dt>ZIP</dt>
          <dd>{zip || <span className="muted">—</span>}</dd>
        </dl>
      }
      edit={
        <div className="review-form-grid">
          <div className="field full">
            <label className="field-label">Street</label>
            <input type="text" {...register('street')} autoComplete="address-line1" />
          </div>
          <div className="field full">
            <label className="field-label">Suite / unit (optional)</label>
            <input type="text" {...register('suite')} autoComplete="address-line2" />
          </div>
          <div className="field">
            <label className="field-label">City</label>
            <input type="text" {...register('city')} autoComplete="address-level2" />
          </div>
          <div className="field">
            <label className="field-label">State</label>
            <select {...register('state')}>
              {US_STATES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          <div className="field">
            <label className="field-label">ZIP</label>
            <input type="text" {...register('zip')} inputMode="numeric" maxLength={10} autoComplete="postal-code" />
          </div>
        </div>
      }
    />
  );
}

/* -------------------------------------------------------------------------
 * Hours card (spans 2 columns)
 * ----------------------------------------------------------------------- */

function HoursCard(props: { editing: boolean; setEditing: (v: boolean) => void }) {
  const { control, watch, setValue, register } = useFormContext<Step1Values>();
  const hours = watch('hours');

  const summary = useMemo(() => buildHoursSummary(hours), [hours]);

  const applyQuickSet = (preset: 'late' | 'long' | 'twentyfour' | 'closed-sun' | 'standard') => {
    const set = (k: DayKey, closed: boolean, open: string, close: string) => {
      setValue(`hours.${k}.closed`, closed, { shouldDirty: true });
      setValue(`hours.${k}.open`, open, { shouldDirty: true });
      setValue(`hours.${k}.close`, close, { shouldDirty: true });
    };
    if (preset === 'late') DAYS.forEach((d) => set(d, false, '05:00', '23:00'));
    else if (preset === 'long') DAYS.forEach((d) => set(d, false, '06:00', '23:59'));
    else if (preset === 'twentyfour') DAYS.forEach((d) => set(d, false, '00:00', '23:59'));
    else if (preset === 'closed-sun') {
      (['mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as DayKey[]).forEach((d) => set(d, false, '10:00', '18:00'));
      set('sun', true, '', '');
    } else if (preset === 'standard') {
      DAYS.forEach((d) => set(d, false, '10:00', '18:00'));
    }
  };

  return (
    <ReviewCard
      id="card-hours"
      span2
      icon={<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><circle cx="12" cy="12" r="10" /><path d="M12 6v6l4 2" /></svg>}
      title="Operating hours"
      badge="Default · please verify"
      badgeVariant="warn"
      editing={props.editing}
      setEditing={props.setEditing}
      view={
        <>
          <div className="hours-summary">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden><path d="M5 12l5 5L20 7" /></svg>
            <span><strong>{summary.headline}</strong></span>
            {summary.suffix && <span className="hours-summary__suffix">{summary.suffix}</span>}
          </div>
          <div className="hours-table">
            {DAYS.map((d) => (
              <span key={`${d}-row`} style={{ display: 'contents' }}>
                <span className="day">{DAY_LABEL[d]}</span>
                <span className="time">{formatHoursRow(hours[d])}</span>
              </span>
            ))}
          </div>
        </>
      }
      edit={
        <>
          <div className="quick-set">
            <span className="quick-set__label">Quick set:</span>
            <button type="button" className="chip" onClick={() => applyQuickSet('standard')}>10am–6pm daily</button>
            <button type="button" className="chip" onClick={() => applyQuickSet('late')}>5am–11pm daily</button>
            <button type="button" className="chip" onClick={() => applyQuickSet('long')}>6am–midnight daily</button>
            <button type="button" className="chip" onClick={() => applyQuickSet('twentyfour')}>24/7</button>
            <button type="button" className="chip" onClick={() => applyQuickSet('closed-sun')}>Closed Sundays</button>
          </div>
          <div className="hours-edit">
            {DAYS.map((d) => {
              const closed = !!hours[d]?.closed;
              return (
                <span key={d} style={{ display: 'contents' }}>
                  <span className="hours-edit__day">{DAY_LABEL[d]}</span>
                  <input type="time" disabled={closed} {...register(`hours.${d}.open`)} />
                  <input type="time" disabled={closed} {...register(`hours.${d}.close`)} />
                  <span>
                    <Controller
                      name={`hours.${d}.closed`}
                      control={control}
                      render={({ field }) => (
                        <input
                          id={`closed-${d}`}
                          type="checkbox"
                          checked={!!field.value}
                          onChange={(e) => field.onChange(e.target.checked)}
                        />
                      )}
                    />
                    <label htmlFor={`closed-${d}`} className="hours-edit__closed-label">Closed</label>
                  </span>
                </span>
              );
            })}
          </div>
        </>
      }
    />
  );
}

function formatHoursRow(d?: { closed: boolean; open: string; close: string }) {
  if (!d) return '—';
  if (d.closed) return 'Closed';
  if (!d.open || !d.close) return '—';
  return `${formatTime(d.open)} – ${formatTime(d.close)}`;
}

function formatTime(hhmm: string): string {
  const [hStr, mStr] = hhmm.split(':');
  let h = parseInt(hStr ?? '0', 10);
  const m = parseInt(mStr ?? '0', 10);
  if (Number.isNaN(h)) return hhmm;
  const am = h < 12;
  if (h === 0) h = 12;
  else if (h > 12) h -= 12;
  const mm = m.toString().padStart(2, '0');
  return `${h}:${mm} ${am ? 'AM' : 'PM'}`;
}

function buildHoursSummary(hours: Step1Values['hours']) {
  const open = DAYS.filter((d) => !hours[d]?.closed);
  if (open.length === 0) {
    return { headline: 'Closed all week', suffix: '' };
  }
  const sample = hours[open[0]];
  const allSame = open.every((d) => hours[d].open === sample.open && hours[d].close === sample.close);
  if (allSame && open.length === 7) {
    return {
      headline: `Open daily, ${formatTime(sample.open)} – ${formatTime(sample.close)}`,
      suffix: 'Same hours every day',
    };
  }
  if (allSame) {
    return {
      headline: `${formatTime(sample.open)} – ${formatTime(sample.close)}`,
      suffix: `${open.length} days/week`,
    };
  }
  return { headline: 'Custom hours', suffix: `${open.length} days/week` };
}

/* -------------------------------------------------------------------------
 * Owner / Primary contact card
 * ----------------------------------------------------------------------- */

function OwnerCard(props: { editing: boolean; setEditing: (v: boolean) => void }) {
  const { register, watch, formState: { errors } } = useFormContext<Step1Values>();
  const name = watch('primaryContact.name');
  const email = watch('primaryContact.email');
  const phone = watch('primaryContact.phone');
  const initials = (name || '').split(/\s+/).map((s) => s[0]).filter(Boolean).slice(0, 2).join('').toUpperCase() || '—';

  return (
    <ReviewCard
      id="card-owner"
      icon={<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" /></svg>}
      title="Owner / Primary contact"
      badge="On file"
      editing={props.editing}
      setEditing={props.setEditing}
      view={
        <>
          <div className="person">
            <div className="avatar">{initials}</div>
            <div>
              <div className="person__name">{name || <span className="muted">—</span>}</div>
              <div className="person__role">Owner</div>
            </div>
          </div>
          <div className="contact-lines">
            <div>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" /><path d="M22 6l-10 7L2 6" /></svg>
              {email || <span className="muted">no email on file</span>}
            </div>
            <div>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z" /></svg>
              {phone || <span className="muted">no phone on file</span>}
            </div>
          </div>
        </>
      }
      edit={
        <div className="review-form-grid">
          <div className="field full">
            <label className="field-label">Full name</label>
            <input type="text" {...register('primaryContact.name')} autoComplete="name" />
            {errors.primaryContact?.name && <span className="field-error">{errors.primaryContact.name.message}</span>}
          </div>
          <div className="field full">
            <label className="field-label">Email</label>
            <input type="email" {...register('primaryContact.email')} autoComplete="email" />
            {errors.primaryContact?.email && <span className="field-error">{errors.primaryContact.email.message}</span>}
          </div>
          <div className="field full">
            <label className="field-label">Mobile phone</label>
            <input type="tel" {...register('primaryContact.phone')} autoComplete="tel" placeholder="(215) 555-0123" />
            {errors.primaryContact?.phone && <span className="field-error">{errors.primaryContact.phone.message}</span>}
          </div>
        </div>
      }
    />
  );
}

/* -------------------------------------------------------------------------
 * Back-of-house manager card (optional)
 * ----------------------------------------------------------------------- */

function ManagerCard(props: { editing: boolean; setEditing: (v: boolean) => void }) {
  const { register, watch, formState: { errors } } = useFormContext<Step1Values>();
  const name = watch('bohManager.name');
  const email = watch('bohManager.email');
  const phone = watch('bohManager.phone');
  const hasAny = !!(name || email || phone);
  const initials = (name || '').split(/\s+/).map((s) => s[0]).filter(Boolean).slice(0, 2).join('').toUpperCase() || '—';

  return (
    <ReviewCard
      id="card-manager"
      icon={<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M22 11h-6M19 8v6" /></svg>}
      title="Back-of-house manager"
      badge="Optional"
      badgeVariant="optional"
      editLabel={hasAny ? 'Edit' : 'Add'}
      editing={props.editing}
      setEditing={props.setEditing}
      view={
        hasAny ? (
          <>
            <div className="person">
              <div className="avatar">{initials}</div>
              <div>
                <div className="person__name">{name}</div>
                <div className="person__role">BOH manager</div>
              </div>
            </div>
            <div className="contact-lines">
              {email && (
                <div>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" /><path d="M22 6l-10 7L2 6" /></svg>
                  {email}
                </div>
              )}
              {phone && (
                <div>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z" /></svg>
                  {phone}
                </div>
              )}
            </div>
          </>
        ) : (
          <div className="empty-state">
            No back-of-house manager on file.{' '}
            <strong>You can skip this and add it later</strong> — but listing the person who handles deposits
            day-to-day helps us reach the right contact for cash issues.
          </div>
        )
      }
      edit={
        <div className="review-form-grid">
          <div className="field full">
            <label className="field-label">Full name</label>
            <input type="text" {...register('bohManager.name')} placeholder="e.g. Courtney Smith" />
          </div>
          <div className="field full">
            <label className="field-label">Email</label>
            <input type="email" {...register('bohManager.email')} placeholder="manager@example.com" />
            {errors.bohManager?.email && <span className="field-error">{errors.bohManager.email.message}</span>}
          </div>
          <div className="field full">
            <label className="field-label">Mobile phone</label>
            <input type="tel" {...register('bohManager.phone')} placeholder="(215) 555-0000" />
          </div>
        </div>
      }
    />
  );
}
