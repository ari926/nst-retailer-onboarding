# NST Retailer Onboarding — V1 Production Checklist

Owner: Ari Raptis (`ari@talaria.com`)
Repo: [ari926/nst-retailer-onboarding](https://github.com/ari926/nst-retailer-onboarding)
Target launch: first retailer pilot — two stores in Q2 2026.

Everything in this doc must be ✅ before the first real retailer email goes out.

---

## 1. Infrastructure & DNS

V1 deploys to **GitHub Pages** (Vercel never worked — sandbox token issue). The
`vercel.json` in the repo root is vestigial; ignore it.

- [ ] **GoDaddy CNAME**: log in to GoDaddy → DNS for `nationalsecuretransport.com` →
      add record:
      - Type: `CNAME`
      - Name: `onboard`
      - Value: `ari926.github.io.`
      - TTL: 1 hour
      Verify with `dig onboard.nationalsecuretransport.com +short` — should
      return `ari926.github.io` once propagated (5–60 min).
- [ ] `public/CNAME` committed with body `onboard.nationalsecuretransport.com`
      so each Vite build copies it to `dist/`.
- [ ] **GitHub repo settings** → **Pages**:
      - Source: `gh-pages` branch, `/ (root)` folder.
      - Custom domain: `onboard.nationalsecuretransport.com` (saved, green
        check mark from GitHub's DNS check).
      - Enforce HTTPS: enabled (Let's Encrypt cert auto-issued; can take up
        to 24h after first save).
- [ ] Build + publish flow documented for ops:
      `VITE_MOCK_AUTH=true npm run build` then push `dist/` contents to
      `gh-pages`. Replace `VITE_MOCK_AUTH=true` with `false` once §2 (Supabase)
      is fully wired and Salesforce is seeding real accounts.
- [ ] **SPA fallback for BrowserRouter**: when `VITE_MOCK_AUTH=false` flips us
      from `HashRouter` to `BrowserRouter`, add `public/404.html` (duplicate of
      `index.html`) so GitHub Pages serves the SPA shell on direct deep-links
      like `/onboarding/safe`. Not needed under HashRouter.
- [ ] Production environment variables baked into the build (Vite reads at
      build time, not runtime — no `.env` server):
  - `VITE_SUPABASE_URL`
  - `VITE_SUPABASE_ANON_KEY`
  - `VITE_MOCK_AUTH=false`
  - `VITE_SENTRY_DSN`
- [ ] Support footer + emails point to `support@nstops.com` (already in
      `Header.tsx` mailto handler).

## 2. Supabase

- [ ] Project `rqmtikbgkplxmmchyujo` upgraded from Free to **Pro** tier (Free ties wake with cold starts; Pro keeps Edge Functions warm).
- [ ] Weekly PITR backups confirmed on `rqmtikbgkplxmmchyujo` dashboard.
- [ ] `service_role` key rotated and stored in Vercel + 1Password. Never checked into the repo.
- [ ] RLS enabled on every table — run `scripts/verify-rls.sql` and confirm zero tables report `rls_enabled=false`.
- [ ] Edge Function secrets set in Supabase dashboard:
  - `RESEND_API_KEY` (restricted sender: `onboarding@mail.nstops.com`)
  - `SFDC_WEBHOOK_SECRET` (HMAC shared secret for `sf-webhook`)
  - `SFDC_CLIENT_ID`, `SFDC_CLIENT_SECRET`, `SFDC_USERNAME`, `SFDC_PASSWORD` (JWT Bearer flow)
  - `AWS_TEXTRACT_ACCESS_KEY`, `AWS_TEXTRACT_SECRET_KEY`, `AWS_TEXTRACT_REGION=us-east-1`
  - `USPS_USERID` (for `/usps-validate` — see §7)
- [ ] `supabase migration list` shows `0001_core_schema` through `0004_invoice_samples` applied on prod.

## 3. Salesforce

- [ ] **Sandbox** sync tested end-to-end for all 7 steps with a dummy account.
- [ ] Production `Connected App` created with JWT Bearer flow; cert installed in Supabase Edge Function secrets.
- [ ] Scheduled Flow "NST — Nudge deferred retailers" running every 2 weeks; `MAX_DEFERRED_NUDGES = 6` enforced.
- [ ] Email Template records created for all 5 templates (`nst_sample_invoice`, `nst_launch_confirmed`, `nst_launch_reminder`, `nst_step_reopened`, `nst_deferred_nudge`) — see [`docs/sfdc-email-templates.md`](./sfdc-email-templates.md).
- [ ] Webhook URL `https://rqmtikbgkplxmmchyujo.functions.supabase.co/sf-webhook` registered with SFDC and returning 200 on test payload.

## 4. Email (Resend)

- [ ] Domain `mail.nstops.com` verified (SPF, DKIM, DMARC) — green check in Resend dashboard.
- [ ] DMARC policy set to `p=quarantine; pct=100` (not `reject` yet — one-week soak first).
- [ ] Bounce + complaint webhooks wired to `sf-webhook` (type: `email_bounced`).
- [ ] Monthly send volume projection under 50k messages (the plan's cap).
- [ ] Render-only preview of all 5 templates reviewed by NST ops lead — [`preview/`](../preview/).

## 5. Security

- [ ] `npm audit --production` returns zero high/critical.
- [ ] CSP header set in `vercel.json` — `default-src 'self'; connect-src 'self' https://*.supabase.co https://api.resend.com`.
- [ ] Banking fields (`account_number`, `routing_number`) confirmed encrypted at rest via Supabase column encryption (`pgsodium`). Only `*_last4` columns stored in plaintext.
- [ ] Safe combinations: confirmed never persisted server-side (Step 2 form submits `combo_hint` only; full combo stays on retailer's paper form).
- [ ] Sentry source maps uploaded, DSN restricted to `onboarding.nstops.com`.
- [ ] Rate limiting on `/claim` enabled (10 requests/min/IP via Vercel Edge Middleware).
- [ ] GDPR/CCPA: privacy policy link in footer points to `nstops.com/privacy`.

## 6. Build & Bundle

- [ ] `npm run build` completes with zero TS errors, zero console warnings.
- [ ] Main bundle < 600KB gzipped (jspdf/html2canvas/supabase are separate vendor chunks).
- [ ] Lighthouse performance score ≥ 85 on `/` and `/onboarding`.
- [ ] Lazy chunks load correctly from CDN (verify `Network` tab in DevTools).

## 7. External integrations (V1 stubs → production)

| Integration | V1 status | Production blocker |
|---|---|---|
| USPS Address Validation | Stub in `validators.ts` | Provision USPS Web Tools USERID, ship `/usps-validate` Edge Function |
| Twilio phone verification | Client-side E.164 normalize only | Not V1 — ops manually confirms phone during first call |
| Email MX check | `validators.ts` calls `/api/mx-check` (no-op) | Deploy `mx-check` Edge Function using Deno's `Deno.resolveDns` |
| AWS Textract | Mock returns sample data | Swap `ocrService.ts` mock for real `startDocumentAnalysis` call |

## 8. Observability

- [ ] Sentry project `nst-retailer-onboarding` created and wired to main.
- [ ] Release tagging: `sentry-cli releases new "$(git rev-parse --short HEAD)"` on every deploy.
- [ ] Uptime check on `GET /` and `GET /onboarding` via BetterStack (2-min interval).
- [ ] Supabase log drain → Datadog (or a Loki instance) for Edge Function logs.
- [ ] Analytics events flowing through `lib/analytics.ts` → GTM dataLayer → GA4. Verify at least `home.claim_clicked`, `step.completed`, `onboarding.pdf_downloaded`.

## 9. Accessibility & Browser support

- [ ] `axe-core` run on every step, zero serious/critical violations.
- [ ] Keyboard-only walk-through of all 7 steps with no traps (pay attention to Step 2 radio grid and Step 7 day pills).
- [ ] Tested on iOS Safari 16+, Android Chrome 120+, Windows Edge 120+, macOS Safari 17+.
- [ ] Language toggle persists across reload (key: `nst_lang`).

## 10. Content & Copy

- [ ] PDF handoff generator tested in both EN and ES (download, eyeball section headers).
- [ ] Email templates reviewed by NST CS lead — no Talaria/Ethos copy leaked.
- [ ] Support footer on every page points to `support@nstops.com` + `(212) 555-NSTO`.
- [ ] All `TODO`, `FIXME`, "PR #N" comments in shipping files removed or turned into linked GitHub issues.

## 11. Rollout

- [ ] Pilot list finalized: two stores in the NY metro, English + Spanish speakers.
- [ ] Ops-side runbook in Confluence: how to reopen a step, how to re-send sample invoice, how to handle an SFDC sync failure.
- [ ] On-call rotation for first 30 days: @ari + one NST ops engineer.
- [ ] Rollback plan: `vercel rollback` to prior deploy, `supabase migration repair` noted.
- [ ] Go/no-go review meeting booked 48h before first retailer email.

---

## Known deferred items (V2)

These are intentionally **not** blockers for V1:

- Retailer-uploaded logo on ops handoff PDF (V1 prints "NST" wordmark only).
- Auth portability between marketplace and onboarding portals (per Ari: "Let's not worry about how things are connected right now").
- Multi-location retailers — V1 ships one storefront per SFDC account; V2 adds a location switcher.
- Real-time chat with NST rep — V1 shows an email CTA ("Message our team").
- Push notifications for deferred nudges — V1 sends email only.

---

*Last updated: 2026-04-24 (PR #14).*
