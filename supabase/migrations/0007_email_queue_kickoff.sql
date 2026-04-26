-- 0007_email_queue_kickoff.sql
--
-- Outbound email queue + trigger + pg_cron schedule for the
-- post-Step-1 kickoff email. Mirrors the sf_sync_queue + drain-cron
-- pattern from 0002 / 0006 so we have one mental model: a DB trigger
-- enqueues, an Edge Function drains, retries are exponential, and the
-- whole thing is observable in Postgres.
--
-- Why a queue and not a direct call from the trigger? Two reasons:
--   1) PL/pgSQL can't talk to Resend directly without exposing the API
--      key in the DB. Triggers should not own outbound network calls.
--   2) Step 1 submit is in the retailer's hot path. We don't want
--      Resend latency or transient 5xx blocking the submit. The queue
--      decouples submission ack from email send.

-- ---------- 1. email_queue table ----------

do $$
begin
  if not exists (select 1 from pg_type where typname = 'email_queue_status') then
    create type public.email_queue_status as enum (
      'pending',
      'running',
      'succeeded',
      'failed',
      'dead'
    );
  end if;
end $$;

create table if not exists public.email_queue (
  id uuid primary key default gen_random_uuid(),
  onboarding_id uuid not null references public.retailer_onboardings(id) on delete cascade,
  template_key text not null,
  status email_queue_status not null default 'pending',
  attempts integer not null default 0,
  max_attempts integer not null default 5,
  next_run_at timestamptz not null default now(),
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists email_queue_due_idx
  on public.email_queue (template_key, status, next_run_at)
  where status = 'pending';

-- One pending/succeeded kickoff per onboarding. We don't want a second
-- step_submissions row for step 1 (re-submission, retry) to send a
-- duplicate kickoff. If an admin really needs to resend, they can
-- update the existing row's status to 'pending' and bump next_run_at.
create unique index if not exists email_queue_kickoff_once_idx
  on public.email_queue (onboarding_id, template_key)
  where template_key = 'kickoff_step1';

-- updated_at touch
create or replace function public.touch_email_queue_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end
$$;

drop trigger if exists email_queue_touch on public.email_queue;
create trigger email_queue_touch
  before update on public.email_queue
  for each row execute function public.touch_email_queue_updated_at();

-- RLS: service role only. No retailer-facing reads.
alter table public.email_queue enable row level security;
-- (no policies = no access for non-service-role; service_role bypasses RLS)

-- ---------- 2. enqueue trigger on step_submissions ----------

-- Fires after a step 1 submission is inserted. Enqueues a kickoff_step1
-- row. The unique index above ensures idempotency if step 1 is
-- submitted more than once.
create or replace function public.enqueue_kickoff_email()
returns trigger language plpgsql security definer as $$
begin
  if new.step_number = 1 then
    -- Partial unique index (template_key='kickoff_step1') means we can't
    -- name it in ON CONFLICT directly; use a guarded insert instead.
    if not exists (
      select 1 from public.email_queue
      where onboarding_id = new.onboarding_id
        and template_key = 'kickoff_step1'
    ) then
      insert into public.email_queue (onboarding_id, template_key, status)
      values (new.onboarding_id, 'kickoff_step1', 'pending');
    end if;
  end if;
  return new;
end
$$;

drop trigger if exists step_submissions_enqueue_kickoff on public.step_submissions;
create trigger step_submissions_enqueue_kickoff
  after insert on public.step_submissions
  for each row execute function public.enqueue_kickoff_email();

-- ---------- 3. pg_cron drain schedule ----------
--
-- Already-installed extensions from 0006: pg_cron, pg_net.
-- Drain every minute. Unschedule first so this migration is idempotent.

do $$
declare
  existing_jobid bigint;
begin
  select jobid into existing_jobid
  from cron.job
  where jobname = 'send-kickoff-email-drain';
  if existing_jobid is not null then
    perform cron.unschedule(existing_jobid);
  end if;
end
$$;

select cron.schedule(
  'send-kickoff-email-drain',
  '* * * * *',
  $cmd$
    select net.http_post(
      url := 'https://rqmtikbgkplxmmchyujo.supabase.co/functions/v1/send-kickoff-email',
      headers := '{"Content-Type":"application/json"}'::jsonb,
      body := '{}'::jsonb,
      timeout_milliseconds := 60000
    );
  $cmd$
);

comment on table public.email_queue is
  'Outbound transactional email queue. Drained by send-kickoff-email Edge Function via pg_cron every minute.';
