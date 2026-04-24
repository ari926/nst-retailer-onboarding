# NST Retailer Onboarding

Self-serve onboarding flow for new National Secure Transport retailers. Runs at **onboard.nationalsecuretransport.com** after contract signature.

## Stack

- React 19 + Vite 8 + TypeScript
- Supabase (Auth, Postgres, Storage)
- React Router v7, TanStack Query, Zustand
- react-i18next (EN / ES — informal "tú")
- React Hook Form + Zod
- jsPDF for the Ops Handoff PDF
- Playwright for E2E
- Deployed on Vercel

## Getting started

```bash
npm install
cp .env.example .env.local   # fill in Supabase + Resend + AWS keys
npm run dev
```

Dev server runs at `http://localhost:5173`.

## Scripts

| Command              | What it does                                 |
| -------------------- | -------------------------------------------- |
| `npm run dev`        | Vite dev server                              |
| `npm run build`      | Type-check + production bundle               |
| `npm run preview`    | Serve production build locally               |
| `npm run lint`       | ESLint                                       |
| `npm test`           | Playwright E2E                               |
| `npm run test:ui`    | Playwright UI mode                           |
| `npm run types:supabase` | Regenerate `src/types/database.ts` from DB |

## Project layout

```
src/
  components/     layout/, ui/, steps/
  hooks/          React hooks
  lib/            supabase.ts, i18n.ts, etc.
  pages/          route components
  stores/         Zustand stores
  styles/         tokens.css, components.css, etc.
  types/          generated + hand-written TS types
  utils/          pure helpers
  i18n/           en.json, es.json
supabase/         migrations (7-table schema already applied)
docs/             PRD, Script, Decisions
tests/e2e/        Playwright specs
```

## Environment

Backed by Supabase project `nst-onboarding` (ref `rqmtikbgkplxmmchyujo`, us-east-1, Free tier). The 7-table schema with RLS is already applied.

See `.env.example` for all required keys. Salesforce field setup is documented in `docs/SALESFORCE_FIELDS.md` (lands in a later PR — see handoff package).

## PR roadmap

This repo is built incrementally across 14 PRs:

1. **Scaffold** (this PR) — Vite + React + Supabase + Nexus-style CSS
2. Design system + layout shell
3. Auth + Step 0 (claim account, MFA)
4. Step 1 — store profile + hours + contacts
5. Step 2 — safe + keys
6. Step 3 — banking + OCR (Textract)
7. Steps 4 & 5 — deposit + change order dry-runs
8. Step 6 — invoicing contact + sample invoice
9. Step 7 — first pickup + deferred loop
10. Ops Handoff PDF generator
11. Salesforce sync + webhooks
12. Email integration (Resend)
13. Playwright E2E tests
14. Polish, error states, analytics

## License

Proprietary — © National Secure Transport.
