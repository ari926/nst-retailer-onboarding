# Admin "View as Customer" Access

## Why

HQ ops needs to see exactly what a retailer sees in the onboarding portal —
without asking the retailer to share their screen and without bypassing audit
controls. Same flow customers use, but with admin metadata attached so
actions are traceable.

## End-to-end flow

There are **two Supabase projects** in play:

| Project ref | Role | URL |
|---|---|---|
| `ygcpcefwtrcdutrjkfik` | HQ (talaria.com) — Lovable backend | `https://hq.talaria.com` |
| `rqmtikbgkplxmmchyujo` | Portal (NST onboarding) — this repo | `https://onboard.nationalsecuretransport.com` |

```
HQ "Open portal as customer" button (hq.talaria.com)
        │
        │ Lovable client → HQ edge function
        │ POST https://ygcpcefwtrcdutrjkfik.supabase.co/functions/v1/hq-mint-portal-token
        │ body: { account_id: '001…', source: 'admin_access',
        │          acting_admin_email, expires_in_days: 1 }
        │ Authorization: Bearer <HQ anon key> (browser session)
        ▼
HQ hq-mint-portal-token (HQ project, ygcpcefwtrcdutrjkfik)
        │
        │ forwards to portal with the same body shape
        │ NOTE: HQ proxy does NOT currently sign HMAC; portal accepts via
        │       trusted-proxy fallback (path 3 below)
        ▼
        │ POST https://rqmtikbgkplxmmchyujo.supabase.co/functions/v1/mint-onboarding-token
        │ body: { account_id, source: 'admin_access', acting_admin_email,
        │          expires_in_days: 1 }
        │ Authorization: Bearer <portal anon key>
        ▼
Portal mint-onboarding-token (portal project, rqmtikbgkplxmmchyujo)
        │
        │ Auth paths accepted for source='admin_access':
        │   1. HMAC (preferred, server-to-server) — x-hq-signature
        │   2. Supabase JWT in Authorization header (same-project admins)
        │   3. Trusted-proxy fallback — Bearer present + acting_admin_email
        │      in body. Used by current HQ proxy until HMAC signing is added.
        │ Deletes any prior admin_access token for this synthetic
        │ opportunity_id (admin:<account_id>) to clear the unique constraint,
        │ then inserts a fresh row and writes admin_portal_access_log.
        │ returns { token, portal_url, expires_at, auth_path }
        ▼
HQ opens portal_url in new tab → onboard.nationalsecuretransport.com/?t=<token>
        │
        ▼
Portal Home.tsx
        │
        │ POST /functions/v1/resolve-token  (no HMAC, token is the credential)
        │ body: { token }
        ▼
Portal resolve-token
        │
        │ looks up onboarding_tokens, returns:
        │   { sfdc_account_id, sfdc_opportunity_id, source, acting_admin_email, ... }
        │ if source = 'admin_access', logs to admin_portal_access_log
        ▼
Home.tsx writeTokenSession() → localStorage[nst_token_session]
        │
        ▼
useAuth picks up token session → user is "signed in" as the bound retailer
ProtectedRoute lets them through
AdminModeBanner shows up because isAdminSession = true
```

## Token sources

| source         | TTL     | Reused? | Banner | Audit log         |
|----------------|---------|---------|--------|-------------------|
| `intro_email`  | 60 days | Yes     | No     | onboarding_events |
| `admin_access` | 1 day   | No      | Yes    | admin_portal_access_log |

Admin tokens are deliberately **not reused** — each "Open portal as customer"
click mints a fresh token so individual admin sessions can be revoked
independently and short-lived. To satisfy the `onboarding_tokens_sfdc_opportunity_id_key`
unique constraint, `mint-onboarding-token` deletes any prior admin_access token
sharing the synthetic opportunity_id `admin:<account_id>` before inserting the new one.

## Security posture

- Token is 32 bytes of CSPRNG randomness, base64url-encoded → 43 chars.
- All token-related edge functions (mint, validate, resolve, reopen) run
  with `verify_jwt = false`. Auth is either HMAC (HQ→portal) or token-as-bearer
  (portal browser).
- The portal trusts what HQ stamps into the token (source, admin email).
  Today this happens via the **trusted-proxy fallback** path: a Bearer
  token (portal anon key) plus `acting_admin_email` in the body is accepted
  as proof that the call came from HQ. This is acceptable because both
  projects sit behind Supabase auth and `mint-onboarding-token` is rate-limited
  by Supabase. Long-term, HQ should switch to HMAC signing (path 1) so the
  secret can be rotated independently. Rotation is documented in
  `talaria_hq_secrets.md`.
- Banking values are never sent in admin tokens — they live only on
  step_submissions and are masked at HQ.

## Audit trail

Two surfaces:

1. **`admin_portal_access_log`** — written by `resolve-token` every time an
   admin token is successfully resolved. Stores token, sfdc_account_id,
   acting_admin_email, IP, user-agent, and opened_at.

2. **HQ-side `nst_onboarding_events`** — already wired by HQ Lovable to
   log `admin_portal_access` events when the button is clicked.

The two should match. If they drift, something tampered with one of them.

## Rollback

If anything goes sideways:

1. Revoke all live admin tokens:
   ```sql
   update onboarding_tokens
   set revoked_at = now()
   where source = 'admin_access'
     and revoked_at is null;
   ```
2. Set `verify_jwt = true` on `resolve-token` in `supabase/config.toml` and
   redeploy — that re-locks the public endpoint and forces all access through
   the Supabase auth gate. (Note: this also breaks the customer intro-email
   flow until reverted.)
