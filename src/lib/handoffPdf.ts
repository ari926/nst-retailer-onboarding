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

function formatMoney(n: number | undefined | null, locale = 'en-US'): string {
  if (n == null || Number.isNaN(n)) return '—';
  // Money is always in USD for V1 — only the number/decimal formatting
  // switches with locale.
  return n.toLocaleString(locale, { style: 'currency', currency: 'USD' });
}

function formatDate(iso: string | undefined, locale = 'en-US'): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(locale, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

// ---------------------------------------------------------------------------
// PDF localization
//
// Goal: retailer-facing chrome (cover, section headers, footer, status
// fallbacks, key-holder table head, frequency/time labels) translates to
// Spanish. Actual data values (store names, addresses, numbers) are never
// translated — they come straight from the form submissions.
//
// The PDF stays English-only for NST ops consumption in V1 by default,
// but retailers who filled the flow in Spanish see a Spanish copy when
// they hit "Download ops summary".
// ---------------------------------------------------------------------------

export type PdfLang = 'en' | 'es';

interface PdfStrings {
  cover: {
    productLabel: string; // "Operations Handoff"
    title: string; // "Store Setup Summary"
    storefrontFallback: string;
    generated: string;
    sfdcAccount: string;
    preparedFor: string;
    preparedForValue: string;
    securityTitle: string;
    securityBody: string;
    footerConfidential: string;
  };
  sections: {
    storeProfile: string;
    safe: string;
    banking: string;
    deposit: string;
    changeOrder: string;
    invoicing: string;
    pickup: string;
  };
  labels: {
    storefront: string;
    dba: string;
    address: string;
    owner: string;
    manager: string;
    safeType: string;
    makeModel: string;
    locationInStore: string;
    combo: string;
    comboNote: string;
    provisionalCredit: string;
    yesEligible: string;
    no: string;
    keyHolders: string;
    name: string;
    role: string;
    phone: string;
    bank: string;
    accountType: string;
    nameOnAccount: string;
    routing: string;
    account: string;
    depositDate: string;
    bagNumber: string;
    total: string;
    deliveryDate: string;
    contactName: string;
    email: string;
    cadence: string;
    cadenceValue: string;
    status: string;
    notSubmitted: string;
    deferredStatus: string;
    nudgeCadence: string;
    nudgeCadenceValue: string;
    firstPickup: string;
    serviceDays: string;
    frequency: string;
    timeWindow: string;
    driverNotes: string;
    page: string; // "Page {i} of {n}"
  };
  days: Record<string, string>;
  freq: Record<string, string>;
  time: Record<string, string>;
  locale: string; // for toLocaleDateString / toLocaleTimeString
  dateAt: string; // connector between date and time on cover
}

const EN_STRINGS: PdfStrings = {
  cover: {
    productLabel: 'Operations Handoff',
    title: 'Store Setup Summary',
    storefrontFallback: 'Storefront pending',
    generated: 'Generated',
    sfdcAccount: 'SFDC account',
    preparedFor: 'Prepared for',
    preparedForValue: 'NST Operations — New Store Onboarding',
    securityTitle: 'Security',
    securityBody:
      'Safe combinations and full banking numbers are never printed. Route techs will confirm\n' +
      'those details in person and store them in the NST ops portal.',
    footerConfidential: 'Confidential — NST Retailer Onboarding V1',
  },
  sections: {
    storeProfile: '1. Store profile & contacts',
    safe: '2. Safe & key holders',
    banking: '3. Banking',
    deposit: '4. Sample deposit (dry run)',
    changeOrder: '5. Sample change order (dry run)',
    invoicing: '6. Invoicing contact',
    pickup: '7. First pickup & ongoing service',
  },
  labels: {
    storefront: 'Storefront',
    dba: 'DBA',
    address: 'Address',
    owner: 'Owner',
    manager: 'Manager',
    safeType: 'Safe type',
    makeModel: 'Make / model',
    locationInStore: 'Location in store',
    combo: 'Combo',
    comboNote: 'Confirmed in person — not printed',
    provisionalCredit: 'Provisional credit',
    yesEligible: 'Yes — eligible',
    no: 'No',
    keyHolders: 'Key holders',
    name: 'Name',
    role: 'Role',
    phone: 'Phone',
    bank: 'Bank',
    accountType: 'Account type',
    nameOnAccount: 'Name on account',
    routing: 'Routing',
    account: 'Account',
    depositDate: 'Deposit date',
    bagNumber: 'Bag number',
    total: 'Total',
    deliveryDate: 'Delivery date',
    contactName: 'Contact name',
    email: 'Email',
    cadence: 'Cadence',
    cadenceValue: 'Monthly on the 1st',
    status: 'Status',
    notSubmitted: 'Not submitted',
    deferredStatus: 'Deferred — retailer will confirm date later',
    nudgeCadence: 'Nudge cadence',
    nudgeCadenceValue: 'Every 2 weeks (max 6 nudges = 12 weeks)',
    firstPickup: 'First pickup',
    serviceDays: 'Service days',
    frequency: 'Frequency',
    timeWindow: 'Time window',
    driverNotes: 'Driver notes',
    page: 'Page {i} of {n}',
  },
  days: {
    mon: 'Monday',
    tue: 'Tuesday',
    wed: 'Wednesday',
    thu: 'Thursday',
    fri: 'Friday',
    sat: 'Saturday',
    sun: 'Sunday',
  },
  freq: {
    weekly: 'Weekly',
    twice_weekly: 'Twice per week',
    thrice_weekly: 'Three times per week',
    daily: 'Daily (Mon–Fri)',
    biweekly: 'Every other week',
  },
  time: {
    am: 'Morning',
    pm: 'Afternoon',
    flexible: 'Flexible',
  },
  locale: 'en-US',
  dateAt: ' at ',
};

const ES_STRINGS: PdfStrings = {
  cover: {
    productLabel: 'Entrega a operaciones',
    title: 'Resumen de configuración de tienda',
    storefrontFallback: 'Tienda pendiente',
    generated: 'Generado',
    sfdcAccount: 'Cuenta SFDC',
    preparedFor: 'Preparado para',
    preparedForValue: 'Operaciones NST — nueva tienda',
    securityTitle: 'Seguridad',
    securityBody:
      'Las combinaciones de la caja fuerte y los números bancarios completos nunca se imprimen.\n' +
      'Los técnicos de ruta los confirmarán en persona y los guardarán en el portal de NST.',
    footerConfidential: 'Confidencial — Incorporación de comerciantes NST V1',
  },
  sections: {
    storeProfile: '1. Perfil de la tienda y contactos',
    safe: '2. Caja fuerte y portadores de llave',
    banking: '3. Cuenta bancaria',
    deposit: '4. Depósito de prueba',
    changeOrder: '5. Pedido de cambio de prueba',
    invoicing: '6. Contacto de facturación',
    pickup: '7. Primera recogida y servicio continuo',
  },
  labels: {
    storefront: 'Tienda',
    dba: 'Nombre comercial',
    address: 'Dirección',
    owner: 'Propietario',
    manager: 'Gerente',
    safeType: 'Tipo de caja fuerte',
    makeModel: 'Marca / modelo',
    locationInStore: 'Ubicación en tienda',
    combo: 'Combinación',
    comboNote: 'Confirmada en persona — no se imprime',
    provisionalCredit: 'Crédito provisional',
    yesEligible: 'Sí — elegible',
    no: 'No',
    keyHolders: 'Portadores de llave',
    name: 'Nombre',
    role: 'Rol',
    phone: 'Teléfono',
    bank: 'Banco',
    accountType: 'Tipo de cuenta',
    nameOnAccount: 'Nombre en la cuenta',
    routing: 'Número de ruta',
    account: 'Cuenta',
    depositDate: 'Fecha del depósito',
    bagNumber: 'Número de bolsa',
    total: 'Total',
    deliveryDate: 'Fecha de entrega',
    contactName: 'Nombre del contacto',
    email: 'Correo electrónico',
    cadence: 'Frecuencia',
    cadenceValue: 'Mensual, el día 1',
    status: 'Estado',
    notSubmitted: 'No enviado',
    deferredStatus: 'Aplazado — el comerciante confirmará la fecha más tarde',
    nudgeCadence: 'Cadencia de recordatorios',
    nudgeCadenceValue: 'Cada 2 semanas (máx. 6 recordatorios = 12 semanas)',
    firstPickup: 'Primera recogida',
    serviceDays: 'Días de servicio',
    frequency: 'Frecuencia',
    timeWindow: 'Ventana horaria',
    driverNotes: 'Notas para el conductor',
    page: 'Página {i} de {n}',
  },
  days: {
    mon: 'Lunes',
    tue: 'Martes',
    wed: 'Miércoles',
    thu: 'Jueves',
    fri: 'Viernes',
    sat: 'Sábado',
    sun: 'Domingo',
  },
  freq: {
    weekly: 'Semanal',
    twice_weekly: 'Dos veces por semana',
    thrice_weekly: 'Tres veces por semana',
    daily: 'Diario (lun.–vie.)',
    biweekly: 'Quincenal',
  },
  time: {
    am: 'Mañana',
    pm: 'Tarde',
    flexible: 'Flexible',
  },
  locale: 'es-MX',
  dateAt: ' a las ',
};

function stringsFor(lang: PdfLang): PdfStrings {
  return lang === 'es' ? ES_STRINGS : EN_STRINGS;
}

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
  S: PdfStrings,
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
  doc.text(S.cover.productLabel, 40, 98);

  // Main title
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(26);
  doc.setTextColor(NST_INK);
  doc.text(S.cover.title, 40, 160);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(14);
  doc.setTextColor(NST_MUTED);
  doc.text(storefrontName || S.cover.storefrontFallback, 40, 185);

  // Metadata block
  doc.setDrawColor(NST_BORDER);
  doc.setLineWidth(0.75);
  doc.roundedRect(40, 220, pageW - 80, 110, 4, 4);

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  doc.setTextColor(NST_INK);
  doc.text(S.cover.generated, 60, 248);
  doc.text(S.cover.sfdcAccount, 60, 272);
  doc.text(S.cover.preparedFor, 60, 296);

  doc.setFont('helvetica', 'normal');
  doc.setTextColor(NST_MUTED);
  const now = new Date();
  doc.text(
    now.toLocaleDateString(S.locale, {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    }) +
      S.dateAt +
      now.toLocaleTimeString(S.locale, { hour: 'numeric', minute: '2-digit' }),
    180,
    248,
  );
  doc.text(sfdcAccountId || '—', 180, 272);
  doc.text(S.cover.preparedForValue, 180, 296);

  // Security notice
  doc.setDrawColor(NST_TEAL);
  doc.setFillColor(248, 252, 252);
  doc.roundedRect(40, 360, pageW - 80, 70, 4, 4, 'FD');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  doc.setTextColor(NST_TEAL);
  doc.text(S.cover.securityTitle, 56, 382);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9.5);
  doc.setTextColor(NST_INK);
  doc.text(S.cover.securityBody, 56, 400);

  // Footer
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.setTextColor(NST_MUTED);
  doc.text(
    S.cover.footerConfidential,
    40,
    doc.internal.pageSize.getHeight() - 30,
  );
}

function drawFooter(doc: jsPDF, storefrontName: string, S: PdfStrings): void {
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
    doc.text(storefrontName || S.labels.storefront, 40, pageH - 26);
    const label = S.labels.page
      .replace('{i}', String(i))
      .replace('{n}', String(pageCount));
    doc.text(label, pageW - 80, pageH - 26);
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
  /** UI language the PDF should render in. Defaults to English. */
  lang?: PdfLang;
}

/**
 * Core renderer shared by download + buffer variants. Takes a pre-constructed
 * jsPDF instance so callers can either `save()` or grab the ArrayBuffer.
 */
function renderHandoff(doc: jsPDF, ctx: HandoffContext): void {
  const S = stringsFor(ctx.lang ?? 'en');
  const locale = S.locale;

  // Cover page
  drawCover(doc, ctx.storefrontName, ctx.sfdcAccountId, S);

  // ---- Content page ----
  doc.addPage();
  let y = 60;

  // Step 1 — Store profile
  const s1 = readSubmission<Step1Payload>(1)?.payload;
  y = drawSectionHeader(doc, S.sections.storeProfile, y);
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
        [S.labels.storefront, s1.storefrontName ?? ctx.storefrontName ?? '—'],
        [S.labels.dba, s1.dba ?? '—'],
        [S.labels.address, address || '—'],
        [
          S.labels.owner,
          [s1.ownerContact?.name, s1.ownerContact?.phone, s1.ownerContact?.email]
            .filter(Boolean)
            .join(' · ') || '—',
        ],
        [
          S.labels.manager,
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
    y = buildKvTable(doc, [[S.labels.status, S.labels.notSubmitted]], y);
  }

  // Step 2 — Safe & keys
  y = checkPageBreak(doc, y, 140);
  y = drawSectionHeader(doc, S.sections.safe, y);
  const s2 = readSubmission<Step2Payload>(2)?.payload;
  if (s2) {
    y = buildKvTable(
      doc,
      [
        [S.labels.safeType, s2.safeType ?? '—'],
        [
          S.labels.makeModel,
          [s2.safeMake, s2.safeModel].filter(Boolean).join(' ') || '—',
        ],
        [S.labels.locationInStore, s2.safeLocation ?? '—'],
        [S.labels.combo, S.labels.comboNote],
        [
          S.labels.provisionalCredit,
          s2.provisionalCredit ? S.labels.yesEligible : S.labels.no,
        ],
      ],
      y,
    );

    if (s2.keyHolders && s2.keyHolders.length > 0) {
      y = checkPageBreak(doc, y, 80);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(10);
      doc.setTextColor(NST_INK);
      doc.text(S.labels.keyHolders, 40, y);
      y += 6;
      autoTable(doc, {
        startY: y,
        head: [[S.labels.name, S.labels.role, S.labels.phone]],
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
    y = buildKvTable(doc, [[S.labels.status, S.labels.notSubmitted]], y);
  }

  // Step 3 — Banking
  y = checkPageBreak(doc, y, 100);
  y = drawSectionHeader(doc, S.sections.banking, y);
  const s3 = readSubmission<Step3Payload>(3)?.payload;
  if (s3) {
    y = buildKvTable(
      doc,
      [
        [S.labels.bank, s3.bankName ?? '—'],
        [S.labels.accountType, s3.accountType ?? '—'],
        [S.labels.nameOnAccount, s3.nameOnAccount ?? '—'],
        [S.labels.routing, s3.routingLast4 ? `•••• ${s3.routingLast4}` : '—'],
        [S.labels.account, s3.accountLast4 ? `•••• ${s3.accountLast4}` : '—'],
      ],
      y,
    );
  } else {
    y = buildKvTable(doc, [[S.labels.status, S.labels.notSubmitted]], y);
  }

  // Step 4 — Sample deposit
  y = checkPageBreak(doc, y, 80);
  y = drawSectionHeader(doc, S.sections.deposit, y);
  const s4 = readSubmission<Step4Payload>(4)?.payload;
  if (s4) {
    y = buildKvTable(
      doc,
      [
        [S.labels.depositDate, formatDate(s4.date, locale)],
        [S.labels.bagNumber, s4.bagNumber ?? '—'],
        [S.labels.total, formatMoney(s4.total, locale)],
      ],
      y,
    );
  } else {
    y = buildKvTable(doc, [[S.labels.status, S.labels.notSubmitted]], y);
  }

  // Step 5 — Sample change order
  y = checkPageBreak(doc, y, 80);
  y = drawSectionHeader(doc, S.sections.changeOrder, y);
  const s5 = readSubmission<Step5Payload>(5)?.payload;
  if (s5) {
    y = buildKvTable(
      doc,
      [
        [S.labels.deliveryDate, formatDate(s5.deliveryDate, locale)],
        [S.labels.total, formatMoney(s5.total, locale)],
      ],
      y,
    );
  } else {
    y = buildKvTable(doc, [[S.labels.status, S.labels.notSubmitted]], y);
  }

  // Step 6 — Invoicing
  y = checkPageBreak(doc, y, 80);
  y = drawSectionHeader(doc, S.sections.invoicing, y);
  const s6 = readSubmission<Step6Payload>(6)?.payload;
  if (s6) {
    y = buildKvTable(
      doc,
      [
        [S.labels.contactName, s6.contactName ?? '—'],
        [S.labels.email, s6.contactEmail ?? '—'],
        [S.labels.cadence, S.labels.cadenceValue],
      ],
      y,
    );
  } else {
    y = buildKvTable(doc, [[S.labels.status, S.labels.notSubmitted]], y);
  }

  // Step 7 — First pickup
  y = checkPageBreak(doc, y, 100);
  y = drawSectionHeader(doc, S.sections.pickup, y);
  const s7 = readSubmission<Step7Payload>(7)?.payload;
  if (s7) {
    if (s7.deferred) {
      y = buildKvTable(
        doc,
        [
          [S.labels.status, S.labels.deferredStatus],
          [S.labels.nudgeCadence, S.labels.nudgeCadenceValue],
        ],
        y,
      );
    } else {
      const days =
        s7.serviceDays?.map((d) => S.days[d] ?? d).join(', ') || '—';
      y = buildKvTable(
        doc,
        [
          [S.labels.firstPickup, formatDate(s7.preferredDate, locale)],
          [S.labels.serviceDays, days],
          [
            S.labels.frequency,
            s7.frequency ? (S.freq[s7.frequency] ?? s7.frequency) : '—',
          ],
          [
            S.labels.timeWindow,
            s7.timeWindow ? (S.time[s7.timeWindow] ?? s7.timeWindow) : '—',
          ],
          [S.labels.driverNotes, s7.driverNotes?.trim() || '—'],
        ],
        y,
      );
    }
  } else {
    y = buildKvTable(doc, [[S.labels.status, S.labels.notSubmitted]], y);
  }

  drawFooter(doc, ctx.storefrontName, S);
}

/**
 * Generates the Ops Handoff PDF from persisted step submissions and returns
 * the filename used. Triggers a browser download via jsPDF's `save()`.
 */
export function generateHandoffPdf(ctx: HandoffContext): string {
  const doc = new jsPDF({ unit: 'pt', format: 'letter' });
  renderHandoff(doc, ctx);

  const safeName = (ctx.storefrontName || 'store')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  const stamp = new Date().toISOString().split('T')[0];
  const suffix = ctx.lang === 'es' ? '-es' : '';
  const filename = `nst-ops-handoff-${safeName}${suffix}-${stamp}.pdf`;
  doc.save(filename);
  return filename;
}

/** Exposed for unit/e2e tests — returns the raw ArrayBuffer instead of triggering download. */
export function buildHandoffPdfBuffer(ctx: HandoffContext): ArrayBuffer {
  const doc = new jsPDF({ unit: 'pt', format: 'letter' });
  renderHandoff(doc, ctx);
  return doc.output('arraybuffer');
}
