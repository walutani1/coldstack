-- 037: Make enrichment_run_complete_item idempotent.
--
-- The item's stale-reclaim window (a tick that dies mid-lead) means a lead can be
-- claimed and completed more than once. The counter increment must therefore
-- only count the FIRST transition into a terminal state; a repeat completion
-- updates nothing and leaves done/failed correct. Without this, a reclaimed item
-- could push done+failed past total.

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
  v_transitioned boolean := false;
  v_remaining integer;
begin
  if p_status not in ('done', 'failed') then
    raise exception 'invalid terminal status %', p_status;
  end if;

  -- Only a still-active item (pending/running) transitions; a repeat completion
  -- of an already-terminal item matches no row and increments nothing.
  update public.enrichment_run_job_items i
  set status = p_status,
      error = left(p_error, 500),
      claimed_at = null,
      updated_at = now()
  where i.job_id = p_job_id
    and i.lead_id = p_lead_id
    and i.status in ('pending', 'running');
  v_transitioned := found;

  if v_transitioned then
    update public.enrichment_run_jobs j
    set done = j.done + (case when p_status = 'done' then 1 else 0 end),
        failed = j.failed + (case when p_status = 'failed' then 1 else 0 end),
        last_tick_at = now(),
        updated_at = now()
    where j.id = p_job_id;
  end if;

  select count(*) into v_remaining
  from public.enrichment_run_job_items i
  where i.job_id = p_job_id and i.status in ('pending', 'running');

  return v_remaining;
end;
$$;

revoke execute on function public.enrichment_run_complete_item(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.enrichment_run_complete_item(uuid, uuid, text, text) to service_role;

notify pgrst, 'reload schema';
