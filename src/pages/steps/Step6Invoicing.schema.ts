import { z } from 'zod';

/**
 * Step 6 — Invoicing contact + sample invoice preview.
 *
 * NST invoices weekly. The retailer confirms a billing contact, and the
 * page exposes a "Preview Sample Invoice" button that opens the static
 * sample PDF inline so they know what real invoices look like.
 *
 * Validation:
 *   - contact_name required
 *   - contact_email required, RFC-5322-ish regex
 *
 * The previous `sendSample` checkbox + email send flow has been removed
 * in favor of inline PDF preview. The live weekly cadence is still
 * driven by the SFDC Scheduled Flow.
 */

const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const step6Schema = z.object({
  contactName: z
    .string()
    .min(2, 'Enter the billing contact\u2019s full name')
    .max(120),
  contactEmail: z
    .string()
    .min(1, 'Enter an email')
    .regex(emailRegex, 'Enter a valid email'),
});

export type Step6Values = z.infer<typeof step6Schema>;

export const step6Defaults: Step6Values = {
  contactName: '',
  contactEmail: '',
};
