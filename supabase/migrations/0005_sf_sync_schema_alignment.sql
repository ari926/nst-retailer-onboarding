-- 0005_sf_sync_schema_alignment.sql
--
-- Aligns the in-DB schema with what the deployed sf-sync edge function
-- expects. The earlier 0002 / 0003 migrations were authored against a
-- planned schema (step_submissions(sfdc_account_id, step_id, payload))
-- that didn't match what was actually deployed in production
-- (step_submissions(onboarding_id, step_number, submitted_data) with
-- sfdc_account_id on retailer_onboardings).
--
-- This migration:
--   1. Rewrites the enqueue_sf_sync trigger to look up sfdc_account_id
--      via a JOIN through retailer_onboardings.
--   2. Adds sf_object_id + sf_synced_at columns to step_submissions
--      so the edge function can write SF object IDs back for idempotent
--      retries on child-record steps (Safe_Setup__c, Contact).
--
-- Already applied to the production DB on 2026-04-26 via the connector
-- migrations `fix_sf_sync_trigger_for_real_schema` and
-- `add_sf_object_id_to_step_submissions`.

-- 1) Trigger rewrite
create or replace function enqueue_sf_sync()
returns trigger
language plpgsql
as $$
declare
  v_sfdc_account_id text;
begin
  select sfdc_account_id into v_sfdc_account_id
    from retailer_onboardings
   where id = new.onboarding_id;

  -- No SF account linked yet (e.g. claim-flow row before SF push) — skip
  -- enqueue so we never push orphan rows to SF.
  if v_sfdc_account_id is null then
    return new;
  end if;

  insert into sf_sync_queue (
    submission_id, sfdc_account_id, step_id, payload
  )
  values (
    new.id, v_sfdc_account_id, new.step_number, new.submitted_data
  );
  return new;
end;
$$;

drop trigger if exists step_submissions_enqueue_sf on step_submissions;
create trigger step_submissions_enqueue_sf
  after insert on step_submissions
  for each row execute function enqueue_sf_sync();

-- 2) Columns the sf-sync edge function writes back to.
alter table step_submissions add column if not exists sf_object_id text;
alter table step_submissions add column if not exists sf_synced_at timestamptz;
