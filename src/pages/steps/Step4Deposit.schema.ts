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

const denomCounts = z.object({
  hundred: z.coerce.number().int().min(0),
  fifty: z.coerce.number().int().min(0),
  twenty: z.coerce.number().int().min(0),
  ten: z.coerce.number().int().min(0),
  five: z.coerce.number().int().min(0),
  one: z.coerce.number().int().min(0),
});

export const step4Schema = z
  .object({
    amount: z.coerce.number().positive('Deposit amount must be greater than 0'),
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

export const step4Defaults: Step4Values = {
  amount: 0,
  date: '',
  bagNumber: '',
  denominations: { hundred: 0, fifty: 0, twenty: 0, ten: 0, five: 0, one: 0 },
  notes: '',
};
