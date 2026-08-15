-- 051: LinkedIn profile-link column on the Decision Makers table.
--
-- A source-kind column (no run step, no LLM, no export mapping) that renders
-- the lead's linkedin_url as a clickable link opening in a new tab. Placed
-- just before the "LinkedIn: At company?" verify column. Idempotent: inserts
-- only when the table does not already have a linkedin_url column.

insert into public.enrichment_columns (table_id, key, label, kind, sort_order, visible)
select '38a8048e-0389-414b-a9e6-2a4747189e4d', 'linkedin_url', 'LinkedIn', 'source', 59, true
where not exists (
  select 1 from public.enrichment_columns
  where table_id = '38a8048e-0389-414b-a9e6-2a4747189e4d' and key = 'linkedin_url'
);

notify pgrst, 'reload schema';
