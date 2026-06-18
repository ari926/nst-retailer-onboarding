-- ============================================================================
-- 0009_onboarding_tokens.sql
--
-- Tokenized magic-link table for the kickoff email.
--
-- One token is minted per Opportunity when Flow B fires (Closed Won → Account
-- Onboarding_Status flips to "Claimed"). The token is embedded in the
-- /onboarding/start?token=... URL surfaced via Opportunity.Onboarding_URL__c
-- formula field, which the email template merges in.
--
-- The retailer clicks the link and the resolve-onboarding-token edge function:
--   1. Looks up the token row
--   2. Pulls live Account + Opportunity + Contact data from Salesforce via the
--      existing JWT auth pattern
--   3. Returns a "prefill bundle" + a short-lived Supabase session keyed to the
--      sfdc_account_id (so RLS works for step_drafts/submissions)
--
-- Tokens are single-machine-scoped: redeemed_at + last_used_ip recorded for
-- audit. Tokens do NOT expire by time — onboarding may take days — but they
-- can be revoked by setting revoked_at.
-- ============================================================================

create extension if not exists "pgcrypto";

create table if not exists onboarding_tokens (
  -- The token value the retailer carries in the URL. URL-safe random.
  token              text primary key,

  -- Salesforce identifiers we need to resolve prefill data + scope RLS.
  sfdc_account_id    text not null,
  sfdc_opportunity_id text not null,
  sfdc_contact_id    text,            -- Primary Contact, may be null

  -- Convenience copies populated at mint time. The resolve edge function
  -- always re-fetches from SFDC for live data, but having these here lets
  -- the link itself be debugged without a SFDC call.
  recipient_email    text,
  recipient_first_name text,
  account_name       text,

  -- Lifecycle
  created_at         timestamptz not null default now(),
  first_redeemed_at  timestamptz,
  last_redeemed_at   timestamptz,
  redeem_count       integer not null default 0,
  last_used_ip       text,
  last_user_agent    text,
  revoked_at         timestamptz,
  revoke_reason      text,

  unique (sfdc_opportunity_id)         -- one token per Opp
);

create index if not exists onboarding_tokens_account_idx
  on onboarding_tokens (sfdc_account_id);
create index if not exists onboarding_tokens_active_idx
  on onboarding_tokens (revoked_at)
  where revoked_at is null;

-- Service-role-only table — retailers never query this directly.
-- The edge function uses the service-role key.
alter table onboarding_tokens enable row level security;

-- Explicitly: NO retailer-facing policies. Only service_role can read/write.

comment on table onboarding_tokens is
  'Single-use-per-Opp magic-link tokens for the kickoff email. Resolved by the resolve-onboarding-token edge function which trades the token for a scoped Supabase session + live SFDC prefill bundle.';

-- ============================================================================
-- mint_onboarding_token RPC — invoked by Flow B (via Pipedream / sf-sync) or
-- by a SQL trigger. Idempotent: re-calling for the same Opp returns the
-- existing token (so Flow B retries don't generate fresh URLs).
-- ============================================================================
create or replace function mint_onboarding_token(
  p_sfdc_account_id    text,
  p_sfdc_opportunity_id text,
  p_sfdc_contact_id    text default null,
  p_recipient_email    text default null,
  p_recipient_first_name text default null,
  p_account_name       text default null
) returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_token text;
  v_existing text;
begin
  -- Return existing if not revoked
  select token into v_existing
  from onboarding_tokens
  where sfdc_opportunity_id = p_sfdc_opportunity_id
    and revoked_at is null
  limit 1;

  if v_existing is not null then
    return v_existing;
  end if;

  -- Mint new — 32 bytes of randomness, URL-safe base64.
  v_token := translate(encode(gen_random_bytes(32), 'base64'), '+/=', '-_');

  insert into onboarding_tokens (
    token, sfdc_account_id, sfdc_opportunity_id, sfdc_contact_id,
    recipient_email, recipient_first_name, account_name
  ) values (
    v_token, p_sfdc_account_id, p_sfdc_opportunity_id, p_sfdc_contact_id,
    p_recipient_email, p_recipient_first_name, p_account_name
  );

  return v_token;
end;
$$;

revoke all on function mint_onboarding_token(text, text, text, text, text, text) from public;
grant execute on function mint_onboarding_token(text, text, text, text, text, text) to service_role;

comment on function mint_onboarding_token is
  'Idempotently mints a tokenized onboarding URL for an Opportunity. Returns the token string to embed in the kickoff email link.';

-- ============================================================================
-- record_token_redemption RPC — tracks redemption metadata for audit.
-- ============================================================================
create or replace function record_token_redemption(
  p_token   text,
  p_ip      text default null,
  p_user_agent text default null
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update onboarding_tokens
  set first_redeemed_at = coalesce(first_redeemed_at, now()),
      last_redeemed_at  = now(),
      redeem_count      = redeem_count + 1,
      last_used_ip      = coalesce(p_ip, last_used_ip),
      last_user_agent   = coalesce(p_user_agent, last_user_agent)
  where token = p_token
    and revoked_at is null;
end;
$$;

revoke all on function record_token_redemption(text, text, text) from public;
grant execute on function record_token_redemption(text, text, text) to service_role;
