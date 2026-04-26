-- 0006_pg_cron_sf_sync.sql
--
-- Schedules the sf-sync edge function to run every minute via pg_cron + pg_net.
-- This is what closes the loop on the queue: step_submissions insert →
-- enqueue trigger → sf_sync_queue → cron-driven HTTP POST → edge function
-- drains the queue → SF.
--
-- Already applied to production on 2026-04-26.
-- Verified: cron.job_run_details + net._http_response both show 200 OK.

create extension if not exists pg_cron with schema extensions;
create extension if not exists pg_net  with schema extensions;

-- Idempotent: unschedule if it already exists, then re-create.
do $$
begin
  if exists (select 1 from cron.job where jobname = 'sf-sync-drain') then
    perform cron.unschedule('sf-sync-drain');
  end if;
end $$;

select cron.schedule(
  'sf-sync-drain',
  '* * * * *',  -- every minute
  $cron$
  select net.http_post(
    url := 'https://rqmtikbgkplxmmchyujo.supabase.co/functions/v1/sf-sync',
    headers := '{"Content-Type":"application/json"}'::jsonb,
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
  $cron$
);
