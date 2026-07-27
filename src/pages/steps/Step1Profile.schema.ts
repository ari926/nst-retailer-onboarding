import { z } from 'zod';

const US_STATES = [
  'AL','AK','AZ','AR','CA','CO','CT','DE','DC','FL','GA','HI','ID','IL','IN','IA',
  'KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM',
  'NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA',
  'WV','WI','WY','PR','VI','GU','AS','MP',
] as const;

/**
 * Step 1 — Business Card
 *
 * Reworked 2026-07-21 per Amanda Kristoff's work list + Ari's clarifications:
 *
 *   1. Owner is now first-class on the business card (name/email/phone). Owner
 *      is USUALLY the same person as the Primary Contact, so the Primary
 *      Contact card auto-fills from Owner via `primaryContactSameAsOwner`.
 *      A retailer can uncheck that box to enter a different primary contact.
 *   2. "Owner / Primary contact" card renamed to just "Primary Contact".
 *   3. Operating hours are mandatory (at least one day open) — surfaced in
 *      the UI as a required section, not just a soft validator.
 *   4. New `additionalContacts` array — optional secondary card where the
 *      retailer can add Manager / Assistant Manager / General Manager / Staff
 *      entries. Non-mandatory; used by ops for after-hours reach-outs.
 */

const hoursDaySchema = z
  .object({
    closed: z.boolean(),
    open: z.string(),
    close: z.string(),
  })
  .refine(
    (v) => v.closed || (v.open !== '' && v.close !== ''),
    { message: 'Open and close times are required unless closed', path: ['open'] },
  )
  .refine(
    (v) => v.closed || v.open < v.close,
    { message: 'Close time must be after open time', path: ['close'] },
  );

/** Roles allowed on the Additional Contacts card (Amanda's spec). */
export const ADDITIONAL_CONTACT_ROLES = [
  'manager',
  'assistant_manager',
  'general_manager',
  'staff',
] as const;
export type AdditionalContactRole = (typeof ADDITIONAL_CONTACT_ROLES)[number];

const additionalContactSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  role: z.enum(ADDITIONAL_CONTACT_ROLES, { message: 'Pick a role' }),
  email: z
    .union([z.string().email('Enter a valid email'), z.literal('')])
    .optional(),
  phone: z.string().optional(),
});

const ownerSchema = z.object({
  name: z.string().min(1, 'Owner name is required'),
  email: z.string().email('Enter a valid email'),
  phone: z.string().min(10, 'Enter a valid phone number'),
});

const primaryContactSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  email: z.string().email('Enter a valid email'),
  phone: z.string().min(10, 'Enter a valid phone number'),
});

export const step1Schema = z.object({
  legalName: z.string().min(1, 'Legal name is required'),
  storefrontName: z.string().min(1, 'Storefront name is required'),
  street: z.string().min(1, 'Street is required'),
  suite: z.string(),
  city: z.string().min(1, 'City is required'),
  state: z.enum(US_STATES, { message: 'Select a state' }),
  zip: z.string().regex(/^\d{5}(-\d{4})?$/, 'Enter a valid ZIP'),
  hours: z
    .object({
      mon: hoursDaySchema,
      tue: hoursDaySchema,
      wed: hoursDaySchema,
      thu: hoursDaySchema,
      fri: hoursDaySchema,
      sat: hoursDaySchema,
      sun: hoursDaySchema,
    })
    .refine(
      (h) => Object.values(h).some((d) => !d.closed),
      { message: 'At least one day must be open' },
    ),
  accessNotes: z.string(),

  // New 2026-07-21 — Owner is now on the business card.
  owner: ownerSchema,

  // Renamed from "Owner / Primary contact". When `primaryContactSameAsOwner`
  // is true, this is auto-filled from `owner` in the UI (still validated).
  primaryContact: primaryContactSchema,

  /** True when Primary Contact should mirror the Owner block. */
  primaryContactSameAsOwner: z.boolean(),

  /** Optional secondary contacts (Manager / Asst Mgr / GM / Staff). */
  additionalContacts: z.array(additionalContactSchema).optional(),

  bohManager: z.object({
    name: z.string(),
    email: z.union([z.string().email('Enter a valid email'), z.literal('')]),
    phone: z.string(),
  }),
});

export type Step1Values = z.infer<typeof step1Schema>;

export const step1Defaults: Step1Values = {
  legalName: '',
  storefrontName: '',
  street: '',
  suite: '',
  city: '',
  state: 'PA',
  zip: '',
  hours: {
    mon: { closed: false, open: '10:00', close: '18:00' },
    tue: { closed: false, open: '10:00', close: '18:00' },
    wed: { closed: false, open: '10:00', close: '18:00' },
    thu: { closed: false, open: '10:00', close: '18:00' },
    fri: { closed: false, open: '10:00', close: '18:00' },
    sat: { closed: false, open: '10:00', close: '18:00' },
    sun: { closed: false, open: '10:00', close: '18:00' },
  },
  accessNotes: '',
  owner: { name: '', email: '', phone: '' },
  primaryContact: { name: '', email: '', phone: '' },
  primaryContactSameAsOwner: true,
  additionalContacts: [],
  bohManager: { name: '', email: '', phone: '' },
};

export { US_STATES };
