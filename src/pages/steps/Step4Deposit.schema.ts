import { z } from 'zod';

/**
 * Step 4 — Sample deposit walkthrough (aligned to CIT Bank Deposits screen).
 *
 * Per Amanda 2026-07-21: mirror the CIT "Bank deposits / Create new deposit"
 * screen so retailers train on the layout they'll use daily.
 *
 * Fields (per spec):
 *   Store info panel (read-only, sourced from Salesforce prefill via onboarding)
 *   - Customer, Location name, Location id, Address, Pickup schedule.
 *
 *   Deposit ticket (main panel):
 *   - bagNumber            (required — deposit bag number)
 *   - preparedBy           (free entry — not defaulted to user)
 *   - businessDate         (date picker — required)
 *   - verifiedBy           (free entry — not defaulted to user)
 *   - registerId           (free entry)
 *   - departureDate        (date picker)
 *   - shiftNumber          (dropdown: 1, 2, 3, 4)
 *   - expectedCreditDate   (auto-calculated / display only — not persisted; derived)
 *
 *   Amount entry (right panel):
 *   - totalCurrency        (dollars — total bills, may be entered directly OR via breakdown)
 *   - totalCoin            (dollars — total coin, may be entered directly OR via breakdown)
 *   - currencyBreakdown    (optional denomination counts for bills)
 *   - coinBreakdown        (optional denomination counts for coin)
 *   - comments             (free entry)
 *
 * Rules (per Amanda):
 *   - Retailer may enter totals only OR use "Input details…" breakdowns.
 *   - Breakdown is optional; when provided, must equal the corresponding total.
 *   - Total deposit = totalCurrency + totalCoin (display-only sum).
 *   - bagNumber and businessDate required.
 *   - At least one of (totalCurrency > 0, totalCoin > 0) required.
 */

export const BILL_DENOMS = [
  { key: 'hundred', value: 100, label: '$100 bills' },
  { key: 'fifty', value: 50, label: '$50 bills' },
  { key: 'twenty', value: 20, label: '$20 bills' },
  { key: 'ten', value: 10, label: '$10 bills' },
  { key: 'five', value: 5, label: '$5 bills' },
  { key: 'one', value: 1, label: '$1 bills' },
] as const;

export const COIN_DENOMS = [
  { key: 'dollarCoins', value: 1, label: '$1 coins' },
  { key: 'halfDollars', value: 0.5, label: 'Half dollars' },
  { key: 'quarters', value: 0.25, label: 'Quarters' },
  { key: 'dimes', value: 0.1, label: 'Dimes' },
  { key: 'nickels', value: 0.05, label: 'Nickels' },
  { key: 'pennies', value: 0.01, label: 'Pennies' },
] as const;

export type BillKey = (typeof BILL_DENOMS)[number]['key'];
export type CoinKey = (typeof COIN_DENOMS)[number]['key'];

export const SHIFT_OPTIONS = ['1', '2', '3', '4'] as const;

const currencyBreakdownSchema = z.object({
  hundred: z.coerce.number().int().min(0),
  fifty: z.coerce.number().int().min(0),
  twenty: z.coerce.number().int().min(0),
  ten: z.coerce.number().int().min(0),
  five: z.coerce.number().int().min(0),
  one: z.coerce.number().int().min(0),
});

const coinBreakdownSchema = z.object({
  dollarCoins: z.coerce.number().int().min(0),
  halfDollars: z.coerce.number().int().min(0),
  quarters: z.coerce.number().int().min(0),
  dimes: z.coerce.number().int().min(0),
  nickels: z.coerce.number().int().min(0),
  pennies: z.coerce.number().int().min(0),
});

export const step4Schema = z
  .object({
    // Ticket fields (main panel)
    bagNumber: z.string().min(1, 'Enter the deposit bag number'),
    preparedBy: z.string(),
    businessDate: z.string().min(1, 'Pick a business date'),
    verifiedBy: z.string(),
    registerId: z.string(),
    departureDate: z.string(),
    shiftNumber: z.string(),

    // Amount entry
    totalCurrency: z.coerce.number().min(0),
    totalCoin: z.coerce.number().min(0),

    // Optional denomination breakdowns (may be empty / all zeros)
    useCurrencyBreakdown: z.boolean(),
    useCoinBreakdown: z.boolean(),
    currencyBreakdown: currencyBreakdownSchema,
    coinBreakdown: coinBreakdownSchema,

    comments: z.string(),

    // LEGACY fields kept for backward-compat with prior Step 4 drafts.
    // These aren't shown in the new UI but let old submitted data keep
    // rendering in handoffs and audit views.
    _legacy: z.object({
      amount: z.coerce.number().optional(),
      date: z.string().optional(),
      denominations: z.record(z.coerce.number()).optional(),
      notes: z.string().optional(),
    }).partial().optional(),
  })
  .superRefine((v, ctx) => {
    const grandTotal = (v.totalCurrency ?? 0) + (v.totalCoin ?? 0);
    if (grandTotal <= 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['totalCurrency'],
        message: 'Enter a total for currency, coin, or both.',
      });
    }

    // If retailer opened the currency breakdown, its sum must equal totalCurrency.
    if (v.useCurrencyBreakdown) {
      const breakdownTotal = BILL_DENOMS.reduce(
        (sum, d) => sum + (v.currencyBreakdown[d.key] ?? 0) * d.value,
        0,
      );
      if (breakdownTotal > 0 && Math.abs(breakdownTotal - v.totalCurrency) > 0.005) {
        ctx.addIssue({
          code: 'custom',
          path: ['totalCurrency'],
          message: `Currency breakdown adds up to $${breakdownTotal.toFixed(2)} but total currency is $${v.totalCurrency.toFixed(2)}. Fix one.`,
        });
      }
    }

    if (v.useCoinBreakdown) {
      const coinTotal = COIN_DENOMS.reduce(
        (sum, d) => sum + (v.coinBreakdown[d.key] ?? 0) * d.value,
        0,
      );
      if (coinTotal > 0 && Math.abs(coinTotal - v.totalCoin) > 0.005) {
        ctx.addIssue({
          code: 'custom',
          path: ['totalCoin'],
          message: `Coin breakdown adds up to $${coinTotal.toFixed(2)} but total coin is $${v.totalCoin.toFixed(2)}. Fix one.`,
        });
      }
    }
  });

export type Step4Values = z.infer<typeof step4Schema>;

export const step4Defaults: Step4Values = {
  bagNumber: '',
  preparedBy: '',
  businessDate: '',
  verifiedBy: '',
  registerId: '',
  departureDate: '',
  shiftNumber: '',
  totalCurrency: 0,
  totalCoin: 0,
  useCurrencyBreakdown: false,
  useCoinBreakdown: false,
  currencyBreakdown: { hundred: 0, fifty: 0, twenty: 0, ten: 0, five: 0, one: 0 },
  coinBreakdown: {
    dollarCoins: 0, halfDollars: 0, quarters: 0, dimes: 0, nickels: 0, pennies: 0,
  },
  comments: '',
};

/**
 * Expected credit date is calculated as the next business day (Mon–Fri) after
 * `businessDate`. Purely for display; not persisted.
 */
export function computeExpectedCreditDate(businessDate: string): string {
  if (!businessDate) return '';
  const d = new Date(businessDate);
  if (!Number.isFinite(d.getTime())) return '';
  const next = new Date(d);
  next.setDate(next.getDate() + 1);
  // Skip Sat/Sun
  while (next.getDay() === 0 || next.getDay() === 6) {
    next.setDate(next.getDate() + 1);
  }
  return next.toISOString().slice(0, 10);
}
