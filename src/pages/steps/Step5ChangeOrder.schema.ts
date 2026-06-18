import { z } from 'zod';

/**
 * Step 4 (formerly Step 5) — Sample change order dry-run.
 *
 * V2 overhaul: change orders are now denominated as **currency bundles**
 * (e.g. one bundle of $20s = $2,000) and **coin boxes** (e.g. one box of
 * quarters = $500). Pennies, individual loose bills, and custom roll counts
 * have all been removed.
 *
 * Bundle math (per the user spec):
 *   $1   →  $100   per bundle
 *   $5   →  $500   per bundle
 *   $10  →  $1,000 per bundle
 *   $20  →  $2,000 per bundle
 *   $50  →  $5,000 per bundle
 *   $100 → $10,000 per bundle
 *
 * Coin box math:
 *   Nickels  → $100  per box
 *   Dimes    → $250  per box
 *   Quarters → $500  per box
 *
 * Validation:
 *   - delivery date must be at least 2 business days from today
 *   - at least one bundle or coin box requested with quantity > 0
 */

export const BUNDLE_DENOMINATIONS = [
  { key: 'ones', value: 1, mult: 100 },
  { key: 'fives', value: 5, mult: 500 },
  { key: 'tens', value: 10, mult: 1000 },
  { key: 'twenties', value: 20, mult: 2000 },
  { key: 'fifties', value: 50, mult: 5000 },
  { key: 'hundreds', value: 100, mult: 10000 },
] as const;

export const COIN_BOX_DENOMINATIONS = [
  { key: 'nickels', mult: 100 },
  { key: 'dimes', mult: 250 },
  { key: 'quarters', mult: 500 },
] as const;

export type BundleKey = (typeof BUNDLE_DENOMINATIONS)[number]['key'];
export type CoinBoxKey = (typeof COIN_BOX_DENOMINATIONS)[number]['key'];

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
    // Currency bundles — number of bundles requested per denomination
    bundles: z.object({
      ones: z.coerce.number().int().min(0),
      fives: z.coerce.number().int().min(0),
      tens: z.coerce.number().int().min(0),
      twenties: z.coerce.number().int().min(0),
      fifties: z.coerce.number().int().min(0),
      hundreds: z.coerce.number().int().min(0),
    }),
    // Coin boxes — number of boxes requested per denomination
    coinBoxes: z.object({
      nickels: z.coerce.number().int().min(0),
      dimes: z.coerce.number().int().min(0),
      quarters: z.coerce.number().int().min(0),
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

    // At least one bundle or coin box quantity > 0
    const any =
      Object.values(v.bundles).some((n) => n > 0) ||
      Object.values(v.coinBoxes).some((n) => n > 0);
    if (!any) {
      ctx.addIssue({
        code: 'custom',
        path: ['bundles'],
        message: 'Request at least one bundle or coin box',
      });
    }
  });

export type Step5Values = z.infer<typeof step5Schema>;

export const step5Defaults: Step5Values = {
  deliveryDate: '',
  bundles: {
    ones: 0,
    fives: 0,
    tens: 0,
    twenties: 0,
    fifties: 0,
    hundreds: 0,
  },
  coinBoxes: { nickels: 0, dimes: 0, quarters: 0 },
  notes: '',
};
