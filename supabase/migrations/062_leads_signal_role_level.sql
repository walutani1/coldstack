-- 062: allow 'signal' as a lead role level.
--
-- Leads pushed from the Signals tab are owners/CEOs/ops leaders at qualified
-- hiring-signal companies — a different population from the manager/director
-- prospecting lists. Giving them their own role level keeps them out of the
-- existing Champions/Decision Makers tables (which filter on manager/director)
-- while letting the Signals table select them with the same canonical filter
-- machinery. The prior definition was:
--   CHECK (role_level = ANY (ARRAY['manager'::text, 'director'::text]))

alter table public.leads drop constraint if exists leads_role_level_check;
alter table public.leads
  add constraint leads_role_level_check
  check (role_level = any (array['manager'::text, 'director'::text, 'signal'::text]));

notify pgrst, 'reload schema';
