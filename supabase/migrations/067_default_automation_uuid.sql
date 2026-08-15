-- 067: give the default automation an RFC-4122-valid id.
--
-- 066 seeded '00000000-0000-0000-0000-0000000a0001'. Postgres's uuid type
-- accepts it, but it carries version 0 and variant 0, so zod's .uuid() (which
-- enforces the RFC's version/variant nibbles, special-casing only the all-zero
-- nil uuid) rejects it — every automation-scoped query failed validation with
-- "Invalid UUID" before reaching the database. Re-key to a v4-shaped id and
-- repoint the children; no other data changes.

do $$
declare
  old_id uuid := '00000000-0000-0000-0000-0000000a0001';
  new_id uuid := 'a0000000-0000-4000-8000-000000000001';
begin
  if not exists (select 1 from public.signal_automations where id = old_id) then
    return;
  end if;

  insert into public.signal_automations
    (id, name, status, criteria, smartlead_campaign_id, smartlead_campaign_name, prospect_table_id,
     schedule, autopush, contacts_per_company, release_gap_days, archived, last_run_at, created_at, updated_at)
  select new_id, name, status, criteria, smartlead_campaign_id, smartlead_campaign_name, prospect_table_id,
         schedule, autopush, contacts_per_company, release_gap_days, archived, last_run_at, created_at, now()
  from public.signal_automations
  where id = old_id
  on conflict (id) do nothing;

  update public.signal_searches    set automation_id = new_id where automation_id = old_id;
  update public.signal_companies   set automation_id = new_id where automation_id = old_id;
  update public.signal_jobs        set automation_id = new_id where automation_id = old_id;
  update public.signal_runs        set automation_id = new_id where automation_id = old_id;
  update public.signal_funnel_runs set automation_id = new_id where automation_id = old_id;
  update public.signal_lead_claims set automation_id = new_id where automation_id = old_id;

  delete from public.signal_automations where id = old_id;
end $$;

notify pgrst, 'reload schema';
