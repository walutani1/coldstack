-- 038: Single-writer tick lease + atomic materialization for run jobs.
--
-- Codex review (critical): nothing stopped two ticks (two self-chains, or a
-- self-chain plus the cron safety net) from processing the same job at once.
-- Each builds its own semaphores, so llm=3 becomes 6 concurrent calls and, past
-- the reclaim window, both can run the same lead - doubling paid LinkedIn / LLM
-- work. A CAS tick lease makes exactly one tick own a job at a time.
--
-- Also adds a non-runnable 'materializing' status so job creation is effectively
-- atomic: the job is invisible to workers/cron until all item chunks are inserted
-- and it flips to 'pending'. A creation that dies mid-insert leaves a
-- 'materializing' job that nothing will run (and can be swept later).

alter table public.enrichment_run_jobs
  add column if not exists tick_owner uuid,
  add column if not exists tick_expires_at timestamptz;

-- Allow the new 'materializing' status.
alter table public.enrichment_run_jobs drop constraint if exists enrichment_run_jobs_status_check;
alter table public.enrichment_run_jobs
  add constraint enrichment_run_jobs_status_check
  check (status in ('materializing', 'pending', 'running', 'done', 'canceled', 'failed'));

-- Try to take (or renew) the tick lease for a job. Succeeds only when the job is
-- runnable and either unleased, self-owned, or the prior lease expired. Returns
-- true iff this owner now holds the lease.
create or replace function public.enrichment_run_acquire_tick(
  p_job_id uuid,
  p_owner uuid,
  p_ttl_seconds integer default 300
)
returns boolean
language plpgsql
as $$
declare
  v_updated integer;
begin
  update public.enrichment_run_jobs j
  set tick_owner = p_owner,
      tick_expires_at = now() + make_interval(secs => p_ttl_seconds),
      updated_at = now()
  where j.id = p_job_id
    and j.status in ('pending', 'running')
    and (j.tick_owner is null or j.tick_owner = p_owner or j.tick_expires_at < now());
  get diagnostics v_updated = row_count;
  return v_updated > 0;
end;
$$;

-- Renew the lease mid-tick (called from the heartbeat) only if still owned.
create or replace function public.enrichment_run_renew_tick(
  p_job_id uuid,
  p_owner uuid,
  p_ttl_seconds integer default 300
)
returns boolean
language plpgsql
as $$
declare
  v_updated integer;
begin
  update public.enrichment_run_jobs j
  set tick_expires_at = now() + make_interval(secs => p_ttl_seconds),
      last_tick_at = now(),
      updated_at = now()
  where j.id = p_job_id and j.tick_owner = p_owner
    and j.status in ('pending', 'running');
  get diagnostics v_updated = row_count;
  return v_updated > 0;
end;
$$;

-- Release the lease at tick end (only if still owned).
create or replace function public.enrichment_run_release_tick(
  p_job_id uuid,
  p_owner uuid
)
returns void
language sql
as $$
  update public.enrichment_run_jobs j
  set tick_owner = null, tick_expires_at = null, updated_at = now()
  where j.id = p_job_id and j.tick_owner = p_owner;
$$;

revoke execute on function public.enrichment_run_acquire_tick(uuid, uuid, integer) from public, anon, authenticated;
revoke execute on function public.enrichment_run_renew_tick(uuid, uuid, integer) from public, anon, authenticated;
revoke execute on function public.enrichment_run_release_tick(uuid, uuid) from public, anon, authenticated;
grant execute on function public.enrichment_run_acquire_tick(uuid, uuid, integer) to service_role;
grant execute on function public.enrichment_run_renew_tick(uuid, uuid, integer) to service_role;
grant execute on function public.enrichment_run_release_tick(uuid, uuid) to service_role;

notify pgrst, 'reload schema';
