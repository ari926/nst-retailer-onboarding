# NST Retailer Onboarding — Salesforce Deployment Package

This directory contains a Salesforce metadata package that creates everything the NST Retailer Onboarding app needs in your SF org. **Source format (SFDX-compatible)** — also deployable via Workbench/Change Sets after conversion.

> Companion doc: [`../docs/SALESFORCE_FIELDS.md`](../docs/SALESFORCE_FIELDS.md) — explains the schema decisions, what's reused vs. net-new, and open questions for the admin.

## What this package creates

### 10 custom fields on `Account`
| API Name | Type | Purpose |
|---|---|---|
| `NST_Temp_Code__c` | Text(12), unique, external ID | Magic-link claim code |
| `Onboarding_Status__c` | Picklist (9 values) | Step progression tracker |
| `Launch_Date__c` | Date | Confirmed first-pickup date |
| `Hours_of_Operation_JSON__c` | Long Text Area | Weekly hours as JSON |
| `Timezone__c` | Picklist (IANA values) | DST-safe timezone |
| `Store_Type__c` | Picklist | Convenience / Grocery / Pharmacy / etc. |
| `Loading_Dock_Notes__c` | Text(255) | Driver-facing access notes |
| `Bank_Account_Last_4__c` | Text(4) | Display-only — full # never in SF |
| `Voided_Check_URL__c` | URL | Supabase storage link |
| `Pickup_Window__c` | Picklist | Morning / Afternoon / Evening / Overnight |

### 1 custom object: `Safe_Setup__c` (with 9 fields)
Master-detail to Account. Captures Step 2 safe configuration. NAMSYS remains source of truth for live data — this is setup-only.

### 1 custom tab: `Safe_Setup__c`
Lock motif, available (not default-on).

### 1 permission set: `NST Onboarding`
Read/edit on all the above. **Assign to**: integration user (API user), Sales, CS, Ops. No delete on `Safe_Setup__c` (safe records are audit artifacts).

---

## Deployment options

### Option A — SFDX (recommended)
Requires Salesforce CLI installed locally.

```bash
# From the sfdc-deploy/ directory
cd sfdc-deploy

# Authenticate to the production org (one-time)
sf org login web --alias talaria-prod --instance-url https://talariatransportation.my.salesforce.com

# Validate (dry-run, no writes)
sf project deploy validate --target-org talaria-prod --manifest manifest/package.xml

# Deploy
sf project deploy start --target-org talaria-prod --manifest manifest/package.xml

# Assign permission set (replace with target username)
sf org assign permset --name NST_Onboarding --target-org talaria-prod
```

### Option B — Workbench (no CLI needed)
1. Convert source format to MDAPI:
   ```bash
   sf project convert source --root-dir force-app --output-dir mdapi-out
   ```
2. Zip `mdapi-out/`:
   ```bash
   cd mdapi-out && zip -r ../nst-onboarding-package.zip .
   ```
3. Go to https://workbench.developerforce.com → migration → deploy
4. Upload `nst-onboarding-package.zip`, check "Single Package", deploy
5. Manually assign `NST Onboarding` permission set to users

### Option C — Change Sets (only if you have a sandbox)
Not applicable here — the connector audit confirmed this org has no sandbox available.

---

## Pre-deploy checklist for the admin

- [ ] Confirm naming convention is OK (we matched the existing `*_NST_*` and underscore_pattern style)
- [ ] Confirm `Hours_of_Operation_JSON__c` long-text JSON approach (vs. 14 individual time fields)
- [ ] Decide on Shield encryption for `Combo_Last_4__c` (Shield license required)
- [ ] Verify `Safe_Setup__c` master-detail is what you want (cascade delete with Account) vs. lookup (orphan)
- [ ] Add new fields to relevant page layouts (Account, Safe Setup) — **this package does not modify page layouts**
- [ ] Assign `NST Onboarding` permission set to: integration user, Sales profile, CS profile, Ops profile

---

## Post-deploy work (NOT included in this package)

These need admin-built logic:

1. **Validation rules**
   - `NST_Temp_Code__c` populated when `Onboarding_Status__c != 'Live'`
   - `Launch_Date__c` required when `Onboarding_Status__c = 'Live'`

2. **Flows**
   - Onboarding completion → `Account_Stage__c = 'Customer'`
   - `Awaiting Pickup` → `Live` when `First_pick_up_date__c <= TODAY()` AND a `Safe_Setup__c.Verified__c = true` exists
   - 14-day stalled-onboarding nudge to assigned rep
   - Deferred-pickup re-email loop (7 days)

3. **Reports / list views**
   - "Retailers awaiting pickup" (`Onboarding_Status__c = 'Awaiting Pickup'`)
   - "Stalled onboardings" (`Onboarding_Status__c = 'Stalled'`)
   - "Active onboarding pipeline" (`Onboarding_Status__c NOT IN ('Live', 'Not Started')`)

4. **Page layout updates**
   - Add a "NST Onboarding" section to Account page layouts with the 10 new fields
   - Add the Safe Setups related list to Account

5. **Email templates**
   - 24+ existing templates remain in use (incl. 8+ rep-personalized "Welcome to NST"). Splice sample-invoice block into existing templates per `docs/sfdc-email-templates.md` — do not add a 25th template.

---

## Rollback

If anything goes wrong, this package is fully reversible. Run the admin uninstall manifest:

```bash
sf project deploy start --target-org talaria-prod --manifest manifest/destructive-package.xml
```

(See `manifest/destructiveChanges.xml` for the rollback list — generated alongside this package.)

---

*Generated 2026-04-25 from production org metadata audit. Org ID: `00D4x0000016EqMEAU`.*
