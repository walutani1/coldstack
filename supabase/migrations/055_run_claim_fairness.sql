-- 055: Stop a run from re-grinding the same slow leads instead of advancing.
--
-- Two bugs in the item claim made a 1000-row CLI run crawl: 72 rows in 4.4h,
-- with individual leads showing attempts=22..27.
--
-- 1. The reclaim window (180s) was SHORTER than a lead takes. On the CLI runner
--    with llm concurrency 1 a full waterfall (title -> LinkedIn -> ZeroBounce ->
--    5 personalization columns -> review -> export) runs ~222s, and the tick
--    budget itself is 230s. So a lead that was legitimately mid-flight already
--    counted as abandoned and got re-claimed and restarted. 600s clears the
--    observed duration and the tick budget with room to spare, while still
--    releasing genuinely abandoned rows promptly after a crashed tick.
--
-- 2. `order by i.status desc` put 'running' before 'pending' (r > p), so those
--    prematurely-stale rows were re-claimed IN PREFERENCE TO untouched work.
--    The run kept redoing the same leads while hundreds sat pending. Ordering
--    ascending puts 'pending' first, so a run always advances through new leads
--    and only revisits a stalled row once there is nothing fresh to do.
--
-- Signature is unchanged, so this is a safe hot swap under a running job.

create or replace function public.enrichment_run_claim_items(
  p_job_id uuid,
  p_limit integer,
  p_stale_seconds integer default 600
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
    -- 'pending' sorts before 'running': fresh work first, retries last.
    order by i.status asc, i.updated_at
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

revoke execute on function public.enrichment_run_claim_items(uuid, integer, integer) from public, anon, authenticated;
grant execute on function public.enrichment_run_claim_items(uuid, integer, integer) to service_role;

notify pgrst, 'reload schema';
