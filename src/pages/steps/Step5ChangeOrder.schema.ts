import { z } from 'zod';

/**
 * Step 5 — Sample change order dry-run.
 *
 * Retailer requests $50 in quarters so they know how to submit change
 * orders once live. Validation:
 *   - delivery date must be at least 2 business days from today
 *   - at least one denomination requested with count > 0
 */

export const COIN_DENOMINATIONS = [
  { key: 'quarters', value: 0.25 },
  { key: 'dimes', value: 0.1 },
  { key: 'nickels', value: 0.05 },
  { key: 'pennies', value: 0.01 },
] as const;

export const BILL_DENOMINATIONS = [
  { key: 'singles', value: 1 },
  { key: 'fives', value: 5 },
  { key: 'tens', value: 10 },
  { key: 'twenties', value: 20 },
] as const;

export type CoinKey = (typeof COIN_DENOMINATIONS)[number]['key'];
export type BillKey = (typeof BILL_DENOMINATIONS)[number]['key'];

/** Count business days (Mon-Fri), no federal holiday calendar in V1. */
export function addBusinessDays(from: Date, days: number): Date {
  const d = new Date(from);
  let added = 0;
  while (added < days) {
    d.setDate(d.getDate() + 1);
    const day = d.getDay();
    if (day !== 0 && day !== 6) added++;
  }
  return d;
}

export const step5Schema = z
  .object({
    deliveryDate: z.string().min(1, 'Pick a delivery date'),
    // coin rolls (count = rolls; quarters roll = $10 = 40 coins)
    rolls: z.object({
      quarters: z.coerce.number().int().min(0),
      dimes: z.coerce.number().int().min(0),
      nickels: z.coerce.number().int().min(0),
      pennies: z.coerce.number().int().min(0),
    }),
    // loose bills (count = bills)
    bills: z.object({
      singles: z.coerce.number().int().min(0),
      fives: z.coerce.number().int().min(0),
      tens: z.coerce.number().int().min(0),
      twenties: z.coerce.number().int().min(0),
    }),
    notes: z.string().optional(),
  })
  .superRefine((v, ctx) => {
    // Validate delivery date is >= 2 business days from now
    const minDate = addBusinessDays(new Date(), 2);
    minDate.setHours(0, 0, 0, 0);
    const picked = new Date(v.deliveryDate);
    if (Number.isFinite(picked.getTime()) && picked < minDate) {
      ctx.addIssue({
        code: 'custom',
        path: ['deliveryDate'],
        message: 'Delivery date must be at least 2 business days from today.',
      });
    }

    // At least one denomination > 0
    const any =
      Object.values(v.rolls).some((n) => n > 0) ||
      Object.values(v.bills).some((n) => n > 0);
    if (!any) {
      ctx.addIssue({
        code: 'custom',
        path: ['rolls'],
        message: 'Request at least one denomination',
      });
    }
  });

export type Step5Values = z.infer<typeof step5Schema>;

// Values in a quarter roll, dime roll, etc. (standard bank roll counts)
export const ROLL_COUNTS: Record<CoinKey, number> = {
  quarters: 40, // $10 roll
  dimes: 50, // $5 roll
  nickels: 40, // $2 roll
  pennies: 50, // $0.50 roll
};

export const step5Defaults: Step5Values = {
  deliveryDate: '',
  rolls: { quarters: 0, dimes: 0, nickels: 0, pennies: 0 },
  bills: { singles: 0, fives: 0, tens: 0, twenties: 0 },
  notes: '',
};
