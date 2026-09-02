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
    // 2026-09-02 (Amanda): totals now auto-sync live from an open breakdown
    // (see Step4Deposit.tsx), so a mismatch between the two can no longer
    // happen in the UI — the only remaining rule is that something was
    // entered, whether as a plain total or via denomination breakdown.
    const grandTotal = (v.totalCurrency ?? 0) + (v.totalCoin ?? 0);
    if (grandTotal <= 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['totalCurrency'],
        message: 'Enter a total for currency, coin, or both.',
      });
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
 * 2026-07-26 change set (Amanda + Doug):
 *   The departure-date picker must restrict to future dates that match the
 *   store's actual pickup day-of-week (a Wednesday store sees only future
 *   Wednesdays, etc.). These helpers make that filtering deterministic and
 *   testable.
 */

export const SERVICE_DAY_WEEKDAY: Record<string, number> = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
};

export const WEEKDAY_LABEL: Record<number, string> = {
  0: 'Sunday', 1: 'Monday', 2: 'Tuesday', 3: 'Wednesday',
  4: 'Thursday', 5: 'Friday', 6: 'Saturday',
};

/**
 * Derive the store's expected pickup weekday from Step 7 draft. Priority:
 *   1. explicit ISO date in Step 7 `preferredDate` (Monday-of-week anchor)
 *   2. `serviceDay` code if present in draft (legacy)
 *   3. fallback: Wednesday (matches the walkthrough banner copy)
 */
export function deriveServiceWeekday(step7?: {
  preferredDate?: string;
  serviceDay?: string;
}): number {
  if (step7?.preferredDate) {
    const [y, m, d] = step7.preferredDate.split('-').map(Number);
    if (y && m && d) {
      const dt = new Date(y, m - 1, d);
      if (Number.isFinite(dt.getTime())) return dt.getDay();
    }
  }
  if (step7?.serviceDay && step7.serviceDay in SERVICE_DAY_WEEKDAY) {
    return SERVICE_DAY_WEEKDAY[step7.serviceDay];
  }
  return 3; // Wednesday
}

/**
 * Generate `count` future dates whose weekday matches `weekday` (0=Sun..6=Sat),
 * starting from the day AFTER `from`. Used to populate the CIT-style departure
 * date picker so retailers can only pick their actual service day.
 */
export function nextDatesForWeekday(
  weekday: number,
  count = 12,
  from: Date = new Date(),
): string[] {
  const out: string[] = [];
  const cursor = new Date(from);
  cursor.setHours(0, 0, 0, 0);
  cursor.setDate(cursor.getDate() + 1);
  while (cursor.getDay() !== weekday) cursor.setDate(cursor.getDate() + 1);
  while (out.length < count) {
    out.push(cursor.toISOString().slice(0, 10));
    cursor.setDate(cursor.getDate() + 7);
  }
  return out;
}

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
