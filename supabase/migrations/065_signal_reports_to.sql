-- 065: remember who the posted role reports to.
--
-- When a job description states the reporting line ("reports directly to the
-- COO"), that person is the outreach target — better than any title-ranking
-- heuristic, because the posting itself named them. The JD-scoring stage
-- already reads the descriptions, so extracting it costs nothing extra.
-- Measured on real postings: only ~8% state it, so title ranking stays the
-- main path and this is an override when present.

alter table public.signal_companies
  add column if not exists reports_to_title text;

comment on column public.signal_companies.reports_to_title is
  'Title the posted role reports to, verbatim from the JD. Null unless explicitly stated.';

alter table public.signal_contacts
  -- Set when this contact was chosen because the JD named their title.
  add column if not exists matched_reports_to boolean not null default false;

notify pgrst, 'reload schema';
