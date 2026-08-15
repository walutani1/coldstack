-- 060: Signals — second job-board source: Indeed (borderline/indeed-scraper).
--
-- Searches gain a source; jobs dedupe per source (the old linkedin_job_id
-- becomes external_job_id: LinkedIn numeric id or Indeed jobKey). Indeed's
-- company profiles carry a company-reported employee-count range, which
-- becomes a third headcount source ('indeed_profile'): better than an LLM
-- estimate, but still not 'verified' — hard size-kills stay verified-only.

alter table public.signal_searches
  add column if not exists source text not null default 'linkedin'
    check (source in ('linkedin', 'indeed'));

alter table public.signal_jobs
  rename column linkedin_job_id to external_job_id;
alter table public.signal_jobs
  add column if not exists source text not null default 'linkedin'
    check (source in ('linkedin', 'indeed'));
alter table public.signal_jobs
  drop constraint if exists signal_jobs_linkedin_job_id_key;
create unique index if not exists signal_jobs_source_external_idx
  on public.signal_jobs (source, external_job_id);

alter table public.signal_companies
  add column if not exists indeed_url text;
alter table public.signal_companies
  drop constraint if exists signal_companies_headcount_source_check;
alter table public.signal_companies
  add constraint signal_companies_headcount_source_check
    check (headcount_source in ('verified', 'indeed_profile', 'llm_estimate'));

notify pgrst, 'reload schema';
