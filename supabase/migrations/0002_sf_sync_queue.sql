-- Salesforce sync queue + launch date tracking.
--
-- Flow:
--   1. step_submissions insert fires the `sync_step_to_sf` trigger which
--      enqueues a row in `sf_sync_queue`.
--   2. `sf-sync` Edge Function runs on a schedule (pg_cron every minute),
--      claims pending rows (`SKIP LOCKED`), calls SF Apex REST, writes the
--      returned SF object id back into step_submissions, and marks the queue
--      row as `succeeded` or `failed` with a retry count.
--   3. Failures are retried with exponential backoff up to `max_attempts`;
--      after that the row is marked `dead` and alerts ops via Slack webhook.
--
-- This separates the client-facing write path from the fragile SF integration
-- so retailer submits never fail because of SF outages.

create type sf_sync_status as enum ('pending', 'running', 'succeeded', 'failed', 'dead');

create table if not exists sf_sync_queue (
  id uuid primary key default gen_random_uuid(),
  submission_id uuid not null references step_submissions (id) on delete cascade,
  sfdc_account_id text not null,
  step_id smallint not null,
  operation text not null default 'upsert_step',
  payload jsonb not null,
  status sf_sync_status not null default 'pending',
  attempts smallint not null default 0,
  max_attempts smallint not null default 5,
  next_run_at timestamptz not null default now(),
  last_error text,
  sf_object_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists sf_sync_queue_runnable_idx
  on sf_sync_queue (next_run_at)
  where status in ('pending', 'failed');

create index if not exists sf_sync_queue_account_idx
  on sf_sync_queue (sfdc_account_id, status);

-- Trigger: auto-enqueue a sync row on every step_submissions insert.
create or replace function enqueue_sf_sync()
returns trigger
language plpgsql
as $$
begin
  insert into sf_sync_queue (
    submission_id, sfdc_account_id, step_id, payload
  )
  values (
    new.id, new.sfdc_account_id, new.step_id, new.payload
  );
  return new;
end;
$$;

drop trigger if exists step_submissions_enqueue_sf on step_submissions;
create trigger step_submissions_enqueue_sf
  after insert on step_submissions
  for each row execute function enqueue_sf_sync();

-- ============================================================================
-- launch_status — one row per retailer tracking activation state.
-- Populated by the sf-webhook function when SFDC confirms a launch date.
-- ============================================================================
create table if not exists launch_status (
  sfdc_account_id text primary key,
  status text not null default 'in_setup' check (
    status in ('in_setup', 'ready_for_review', 'launch_scheduled', 'live', 'churned')
  ),
  launch_date date,
  locked boolean not null default true,
  last_nudge_sent_at timestamptz,
  nudge_count smallint not null default 0,
  updated_at timestamptz not null default now()
);

alter table launch_status enable row level security;

create policy "retailers_read_own_launch_status" on launch_status
  for select using (
    sfdc_account_id = coalesce(
      auth.jwt() ->> 'sfdc_account_id',
      (auth.jwt() -> 'user_metadata' ->> 'sfdc_account_id')
    )
  );

-- touch_updated_at trigger for both tables.
create or replace function touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists sf_sync_queue_touch on sf_sync_queue;
create trigger sf_sync_queue_touch
  before update on sf_sync_queue
  for each row execute function touch_updated_at();

drop trigger if exists launch_status_touch on launch_status;
create trigger launch_status_touch
  before update on launch_status
  for each row execute function touch_updated_at();
