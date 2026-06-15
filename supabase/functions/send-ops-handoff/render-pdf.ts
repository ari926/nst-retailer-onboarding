// supabase/functions/send-ops-handoff/render-pdf.ts
//
// Server-side ops handoff PDF — V2 ONE-PAGE LAYOUT.
//
// Design intent (locked with Ari, 2026-04-26):
//   - Single page (US Letter). Compact header instead of full cover.
//   - Sections 4 (sample deposit) + 5 (sample change order) DROPPED entirely.
//   - Section 6 (invoicing) is suppressed if no contactName + contactEmail.
//   - Banking + Invoicing rendered side-by-side to save vertical space.
//   - Safe details + pickup details use 2-column row pairs.
//   - "Combo not printed" / "Routing not printed" rows removed; footer covers it.
//   - Key holder table soft-capped at 6 rows (rest noted as "+N more in SF").
//
// Security guarantees (unchanged from V1):
//   - Safe combinations are NEVER rendered — even partial.
//   - Full routing + full account numbers are NEVER rendered. Only last-4
//     of the account # is included.
//
// Imports: jsPDF + jspdf-autotable via esm.sh (Deno-compatible).

// deno-lint-ignore-file no-explicit-any
import jsPDF from 'https://esm.sh/jspdf@2.5.1';
import autoTable from 'https://esm.sh/jspdf-autotable@3.8.2?deps=jspdf@2.5.1';

const NST_TEAL = '#01696F';
const NST_INK = '#28251D';
const NST_MUTED = '#7A7974';
const NST_BORDER = '#D4D1CA';
const NST_ROW_BORDER = '#ECEAE3';
const NST_CALLOUT_BG = '#F2F8F8';
const NST_STRIPE = '#F9F8F5';

// --- Page geometry (US Letter, 72dpi → 612 x 792 pt) -----------------------
const PAGE_W = 612;
const PAGE_H = 792;
const MARGIN_X = 36;
const CONTENT_W = PAGE_W - MARGIN_X * 2; // 540pt
const COL_GAP = 18;
const COL_W = (CONTENT_W - COL_GAP) / 2; // each column ~261pt

const KEY_HOLDER_ROW_CAP = 6; // rows beyond this collapse into "+N more in SF"

// --- Payload shapes (compatible with the production submitted_data JSONB) --

export interface Step1Payload {
  legalName?: string;
  storefrontName?: string;
  dba?: string;
  street?: string;
  suite?: string;
  addressLine1?: string;
  addressLine2?: string;
  city?: string;
  state?: string;
  zip?: string;
  hours?: Record<string, { open?: string; close?: string; closed?: boolean }>;
  primaryContact?: { name?: string; email?: string; phone?: string };
  ownerContact?: { name?: string; email?: string; phone?: string };
  bohManager?: { name?: string; email?: string; phone?: string };
  managerContact?: { name?: string; email?: string; phone?: string };
  accessNotes?: string;
}

export interface Step2Payload {
  hasSmartSafe?: 'yes' | 'no';
  safeType?: string;
  safeMake?: string;
  safeModel?: string;
  safeSerial?: string;
  safeLocation?: string;
  storageMethod?: string;
  keyHolders?: Array<{ name?: string; role?: string; phone?: string }>;
}

export interface Step3Payload {
  bankName?: string;
  accountLast4?: string;
  accountType?: string;
  signerName?: string;
  nameOnAccount?: string;
}

// Steps 4 + 5 intentionally have no shape — V2 PDF excludes them.

export interface Step6Payload {
  contactName?: string;
  contactEmail?: string;
  contactPhone?: string;
}

export interface Step7Payload {
  deferred?: boolean;
  preferredDate?: string;
  serviceDays?: string[];
  frequency?: string;
  timeWindow?: string;
  driverNotes?: string;
}

export interface SubmissionsMap {
  1?: Step1Payload;
  2?: Step2Payload;
  3?: Step3Payload;
  4?: unknown; // intentionally unread
  5?: unknown; // intentionally unread
  6?: Step6Payload;
  7?: Step7Payload;
}

export interface HandoffContext {
  storefrontName: string;
  sfdcAccountId: string | null;
  /** Kept on the type for caller compatibility; NOT printed on the PDF in V2. */
  sfdcOpportunityId: string | null;
}

// --- Formatters ------------------------------------------------------------

function formatDate(iso: string | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

const DAY_FULL: Record<string, string> = {
  mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday',
  fri: 'Friday', sat: 'Saturday', sun: 'Sunday',
};

const FREQ_LABEL: Record<string, string> = {
  weekly: 'Weekly',
  '1x_weekly': 'Weekly',
  twice_weekly: '2× weekly',
  '2x_weekly': '2× weekly',
  thrice_weekly: '3× weekly',
  '3x_weekly': '3× weekly',
  daily: 'Daily (Mon–Fri)',
  biweekly: 'Every other week',
  eow: 'Every other week',
  monthly: 'Monthly',
};

const TIME_LABEL: Record<string, string> = {
  am: 'Morning',
  pm: 'Afternoon',
  flexible: 'Flexible',
  morning: 'Morning (6am–11am)',
  afternoon: 'Afternoon (11am–3pm)',
  evening: 'Evening (3pm–7pm)',
  overnight: 'Overnight (7pm–6am)',
};

/** Compact pickup line for the teal callout. */
function pickupHeadline(s7: Step7Payload | undefined): string {
  if (!s7) return 'Schedule not submitted';
  if (s7.deferred) return 'Deferred — retailer will confirm date later';
  const date = s7.preferredDate ? formatDate(s7.preferredDate) : 'TBD';
  const window =
    s7.timeWindow
      ? (TIME_LABEL[s7.timeWindow.toLowerCase()] ?? TIME_LABEL[s7.timeWindow] ?? s7.timeWindow)
      : 'TBD';
  return `${date} · ${window}`;
}

/** Render a single contact line: "Name · phone · email" with em-dash fallback. */
function contactLine(c: { name?: string; phone?: string; email?: string } | undefined): string {
  if (!c) return '—';
  const parts = [c.name, c.phone, c.email].filter(Boolean);
  return parts.length > 0 ? parts.join(' · ') : '—';
}

// --- Drawing helpers -------------------------------------------------------

/** Draw the compact header (replaces V1's cover page). Returns next y. */
function drawHeader(
  doc: any,
  storefrontName: string,
  sfdcAccountId: string | null,
): number {
  // Top teal bar (8pt)
  doc.setFillColor(NST_TEAL);
  doc.rect(0, 0, PAGE_W, 8, 'F');

  const padTop = 22;

  // Left: NST mark + Operations Handoff label + title + subtitle
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(20);
  doc.setTextColor(NST_TEAL);
  doc.text('NST', MARGIN_X, padTop + 16);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.setTextColor(NST_MUTED);
  doc.text('OPERATIONS HANDOFF', MARGIN_X, padTop + 28);

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(15);
  doc.setTextColor(NST_INK);
  // Truncate very long storefront names so they fit alongside the right metadata.
  const titleMax = CONTENT_W - 220; // leave 220pt for right-side metadata
  doc.text(truncateToWidth(doc, storefrontName || 'Storefront pending', titleMax), MARGIN_X, padTop + 50);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(11);
  doc.setTextColor(NST_MUTED);
  doc.text('Store setup summary', MARGIN_X, padTop + 64);

  // Right: metadata block (right-aligned)
  const rightX = PAGE_W - MARGIN_X;
  const now = new Date();
  const nowStr =
    'Generated ' +
    now.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) +
    ' · ' +
    now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8.5);
  doc.setTextColor(NST_MUTED);
  doc.text(nowStr, rightX, padTop + 16, { align: 'right' });

  if (sfdcAccountId) {
    doc.text(`SFDC Account · `, rightX - 90, padTop + 28, { align: 'right' });
    doc.setFont('courier', 'normal');
    doc.setFontSize(8.5);
    doc.setTextColor(NST_INK);
    doc.text(sfdcAccountId, rightX, padTop + 28, { align: 'right' });
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(NST_MUTED);
  }
  doc.text('Prepared for NST Operations', rightX, padTop + 40, { align: 'right' });

  // Bottom border under header
  const headerBottom = padTop + 76;
  doc.setDrawColor(NST_BORDER);
  doc.setLineWidth(0.5);
  doc.line(MARGIN_X, headerBottom, PAGE_W - MARGIN_X, headerBottom);

  return headerBottom + 14; // start of body
}

/** Draw a section header. Returns next y. */
function drawSectionHeader(doc: any, title: string, y: number): number {
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9);
  doc.setTextColor(NST_INK);
  doc.text(title.toUpperCase(), MARGIN_X, y);
  // Teal underline across full content width
  doc.setDrawColor(NST_TEAL);
  doc.setLineWidth(1.0);
  doc.line(MARGIN_X, y + 3, PAGE_W - MARGIN_X, y + 3);
  return y + 13;
}

/** Draw a key/value row. xLeft = left edge, w = total row width. Returns next y. */
function drawKvRow(
  doc: any,
  k: string,
  v: string,
  xLeft: number,
  w: number,
  y: number,
  opts: { keyW?: number; lastRow?: boolean } = {},
): number {
  const keyW = opts.keyW ?? 78;
  const padX = 0;
  const valX = xLeft + keyW + 6;
  const valW = w - keyW - 6;

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8.5);
  doc.setTextColor(NST_MUTED);
  doc.text(k, xLeft + padX, y + 8);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(NST_INK);
  // Wrap long values to fit valW.
  const lines = doc.splitTextToSize(v || '—', valW) as string[];
  lines.forEach((line, i) => {
    doc.text(line, valX, y + 8 + i * 11);
  });
  const rowH = 6 + Math.max(1, lines.length) * 11;

  // Bottom hairline (skip if last row in section)
  if (!opts.lastRow) {
    doc.setDrawColor(NST_ROW_BORDER);
    doc.setLineWidth(0.3);
    doc.line(xLeft, y + rowH, xLeft + w, y + rowH);
  }
  return y + rowH;
}

/** Draw multiple kv rows in a column. Returns next y. */
function drawKvCol(
  doc: any,
  rows: Array<[string, string]>,
  xLeft: number,
  w: number,
  startY: number,
  keyW = 78,
): number {
  let y = startY;
  rows.forEach(([k, v], i) => {
    y = drawKvRow(doc, k, v, xLeft, w, y, {
      keyW,
      lastRow: i === rows.length - 1,
    });
  });
  return y;
}

/** Draw the teal callout for first pickup. Returns next y. */
function drawPickupCallout(doc: any, label: string, value: string, y: number): number {
  const h = 22;
  doc.setFillColor(NST_CALLOUT_BG);
  doc.rect(MARGIN_X, y, CONTENT_W, h, 'F');
  // Left teal accent bar
  doc.setFillColor(NST_TEAL);
  doc.rect(MARGIN_X, y, 2.5, h, 'F');

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9);
  doc.setTextColor(NST_TEAL);
  doc.text(label, MARGIN_X + 10, y + 14);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9.5);
  doc.setTextColor(NST_INK);
  const labelW = doc.getTextWidth(label);
  doc.text(value, MARGIN_X + 10 + labelW + 6, y + 14);

  return y + h + 6;
}

/** Truncate a string to fit within maxWidth at current font; appends "…" if cut. */
function truncateToWidth(doc: any, text: string, maxWidth: number): string {
  if (doc.getTextWidth(text) <= maxWidth) return text;
  const ell = '…';
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (doc.getTextWidth(text.slice(0, mid) + ell) <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  return text.slice(0, lo).trimEnd() + ell;
}

/** Draw the footer at the bottom of the page. */
function drawFooter(doc: any, storefrontName: string): void {
  const y = PAGE_H - 28;
  doc.setDrawColor(NST_BORDER);
  doc.setLineWidth(0.4);
  doc.line(MARGIN_X, y - 6, PAGE_W - MARGIN_X, y - 6);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7.5);
  doc.setTextColor(NST_MUTED);
  doc.text(
    `${storefrontName || 'Store'} · Confidential`,
    MARGIN_X,
    y + 4,
  );
  doc.text(
    'Combinations + full banking numbers confirmed in person · NST Operations',
    PAGE_W - MARGIN_X,
    y + 4,
    { align: 'right' },
  );
}

// --- Section composers -----------------------------------------------------

function composeStep1Rows(s1: Step1Payload | undefined, fallbackName: string): Array<[string, string]> {
  if (!s1) return [['Status', 'Not submitted']];
  const owner = s1.primaryContact ?? s1.ownerContact;
  const manager = s1.bohManager ?? s1.managerContact;
  const street = s1.street ?? s1.addressLine1;
  const suite = s1.suite ?? s1.addressLine2;
  const addressInline = [
    [street, suite].filter(Boolean).join(', '),
    [s1.city, s1.state, s1.zip].filter(Boolean).join(', '),
  ].filter(Boolean).join(' · ');

  const rows: Array<[string, string]> = [
    ['Address', addressInline || '—'],
  ];

  // Hours: collapse to a one-line summary if we can; otherwise omit.
  const hoursLine = summarizeHours(s1.hours);
  if (hoursLine) rows.push(['Hours', hoursLine]);

  rows.push(
    ['Owner', contactLine(owner)],
    ['BOH Manager', contactLine(manager)],
  );

  if (s1.accessNotes && s1.accessNotes.trim()) {
    rows.push(['Access notes', s1.accessNotes.trim()]);
  }

  return rows;
}

/**
 * Best-effort one-line hours summary. The form stores per-day open/close;
 * if all open days share the same window we render "Mon–Fri 7am–10pm".
 * Otherwise we render a comma list. Returns null if no hours data.
 */
function summarizeHours(
  hours: Record<string, { open?: string; close?: string; closed?: boolean }> | undefined,
): string | null {
  if (!hours) return null;
  const order = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
  const dayNames: Record<string, string> = {
    mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu',
    fri: 'Fri', sat: 'Sat', sun: 'Sun',
  };
  const open = order.filter((d) => hours[d] && !hours[d].closed && hours[d].open);
  if (open.length === 0) return null;
  // If every open day has the same hours, collapse to range.
  const firstWindow = `${hours[open[0]].open}–${hours[open[0]].close}`;
  const allSame = open.every(
    (d) => `${hours[d].open}–${hours[d].close}` === firstWindow,
  );
  if (allSame) {
    return `${dayNames[open[0]]}–${dayNames[open[open.length - 1]]} ${firstWindow}`;
  }
  return open.map((d) => `${dayNames[d]} ${hours[d].open}–${hours[d].close}`).join(' · ');
}

function deriveSafeType(s2: Step2Payload): string | undefined {
  if (s2.safeType) return s2.safeType;
  if (s2.hasSmartSafe === 'yes') return 'Smart Safe (with bill validator)';
  if (s2.hasSmartSafe === 'no') {
    if (s2.storageMethod === 'drop_safe') return 'Drop Safe';
    return 'Other';
  }
  return undefined;
}

// --- Main entry point ------------------------------------------------------

/**
 * Render the V2 ops handoff PDF. Returns a Uint8Array suitable for upload
 * to Salesforce as a ContentVersion's VersionData (the caller base64-encodes
 * it inside the multipart body).
 */
export function renderHandoffPdf(
  ctx: HandoffContext,
  submissions: SubmissionsMap,
): Uint8Array {
  const doc = new jsPDF({ unit: 'pt', format: 'letter' });

  // --- Header ---
  let y = drawHeader(doc, ctx.storefrontName, ctx.sfdcAccountId);

  // --- Section 1: Store profile & contacts ---
  y = drawSectionHeader(doc, '1 · Store profile & contacts', y);
  const s1 = submissions[1];
  y = drawKvCol(doc, composeStep1Rows(s1, ctx.storefrontName), MARGIN_X, CONTENT_W, y, 78);
  y += 8;

  // --- Section 2: Safe & key holders ---
  y = drawSectionHeader(doc, '2 · Safe & key holders', y);
  const s2 = submissions[2];
  if (s2) {
    const safeType = deriveSafeType(s2);
    const leftRows: Array<[string, string]> = [
      ['Safe type', safeType ?? '—'],
      ['Make / model', [s2.safeMake, s2.safeModel].filter(Boolean).join(' ') || '—'],
    ];
    const rightRows: Array<[string, string]> = [
      ['Serial', s2.safeSerial ?? '—'],
      ['Location', s2.safeLocation ?? '—'],
    ];
    const yLeft = drawKvCol(doc, leftRows, MARGIN_X, COL_W, y, 70);
    const yRight = drawKvCol(doc, rightRows, MARGIN_X + COL_W + COL_GAP, COL_W, y, 70);
    y = Math.max(yLeft, yRight) + 4;

    // Key holders table (soft-capped at KEY_HOLDER_ROW_CAP rows)
    if (s2.keyHolders && s2.keyHolders.length > 0) {
      const allHolders = s2.keyHolders;
      const visible = allHolders.slice(0, KEY_HOLDER_ROW_CAP);
      const overflow = allHolders.length - visible.length;

      autoTable(doc, {
        startY: y,
        head: [['Name', 'Role', 'Phone']],
        body: visible.map((k) => [k.name ?? '—', k.role ?? '—', k.phone ?? '—']),
        theme: 'striped',
        headStyles: {
          fillColor: NST_TEAL,
          textColor: '#FFFFFF',
          fontStyle: 'bold',
          fontSize: 8.5,
          cellPadding: 4,
        },
        styles: {
          font: 'helvetica',
          fontSize: 9,
          cellPadding: 4,
          textColor: NST_INK,
          lineColor: NST_ROW_BORDER,
          lineWidth: 0.25,
        },
        alternateRowStyles: { fillColor: NST_STRIPE },
        margin: { left: MARGIN_X, right: MARGIN_X },
      });
      y = (doc as any).lastAutoTable.finalY;

      if (overflow > 0) {
        doc.setFont('helvetica', 'italic');
        doc.setFontSize(8);
        doc.setTextColor(NST_MUTED);
        doc.text(`+ ${overflow} more in SF`, MARGIN_X, y + 10);
        y += 12;
      }
    }
    y += 8;
  } else {
    y = drawKvCol(doc, [['Status', 'Not submitted']], MARGIN_X, CONTENT_W, y, 78);
    y += 8;
  }

  // --- Sections 3 + 6 side-by-side (Banking | Invoicing) ---
  // Skip the entire "6 · Invoicing contact" column if no name AND no email.
  const s3 = submissions[3];
  const s6 = submissions[6];
  const showS6 = !!(s6 && (s6.contactName?.trim() || s6.contactEmail?.trim()));

  if (showS6) {
    // Left: Banking
    let yL = drawSectionHeader(doc, '3 · Banking', y);
    yL = drawKvCol(
      doc,
      s3
        ? [
            ['Bank', s3.bankName ?? '—'],
            ['Account type', s3.accountType ?? '—'],
            ['Name on acct', s3.nameOnAccount ?? s3.signerName ?? '—'],
            ['Account', s3.accountLast4 ? `•••• ${s3.accountLast4}` : '—'],
          ]
        : [['Status', 'Not submitted']],
      MARGIN_X,
      COL_W,
      yL,
      72,
    );

    // Right: Invoicing
    let yR = drawSectionHeader(doc, '6 · Invoicing contact', y);
    const s6Rows: Array<[string, string]> = [];
    if (s6!.contactName?.trim()) s6Rows.push(['Name', s6!.contactName!.trim()]);
    if (s6!.contactEmail?.trim()) s6Rows.push(['Email', s6!.contactEmail!.trim()]);
    if (s6!.contactPhone?.trim()) s6Rows.push(['Phone', s6!.contactPhone!.trim()]);
    yR = drawKvCol(doc, s6Rows, MARGIN_X + COL_W + COL_GAP, COL_W, yR, 50);

    y = Math.max(yL, yR) + 8;
  } else {
    // Banking only (full-width)
    y = drawSectionHeader(doc, '3 · Banking', y);
    y = drawKvCol(
      doc,
      s3
        ? [
            ['Bank', s3.bankName ?? '—'],
            ['Account type', s3.accountType ?? '—'],
            ['Name on account', s3.nameOnAccount ?? s3.signerName ?? '—'],
            ['Account', s3.accountLast4 ? `•••• ${s3.accountLast4}` : '—'],
          ]
        : [['Status', 'Not submitted']],
      MARGIN_X,
      CONTENT_W,
      y,
      78,
    );
    y += 8;
  }

  // --- Section 7: First pickup & ongoing service ---
  y = drawSectionHeader(doc, '7 · First pickup & ongoing service', y);
  const s7 = submissions[7];

  // Teal callout with the headline date+window
  y = drawPickupCallout(doc, 'First pickup:', pickupHeadline(s7), y);

  if (s7 && !s7.deferred) {
    const days = s7.serviceDays?.map((d) => DAY_FULL[d] ?? d).join(', ') || '—';
    const freq = s7.frequency
      ? FREQ_LABEL[s7.frequency.toLowerCase()] ?? FREQ_LABEL[s7.frequency] ?? s7.frequency
      : '—';
    const window = s7.timeWindow
      ? TIME_LABEL[s7.timeWindow.toLowerCase()] ?? TIME_LABEL[s7.timeWindow] ?? s7.timeWindow
      : '—';
    const driverNotes = s7.driverNotes?.trim() || '—';

    const leftRows: Array<[string, string]> = [
      ['Service days', days],
      ['Frequency', freq],
    ];
    const rightRows: Array<[string, string]> = [
      ['Time window', window],
      ['Driver notes', driverNotes],
    ];
    const yLeft = drawKvCol(doc, leftRows, MARGIN_X, COL_W, y, 80);
    const yRight = drawKvCol(doc, rightRows, MARGIN_X + COL_W + COL_GAP, COL_W, y, 80);
    y = Math.max(yLeft, yRight);
  } else if (s7?.deferred) {
    y = drawKvCol(
      doc,
      [['Nudge cadence', 'Every 2 weeks (max 6 nudges = 12 weeks)']],
      MARGIN_X,
      CONTENT_W,
      y,
      80,
    );
  }

  // --- Footer ---
  drawFooter(doc, ctx.storefrontName);

  const ab = doc.output('arraybuffer') as ArrayBuffer;
  return new Uint8Array(ab);
}

export function buildPdfFilename(storefrontName: string): string {
  const safe = (storefrontName || 'store')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  const stamp = new Date().toISOString().split('T')[0];
  return `nst-ops-handoff-${safe}-${stamp}.pdf`;
}
