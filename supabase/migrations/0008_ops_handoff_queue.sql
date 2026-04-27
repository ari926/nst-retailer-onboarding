-- 0008_ops_handoff_queue.sql
--
-- Outbound queue + trigger + pg_cron schedule for the Ops Handoff PDF email.
-- Mirrors the pattern from 0002 / 0006 / 0007 so we have one mental model:
--
--   step_submissions (step 7 commit) → trigger enqueues ops_handoff_jobs row
--     → pg_cron POSTs every minute → send-ops-handoff Edge Function drains
--     → renders PDF → uploads as ContentVersion to the Opp → sends EmailMessage
--     → marks job 'succeeded' with sfdc_content_version_id + sfdc_email_message_id.
--
-- Why a separate queue (not email_queue):
--   1) The ops handoff has a *file artifact* (ContentVersion) that needs its
--      own SF-side ID tracked alongside the email. Cramming that into
--      email_queue would dilute it.
--   2) The trigger fires on step 7 *commit* only (deferred submissions skip).
--      That's a different rule shape than the kickoff trigger.
--   3) Different recipients (operations@ + CC opp owner) and different
--      sender (Salesforce, via JWT-auth REST), not Resend.
--
-- Trigger rule:
--   - Fires on step_submissions INSERT WHERE step_number = 7
--   - AND submitted_data->>'deferred' IS NOT 'true'  (locked-in commit only)
--   - AND retailer_onboardings.sfdc_opportunity_id IS NOT NULL  (must be tied to an Opp)
--   - Idempotent via unique index on (onboarding_id, kind='step7_commit_v1').

-- ---------- 1. ops_handoff_jobs table ----------

-- Reuses email_queue_status enum from 0007 for status values.
-- (pending | running | succeeded | failed | dead)

create table if not exists public.ops_handoff_jobs (
  id uuid primary key default gen_random_uuid(),
  onboarding_id uuid not null references public.retailer_onboardings(id) on delete cascade,
  submission_id uuid references public.step_submissions(id) on delete set null,
  -- 'kind' lets us add other handoff variants later (re-render, deferred-then-committed, etc.)
  kind text not null default 'step7_commit_v1',
  status email_queue_status not null default 'pending',
  attempts integer not null default 0,
  max_attempts integer not null default 5,
  next_run_at timestamptz not null default now(),
  last_error text,
  -- Populated once the PDF has been uploaded to SF as a ContentVersion.
  sfdc_content_version_id text,
  sfdc_content_document_id text,
  -- Populated once the EmailMessage has been created on the Opportunity.
  sfdc_email_message_id text,
  pdf_byte_size integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists ops_handoff_jobs_due_idx
  on public.ops_handoff_jobs (status, next_run_at)
  where status in ('pending', 'failed');

create index if not exists ops_handoff_jobs_onboarding_idx
  on public.ops_handoff_jobs (onboarding_id);

-- One succeeded handoff per onboarding+kind. We don't want a duplicate ops
-- email if step 7 is somehow re-submitted. If an ops admin needs a re-send,
-- they can flip the existing row back to 'pending' and bump next_run_at.
create unique index if not exists ops_handoff_jobs_once_idx
  on public.ops_handoff_jobs (onboarding_id, kind);

-- updated_at touch (reuse the same touch pattern as sf_sync_queue / email_queue)
drop trigger if exists ops_handoff_jobs_touch on public.ops_handoff_jobs;
create trigger ops_handoff_jobs_touch
  before update on public.ops_handoff_jobs
  for each row execute function public.touch_updated_at();

-- RLS: service role only. No retailer-facing reads.
alter table public.ops_handoff_jobs enable row level security;
-- (no policies = no access for non-service-role; service_role bypasses RLS)

-- ---------- 2. enqueue trigger on step_submissions ----------
--
-- Fires after a step 7 submission is inserted. Rules:
--   - Skip if submitted_data->>'deferred' is 'true' (no PDF until they commit).
--   - Skip if the onboarding has no sfdc_opportunity_id yet (PDF needs an Opp
--     to attach to; this should never happen at step 7 in practice but we
--     guard so we never enqueue an orphan job).
--   - Otherwise: insert a 'pending' job, idempotent on (onboarding_id, kind).

create or replace function public.enqueue_ops_handoff()
returns trigger language plpgsql security definer as $$
declare
  v_opportunity_id text;
  v_deferred       boolean;
begin
  if new.step_number <> 7 then
    return new;
  end if;

  -- Read the deferred flag from the submitted JSON. Treat null/missing/false as
  -- "committed" so a malformed payload still triggers the handoff.
  v_deferred := coalesce((new.submitted_data->>'deferred')::boolean, false);
  if v_deferred then
    return new;
  end if;

  select sfdc_opportunity_id into v_opportunity_id
    from public.retailer_onboardings
   where id = new.onboarding_id;

  if v_opportunity_id is null then
    -- No Opp linked yet — log and skip. Ops can re-fire manually if needed.
    insert into public.audit_log (sfdc_account_id, actor_type, action, metadata)
    select sfdc_account_id, 'system', 'ops_handoff_skipped_no_opp',
           jsonb_build_object('onboarding_id', new.onboarding_id, 'submission_id', new.id)
      from public.retailer_onboardings where id = new.onboarding_id;
    return new;
  end if;

  -- Idempotent enqueue. Partial unique index can't be referenced in ON CONFLICT,
  -- so guard with EXISTS.
  if not exists (
    select 1 from public.ops_handoff_jobs
     where onboarding_id = new.onboarding_id
       and kind = 'step7_commit_v1'
  ) then
    insert into public.ops_handoff_jobs (onboarding_id, submission_id, kind, status)
    values (new.onboarding_id, new.id, 'step7_commit_v1', 'pending');
  end if;

  return new;
end
$$;

drop trigger if exists step_submissions_enqueue_ops_handoff on public.step_submissions;
create trigger step_submissions_enqueue_ops_handoff
  after insert on public.step_submissions
  for each row execute function public.enqueue_ops_handoff();

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
   where jobname = 'send-ops-handoff-drain';
  if existing_jobid is not null then
    perform cron.unschedule(existing_jobid);
  end if;
end
$$;

select cron.schedule(
  'send-ops-handoff-drain',
  '* * * * *',
  $cmd$
    select net.http_post(
      url := 'https://rqmtikbgkplxmmchyujo.supabase.co/functions/v1/send-ops-handoff',
      headers := '{"Content-Type":"application/json"}'::jsonb,
      body := '{}'::jsonb,
      timeout_milliseconds := 120000
    );
  $cmd$
);

comment on table public.ops_handoff_jobs is
  'Ops Handoff PDF + email queue. One row per onboarding+kind. '
  'Drained by send-ops-handoff Edge Function via pg_cron every minute. '
  'On success, stores sfdc_content_version_id (PDF on Opp) and sfdc_email_message_id.';
