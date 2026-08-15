-- 046: allow the 'removed' export status, and repair the split-state rows.
--
-- The remove-from-campaign action writes enrichment_table_exports.status = 'removed',
-- but the original CHECK only permitted ('exported','failed'). The write therefore
-- violated the constraint and (because its error was unchecked in the action) failed
-- silently, leaving a stale 'exported' row that blocked re-export via the dedup gate.
-- Widen the constraint, then heal the rows already stuck in the split state.

do $$
declare
  cname text;
begin
  -- Drop whatever CHECK constraint currently governs status (name is deterministic
  -- for an inline column check, but resolve it defensively).
  select conname into cname
  from pg_constraint
  where conrelid = 'public.enrichment_table_exports'::regclass
    and contype = 'c'
    and pg_get_constraintdef(oid) ilike '%status%';
  if cname is not null then
    execute format('alter table public.enrichment_table_exports drop constraint %I', cname);
  end if;
end $$;

alter table public.enrichment_table_exports
  add constraint enrichment_table_exports_status_check check (status in ('exported', 'failed', 'removed'));

-- Heal the split state: a local export record still marked 'exported' even though a
-- remove ran for that exact lead+campaign (the remove succeeded in Smartlead but its
-- companion write here had been rejected). Matched per-campaign via the remove's own
-- lead_run so a removal from campaign B can never touch a live campaign-A export.
update public.enrichment_table_exports e
set status = 'removed'
where e.status = 'exported'
  and exists (
    select 1 from public.lead_runs r
    where r.lead_id = e.lead_id
      and r.action = 'smartlead_remove'
      and r.details->>'campaign_id' = e.campaign_id
  );

notify pgrst, 'reload schema';
