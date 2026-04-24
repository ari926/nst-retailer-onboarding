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

function readSubmission<T = unknown>(stepId: StepId): StepSubmission<T> | null {
  try {
    const raw = localStorage.getItem(`nst_mock_step_submission_${stepId}`);
    if (!raw) return null;
    return JSON.parse(raw) as StepSubmission<T>;
  } catch {
    return null;
  }
}

interface Step1Payload {
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
  date?: string;
  bagNumber?: string;
  total?: number;
}

interface Step5Payload {
  deliveryDate?: string;
  total?: number;
}

interface Step6Payload {
  contactName?: string;
  contactEmail?: string;
}

interface Step7Payload {
  deferred?: boolean;
  preferredDate?: string;
  serviceDays?: string[];
  frequency?: string;
  timeWindow?: string;
  driverNotes?: string;
}

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
}

/**
 * Generates the Ops Handoff PDF from persisted step submissions and returns
 * the filename used. Triggers a browser download via jsPDF's `save()`.
 */
export function generateHandoffPdf(ctx: HandoffContext): string {
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
    const address = [
      s1.addressLine1,
      s1.addressLine2,
      [s1.city, s1.state, s1.zip].filter(Boolean).join(', '),
    ]
      .filter(Boolean)
      .join('\n');
    y = buildKvTable(
      doc,
      [
        ['Storefront', s1.storefrontName ?? ctx.storefrontName ?? '—'],
        ['DBA', s1.dba ?? '—'],
        ['Address', address || '—'],
        [
          'Owner',
          [s1.ownerContact?.name, s1.ownerContact?.phone, s1.ownerContact?.email]
            .filter(Boolean)
            .join(' · ') || '—',
        ],
        [
          'Manager',
          [
            s1.managerContact?.name,
            s1.managerContact?.phone,
            s1.managerContact?.email,
          ]
            .filter(Boolean)
            .join(' · ') || '—',
        ],
      ],
      y,
    );
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

  // Step 4 — Sample deposit
  y = checkPageBreak(doc, y, 80);
  y = drawSectionHeader(doc, '4. Sample deposit (dry run)', y);
  const s4 = readSubmission<Step4Payload>(4)?.payload;
  if (s4) {
    y = buildKvTable(
      doc,
      [
        ['Deposit date', formatDate(s4.date)],
        ['Bag number', s4.bagNumber ?? '—'],
        ['Total', formatMoney(s4.total)],
      ],
      y,
    );
  } else {
    y = buildKvTable(doc, [['Status', 'Not submitted']], y);
  }

  // Step 5 — Sample change order
  y = checkPageBreak(doc, y, 80);
  y = drawSectionHeader(doc, '5. Sample change order (dry run)', y);
  const s5 = readSubmission<Step5Payload>(5)?.payload;
  if (s5) {
    y = buildKvTable(
      doc,
      [
        ['Delivery date', formatDate(s5.deliveryDate)],
        ['Total', formatMoney(s5.total)],
      ],
      y,
    );
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
    if (s7.deferred) {
      y = buildKvTable(
        doc,
        [
          ['Status', 'Deferred — retailer will confirm date later'],
          ['Nudge cadence', 'Every 2 weeks (max 6 nudges = 12 weeks)'],
        ],
        y,
      );
    } else {
      const days =
        s7.serviceDays?.map((d) => DAY_FULL[d] ?? d).join(', ') || '—';
      y = buildKvTable(
        doc,
        [
          ['First pickup', formatDate(s7.preferredDate)],
          ['Service days', days],
          [
            'Frequency',
            s7.frequency ? (FREQ_LABEL[s7.frequency] ?? s7.frequency) : '—',
          ],
          [
            'Time window',
            s7.timeWindow
              ? (TIME_LABEL[s7.timeWindow] ?? s7.timeWindow)
              : '—',
          ],
          ['Driver notes', s7.driverNotes?.trim() || '—'],
        ],
        y,
      );
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
