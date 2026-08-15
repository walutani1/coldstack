-- 054: Track which step a run item is on, so the UI can show the spinner on the
-- cell that is ACTUALLY running.
--
-- A waterfall row walks left to right (title check -> LinkedIn -> ZeroBounce ->
-- personalization -> review -> export), but nothing recorded where a row was.
-- The client had to pin the spinner to the job's START column, so a bulk run
-- looked frozen on the first cell while the row was really off running LinkedIn
-- or personalization minutes later.
--
-- current_step holds the step KEY (a built-in column key like 'linkedin', or a
-- custom column key like 'tenure'), written as each step begins. It is display
-- state only: nothing branches on it, so a missed write just leaves the spinner
-- where it was until the next step lands.

alter table public.enrichment_run_job_items
  add column if not exists current_step text;

notify pgrst, 'reload schema';
