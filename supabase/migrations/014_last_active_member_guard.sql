-- Database-level guard: the last active inbox member can never be
-- deactivated, even by concurrent requests. The app performs the same check
-- for a friendly message, but that check is read-then-write and racy; this
-- trigger is the source of truth. The FOR UPDATE lock serializes concurrent
-- deactivations (Postgres re-evaluates is_active on the locked row, so a row
-- deactivated by a just-committed transaction no longer counts; a symmetric
-- race degrades to a deadlock error on one side, never to zero active rows).
create or replace function inbox_profiles_guard_last_active() returns trigger
language plpgsql as $$
begin
  if old.is_active and not new.is_active then
    if not exists (
      select 1 from inbox_profiles
      where is_active and id <> old.id
      for update
    ) then
      raise exception 'The last active team member cannot be deactivated.';
    end if;
  end if;
  return new;
end $$;

drop trigger if exists inbox_profiles_last_active on inbox_profiles;
create trigger inbox_profiles_last_active
  before update of is_active on inbox_profiles
  for each row execute function inbox_profiles_guard_last_active();
