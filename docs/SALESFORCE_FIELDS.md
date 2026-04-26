# Salesforce Schema Mapping — NST Retailer Onboarding V1

**Org:** `talariatransportation.my.salesforce.com` (production)
**Audit date:** 2026-04-25
**Auditor:** ari@talaria.com

## Summary

Before this audit, the onboarding flow assumed we'd create a parallel set of custom objects in Salesforce. **It turns out roughly 60% of what we need already exists** on `Account`, `Contact`, and `Account_QuickBooks_Customer_Relation__c`. This doc is the new source of truth for what to reuse vs. build.

| Step | Existing fields reused | Net-new fields | Net-new objects |
|---|---|---|---|
| 1. Store profile | 8 | 4 | 0 |
| 2. Safe & keys | 0 | 0 | 1 (`Safe_Setup__c`) |
| 3. Banking | 1 | 2 | 0 |
| 4. Sample deposit | 0 | 0 | 0 — lives in Supabase + Ops Handoff PDF only |
| 5. Sample change order | 0 | 0 | 0 — lives in Supabase + Ops Handoff PDF only |
| 6. Invoicing | 4 | 0 | 0 |
| 7. First pickup | 4 | 1 | 0 |
| Cross-cutting | — | 3 | 0 |

**Net-new total:** 1 custom object, 10 Account fields, 0 Contact fields.

**Step progress is tracked via `Account.Onboarding_Status__c` (picklist), not per-step boolean fields.** Dry-run step completion (Steps 4 & 5) advances that picklist; the actual numbers don't sync to SF.

---

## Cross-cutting fields (apply across the whole flow)

| Field / Object | Status | API Name | Type | Notes |
|---|---|---|---|---|
| Account | reused | `Account_Stage__c` | Picklist | Already has `New / Working / Potential / Qualified / Customer / Churned`. Drive onboarding lifecycle off this — set to `Working` on claim, `Customer` on Step 7 commit. |
| Account | **net-new** | `Onboarding_Status__c` | Picklist | See picklist values below. Distinct from `Account_Stage__c` so Sales doesn't lose their funnel. |
| Account | **net-new** | `NST_Temp_Code__c` | Text(12), unique | Magic-link claim code emitted when sales hands off. Cleared on first successful claim. |
| Account | **net-new** | `Launch_Date__c` | Date | The confirmed first-pickup date. Used for ops scheduling + "live" reporting. |

---

## `Onboarding_Status__c` picklist values

Drives off step **completion** (did they walk through it), not data presence (did they fill in every field). This matters because some fields — most notably `First_pick_up_date__c` — are genuinely unknown to the retailer at the time they finish onboarding; ops sets the date later.

| Value | Meaning | Trigger |
|---|---|---|
| `Not Started` | `NST_Temp_Code__c` emitted, never claimed | Default on Account creation |
| `Claimed` | Logged in via magic link | Step 0 complete |
| `Profile Complete` | Store profile + contacts done | Step 1 complete |
| `Setup Complete` | Safe + banking done | Steps 2 + 3 complete |
| `Trained` | Sample deposit + change order walked through | Steps 4 + 5 complete — **no separate boolean fields needed** |
| `Invoicing Configured` | Invoice contact + sample sent | Step 6 complete |
| `Awaiting Pickup` | All 7 steps walked; no first-pickup date confirmed yet | Step 7 deferred OR submitted-pending-ops |
| `Live` | First pickup completed + driver-verified | Flow-driven once `First_pick_up_date__c` is reached + driver confirms |
| `Stalled` | No progress for 14 days at any pre-`Live` status | Flow-driven |

> Why this matters for the "they don't know their date" case: a retailer hits `Awaiting Pickup` by completing all 7 steps even if `First_pick_up_date__c` is blank. Step 7's defer path lands here without a date. Ops fills the date later from their scheduling system, and a Flow flips status to `Live` once it's reached + verified.

---

## Step 1 — Store profile, hours, contacts

### Reused (8)

| Field | API Name | Type | Notes |
|---|---|---|---|
| Account.Legal Name | `Legal_Name__c` | Text | |
| Account.Account Number | `Account_Number__c` | Text | NST internal account # |
| Account.Customer ID | `Customer_ID__c` | Text | |
| Account.Primary Contact | `Primary_Contact__c` | Lookup(Contact) | Store Manager goes here |
| Account.Territory | `Territory__c` | Picklist | |
| Account.Market Size | `Market_Size__c` | Picklist | |
| Account.Products | `Products__c` | Multipicklist | CIT, ATM, SMS, CVS, etc. — already there |
| Contact.LinkedIn URL | `LinkedIn_URL__c` | URL | Optional, nice-to-have for store mgr |

### Net-new on Account (4)

| Field | API Name | Type | Notes |
|---|---|---|---|
| Hours of Operation | `Hours_of_Operation_JSON__c` | Long Text Area (32k) | Stringified JSON `{mon:{open:"08:00",close:"22:00",closed:false}, ...}`. Avoids 7×3 = 21 fields. |
| Timezone | `Timezone__c` | Picklist | IANA values (`America/New_York` etc.) |
| Store Type | `Store_Type__c` | Picklist | Convenience, Grocery, Pharmacy, QSR, Other |
| Loading Dock Notes | `Loading_Dock_Notes__c` | Text Area (255) | Driver-facing |

> **Decision needed:** confirm with Salesforce admin that `Hours_of_Operation_JSON__c` as a long-text JSON blob is acceptable; alternative is 14 fields (`Mon_Open__c`, `Mon_Close__c`, …). I recommend the JSON blob — same pattern as `NAMSYS_Customer_Name_Grouping__c`.

---

## Step 2 — Safe & keys

No existing field fits. The closest is `NAMSYS_Customer_Name_Grouping__c` (a NAMSYS keyword grouping field) but that's downstream metadata, not setup metadata.

### Net-new object: `Safe_Setup__c`

Master-detail to Account.

| Field | API Name | Type | Notes |
|---|---|---|---|
| Account | `Account__c` | Master-Detail(Account) | |
| Safe Make | `Safe_Make__c` | Picklist | American Security, Tidel, FireKing, SentrySafe, Other |
| Safe Model | `Safe_Model__c` | Text | |
| Safe Serial | `Safe_Serial__c` | Text | |
| Safe Type | `Safe_Type__c` | Picklist | Smart Safe, Drop Safe, Combo, Time-delay |
| Combo Last 4 | `Combo_Last_4__c` | Text(4), encrypted | NEVER store full combo |
| Key Holders Count | `Key_Holders_Count__c` | Number | |
| Backup Key Location | `Backup_Key_Location__c` | Text Area (255) | |
| Photo URL | `Safe_Photo_URL__c` | URL | Supabase storage URL |

> Note: NAMSYS is the source of truth for live safe data once we're operating. `Safe_Setup__c` is **setup-only** — we copy the relevant bits into NAMSYS via existing integration.

---

## Step 3 — Banking

### Reused (1)

| Field | API Name | Type | Notes |
|---|---|---|---|
| Account.Financial Institution | `Financial_Institution__c` | Lookup(Account) | NST already uses the "banks-as-Accounts" pattern. Reuse it. |

### Net-new on Account (2)

| Field | API Name | Type | Notes |
|---|---|---|---|
| Bank Account Last 4 | `Bank_Account_Last_4__c` | Text(4) | Display-only |
| Voided Check URL | `Voided_Check_URL__c` | URL | Supabase storage URL; OCR-extracted routing/account stored only in onboarding state, **never in SF** |

> **Security:** full account # and routing # are stored in Supabase (encrypted at rest) only. Salesforce holds last 4 + reference to the doc.

---

## Steps 4 & 5 — Sample deposit & sample change order (dry-runs)

**Not synced to Salesforce.** These are training exercises — throwaway data with no downstream SF consumer. Real deposit/change-order data flows through NAMSYS, not SF; sample data in SF would be the only deposit data in SF, which is an inconsistent pattern.

### Where the data actually lives

| Artifact | Storage | Used by |
|---|---|---|
| Dry-run amounts, denominations, bag #, notes | Supabase (`onboarding_state`) | Onboarding UI |
| Snapshot for ops/driver | Ops Handoff PDF (PR #10) | Ops + driver on first pickup |

### What SF gets

Only the **fact** that the retailer completed both dry-runs — captured by `Onboarding_Status__c` advancing to `Trained` (see picklist above). No per-step boolean field, no custom objects, no field count.

> If at any point Sales/CS requests deposit-amount visibility in SF, the path is to add reporting fields then — not to pre-build objects on speculation.

---

## Step 6 — Invoicing contact + sample invoice

This is the **biggest reuse win** — invoicing infrastructure already exists.

### Reused (4)

| Field | API Name | Type | Notes |
|---|---|---|---|
| Contact.Invoice Contact | `Invoice_Contact__c` | Checkbox | Already used to flag "this contact gets invoices." Set true for Step 6 contact. |
| Contact.Secondary Email | `Secondary_Email__c` | Email | CC line on invoices |
| Account_QuickBooks_Customer_Relation__c | (whole object) | Junction | Maps SF Account ↔ QB customer. **Already wired** — no work needed beyond ensuring the row gets created on activation. |
| Account.Cirreon NST Billing | `Cirreon_NST_Billing__c` | Checkbox | Existing billing flag — surface as read-only in onboarding UI |

### Existing email templates (do **not** add a 25th)

NST already has 24+ email templates including 8+ rep-personalized "Welcome to NST" variants (Keith, Bryce, Jason, Darius, Shannon). Splice the sample-invoice block into the existing rep template rather than creating a new one. See `docs/sfdc-email-templates.md`.

### Net-new

None required for Step 6.

---

## Step 7 — First pickup request + deferred loop

This step's data **already lives on Account** — surprising amount of reuse.

### Reused (4)

| Field | API Name | Type | Notes |
|---|---|---|---|
| Account.Pick-up Frequency | `Pick_up_frequency__c` | Picklist | Values: `2x weekly`, `1x weekly`, `EOW`, `Monthly`. Already there. |
| Account.First Pickup Date | `First_pick_up_date__c` | Date | Already there. |
| Account.Proposal Pickup Rate | `Proposal_pick_up_rate__c` | Currency | Surface as read-only in UI |
| Account.Proposal BSP | `Proposal_BSP__c` | Currency | Surface as read-only |

### Net-new on Account (1)

| Field | API Name | Type | Notes |
|---|---|---|---|
| Pickup Window | `Pickup_Window__c` | Picklist | `Morning (6a-12p)`, `Afternoon (12p-5p)`, `Evening (5p-10p)`, `Overnight (10p-6a)`. Frequency picklist exists, window doesn't. |

> **Deferred loop:** if the retailer defers Step 7, set `Onboarding_Status__c = 'Awaiting Pickup'` and leave `First_pick_up_date__c` null. SFDC Flow checks daily and re-emails after 7 days.

---

## What we're explicitly NOT touching

- **NAMSYS fields** (`NAMSYS_*__c`) — those are populated by the live NAMSYS integration. We do not write to them from onboarding.
- **QB_Invoice__c, Pending_Invoice__c, Aggregate_Invoice_Customer__c** — these are operational invoice records, not onboarding setup.
- **Account_Stage__c** transitions beyond `Working` → `Customer` — Sales owns the rest of that funnel.

---

## Implementation order (suggested)

1. **Phase 1 — Account fields only.** Add the 10 net-new Account fields (including the `Onboarding_Status__c` picklist). Wire onboarding state → Account upsert. Get Steps 1, 3, 6, 7 fully synced. Steps 4 & 5 advance the status picklist only. *(No new objects yet — fastest path to "SF reflects onboarding".)*
2. **Phase 2 — `Safe_Setup__c`.** One custom object for Step 2.
3. **Phase 3 — Validation rules + Flows.** `NST_Temp_Code__c` uniqueness; `Onboarding_Status__c` auto-transitions (including the `Awaiting Pickup` → `Live` flip when `First_pick_up_date__c` is reached + driver confirms); deferred-pickup nudge Flow.

---

## Open questions for SF admin

1. OK with `Hours_of_Operation_JSON__c` long-text JSON blob, or should we go fielded?
2. `Combo_Last_4__c` — is the existing platform encryption license sufficient, or do we need Shield?
3. Who owns the SFDC Flow build? (Onboarding completion → Account.Account_Stage__c = 'Customer')
4. Should `Safe_Setup__c` be master-detail (cascade delete with Account) or lookup (orphan if Account deleted)? I've recommended master-detail.

---

*Source of truth for existing fields: live SF metadata pulled 2026-04-25 from production org `00D4x0000016EqMEAU`. Raw inventory in `tool_calls/call_external_tool/output_moe3*.json`.*
