import { z } from 'zod';

/**
 * Step 7 — Frequency, Service Start Timing, and First Pickup.
 *
 * Reworked 2026-07-21 per Amanda Kristoff's work list:
 *
 *   1. Frequency is asked FIRST (before any date selection).
 *   2. New field `serviceStartTiming` asks "When do you wish to begin service?"
 *      with 5 options: asap, 0_3mo, 3_6mo, 6_9mo, 9_12mo.
 *   3. Preferred date is:
 *        - required + Monday-only + within-timing-window when timing is
 *          asap / 0_3mo / 3_6mo (near-term commitment)
 *        - HIDDEN when timing is 6_9mo / 9_12mo (too far out to pin a date;
 *          we'll circle back based on check-back cadence).
 *   4. Time window (AM/PM/Flexible) removed entirely — routing wins over
 *      customer preference at scale.
 *   5. New field `checkBackCadence` collected when timing is 6_9mo / 9_12mo,
 *      or when the customer is "not sure yet" (deferred). Options:
 *      every_2_weeks, monthly, they_reach_out.
 *
 * `deferred: true` (the "not sure yet" toggle at the top of the step) still
 * bypasses date validation; in that mode we still capture frequency + check-
 * back cadence so ops can pre-plan and stay in touch.
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

export const FREQUENCIES = [
  'weekly',
  'twice_weekly',
  'thrice_weekly',
  'daily',
  'biweekly',
] as const;
export type Frequency = (typeof FREQUENCIES)[number];

export const SERVICE_START_TIMINGS = [
  'asap',
  '0_3mo',
  '3_6mo',
  '6_9mo',
  '9_12mo',
] as const;
export type ServiceStartTiming = (typeof SERVICE_START_TIMINGS)[number];

/** Near-term timings — require a concrete first pickup date. */
export const NEAR_TERM_TIMINGS: readonly ServiceStartTiming[] = [
  'asap',
  '0_3mo',
  '3_6mo',
];

/** Far-out timings — collect check-back cadence instead of a date. */
export const FAR_OUT_TIMINGS: readonly ServiceStartTiming[] = [
  '6_9mo',
  '9_12mo',
];

export const CHECK_BACK_CADENCES = [
  'every_2_weeks',
  'monthly',
  'they_reach_out',
] as const;
export type CheckBackCadence = (typeof CHECK_BACK_CADENCES)[number];

/**
 * Legacy — kept exported so nothing that still imports it breaks. No longer
 * used in the UI (Amanda removed the time-window question 2026-07-21).
 */
export const TIME_WINDOWS = ['am', 'pm', 'flexible'] as const;
export type TimeWindow = (typeof TIME_WINDOWS)[number];

/** Earliest allowed first pickup — 10 calendar days from `from`. */
export function earliestPickupDate(from: Date = new Date()): Date {
  const d = new Date(from);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + 10);
  return d;
}

/**
 * Latest allowed pickup date for a given timing.
 *   asap    → +6 weeks   (rough "as soon as we can route you in")
 *   0_3mo   → +3 months
 *   3_6mo   → +6 months
 * Far-out timings don't collect a date so they don't have a max.
 */
export function latestPickupDate(
  timing: ServiceStartTiming,
  from: Date = new Date(),
): Date | null {
  const d = new Date(from);
  d.setHours(0, 0, 0, 0);
  switch (timing) {
    case 'asap':
      d.setDate(d.getDate() + 42); // ~6 weeks
      return d;
    case '0_3mo':
      d.setMonth(d.getMonth() + 3);
      return d;
    case '3_6mo':
      d.setMonth(d.getMonth() + 6);
      return d;
    default:
      return null;
  }
}

export function toIsoDate(d: Date): string {
  return d.toISOString().split('T')[0];
}

/** Is the given YYYY-MM-DD string a Monday? */
export function isMonday(iso: string): boolean {
  if (!iso) return false;
  // Parse as local midnight to avoid TZ drift on the date input value.
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d) return false;
  const dt = new Date(y, m - 1, d);
  return dt.getDay() === 1; // 0=Sun, 1=Mon
}

/**
 * Generate up to `count` valid Monday ISO date strings inside the near-term
 * window for a given timing. Used by the UI's Monday-only date picker.
 */
export function nextMondays(
  timing: ServiceStartTiming,
  count = 26,
  from: Date = new Date(),
): string[] {
  const earliest = earliestPickupDate(from);
  const latest = latestPickupDate(timing, from);
  const out: string[] = [];
  const cursor = new Date(earliest);
  // Walk forward to the first Monday >= earliest
  while (cursor.getDay() !== 1) {
    cursor.setDate(cursor.getDate() + 1);
  }
  while (out.length < count) {
    if (latest && cursor > latest) break;
    out.push(toIsoDate(cursor));
    cursor.setDate(cursor.getDate() + 7);
  }
  return out;
}

export const step7Schema = z
  .object({
    deferred: z.boolean(),
    // Amanda 2026-07-21: frequency is now asked FIRST, before any date choice.
    frequency: z.union([z.enum(FREQUENCIES), z.literal('')]).optional(),
    // New — "When do you wish to begin service?"
    serviceStartTiming: z
      .union([z.enum(SERVICE_START_TIMINGS), z.literal('')])
      .optional(),
    // Only collected when serviceStartTiming is a near-term option.
    preferredDate: z.string().optional(),
    // Only collected when serviceStartTiming is far-out (6_9mo / 9_12mo) or
    // when the customer chose "not sure yet" (deferred: true).
    checkBackCadence: z
      .union([z.enum(CHECK_BACK_CADENCES), z.literal('')])
      .optional(),
    // Legacy — kept in schema so old submissions still parse cleanly. Not
    // populated by the current UI.
    serviceDays: z.array(z.enum(SERVICE_DAYS)).optional(),
    timeWindow: z.string().optional(),
    driverNotes: z.string().max(500).optional(),
  })
  .superRefine((v, ctx) => {
    // Frequency is always required (whether deferred or not) — the whole
    // point of asking it first is that ops needs it up front.
    if (!v.frequency) {
      ctx.addIssue({
        code: 'custom',
        path: ['frequency'],
        message: 'Pick a pickup frequency',
      });
    }

    if (v.deferred) {
      // "Not sure yet" mode — still capture cadence so we can nudge them.
      if (!v.checkBackCadence) {
        ctx.addIssue({
          code: 'custom',
          path: ['checkBackCadence'],
          message: 'How often should we check back in?',
        });
      }
      return;
    }

    // Committed mode — serviceStartTiming drives everything else.
    if (!v.serviceStartTiming) {
      ctx.addIssue({
        code: 'custom',
        path: ['serviceStartTiming'],
        message: 'When do you wish to begin service?',
      });
      return;
    }

    const timing = v.serviceStartTiming as ServiceStartTiming;
    const isNearTerm = (NEAR_TERM_TIMINGS as readonly string[]).includes(timing);
    const isFarOut = (FAR_OUT_TIMINGS as readonly string[]).includes(timing);

    if (isNearTerm) {
      // Near-term → require a Monday within [earliest, latest] window.
      if (!v.preferredDate) {
        ctx.addIssue({
          code: 'custom',
          path: ['preferredDate'],
          message: 'Pick a Monday to begin service',
        });
        return;
      }
      if (!isMonday(v.preferredDate)) {
        ctx.addIssue({
          code: 'custom',
          path: ['preferredDate'],
          message: 'Please pick a Monday',
        });
      }
      const earliest = earliestPickupDate();
      const [y, m, d] = v.preferredDate.split('-').map(Number);
      const picked = new Date(y, (m ?? 1) - 1, d ?? 1);
      picked.setHours(0, 0, 0, 0);
      if (Number.isNaN(picked.getTime()) || picked < earliest) {
        ctx.addIssue({
          code: 'custom',
          path: ['preferredDate'],
          message: `Your first pickup must be at least 10 calendar days from today (${toIsoDate(earliest)} or later).`,
        });
      }
      const latest = latestPickupDate(timing);
      if (latest && picked > latest) {
        ctx.addIssue({
          code: 'custom',
          path: ['preferredDate'],
          message: `That date is outside the "${timing}" window. Please pick a Monday on or before ${toIsoDate(latest)}.`,
        });
      }
    } else if (isFarOut) {
      // Far-out → require check-back cadence, no date needed.
      if (!v.checkBackCadence) {
        ctx.addIssue({
          code: 'custom',
          path: ['checkBackCadence'],
          message: 'How often should we check back in?',
        });
      }
    }
  });

export type Step7Values = z.infer<typeof step7Schema>;

export const step7Defaults: Step7Values = {
  deferred: false,
  frequency: '',
  serviceStartTiming: '',
  preferredDate: '',
  checkBackCadence: '',
  serviceDays: [],
  timeWindow: '',
  driverNotes: '',
};

/** Max number of every-two-weeks nudges we'll send before auto-closing the loop. */
export const MAX_DEFERRED_NUDGES = 6; // 6 × 2 weeks = 12 weeks
