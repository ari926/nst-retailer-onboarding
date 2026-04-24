# Salesforce Flow Email Templates

This doc explains how the SFDC Ops team should wire the templates in
`supabase/functions/_shared/email-templates/render.ts` into the
production weekly cadence. The retailer-facing app does NOT send these
emails — Salesforce does, on its own cron via Scheduled Flows.

## Templates

| Template | Trigger | Sender flow | Audience |
|---|---|---|---|
| `renderLaunchConfirmed` | Webhook `launch_date_confirmed` from sf-webhook OR a manual launch-date set in SFDC | "Launch Confirmed" Scheduled Flow, runs at 8:00 AM CT next business day | Billing contact + main contact |
| `renderLaunchReminder` | Scheduled, fires 7 / 3 / 1 days before launch | "Launch Reminder" Scheduled Flow | Main contact only |
| `renderStepReopened` | When ops reopens any step in SFDC and the webhook returns to Supabase | "Step Reopened" Triggered Flow | Main contact |
| `renderDeferredNudge` | Scheduled, fires every 5 days when `launch_status.status='deferred'` and `nudge_count < 6` | "Deferred Nudge" Scheduled Flow, capped at 6 nudges | Main contact |

## How to copy into Salesforce

1. Open the rendered template (each export function is pure — paste a
   sample call into the QA preview tool to render HTML).
2. In Salesforce → Email Templates → New Lightning Email Template.
3. Paste the full HTML into the Source view.
4. Replace the inline strings (e.g. `Hi Maria,`) with merge fields:
   - `${contactFirstName}` → `{{Recipient.FirstName}}`
   - `${storefrontName}` → `{{Account.Name}}`
   - `${launchDateHuman}` → `{{Account.Launch_Date_Display__c}}`
   - `${repName}` → `{{Owner.Name}}`
   - `${repPhone}` → `{{Owner.Phone}}`
   - `${portalUrl}` → `https://onboarding.nstops.com/portal`
   - `${resumeUrl}` → `https://onboarding.nstops.com/onboarding/launch`
5. Save and link it to the corresponding Scheduled Flow.

## Why are these templates checked in here, not in SFDC?

Two reasons:
1. **Single source of truth.** When marketing/legal updates the wording,
   the change goes here first, gets reviewed in PR, then lands in SFDC.
2. **QA without SFDC seats.** Engineers can render any template by
   importing `render.ts` and saving the output to a file — no need to
   push test data into a SFDC sandbox.

## Render preview script

```ts
// scripts/preview-emails.ts
import { writeFileSync } from 'fs';
import {
  renderSampleInvoice,
  renderLaunchConfirmed,
  renderLaunchReminder,
  renderStepReopened,
  renderDeferredNudge,
} from '../supabase/functions/_shared/email-templates/render';

writeFileSync('preview/sample-invoice.html', renderSampleInvoice({
  storefrontName: 'Corner Bodega',
  contactName: 'Maria Lopez',
  contactEmail: 'maria@cornerbodega.com',
  sampleInvoiceNumber: 'NST-SAMPLE-MOCK01',
  sentAt: new Date().toISOString(),
}));

writeFileSync('preview/launch-confirmed.html', renderLaunchConfirmed({
  contactFirstName: 'Maria',
  storefrontName: 'Corner Bodega',
  launchDateHuman: 'Monday, May 12',
  repName: 'Jordan Smith',
  repPhone: '(555) 010-2200',
  portalUrl: 'https://onboarding.nstops.com/portal',
}));

// ... etc
```

## Hard rules (carry over from PRD)

- No PII the retailer didn't enter themselves
- Banking detail is never echoed in any email — only mentioned
  generically ("the account you set up in Step 3")
- Safe combinations are NEVER referenced in any email
- Bilingual support comes in V2 (these templates are EN-only for V1)
