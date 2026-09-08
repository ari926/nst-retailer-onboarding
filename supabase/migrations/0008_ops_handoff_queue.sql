-- 0008_ops_handoff_queue.sql
--
-- send-ops-handoff/index.ts has referenced "migration 0008" since it was
-- written, but no such migration — or any commit creating ops_handoff_jobs,
-- its enqueue trigger, or the pg_cron drain job — ever existed in this repo.
-- All of it was set up directly against the live DB, out of band, and it
-- looks like the enqueue half of that setup never actually happened: a
-- completed onboarding (Amanda Test Account, 2026-09-08) sat with no queue
-- row at all — not stuck, never inserted — so "[NST Ops] New store ready"
-- never fired. Root-caused by manually invoking send-ops-handoff with the
-- onboarding id: the function had to INSERT the job itself (single-shot
-- mode inserts when no existing row is found), proving none existed.
--
-- This migration finally commits that infrastructure, modeled directly on
-- the working hq_sync_outbox pattern from 0007_hq_sync_outbox_live.sql
-- (same status lifecycle, same enqueue-trigger-on-status-change shape).
--
-- Adds:
--   * ops_handoff_jobs        — queue drained by send-ops-handoff
--   * enqueue_ops_handoff_job() — AFTER UPDATE OF status trigger on
--     retailer_onboardings; enqueues a 'step7_commit_v1' job the moment
--     status flips to 'completed' (mirrors enqueue_hq_status_change(),
--     which already works correctly for the HQ widget sync).
--   * cron.schedule(...)      — drains pending/failed jobs every minute via
--     pg_net -> send-ops-handoff, matching the "pg_cron every minute" the
--     function's own comments have always assumed.
--
-- ============================================================================
-- BEFORE APPLYING — Ari, please read:
-- ============================================================================
-- 1. If pg_cron / pg_net are already enabled for other jobs (sf-sync,
--    notify-hq), the `create extension` lines below are no-ops — safe either
--    way.
-- 2. The cron.schedule block at the bottom authenticates its pg_net call via
--    Vault secrets named 'project_url' and 'service_role_key'. If the
--    existing sf-sync / notify-hq cron jobs already use differently-named
--    Vault secrets (or a different auth pattern entirely, since that setup
--    was never committed either), reuse whatever they already use instead
--    of creating new ones — I couldn't inspect the live cron.job table to
--    confirm. Otherwise, run once before applying the schedule at the
--    bottom:
--      select vault.create_secret('https://rqmtikbgkplxmmchyujo.supabase.co', 'project_url');
--      select vault.create_secret('<service-role-key>', 'service_role_key');
-- 3. This does NOT touch the Amanda Test Account row or resend anything —
--    that email already went out via a manual one-off replay on 2026-09-08.
--    This only fixes enqueueing for every onboarding that completes from now on.
-- ============================================================================

create extension if not exists "pgcrypto";
create extension if not exists "pg_net" with schema extensions;
create extension if not exists "pg_cron" with schema extensions;

-- ============================================================================
-- ops_handoff_jobs — queue drained by send-ops-handoff
-- ============================================================================
create table if not exists ops_handoff_jobs (
  id uuid primary key default gen_random_uuid(),
  onboarding_id uuid not null references retailer_onboardings(id) on delete cascade,
  submission_id uuid references step_submissions(id) on delete set null,
  kind text not null default 'step7_commit_v1' check (kind in ('step7_commit_v1')),
  status text not null default 'pending' check (status in (
    'pending','running','succeeded','failed','dead'
  )),
  attempts smallint not null default 0,
  max_attempts smallint not null default 5,
  sfdc_content_version_id text,
  sfdc_content_document_id text,
  last_error text,
  next_run_at timestamptz not null default now(),
  succeeded_at timestamptz,
  created_at timestamptz not null default now(),
  -- One handoff job per onboarding — the enqueue trigger relies on this to
  -- stay idempotent (on conflict do nothing) if status ever flaps.
  unique (onboarding_id, kind)
);

create index if not exists ops_handoff_jobs_pending_idx
  on ops_handoff_jobs (next_run_at)
  where status in ('pending','failed');

create index if not exists ops_handoff_jobs_onboarding_idx
  on ops_handoff_jobs (onboarding_id);

alter table ops_handoff_jobs enable row level security;
-- No policies added — matches every other internal queue table in this
-- schema (hq_sync_outbox, hq_sync_log): service-role only, anon reads and
-- writes both denied by default with RLS enabled and no grants.

-- ============================================================================
-- Enqueue trigger: retailer_onboardings status -> completed => queue job
-- ============================================================================
create or replace function enqueue_ops_handoff_job()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if NEW.status is distinct from OLD.status and NEW.status = 'completed' then
    insert into ops_handoff_jobs (onboarding_id, kind, status)
    values (NEW.id, 'step7_commit_v1', 'pending')
    on conflict (onboarding_id, kind) do nothing;
  end if;

  return NEW;
end;
$$;

drop trigger if exists trg_retailer_onboardings_enqueue_ops_handoff on retailer_onboardings;
create trigger trg_retailer_onboardings_enqueue_ops_handoff
  after update of status on retailer_onboardings
  for each row execute function enqueue_ops_handoff_job();

-- ============================================================================
-- Backfill — catch any already-completed onboarding still missing a job
-- (e.g. the exact situation this migration was written to fix).
-- ============================================================================
insert into ops_handoff_jobs (onboarding_id, kind, status)
select ro.id, 'step7_commit_v1', 'pending'
from retailer_onboardings ro
where ro.status = 'completed'
on conflict (onboarding_id, kind) do nothing;

-- ============================================================================
-- pg_cron: drain ops_handoff_jobs every minute (matches send-ops-handoff's
-- own header comment: "Triggered by pg_cron every minute via pg_net.http_post")
-- ============================================================================
select cron.schedule(
  'drain-ops-handoff-jobs',
  '* * * * *',
  $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url') || '/functions/v1/send-ops-handoff',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key')
    ),
    body := '{}'::jsonb
  )
  where exists (
    select 1 from ops_handoff_jobs
    where status in ('pending','failed') and next_run_at <= now()
  );
  $$
);
