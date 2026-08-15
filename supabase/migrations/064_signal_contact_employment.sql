-- 064: record whether a roster profile still works at the company.
--
-- LinkedIn's people search returns profiles whose index entry still points at
-- the company after the person has moved on (observed: a "Regional Operation
-- Manager" on a Delta Waste roster whose current position had been at another
-- waste company for five months). Their current position is in the same
-- payload, so the check is free — it keeps departed people out of both the
-- headcount and the outreach picks.

alter table public.signal_contacts
  add column if not exists employment_status text
    check (employment_status in ('current', 'departed', 'unknown')),
  add column if not exists current_employer text;

notify pgrst, 'reload schema';
