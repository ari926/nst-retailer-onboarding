# CLAUDE.md — working notes for this repo

Context for AI assistants working on this codebase.

## What this app is

Self-serve onboarding for new NST retailers after contract signature. 7 steps + "not sure yet" deferral loop. Lives at `onboard.nationalsecuretransport.com`.

## Stack hard rules

- **React 19 + Vite + TS** — matches Talaria Marketplace pattern. Do NOT introduce Next.js.
- **Supabase** for Auth, DB, Storage. Project ref `rqmtikbgkplxmmchyujo`. Schema is 7 tables with RLS — see `supabase/migrations/`.
- **Salesforce is the system of record** for retailer data. Supabase holds onboarding state only (submissions, drafts, OCR, files, email log, audit).
- **NST brand only** — never display bank / processor logos.
- **EN / ES** — Spanish uses informal "tú".
- **No tailwind** — Nexus-style CSS tokens in `src/styles/`.

## Do not touch

- The `Ethos` Supabase project — separate health project.
- Talaria Marketplace, Atlas V2, NST HQ (Lovable) — separate repos.

## Key product rules

- 10-day calendar minimum for first pickup.
- "I'm not sure yet" path → deferred loop, biweekly emails, max 6 reminders.
- Ops Handoff PDF emails to `operations@nationalsecuretransport.com` on completion.
- SFDC owns cron via Scheduled Flows — we do not run our own cron.
- Do NOT retrofit existing retailers; this is for new accounts only.

## PR discipline

Work ships in 14 PRs (see `README.md`). Each PR is independently reviewable and does one thing. Never mix concerns across PRs.

## Conventions

- Absolute-ish imports via Vite alias `@/` → `src/`.
- React Hook Form + Zod for every form. Schemas live next to the component.
- Server state: TanStack Query. Client state: Zustand. Never mix.
- All user-facing strings go through i18n — no hardcoded English in components.
- Every DB mutation writes to `audit_log`.
