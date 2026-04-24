import { z } from 'zod';

/**
 * Step 2 — Safe & keys
 *
 * Branching logic:
 *   - hasSmartSafe === 'yes'  -> safe make/model/serial + dashboard connection required
 *   - hasSmartSafe === 'no'   -> storageMethod required instead
 *
 * Always required:
 *   - at least one key holder (name + location)
 *   - provisional credit choice
 */

export const STORAGE_METHODS = ['under_counter', 'drop_safe', 'vault', 'other'] as const;
export const DASHBOARD_OPTIONS = ['direct', 'carrier', 'unsure'] as const;
export const PROVISIONAL_OPTIONS = ['already_set', 'want_to_set', 'no'] as const;

const keyHolderSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  role: z.string().optional(),
  location: z.string().min(1, 'Tell us where the key is kept'),
});

export const step2Schema = z
  .object({
    hasSmartSafe: z.enum(['yes', 'no'], { message: 'Pick one' }),

    // Smart safe branch
    safeMake: z.string().optional(),
    safeModel: z.string().optional(),
    safeSerial: z.string().optional(),
    dashboardConnection: z.enum(DASHBOARD_OPTIONS).optional(),

    // No-smart-safe branch
    storageMethod: z.enum(STORAGE_METHODS).optional(),
    storageMethodOther: z.string().optional(),

    // Always
    keyHolders: z
      .array(keyHolderSchema)
      .min(1, 'Add at least one key holder'),
    provisionalCredit: z.enum(PROVISIONAL_OPTIONS, { message: 'Pick one' }),
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
  provisionalCredit: 'no',
};
