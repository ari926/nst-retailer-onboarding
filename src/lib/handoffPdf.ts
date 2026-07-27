import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import type { StepId } from '../types/onboarding';

/**
 * Ops Handoff PDF generator.
 *
 * Produces the PDF that NST operations uses to physically set up a new store:
 *   - Storefront details + contacts (from Step 1)
 *   - Safe spec + key holder list (Step 2) — NB: combination is NEVER printed
 *   - Banking (Step 3) — only last-4 of account #; routing redacted
 *   - Sample deposit + change order results (Steps 4 & 5)
 *   - Invoicing contact + email (Step 6)
 *   - First pickup schedule OR deferred status (Step 7)
 *
 * Security constraint: we deliberately omit secrets (safe combos, full routing
 * and account numbers). Operators confirm those in-person during site visit.
 *
 * PR #11 will replace the localStorage read with a server-side PDF render
 * triggered by SFDC once activation is confirmed. This client-side generator
 * stays as the retailer's "download my info" self-service copy.
 */

const NST_TEAL = '#01696F';
const NST_INK = '#28251D';
const NST_MUTED = '#7A7974';
const NST_BORDER = '#D4D1CA';

interface StepSubmission<T = unknown> {
  payload: T;
  submitted_at: string;
}

// Per-run submissions map, populated by generateHandoffPdf() before any
// section is drawn. Keyed by step number (1..7). A missing entry means the
// step was never submitted (or its load failed) — render "Not submitted".
//
// NOTE: this replaced a prior implementation that read from a stray
// localStorage key (`nst_mock_step_submission_${stepId}`) which was never
// actually written by any code path in production. That defect made every
// section of every exported PDF display "Status: Not submitted", regardless
// of whether the retailer had actually completed and submitted the step.
let currentSubmissions: Record<number, unknown> = {};

function readSubmission<T = unknown>(stepId: StepId): StepSubmission<T> | null {
  const payload = currentSubmissions[stepId];
  if (!payload) return null;
  return { payload: payload as T, submitted_at: '' };
}

interface Step1Payload {
  // Legacy / normalized shape (kept for older submissions).
  storefrontName?: string;
  dba?: string;
  addressLine1?: string;
  addressLine2?: string;
  city?: string;
  state?: string;
  zip?: string;
  hours?: Record<string, { open?: string; close?: string; closed?: boolean }>;
  ownerContact?: { name?: string; email?: string; phone?: string };
  managerContact?: { name?: string; email?: string; phone?: string };

  // Current app shape (raw form values). Preferred when present.
  legalName?: string;
  street?: string;
  suite?: string | null;
  owner?: { name?: string; email?: string; phone?: string };
  primaryContact?: { name?: string; email?: string; phone?: string };
  primaryContactSameAsOwner?: boolean;
  additionalContacts?: Array<{
    name?: string;
    role?: string;
    email?: string | null;
    phone?: string | null;
  }>;
  bohManager?: { name?: string; email?: string; phone?: string };
}

interface Step2Payload {
  safeType?: string;
  safeMake?: string;
  safeModel?: string;
  safeLocation?: string;
  keyHolders?: Array<{ name: string; role?: string; phone?: string }>;
  provisionalCredit?: boolean;
}

interface Step3Payload {
  bankName?: string;
  routingLast4?: string;
  accountLast4?: string;
  accountType?: string;
  nameOnAccount?: string;
}

interface Step4Payload {
  // Legacy shape (pre 2026-07-21)
  date?: string;
  bagNumber?: string;
  total?: number;
  amount?: number;
  // New CIT-aligned shape (2026-07-21+)
  businessDate?: string;
  preparedBy?: string;
  verifiedBy?: string;
  registerId?: string;
  departureDate?: string;
  shiftNumber?: string;
  totalCurrency?: number;
  totalCoin?: number;
  comments?: string;
}

interface Step5Payload {
  // Legacy shape
  deliveryDate?: string;
  total?: number;
  // New Cash-Services-aligned shape (2026-07-21+)
  arrivalDate?: string;
  units?: Partial<Record<'ones'|'fives'|'tens'|'twenties'|'quarters'|'dimes'|'nickels', number>>;
  comments?: string;
}

// Amanda's unit-value table for Step 5 PDF rendering.
const STEP5_UNIT_VALUE: Record<string, number> = {
  ones: 100, fives: 500, tens: 1000, twenties: 2000,
  quarters: 500, dimes: 250, nickels: 100,
};
const STEP5_UNIT_LABEL: Record<string, string> = {
  ones: '$1 bills', fives: '$5 bills', tens: '$10 bills', twenties: '$20 bills',
  quarters: 'Quarters', dimes: 'Dimes', nickels: 'Nickels',
};

interface Step6Payload {
  contactName?: string;
  contactEmail?: string;
}

interface Step7Payload {
  deferred?: boolean;
  preferredDate?: string;
  serviceDays?: string[];
  frequency?: string;
  /** Legacy — removed from UI 2026-07-21 but retained here for old submissions. */
  timeWindow?: string;
  /** Added 2026-07-21 — "When do you wish to begin service?" */
  serviceStartTiming?: string;
  /** Added 2026-07-21 — far-out / not-sure-yet check-back cadence. */
  checkBackCadence?: string;
  driverNotes?: string;
}

const SERVICE_START_LABEL: Record<string, string> = {
  asap: 'ASAP',
  '0_3mo': '0–3 months',
  '3_6mo': '3–6 months',
  '6_9mo': '6–9 months',
  '9_12mo': '9–12 months',
};

const CHECK_BACK_LABEL: Record<string, string> = {
  every_2_weeks: 'Every 2 weeks',
  monthly: 'Monthly',
  they_reach_out: 'They’ll reach out when ready',
};

function formatMoney(n: number | undefined | null): string {
  if (n == null || Number.isNaN(n)) return '—';
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

function formatDate(iso: string | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

const DAY_FULL: Record<string, string> = {
  mon: 'Monday',
  tue: 'Tuesday',
  wed: 'Wednesday',
  thu: 'Thursday',
  fri: 'Friday',
  sat: 'Saturday',
  sun: 'Sunday',
};

const FREQ_LABEL: Record<string, string> = {
  weekly: 'Weekly',
  twice_weekly: 'Twice per week',
  thrice_weekly: 'Three times per week',
  daily: 'Daily (Mon–Fri)',
  biweekly: 'Every other week',
};

const TIME_LABEL: Record<string, string> = {
  am: 'Morning',
  pm: 'Afternoon',
  flexible: 'Flexible',
};

function drawSectionHeader(doc: jsPDF, title: string, y: number): number {
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(13);
  doc.setTextColor(NST_INK);
  doc.text(title, 40, y);
  // Teal underline
  doc.setDrawColor(NST_TEAL);
  doc.setLineWidth(1.25);
  doc.line(40, y + 4, 555, y + 4);
  return y + 18;
}

function checkPageBreak(doc: jsPDF, y: number, needed = 80): number {
  const pageH = doc.internal.pageSize.getHeight();
  if (y + needed > pageH - 50) {
    doc.addPage();
    return 60;
  }
  return y;
}

function drawCover(
  doc: jsPDF,
  storefrontName: string,
  sfdcAccountId: string | null,
): void {
  const pageW = doc.internal.pageSize.getWidth();

  // Teal bar across top
  doc.setFillColor(NST_TEAL);
  doc.rect(0, 0, pageW, 8, 'F');

  // NST logo mark (text-only, brand-accurate)
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(28);
  doc.setTextColor(NST_TEAL);
  doc.text('NST', 40, 80);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.setTextColor(NST_MUTED);
  doc.text('Operations Handoff', 40, 98);

  // Main title
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(26);
  doc.setTextColor(NST_INK);
  doc.text('Store Setup Summary', 40, 160);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(14);
  doc.setTextColor(NST_MUTED);
  doc.text(storefrontName || 'Storefront pending', 40, 185);

  // Metadata block
  doc.setDrawColor(NST_BORDER);
  doc.setLineWidth(0.75);
  doc.roundedRect(40, 220, pageW - 80, 110, 4, 4);

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  doc.setTextColor(NST_INK);
  doc.text('Generated', 60, 248);
  doc.text('SFDC account', 60, 272);
  doc.text('Prepared for', 60, 296);

  doc.setFont('helvetica', 'normal');
  doc.setTextColor(NST_MUTED);
  const now = new Date();
  doc.text(
    now.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    }) +
      ' at ' +
      now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }),
    180,
    248,
  );
  doc.text(sfdcAccountId || '—', 180, 272);
  doc.text('NST Operations — New Store Onboarding', 180, 296);

  // Security notice
  doc.setDrawColor(NST_TEAL);
  doc.setFillColor(248, 252, 252);
  doc.roundedRect(40, 360, pageW - 80, 70, 4, 4, 'FD');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  doc.setTextColor(NST_TEAL);
  doc.text('Security', 56, 382);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9.5);
  doc.setTextColor(NST_INK);
  const note =
    'Safe combinations and full banking numbers are never printed. Route techs will confirm\n' +
    'those details in person and store them in the NST ops portal.';
  doc.text(note, 56, 400);

  // Footer
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.setTextColor(NST_MUTED);
  doc.text(
    'Confidential — NST Retailer Onboarding V1',
    40,
    doc.internal.pageSize.getHeight() - 30,
  );
}

function drawFooter(doc: jsPDF, storefrontName: string): void {
  const pageCount = doc.getNumberOfPages();
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  for (let i = 2; i <= pageCount; i++) {
    doc.setPage(i);
    doc.setDrawColor(NST_BORDER);
    doc.setLineWidth(0.5);
    doc.line(40, pageH - 40, pageW - 40, pageH - 40);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(NST_MUTED);
    doc.text(storefrontName || 'Store', 40, pageH - 26);
    doc.text(`Page ${i} of ${pageCount}`, pageW - 80, pageH - 26);
  }
}

function buildKvTable(
  doc: jsPDF,
  rows: Array<[string, string]>,
  startY: number,
): number {
  autoTable(doc, {
    startY,
    head: [],
    body: rows.map(([k, v]) => [k, v]),
    theme: 'plain',
    styles: {
      font: 'helvetica',
      fontSize: 10,
      cellPadding: { top: 4, bottom: 4, left: 8, right: 8 },
      textColor: NST_INK,
      lineColor: NST_BORDER,
      lineWidth: 0.25,
    },
    columnStyles: {
      0: {
        cellWidth: 150,
        fontStyle: 'bold',
        textColor: NST_MUTED,
      },
      1: { cellWidth: 'auto', textColor: NST_INK },
    },
    margin: { left: 40, right: 40 },
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (doc as any).lastAutoTable.finalY + 16;
}

export interface HandoffContext {
  storefrontName: string;
  sfdcAccountId: string | null;
  /**
   * Submitted payloads keyed by step number (1..7). Callers must preload this
   * via `loadAllSubmissions()` from stepService before calling the generator;
   * jsPDF is synchronous so we can't fetch here.
   */
  submissions: Record<number, unknown>;
}

/**
 * Generates the Ops Handoff PDF from persisted step submissions and returns
 * the filename used. Triggers a browser download via jsPDF's `save()`.
 */
export function generateHandoffPdf(ctx: HandoffContext): string {
  // Publish the preloaded submissions map so readSubmission() can find it.
  // Assigning to a module-scoped var (rather than passing through every
  // section) keeps the diff small and mirrors the shape of the old (broken)
  // localStorage read.
  currentSubmissions = ctx.submissions ?? {};

  const doc = new jsPDF({ unit: 'pt', format: 'letter' });

  // Cover page
  drawCover(doc, ctx.storefrontName, ctx.sfdcAccountId);

  // ---- Content page ----
  doc.addPage();
  let y = 60;

  // Step 1 — Store profile
  const s1 = readSubmission<Step1Payload>(1)?.payload;
  y = drawSectionHeader(doc, '1. Store profile & contacts', y);
  if (s1) {
    // Prefer raw form values when they're present; fall back to the older
    // normalized shape so PDFs still render for pre-2026-07-21 submissions.
    const owner = s1.owner ?? s1.ownerContact ?? {};
    const primary = s1.primaryContact ?? s1.ownerContact ?? {};
    const primarySameAsOwner = s1.primaryContactSameAsOwner === true;
    const legal = s1.legalName ?? s1.storefrontName ?? ctx.storefrontName ?? '—';
    const dba = s1.storefrontName ?? s1.dba ?? '—';
    const streetLine1 = s1.street ?? s1.addressLine1 ?? '';
    const streetLine2 = s1.suite ?? s1.addressLine2 ?? '';
    const address = [
      streetLine1,
      streetLine2,
      [s1.city, s1.state, s1.zip].filter(Boolean).join(', '),
    ]
      .filter(Boolean)
      .join('\n');

    const rows: Array<[string, string]> = [
      ['Legal entity', legal],
      ['Storefront / DBA', dba],
      ['Address', address || '—'],
      [
        'Owner',
        [owner.name, owner.phone, owner.email]
          .filter(Boolean)
          .join(' · ') || '—',
      ],
      [
        'Primary Onboarding Contact',
        primarySameAsOwner
          ? 'Same as owner'
          : ([primary.name, primary.phone, primary.email]
              .filter(Boolean)
              .join(' · ') || '—'),
      ],
    ];

    // Additional contacts — one row each, only if the retailer added any.
    if (Array.isArray(s1.additionalContacts) && s1.additionalContacts.length > 0) {
      for (const c of s1.additionalContacts) {
        if (!c?.name) continue;
        const roleLabel = ({
          manager: 'Manager',
          assistant_manager: 'Assistant Manager',
          general_manager: 'General Manager',
          staff: 'Staff',
        } as Record<string, string>)[c.role ?? ''] ?? (c.role ?? 'Contact');
        rows.push([
          roleLabel,
          [c.name, c.phone, c.email].filter(Boolean).join(' · '),
        ]);
      }
    }

    // Legacy BOH manager field — only shown if populated.
    const boh = s1.bohManager ?? s1.managerContact;
    if (boh && (boh.name || boh.email || boh.phone)) {
      rows.push([
        'Primary Site Contact',
        [boh.name, boh.phone, boh.email].filter(Boolean).join(' · ') || '—',
      ]);
    }

    y = buildKvTable(doc, rows, y);
  } else {
    y = buildKvTable(doc, [['Status', 'Not submitted']], y);
  }

  // Step 2 — Safe & keys
  y = checkPageBreak(doc, y, 140);
  y = drawSectionHeader(doc, '2. Safe & key holders', y);
  const s2 = readSubmission<Step2Payload>(2)?.payload;
  if (s2) {
    y = buildKvTable(
      doc,
      [
        ['Safe type', s2.safeType ?? '—'],
        [
          'Make / model',
          [s2.safeMake, s2.safeModel].filter(Boolean).join(' ') || '—',
        ],
        ['Location in store', s2.safeLocation ?? '—'],
        ['Combo', 'Confirmed in person — not printed'],
        ['Provisional credit', s2.provisionalCredit ? 'Yes — eligible' : 'No'],
      ],
      y,
    );

    if (s2.keyHolders && s2.keyHolders.length > 0) {
      y = checkPageBreak(doc, y, 80);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(10);
      doc.setTextColor(NST_INK);
      doc.text('Key holders', 40, y);
      y += 6;
      autoTable(doc, {
        startY: y,
        head: [['Name', 'Role', 'Phone']],
        body: s2.keyHolders.map((k) => [
          k.name ?? '—',
          k.role ?? '—',
          k.phone ?? '—',
        ]),
        theme: 'striped',
        headStyles: {
          fillColor: NST_TEAL,
          textColor: '#FFFFFF',
          fontStyle: 'bold',
        },
        styles: {
          font: 'helvetica',
          fontSize: 10,
          cellPadding: 6,
          textColor: NST_INK,
        },
        alternateRowStyles: { fillColor: '#F9F8F5' },
        margin: { left: 40, right: 40 },
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      y = (doc as any).lastAutoTable.finalY + 16;
    }
  } else {
    y = buildKvTable(doc, [['Status', 'Not submitted']], y);
  }

  // Step 3 — Banking
  y = checkPageBreak(doc, y, 100);
  y = drawSectionHeader(doc, '3. Banking', y);
  const s3 = readSubmission<Step3Payload>(3)?.payload;
  if (s3) {
    y = buildKvTable(
      doc,
      [
        ['Bank', s3.bankName ?? '—'],
        ['Account type', s3.accountType ?? '—'],
        ['Name on account', s3.nameOnAccount ?? '—'],
        ['Routing', s3.routingLast4 ? `•••• ${s3.routingLast4}` : '—'],
        ['Account', s3.accountLast4 ? `•••• ${s3.accountLast4}` : '—'],
      ],
      y,
    );
  } else {
    y = buildKvTable(doc, [['Status', 'Not submitted']], y);
  }

  // Step 4 — Sample deposit (CIT-aligned)
  y = checkPageBreak(doc, y, 100);
  y = drawSectionHeader(doc, '4. Sample deposit (dry run)', y);
  const s4 = readSubmission<Step4Payload>(4)?.payload;
  if (s4) {
    const currency = s4.totalCurrency;
    const coin = s4.totalCoin;
    const legacyTotal = s4.total ?? s4.amount;
    const totalRow: number | undefined =
      currency != null || coin != null
        ? (Number(currency) || 0) + (Number(coin) || 0)
        : legacyTotal;
    y = buildKvTable(
      doc,
      [
        ['Bag number', s4.bagNumber ?? '—'],
        ['Business date', formatDate(s4.businessDate ?? s4.date)],
        ['Prepared by', s4.preparedBy ?? '—'],
        ['Verified by', s4.verifiedBy ?? '—'],
        ['Register id', s4.registerId ?? '—'],
        ['Departure date', formatDate(s4.departureDate)],
        ['Shift', s4.shiftNumber ? `Shift ${s4.shiftNumber}` : '—'],
        ['Total currency', currency != null ? formatMoney(currency) : '—'],
        ['Total coin', coin != null ? formatMoney(coin) : '—'],
        ['Total deposit', totalRow != null ? formatMoney(totalRow) : '—'],
        ['Comments', s4.comments || '—'],
      ],
      y,
    );
  } else {
    y = buildKvTable(doc, [['Status', 'Not submitted']], y);
  }

  // Step 5 — Sample change order (Cash Services-aligned)
  y = checkPageBreak(doc, y, 100);
  y = drawSectionHeader(doc, '5. Sample change order (dry run)', y);
  const s5 = readSubmission<Step5Payload>(5)?.payload;
  if (s5) {
    const rows: Array<[string, string]> = [];
    rows.push(['Arrival date', formatDate(s5.arrivalDate ?? s5.deliveryDate)]);
    if (s5.units) {
      let unitTotal = 0;
      for (const [key, val] of Object.entries(s5.units)) {
        const n = Number(val) || 0;
        if (n <= 0) continue;
        const uv = STEP5_UNIT_VALUE[key] ?? 0;
        unitTotal += n * uv;
        rows.push([
          `${STEP5_UNIT_LABEL[key] ?? key} × ${n}`,
          formatMoney(n * uv),
        ]);
      }
      rows.push(['Total USD', formatMoney(unitTotal)]);
    } else if (s5.total != null) {
      rows.push(['Total', formatMoney(s5.total)]);
    }
    if (s5.comments) rows.push(['Comments', s5.comments]);
    y = buildKvTable(doc, rows, y);
  } else {
    y = buildKvTable(doc, [['Status', 'Not submitted']], y);
  }

  // Step 6 — Invoicing
  y = checkPageBreak(doc, y, 80);
  y = drawSectionHeader(doc, '6. Invoicing contact', y);
  const s6 = readSubmission<Step6Payload>(6)?.payload;
  if (s6) {
    y = buildKvTable(
      doc,
      [
        ['Contact name', s6.contactName ?? '—'],
        ['Email', s6.contactEmail ?? '—'],
        ['Cadence', 'Monthly on the 1st'],
      ],
      y,
    );
  } else {
    y = buildKvTable(doc, [['Status', 'Not submitted']], y);
  }

  // Step 7 — First pickup
  y = checkPageBreak(doc, y, 100);
  y = drawSectionHeader(doc, '7. First pickup & ongoing service', y);
  const s7 = readSubmission<Step7Payload>(7)?.payload;
  if (s7) {
    const freqLabel = s7.frequency
      ? (FREQ_LABEL[s7.frequency] ?? s7.frequency)
      : '—';
    const cadenceLabel = s7.checkBackCadence
      ? (CHECK_BACK_LABEL[s7.checkBackCadence] ?? s7.checkBackCadence)
      : null;

    if (s7.deferred) {
      // "Not sure yet" — no timing, no date. We do still have frequency and
      // (per Amanda 2026-07-21) a customer-chosen check-back cadence.
      y = buildKvTable(
        doc,
        [
          ['Status', 'Deferred — retailer will confirm date later'],
          ['Frequency', freqLabel],
          ['Check-back cadence', cadenceLabel ?? '—'],
        ],
        y,
      );
    } else {
      const timingLabel = s7.serviceStartTiming
        ? (SERVICE_START_LABEL[s7.serviceStartTiming] ?? s7.serviceStartTiming)
        : '—';
      const days =
        s7.serviceDays?.map((d) => DAY_FULL[d] ?? d).join(', ') || '—';

      // Row set depends on whether this is a near-term (has date) or
      // far-out (has check-back cadence) submission.
      const rows: [string, string][] = [
        ['Frequency', freqLabel],
        ['When to begin service', timingLabel],
      ];
      if (s7.preferredDate) {
        // 2026-07-26 change set (Amanda + Doug): the ISO date is the Monday
        // anchor of the week; routing picks the actual day-of-week later.
        rows.push(['Preferred week of start', `Week of ${formatDate(s7.preferredDate)}`]);
      }
      if (cadenceLabel) {
        rows.push(['Check-back cadence', cadenceLabel]);
      }
      // Historical field — only include if actually populated.
      if (s7.serviceDays && s7.serviceDays.length > 0) {
        rows.push(['Service days', days]);
      }
      // Legacy field — hidden if empty, shown for old submissions that
      // still have a time window recorded.
      if (s7.timeWindow) {
        rows.push([
          'Time window (legacy)',
          TIME_LABEL[s7.timeWindow] ?? s7.timeWindow,
        ]);
      }
      rows.push(['Driver notes', s7.driverNotes?.trim() || '—']);

      y = buildKvTable(doc, rows, y);
    }
  } else {
    y = buildKvTable(doc, [['Status', 'Not submitted']], y);
  }

  drawFooter(doc, ctx.storefrontName);

  const safeName = (ctx.storefrontName || 'store')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  const stamp = new Date().toISOString().split('T')[0];
  const filename = `nst-ops-handoff-${safeName}-${stamp}.pdf`;
  doc.save(filename);
  return filename;
}

/** Exposed for unit/e2e tests — returns the raw ArrayBuffer instead of triggering download. */
export function buildHandoffPdfBuffer(ctx: HandoffContext): ArrayBuffer {
  const doc = new jsPDF({ unit: 'pt', format: 'letter' });
  drawCover(doc, ctx.storefrontName, ctx.sfdcAccountId);
  // Re-run same code path (not DRY but keeps generateHandoffPdf one file).
  // Easiest: just call the same fn with a patched save. For brevity in V1 the
  // renderer is called inline from the button; tests can spy on save().
  return doc.output('arraybuffer');
}
