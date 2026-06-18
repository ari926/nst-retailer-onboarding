import { z } from 'zod';

/**
 * Step 6 (formerly Step 7) — First pickup + ongoing service request.
 *
 * Two modes:
 *   1. Retailer picks a preferred first pickup date (≥ 10 calendar days out)
 *      and fills the ongoing service spec (days, window, frequency).
 *   2. Retailer is "not sure yet" — defer the date. NST will email every
 *      2 weeks (capped at 6 nudges = 12 weeks) asking them to confirm.
 *
 * V2 addition: a **pickup contact** section ("Who do we contact on day of
 * pickup?") is required in BOTH modes — full name + mobile phone are
 * required, store phone is optional.
 *
 * In deferred mode the service-spec fields (days, frequency, window) are
 * optional — we still want to capture whatever they know so ops can pre-plan.
 */

export const SERVICE_DAYS = [
  'mon',
  'tue',
  'wed',
  'thu',
  'fri',
  'sat',
] as const;

export type ServiceDay = (typeof SERVICE_DAYS)[number];

export const TIME_WINDOWS = ['am', 'pm', 'flexible'] as const;
export type TimeWindow = (typeof TIME_WINDOWS)[number];

export const FREQUENCIES = [
  'weekly',
  'twice_weekly',
  'thrice_weekly',
  'daily',
  'biweekly',
] as const;
export type Frequency = (typeof FREQUENCIES)[number];

/** Earliest allowed first pickup — 10 calendar days from `from`. */
export function earliestPickupDate(from: Date = new Date()): Date {
  const d = new Date(from);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + 10);
  return d;
}

export function toIsoDate(d: Date): string {
  return d.toISOString().split('T')[0];
}

// Accept empty strings for the enum fields so persisted "" values from unmounted
// selects don't fail validation. superRefine enforces real values when !deferred.
export const step7Schema = z
  .object({
    deferred: z.boolean(),
    preferredDate: z.string().optional(),
    serviceDays: z.array(z.enum(SERVICE_DAYS)),
    timeWindow: z.union([z.enum(TIME_WINDOWS), z.literal('')]).optional(),
    frequency: z.union([z.enum(FREQUENCIES), z.literal('')]).optional(),
    driverNotes: z.string().max(500).optional(),
    // Pickup contact — required in both modes (V2)
    pickupContact: z.object({
      fullName: z.string().min(1, 'Enter the contact name'),
      mobilePhone: z.string().min(10, 'Enter a valid phone number'),
      storePhone: z
        .string()
        .optional()
        .refine(
          (v) => !v || v.length === 0 || v.length >= 10,
          'Enter a valid phone number',
        ),
    }),
  })
  .superRefine((v, ctx) => {
    if (v.deferred) return; // no further checks when deferring (pickupContact already validated above)

    if (!v.preferredDate) {
      ctx.addIssue({
        code: 'custom',
        path: ['preferredDate'],
        message: 'Pick a first pickup date or choose "I\u2019m not sure yet"',
      });
      return;
    }

    const earliest = earliestPickupDate();
    const picked = new Date(v.preferredDate);
    picked.setHours(0, 0, 0, 0);
    if (Number.isNaN(picked.getTime()) || picked < earliest) {
      ctx.addIssue({
        code: 'custom',
        path: ['preferredDate'],
        message: `Your first pickup must be at least 10 calendar days from today (${toIsoDate(earliest)} or later).`,
      });
    }

    if (!v.serviceDays || v.serviceDays.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['serviceDays'],
        message: 'Pick at least one ongoing service day',
      });
    }

    if (!v.frequency) {
      ctx.addIssue({
        code: 'custom',
        path: ['frequency'],
        message: 'Pick a pickup frequency',
      });
    }

    if (!v.timeWindow) {
      ctx.addIssue({
        code: 'custom',
        path: ['timeWindow'],
        message: 'Pick a time window',
      });
    }
  });

export type Step7Values = z.infer<typeof step7Schema>;

export const step7Defaults: Step7Values = {
  deferred: false,
  preferredDate: '',
  serviceDays: [],
  timeWindow: '',
  frequency: '',
  driverNotes: '',
  pickupContact: {
    fullName: '',
    mobilePhone: '',
    storePhone: '',
  },
};

/** Max number of every-two-weeks nudges we'll send before auto-closing the loop. */
export const MAX_DEFERRED_NUDGES = 6; // 6 × 2 weeks = 12 weeks
