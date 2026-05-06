import { z } from 'zod';

const US_STATES = [
  'AL','AK','AZ','AR','CA','CO','CT','DE','DC','FL','GA','HI','ID','IL','IN','IA',
  'KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM',
  'NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA',
  'WV','WI','WY','PR','VI','GU','AS','MP',
] as const;

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

export const step1Schema = z.object({
  legalName: z.string().min(1, 'Legal name is required'),
  storefrontName: z.string().min(1, 'Storefront name is required'),
  street: z.string().min(1, 'Street is required'),
  suite: z.string(),
  city: z.string().min(1, 'City is required'),
  state: z.enum(US_STATES, { message: 'Select a state' }),
  zip: z.string().regex(/^\d{5}(-\d{4})?$/, 'Enter a valid ZIP'),
  hours: z.object({
    mon: hoursDaySchema,
    tue: hoursDaySchema,
    wed: hoursDaySchema,
    thu: hoursDaySchema,
    fri: hoursDaySchema,
    sat: hoursDaySchema,
    sun: hoursDaySchema,
  }).refine(
    (h) => Object.values(h).some((d) => !d.closed),
    { message: 'At least one day must be open' },
  ),
  accessNotes: z.string(),
  primaryContact: z.object({
    name: z.string().min(1, 'Name is required'),
    email: z.string().email('Enter a valid email'),
    phone: z.string().min(10, 'Enter a valid phone number'),
  }),
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
  primaryContact: { name: '', email: '', phone: '' },
  bohManager:     { name: '', email: '', phone: '' },
};

export { US_STATES };
