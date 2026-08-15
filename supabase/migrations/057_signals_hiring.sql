-- 057: Signals tab, first signal: hiring (LinkedIn job postings).
--
-- A saved search records the operator's scrape intent (job titles, location,
-- posting-window and other actor filters). Each "Run" starts one Apify actor
-- run (worldunboxer/rapid-linkedin-scraper); the run row carries the Apify run
-- id so ingestion survives the tab closing — any later poll can finish it.
-- Jobs dedupe globally on the LinkedIn job id: re-running a search refreshes
-- last_seen_at instead of duplicating rows. Companies dedupe on a normalized
-- name key and carry the Firecrawl+LLM research state (phase: company research
-- only; person-level enrichment is a later signal iteration).

create table if not exists public.signal_searches (
  id uuid primary key default gen_random_uuid(),
  signal_type text not null default 'hiring' check (signal_type in ('hiring')),
  name text not null,
  job_titles text[] not null default '{}',
  location text not null default 'United States',
  cities text[] not null default '{}',
  experience text,
  employment_type text,
  work_arrangement text,
  posted_within text,
  max_jobs integer not null default 100 check (max_jobs between 1 and 1000),
  archived boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_run_at timestamptz
);

create table if not exists public.signal_runs (
  id uuid primary key default gen_random_uuid(),
  search_id uuid not null references public.signal_searches(id) on delete cascade,
  apify_run_id text,
  apify_dataset_id text,
  status text not null default 'running'
    check (status in ('running', 'ingesting', 'succeeded', 'failed')),
  jobs_found integer,
  jobs_new integer,
  jobs_seen_again integer,
  error text,
  started_at timestamptz not null default now(),
  finished_at timestamptz
);

create table if not exists public.signal_companies (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  -- Lowercased, suffix-stripped comparison key ("Acme Corp." -> "acme").
  name_key text not null unique,
  linkedin_url text,
  logo_url text,
  industries text,
  website_url text,
  research_status text not null default 'none'
    check (research_status in ('none', 'running', 'done', 'failed')),
  research_brief text,
  research_sources jsonb,
  research_model text,
  research_error text,
  researched_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.signal_jobs (
  id uuid primary key default gen_random_uuid(),
  search_id uuid references public.signal_searches(id) on delete set null,
  run_id uuid references public.signal_runs(id) on delete set null,
  company_id uuid references public.signal_companies(id) on delete set null,
  linkedin_job_id text not null unique,
  job_url text not null,
  title text not null,
  company_name text not null,
  company_linkedin_url text,
  company_logo_url text,
  location text,
  -- Raw relative label from LinkedIn ("5 days ago") plus the absolute
  -- approximation computed at ingest; the label is what the operator saw.
  time_posted text,
  posted_at timestamptz,
  num_applicants text,
  salary_range text,
  seniority_level text,
  employment_type text,
  job_function text,
  industries text,
  easy_apply boolean,
  apply_url text,
  contact_email text,
  description text,
  search_keyword text,
  -- Operator triage: new -> shortlisted (use as outreach signal) | dismissed.
  status text not null default 'new' check (status in ('new', 'shortlisted', 'dismissed')),
  raw jsonb,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create index if not exists signal_runs_search_idx on public.signal_runs (search_id, started_at desc);
create index if not exists signal_runs_open_idx on public.signal_runs (status) where status in ('running', 'ingesting');
create index if not exists signal_jobs_status_idx on public.signal_jobs (status, first_seen_at desc);
create index if not exists signal_jobs_search_idx on public.signal_jobs (search_id);
create index if not exists signal_jobs_company_idx on public.signal_jobs (company_id);

-- Service-role access only (same posture as every other operational table):
-- RLS on with no policies, so PostgREST anon/authenticated see nothing.
alter table public.signal_searches enable row level security;
alter table public.signal_runs enable row level security;
alter table public.signal_companies enable row level security;
alter table public.signal_jobs enable row level security;

notify pgrst, 'reload schema';
