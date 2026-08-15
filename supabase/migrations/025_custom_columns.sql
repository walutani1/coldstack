-- 025: Per-table custom AI columns (Clay-style), additive and backward-compatible.
--
-- Adds three tables and a layout flag. NOTHING existing changes: the five
-- built-in personalization columns keep their values on public.leads, both
-- lists stay on layout_version 'v1' (the current hardcoded rendering + global
-- prompts + existing writeback RPC), and no read path is altered. The Decision
-- Makers columns/mappings are seeded but the table is NOT flipped to 'v2' here;
-- that flip ships with the v2 rendering code in a later migration.
--
--   enrichment_columns        - per-table column definitions (label, prompt,
--                               model, order, visibility, kind). Where "create
--                               an AI column" and "edit its prompt" live, and
--                               because it is per-table the prompts are per-table.
--   enrichment_cell_values    - per-lead x per-column AI values (the generic
--                               store that makes columns arbitrary instead of a
--                               fixed enum). Built-ins never write here.
--   enrichment_export_mappings- per-table column -> Smartlead field mapping and
--                               export-required flags (replaces the hardcoded
--                               all-five-built-ins export readiness).

create table if not exists public.enrichment_columns (
  id uuid primary key default gen_random_uuid(),
  table_id uuid not null references public.enrichment_tables(id) on delete cascade,
  key text not null check (char_length(key) between 1 and 60 and key ~ '^[a-z][a-z0-9_]*$'),
  label text not null check (char_length(label) between 1 and 80),
  -- builtin: rendered by an existing special cell, value read from public.leads
  --          or produced by a built-in action; never stored in cell_values.
  -- source:  read-only, derived from joined data (e.g. companies.company_summary).
  -- ai:      custom LLM column; value lives in enrichment_cell_values.
  kind text not null check (kind in ('builtin', 'source', 'ai')),
  prompt text check (prompt is null or char_length(prompt) <= 8000),
  model text check (model is null or char_length(model) <= 100),
  -- Which curated inputs the runner feeds the prompt (e.g. {title, linkedin_profile,
  -- company_summary}). Never the whole lead row.
  source_keys text[] not null default '{}',
  sort_order integer not null default 0,
  visible boolean not null default true,
  -- Bumping this marks every cell of the column outdated without touching values.
  generation_version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (table_id, key),
  -- Composite-unique target so export mappings can pin (table_id, column_id).
  unique (table_id, id)
);
create index if not exists enrichment_columns_table_idx on public.enrichment_columns (table_id, sort_order);

create table if not exists public.enrichment_cell_values (
  column_id uuid not null references public.enrichment_columns(id) on delete cascade,
  lead_id uuid not null references public.leads(id) on delete cascade,
  value text,
  -- Cell-local optimistic-concurrency token, bumped on every write. Unrelated
  -- email/export/other-column writes can never make this cell look stale.
  revision integer not null default 1,
  -- The column.generation_version at write time (for outdated detection).
  generation_version integer not null default 1,
  model text,
  provider text,
  updated_at timestamptz not null default now(),
  updated_by text,
  primary key (column_id, lead_id)
);
create index if not exists enrichment_cell_values_lead_idx on public.enrichment_cell_values (lead_id);

create table if not exists public.enrichment_export_mappings (
  id uuid primary key default gen_random_uuid(),
  table_id uuid not null references public.enrichment_tables(id) on delete cascade,
  column_id uuid not null,
  -- standard: a first-class Smartlead lead field (first_name, company, ...).
  -- custom_variable: a Smartlead custom field, keyed by target_key.
  target text not null check (target in ('standard', 'custom_variable')),
  target_key text not null check (char_length(target_key) between 1 and 120),
  required boolean not null default false,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (table_id, target, target_key),
  -- A mapping's column must belong to the mapping's table.
  foreign key (table_id, column_id) references public.enrichment_columns (table_id, id) on delete cascade
);
create index if not exists enrichment_export_mappings_column_idx on public.enrichment_export_mappings (column_id);

-- The app reads/writes these through the service role (getAdminClient). RLS is
-- enabled with no policies (nothing else can touch them); the service role
-- bypasses RLS but still needs ordinary table grants on newer Supabase.
alter table public.enrichment_columns enable row level security;
alter table public.enrichment_cell_values enable row level security;
alter table public.enrichment_export_mappings enable row level security;

revoke all on table public.enrichment_columns, public.enrichment_cell_values, public.enrichment_export_mappings from public, anon, authenticated;
grant select, insert, update, delete on table public.enrichment_columns, public.enrichment_cell_values, public.enrichment_export_mappings to service_role;

-- Every table starts on the current (hardcoded) rendering. Only tables flipped
-- to 'v2' use the dynamic column layout (flip ships with the v2 read/render code).
alter table public.enrichment_tables add column if not exists layout_version text not null default 'v1';

-- ── Seed the Decision Makers column layout + export mappings (data only; no
-- read path uses these until the table is flipped to v2 later). ──────────────
do $$
declare
  dm uuid;
begin
  select t.id into dm from public.enrichment_tables t
    join public.enrichment_workbooks w on w.id = t.workbook_id
    where w.slug = 'manufacturing-ops' and t.slug = 'decision-makers';
  if dm is null then
    raise notice 'decision-makers table not found; skipping seed';
    return;
  end if;

  -- Visible columns, in order. Anything omitted (qualification, final_title,
  -- operations_task, ops_candidate) simply does not render for this table.
  insert into public.enrichment_columns (table_id, key, label, kind, sort_order, source_keys) values
    (dm, 'contact',            'Contact',            'builtin',  0,  '{}'),
    (dm, 'company',            'Company',            'builtin', 10,  '{}'),
    (dm, 'company_summary',    'Company summary',    'source',  20,  '{company_summary}'),
    (dm, 'email',              'Email',              'builtin', 30,  '{}'),
    (dm, 'linkedin',           'LinkedIn: At company?', 'builtin', 40, '{}'),
    (dm, 'validate_email',     'ZeroBounce: Validate Email', 'builtin', 50, '{}'),
    (dm, 'email_status',       'Email status',       'builtin', 60,  '{}'),
    (dm, 'find_email',         'LeadMagic: Find Email', 'builtin', 70, '{}'),
    (dm, 'final_first_name',   'Final first_name',   'builtin', 80,  '{}'),
    (dm, 'final_company_name', 'Final company_name', 'builtin', 90,  '{}'),
    (dm, 'smartlead_export',   'Smartlead: Export',  'builtin', 200, '{}')
  on conflict (table_id, key) do nothing;

  insert into public.enrichment_columns (table_id, key, label, kind, model, sort_order, source_keys, prompt) values
    (dm, 'tenure', 'Tenure', 'ai', 'claude-sonnet-5', 100, '{linkedin_profile,title,company}',
     'Write the tenure phrase for the cold-email sentence "after {tenure} {role_responsibility}, ...". You are given how long the person has been at their current company. Never state an exact or decimal figure (not "2.4 years"). Say it the way a person would out loud, rounding to a clean estimate: "over two years", "almost three years", or "nearly four years". Spell small numbers as words. Return only the phrase, lowercase, with no trailing punctuation.'),
    (dm, 'role_responsibility', 'Role responsibility', 'ai', 'claude-sonnet-5', 110, '{title,linkedin_profile,company}',
     'Write a 2 to 4 word phrase for the cold-email sentence "after {tenure} {role_responsibility}, ...". It describes what the person leads or manages, based on their job title. If a current LinkedIn title is provided and differs from the given title, prefer the LinkedIn one. Use natural phrasing such as "leading operations", "managing operations", or "leading the operations team". Never include the company name. Return only the phrase, lowercase, with no trailing punctuation.'),
    (dm, 'ops_task_1', 'Ops task 1', 'ai', 'claude-sonnet-5', 120, '{company_summary,title,role_level}',
     'Suggest ONE specific operational process this company could automate or build a small internal tool or AI agent for, based on what they make and the markets they serve. Pick the single highest-impact manual process for their operation. Rules: concise (a short noun phrase, under about 12 words); a clear, useful outcome an ops team would actually want; and niche and specific to their business. Avoid anything a big off-the-shelf system (ERP, CRM, MES, accounting, or e-commerce platform) already handles. Return only the task, with no preamble.'),
    (dm, 'ops_task_2', 'Ops task 2', 'ai', 'claude-sonnet-5', 130, '{company_summary,title,role_level}',
     'Suggest ONE specific data-entry, tracking, or reporting bottleneck this company could automate with a small internal tool or AI agent, based on what they make and the markets they serve. It must be DIFFERENT from order intake or scheduling. Rules: concise short noun phrase (under about 12 words); clearly useful to an ops team; niche and specific to their business; and not something a big off-the-shelf system already solves. Return only the task, with no preamble.'),
    (dm, 'ops_task_3', 'Ops task 3', 'ai', 'claude-sonnet-5', 140, '{company_summary,title,role_level}',
     'Suggest ONE specific coordination, status-visibility, or communication bottleneck this company could fix with a small internal tool or AI agent, based on what they make and the markets they serve. It must be in a DIFFERENT category from an order-intake task and from a report or tracker. Rules: concise short noun phrase (under about 12 words); useful to a growing ops team; niche and specific; and not covered by big off-the-shelf software. Return only the task, with no preamble.')
  on conflict (table_id, key) do nothing;

  insert into public.enrichment_export_mappings (table_id, column_id, target, target_key, required)
  select dm, c.id, 'custom_variable', c.key, true
  from public.enrichment_columns c
  where c.table_id = dm and c.key in ('tenure', 'role_responsibility', 'ops_task_1', 'ops_task_2', 'ops_task_3')
  on conflict (table_id, target, target_key) do nothing;
end $$;

notify pgrst, 'reload schema';
