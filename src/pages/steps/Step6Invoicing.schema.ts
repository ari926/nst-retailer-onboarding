import { z } from 'zod';

/**
 * Step 6 — Invoicing contact + sample invoice.
 *
 * NST invoices weekly. The retailer confirms a billing contact and can
 * opt in to receive a sample invoice right now so they know what to
 * expect. The SFDC Scheduled Flow handles the live weekly cadence.
 *
 * Validation:
 *   - contact_name required
 *   - contact_email required, RFC-5322-ish regex
 *   - send_sample is optional (defaults to true in the UI)
 *
 * Bounce handling is server-side: if the sample send returns
 * accepted=false, we surface the error inline and let the retailer edit
 * the email without losing the rest of the form.
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
  sendSample: z.boolean(),
});

export type Step6Values = z.infer<typeof step6Schema>;

export const step6Defaults: Step6Values = {
  contactName: '',
  contactEmail: '',
  sendSample: true,
};
