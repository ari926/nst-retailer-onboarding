-- 0006_admin_token_metadata.sql
-- Adds admin-mode metadata to onboarding_tokens so the portal can distinguish
-- customer-facing tokens (from the intro email) from admin "view as customer"
-- tokens minted from HQ's NST Onboarding detail page.
--
-- See README / docs/hq-bridge.md for the full flow.

do $$
begin
  if exists (select 1 from information_schema.tables where table_name = 'onboarding_tokens') then

    -- source: where this token came from
    --   'intro_email'  → customer-facing, long-lived (60d), email gate stays
    --   'admin_access' → HQ admin viewing customer's portal, short-lived (24h),
    --                    bypasses email gate, every action is audit-logged
    alter table onboarding_tokens
      add column if not exists source text not null default 'intro_email';

    alter table onboarding_tokens
      add constraint onboarding_tokens_source_check
      check (source in ('intro_email', 'admin_access'))
      not valid;

    alter table onboarding_tokens
      validate constraint onboarding_tokens_source_check;

    -- acting_admin_email: who minted this token (only set when source = 'admin_access')
    alter table onboarding_tokens
      add column if not exists acting_admin_email text;

    -- Index for lookups + analytics
    create index if not exists onboarding_tokens_source_idx
      on onboarding_tokens (source);

    create index if not exists onboarding_tokens_acting_admin_idx
      on onboarding_tokens (acting_admin_email)
      where acting_admin_email is not null;
  end if;
end$$;

-- Audit log of admin portal opens. Lets HQ show "Recent admin views" and gives
-- us a tamper-evident record if a retailer asks "who looked at my data?"
create table if not exists admin_portal_access_log (
  id uuid primary key default gen_random_uuid(),
  token text not null,
  sfdc_account_id text not null,
  sfdc_opportunity_id text,
  acting_admin_email text not null,
  opened_at timestamptz not null default now(),
  user_agent text,
  ip_address text
);

create index if not exists admin_portal_access_log_account_idx
  on admin_portal_access_log (sfdc_account_id, opened_at desc);

create index if not exists admin_portal_access_log_admin_idx
  on admin_portal_access_log (acting_admin_email, opened_at desc);
