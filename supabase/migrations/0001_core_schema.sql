-- Core onboarding schema.
--
-- Matches the domain model in src/types/onboarding.ts. Kept minimal for V1 —
-- payloads are JSONB so we can evolve step shape without migrations. When we
-- stabilize the shape in V2 we will extract typed columns.
--
-- Row-Level Security: every table is keyed on sfdc_account_id. Retailer-facing
-- policies restrict SELECT/INSERT/UPDATE to rows matching the JWT's
-- `sfdc_account_id` custom claim. Ops / service-role bypasses RLS.

create extension if not exists "pgcrypto";

-- ============================================================================
-- step_drafts — autosaved step state per retailer+step. Upserted every ~1.5s.
-- ============================================================================
create table if not exists step_drafts (
  id uuid primary key default gen_random_uuid(),
  sfdc_account_id text not null,
  step_id smallint not null check (step_id between 0 and 7),
  payload jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  unique (sfdc_account_id, step_id)
);

create index if not exists step_drafts_account_idx
  on step_drafts (sfdc_account_id);

alter table step_drafts enable row level security;

create policy "retailers_read_own_drafts" on step_drafts
  for select using (
    sfdc_account_id = coalesce(
      auth.jwt() ->> 'sfdc_account_id',
      (auth.jwt() -> 'user_metadata' ->> 'sfdc_account_id')
    )
  );

create policy "retailers_write_own_drafts" on step_drafts
  for insert with check (
    sfdc_account_id = coalesce(
      auth.jwt() ->> 'sfdc_account_id',
      (auth.jwt() -> 'user_metadata' ->> 'sfdc_account_id')
    )
  );

create policy "retailers_update_own_drafts" on step_drafts
  for update using (
    sfdc_account_id = coalesce(
      auth.jwt() ->> 'sfdc_account_id',
      (auth.jwt() -> 'user_metadata' ->> 'sfdc_account_id')
    )
  );

-- ============================================================================
-- step_submissions — finalized step payloads. Immutable once inserted.
-- ============================================================================
create table if not exists step_submissions (
  id uuid primary key default gen_random_uuid(),
  sfdc_account_id text not null,
  step_id smallint not null check (step_id between 0 and 7),
  payload jsonb not null,
  submitted_at timestamptz not null default now(),
  -- Populated by sf-sync Edge Function once the SFDC round-trip succeeds.
  sf_object_id text,
  sf_synced_at timestamptz
);

create index if not exists step_submissions_account_idx
  on step_submissions (sfdc_account_id, step_id);
create index if not exists step_submissions_unsynced_idx
  on step_submissions (sf_synced_at)
  where sf_synced_at is null;

alter table step_submissions enable row level security;

create policy "retailers_read_own_submissions" on step_submissions
  for select using (
    sfdc_account_id = coalesce(
      auth.jwt() ->> 'sfdc_account_id',
      (auth.jwt() -> 'user_metadata' ->> 'sfdc_account_id')
    )
  );

create policy "retailers_insert_own_submissions" on step_submissions
  for insert with check (
    sfdc_account_id = coalesce(
      auth.jwt() ->> 'sfdc_account_id',
      (auth.jwt() -> 'user_metadata' ->> 'sfdc_account_id')
    )
  );

-- ============================================================================
-- audit_log — append-only log of every meaningful action.
-- ============================================================================
create table if not exists audit_log (
  id uuid primary key default gen_random_uuid(),
  sfdc_account_id text,
  actor_type text not null check (
    actor_type in ('retailer', 'ops', 'system', 'sfdc')
  ),
  action text not null,
  metadata jsonb default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists audit_log_account_idx
  on audit_log (sfdc_account_id, created_at desc);

alter table audit_log enable row level security;

-- Audit log is append-only. Retailers can read their own, only service role writes.
create policy "retailers_read_own_audit" on audit_log
  for select using (
    sfdc_account_id = coalesce(
      auth.jwt() ->> 'sfdc_account_id',
      (auth.jwt() -> 'user_metadata' ->> 'sfdc_account_id')
    )
  );
