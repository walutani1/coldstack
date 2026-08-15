-- 036: Per-job auto-export preference for waterfall runs.
--
-- The client's Auto-export toggle decides whether a waterfall's final step
-- pushes deliverable, review-passed leads to Smartlead. Capture it on the job
-- so a toggle change mid-run does not retroactively arm or disarm export.
-- Ignored for kind='column' runs (no downstream cascade).

alter table public.enrichment_run_jobs
  add column if not exists include_export boolean not null default false;

notify pgrst, 'reload schema';
