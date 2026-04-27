import { z } from 'zod';

/**
 * Step 2 — Safe & keys
 *
 * Branching logic (V2):
 *   - hasSmartSafe === 'yes'  -> safe make/model/serial + dashboard connection
 *                                + key holders (≥1) + provisional credit choice
 *   - hasSmartSafe === 'no'   -> storageMethod ONLY
 *                                (key holders + provisional credit are hidden
 *                                 and not required)
 */

export const STORAGE_METHODS = ['under_counter', 'drop_safe', 'vault', 'other'] as const;
export const DASHBOARD_OPTIONS = ['direct', 'carrier', 'unsure'] as const;
export const PROVISIONAL_OPTIONS = ['already_set', 'want_to_set', 'no'] as const;

const keyHolderSchema = z.object({
  name: z.string(),
  role: z.string().optional(),
  location: z.string(),
});

export const step2Schema = z
  .object({
    hasSmartSafe: z.enum(['yes', 'no'], { message: 'Pick one' }),

    // Smart-safe branch
    safeMake: z.string().optional(),
    safeModel: z.string().optional(),
    safeSerial: z.string().optional(),
    dashboardConnection: z.enum(DASHBOARD_OPTIONS).optional(),

    // No-smart-safe branch
    storageMethod: z.enum(STORAGE_METHODS).optional(),
    storageMethodOther: z.string().optional(),

    // Conditional (only when hasSmartSafe === 'yes')
    keyHolders: z.array(keyHolderSchema).optional(),
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
      if (!v.safeSerial?.trim()) {
        ctx.addIssue({ code: 'custom', path: ['safeSerial'], message: 'Required' });
      }
      if (!v.dashboardConnection) {
        ctx.addIssue({ code: 'custom', path: ['dashboardConnection'], message: 'Required' });
      }

      // Key holders required only when Smart Safe is in play.
      if (!v.keyHolders || v.keyHolders.length === 0) {
        ctx.addIssue({
          code: 'custom',
          path: ['keyHolders'],
          message: 'Add at least one key holder',
        });
      } else {
        v.keyHolders.forEach((kh, idx) => {
          if (!kh.name?.trim()) {
            ctx.addIssue({
              code: 'custom',
              path: ['keyHolders', idx, 'name'],
              message: 'Name is required',
            });
          }
          if (!kh.location?.trim()) {
            ctx.addIssue({
              code: 'custom',
              path: ['keyHolders', idx, 'location'],
              message: 'Tell us where the key is kept',
            });
          }
        });
      }

      if (!v.provisionalCredit) {
        ctx.addIssue({
          code: 'custom',
          path: ['provisionalCredit'],
          message: 'Pick one',
        });
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
  safeSerial: '',
  dashboardConnection: undefined,
  storageMethod: undefined,
  storageMethodOther: '',
  keyHolders: [{ name: '', role: '', location: '' }],
  provisionalCredit: undefined,
};
