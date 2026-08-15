-- 035: Durable, server-side enrichment run jobs.
--
-- Client-invoked Server Functions are dispatched one at a time in this Next.js
-- (see docs 07-mutating-data.md), so real per-provider concurrency cannot live
-- in the browser. A "run" (bulk column fill or an autorun waterfall over many
-- leads) is therefore a durable job the SERVER advances in bounded chunks with
-- server-side concurrency, exactly like the reply/untracked pipelines the cron
-- already drains. Progress persists so a refresh, navigation, sleep, or deploy
-- never loses the run; the browser only creates the job and polls it.
--
--   enrichment_run_jobs       - one row per run. kind='column' fills a single
--                               column; kind='waterfall' cascades each lead
--                               through the autorun chain from a start column.
--   enrichment_run_job_items  - one row per lead in the job, with per-lead
--                               status so the worker can claim, retry, and
--                               resume deterministically across ticks.
--
-- Two RPCs keep the two overlapping drivers (self-chaining ticks + the 10-min
-- cron safety net) from double-processing: claim flips pending->running under
-- FOR UPDATE SKIP LOCKED, and complete records the terminal status and bumps
-- the job counters atomically.

create table if not exists public.enrichment_run_jobs (
  id uuid primary key default gen_random_uuid(),
  table_id uuid not null references public.enrichment_tables(id) on delete cascade,
  -- column: single-column bulk fill. waterfall: autorun cascade from start_column_key.
  kind text not null check (kind in ('column', 'waterfall')),
  -- The column the run starts at (the clicked column). For waterfall the chain
  -- continues to downstream columns; for column it is the only column touched.
  start_column_key text not null check (char_length(start_column_key) between 1 and 60),
  mode text not null check (mode in ('test10', 'unrun', 'outdated', 'force')),
  status text not null default 'pending' check (status in ('pending', 'running', 'done', 'canceled', 'failed')),
  total integer not null default 0,
  done integer not null default 0,
  failed integer not null default 0,
  -- Single logical run_id, reused for all writebacks and for ignoring late
  -- results after a cancel (the stale-guard token).
  run_id uuid not null default gen_random_uuid(),
  -- Per-provider concurrency captured at creation so a settings change mid-run
  -- does not retroactively change the ceiling this run promised.
  concurrency jsonb,
  error text,
  created_by text,
  -- Heartbeat: the worker stamps this each tick; the cron uses it to detect a
  -- run whose self-chaining ticks died and needs resuming.
  last_tick_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists enrichment_run_jobs_active_idx
  on public.enrichment_run_jobs (status, last_tick_at)
  where status in ('pending', 'running');
create index if not exists enrichment_run_jobs_table_idx
  on public.enrichment_run_jobs (table_id, created_at desc);

create table if not exists public.enrichment_run_job_items (
  job_id uuid not null references public.enrichment_run_jobs(id) on delete cascade,
  lead_id uuid not null references public.leads(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'running', 'done', 'failed')),
  attempts integer not null default 0,
  -- When the current attempt claimed the item; lets the worker reclaim rows
  -- stuck in 'running' after a dead tick.
  claimed_at timestamptz,
  error text,
  updated_at timestamptz not null default now(),
  primary key (job_id, lead_id)
);
create index if not exists enrichment_run_job_items_pending_idx
  on public.enrichment_run_job_items (job_id, status);

-- Claim up to p_limit runnable items for a job: pending, or running-but-stale
-- (a prior tick died). Flips them to running and stamps claimed_at, skipping
-- rows another tick is already holding. Returns the claimed lead ids.
create or replace function public.enrichment_run_claim_items(
  p_job_id uuid,
  p_limit integer,
  p_stale_seconds integer default 180
)
returns table (lead_id uuid)
language plpgsql
as $$
begin
  return query
  with candidates as (
    select i.lead_id
    from public.enrichment_run_job_items i
    where i.job_id = p_job_id
      and (
        i.status = 'pending'
        or (i.status = 'running' and i.claimed_at < now() - make_interval(secs => p_stale_seconds))
      )
    order by i.status desc, i.updated_at
    for update skip locked
    limit greatest(p_limit, 0)
  )
  update public.enrichment_run_job_items i
  set status = 'running',
      attempts = i.attempts + 1,
      claimed_at = now(),
      updated_at = now()
  from candidates c
  where i.job_id = p_job_id and i.lead_id = c.lead_id
  returning i.lead_id;
end;
$$;

-- Record an item's terminal status and advance the job counters atomically.
-- Returns the number of items still pending/running so the caller knows when
-- the job is drained.
create or replace function public.enrichment_run_complete_item(
  p_job_id uuid,
  p_lead_id uuid,
  p_status text,
  p_error text default null
)
returns integer
language plpgsql
as $$
declare
  v_prev text;
  v_remaining integer;
begin
  if p_status not in ('done', 'failed') then
    raise exception 'invalid terminal status %', p_status;
  end if;

  update public.enrichment_run_job_items i
  set status = p_status,
      error = left(p_error, 500),
      claimed_at = null,
      updated_at = now()
  where i.job_id = p_job_id and i.lead_id = p_lead_id
  returning i.status into v_prev;

  -- Idempotent: only count a transition into a terminal state once.
  update public.enrichment_run_jobs j
  set done = j.done + (case when p_status = 'done' then 1 else 0 end),
      failed = j.failed + (case when p_status = 'failed' then 1 else 0 end),
      last_tick_at = now(),
      updated_at = now()
  where j.id = p_job_id;

  select count(*) into v_remaining
  from public.enrichment_run_job_items i
  where i.job_id = p_job_id and i.status in ('pending', 'running');

  return v_remaining;
end;
$$;

-- service_role bypasses RLS but still needs table grants on newer Supabase.
alter table public.enrichment_run_jobs enable row level security;
alter table public.enrichment_run_job_items enable row level security;

revoke all on table public.enrichment_run_jobs, public.enrichment_run_job_items from public, anon, authenticated;
grant select, insert, update, delete on table public.enrichment_run_jobs, public.enrichment_run_job_items to service_role;

revoke execute on function public.enrichment_run_claim_items(uuid, integer, integer) from public, anon, authenticated;
revoke execute on function public.enrichment_run_complete_item(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.enrichment_run_claim_items(uuid, integer, integer) to service_role;
grant execute on function public.enrichment_run_complete_item(uuid, uuid, text, text) to service_role;

notify pgrst, 'reload schema';
