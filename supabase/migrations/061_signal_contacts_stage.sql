-- 061: Contact sourcing for qualified signal companies.
--
-- When a company qualifies, the funnel pulls its LinkedIn employee roster
-- (harvestapi Apify actor), ranks contacts deterministically, auto-picks a
-- primary + backup (operator-editable), finds emails (Apollo -> LeadMagic),
-- and the operator pushes the picked-and-reachable contacts into the
-- Prospects tab (public.leads, role_level 'signal') with one click.

-- Roster rows. 059 reserved this table with a minimal shape; extend it.
alter table public.signal_contacts
  add column if not exists first_name text,
  add column if not exists last_name text,
  add column if not exists location text,
  add column if not exists about text,
  add column if not exists picture_url text,
  -- LinkedIn member hash id (the /in/ACwAA... form) — the dedupe key within
  -- a company; short-mode scrapes only return this, not the vanity slug.
  add column if not exists linkedin_member_id text,
  add column if not exists tenure_months integer,
  add column if not exists started_on text,
  -- Deterministic ranking (title buckets + tenure tiebreak). rank 1 = best.
  add column if not exists rank integer,
  add column if not exists rank_score integer,
  add column if not exists rank_reason text,
  -- Pick order: 1 = primary, 2 = backup, null = not in the lead list.
  -- status ('candidate'|'selected'|'excluded') stays the state field.
  add column if not exists pick_order integer,
  -- Whether the operator touched the pick (sticky vs re-sourcing).
  add column if not exists pick_by_operator boolean not null default false,
  add column if not exists email_status text
    check (email_status in ('pending', 'found', 'not_found', 'error')),
  add column if not exists email_source text,
  add column if not exists email_error text,
  add column if not exists email_checked_at timestamptz,
  -- Set when pushed into public.leads (idempotence + provenance).
  add column if not exists lead_id uuid,
  add column if not exists pushed_at timestamptz;

create unique index if not exists signal_contacts_member_idx
  on public.signal_contacts (company_id, linkedin_member_id)
  where linkedin_member_id is not null;
create index if not exists signal_contacts_pick_idx
  on public.signal_contacts (company_id, pick_order)
  where pick_order is not null;

-- Contact-sourcing lifecycle on the company. Poll-driven like research:
-- 'pending' -> start the Apify roster run ('sourcing', run id stored) ->
-- ingest + rank + email on completion ('sourced' | 'errored').
alter table public.signal_companies
  add column if not exists contacts_state text not null default 'none'
    check (contacts_state in ('none', 'pending', 'sourcing', 'sourced', 'errored')),
  add column if not exists contacts_run_id text,
  add column if not exists contacts_error text,
  add column if not exists contacts_sourced_at timestamptz,
  add column if not exists roster_count integer;

create index if not exists signal_companies_contacts_idx
  on public.signal_companies (contacts_state)
  where contacts_state in ('pending', 'sourcing');

notify pgrst, 'reload schema';
