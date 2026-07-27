import { z } from 'zod';

/**
 * Step 5 — Sample change order (aligned to Cash Services Change Order screen).
 *
 * Per Amanda 2026-07-21: mirror the Cash Services "Create change order" screen
 * so retailers train on the same interface they'll use going live. NST-styled
 * portal shell, Cash Services information architecture.
 *
 * Header fields:
 *   Customer id, Name, Location, Cutoff time, Arrival date (dropdown).
 *
 * Denomination entry grid — the retailer requests whole "units" per row.
 * Units are NOT subdivided (a $20-bill unit is one $2,000 strap).
 */

// Amanda-provided unit definitions. `unitValue` = dollars per unit.
// 2026-07-26 change set (Amanda + Doug):
//   Added $50 and $100 denominations. Unit values follow the strap convention
//   (5,000 and 10,000 per strap respectively) confirmed by Ari.
export const CHANGE_ORDER_DENOMS = [
  { key: 'ones',      label: '$1 bills',   unitValue: 100   },
  { key: 'fives',     label: '$5 bills',   unitValue: 500   },
  { key: 'tens',      label: '$10 bills',  unitValue: 1000  },
  { key: 'twenties',  label: '$20 bills',  unitValue: 2000  },
  { key: 'fifties',   label: '$50 bills',  unitValue: 5000  },
  { key: 'hundreds',  label: '$100 bills', unitValue: 10000 },
  { key: 'quarters',  label: 'Quarters',   unitValue: 500   },
  { key: 'dimes',     label: 'Dimes',      unitValue: 250   },
  { key: 'nickels',   label: 'Nickels',    unitValue: 100   },
] as const;

export type ChangeOrderDenomKey = (typeof CHANGE_ORDER_DENOMS)[number]['key'];

/**
 * Sample account business rules — hard-coded to match Amanda's spec.
 * Wednesday delivery, Monday 1 PM cutoff.
 */
export const SAMPLE_DELIVERY_DAY = 3; // 0=Sun … 3=Wed
export const SAMPLE_CUTOFF_DAY = 1;   // Monday
export const SAMPLE_CUTOFF_TIME = '1:00 PM';

/**
 * Compute the next 3 Wednesdays from today (inclusive of upcoming Wed if it's
 * still before the Monday 1 PM cutoff). Returns ISO date strings (yyyy-mm-dd).
 *
 * Cutoff rule: to get a Wednesday delivery, the order must be submitted by
 * Monday 1 PM of the same week. If we're past cutoff, we skip that Wednesday.
 */
export function nextArrivalDates(from: Date = new Date(), count = 3): string[] {
  const results: string[] = [];
  const d = new Date(from);
  d.setHours(0, 0, 0, 0);

  // Determine the first eligible Wed
  const now = new Date(from);
  const dayOfWeek = now.getDay();
  const hour = now.getHours() + now.getMinutes() / 60;

  // Find the coming Wednesday
  let firstWed = new Date(d);
  const daysToWed = (SAMPLE_DELIVERY_DAY - firstWed.getDay() + 7) % 7;
  firstWed.setDate(firstWed.getDate() + (daysToWed || 7));

  // If today is Sun/Mon/Tue same-week Wed, check the Monday-1PM cutoff.
  // If we're past Mon 1PM in the same week as firstWed, skip to next.
  if (daysToWed !== 0) {
    // Compute the Monday of the same week as firstWed
    const mondayOfSameWeek = new Date(firstWed);
    mondayOfSameWeek.setDate(firstWed.getDate() - 2);
    mondayOfSameWeek.setHours(13, 0, 0, 0); // 1 PM
    if (now.getTime() > mondayOfSameWeek.getTime()) {
      firstWed.setDate(firstWed.getDate() + 7);
    }
  } else {
    // daysToWed === 0 means today IS Wednesday — always ship to next Wed
    firstWed.setDate(firstWed.getDate() + 7);
  }

  // Silence unused-var warnings
  void dayOfWeek;
  void hour;

  for (let i = 0; i < count; i++) {
    const w = new Date(firstWed);
    w.setDate(w.getDate() + i * 7);
    results.push(w.toISOString().slice(0, 10));
  }
  return results;
}

/** Format a yyyy-mm-dd date to "Wed, Jan 3 2027" for display. */
export function formatArrivalLabel(iso: string): string {
  if (!iso) return '';
  const d = new Date(`${iso}T12:00:00`);
  return d.toLocaleDateString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
  });
}

// Zod: each denom is a non-negative integer count of units.
// 2026-07-26 change set: fifties + hundreds added to the count shape.
const denomCounts = z.object({
  ones: z.coerce.number().int().min(0),
  fives: z.coerce.number().int().min(0),
  tens: z.coerce.number().int().min(0),
  twenties: z.coerce.number().int().min(0),
  fifties: z.coerce.number().int().min(0),
  hundreds: z.coerce.number().int().min(0),
  quarters: z.coerce.number().int().min(0),
  dimes: z.coerce.number().int().min(0),
  nickels: z.coerce.number().int().min(0),
});

export const step5Schema = z
  .object({
    // Header fields — pre-filled from onboarding context, editable arrival date.
    arrivalDate: z.string().min(1, 'Pick an arrival date'),
    // Denomination grid (units)
    units: denomCounts,
    comments: z.string(),

    // Legacy fields kept for backward-compat with prior Step 5 drafts.
    _legacy: z.object({
      deliveryDate: z.string().optional(),
      rolls: z.record(z.coerce.number()).optional(),
      bills: z.record(z.coerce.number()).optional(),
      notes: z.string().optional(),
    }).partial().optional(),
  })
  .superRefine((v, ctx) => {
    // At least one denomination unit > 0
    const any = Object.values(v.units).some((n) => n > 0);
    if (!any) {
      ctx.addIssue({
        code: 'custom',
        path: ['units'],
        message: 'Request at least one unit',
      });
    }
    // Arrival date must be one of the eligible Wednesdays (any future Wed).
    const arrival = new Date(`${v.arrivalDate}T12:00:00`);
    if (Number.isFinite(arrival.getTime())) {
      if (arrival.getDay() !== SAMPLE_DELIVERY_DAY) {
        ctx.addIssue({
          code: 'custom',
          path: ['arrivalDate'],
          message: 'Sample account delivers on Wednesdays.',
        });
      }
    }
  });

export type Step5Values = z.infer<typeof step5Schema>;

export const step5Defaults: Step5Values = {
  arrivalDate: '',
  units: {
    ones: 0, fives: 0, tens: 0, twenties: 0, fifties: 0, hundreds: 0,
    quarters: 0, dimes: 0, nickels: 0,
  },
  comments: '',
};

/** Sum total USD across all requested units. */
export function sumChangeOrderUsd(units: Step5Values['units']): {
  currency: number;
  coin: number;
  total: number;
} {
  const currencyKeys: ChangeOrderDenomKey[] = ['ones', 'fives', 'tens', 'twenties', 'fifties', 'hundreds'];
  const coinKeys: ChangeOrderDenomKey[] = ['quarters', 'dimes', 'nickels'];
  const findUnit = (k: ChangeOrderDenomKey) =>
    CHANGE_ORDER_DENOMS.find((d) => d.key === k)?.unitValue ?? 0;
  const currency = currencyKeys.reduce((sum, k) => sum + (Number(units[k]) || 0) * findUnit(k), 0);
  const coin = coinKeys.reduce((sum, k) => sum + (Number(units[k]) || 0) * findUnit(k), 0);
  return { currency, coin, total: currency + coin };
}
