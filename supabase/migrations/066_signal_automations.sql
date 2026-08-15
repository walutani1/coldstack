-- 066: Automations — the unit of work for Signals.
--
-- An automation owns its job searches, its targeting criteria, its Smartlead
-- campaign and its prospect list. Because criteria are per-automation, the SAME
-- company can legitimately qualify for one automation and be killed by another,
-- so every row that carries a verdict becomes automation-scoped.
--
-- The expensive, automation-independent work (Firecrawl research, the LLM
-- headcount estimate, the Apify roster) is still paid for ONCE per real-world
-- company: signal_profile_claims is a lease keyed on a canonical company
-- identity, and a losing automation copies the fresh result instead of
-- re-buying it. signal_lead_claims enforces the operator's rule that a person
-- belongs to exactly one campaign across the whole workspace.

create table if not exists public.signal_automations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  status text not null default 'draft' check (status in ('draft', 'active', 'paused')),
  -- Per-automation targeting: industries, headcount range, threshold. Falls
  -- back to the global signal_configs defaults for anything absent.
  criteria jsonb not null default '{}'::jsonb,
  smartlead_campaign_id text,
  smartlead_campaign_name text,
  prospect_table_id uuid references public.enrichment_tables(id) on delete set null,
  -- { frequency: 'daily'|'manual', hourUtc: int }
  schedule jsonb not null default '{}'::jsonb,
  -- Off until the operator trusts the pipeline; then leads push themselves.
  autopush boolean not null default false,
  -- Contacts emailed per company, and the gap before the next one is released.
  contacts_per_company integer not null default 2 check (contacts_per_company between 1 and 3),
  release_gap_days integer not null default 7 check (release_gap_days between 1 and 60),
  archived boolean not null default false,
  last_run_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((smartlead_campaign_id is null) = (smartlead_campaign_name is null))
);

-- Adopt everything that exists today into one automation so nothing is orphaned
-- and no company id changes (signal_stage_results, signal_contacts, pushed lead
-- provenance and the operator's sticky decisions all key off those ids).
insert into public.signal_automations (id, name, status, criteria)
values ('00000000-0000-0000-0000-0000000a0001', 'Modernization hires — US', 'active', '{}'::jsonb)
on conflict (id) do nothing;

alter table public.signal_searches
  add column if not exists automation_id uuid references public.signal_automations(id) on delete cascade;
alter table public.signal_companies
  add column if not exists automation_id uuid references public.signal_automations(id) on delete cascade,
  -- Canonical cross-automation identity. LinkedIn slug > domain > name_key:
  -- name alone would let two unrelated "Acme Logistics" share a research brief.
  add column if not exists profile_key text,
  add column if not exists researched_at_copy timestamptz,
  add column if not exists profile_copied_from uuid references public.signal_companies(id) on delete set null;
alter table public.signal_jobs
  add column if not exists automation_id uuid references public.signal_automations(id) on delete cascade;
alter table public.signal_runs
  add column if not exists automation_id uuid references public.signal_automations(id) on delete set null;
alter table public.signal_funnel_runs
  add column if not exists automation_id uuid references public.signal_automations(id) on delete cascade,
  -- The criteria this run actually used, so an audit stays truthful after the
  -- automation is edited.
  add column if not exists effective_criteria jsonb;

update public.signal_searches set automation_id = '00000000-0000-0000-0000-0000000a0001' where automation_id is null;
update public.signal_companies set automation_id = '00000000-0000-0000-0000-0000000a0001' where automation_id is null;
update public.signal_jobs set automation_id = '00000000-0000-0000-0000-0000000a0001' where automation_id is null;
update public.signal_funnel_runs set automation_id = '00000000-0000-0000-0000-0000000a0001' where automation_id is null;
update public.signal_runs r
  set automation_id = s.automation_id
  from public.signal_searches s
  where r.search_id = s.id and r.automation_id is null;

-- Backfill the canonical key from the strongest identifier each row has.
update public.signal_companies
set profile_key = coalesce(
  nullif(lower(substring(linkedin_url from 'linkedin\.com/company/([^/?#]+)')), ''),
  nullif(lower(regexp_replace(coalesce(domain, website_url, ''), '^https?://(www\.)?|/.*$', '', 'g')), ''),
  'name:' || name_key
)
where profile_key is null;

alter table public.signal_searches alter column automation_id set not null;
alter table public.signal_companies alter column automation_id set not null;
alter table public.signal_jobs alter column automation_id set not null;

-- Dedupe becomes per-automation. Without this, automation B's scrape would find
-- automation A's company row and write B's verdict over A's.
alter table public.signal_companies drop constraint if exists signal_companies_name_key_key;
create unique index if not exists signal_companies_automation_name_idx
  on public.signal_companies (automation_id, name_key);
create index if not exists signal_companies_profile_key_idx
  on public.signal_companies (profile_key);

-- Same for evidence: a globally-unique job id made automation B treat A's
-- posting as "already seen", so B ingested no evidence and never evaluated
-- the company at all.
drop index if exists public.signal_jobs_source_external_idx;
create unique index if not exists signal_jobs_automation_source_external_idx
  on public.signal_jobs (automation_id, source, external_job_id);

-- One open run per automation (was one globally, which blocked concurrency).
drop index if exists public.signal_funnel_runs_open_idx;
create unique index if not exists signal_funnel_runs_one_open_per_automation
  on public.signal_funnel_runs (automation_id) where status in ('running', 'paused');

/* ── Guardrail 1: never buy the same company's facts twice ──────────────
   A lease keyed on canonical identity. The winner pays for research/roster;
   everyone else waits for it and copies. lease_until makes a crashed worker
   recoverable without a human. */
create table if not exists public.signal_profile_claims (
  profile_key text primary key,
  research_status text not null default 'none' check (research_status in ('none', 'running', 'done', 'failed')),
  research_company_id uuid references public.signal_companies(id) on delete set null,
  research_fetched_at timestamptz,
  roster_status text not null default 'none' check (roster_status in ('none', 'running', 'done', 'failed')),
  roster_company_id uuid references public.signal_companies(id) on delete set null,
  roster_fetched_at timestamptz,
  lease_until timestamptz,
  updated_at timestamptz not null default now()
);

/* ── Guardrail 2: one person, one campaign ─────────────────────────────
   Identity is the email or the LinkedIn member id, not the duplicated contact
   row — otherwise two automations can each push the same human into their own
   campaign and both believe they own them. */
create table if not exists public.signal_lead_claims (
  identity_key text primary key,
  automation_id uuid not null references public.signal_automations(id) on delete cascade,
  contact_id uuid references public.signal_contacts(id) on delete set null,
  smartlead_campaign_id text,
  smartlead_campaign_name text,
  lead_id uuid,
  claimed_at timestamptz not null default now()
);

-- Release cadence: contact 2 goes out only after contact 1 has actually been
-- emailed for release_gap_days with no reply from anyone at the company.
alter table public.signal_contacts
  add column if not exists released_at timestamptz,
  add column if not exists release_blocked_reason text;

create index if not exists signal_automations_active_idx on public.signal_automations (status) where archived = false;
create index if not exists signal_searches_automation_idx on public.signal_searches (automation_id);
create index if not exists signal_companies_automation_state_idx on public.signal_companies (automation_id, funnel_state);

alter table public.signal_automations enable row level security;
alter table public.signal_profile_claims enable row level security;
alter table public.signal_lead_claims enable row level security;

notify pgrst, 'reload schema';
