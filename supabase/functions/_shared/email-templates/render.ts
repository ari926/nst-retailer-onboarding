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

export interface SampleInvoiceVars {
  storefrontName: string;
  contactName: string;
  contactEmail: string;
  sampleInvoiceNumber: string;
  sentAt: string; // ISO
}

/**
 * Mock invoice line items. These intentionally look like a real weekly
 * NST invoice so the retailer recognizes the format on day one:
 *  - Pickup service (per route stop)
 *  - Cash deposit handling fee (per $1k)
 *  - Coin order surcharge
 *  - Adjustment line (if any)
 */
function sampleLineItems(): Array<{ label: string; qty: string; amt: number }> {
  return [
    { label: 'Weekly route stop (Mon, Wed, Fri)', qty: '3', amt: 75.0 },
    { label: 'Cash deposit handling — per $1,000', qty: '4.2', amt: 16.8 },
    { label: 'Coin order — quarter rolls', qty: '2', amt: 12.0 },
  ];
}

export function renderSampleInvoice(v: SampleInvoiceVars): string {
  const lines = sampleLineItems();
  const subtotal = lines.reduce((acc, l) => acc + l.amt, 0);
  const tax = +(subtotal * 0.0825).toFixed(2);
  const total = +(subtotal + tax).toFixed(2);
  const dt = new Date(v.sentAt);
  const periodEnd = dt.toISOString().slice(0, 10);

  const lineRows = lines
    .map(
      (l) =>
        `<tr><td>${escapeHtml(l.label)}</td><td class="right">${escapeHtml(
          l.qty,
        )}</td><td class="right">$${l.amt.toFixed(2)}</td></tr>`,
    )
    .join('');

  const body = `
    <p>Hi ${escapeHtml(v.contactName.split(' ')[0])},</p>
    <p>This is a <strong>sample</strong> of the weekly invoice your team will receive
       once ${escapeHtml(v.storefrontName)} is live with NST. No payment is due —
       this is for your records and to confirm the format works for your AP system.</p>

    <table class="kv">
      <tr><td class="k">Invoice number</td><td class="v">${escapeHtml(v.sampleInvoiceNumber)}</td></tr>
      <tr><td class="k">Billed to</td><td class="v">${escapeHtml(v.storefrontName)}</td></tr>
      <tr><td class="k">Sent to</td><td class="v">${escapeHtml(v.contactEmail)}</td></tr>
      <tr><td class="k">Period ending</td><td class="v">${escapeHtml(periodEnd)}</td></tr>
    </table>

    <table class="lines">
      <thead>
        <tr><th>Item</th><th style="text-align:right">Qty</th><th style="text-align:right">Amount</th></tr>
      </thead>
      <tbody>
        ${lineRows}
        <tr><td>Subtotal</td><td></td><td class="right">$${subtotal.toFixed(2)}</td></tr>
        <tr><td>Tax (8.25%)</td><td></td><td class="right">$${tax.toFixed(2)}</td></tr>
        <tr class="total-row"><td>Total due</td><td></td><td class="right">$${total.toFixed(2)}</td></tr>
      </tbody>
    </table>

    <div class="note">
      Production invoices will be sent every Monday for the prior week and
      auto-debited from the bank account you set up in Step 3.
    </div>

    <p style="margin-top: 24px;">— The NST team</p>
  `;
  return SHELL(`Sample invoice — ${v.storefrontName}`, body);
}

// ---------- Kickoff email (sent immediately after step 1 / profile submission) ----------
//
// Fires once per onboarding when the retailer finishes Step 1. Confirms
// the profile is in, sets expectations for steps 2-7, and surfaces the
// 10-day pickup floor so they don't pick a date we can't honor.
//
// Bilingual: language is selected by the caller from
// retailer_onboardings.language ('en' | 'es').

export interface KickoffVars {
  contactFirstName: string;
  storefrontName: string;
  resumeUrl: string;
  earliestPickupHuman: string; // "Monday, May 5" — pre-formatted in caller's locale
  repName?: string;
  repEmail?: string;
  supportPhone?: string;
  language: 'en' | 'es';
}

function kickoffEn(v: KickoffVars): { subject: string; html: string } {
  const subject = `You're almost done setting up with NST — 6 quick steps left`;
  const repBlock =
    v.repName && v.repEmail
      ? `<div class="note"><strong>Your rep:</strong> ${escapeHtml(v.repName)} &middot; ${escapeHtml(v.repEmail)}</div>`
      : '';
  const phoneBlock = v.supportPhone
    ? `<p>Questions? Reply to this email or text us at <strong>${escapeHtml(v.supportPhone)}</strong>.</p>`
    : `<p>Questions? Just reply to this email.</p>`;
  const html = SHELL(
    `Welcome to NST. Let's finish setting up ${v.storefrontName}.`,
    `
    <p>Hi ${escapeHtml(v.contactFirstName)},</p>
    <p>Your store profile is in. Thank you.</p>
    <p>To finish setting up your account, please complete the steps below.
       It takes about 15 minutes and is fully self-serve.</p>

    <div class="note" style="background:#f7fafa;border-left:3px solid #01696F;">
      <strong style="display:block;margin-bottom:6px;text-transform:uppercase;font-size:12px;letter-spacing:0.04em;color:#01696F;">What's left</strong>
      <ul style="margin:0;padding-left:18px;">
        <li>Tell us about your safe and key holders</li>
        <li>Add your bank info (we'll just need a voided check)</li>
        <li>Walk through a sample deposit and change order</li>
        <li>Set up invoicing</li>
        <li>Pick your first pickup date</li>
      </ul>
    </div>

    <div class="note" style="background:#fff8e6;border-left:3px solid #e0a800;color:#4a3e0e;">
      <strong>One important thing:</strong> we need a minimum 10 calendar-day window
      to schedule your first pickup, so the earliest date you'll see on the calendar
      is <strong>${escapeHtml(v.earliestPickupHuman)}</strong>.
    </div>

    <p style="margin-top:20px;">
      <a class="btn" href="${escapeHtml(v.resumeUrl)}">Finish my setup &rarr;</a>
    </p>

    <p>If you need to hand this off to someone else in the store, forward this
       email — the link works for whoever opens it first.</p>

    ${phoneBlock}

    <p style="margin-top:24px;color:#6b7280;">— The NST team</p>

    ${repBlock}
    `,
  );
  return { subject, html };
}

function kickoffEs(v: KickoffVars): { subject: string; html: string } {
  const subject = `Casi termina su configuración con NST — quedan 6 pasos rápidos`;
  const repBlock =
    v.repName && v.repEmail
      ? `<div class="note"><strong>Su representante:</strong> ${escapeHtml(v.repName)} &middot; ${escapeHtml(v.repEmail)}</div>`
      : '';
  const phoneBlock = v.supportPhone
    ? `<p>¿Preguntas? Responda a este correo o envíenos un mensaje al <strong>${escapeHtml(v.supportPhone)}</strong>.</p>`
    : `<p>¿Preguntas? Solo responda a este correo.</p>`;
  const html = SHELL(
    `Bienvenido a NST. Terminemos de configurar ${v.storefrontName}.`,
    `
    <p>Hola ${escapeHtml(v.contactFirstName)},</p>
    <p>Recibimos el perfil de su tienda. Gracias.</p>
    <p>Para terminar de configurar su cuenta, complete los pasos a continuación.
       Toma unos 15 minutos y lo puede hacer usted mismo.</p>

    <div class="note" style="background:#f7fafa;border-left:3px solid #01696F;">
      <strong style="display:block;margin-bottom:6px;text-transform:uppercase;font-size:12px;letter-spacing:0.04em;color:#01696F;">Lo que falta</strong>
      <ul style="margin:0;padding-left:18px;">
        <li>Información sobre su caja fuerte y quién tiene las llaves</li>
        <li>Datos bancarios (solo necesitamos un cheque anulado)</li>
        <li>Revisar un depósito y un pedido de cambio de muestra</li>
        <li>Configurar la facturación</li>
        <li>Elegir la fecha de su primera recolección</li>
      </ul>
    </div>

    <div class="note" style="background:#fff8e6;border-left:3px solid #e0a800;color:#4a3e0e;">
      <strong>Una cosa importante:</strong> necesitamos un mínimo de 10 días calendario
      para agendar su primera recolección, así que la fecha más temprana que verá
      en el calendario es <strong>${escapeHtml(v.earliestPickupHuman)}</strong>.
    </div>

    <p style="margin-top:20px;">
      <a class="btn" href="${escapeHtml(v.resumeUrl)}">Terminar mi configuración &rarr;</a>
    </p>

    <p>Si necesita pasarle esto a otra persona en la tienda, reenvíe este
       correo — el enlace funciona para quien lo abra primero.</p>

    ${phoneBlock}

    <p style="margin-top:24px;color:#6b7280;">— El equipo de NST</p>

    ${repBlock}
    `,
  );
  return { subject, html };
}

export function renderKickoff(v: KickoffVars): { subject: string; html: string } {
  return v.language === 'es' ? kickoffEs(v) : kickoffEn(v);
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
