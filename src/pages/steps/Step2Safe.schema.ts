import { z } from 'zod';

/**
 * Step 2 — Safe & keys
 *
 * Branching logic:
 *   - hasSmartSafe === 'yes'  -> safe make/model + free-text dashboardConnection description required
 *                             -> provisional credit choice required
 *   - hasSmartSafe === 'no'   -> storageMethod required instead
 *                             -> provisional credit is HIDDEN (only applies to SmartSafe)
 *
 * Always required:
 *   - at least one key holder (name; role is optional)
 *
 * NOTE history:
 *   - 2026-07-21 (Amanda): removed "where keys are kept" question. Kept name + role only.
 *   - 2026-07-26 (Amanda + Doug): removed SmartSafe serial number question. Customers rarely
 *     have the serial on hand. Also replaced the enum dashboardConnection radio
 *     (direct / carrier / unsure) with an open-ended free-text field prompted:
 *       "How will your safe connect to the dashboard, and does it require internet access?"
 *     The old field name `dashboardConnection` is kept for backwards compatibility with
 *     older drafts, but its type is now `string` instead of an enum.
 */

export const STORAGE_METHODS = ['under_counter', 'drop_safe', 'vault', 'other'] as const;
// Legacy enum retained only for migration of old drafts persisted before 2026-07-26.
// New drafts use a free-text `dashboardConnection` string.
export const LEGACY_DASHBOARD_OPTIONS = ['direct', 'carrier', 'unsure'] as const;
export const PROVISIONAL_OPTIONS = ['already_set', 'want_to_set', 'no'] as const;

const keyHolderSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  role: z.string().optional(),
});

export const step2Schema = z
  .object({
    hasSmartSafe: z.enum(['yes', 'no'], { message: 'Pick one' }),

    // Smart safe branch
    safeMake: z.string().optional(),
    safeModel: z.string().optional(),
    // 2026-07-26 free-text replacement for the old enum dashboardConnection question.
    // Kept the same field name so persisted drafts still round-trip.
    dashboardConnection: z.string().optional(),

    // No-smart-safe branch
    storageMethod: z.enum(STORAGE_METHODS).optional(),
    storageMethodOther: z.string().optional(),

    // Always
    keyHolders: z
      .array(keyHolderSchema)
      .min(1, 'Add at least one key holder'),
    // Only required when hasSmartSafe === 'yes' (see superRefine below).
    provisionalCredit: z.enum(PROVISIONAL_OPTIONS).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.hasSmartSafe === 'yes') {
      if (!v.safeMake?.trim()) {
        ctx.addIssue({ code: 'custom', path: ['safeMake'], message: 'Required' });
      }
      if (!v.safeModel?.trim()) {
        ctx.addIssue({ code: 'custom', path: ['safeModel'], message: 'Required' });
      }
      if (!v.dashboardConnection?.trim()) {
        ctx.addIssue({ code: 'custom', path: ['dashboardConnection'], message: 'Please describe how the safe connects to the dashboard.' });
      }
      if (!v.provisionalCredit) {
        ctx.addIssue({ code: 'custom', path: ['provisionalCredit'], message: 'Pick one' });
      }
    } else if (v.hasSmartSafe === 'no') {
      if (!v.storageMethod) {
        ctx.addIssue({ code: 'custom', path: ['storageMethod'], message: 'Required' });
      }
      if (v.storageMethod === 'other' && !v.storageMethodOther?.trim()) {
        ctx.addIssue({
          code: 'custom',
          path: ['storageMethodOther'],
          message: 'Please describe',
        });
      }
    }
  });

export type Step2Values = z.infer<typeof step2Schema>;

export const step2Defaults: Step2Values = {
  hasSmartSafe: 'no',
  safeMake: '',
  safeModel: '',
  dashboardConnection: '',
  storageMethod: undefined,
  storageMethodOther: '',
  keyHolders: [{ name: '', role: '' }],
  provisionalCredit: undefined,
};
