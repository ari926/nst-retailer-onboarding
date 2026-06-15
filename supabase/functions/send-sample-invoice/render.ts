// supabase/functions/_shared/email-templates/render.ts
//
// Tiny HTML template engine for transactional emails. We don't bring in
// React or MJML — the emails are simple, the audience is Outlook +
// Apple Mail + Gmail, and inlined-table HTML is the most reliable path.
//
// All templates here are also exported as standalone .html files in
// this same folder so the Salesforce ops team can copy them into
// Marketing Cloud / Email Templates when wiring up the SFDC Flows
// (launch_confirmed, launch_reminder, step_reopened, nudge).

const SHELL = (title: string, body: string) => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    <style>
      body { margin: 0; padding: 0; background: #f6f5f0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; color: #111; }
      .wrap { max-width: 560px; margin: 0 auto; padding: 24px 16px; }
      .card { background: #ffffff; border-radius: 12px; padding: 32px; }
      .accent { background: #01696F; color: #ffffff; padding: 24px 32px; border-radius: 12px 12px 0 0; }
      .accent h1 { margin: 0; font-size: 22px; line-height: 1.3; }
      .body { padding: 28px 32px; background: #ffffff; border-radius: 0 0 12px 12px; }
      .meta { font-size: 13px; color: #6b7280; margin-top: 4px; }
      table.kv { width: 100%; border-collapse: collapse; margin: 20px 0; }
      table.kv td { padding: 8px 0; vertical-align: top; font-size: 14px; }
      table.kv td.k { color: #6b7280; width: 38%; }
      table.kv td.v { color: #111; font-weight: 500; }
      table.lines { width: 100%; border-collapse: collapse; margin: 16px 0; }
      table.lines th { text-align: left; padding: 10px 8px; font-size: 12px; text-transform: uppercase; color: #6b7280; border-bottom: 1px solid #e5e7eb; }
      table.lines td { padding: 10px 8px; font-size: 14px; border-bottom: 1px solid #f3f4f6; }
      table.lines td.right { text-align: right; }
      .total-row td { font-weight: 600; border-top: 2px solid #111; border-bottom: none; padding-top: 14px; }
      .footer { font-size: 12px; color: #9ca3af; padding: 16px 32px 0; text-align: center; }
      .btn { display: inline-block; background: #01696F; color: #ffffff !important; text-decoration: none; padding: 10px 18px; border-radius: 8px; font-weight: 600; font-size: 14px; }
      .note { background: #f9fafb; border-left: 3px solid #01696F; padding: 12px 16px; border-radius: 4px; font-size: 13px; color: #4b5563; margin: 16px 0; }
    </style>
  </head>
  <body>
    <div class="wrap">
      <div class="accent">
        <h1>${escapeHtml(title)}</h1>
      </div>
      <div class="body">
        ${body}
        <div class="footer">
          NST Operations &middot; questions? reply to this email.
        </div>
      </div>
    </div>
  </body>
</html>`;

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ---------- Sample invoice (sent immediately from Step 6) ----------
//
// Production-format invoice. Line items, descriptions, units and structure
// mirror what NST Operations actually generates in QuickBooks for a weekly
// cash-in-transit pickup (reference: invoice 261883855 — Capeway Cannabis :
// Carver, $89.57). When a retailer receives this on Monday morning post
// go-live, the format will be byte-identical so AP teams don't have to
// re-onboard the document twice.
//
// We render a self-contained HTML page (no SHELL() wrapper) because the
// invoice is the entire document, not a content card inside a portal email.

export interface SampleInvoiceVars {
  storefrontName: string;
  /** Optional location label, e.g. "Philadelphia, PA". Falls back to "" */
  storefrontLocation?: string;
  contactName: string;
  contactEmail: string;
  sampleInvoiceNumber: string;
  sentAt: string; // ISO
  /**
   * Retailer's bank-on-file confirmed in Step 3. Used to render the
   * "Payment method" block so the AP contact can verify the right account
   * will be auto-debited on the due date. Both fields optional — if either
   * is missing we render a neutral fallback ("Bank on file confirmed in
   * Step 3") rather than half-info that could mislead.
   *
   * Source per integration spec:
   *   - bankName        ← Opportunity.Bank_Name__c
   *   - bankAccountLast4 ← Account.Bank_Account_Last_4__c
   */
  bankName?: string;
  bankAccountLast4?: string;
}

function fmtUSD(n: number): string {
  return '$' + n.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function fmtUnit(n: number): string {
  // Show up to 4 decimals so per-dollar items like $0.001 don't round to $0.00
  return '$' + n.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  });
}

function fmtQty(n: number): string {
  return n.toLocaleString('en-US');
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Real NST line items, matching the QuickBooks Items file:
 *  - SERVICE FEE      — weekly armored route stop
 *  - Cash value       — deposit handling, per dollar processed
 *  - Deposit bag      — tamper-evident bag
 *  - Coin fee         — coin order surcharge
 *  - Fuel Surcharge   — indexed to weekly DOE diesel price
 *
 * Quantities reflect a typical small storefront's first week.
 */
function sampleLineItems(periodStart: string): Array<{
  item: string;
  desc: string;
  serviceDate: string;
  qty: number;
  unit: number;
  amt: number;
}> {
  return [
    {
      item: 'SERVICE FEE',
      desc: 'Weekly armored route stop',
      serviceDate: periodStart,
      qty: 1,
      unit: 65.0,
      amt: 65.0,
    },
    {
      item: 'Cash value',
      desc: 'Cash deposit handling — per dollar processed',
      serviceDate: periodStart,
      qty: 11431,
      unit: 0.001,
      amt: 11.43,
    },
    {
      item: 'Deposit bag',
      desc: 'Tamper-evident deposit bag — first 100 are complimentary',
      serviceDate: periodStart,
      qty: 1,
      unit: 5.0,
      amt: 5.0,
    },
    {
      item: 'Coin fee',
      desc: 'Coin order surcharge — standard quarter rolls',
      serviceDate: periodStart,
      qty: 1,
      unit: 0.5,
      amt: 0.5,
    },
    {
      item: 'Fuel Surcharge',
      desc: 'Fuel surcharge — indexed to weekly DOE diesel price',
      serviceDate: periodStart,
      qty: 1,
      unit: 7.64,
      amt: 7.64,
    },
  ];
}

export function renderSampleInvoice(v: SampleInvoiceVars): string {
  const sentDate = new Date(v.sentAt);
  const txnDate = isoDate(sentDate);
  const dueDate = (() => {
    const d = new Date(sentDate);
    d.setDate(d.getDate() + 15); // Net 15
    return isoDate(d);
  })();

  const lines = sampleLineItems(txnDate);
  const subtotal = +lines.reduce((acc, l) => acc + l.amt, 0).toFixed(2);
  const tax = 0.0; // Cash-in-transit line haul is non-taxable in most jurisdictions per AvaTax
  const total = +(subtotal + tax).toFixed(2);

  const lineRows = lines
    .map(
      (l, i) => `
      <tr>
        <td class="lnum">${i + 1}</td>
        <td>
          <div class="item-name">${escapeHtml(l.item)}</div>
          <div class="item-desc">${escapeHtml(l.desc)}</div>
          <div class="item-svc">Service date ${escapeHtml(l.serviceDate)}</div>
        </td>
        <td class="right">${escapeHtml(fmtQty(l.qty))}</td>
        <td class="right">${escapeHtml(fmtUnit(l.unit))}</td>
        <td class="right amt">${escapeHtml(fmtUSD(l.amt))}</td>
      </tr>`,
    )
    .join('');

  const location = v.storefrontLocation ?? '';
  const billToBlock = location
    ? `<strong>${escapeHtml(v.storefrontName)}</strong><br>${escapeHtml(location)}<br>${escapeHtml(v.contactName)}<br>${escapeHtml(v.contactEmail)}`
    : `<strong>${escapeHtml(v.storefrontName)}</strong><br>${escapeHtml(v.contactName)}<br>${escapeHtml(v.contactEmail)}`;

  // Payment method block — confirms which bank-on-file will be auto-debited.
  // We render the bank name + masked last-4 if both are available; otherwise
  // fall back to a neutral confirmation that doesn't claim a specific bank.
  const hasBank = !!(v.bankName && v.bankAccountLast4);
  const last4 = (v.bankAccountLast4 ?? '').replace(/\D/g, '').slice(-4);
  const paymentMethodBlock = hasBank
    ? `<strong>Auto-debit (ACH)</strong><br>` +
      `${escapeHtml(v.bankName!)}<br>` +
      `Account ending in &bull;&bull;&bull;&bull;${escapeHtml(last4)}`
    : `<strong>Auto-debit (ACH)</strong><br>Bank on file confirmed in Step 3`;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Sample invoice — ${escapeHtml(v.storefrontName)}</title>
  <style>
    body { margin: 0; padding: 0; background: #f6f5f0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #111; }
    .wrap { max-width: 720px; margin: 0 auto; padding: 24px 16px; }
    .preamble { background: #e7f1f8; border-left: 4px solid #006494; padding: 14px 18px; border-radius: 6px; font-size: 14px; color: #0f3a55; margin-bottom: 16px; }
    .preamble strong { color: #003e5c; }

    .doc { background: #fff; border: 1px solid #e5e7eb; border-radius: 8px; overflow: hidden; }
    .doc-head { display: flex; align-items: flex-start; justify-content: space-between; padding: 28px 32px 20px; border-bottom: 2px solid #01696F; }
    .brand { display:flex; align-items:center; gap:12px; }
    .brand-mark { width:42px; height:42px; background:#01696F; color:#fff; display:grid; place-items:center; border-radius:8px; font-weight:700; font-family: Georgia, serif; font-size: 18px; }
    .brand-name { font-weight:700; font-size:18px; letter-spacing:0.02em; color:#0f1f2e; }
    .brand-sub  { font-size:11px; color:#6b7280; text-transform:uppercase; letter-spacing:0.08em; margin-top:2px; }
    .doc-title { text-align:right; }
    .doc-title h1 { margin:0; font-size:22px; letter-spacing:0.06em; color:#01696F; text-transform:uppercase; }
    .doc-title .num { font-size:13px; color:#6b7280; margin-top:4px; }

    .meta-grid { display:grid; grid-template-columns: 1fr 1fr 1fr; gap: 0; padding: 18px 32px; background:#fafaf7; border-bottom:1px solid #e5e7eb; font-size:12px; }
    .meta-grid h3 { margin:0 0 6px; font-size:11px; color:#6b7280; text-transform:uppercase; letter-spacing:0.08em; font-weight:600; }
    .meta-grid p { margin:0; font-size:13px; line-height:1.45; color:#111; }
    .meta-grid p strong { font-weight:600; }

    table.lines { width:100%; border-collapse:collapse; }
    table.lines thead th { background:#fafaf7; text-align:left; padding:10px 12px; font-size:11px; text-transform:uppercase; letter-spacing:0.06em; color:#6b7280; border-bottom:1px solid #e5e7eb; font-weight:600; }
    table.lines thead th.right { text-align:right; }
    table.lines td { padding:14px 12px; font-size:13px; border-bottom:1px solid #f3f4f6; vertical-align:top; }
    table.lines td.right { text-align:right; }
    table.lines td.lnum { color:#9ca3af; font-variant-numeric: tabular-nums; width:32px; }
    table.lines td.amt { font-weight:600; color:#0f1f2e; font-variant-numeric: tabular-nums; }
    .item-name { font-weight:600; color:#0f1f2e; }
    .item-desc { font-size:12px; color:#4b5563; margin-top:2px; }
    .item-svc  { font-size:11px; color:#9ca3af; margin-top:4px; }

    .totals { display:flex; justify-content:flex-end; padding: 12px 32px 22px; border-bottom:1px solid #e5e7eb; }
    .totals table { width: 280px; border-collapse:collapse; font-size:13px; }
    .totals td { padding:6px 0; }
    .totals td.k { color:#6b7280; }
    .totals td.v { text-align:right; font-variant-numeric: tabular-nums; }
    .totals tr.sub td { border-top:1px solid #e5e7eb; padding-top:10px; }
    .totals tr.total td { border-top:2px solid #0f1f2e; padding-top:12px; font-weight:700; font-size:15px; color:#0f1f2e; }

    .footer { padding: 18px 32px 26px; font-size:12px; color:#6b7280; line-height:1.6; background:#fafaf7; }
    .footer strong { color:#111; }

    .badge { display:inline-block; padding:3px 8px; background:#fef3c7; color:#92400e; border-radius:4px; font-size:10px; font-weight:700; letter-spacing:0.06em; text-transform:uppercase; }
    .payment-grid { background:#f3f9f9; border-bottom:1px solid #e5e7eb; }
    .payment-grid p { font-variant-numeric: tabular-nums; }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="preamble">
      <strong>This is a sample.</strong> No payment is due. We're sending this so you can see the exact
      invoice format your AP team will receive every Monday once ${escapeHtml(v.storefrontName)} is live.
      The line items below mirror a real NST cash-in-transit invoice.
    </div>

    <div class="doc">
      <div class="doc-head">
        <div class="brand">
          <div class="brand-mark">N</div>
          <div>
            <div class="brand-name">National Secure Transport</div>
            <div class="brand-sub">Cash logistics &middot; armored services</div>
          </div>
        </div>
        <div class="doc-title">
          <h1>Invoice <span class="badge">Sample</span></h1>
          <div class="num">${escapeHtml(v.sampleInvoiceNumber)}</div>
        </div>
      </div>

      <div class="meta-grid">
        <div>
          <h3>Bill to</h3>
          <p>${billToBlock}</p>
        </div>
        <div>
          <h3>Remit to</h3>
          <p><strong>National Secure Transport</strong><br>
             218 2nd St<br>
             Highspire, PA 17034-1201</p>
        </div>
        <div>
          <h3>Invoice details</h3>
          <p>Invoice date <strong>${escapeHtml(txnDate)}</strong><br>
             Due date <strong>${escapeHtml(dueDate)}</strong><br>
             Terms <strong>Net 15</strong></p>
        </div>
      </div>

      <div class="meta-grid payment-grid">
        <div style="grid-column: 1 / -1;">
          <h3>Payment method</h3>
          <p>${paymentMethodBlock}</p>
        </div>
      </div>

      <table class="lines">
        <thead>
          <tr>
            <th>#</th>
            <th>Item / description</th>
            <th class="right">Qty</th>
            <th class="right">Unit</th>
            <th class="right">Amount</th>
          </tr>
        </thead>
        <tbody>
          ${lineRows}
        </tbody>
      </table>

      <div class="totals">
        <table>
          <tr class="sub"><td class="k">Subtotal</td><td class="v">${escapeHtml(fmtUSD(subtotal))}</td></tr>
          <tr><td class="k">Sales tax</td><td class="v">${escapeHtml(fmtUSD(tax))}</td></tr>
          <tr class="total"><td class="k">Total due</td><td class="v">${escapeHtml(fmtUSD(total))}</td></tr>
        </table>
      </div>

      <div class="footer">
        <strong>How billing works in production.</strong> Invoices are generated in QuickBooks each Monday
        for the prior week's pickups and emailed to your AP contact. Payment is auto-debited from the bank
        account confirmed in Step 3 on the due date. Net 15 terms apply unless your contract states otherwise.<br><br>
        <strong>Questions?</strong> Reply to this email or contact your NST rep — we'll get back to you the same day.
      </div>
    </div>
  </div>
</body>
</html>`;
}

// ---------- SFDC Flow templates (rendered by Salesforce, copied here for parity) ----------
//
// The four templates below mirror what the SFDC ops team will paste
// into their Marketing Cloud / Email Templates. We export the rendered
// HTML so we have one source of truth and so QA can preview them
// without leaving the Supabase project.

export interface LaunchConfirmedVars {
  contactFirstName: string;
  storefrontName: string;
  launchDateHuman: string; // "Monday, May 12"
  repName: string;
  repPhone: string;
  portalUrl: string;
}

export function renderLaunchConfirmed(v: LaunchConfirmedVars): string {
  return SHELL(
    `Your launch date is set: ${v.launchDateHuman}`,
    `
    <p>Hi ${escapeHtml(v.contactFirstName)},</p>
    <p>Your NST launch for <strong>${escapeHtml(v.storefrontName)}</strong> is confirmed for
       <strong>${escapeHtml(v.launchDateHuman)}</strong>. Your route driver will arrive
       between 7am and 11am for the first pickup.</p>
    <p>What to expect on day one:</p>
    <ul>
      <li>Driver scans your safe QR code on arrival</li>
      <li>Cash handoff in pre-labeled bags (we provide the first 100)</li>
      <li>You'll get a receipt by email within 30 minutes</li>
    </ul>
    <p style="margin-top:20px;">
      <a class="btn" href="${escapeHtml(v.portalUrl)}">Open your portal</a>
    </p>
    <div class="note">
      Need to reschedule? Reply to this email or call your rep
      ${escapeHtml(v.repName)} at ${escapeHtml(v.repPhone)}.
    </div>
    `,
  );
}

export interface LaunchReminderVars {
  contactFirstName: string;
  storefrontName: string;
  daysUntilLaunch: number;
  launchDateHuman: string;
  portalUrl: string;
}

export function renderLaunchReminder(v: LaunchReminderVars): string {
  const headline =
    v.daysUntilLaunch === 1
      ? `Tomorrow: NST starts at ${v.storefrontName}`
      : `${v.daysUntilLaunch} days until launch`;
  return SHELL(
    headline,
    `
    <p>Hi ${escapeHtml(v.contactFirstName)},</p>
    <p>Quick reminder — your NST launch is on <strong>${escapeHtml(v.launchDateHuman)}</strong>.
       Make sure the safe is unlocked and your morning manager knows to expect the driver.</p>
    <p style="margin-top:20px;">
      <a class="btn" href="${escapeHtml(v.portalUrl)}">Review launch checklist</a>
    </p>
    `,
  );
}

export interface StepReopenedVars {
  contactFirstName: string;
  storefrontName: string;
  stepName: string; // "Banking" / "Safe & keys" / etc
  reason: string;
  resumeUrl: string;
}

export function renderStepReopened(v: StepReopenedVars): string {
  return SHELL(
    `Action needed: ${v.stepName}`,
    `
    <p>Hi ${escapeHtml(v.contactFirstName)},</p>
    <p>Your NST rep reopened <strong>${escapeHtml(v.stepName)}</strong> for
       ${escapeHtml(v.storefrontName)} so we can finish setup. Here's why:</p>
    <div class="note">${escapeHtml(v.reason)}</div>
    <p style="margin-top:20px;">
      <a class="btn" href="${escapeHtml(v.resumeUrl)}">Update this step</a>
    </p>
    <p>This usually takes less than 5 minutes. Reply to this email if you need help.</p>
    `,
  );
}

export interface DeferredNudgeVars {
  contactFirstName: string;
  storefrontName: string;
  /** 1-based — gets capped at 6 by the SFDC scheduled flow. */
  nudgeNumber: number;
  resumeUrl: string;
}

export function renderDeferredNudge(v: DeferredNudgeVars): string {
  return SHELL(
    `Ready to schedule your first NST pickup?`,
    `
    <p>Hi ${escapeHtml(v.contactFirstName)},</p>
    <p>Your setup for ${escapeHtml(v.storefrontName)} is almost done — the only
       thing left is picking a date for your first pickup.</p>
    <p>It takes about 60 seconds.</p>
    <p style="margin-top:20px;">
      <a class="btn" href="${escapeHtml(v.resumeUrl)}">Pick a date</a>
    </p>
    ${
      v.nudgeNumber >= 5
        ? `<div class="note">This is one of our last reminders — after this we'll have your rep give you a call to make sure everything's on track.</div>`
        : ''
    }
    `,
  );
}
