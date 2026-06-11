-- HQ ↔ portal bridge support.
--
-- Adds:
--   * hq_sync_log — append-only audit of every outbound webhook the portal
--     fires to HQ. Used to debug delivery + retry-from-DLQ if HQ is down.
--   * hq_sync_outbox — pending webhook deliveries. The notify-hq Edge
--     Function drains this. Inserted by an AFTER INSERT trigger on
--     step_submissions so the wiring is at the database layer, not
--     scattered across application code.
--   * onboarding_tokens.hq_minted_at — flag on existing tokens that
--     were minted via the new HQ-triggered mint-onboarding-token endpoint
--     (vs. ones that existed before this rollout).
--
-- The HQ-side `PORTAL_WEBHOOK_SECRET` is configured as a Lovable / Supabase
-- secret on the portal project too; the Edge Function reads it from env.
-- Nothing in this migration touches secret material.

create extension if not exists "pgcrypto";

-- ============================================================================
-- hq_sync_outbox — pending webhook deliveries
-- ============================================================================
create table if not exists hq_sync_outbox (
  id uuid primary key default gen_random_uuid(),
  event text not null check (event in (
    'step_submitted','step_reopened','onboarding_completed','token_redeemed'
  )),
  sfdc_account_id text not null,
  sfdc_opportunity_id text not null,
  sfdc_contact_id text,
  step_id smallint,
  payload jsonb not null,
  status text not null default 'pending' check (status in (
    'pending','sending','succeeded','failed','dead'
  )),
  attempts smallint not null default 0,
  max_attempts smallint not null default 5,
  last_error text,
  next_run_at timestamptz not null default now(),
  succeeded_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists hq_sync_outbox_pending_idx
  on hq_sync_outbox (next_run_at)
  where status in ('pending','failed');

create index if not exists hq_sync_outbox_opp_idx
  on hq_sync_outbox (sfdc_opportunity_id, created_at desc);

-- No RLS — service role only.
alter table hq_sync_outbox enable row level security;

-- ============================================================================
-- hq_sync_log — append-only audit of every delivery attempt
-- ============================================================================
create table if not exists hq_sync_log (
  id uuid primary key default gen_random_uuid(),
  outbox_id uuid references hq_sync_outbox(id) on delete set null,
  event text not null,
  sfdc_opportunity_id text,
  attempt smallint,
  http_status int,
  ok boolean,
  error text,
  duration_ms int,
  created_at timestamptz not null default now()
);

create index if not exists hq_sync_log_opp_idx
  on hq_sync_log (sfdc_opportunity_id, created_at desc);

alter table hq_sync_log enable row level security;

-- ============================================================================
-- onboarding_tokens — add hq_minted_at flag (table assumed to exist already)
-- ============================================================================
-- Schema for onboarding_tokens lives in the Lovable-managed portal project.
-- We add the column defensively here so future migrations are reproducible.
do $$
begin
  if exists (select 1 from information_schema.tables where table_name = 'onboarding_tokens') then
    alter table onboarding_tokens
      add column if not exists hq_minted_at timestamptz;
    alter table onboarding_tokens
      add column if not exists hq_minted_by_signature text;
  end if;
end$$;

-- ============================================================================
-- Enqueue trigger: every finalized step_submission fires a webhook to HQ
-- ============================================================================
create or replace function enqueue_hq_step_submitted()
returns trigger
language plpgsql
security definer
as $$
declare
  v_opportunity_id text;
  v_contact_id text;
begin
  -- Resolve opportunity + contact via the token table (the token row carries
  -- the SF ids we provisioned for this retailer). If we can't resolve, skip
  -- silently — the cron-driven SF pull will still catch the change.
  select sfdc_opportunity_id, sfdc_contact_id
    into v_opportunity_id, v_contact_id
  from onboarding_tokens
  where sfdc_account_id = NEW.sfdc_account_id
  order by created_at desc
  limit 1;

  if v_opportunity_id is null then
    return NEW;
  end if;

  insert into hq_sync_outbox (
    event,
    sfdc_account_id,
    sfdc_opportunity_id,
    sfdc_contact_id,
    step_id,
    payload
  ) values (
    'step_submitted',
    NEW.sfdc_account_id,
    v_opportunity_id,
    v_contact_id,
    NEW.step_id,
    jsonb_build_object(
      'submission_id', NEW.id,
      'submitted_at', NEW.submitted_at,
      'step_id', NEW.step_id
    )
  );

  return NEW;
end;
$$;

drop trigger if exists trg_step_submissions_enqueue_hq on step_submissions;
create trigger trg_step_submissions_enqueue_hq
  after insert on step_submissions
  for each row execute function enqueue_hq_step_submitted();
