-- 063: ground the headcount estimate in observed LinkedIn data.
--
-- The employee-roster scrape we already pay for (harvestapi, one pull per
-- company) reports how many profiles list the company as their current
-- employer. That is an exact observation, but NOT a census: in the
-- operations-heavy industries we target, drivers and plant staff frequently
-- have no LinkedIn profile, so the number is a floor. Storing it separately
-- from `headcount` keeps that distinction honest — the size stage uses it to
-- anchor its estimate instead of guessing blind, and `headcount_anchor`
-- records which observation the current estimate was built on so the estimate
-- is redone exactly once when a fresh roster arrives.

alter table public.signal_companies
  -- Employees whose CURRENT position was verified against this company.
  add column if not exists linkedin_employee_count integer,
  -- Roster profiles returned before the current-employer check.
  add column if not exists linkedin_profile_count integer,
  add column if not exists headcount_anchor integer;

comment on column public.signal_companies.linkedin_employee_count is
  'Verified-current employees seen on LinkedIn. A floor on true headcount, never a census.';

notify pgrst, 'reload schema';
