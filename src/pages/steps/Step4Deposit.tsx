import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { FormProvider, useForm, useFormContext } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { ChevronDown, ChevronUp, Building2 } from 'lucide-react';

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
 * Layout:
 *   Simulation banner ("Simulating login as: [customer]")
 *   Left: Store Information (read-only summary)
 *   Right column:
 *     Deposit ticket card (bag, prepared by, business date, verified by,
 *       register id, departure date, shift, expected credit date)
 *     Amount entry card (total currency + coin + optional breakdowns)
 *     Comments
 */

interface StoreInfo {
  customer: string;
  locationName: string;
  locationId: string;
  address: string;
  pickupSchedule: string;
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
        <span className="denom-drawer__hint">Optional — enter counts by denomination</span>
      </button>
      {open && (
        <div className="denom-drawer__body">
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
          <div className="denom-drawer__actions">
            <button
              type="button"
              className="btn-ghost btn-ghost--sm"
              onClick={() => {
                setValue('totalCurrency', Number(breakdownTotal.toFixed(2)), { shouldDirty: true });
              }}
            >
              Copy breakdown into total
            </button>
          </div>
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
        <span className="denom-drawer__hint">Optional — enter counts by coin</span>
      </button>
      {open && (
        <div className="denom-drawer__body">
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
          <div className="denom-drawer__actions">
            <button
              type="button"
              className="btn-ghost btn-ghost--sm"
              onClick={() => {
                setValue('totalCoin', Number(breakdownTotal.toFixed(2)), { shouldDirty: true });
              }}
            >
              Copy breakdown into total
            </button>
          </div>
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

  const expectedCreditDate = useMemo(() => computeExpectedCreditDate(businessDate), [businessDate]);

  const onSubmit = async (values: Step4Values) => {
    setSubmitting(true);
    try {
      await submitStep(4, values);
      markStepCompleted(4);
      setCurrentStep(5);
      toast.success(t('step_4_deposit.success', 'Sample deposit completed.'));
      navigate('/onboarding/change-order');
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
          stepId={4}
          titleKey="step_4_deposit.title"
          subtitleKey="step_4_deposit.subtitle"
          submitting={submitting}
          submitLabelKey="step_4_deposit.submit"
        >
          <SimulationBanner customer={storeInfo.customer} />

          <div className="cit-layout">
            <StoreInfoPanel info={storeInfo} />

            <div className="cit-layout__main stack stack-md">
              <div className="step-card stack stack-md">
                <h3 className="section-heading">Create new deposit</h3>

                <div className="grid-2">
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
                </div>

                <div className="grid-2">
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
                </div>

                <div className="grid-2">
                  <div className="field">
                    <label htmlFor="registerId" className="field-label">Register id</label>
                    <input id="registerId" className="input" {...register('registerId')} />
                  </div>
                  <div className="field">
                    <label htmlFor="departureDate" className="field-label">Departure date</label>
                    <input id="departureDate" className="input" type="date" {...register('departureDate')} />
                  </div>
                </div>

                <div className="grid-2">
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
              </div>

              <div className="step-card stack stack-md">
                <h3 className="section-heading">Deposit amount</h3>

                <div className="grid-2">
                  <div className="field">
                    <label htmlFor="totalCurrency" className="field-label">Total currency ($)</label>
                    <input
                      id="totalCurrency"
                      className="input"
                      type="number"
                      step="0.01"
                      min="0"
                      {...register('totalCurrency')}
                    />
                    <CurrencyBreakdown />
                  </div>
                  <div className="field">
                    <label htmlFor="totalCoin" className="field-label">Total coin ($)</label>
                    <input
                      id="totalCoin"
                      className="input"
                      type="number"
                      step="0.01"
                      min="0"
                      {...register('totalCoin')}
                    />
                    <CoinBreakdown />
                  </div>
                </div>

                <div className="deposit-total">
                  <span>Total deposit</span>
                  <strong>${totalDeposit.toFixed(2)}</strong>
                </div>
              </div>

              <div className="step-card">
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
