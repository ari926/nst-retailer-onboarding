import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  Controller,
  FormProvider,
  useFieldArray,
  useForm,
  useFormContext,
} from 'react-hook-form';
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
  ADDITIONAL_CONTACT_ROLES,
  type AdditionalContactRole,
  type Step1Values,
} from './Step1Profile.schema';

/**
 * Step 1 — Confirm store profile (v3 review-card layout, 2026-07-21).
 *
 * Amanda Kristoff's rework:
 *   • Business card now carries Owner info (name/email/phone).
 *   • Old "Owner / Primary contact" card is now "Primary Contact".
 *     Because the Owner is usually ALSO the primary contact, this card
 *     auto-fills from Owner via a "Same as owner" toggle.
 *   • Operating hours surfaced as mandatory.
 *   • New "Additional contacts" card lets the retailer add optional
 *     Manager / Asst Mgr / GM / Staff people with role, name, email, phone.
 *
 * We keep the back-of-house Manager card as-is for backward-compat with
 * older drafts, but it lives below the new Additional Contacts card and
 * is labelled as optional/legacy.
 */

const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
type DayKey = typeof DAYS[number];
const DAY_LABEL: Record<DayKey, string> = {
  mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun',
};

const ROLE_LABEL: Record<AdditionalContactRole, string> = {
  manager: 'Manager',
  assistant_manager: 'Assistant Manager',
  general_manager: 'General Manager',
  staff: 'Staff',
};

type EditKey =
  | 'business'
  | 'address'
  | 'hours'
  | 'primary'
  | 'additional'
  | 'manager';

// Human-readable names for cards, used in the specific validation toast.
// Keep in sync with the ReviewCard `id` prop below (`card-<key>`).
const CARD_LABEL: Record<EditKey, string> = {
  // Card labels here are what appears in validation toasts. Keep aligned to
  // the on-screen card titles below.
  //
  // 2026-07-26 change set (Amanda + Doug):
  //   - "Business card" (formerly "Primary Contact") is now "Primary Onboarding Contact"
  //   - "Back-of-house manager" is now "Primary Site Contact"
  //   - Additional Contacts is now the last card in the review grid
  business: 'Business & Owner',
  address: 'Address',
  hours: 'Operating hours',
  primary: 'Primary Onboarding Contact',
  additional: 'Additional contacts',
  manager: 'Primary Site Contact',
};

// Map top-level RHF/Zod field paths to the card that owns them, so a failed
// submit can visibly highlight the offending card and name it in the toast.
function invalidCardsFromErrors(errors: Record<string, unknown>): Set<EditKey> {
  const set = new Set<EditKey>();
  if (!errors) return set;
  if (errors.legalName || errors.storefrontName || errors.owner) set.add('business');
  if (errors.street || errors.city || errors.state || errors.zip) set.add('address');
  if (errors.hours) set.add('hours');
  if (errors.primaryContact || errors.primaryContactSameAsOwner) set.add('primary');
  if (errors.additionalContacts) set.add('additional');
  if (errors.bohManager) set.add('manager');
  return set;
}

function buildInvalidToast(invalid: Set<EditKey>): string {
  const names = Array.from(invalid).map((k) => CARD_LABEL[k]);
  if (names.length === 0) return 'Please fix the highlighted fields before continuing.';
  if (names.length === 1) return `${names[0]} needs your attention before we can continue.`;
  const last = names.pop();
  return `Fix these sections before continuing: ${names.join(', ')} and ${last}.`;
}

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
    business: false, address: false, hours: false, primary: false, additional: false, manager: false,
  });
  // Cards flagged by the last failed submit. Cleared when a card is opened for
  // edit (user is fixing it) or when submit succeeds.
  const [invalidCards, setInvalidCards] = useState<Set<EditKey>>(new Set());

  const ctx = useOnboardingContext(token);

  // Provenance — what did SF actually return? Drives the per-card badge so
  // we don't lie to the user with a hardcoded "On file" badge over an empty
  // field.
  const provenance = useMemo(() => {
    const acct = ctx.data?.prefill?.account ?? null;
    const contact = ctx.data?.prefill?.contact ?? null;
    return {
      business: !!(acct?.Name),
      address: !!(acct?.BillingStreet || acct?.BillingCity || acct?.BillingPostalCode),
      primary: !!(contact?.Email || contact?.FirstName),
    };
  }, [ctx.data]);

  // "Pulled from Salesforce just now" timestamp displayed under the page
  // subtitle. Set once when ctx.data first arrives.
  const [pulledAt, setPulledAt] = useState<Date | null>(null);
  useEffect(() => {
    if (ctx.data && !pulledAt) setPulledAt(new Date());
  }, [ctx.data, pulledAt]);

  const methods = useForm<Step1Values>({
    resolver: zodResolver(step1Schema),
    defaultValues: step1Defaults,
    mode: 'onBlur',
    shouldUnregister: false, // keep field values when sub-editors unmount
  });
  const { handleSubmit, watch, reset, getValues, setValue } = methods;

  // "Primary Contact = Same as Owner" auto-fill.
  //
  // When the toggle is on, we mirror `owner` into `primaryContact` on every
  // change. This lets us keep BOTH blocks in the submitted payload (ops still
  // reads `primaryContact` for legacy Salesforce syncs) without asking the
  // retailer to type the same info twice.
  const sameAsOwner = watch('primaryContactSameAsOwner');
  const ownerName = watch('owner.name');
  const ownerEmail = watch('owner.email');
  const ownerPhone = watch('owner.phone');
  useEffect(() => {
    if (!sameAsOwner) return;
    setValue('primaryContact.name', ownerName ?? '', { shouldDirty: false });
    setValue('primaryContact.email', ownerEmail ?? '', { shouldDirty: false });
    setValue('primaryContact.phone', ownerPhone ?? '', { shouldDirty: false });
  }, [sameAsOwner, ownerName, ownerEmail, ownerPhone, setValue]);

  // Load draft once on mount.
  //
  // Older drafts (pre 2026-07-21) don't carry the new fields (`owner`,
  // `primaryContactSameAsOwner`, `additionalContacts`). If we blindly reset()
  // to that raw draft, RHF will treat those fields as `undefined` and the
  // "Same as owner" checkbox will render UNCHECKED even though the schema
  // defaults it to true. Detect that case and inherit the defaults for any
  // missing keys so returning drafts still land with the box checked.
  useEffect(() => {
    let mounted = true;
    (async () => {
      const draft = await loadDraft<Step1Values>(1);
      if (mounted && draft) {
        const backfilledOwner = draft.owner ?? {
          // Backfill Owner from the old Primary Contact if we have nothing
          // else — that's usually the same person.
          name: draft.primaryContact?.name ?? '',
          email: draft.primaryContact?.email ?? '',
          phone: draft.primaryContact?.phone ?? '',
        };

        // Self-heal rule: if the persisted `primaryContactSameAsOwner` flag is
        // false but the Owner and Primary Contact actually match, restore
        // the toggle to true. This recovers from earlier drafts where the
        // toggle was set to false during an intermediate build that didn't
        // default-check the box.
        const pc = draft.primaryContact ?? { name: '', email: '', phone: '' };
        const matches =
          !!backfilledOwner.name &&
          backfilledOwner.name === pc.name &&
          backfilledOwner.email === pc.email &&
          backfilledOwner.phone === pc.phone;

        const persistedFlag = draft.primaryContactSameAsOwner;
        const resolvedFlag =
          typeof persistedFlag === 'boolean'
            ? persistedFlag || matches // false + matching data → heal to true
            : true;

        const migrated: Step1Values = {
          ...step1Defaults,
          ...draft,
          owner: backfilledOwner,
          primaryContactSameAsOwner: resolvedFlag,
          additionalContacts: draft.additionalContacts ?? [],
        };
        reset(migrated);
      }
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

  // Autosave after 1.5s of no changes. See comment in previous version.
  useEffect(() => {
    if (!draftLoaded) return;
    let handle: ReturnType<typeof setTimeout> | null = null;
    const subscription = watch((values) => {
      if (handle) clearTimeout(handle);
      handle = setTimeout(() => {
        void saveDraft(1, values);
      }, 1500);
    });
    return () => {
      if (handle) clearTimeout(handle);
      subscription.unsubscribe();
    };
  }, [watch, draftLoaded]);

  const toggleEdit = (key: EditKey, on: boolean) => {
    setEditing((prev) => ({ ...prev, [key]: on }));
    if (on && invalidCards.has(key)) {
      setInvalidCards((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  };

  const onSubmit = async (values: Step1Values) => {
    setSubmitting(true);
    setInvalidCards(new Set());
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

  const onInvalid = (errors: Record<string, unknown>) => {
    console.warn('[step submit] validation errors', errors);
    const invalid = invalidCardsFromErrors(errors);
    setInvalidCards(invalid);
    toast.error(buildInvalidToast(invalid));
    const first = Array.from(invalid)[0];
    if (first) {
      requestAnimationFrame(() => {
        const el = document.getElementById(`card-${first}`);
        el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
    }
  };

  return (
    <FormProvider {...methods}>
      <form
        id="step-form"
        onSubmit={handleSubmit(onSubmit, onInvalid)}
        noValidate
      >
        <StepShell
          stepId={1}
          titleKey="step_1_profile.title"
          subtitleKey="step_1_profile.subtitle"
          submitting={submitting || ctx.loading || !draftLoaded}
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

            {pulledAt && !ctx.error && (
              <div className="review-pulled-at" aria-live="polite">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M21 12a9 9 0 1 1-3-6.7L21 8" /><path d="M21 3v5h-5" />
                </svg>
                <span>Pulled from Salesforce just now.</span>
              </div>
            )}

            {ctx.error && (
              <div className="review-banner review-banner--warn" role="alert">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" /><path d="M12 9v4M12 17h.01" />
                </svg>
                <span>
                  We couldn't refresh from Salesforce just now. The fields below show what we last had on file — please verify carefully before continuing.
                </span>
              </div>
            )}

            {/* 2026-07-26 card order (Amanda + Doug change set):
                1. Business & Owner (top-of-store info + owner)
                2. Address
                3. Operating days & hours (span-2)
                4. Primary Onboarding Contact  ─┐  side-by-side row
                5. Primary Site Contact        ─┘
                6. Additional Contacts (span-2, last) */}
            <div className="review-grid">
              <BusinessCard editing={editing.business} setEditing={(v) => toggleEdit('business', v)} onFile={provenance.business} invalid={invalidCards.has('business')} />
              <AddressCard editing={editing.address} setEditing={(v) => toggleEdit('address', v)} onFile={provenance.address} invalid={invalidCards.has('address')} />
              <HoursCard editing={editing.hours} setEditing={(v) => toggleEdit('hours', v)} invalid={invalidCards.has('hours')} />
              <PrimaryContactCard editing={editing.primary} setEditing={(v) => toggleEdit('primary', v)} onFile={provenance.primary} invalid={invalidCards.has('primary')} />
              <ManagerCard editing={editing.manager} setEditing={(v) => toggleEdit('manager', v)} invalid={invalidCards.has('manager')} />
              <AdditionalContactsCard editing={editing.additional} setEditing={(v) => toggleEdit('additional', v)} invalid={invalidCards.has('additional')} />
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

  const step1Confirmed = (ctx.onboarding?.current_step ?? 1) > 1;
  const sfState = account?.BillingState ? normalizeState(account.BillingState) : null;
  const resolvedState =
    !step1Confirmed && sfState ? sfState : current.state;

  // SF contact → owner (primary source). If Primary Contact already differs
  // from Owner (i.e. same-as-owner toggle was cleared), we don't overwrite it.
  const ownerName = current.owner.name || joinName(contact?.FirstName, contact?.LastName);
  const ownerEmail = current.owner.email || (contact?.Email ?? ctx.token.recipient_email ?? '');
  const ownerPhone = current.owner.phone ||
    (contact?.MobilePhone ?? contact?.Phone ?? account?.Phone ?? '');

  const next: Step1Values = {
    ...current,
    legalName: current.legalName || acctName,
    storefrontName: current.storefrontName || acctName,
    street: current.street || (account?.BillingStreet ?? ''),
    city: current.city || (account?.BillingCity ?? ''),
    state: resolvedState as Step1Values['state'],
    zip: current.zip || (account?.BillingPostalCode ?? ''),
    owner: { name: ownerName, email: ownerEmail, phone: ownerPhone },
    // primaryContact mirrors owner when the toggle is on. If the toggle was
    // toggled off in a prior draft, current.primaryContact.* will already
    // be populated and we keep it.
    primaryContact: current.primaryContactSameAsOwner
      ? { name: ownerName, email: ownerEmail, phone: ownerPhone }
      : {
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
    next.owner.name !== current.owner.name ||
    next.owner.email !== current.owner.email ||
    next.owner.phone !== current.owner.phone ||
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
  invalid = false,
  view,
  edit,
  onSave,
}: {
  id: string;
  icon: React.ReactNode;
  title: string;
  badge: string;
  badgeVariant?: 'on-file' | 'warn' | 'optional' | 'required';
  editLabel?: string;
  editing: boolean;
  setEditing: (v: boolean) => void;
  span2?: boolean;
  invalid?: boolean;
  view: React.ReactNode;
  edit: React.ReactNode;
  onSave?: () => void;
}) {
  const badgeClass =
    invalid ? 'review-card__badge review-card__badge--invalid' :
    badgeVariant === 'warn' ? 'review-card__badge review-card__badge--warn' :
    badgeVariant === 'required' ? 'review-card__badge review-card__badge--warn' :
    badgeVariant === 'optional' ? 'review-card__badge review-card__badge--neutral' :
    'review-card__badge';
  const displayBadge = invalid ? 'Needs your attention' : badge;
  return (
    <section
      className={`review-card${editing ? ' editing' : ''}${span2 ? ' span-2' : ''}${invalid ? ' invalid' : ''}`}
      id={id}
      aria-invalid={invalid || undefined}
    >
      <header className="review-card__head">
        <div className="review-card__icon">{icon}</div>
        <h2 className="review-card__title">{title}</h2>
        <span className={badgeClass}>{displayBadge}</span>
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
 * Business card — now owns Owner info (Amanda 2026-07-21)
 * ----------------------------------------------------------------------- */

function BusinessCard(props: { editing: boolean; setEditing: (v: boolean) => void; onFile: boolean; invalid?: boolean }) {
  const { register, watch, formState: { errors } } = useFormContext<Step1Values>();
  const legal = watch('legalName');
  const dba = watch('storefrontName');
  const owner = watch('owner');
  const ownerInitials = (owner?.name || '').split(/\s+/).map((s) => s[0]).filter(Boolean).slice(0, 2).join('').toUpperCase() || '—';
  return (
    <ReviewCard
      id="card-business"
      icon={<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M3 21h18M5 21V7l7-4 7 4v14M9 9h.01M9 13h.01M9 17h.01M15 9h.01M15 13h.01M15 17h.01" /></svg>}
      title="Business & Owner"
      badge={props.onFile ? 'On file' : 'Add details'}
      badgeVariant={props.onFile ? 'on-file' : 'optional'}
      editing={props.editing}
      setEditing={props.setEditing}
      invalid={props.invalid}
      view={
        <>
          <dl className="kv">
            <dt>Legal entity</dt><dd>{legal || <span className="muted">—</span>}</dd>
            <dt>DBA / storefront</dt><dd>{dba || <span className="muted">—</span>}</dd>
          </dl>
          <div style={{ height: 12 }} />
          <div className="person">
            <div className="avatar">{ownerInitials}</div>
            <div>
              <div className="person__name">{owner?.name || <span className="muted">—</span>}</div>
              <div className="person__role">Owner</div>
            </div>
          </div>
          <div className="contact-lines">
            <div>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" /><path d="M22 6l-10 7L2 6" /></svg>
              {owner?.email || <span className="muted">no owner email on file</span>}
            </div>
            <div>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z" /></svg>
              {owner?.phone || <span className="muted">no owner phone on file</span>}
            </div>
          </div>
        </>
      }
      edit={
        <div className="review-form-grid">
          <div className="field full">
            <label className="field-label">Legal entity</label>
            <input type="text" {...register('legalName')} />
            {errors.legalName && <span className="field-error">{errors.legalName.message as string}</span>}
          </div>
          <div className="field full">
            <label className="field-label">DBA / storefront</label>
            <input type="text" {...register('storefrontName')} />
            {errors.storefrontName && <span className="field-error">{errors.storefrontName.message as string}</span>}
          </div>
          <div className="field full">
            <label className="field-label" style={{ marginTop: 8 }}>
              Owner name <span className="required-star" aria-hidden>*</span>
            </label>
            <input type="text" {...register('owner.name')} autoComplete="name" placeholder="Legal owner of the store" />
            {errors.owner?.name && <span className="field-error">{errors.owner.name.message as string}</span>}
          </div>
          <div className="field full">
            <label className="field-label">
              Owner email <span className="required-star" aria-hidden>*</span>
            </label>
            <input type="email" {...register('owner.email')} autoComplete="email" placeholder="owner@example.com" />
            {errors.owner?.email && <span className="field-error">{errors.owner.email.message as string}</span>}
          </div>
          <div className="field full">
            <label className="field-label">
              Owner mobile phone <span className="required-star" aria-hidden>*</span>
            </label>
            <input type="tel" {...register('owner.phone')} autoComplete="tel" placeholder="(215) 555-0123" />
            {errors.owner?.phone && <span className="field-error">{errors.owner.phone.message as string}</span>}
          </div>
        </div>
      }
    />
  );
}

/* -------------------------------------------------------------------------
 * Address card
 * ----------------------------------------------------------------------- */

function AddressCard(props: { editing: boolean; setEditing: (v: boolean) => void; onFile: boolean; invalid?: boolean }) {
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
      badge={props.onFile ? 'On file' : 'Add details'}
      badgeVariant={props.onFile ? 'on-file' : 'optional'}
      editing={props.editing}
      setEditing={props.setEditing}
      invalid={props.invalid}
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
 * Hours card (spans 2 columns) — now labelled Required per Amanda
 * ----------------------------------------------------------------------- */

function HoursCard(props: { editing: boolean; setEditing: (v: boolean) => void; invalid?: boolean }) {
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
      title="Operating days & hours"
      badge="Required · please verify"
      badgeVariant="required"
      editing={props.editing}
      setEditing={props.setEditing}
      invalid={props.invalid}
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
 * Primary Contact card
 * ----------------------------------------------------------------------- */

function PrimaryContactCard(props: { editing: boolean; setEditing: (v: boolean) => void; onFile: boolean; invalid?: boolean }) {
  const { register, watch, setValue, formState: { errors } } = useFormContext<Step1Values>();
  const name = watch('primaryContact.name');
  const email = watch('primaryContact.email');
  const phone = watch('primaryContact.phone');
  const sameAsOwner = watch('primaryContactSameAsOwner');
  const initials = (name || '').split(/\s+/).map((s) => s[0]).filter(Boolean).slice(0, 2).join('').toUpperCase() || '—';

  return (
    <ReviewCard
      id="card-primary"
      icon={<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" /></svg>}
      title="Primary Onboarding Contact"
      badge={sameAsOwner ? 'Same as owner' : (props.onFile ? 'On file' : 'Add details')}
      badgeVariant={sameAsOwner ? 'on-file' : (props.onFile ? 'on-file' : 'optional')}
      editing={props.editing}
      setEditing={props.setEditing}
      invalid={props.invalid}
      view={
        <>
          <div className="person">
            <div className="avatar">{initials}</div>
            <div>
              <div className="person__name">{name || <span className="muted">—</span>}</div>
              <div className="person__role">Primary Onboarding Contact</div>
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
        <>
          <label className="toggle-row" style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
            <input
              type="checkbox"
              checked={!!sameAsOwner}
              onChange={(e) => setValue('primaryContactSameAsOwner', e.target.checked, { shouldDirty: true })}
            />
            <span>Same as owner (auto-fills from the Owner listed above)</span>
          </label>
          <div className="review-form-grid">
            <div className="field full">
              <label className="field-label">Full name</label>
              <input
                type="text"
                {...register('primaryContact.name')}
                autoComplete="name"
                disabled={!!sameAsOwner}
              />
              {errors.primaryContact?.name && <span className="field-error">{errors.primaryContact.name.message as string}</span>}
            </div>
            <div className="field full">
              <label className="field-label">Email</label>
              <input
                type="email"
                {...register('primaryContact.email')}
                autoComplete="email"
                disabled={!!sameAsOwner}
              />
              {errors.primaryContact?.email && <span className="field-error">{errors.primaryContact.email.message as string}</span>}
            </div>
            <div className="field full">
              <label className="field-label">Mobile phone</label>
              <input
                type="tel"
                {...register('primaryContact.phone')}
                autoComplete="tel"
                placeholder="(215) 555-0123"
                disabled={!!sameAsOwner}
              />
              {errors.primaryContact?.phone && <span className="field-error">{errors.primaryContact.phone.message as string}</span>}
            </div>
          </div>
        </>
      }
    />
  );
}

/* -------------------------------------------------------------------------
 * Additional Contacts card (NEW 2026-07-21 per Amanda)
 * Manager / Assistant Manager / General Manager / Staff — all optional.
 * ----------------------------------------------------------------------- */

function AdditionalContactsCard(props: { editing: boolean; setEditing: (v: boolean) => void; invalid?: boolean }) {
  const { register, control, watch, formState: { errors } } = useFormContext<Step1Values>();
  const { fields, append, remove } = useFieldArray({ control, name: 'additionalContacts' });
  const contacts = watch('additionalContacts') ?? [];
  const hasAny = contacts.length > 0;

  return (
    <ReviewCard
      id="card-additional"
      span2
      icon={<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" /></svg>}
      title="Additional contacts"
      badge="Optional"
      badgeVariant="optional"
      editLabel={hasAny ? 'Edit' : 'Add'}
      editing={props.editing}
      setEditing={props.setEditing}
      invalid={props.invalid}
      view={
        hasAny ? (
          <div style={{ display: 'grid', gap: 12 }}>
            {contacts.map((c, i) => {
              const initials = (c.name || '').split(/\s+/).map((s) => s[0]).filter(Boolean).slice(0, 2).join('').toUpperCase() || '—';
              return (
                <div key={i} className="person" style={{ alignItems: 'center' }}>
                  <div className="avatar">{initials}</div>
                  <div style={{ flex: 1 }}>
                    <div className="person__name">{c.name || <span className="muted">—</span>}</div>
                    <div className="person__role">{ROLE_LABEL[c.role as AdditionalContactRole] ?? '—'}</div>
                    <div className="contact-lines" style={{ marginTop: 4 }}>
                      {c.email && <div>{c.email}</div>}
                      {c.phone && <div>{c.phone}</div>}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="empty-state">
            No additional contacts yet.{' '}
            <strong>Optional</strong> — add a Manager, Assistant Manager, General Manager, or other staff we should be able to reach.
          </div>
        )
      }
      edit={
        <div style={{ display: 'grid', gap: 12 }}>
          {fields.map((f, i) => (
            <div key={f.id} className="review-form-grid" style={{ border: '1px solid var(--border, #e5e7eb)', borderRadius: 8, padding: 12 }}>
              <div className="field">
                <label className="field-label">Role</label>
                <select {...register(`additionalContacts.${i}.role` as const)}>
                  <option value="">Select role…</option>
                  {ADDITIONAL_CONTACT_ROLES.map((r) => (
                    <option key={r} value={r}>{ROLE_LABEL[r]}</option>
                  ))}
                </select>
                {errors.additionalContacts?.[i]?.role && (
                  <span className="field-error">{errors.additionalContacts[i]?.role?.message as string}</span>
                )}
              </div>
              <div className="field">
                <label className="field-label">Full name</label>
                <input type="text" {...register(`additionalContacts.${i}.name` as const)} />
                {errors.additionalContacts?.[i]?.name && (
                  <span className="field-error">{errors.additionalContacts[i]?.name?.message as string}</span>
                )}
              </div>
              <div className="field">
                <label className="field-label">Email (optional)</label>
                <input type="email" {...register(`additionalContacts.${i}.email` as const)} />
                {errors.additionalContacts?.[i]?.email && (
                  <span className="field-error">{errors.additionalContacts[i]?.email?.message as string}</span>
                )}
              </div>
              <div className="field">
                <label className="field-label">Mobile phone (optional)</label>
                <input type="tel" {...register(`additionalContacts.${i}.phone` as const)} placeholder="(215) 555-0000" />
              </div>
              <div className="field full" style={{ textAlign: 'right' }}>
                <button type="button" className="btn btn-ghost" onClick={() => remove(i)}>Remove</button>
              </div>
            </div>
          ))}
          <div>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => append({ name: '', role: 'manager' as AdditionalContactRole, email: '', phone: '' })}
            >
              + Add contact
            </button>
          </div>
        </div>
      }
    />
  );
}

/* -------------------------------------------------------------------------
 * Back-of-house manager card (legacy, optional)
 * ----------------------------------------------------------------------- */

function ManagerCard(props: { editing: boolean; setEditing: (v: boolean) => void; invalid?: boolean }) {
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
      title="Primary Site Contact"
      badge="Optional"
      badgeVariant="optional"
      editLabel={hasAny ? 'Edit' : 'Add'}
      editing={props.editing}
      setEditing={props.setEditing}
      invalid={props.invalid}
      view={
        hasAny ? (
          <>
            <div className="person">
              <div className="avatar">{initials}</div>
              <div>
                <div className="person__name">{name}</div>
                <div className="person__role">Primary Site Contact</div>
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
            No primary site contact on file.{' '}
            <strong>You can skip this and add it later</strong> — but listing the person on-site who handles
            deposits day-to-day helps us reach the right contact for cash issues.
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
            <input type="email" {...register('bohManager.email')} placeholder="site.contact@example.com" />
            {errors.bohManager?.email && <span className="field-error">{errors.bohManager.email.message as string}</span>}
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
