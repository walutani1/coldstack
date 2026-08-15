-- 056: Don't let a one-second network blip permanently fail a lead.
--
-- A lead whose chain threw a transient infrastructure error (a Supabase
-- `fetch failed`/`terminated` ECONNRESET, or a CLI call that timed out) was
-- marked terminally `failed` by enrichment_run_complete_item, with no retry:
-- the claim function only re-picks `running` items past the stale window, never
-- `failed` ones. In one 1000-row run that turned ~87 recoverable blips into
-- permanent failures (74 died on their very first attempt).
--
-- This RPC is the retryable counterpart to complete_item. The engine calls it
-- only for transient errors: while the item still has retry budget it goes back
-- to `pending` (re-claimed on a later wave, error text kept for visibility, NOT
-- counted as a failure); once attempts reach the cap it becomes a real terminal
-- failure and increments the counter, exactly like complete_item. The cap check
-- lives here because `attempts` lives here, and attempts is already incremented
-- at claim time.

create or replace function public.enrichment_run_retry_or_fail(
  p_job_id uuid,
  p_lead_id uuid,
  p_error text,
  p_max_attempts integer default 5
)
returns integer
language plpgsql
as $$
declare
  v_attempts integer;
  v_active boolean := false;
  v_remaining integer;
begin
  -- Lock the active item and read how many times it has been claimed. A repeat
  -- completion of an already-terminal item matches nothing and changes nothing.
  select i.attempts into v_attempts
  from public.enrichment_run_job_items i
  where i.job_id = p_job_id
    and i.lead_id = p_lead_id
    and i.status in ('pending', 'running')
  for update;
  v_active := found;

  if v_active then
    if coalesce(v_attempts, 0) < p_max_attempts then
      -- Retry budget left: release back to pending. Keep the error text so the UI
      -- shows why it is retrying; do not touch the failed counter.
      update public.enrichment_run_job_items i
      set status = 'pending',
          error = left(p_error, 500),
          claimed_at = null,
          updated_at = now()
      where i.job_id = p_job_id and i.lead_id = p_lead_id;
    else
      -- Out of retries: terminal failure, counted like complete_item('failed').
      update public.enrichment_run_job_items i
      set status = 'failed',
          error = left(p_error, 500),
          claimed_at = null,
          updated_at = now()
      where i.job_id = p_job_id and i.lead_id = p_lead_id;
      update public.enrichment_run_jobs j
      set failed = j.failed + 1,
          last_tick_at = now(),
          updated_at = now()
      where j.id = p_job_id;
    end if;
  end if;

  select count(*) into v_remaining
  from public.enrichment_run_job_items i
  where i.job_id = p_job_id and i.status in ('pending', 'running');

  return v_remaining;
end;
$$;

revoke execute on function public.enrichment_run_retry_or_fail(uuid, uuid, text, integer) from public, anon, authenticated;
grant execute on function public.enrichment_run_retry_or_fail(uuid, uuid, text, integer) to service_role;

notify pgrst, 'reload schema';
