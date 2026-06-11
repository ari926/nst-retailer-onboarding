# HQ ↔ portal bridge

Wires this portal to **Talaria HQ** (the Lovable internal ops app) so that:

1. The **"Send introduction email"** button in HQ mints a token here and emails
   the retailer the kickoff email with a tokenized portal link.
2. Every retailer step submission pushes a near-real-time webhook back to HQ
   so the NST Onboarding tab updates within ~1–2s.
3. Salesforce stays the source of truth for retailer-owned data. HQ stores
   a read-only mirror with banking masked to last-4 only.

## Architecture

```
SF Closed Won
    │
    └──► HQ sf-closed-won-webhook
           │
           └──► creates nst_retailer_onboarding_state row
                  │
                  ├──► (manual) ops clicks "Send introduction email"
                  │       │
                  │       ├──► HQ calls portal /mint-onboarding-token (HMAC)
                  │       │     ◄── { token, portal_url }
                  │       │
                  │       └──► HQ sends kickoff email with tokenized link
                  │
                  └──► retailer fills steps on portal
                         │
                         └──► step_submissions INSERT
                                │
                                ├──► (existing) sf_sync_queue → Salesforce
                                │
                                └──► (NEW) trg_step_submissions_enqueue_hq
                                       → hq_sync_outbox row
                                          │
                                          └──► notify-hq cron drains outbox
                                                 → HQ portal-progress-webhook
                                                    (HMAC-signed payload)
```

## Edge Functions added by this PR

| Function | Caller | Auth |
|---|---|---|
| `mint-onboarding-token` | HQ | HMAC `x-hq-signature` |
| `validate-token` | HQ | HMAC `x-hq-signature` |
| `notify-hq` | cron / ad-hoc | cron secret (none for ad-hoc dev) |
| `reopen-step` | HQ | HMAC `x-hq-signature` |

## Shared secret

`PORTAL_WEBHOOK_SECRET` — same value on HQ and portal sides. Lives in:

- **HQ:** Lovable secret + Supabase Vault entry
- **Portal:** Lovable secret on this project (set via Lovable secrets UI)

Rotate annually or on suspected leak. Rotation procedure:

1. Generate new: `openssl rand -hex 32`
2. Update Lovable secret on both projects + Supabase Vault on HQ
3. Update `talaria_hq_secrets.md` in the HQ Development Space
4. No code change required — both sides read from env

## Outbox + retry behavior

`hq_sync_outbox` is the buffer between portal step submissions and HQ.
Inserted by a Postgres AFTER INSERT trigger on `step_submissions` so the
wiring is database-layer, not application-layer.

Drained every 30s by `notify-hq` cron. Backoff schedule on failure:
`30s → 2m → 10m → 30m → 1h`, max 5 attempts, then status = `dead`. Dead
rows are visible in `hq_sync_log` for ops debugging and can be requeued
manually via `update hq_sync_outbox set status='pending', attempts=0`.

## Banking safety

The `notify-hq` function `buildFieldSnapshot(stepId=3, payload)` explicitly
strips full account/routing numbers and only ships last-4. Even if the
submission payload accidentally contains the full numbers (it shouldn't —
the submit-step function masks before persisting), they will not cross the
wire to HQ.

HQ's `nst_retailer_onboarding_state` table has a CHECK constraint that
rejects any value in `routing_last_4` / `account_last_4` that isn't
exactly 4 digits.

## Idempotency

HQ's `portal-progress-webhook` has a unique index on
`(opportunity_id, event, step_id, submitted_at)` in the audit log. Replays
return `{ ok: true, deduped: true }` without side effects.

## Smoke test

See `library_lovable_prompt_45_nst_onboarding_hq_portal_bridge.md` in the
HQ Development Space — Part F walks through end-to-end verification.
