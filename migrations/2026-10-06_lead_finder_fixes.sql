-- Fixes after the first lead finder runs. Run in the SQL editor of the leads
-- Supabase project. Safe to re-run. Runs as one transaction.

begin;

-- 1. Every matching address found for a lead. leadfinder.js writes it and the
--    admin's add/remove email buttons save to it, but it was never created,
--    so both failed ("Could not find the 'emails' column").
alter table public.leads add column if not exists emails text[];

-- 2. Undo what the failed runs recorded. Their leads were never saved, but the
--    places were marked as checked ('error') and three areas as fully
--    searched, so they would have been skipped for months.
delete from public.lead_sources_seen where outcome = 'error';
update public.lead_targets
set exhausted_at = null, last_error = null
where exhausted_at is not null or last_error is not null;

commit;

-- Make the API see the new column straight away
notify pgrst, 'reload schema';
