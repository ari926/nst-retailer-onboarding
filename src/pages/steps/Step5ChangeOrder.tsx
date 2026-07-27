import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { FormProvider, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { Building2, Info, PackageOpen, Search, ClipboardList, ShoppingCart } from 'lucide-react';

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
 * Per Amanda 2026-07-21: mirror the Cash Services "Create change order"
 * screen so retailers train on the same UI they'll use going live. Uses
 * NST portal shell + Cash Services info architecture.
 */

interface HeaderInfo {
  customerId: string;
  name: string;
  location: string;
}

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
    <div className="change-order-header">
      <div className="change-order-header__row">
        <div className="change-order-header__cell">
          <span className="change-order-header__label">Customer id</span>
          <span className="change-order-header__value mono">{info.customerId || '—'}</span>
        </div>
        <div className="change-order-header__cell">
          <span className="change-order-header__label">Name</span>
          <span className="change-order-header__value">{info.name || '—'}</span>
        </div>
        <div className="change-order-header__cell">
          <span className="change-order-header__label">Location</span>
          <span className="change-order-header__value">{info.location || '—'}</span>
        </div>
        <div className="change-order-header__cell">
          <span className="change-order-header__label">Cutoff time</span>
          <span className="change-order-header__value">Mon · {SAMPLE_CUTOFF_TIME}</span>
        </div>
        <div className="change-order-header__cell">
          <label htmlFor="arrivalDate" className="change-order-header__label">
            Arrival date
          </label>
          <select
            id="arrivalDate"
            className="input change-order-header__select"
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
    </div>
  );
}

function DenominationUnitsCard() {
  // Rendered separately so we can useFormContext-free layout — parent form
  // owns the register calls to keep the file readable.
  return null;
}
void DenominationUnitsCard;

export default function Step5ChangeOrder() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const storefrontName = useOnboardingStore((s) => s.storefrontName);
  const sfdcAccountId = useOnboardingStore((s) => s.sfdcAccountId);
  const markStepCompleted = useOnboardingStore((s) => s.markStepCompleted);
  const setCurrentStep = useOnboardingStore((s) => s.setCurrentStep);

  const [submitting, setSubmitting] = useState(false);
  const [draftLoaded, setDraftLoaded] = useState(false);

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
          // Don't reuse legacy deliveryDate (weekday may differ from Wed) — force
          // retailer to pick a valid Wed. Keep denom counts as best-effort import
          // but scale rolls to units (1 roll ≈ 0 units — we set to 0 to avoid
          // over-requesting).
          const b = legacy.bills || {};
          migrated.units = {
            ones: Number(b.singles) || 0,
            fives: Number(b.fives) || 0,
            tens: Number(b.tens) || 0,
            twenties: Number(b.twenties) || 0,
            // Legacy drafts predate 2026-07-26 change set (no $50/$100 fields).
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

  // RHF mutates nested objects in place, so watch('units') returns the same
  // reference across renders and useMemo doesn't recompute. Watch each key
  // individually so we get fresh primitive values on every keystroke.
  const ones = Number(watch('units.ones')) || 0;
  const fives = Number(watch('units.fives')) || 0;
  const tens = Number(watch('units.tens')) || 0;
  const twenties = Number(watch('units.twenties')) || 0;
  // 2026-07-26 change set: $50 and $100 added per Amanda + Doug.
  const fifties = Number(watch('units.fifties')) || 0;
  const hundreds = Number(watch('units.hundreds')) || 0;
  const quarters = Number(watch('units.quarters')) || 0;
  const dimes = Number(watch('units.dimes')) || 0;
  const nickels = Number(watch('units.nickels')) || 0;
  const arrivalDate = watch('arrivalDate');
  // Keep a live `units` object for row-level subtotal display.
  const units = { ones, fives, tens, twenties, fifties, hundreds, quarters, dimes, nickels };
  const totals = sumChangeOrderUsd(units);

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
    }
  };

  return (
    <FormProvider {...methods}>
      <form
        id="step-form"
        onSubmit={handleSubmit(onSubmit, (errs) => {
          console.warn('[step submit] validation errors', errs);
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
          hideSubmit
          footerActions={
            <>
              {/* 2026-07-26 (Amanda + Doug): Cash Services parity — Confirm / Cancel buttons.
                  Cancel just resets the form; the standard Back button still lives in the
                  StepShell footer on the left. */}
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => reset({ ...step5Defaults, arrivalDate: arrivalOptions[0] ?? '' })}
                disabled={submitting}
              >
                Cancel
              </button>
              <button
                type="submit"
                form="step-form"
                className="btn btn-primary"
                disabled={submitting}
              >
                {submitting ? <span className="spinner" aria-hidden /> : 'Confirm'}
              </button>
            </>
          }
        >
          <SimulationBanner customer={headerInfo.name} />

          {/* 2026-07-26 (Amanda + Doug): Cash Services portal clone — left rail + main.
              Only "Create change order" is active during onboarding. */}
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

          <div className="step-card stack stack-md">
            <div className="section-heading-row">
              <h3 className="section-heading">Create change order</h3>
              <span className="section-hint">
                <Building2 size={12} />
                <span>{headerInfo.name}</span>
              </span>
            </div>

            <div className="unit-callout">
              <Info size={14} />
              <div>
                <strong>Units are delivered whole — not divided.</strong>{' '}
                One $20 unit = $2,000. One $50 unit = $5,000. One $100 unit = $10,000. One quarter unit = $500.
              </div>
            </div>

            <div className="unit-grid">
              <div className="unit-grid__head">
                <span>Currency</span>
                <span>Amount ($)</span>
                <span>Multiple of</span>
                <span>Subtotal</span>
              </div>
              {CHANGE_ORDER_DENOMS.map((d) => {
                const count = Number(units?.[d.key as ChangeOrderDenomKey]) || 0;
                return (
                  <div key={d.key} className="unit-grid__row">
                    <label htmlFor={`unit-${d.key}`} className="unit-grid__label">
                      {d.label}
                    </label>
                    <input
                      id={`unit-${d.key}`}
                      className="input"
                      type="number"
                      min="0"
                      step="1"
                      {...register(`units.${d.key}` as const)}
                    />
                    <span className="unit-grid__multiple">${d.unitValue.toLocaleString()} / unit</span>
                    <span className="unit-grid__subtotal">
                      ${(count * d.unitValue).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </span>
                  </div>
                );
              })}
            </div>

            <div className="unit-totals">
              <div className="unit-totals__row">
                <span>Currency total</span>
                <strong>${totals.currency.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</strong>
              </div>
              <div className="unit-totals__row">
                <span>Coin total</span>
                <strong>${totals.coin.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</strong>
              </div>
              <div className="unit-totals__row unit-totals__row--grand">
                <span>Total USD</span>
                <strong>${totals.total.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</strong>
              </div>
            </div>
            {errors.units && (
              <span className="field-error">{errors.units.message as string}</span>
            )}

            <div className="field">
              <label htmlFor="comments" className="field-label">Comments</label>
              <textarea id="comments" className="textarea" rows={2} {...register('comments')} />
            </div>
          </div>
            </div>
          </div>
        </StepShell>
      </form>
    </FormProvider>
  );
}
