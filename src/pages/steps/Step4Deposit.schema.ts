import { z } from 'zod';

/**
 * Step 4 — Sample deposit dry-run.
 *
 * The retailer enters a fake $100 deposit so they know what fields they'll
 * fill in on day 1 when entering their real deposit in the Cash Services Portal.
 *
 * Validation:
 *   - amount > 0
 *   - date required (free-form; UI exposes a date picker)
 *   - bag number required (we suggest TEST-<retailerId>)
 *   - at least one denomination with count > 0
 *   - sum(count * value) must equal amount (surfaced as a math_error)
 */

export const DENOMINATIONS = [
  { key: 'hundred', value: 100 },
  { key: 'fifty', value: 50 },
  { key: 'twenty', value: 20 },
  { key: 'ten', value: 10 },
  { key: 'five', value: 5 },
  { key: 'one', value: 1 },
] as const;

export type DenominationKey = (typeof DENOMINATIONS)[number]['key'];

// Empty-string-tolerant non-negative integer for denomination counts.
// HTML number inputs surface '' when cleared; coerce to 0 for math, but
// store the raw string in form state so the input doesn't show a
// leading zero (which causes 'type 100' to become '0100').
const denomCount = z
  .union([z.literal(''), z.coerce.number().int().min(0)])
  .transform((v) => (v === '' ? 0 : v));

const denomCounts = z.object({
  hundred: denomCount,
  fifty: denomCount,
  twenty: denomCount,
  ten: denomCount,
  five: denomCount,
  one: denomCount,
});

// Same pattern for the deposit amount — empty string is a valid in-progress
// state; positivity is enforced after coercion so 0 / '' both surface as
// 'must be greater than 0'.
const depositAmount = z
  .union([z.literal(''), z.coerce.number()])
  .transform((v) => (v === '' ? NaN : v))
  .refine((v) => Number.isFinite(v) && v > 0, {
    message: 'Deposit amount must be greater than 0',
  });

export const step4Schema = z
  .object({
    amount: depositAmount,
    date: z.string().min(1, 'Pick a date'),
    bagNumber: z.string().min(1, 'Enter the sealed bag number'),
    denominations: denomCounts,
    notes: z.string().optional(),
  })
  .superRefine((v, ctx) => {
    const total = DENOMINATIONS.reduce((sum, d) => {
      return sum + (v.denominations[d.key] ?? 0) * d.value;
    }, 0);
    if (total === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['denominations'],
        message: 'Enter at least one denomination count',
      });
    }
    if (total > 0 && Math.abs(total - v.amount) > 0.001) {
      ctx.addIssue({
        code: 'custom',
        path: ['amount'],
        message: `Your breakdown adds up to $${total.toFixed(2)} but the deposit total is $${v.amount.toFixed(2)}. Fix one of them.`,
      });
    }
  });

export type Step4Values = z.infer<typeof step4Schema>;
// The form holds in-progress strings; the schema coerces on submit. We use
// `any` here to avoid fighting Zod's input-vs-output type split — RHF only
// cares about defaults at runtime.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const step4Defaults: any = {
  amount: '',
  date: '',
  bagNumber: '',
  denominations: { hundred: '', fifty: '', twenty: '', ten: '', five: '', one: '' },
  notes: '',
};
