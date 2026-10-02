-- Run in the SQL editor of the LEADS Supabase project (the one behind
-- LEADS_SUPABASE_URL on the website and SUPABASE_URL in this repo).
-- Safe to re-run. Runs as one transaction, so a failure changes nothing.

begin;

-- 1. Allow the new email statuses used by sendapproved.js, emailgen.js and
--    the unsubscribe route: 'sending', 'opted_out' and 'failed'.
--    The original seven values are kept unchanged.
alter table public.leads drop constraint if exists leads_email_status_check;
alter table public.leads add constraint leads_email_status_check check (
  email_status = any (array[
    'pending', 'processing', 'verified', 'ready', 'approved',
    'sending', 'sent', 'bounced', 'opted_out', 'failed'
  ]::text[])
);

-- 2. Suppression list: checked by sendapproved.js before every send and
--    written by refactrix.com/unsubscribe. Emails are stored lower-cased.
create table if not exists public.suppressions (
  email      text primary key,
  reason     text not null default 'unsubscribed',
  created_at timestamptz not null default now()
);

-- RLS on with no policies: only secret / service-role keys can read or write.
-- sendapproved.js refuses to run with an anon or publishable key, because
-- under RLS that key would see an empty table and the check would pass.
alter table public.suppressions enable row level security;

-- 3. Retry caps for emailgen.js and analyzer.js (3 attempts, then 'failed').
alter table public.leads
  add column if not exists email_attempts int not null default 0,
  add column if not exists audit_attempts int not null default 0;

commit;
