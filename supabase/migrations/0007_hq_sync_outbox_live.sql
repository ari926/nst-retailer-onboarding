-- 0007_hq_sync_outbox_live.sql
--
-- Ships the HQ ↔ portal bridge plumbing that 0005_hq_bridge.sql described but
-- never actually got applied to the live DB. Also rewrites the enqueue trigger
-- against the *real* step_submissions schema (which uses step_number /
-- submitted_data / onboarding_id, not step_id / payload / sfdc_account_id like
-- 0005 assumed).
--
-- Adds:
--   * hq_sync_outbox   — queued webhook deliveries drained by notify-hq
--   * hq_sync_log      — append-only audit of every delivery attempt
--   * enqueue_hq_step_submitted() — AFTER INSERT/UPDATE trigger on
--     step_submissions; resolves SF ids from retailer_onboardings.
--   * enqueue_hq_status_change()  — AFTER UPDATE trigger on
--     retailer_onboardings; fires onboarding_completed when status flips
--     to 'completed'.

create extension if not exists "pgcrypto";
create extension if not exists "pg_net" with schema extensions;

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
-- onboarding_tokens — add hq_minted_* columns (defensive; may already exist)
-- ============================================================================
do $$
begin
  if exists (select 1 from information_schema.tables where table_name = 'onboarding_tokens') then
    alter table onboarding_tokens add column if not exists hq_minted_at timestamptz;
    alter table onboarding_tokens add column if not exists hq_minted_by_signature text;
  end if;
end$$;

-- ============================================================================
-- Enqueue trigger: step_submissions insert OR update => enqueue step_submitted
-- ============================================================================
create or replace function enqueue_hq_step_submitted()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_account_id text;
  v_opportunity_id text;
  v_contact_id text;
begin
  -- Pull SF ids off retailer_onboardings (joined via onboarding_id).
  select ro.sfdc_account_id, ro.sfdc_opportunity_id
    into v_account_id, v_opportunity_id
  from retailer_onboardings ro
  where ro.id = NEW.onboarding_id;

  if v_account_id is null or v_opportunity_id is null then
    -- No SF mapping yet; skip silently. HQ will sync later if needed.
    return NEW;
  end if;

  -- Contact id lives on onboarding_tokens, latest one wins.
  select ot.sfdc_contact_id
    into v_contact_id
  from onboarding_tokens ot
  where ot.sfdc_account_id = v_account_id
  order by ot.created_at desc
  limit 1;

  insert into hq_sync_outbox (
    event,
    sfdc_account_id,
    sfdc_opportunity_id,
    sfdc_contact_id,
    step_id,
    payload
  ) values (
    'step_submitted',
    v_account_id,
    v_opportunity_id,
    v_contact_id,
    NEW.step_number,
    jsonb_build_object(
      'submission_id', NEW.id,
      'submitted_at', NEW.submitted_at,
      'step_number', NEW.step_number,
      'onboarding_id', NEW.onboarding_id
    )
  );

  return NEW;
end;
$$;

drop trigger if exists trg_step_submissions_enqueue_hq on step_submissions;
create trigger trg_step_submissions_enqueue_hq
  after insert or update of submitted_at on step_submissions
  for each row execute function enqueue_hq_step_submitted();

-- ============================================================================
-- Enqueue trigger: retailer_onboardings status -> completed => onboarding_completed
-- ============================================================================
create or replace function enqueue_hq_status_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_contact_id text;
begin
  if NEW.status is distinct from OLD.status and NEW.status = 'completed' then
    if NEW.sfdc_account_id is null or NEW.sfdc_opportunity_id is null then
      return NEW;
    end if;

    select ot.sfdc_contact_id
      into v_contact_id
    from onboarding_tokens ot
    where ot.sfdc_account_id = NEW.sfdc_account_id
    order by ot.created_at desc
    limit 1;

    insert into hq_sync_outbox (
      event,
      sfdc_account_id,
      sfdc_opportunity_id,
      sfdc_contact_id,
      step_id,
      payload
    ) values (
      'onboarding_completed',
      NEW.sfdc_account_id,
      NEW.sfdc_opportunity_id,
      v_contact_id,
      null,
      jsonb_build_object(
        'onboarding_id', NEW.id,
        'completed_at', NEW.completed_at,
        'submitted_at', coalesce(NEW.completed_at, now())
      )
    );
  end if;

  return NEW;
end;
$$;

drop trigger if exists trg_retailer_onboardings_enqueue_hq_status on retailer_onboardings;
create trigger trg_retailer_onboardings_enqueue_hq_status
  after update of status on retailer_onboardings
  for each row execute function enqueue_hq_status_change();
