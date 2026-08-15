-- 059: Signals v2 — the hiring funnel (see prd.md, locked 2026-07-27).
--
-- Companies move through a fixed pipeline (rollup -> agency screen -> research ->
-- deterministic filters -> title gate -> JD scoring -> score). Every stage writes a
-- signal_stage_results row (verdict + model rationale + config version) because kill
-- transparency is a locked requirement: the operator must always be able to see how a
-- verdict was reached. Configs are immutable versioned snapshots; stage results point
-- at the version that produced them so old audits stay explainable after tuning.

-- Funnel + review lifecycle on companies.
alter table public.signal_companies
  add column if not exists domain text,
  add column if not exists headcount integer,
  add column if not exists headcount_source text
    check (headcount_source in ('verified', 'llm_estimate')),
  add column if not exists headcount_confidence text
    check (headcount_confidence in ('high', 'low')),
  add column if not exists funnel_state text not null default 'pending'
    check (funnel_state in ('pending', 'processing', 'qualified', 'killed', 'errored')),
  add column if not exists killed_stage text,
  add column if not exists kill_reason text,
  add column if not exists funnel_error text,
  -- Only meaningful while funnel_state = 'qualified'.
  add column if not exists review_state text
    check (review_state in ('new', 'approved', 'archived')),
  add column if not exists archived_reason text,
  -- Operator override: sticky, never flipped by re-evaluation.
  add column if not exists override text check (override in ('qualified', 'killed')),
  add column if not exists override_note text,
  add column if not exists override_at timestamptz,
  add column if not exists score integer,
  add column if not exists score_breakdown jsonb,
  add column if not exists flags jsonb not null default '{}'::jsonb,
  add column if not exists evidence_count integer not null default 0,
  add column if not exists latest_evidence_at timestamptz,
  -- Claim marker for batch ticks (stale-reclaim like enrichment runs).
  add column if not exists claimed_at timestamptz,
  -- Config version this company was last evaluated against.
  add column if not exists evaluated_config_version integer;

-- One funnel run = scrape active searches + process companies. Poll-driven; a run
-- row survives closed tabs. Paused = spend cap hit (resumable).
create table if not exists public.signal_funnel_runs (
  id uuid primary key default gen_random_uuid(),
  status text not null default 'running'
    check (status in ('running', 'paused', 'succeeded', 'failed')),
  trigger text not null default 'manual'
    check (trigger in ('manual', 'reevaluate', 'new_evidence', 'cron')),
  config_version integer,
  -- Which saved searches this run scraped (empty for pure re-evaluations).
  search_ids uuid[] not null default '{}',
  stats jsonb not null default '{}'::jsonb,
  spend_estimate_usd numeric(10, 4) not null default 0,
  spend_cap_usd numeric(10, 4),
  error text,
  started_at timestamptz not null default now(),
  finished_at timestamptz
);

-- Per-stage audit trail. Append-only; latest row per (company, stage) is current.
create table if not exists public.signal_stage_results (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.signal_companies(id) on delete cascade,
  funnel_run_id uuid references public.signal_funnel_runs(id) on delete set null,
  stage text not null,
  verdict text not null check (verdict in ('pass', 'kill', 'flag', 'score', 'error', 'skip')),
  -- Parsed structured output (score, factor points, booleans, extracted facts).
  output jsonb,
  rationale text,
  raw_text text,
  error text,
  config_version integer,
  model text,
  input_tokens integer,
  output_tokens integer,
  latency_ms integer,
  created_at timestamptz not null default now()
);

-- Immutable config snapshots. The highest version is active. The config jsonb holds
-- the full funnel setup: stage knobs, prompts, per-stage models, score weights,
-- qualified threshold, studio context text.
create table if not exists public.signal_configs (
  version integer generated always as identity primary key,
  config jsonb not null,
  note text,
  created_by text,
  created_at timestamptz not null default now()
);

-- Reserved for the deferred contact-finding stage (tools TBD). exclusion_reason
-- exists now because "never contact the hiring manager" is a locked rule.
create table if not exists public.signal_contacts (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.signal_companies(id) on delete cascade,
  full_name text,
  title text,
  email text,
  linkedin_url text,
  status text not null default 'candidate'
    check (status in ('candidate', 'selected', 'excluded')),
  exclusion_reason text,
  provider text,
  provider_payload jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists signal_companies_funnel_idx
  on public.signal_companies (funnel_state, score desc nulls last);
create index if not exists signal_companies_review_idx
  on public.signal_companies (review_state) where funnel_state = 'qualified';
create index if not exists signal_companies_claim_idx
  on public.signal_companies (claimed_at) where funnel_state = 'processing';
create index if not exists signal_stage_results_company_idx
  on public.signal_stage_results (company_id, stage, created_at desc);
create index if not exists signal_stage_results_audit_idx
  on public.signal_stage_results (stage, verdict, created_at desc);
create index if not exists signal_funnel_runs_open_idx
  on public.signal_funnel_runs (status) where status in ('running', 'paused');
create index if not exists signal_contacts_company_idx
  on public.signal_contacts (company_id);

alter table public.signal_funnel_runs enable row level security;
alter table public.signal_stage_results enable row level security;
alter table public.signal_configs enable row level security;
alter table public.signal_contacts enable row level security;

notify pgrst, 'reload schema';
