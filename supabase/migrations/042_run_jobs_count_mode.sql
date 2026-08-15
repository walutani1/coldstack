-- 042: Allow the 'count' run mode (run a specific number of rows from a start row).
--
-- Like 'force' at execution (runs each selected row regardless of existing
-- value, still skipping hard-halted leads), but candidate selection takes a
-- positional slice of the current filtered/sorted view - N rows starting at a
-- given row - so runs can be done in measured batches. count/offset are
-- transient (used only when materializing candidates), so no new columns.

alter table public.enrichment_run_jobs
  drop constraint if exists enrichment_run_jobs_mode_check;

alter table public.enrichment_run_jobs
  add constraint enrichment_run_jobs_mode_check
  check (mode in ('test10', 'unrun', 'outdated', 'force', 'count'));

notify pgrst, 'reload schema';
