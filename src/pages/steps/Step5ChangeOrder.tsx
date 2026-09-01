import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { FormProvider, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { PackageOpen, Search, ClipboardList, ShoppingCart } from 'lucide-react';

import { StepShell } from '../../components/ui/StepShell';
import { useOnboardingStore } from '../../stores/onboardingStore';
import { loadDraft, saveDraft, submitStep } from '../../lib/stepService';
import {
  step5Schema,
  step5Defaults,
  CHANGE_ORDER_DENOMS,
  SAMPLE_CUTOFF_TIME,
  nextArrivalDates,
  formatArrivalLabel,
  sumChangeOrderUsd,
  type Step5Values,
  type ChangeOrderDenomKey,
} from './Step5ChangeOrder.schema';

/**
 * Step 5 — Sample change order (Cash Services layout).
 *
 * 2026-08-26 (Amanda screenshot 5 + 3): mirror the real production Cash
 * Services "Create change order" screen more closely.
 *   - Header: Customer id / Name / Location in one row (top). Cutoff time and
 *     Arrival date centered below.
 *   - Body: LEFT column shows "Click name below to select product" hint and a
 *     small vertical Total USD summary panel (Currency / Coin / Total).
 *   - Body: RIGHT column shows a compact denomination table with columns
 *     Currency, Amount ($), Multiple of. NO Subtotal column. NO coin rows
 *     (production Cash Services form only accepts $1/$5/$10/$20/$50/$100).
 *   - Footer: Confirm (blue) + Cancel (text link).
 *   - Confirm click opens the "Please confirm that you would like to place an
 *     order..." modal with Yes/No. Only Yes submits.
 */

interface HeaderInfo {
  customerId: string;
  name: string;
  location: string;
}

// Denominations shown in the change-order form. Coin rows are intentionally
// excluded to match the real production Cash Services form (Amanda 2026-08-26).
const CHANGE_ORDER_CURRENCY_DENOMS = CHANGE_ORDER_DENOMS.filter(
  (d) => !['quarters', 'dimes', 'nickels'].includes(d.key),
);

function SimulationBanner({ customer }: { customer: string }) {
  return (
    <div className="sim-banner" role="status" aria-live="polite">
      <div className="sim-banner__body">
        <span className="sim-banner__badge">TEST MODE</span>
        <span className="sim-banner__text">
          Simulating login as: <strong>{customer || 'Sample Retailer'}</strong>
        </span>
      </div>
      <span className="sim-banner__hint">
        Sample account delivers Wednesday · cutoff Monday {SAMPLE_CUTOFF_TIME}.
      </span>
    </div>
  );
}

/**
 * Format a cutoff timestamp like the reference screenshot:
 *   "Aug 31, 2026 01:00 PM CDT"
 * We pick the Monday-of-week that gates the currently-selected arrival date.
 */
function formatCutoffTimestamp(arrivalIso: string): string {
  if (!arrivalIso) return '—';
  const [y, m, d] = arrivalIso.split('-').map(Number);
  const arrival = new Date(y, m - 1, d);
  // Monday of the same week (arrival is a Wed, so back up 2 days).
  const monday = new Date(arrival);
  monday.setDate(arrival.getDate() - 2);
  monday.setHours(13, 0, 0, 0);
  const datePart = monday.toLocaleDateString('en-US', {
    month: 'short', day: '2-digit', year: 'numeric',
  });
  const timePart = monday.toLocaleTimeString('en-US', {
    hour: '2-digit', minute: '2-digit', hour12: true, timeZoneName: 'short',
  });
  return `${datePart} ${timePart}`;
}

function HeaderBar({
  info,
  arrivalOptions,
  arrivalDate,
  onArrivalChange,
  arrivalError,
}: {
  info: HeaderInfo;
  arrivalOptions: string[];
  arrivalDate: string;
  onArrivalChange: (v: string) => void;
  arrivalError?: string;
}) {
  return (
    <div className="co-header">
      <div className="co-header__ids">
        <div className="co-header__cell">
          <span className="co-header__label">Customer id</span>
          <input className="input co-header__input mono" value={info.customerId || ''} readOnly />
        </div>
        <div className="co-header__cell">
          <span className="co-header__label">Name</span>
          <input className="input co-header__input" value={info.name || ''} readOnly />
        </div>
        <div className="co-header__cell">
          <span className="co-header__label">Location</span>
          <input className="input co-header__input" value={info.location || ''} readOnly />
        </div>
      </div>
      <div className="co-header__cutoff">
        <span className="co-header__label">Cutoff time</span>
        <input className="input co-header__input" value={formatCutoffTimestamp(arrivalDate)} readOnly />
      </div>
      <div className="co-header__arrival">
        <label htmlFor="arrivalDate" className="co-header__label">
          Arrival date <span className="co-header__req">•</span>
        </label>
        <select
          id="arrivalDate"
          className="input co-header__input"
          value={arrivalDate}
          onChange={(e) => onArrivalChange(e.target.value)}
        >
          <option value="">Select arrival</option>
          {arrivalOptions.map((iso) => (
            <option key={iso} value={iso}>{formatArrivalLabel(iso)}</option>
          ))}
        </select>
        {arrivalError && <span className="field-error">{arrivalError}</span>}
      </div>
    </div>
  );
}

function ConfirmModal({
  open,
  amount,
  arrivalIso,
  onYes,
  onNo,
  submitting,
}: {
  open: boolean;
  amount: number;
  arrivalIso: string;
  onYes: () => void;
  onNo: () => void;
  submitting: boolean;
}) {
  if (!open) return null;
  const amountFmt = `$${amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const arrival = arrivalIso ? formatArrivalLabel(arrivalIso) : '';
  return (
    <div className="co-modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="co-modal-title">
      <div className="co-modal">
        <p id="co-modal-title" className="co-modal__body">
          Please confirm that you would like to place an order for <strong>{amountFmt}</strong> to arrive on{' '}
          <strong>{arrival}</strong>. The order total is <strong>{amountFmt}</strong>.
        </p>
        <div className="co-modal__actions">
          <button type="button" className="btn btn-primary" onClick={onYes} disabled={submitting}>
            {submitting ? <span className="spinner" aria-hidden /> : 'Yes'}
          </button>
          <button type="button" className="btn btn-secondary" onClick={onNo} disabled={submitting}>
            No
          </button>
        </div>
      </div>
    </div>
  );
}

export default function Step5ChangeOrder() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const storefrontName = useOnboardingStore((s) => s.storefrontName);
  const sfdcAccountId = useOnboardingStore((s) => s.sfdcAccountId);
  const markStepCompleted = useOnboardingStore((s) => s.markStepCompleted);
  const setCurrentStep = useOnboardingStore((s) => s.setCurrentStep);

  const [submitting, setSubmitting] = useState(false);
  const [draftLoaded, setDraftLoaded] = useState(false);
  // 2026-08-26 (Amanda screenshot 3): production form asks "Please confirm..."
  // before actually submitting the change order.
  const [confirmOpen, setConfirmOpen] = useState(false);
  // Which product row is active in the left summary panel. Matches the ref
  // screenshot where clicking "Currency" highlights the currency section.
  const [activeProduct, setActiveProduct] = useState<'currency' | 'coin'>('currency');
  void activeProduct; // kept for future use; coin section is disabled in the ref

  const arrivalOptions = useMemo(() => nextArrivalDates(new Date(), 3), []);

  const [headerInfo, setHeaderInfo] = useState<HeaderInfo>(() => ({
    customerId: sfdcAccountId ? sfdcAccountId.slice(-6).toUpperCase() : '',
    name: storefrontName || 'Sample Retailer',
    location: storefrontName || '',
  }));

  const methods = useForm<Step5Values>({
    resolver: zodResolver(step5Schema),
    defaultValues: { ...step5Defaults, arrivalDate: arrivalOptions[0] ?? '' },
    mode: 'onBlur',
    shouldUnregister: false,
  });

  const { register, handleSubmit, watch, reset, setValue, formState: { errors } } = methods;

  useEffect(() => {
    let mounted = true;
    (async () => {
      const draft = await loadDraft<Step5Values & Record<string, unknown>>(5);
      if (mounted && draft) {
        const draftAsValues = draft as Step5Values;
        const migrated: Step5Values = {
          ...step5Defaults,
          ...draftAsValues,
          arrivalDate: draftAsValues.arrivalDate || arrivalOptions[0] || '',
        };

        // Legacy migration: old drafts used { deliveryDate, rolls{..}, bills{..} }.
        const legacy = draft as unknown as {
          deliveryDate?: string;
          rolls?: Partial<Record<'quarters'|'dimes'|'nickels'|'pennies', number>>;
          bills?: Partial<Record<'singles'|'fives'|'tens'|'twenties', number>>;
        };
        if (legacy && (legacy.deliveryDate || legacy.rolls || legacy.bills) && !('units' in draft)) {
          const b = legacy.bills || {};
          migrated.units = {
            ones: Number(b.singles) || 0,
            fives: Number(b.fives) || 0,
            tens: Number(b.tens) || 0,
            twenties: Number(b.twenties) || 0,
            fifties: 0,
            hundreds: 0,
            // Coin rolls don't cleanly map to Amanda's unit rules — leave at 0.
            quarters: 0,
            dimes: 0,
            nickels: 0,
          };
        }

        reset(migrated);
      }
      setDraftLoaded(true);
    })();
    return () => { mounted = false; };
  }, [reset, arrivalOptions]);

  useEffect(() => {
    (async () => {
      const s1 = await loadDraft<{ businessName?: string }>(1);
      setHeaderInfo((prev) => ({
        ...prev,
        name: s1?.businessName || prev.name,
        location: s1?.businessName || prev.location,
      }));
    })();
  }, []);

  useEffect(() => {
    if (!draftLoaded) return;
    let handle: ReturnType<typeof setTimeout> | null = null;
    const subscription = watch((values) => {
      if (handle) clearTimeout(handle);
      handle = setTimeout(() => {
        void saveDraft(5, values);
      }, 1500);
    });
    return () => {
      if (handle) clearTimeout(handle);
      subscription.unsubscribe();
    };
  }, [watch, draftLoaded]);

  // Watch each denom individually (RHF mutates nested objects in place and
  // watch('units') returns a stable reference across renders).
  const ones = Number(watch('units.ones')) || 0;
  const fives = Number(watch('units.fives')) || 0;
  const tens = Number(watch('units.tens')) || 0;
  const twenties = Number(watch('units.twenties')) || 0;
  const fifties = Number(watch('units.fifties')) || 0;
  const hundreds = Number(watch('units.hundreds')) || 0;
  const quarters = Number(watch('units.quarters')) || 0;
  const dimes = Number(watch('units.dimes')) || 0;
  const nickels = Number(watch('units.nickels')) || 0;
  const arrivalDate = watch('arrivalDate');
  // Force coin to 0 in the totals — the UI intentionally only collects
  // currency denominations, but old drafts / demo seed may set coin fields.
  // 2026-09-01 (Amanda): the 'Units' input is a COUNT of straps/bills for
  // that denomination — e.g. entering "1" on the $100 row means one $100
  // strap. The grand total multiplies each row's count by its denomination
  // value (the 'Multiple of' column) and sums across currency rows. This
  // matches the Deposit step's Count × Value model and fixes totals that
  // previously summed raw entered numbers instead of dollar values.
  void quarters; void dimes; void nickels;
  const totals = sumChangeOrderUsd({
    ones, fives, tens, twenties, fifties, hundreds,
    quarters: 0, dimes: 0, nickels: 0,
  });

  const onSubmit = async (values: Step5Values) => {
    setSubmitting(true);
    try {
      await submitStep(5, values);
      markStepCompleted(5);
      setCurrentStep(6);
      toast.success(t('step_5_change_order.success', 'Sample change order confirmed.'));
      navigate('/onboarding/invoicing');
    } catch (err) {
      const msg = err instanceof Error ? err.message : t('global.errors.generic');
      toast.error(msg);
    } finally {
      setSubmitting(false);
      setConfirmOpen(false);
    }
  };

  // Confirm button (footer) opens the modal; the modal Yes button actually
  // submits the form via handleSubmit.
  const openConfirm = handleSubmit(
    () => {
      if (totals.total <= 0) {
        toast.error('Enter at least one denomination amount');
        return;
      }
      setConfirmOpen(true);
    },
    (errs) => {
      console.warn('[step submit] validation errors', errs);
      toast.error(t('common.fix_highlighted_fields', 'Please fix the highlighted fields before continuing.'));
    },
  );

  return (
    <FormProvider {...methods}>
      <form
        id="step-form"
        onSubmit={(e) => {
          // Never let native submit propagate — Confirm button opens modal instead.
          e.preventDefault();
        }}
        noValidate
      >
        <StepShell
          stepId={5}
          titleKey="step_5_change_order.title"
          subtitleKey="step_5_change_order.subtitle"
          submitting={submitting}
          submitLabelKey="step_5_change_order.submit"
          hideSubmit
          footerActions={
            <>
              <button
                type="button"
                className="btn-link"
                onClick={() => reset({ ...step5Defaults, arrivalDate: arrivalOptions[0] ?? '' })}
                disabled={submitting}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => void openConfirm()}
                disabled={submitting}
              >
                {submitting ? <span className="spinner" aria-hidden /> : 'Confirm'}
              </button>
            </>
          }
        >
          <SimulationBanner customer={headerInfo.name} />

          {/* 2026-07-26 (Amanda + Doug): Cash Services portal clone — left rail + main. */}
          <div className="cash-shell">
            <nav className="cit-sidenav" aria-label="Cash Services sections">
              <div className="cit-sidenav__group">
                <div className="cit-sidenav__section">Deposits</div>
                <button type="button" className="cit-sidenav__item" disabled>
                  <PackageOpen size={14} /> Search deposits
                </button>
                <div className="cit-sidenav__section">Change orders</div>
                <button type="button" className="cit-sidenav__item cit-sidenav__item--active">
                  <ShoppingCart size={14} /> Create change order
                </button>
                <button type="button" className="cit-sidenav__item" disabled>
                  <Search size={14} /> Search change orders
                </button>
                <div className="cit-sidenav__section">Reports</div>
                <button type="button" className="cit-sidenav__item" disabled>
                  <ClipboardList size={14} /> Deposit summary report
                </button>
                <button type="button" className="cit-sidenav__item" disabled>
                  <ClipboardList size={14} /> Order summary report
                </button>
                <button type="button" className="cit-sidenav__item" disabled>
                  <ClipboardList size={14} /> Customer profiles report
                </button>
              </div>
              <p className="cit-sidenav__hint">Training view — only Create change order is active during onboarding.</p>
            </nav>

            <div className="cash-shell__body stack stack-md">
              <HeaderBar
                info={headerInfo}
                arrivalOptions={arrivalOptions}
                arrivalDate={arrivalDate}
                onArrivalChange={(v) => setValue('arrivalDate', v, { shouldValidate: true, shouldDirty: true })}
                arrivalError={errors.arrivalDate?.message as string | undefined}
              />

              {/* 2026-08-26 (Amanda screenshot 5): compact 2-column form
                  matching the real Cash Services portal exactly. */}
              <div className="co-form">
                <aside className="co-form__summary">
                  <div className="co-form__hint">Click name below to select product</div>
                  <div className="co-form__totals">
                    <div className="co-form__totals-head">
                      <span>&nbsp;</span>
                      <span>Total USD</span>
                    </div>
                    <button
                      type="button"
                      className={`co-form__totals-row ${activeProduct === 'currency' ? 'co-form__totals-row--active' : ''}`}
                      onClick={() => setActiveProduct('currency')}
                    >
                      <span>Currency</span>
                      <span className="co-form__totals-value">
                        ${totals.currency.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      </span>
                    </button>
                    <button
                      type="button"
                      className="co-form__totals-row co-form__totals-row--disabled"
                      disabled
                      aria-disabled="true"
                    >
                      <span>Coin</span>
                      <span className="co-form__totals-value">
                        ${totals.coin.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      </span>
                    </button>
                    <div className="co-form__totals-row co-form__totals-row--grand">
                      <span>Total</span>
                      <span className="co-form__totals-value">
                        ${totals.total.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      </span>
                    </div>
                  </div>
                </aside>

                <div className="co-form__grid">
                  <div className="co-form__grid-head">
                    <span>Currency</span>
                    <span>Units</span>
                    <span>Value each</span>
                  </div>
                  {CHANGE_ORDER_CURRENCY_DENOMS.map((d) => (
                    <div key={d.key} className="co-form__grid-row">
                      <label htmlFor={`unit-${d.key}`} className="co-form__grid-label">
                        {d.label.replace(' bills', '').replace('$', '$')}
                      </label>
                      <div className="co-form__grid-amount">
                        <input
                          id={`unit-${d.key}`}
                          className="input"
                          type="number"
                          min="0"
                          step="1"
                          placeholder="0"
                          {...register(`units.${d.key as ChangeOrderDenomKey}` as const)}
                        />
                      </div>
                      <span className="co-form__grid-multiple">
                        ${d.unitValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
              {errors.units && (
                <span className="field-error">{errors.units.message as string}</span>
              )}
            </div>
          </div>
        </StepShell>
      </form>
      <ConfirmModal
        open={confirmOpen}
        amount={totals.total}
        arrivalIso={arrivalDate}
        onYes={() => { void handleSubmit(onSubmit)(); }}
        onNo={() => setConfirmOpen(false)}
        submitting={submitting}
      />
    </FormProvider>
  );
}
