import { z } from 'zod';

/**
 * Step 3 — Banking details.
 *
 * Two submission modes:
 *   1. Review + match  -> retailer confirms OCR'd values match their records.
 *                         submit shape: { matches: true, ...ocrData }
 *   2. Flag mismatch   -> retailer reports what's wrong; Ops fixes in SFDC.
 *                         submit shape: { matches: false, mismatchNotes, ...ocrData }
 *   3. Manual entry    -> OCR failed (or retailer overrode); retailer typed values.
 *                         submit shape: { matches: true, source: 'manual', ...typed }
 */

export const step3Schema = z
  .object({
    source: z.enum(['ocr', 'manual']),
    bankName: z.string().min(1, 'Required'),
    accountLast4: z
      .string()
      .regex(/^\d{4}$/, 'Must be the last 4 digits of your account number'),
    routingNumber: z
      .string()
      .regex(/^\d{9}$/, 'Routing number must be 9 digits'),
    signerName: z.string().min(1, 'Required'),

    matches: z.boolean(),
    mismatchNotes: z.string().optional(),
  })
  .superRefine((v, ctx) => {
    if (!v.matches && !v.mismatchNotes?.trim()) {
      ctx.addIssue({
        code: 'custom',
        path: ['mismatchNotes'],
        message: "Tell us what doesn't match so we can fix it.",
      });
    }
  });

export type Step3Values = z.infer<typeof step3Schema>;

export const step3Defaults: Step3Values = {
  source: 'ocr',
  bankName: '',
  accountLast4: '',
  routingNumber: '',
  signerName: '',
  matches: true,
  mismatchNotes: '',
};
