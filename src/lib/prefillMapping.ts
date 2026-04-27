/**
 * Map the SFDC prefill bundle into per-step form defaults.
 *
 * Each helper returns a partial of the step's Values type. When merged into
 * the step's defaults, fields that SFDC has data for show up pre-populated;
 * empty SFDC fields fall through to the schema defaults.
 *
 * Conservative on purpose: if a field can't be cleanly mapped (e.g. parsing
 * a phone number, an unknown US state), we omit it rather than guess.
 */

import type { PrefillBundle } from './onboardingToken';
import type { Step1Values } from '../pages/steps/Step1Profile.schema';
import type { Step2Values } from '../pages/steps/Step2Safe.schema';
import { US_STATES } from '../pages/steps/Step1Profile.schema';

type Step1Hours = Step1Values['hours'];
type DayKey = keyof Step1Hours;

const DAY_KEYS: DayKey[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

/** Best-effort split of "First Last" or "Lastname, Firstname" into first/last. */
function splitFullName(full: string | null | undefined): { first: string; last: string } {
  if (!full) return { first: '', last: '' };
  const trimmed = full.trim();
  if (trimmed.includes(',')) {
    const [last, first] = trimmed.split(',').map((s) => s.trim());
    return { first: first ?? '', last: last ?? '' };
  }
  const parts = trimmed.split(/\s+/);
  if (parts.length === 1) return { first: parts[0], last: '' };
  return { first: parts[0], last: parts.slice(1).join(' ') };
}

/** Map an SFDC state value (full name, abbrev, or null) to a US_STATES code. */
function normalizeState(raw: string | null | undefined): Step1Values['state'] | null {
  if (!raw) return null;
  const upper = raw.trim().toUpperCase();
  if ((US_STATES as readonly string[]).includes(upper)) {
    return upper as Step1Values['state'];
  }
  // Map a few common full-name spellings.
  const map: Record<string, string> = {
    'PENNSYLVANIA': 'PA',
    'NEW YORK': 'NY',
    'NEW JERSEY': 'NJ',
    'CALIFORNIA': 'CA',
    'TEXAS': 'TX',
    'FLORIDA': 'FL',
    'ILLINOIS': 'IL',
    'MASSACHUSETTS': 'MA',
    'WASHINGTON': 'WA',
    'DISTRICT OF COLUMBIA': 'DC',
  };
  const code = map[upper];
  if (code && (US_STATES as readonly string[]).includes(code)) {
    return code as Step1Values['state'];
  }
  return null;
}

/** Try to parse a stored hours-of-operation JSON blob into Step1's hours grid. */
function parseHoursJson(raw: string | null | undefined): Partial<Step1Hours> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const out: Partial<Step1Hours> = {};
    for (const day of DAY_KEYS) {
      const v = (parsed as Record<string, unknown>)[day];
      if (
        v &&
        typeof v === 'object' &&
        'closed' in (v as Record<string, unknown>)
      ) {
        const dv = v as { closed?: boolean; open?: string; close?: string };
        out[day] = {
          closed: !!dv.closed,
          open: dv.open ?? '',
          close: dv.close ?? '',
        };
      }
    }
    return Object.keys(out).length ? out : null;
  } catch {
    return null;
  }
}

/** Step 1 — store profile + primary contact. */
export function mapPrefillToStep1(p: PrefillBundle | null): Partial<Step1Values> {
  if (!p) return {};
  const a = p.account;
  const c = p.primary_contact;
  const out: Partial<Step1Values> = {};

  if (a?.legal_name) out.legalName = a.legal_name;
  if (a?.name && a.name !== a.legal_name) out.storefrontName = a.name;
  // Fall back: if only legal_name is set, repeat it as storefront so the field isn't empty.
  if (!out.storefrontName && a?.name) out.storefrontName = a.name;

  const addr = a?.billing_address ?? a?.shipping_address ?? null;
  if (addr) {
    if (addr.street) out.street = addr.street;
    if (addr.city) out.city = addr.city;
    const st = normalizeState(addr.state);
    if (st) out.state = st;
    if (addr.zip) out.zip = addr.zip.split('-')[0];
  }

  // Primary contact (always present once Flow A has run).
  if (c) {
    const fullName =
      c.full_name ||
      [c.first_name, c.last_name].filter(Boolean).join(' ') ||
      '';
    out.primaryContact = {
      name: fullName,
      email: c.email ?? '',
      phone: c.phone ?? '',
    };
  }

  // Hours: SFDC stores a JSON blob if we've previously synced one.
  const hours = parseHoursJson(a?.hours_of_operation_json);
  if (hours) {
    out.hours = {
      mon: hours.mon ?? { closed: false, open: '09:00', close: '21:00' },
      tue: hours.tue ?? { closed: false, open: '09:00', close: '21:00' },
      wed: hours.wed ?? { closed: false, open: '09:00', close: '21:00' },
      thu: hours.thu ?? { closed: false, open: '09:00', close: '21:00' },
      fri: hours.fri ?? { closed: false, open: '09:00', close: '22:00' },
      sat: hours.sat ?? { closed: false, open: '10:00', close: '22:00' },
      sun: hours.sun ?? { closed: true, open: '', close: '' },
    };
  }

  if (a?.loading_dock_notes) out.accessNotes = a.loading_dock_notes;

  return out;
}

/** Step 2 — safe details. We don't have safe data on Account yet, but we can
 * still seed the BOH manager / first key holder from the primary contact. */
export function mapPrefillToStep2(p: PrefillBundle | null): Partial<Step2Values> {
  if (!p) return {};
  const c = p.primary_contact;
  if (!c) return {};
  const fullName =
    c.full_name || [c.first_name, c.last_name].filter(Boolean).join(' ');
  if (!fullName) return {};
  return {
    keyHolders: [
      { name: fullName, role: c.title ?? '', location: '' },
    ],
  };
}

// V2: banking step removed. mapPrefillToStep3 was deleted along with the
// Step3Banking schema. splitFullName is retained as a utility export in case
// other callers need it.

export { splitFullName };
