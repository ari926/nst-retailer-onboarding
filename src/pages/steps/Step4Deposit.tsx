import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { FormProvider, useForm, useFormContext } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { ChevronDown, ChevronUp, Building2, FileText, History, ClipboardList, PackageOpen, ShoppingCart, Search, Wallet } from 'lucide-react';

import { StepShell } from '../../components/ui/StepShell';
import { useOnboardingStore } from '../../stores/onboardingStore';
import { loadDraft, saveDraft, submitStep } from '../../lib/stepService';
import {
  step4Schema,
  step4Defaults,
  BILL_DENOMS,
  COIN_DENOMS,
  SHIFT_OPTIONS,
  computeExpectedCreditDate,
  deriveServiceWeekday,
  nextDatesForWeekday,
  WEEKDAY_LABEL,
  type Step4Values,
  type BillKey,
  type CoinKey,
} from './Step4Deposit.schema';

/**
 * Step 4 — Sample deposit walkthrough (CIT Bank Deposits layout).
 *
 * Per Amanda 2026-07-21: mirror the CIT "Create new deposit" screen so
 * retailers train on the same interface they'll use going live. NST-styled
 * portal shell, CIT information architecture.
 *
 * 2026-07-26 change set (Amanda + Doug):
 *   Pixel-cloned closer to the real CIT portal:
 *     - Left rail nav (Bank deposits / Deposit history / Reports)
 *     - Store info panel + Create-new-deposit form in top row
 *     - Right sidebar with a Reports panel (Deposit list, Deposit activity)
 *     - Deposit history table below the form (sample rows for training)
 *     - Reset + Complete deposit buttons (replaces "Confirm & continue")
 *     - Departure date restricted to future dates on the store's service
 *       day-of-week (Wed store → future Wednesdays only, etc.)
 */

interface StoreInfo {
  customer: string;
  locationName: string;
  locationId: string;
  address: string;
  pickupSchedule: string;
}

// 2026-09-02 (Amanda): brief acknowledgment shown right after a deposit is
// confirmed, explaining the physical tear-off receipt hand-off. Mirrors the
// Step 5 change-order confirm modal's visual style.
function DepositDoneModal({
  open,
  onContinue,
}: {
  open: boolean;
  onContinue: () => void;
}) {
  if (!open) return null;
  return (
    <div className="co-modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="deposit-done-title">
      <div className="co-modal">
        <p id="deposit-done-title" className="co-modal__body">
          Deposit confirmed.
        </p>
        <p className="cit-modal__note">
          A receipt PDF is generated with two tear-off portions: keep the <strong>top portion</strong> for your records,
          and place the <strong>bottom portion</strong> inside the tamper-evident bag along with the deposit.
        </p>
        <div className="co-modal__actions">
          <button type="button" className="btn btn-primary" onClick={onContinue}>
            Continue
          </button>
        </div>
      </div>
    </div>
  );
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
        This is a walkthrough — no funds move. Delivered Wednesday, cutoff 1:00 PM Monday.
      </span>
    </div>
  );
}

function StoreInfoPanel({ info }: { info: StoreInfo }) {
  return (
    <aside className="store-info-panel" aria-label="Store information">
      <header className="store-info-panel__head">
        <Building2 size={16} />
        <span>Store information</span>
      </header>
      <dl className="store-info-panel__body">
        <div className="store-info-panel__row">
          <dt>Customer</dt>
          <dd>{info.customer || '—'}</dd>
        </div>
        <div className="store-info-panel__row">
          <dt>Location name</dt>
          <dd>{info.locationName || '—'}</dd>
        </div>
        <div className="store-info-panel__row">
          <dt>Location id</dt>
          <dd className="mono">{info.locationId || '—'}</dd>
        </div>
        <div className="store-info-panel__row">
          <dt>Address</dt>
          <dd>{info.address || 'Provided on Step 1'}</dd>
        </div>
        <div className="store-info-panel__row">
          <dt>Pickup schedule</dt>
          <dd>{info.pickupSchedule || 'Set on Step 7'}</dd>
        </div>
      </dl>
    </aside>
  );
}

function CurrencyBreakdown() {
  const { register, watch, setValue, formState: { errors } } = useFormContext<Step4Values>();
  const open = watch('useCurrencyBreakdown');
  const values = watch('currencyBreakdown');
  const breakdownTotal = BILL_DENOMS.reduce(
    (sum, d) => sum + (Number(values?.[d.key as BillKey]) || 0) * d.value,
    0,
  );

  // 2026-09-02 (Amanda): when entering by denomination, the total should
  // total itself automatically — no separate "copy into total" step, and
  // no possibility of the two disagreeing.
  useEffect(() => {
    if (open) {
      setValue('totalCurrency', Number(breakdownTotal.toFixed(2)), { shouldDirty: true });
    }
  }, [open, breakdownTotal, setValue]);

  return (
    <div className="denom-drawer">
      <button
        type="button"
        className="denom-drawer__toggle"
        onClick={() => setValue('useCurrencyBreakdown', !open, { shouldDirty: true })}
        aria-expanded={open}
      >
        {open ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        <span>Input details…</span>
        <span className="denom-drawer__hint">Optional — break bills out by denomination instead</span>
      </button>
      {open && (
        <div className="denom-drawer__body">
          <div className="denom-grid__scroll">
            <div className="denom-grid">
              <div className="denom-grid__head">
                <span>Denomination</span>
                <span>Count</span>
                <span>Subtotal</span>
              </div>
              {BILL_DENOMS.map((d) => {
                const count = Number(values?.[d.key as BillKey]) || 0;
                return (
                  <div key={d.key} className="denom-grid__row">
                    <label htmlFor={`bd-${d.key}`} className="denom-grid__label">
                      {d.label}
                    </label>
                    <input
                      id={`bd-${d.key}`}
                      className="input"
                      type="number"
                      min="0"
                      step="1"
                      {...register(`currencyBreakdown.${d.key}` as const)}
                    />
                    <span className="denom-grid__subtotal">${(count * d.value).toFixed(2)}</span>
                  </div>
                );
              })}
              <div className="denom-grid__total">
                <span>Breakdown total</span>
                <strong>${breakdownTotal.toFixed(2)}</strong>
              </div>
            </div>
          </div>
          <p className="denom-drawer__hint denom-drawer__hint--sync">
            Total bills above updates automatically from this breakdown.
          </p>
        </div>
      )}
      {errors.totalCurrency && (
        <span className="field-error">{errors.totalCurrency.message as string}</span>
      )}
    </div>
  );
}

function CoinBreakdown() {
  const { register, watch, setValue, formState: { errors } } = useFormContext<Step4Values>();
  const open = watch('useCoinBreakdown');
  const values = watch('coinBreakdown');
  const breakdownTotal = COIN_DENOMS.reduce(
    (sum, d) => sum + (Number(values?.[d.key as CoinKey]) || 0) * d.value,
    0,
  );

  // 2026-09-02 (Amanda): same auto-totaling as currency — the total updates
  // itself from the coin breakdown, no manual copy step.
  useEffect(() => {
    if (open) {
      setValue('totalCoin', Number(breakdownTotal.toFixed(2)), { shouldDirty: true });
    }
  }, [open, breakdownTotal, setValue]);

  return (
    <div className="denom-drawer">
      <button
        type="button"
        className="denom-drawer__toggle"
        onClick={() => setValue('useCoinBreakdown', !open, { shouldDirty: true })}
        aria-expanded={open}
      >
        {open ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        <span>Input details…</span>
        <span className="denom-drawer__hint">Optional — break coins out by denomination instead</span>
      </button>
      {open && (
        <div className="denom-drawer__body">
          <div className="denom-grid__scroll">
            <div className="denom-grid">
              <div className="denom-grid__head">
                <span>Coin</span>
                <span>Count</span>
                <span>Subtotal</span>
              </div>
              {COIN_DENOMS.map((d) => {
                const count = Number(values?.[d.key as CoinKey]) || 0;
                return (
                  <div key={d.key} className="denom-grid__row">
                    <label htmlFor={`cd-${d.key}`} className="denom-grid__label">
                      {d.label}
                    </label>
                    <input
                      id={`cd-${d.key}`}
                      className="input"
                      type="number"
                      min="0"
                      step="1"
                      {...register(`coinBreakdown.${d.key}` as const)}
                    />
                    <span className="denom-grid__subtotal">${(count * d.value).toFixed(2)}</span>
                  </div>
                );
              })}
              <div className="denom-grid__total">
                <span>Breakdown total</span>
                <strong>${breakdownTotal.toFixed(2)}</strong>
              </div>
            </div>
          </div>
          <p className="denom-drawer__hint denom-drawer__hint--sync">
            Total coins above updates automatically from this breakdown.
          </p>
        </div>
      )}
      {errors.totalCoin && (
        <span className="field-error">{errors.totalCoin.message as string}</span>
      )}
    </div>
  );
}

export default function Step4Deposit() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const storefrontName = useOnboardingStore((s) => s.storefrontName);
  const sfdcAccountId = useOnboardingStore((s) => s.sfdcAccountId);
  const markStepCompleted = useOnboardingStore((s) => s.markStepCompleted);
  const setCurrentStep = useOnboardingStore((s) => s.setCurrentStep);

  const [submitting, setSubmitting] = useState(false);
  const [draftLoaded, setDraftLoaded] = useState(false);
  // 2026-09-02 (Amanda): after a real deposit is confirmed on the production
  // CIT portal, a receipt is generated with two tear-off portions. Shown as a
  // brief acknowledgment once the deposit completes, before moving on.
  const [depositDoneOpen, setDepositDoneOpen] = useState(false);

  // Sourced from Step 1 draft (address) and Step 7 draft (pickup schedule) if
  // they exist. Best-effort fill; the panel gracefully degrades to "—".
  const [storeInfo, setStoreInfo] = useState<StoreInfo>(() => ({
    customer: storefrontName || 'Sample Retailer',
    locationName: storefrontName || '',
    locationId: sfdcAccountId ? sfdcAccountId.slice(-6).toUpperCase() : '',
    address: '',
    pickupSchedule: '',
  }));

  const methods = useForm<Step4Values>({
    resolver: zodResolver(step4Schema),
    defaultValues: step4Defaults,
    mode: 'onBlur',
    shouldUnregister: false,
  });

  const { register, handleSubmit, watch, reset, formState: { errors } } = methods;

  // Load draft; if it looks like the legacy Step 4 shape, migrate.
  useEffect(() => {
    let mounted = true;
    (async () => {
      const draft = await loadDraft<Step4Values & Record<string, unknown>>(4);
      if (mounted && draft) {
        const migrated: Step4Values = { ...step4Defaults, ...(draft as Step4Values) };

        // Legacy migration: old drafts had { amount, date, bagNumber,
        // denominations{hundred..one}, notes }. Map into the new shape.
        const legacy = draft as unknown as {
          amount?: number;
          date?: string;
          bagNumber?: string;
          denominations?: Partial<Record<BillKey, number>>;
          notes?: string;
        };
        if (legacy && (legacy.amount || legacy.denominations) && !('totalCurrency' in draft)) {
          migrated.totalCurrency = Number(legacy.amount) || 0;
          migrated.businessDate = legacy.date || '';
          migrated.bagNumber = legacy.bagNumber || '';
          migrated.comments = legacy.notes || '';
          if (legacy.denominations) {
            migrated.useCurrencyBreakdown = true;
            migrated.currencyBreakdown = {
              hundred: Number(legacy.denominations.hundred) || 0,
              fifty: Number(legacy.denominations.fifty) || 0,
              twenty: Number(legacy.denominations.twenty) || 0,
              ten: Number(legacy.denominations.ten) || 0,
              five: Number(legacy.denominations.five) || 0,
              one: Number(legacy.denominations.one) || 0,
            };
          }
        }

        reset(migrated);
      }
      setDraftLoaded(true);
    })();
    return () => { mounted = false; };
  }, [reset]);

  // Also try to hydrate storeInfo from Step 1 and Step 7 drafts.
  useEffect(() => {
    (async () => {
      const s1 = await loadDraft<{
        businessName?: string;
        address?: { street?: string; city?: string; state?: string; postalCode?: string };
      }>(1);
      const s7 = await loadDraft<{ frequency?: string }>(7);
      setStoreInfo((prev) => ({
        ...prev,
        customer: s1?.businessName || prev.customer,
        locationName: s1?.businessName || prev.locationName,
        address: s1?.address
          ? [s1.address.street, s1.address.city, s1.address.state, s1.address.postalCode]
              .filter(Boolean)
              .join(', ')
          : prev.address,
        pickupSchedule: s7?.frequency
          ? `${s7.frequency} pickups (Wed delivery · Mon 1 PM cutoff)`
          : prev.pickupSchedule || 'Wed delivery · Mon 1 PM cutoff',
      }));
    })();
  }, []);

  // Autosave (1.5s debounce) once draft has loaded.
  useEffect(() => {
    if (!draftLoaded) return;
    let handle: ReturnType<typeof setTimeout> | null = null;
    const subscription = watch((values) => {
      if (handle) clearTimeout(handle);
      handle = setTimeout(() => {
        void saveDraft(4, values);
      }, 1500);
    });
    return () => {
      if (handle) clearTimeout(handle);
      subscription.unsubscribe();
    };
  }, [watch, draftLoaded]);

  const businessDate = watch('businessDate');
  const totalCurrency = Number(watch('totalCurrency')) || 0;
  const totalCoin = Number(watch('totalCoin')) || 0;
  const totalDeposit = totalCurrency + totalCoin;
  const useCurrencyBreakdown = watch('useCurrencyBreakdown');
  const useCoinBreakdown = watch('useCoinBreakdown');

  const expectedCreditDate = useMemo(() => computeExpectedCreditDate(businessDate), [businessDate]);

  // 2026-07-26 (Amanda + Doug): departure date restricted to store service day.
  const [serviceWeekday, setServiceWeekday] = useState<number>(3); // default Wed
  useEffect(() => {
    (async () => {
      const s7 = await loadDraft<{ preferredDate?: string; serviceDay?: string }>(7);
      setServiceWeekday(deriveServiceWeekday(s7 ?? undefined));
    })();
  }, []);
  const departureOptions = useMemo(
    () => nextDatesForWeekday(serviceWeekday, 12),
    [serviceWeekday],
  );

  const onSubmit = async (values: Step4Values) => {
    setSubmitting(true);
    try {
      await submitStep(4, values);
      markStepCompleted(4);
      toast.success(t('step_4_deposit.success', 'Sample deposit completed.'));
      // Show the tear-off receipt note before moving on to Step 5.
      setDepositDoneOpen(true);
    } catch (err) {
      const msg = err instanceof Error ? err.message : t('global.errors.generic');
      toast.error(msg);
    } finally {
      setSubmitting(false);
    }
  };

  const continueToChangeOrder = () => {
    setDepositDoneOpen(false);
    setCurrentStep(5);
    navigate('/onboarding/change-order');
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
          stepId={4}
          titleKey="step_4_deposit.title"
          subtitleKey="step_4_deposit.subtitle"
          submitting={submitting}
          submitLabelKey="step_4_deposit.submit"
          hideSubmit
          footerActions={
            <>
              <button
                type="button"
                className="btn-link"
                onClick={() => reset(step4Defaults)}
                disabled={submitting}
              >
                Reset
              </button>
              <button
                type="submit"
                form="step-form"
                className="btn btn-primary"
                disabled={submitting}
              >
                {submitting ? <span className="spinner" aria-hidden /> : 'Complete deposit'}
              </button>
            </>
          }
        >
          <SimulationBanner customer={storeInfo.customer} />

          {/* 2026-08-26 (Amanda screenshot 6): CIT-portal 2-column shell that
              matches the real Bank deposits page. Left rail lists the same
              nav groups as Step 5 (Deposits / Change orders / Reports).
              Body has a top bar, green section title, 3-column form. */}
          <div className="cit-shell">
            <nav className="cit-sidenav" aria-label="CIT sections">
              <div className="cit-sidenav__group">
                <div className="cit-sidenav__section">Deposits</div>
                <button type="button" className="cit-sidenav__item cit-sidenav__item--active">
                  <FileText size={14} /> Bank deposits
                </button>
                <button type="button" className="cit-sidenav__item" disabled>
                  <PackageOpen size={14} /> Search deposits
                </button>
                <div className="cit-sidenav__section">Change orders</div>
                <button type="button" className="cit-sidenav__item" disabled>
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
              <p className="cit-sidenav__hint">Training view — only Bank deposits is active during onboarding.</p>
            </nav>

            <div className="cit-shell__body stack stack-md">
              <div className="cit-topbar">
                <span className="cit-topbar__customer">Customer: <strong>{storeInfo.customer || 'Sample Retailer'}</strong></span>
                <span className="cit-topbar__user">cash@talaria.com ▾</span>
              </div>
              <div className="cit-section-title">
                <span className="cit-section-title__icon"><Wallet size={20} /></span>
                <span className="cit-section-title__text">Bank deposits</span>
                <a href="#" className="cit-section-title__close" onClick={(e) => e.preventDefault()}>Close</a>
              </div>
          <div className="cit-layout">
            <StoreInfoPanel info={storeInfo} />

            <div className="cit-layout__main stack stack-md">
              <div className="step-card stack stack-md">
                <h3 className="section-heading">Create new deposit</h3>

                {/* 2026-08-26 (Amanda screenshot 6): production form uses a
                    3-column grid — row 1 bag/preparedBy/totalCurrency,
                    row 2 businessDate/verifiedBy/totalCoin,
                    row 3 registerId/departureDate/expectedCreditDate,
                    row 4 shift/expectedCreditDate stays paired. */}
                <div className="grid-3-form">
                  <div className="field">
                    <label htmlFor="bagNumber" className="field-label field-required">
                      Deposit bag number
                    </label>
                    <input id="bagNumber" className="input" {...register('bagNumber')} />
                    {errors.bagNumber && (
                      <span className="field-error">{errors.bagNumber.message}</span>
                    )}
                  </div>
                  <div className="field">
                    <label htmlFor="preparedBy" className="field-label">Prepared by</label>
                    <input id="preparedBy" className="input" {...register('preparedBy')} />
                  </div>
                  <div className="field">
                    <label htmlFor="totalCurrency" className="field-label">
                      Total bills ($)
                      {useCurrencyBreakdown && <span className="field-label__hint"> · auto-totaled</span>}
                    </label>
                    <p className="field-hint">Enter one total, or break bills out by denomination below.</p>
                    <input
                      id="totalCurrency"
                      className="input"
                      type="number"
                      step="0.01"
                      min="0"
                      readOnly={useCurrencyBreakdown}
                      {...register('totalCurrency')}
                    />
                    <CurrencyBreakdown />
                  </div>

                  <div className="field">
                    <label htmlFor="businessDate" className="field-label field-required">
                      Business date
                    </label>
                    <input id="businessDate" className="input" type="date" {...register('businessDate')} />
                    {errors.businessDate && (
                      <span className="field-error">{errors.businessDate.message}</span>
                    )}
                  </div>
                  <div className="field">
                    <label htmlFor="verifiedBy" className="field-label">Verified by</label>
                    <input id="verifiedBy" className="input" {...register('verifiedBy')} />
                  </div>
                  <div className="field">
                    <label htmlFor="totalCoin" className="field-label">
                      Total coins ($)
                      {useCoinBreakdown && <span className="field-label__hint"> · auto-totaled</span>}
                    </label>
                    <p className="field-hint">Enter one total, or break coins out by denomination below.</p>
                    <input
                      id="totalCoin"
                      className="input"
                      type="number"
                      step="0.01"
                      min="0"
                      readOnly={useCoinBreakdown}
                      {...register('totalCoin')}
                    />
                    <CoinBreakdown />
                  </div>

                  <div className="field">
                    <label htmlFor="registerId" className="field-label">Register id</label>
                    <input id="registerId" className="input" {...register('registerId')} />
                  </div>
                  <div className="field">
                    <label htmlFor="departureDate" className="field-label">Departure date</label>
                    {/* 2026-07-26 (Amanda + Doug): only allow future dates on the
                        store's service day-of-week. `departureOptions` is derived
                        from Step 7's preferredDate (Monday-of-week anchor). */}
                    <select id="departureDate" className="input" {...register('departureDate')}>
                      <option value="">— Select {WEEKDAY_LABEL[serviceWeekday]} —</option>
                      {departureOptions.map((iso) => {
                        const [y, m, d] = iso.split('-').map(Number);
                        const dt = new Date(y, m - 1, d);
                        const label = dt.toLocaleDateString(undefined, {
                          weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
                        });
                        return <option key={iso} value={iso}>{label}</option>;
                      })}
                    </select>
                    <span className="field-hint">
                      This store is scheduled for {WEEKDAY_LABEL[serviceWeekday]} service. Departure must fall on a {WEEKDAY_LABEL[serviceWeekday]}.
                    </span>
                  </div>
                  <div className="field">
                    <label className="field-label">USD Total</label>
                    <div className="readonly-value" aria-live="polite">
                      <strong>${totalDeposit.toFixed(2)}</strong>
                    </div>
                  </div>

                  <div className="field">
                    <label htmlFor="shiftNumber" className="field-label">Shift number</label>
                    <select id="shiftNumber" className="input" {...register('shiftNumber')}>
                      <option value="">Select a shift</option>
                      {SHIFT_OPTIONS.map((s) => (
                        <option key={s} value={s}>Shift {s}</option>
                      ))}
                    </select>
                  </div>
                  <div className="field">
                    <label className="field-label">Expected credit date</label>
                    <div className="readonly-value" aria-live="polite">
                      {expectedCreditDate || <span className="muted">Pick a business date</span>}
                    </div>
                    <span className="field-hint">Auto-calculated · next business day</span>
                  </div>
                </div>

                {/* Comments spans full width — a squeezed textarea wraps text
                    one-word-per-line inside the 3-col grid. */}
                <div className="field">
                  <label htmlFor="comments" className="field-label">Comments</label>
                  <textarea id="comments" className="textarea" rows={2} {...register('comments')} />
                </div>
              </div>
            </div>
          </div>
          </div>
          </div>

          {/* 2026-08-28 (layout fix): Deposit History + Reports now sit OUTSIDE
              .cit-shell (a true sibling, not nested inside .cit-shell__body)
              so their combined width lines up with the portal shell's full
              outer edges (including the sidenav rail) instead of only the
              narrower cit-layout content column. Purely a wrapper move — no
              markup, data, or behavior inside Deposit history/Reports changed. */}
          {/* 2026-07-26 (Amanda + Doug): Deposit history + Reports rail.
              Read-only training data — mirrors the CIT screen exactly. */}
          <div className="cit-history-row">
            <section className="step-card cit-history" aria-label="Deposit history">
              <header className="cit-history__head">
                <h3 className="section-heading">Deposit history</h3>
                <label className="cit-history__filter">
                  <input type="checkbox" disabled /> Show cancelled deposits
                </label>
              </header>
              <div className="cit-history__scroll">
                <table className="cit-history__table">
                  <thead>
                    <tr>
                      <th>Date/time</th>
                      <th>Bag number</th>
                      <th>Created by</th>
                      <th>Business date</th>
                      <th>Deposit date</th>
                      <th>Deposit method</th>
                      <th className="num">Currency</th>
                      <th className="num">Coin</th>
                      <th className="num">Total</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td>2026-07-13 04:06 PM EDT</td>
                      <td className="mono">LAK0104</td>
                      <td>cash@talaria.com</td>
                      <td>2026-07-14</td>
                      <td>—</td>
                      <td>Carrier pickup</td>
                      <td className="num">1,200.00</td>
                      <td className="num">—</td>
                      <td className="num">1,200.00</td>
                      <td>Pending departure</td>
                    </tr>
                    <tr>
                      <td>2026-07-10 03:21 PM EDT</td>
                      <td className="mono">TH36756</td>
                      <td>cash@talaria.com</td>
                      <td>2026-07-07</td>
                      <td>—</td>
                      <td>Carrier pickup</td>
                      <td className="num">1,500.00</td>
                      <td className="num">100.00</td>
                      <td className="num">1,600.40</td>
                      <td>Pending departure</td>
                    </tr>
                    <tr>
                      <td>2026-06-26 02:05 PM EDT</td>
                      <td className="mono">EDT714546</td>
                      <td>cash@talaria.com</td>
                      <td>2026-06-30</td>
                      <td>—</td>
                      <td>Carrier pickup</td>
                      <td className="num">2,900.00</td>
                      <td className="num">8.75</td>
                      <td className="num">2,908.75</td>
                      <td>Pending departure</td>
                    </tr>
                    <tr>
                      <td>2026-06-19 11:00 AM EDT</td>
                      <td className="mono">GF2266</td>
                      <td>cash@talaria.com</td>
                      <td>2026-06-16</td>
                      <td>—</td>
                      <td>Carrier pickup</td>
                      <td className="num">10,800.00</td>
                      <td className="num">—</td>
                      <td className="num">10,800.00</td>
                      <td>Pending departure</td>
                    </tr>
                    <tr>
                      <td>2026-06-14 12:32 PM EDT</td>
                      <td className="mono">FA132466</td>
                      <td>cash@talaria.com</td>
                      <td>2026-06-14</td>
                      <td>—</td>
                      <td>Carrier pickup</td>
                      <td className="num">5,340.00</td>
                      <td className="num">—</td>
                      <td className="num">5,340.00</td>
                      <td>Pending departure</td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <div className="cit-history__actions">
                <button type="button" className="btn-ghost btn-ghost--sm" disabled>+ Create deposit</button>
                <button type="button" className="btn-ghost btn-ghost--sm" disabled>× Cancel selected deposit</button>
                <button type="button" className="btn-ghost btn-ghost--sm" disabled>Reprint selected deposit</button>
                <button type="button" className="btn-ghost btn-ghost--sm" disabled>View selected deposit</button>
              </div>
            </section>

            <aside className="cit-reports" aria-label="Reports">
              <header className="cit-reports__head">Reports</header>
              <ul className="cit-reports__list">
                <li><a href="#" onClick={(e) => e.preventDefault()}>Deposit list</a></li>
                <li><a href="#" onClick={(e) => e.preventDefault()}>Deposit activity</a></li>
              </ul>
            </aside>
          </div>
        </StepShell>
      </form>
      <DepositDoneModal open={depositDoneOpen} onContinue={continueToChangeOrder} />
    </FormProvider>
  );
}
