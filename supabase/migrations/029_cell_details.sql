-- Structured payload for a cell beyond its short text value. Used by the email
-- review (QA) column to store the verdict, the issues found, the three filled
-- emails, and every variable's value with its source context - so a click on the
-- cell can show a full per-lead inspection without recomputing or re-calling the
-- model. AI text columns keep using `value` alone; `details` is null for them.
alter table public.enrichment_cell_values
  add column if not exists details jsonb;
