-- RPCs used by the sf-sync Edge Function.

-- Claim up to `batch_size` runnable jobs atomically.
-- Returns full rows and marks them as `running` so parallel workers skip them.
create or replace function sf_sync_claim(batch_size int default 25)
returns setof sf_sync_queue
language plpgsql
security definer
as $$
begin
  return query
  update sf_sync_queue q
     set status = 'running',
         attempts = q.attempts,
         updated_at = now()
   where q.id in (
     select id
       from sf_sync_queue
      where status in ('pending', 'failed')
        and next_run_at <= now()
      order by next_run_at asc
      for update skip locked
      limit batch_size
   )
  returning q.*;
end;
$$;

revoke all on function sf_sync_claim(int) from public;
grant execute on function sf_sync_claim(int) to service_role;

-- Helper used by the UI to display sync status of the current retailer.
create or replace function sf_sync_status_summary(p_account_id text)
returns table (
  step_id smallint,
  sync_status text,
  sf_object_id text,
  last_error text,
  attempts smallint
)
language sql
security definer
as $$
  with latest as (
    select distinct on (q.step_id)
      q.step_id, q.status::text as sync_status,
      q.sf_object_id, q.last_error, q.attempts
    from sf_sync_queue q
    where q.sfdc_account_id = p_account_id
    order by q.step_id, q.created_at desc
  )
  select * from latest;
$$;

revoke all on function sf_sync_status_summary(text) from public;
grant execute on function sf_sync_status_summary(text) to authenticated, service_role;

-- Increment nudge counter. Caps at 6 per PRD (MAX_DEFERRED_NUDGES).
create or replace function increment_nudge(p_account_id text)
returns void
language plpgsql
security definer
as $$
begin
  insert into launch_status (sfdc_account_id, nudge_count, last_nudge_sent_at)
       values (p_account_id, 1, now())
  on conflict (sfdc_account_id) do update
     set nudge_count = least(launch_status.nudge_count + 1, 6),
         last_nudge_sent_at = now();
end;
$$;

revoke all on function increment_nudge(text) from public;
grant execute on function increment_nudge(text) to service_role;
