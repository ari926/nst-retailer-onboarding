-- 0004_invoice_samples.sql
-- Tracks every sample invoice delivery attempt from Step 6.
--
-- A retailer can request multiple samples (e.g. typo, then resend); each
-- attempt is one row. The Edge Function `send-sample-invoice` writes here
-- after Resend accepts or rejects the message.

create table if not exists invoice_samples (
  id              uuid primary key default gen_random_uuid(),
  sfdc_account_id text not null,
  storefront_name text not null,
  contact_name    text not null,
  contact_email   text not null,
  resend_id       text,                          -- Resend message id
  accepted        boolean not null default false,
  error_reason    text,                          -- e.g. mailbox_does_not_exist
  sent_at         timestamptz not null default now(),
  -- Echo of the rendered HTML body so ops can audit what the retailer saw.
  rendered_html_sha256 text
);

create index if not exists invoice_samples_sfdc_idx
  on invoice_samples(sfdc_account_id, sent_at desc);

alter table invoice_samples enable row level security;

-- Retailers can read their own attempts, but only the service role
-- (Edge Function) can insert. We never let the client write directly,
-- so we don't need an INSERT policy for authenticated users.
create policy invoice_samples_select_own on invoice_samples
  for select using (
    sfdc_account_id = (auth.jwt() ->> 'sfdc_account_id')
  );

-- View the latest attempt per account (used by the UI to show
-- "last sent N minutes ago").
create or replace view v_latest_invoice_sample as
select distinct on (sfdc_account_id)
  sfdc_account_id,
  contact_email,
  accepted,
  error_reason,
  sent_at,
  resend_id
from invoice_samples
order by sfdc_account_id, sent_at desc;
