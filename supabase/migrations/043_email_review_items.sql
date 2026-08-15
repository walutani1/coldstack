-- 043: Human-review-before-export for enrichment (email review).
--
-- The email reviewer no longer silently rewrites cells. In manual mode it flags
-- a lead and records PROPOSED fixes (precomputed candidate values, not written),
-- and the lead sits blocked from export until a human resolves it in the review
-- queue: accept the fixes, decline but export anyway, or decline and hold.
--
--   enrichment_review_items     - one CURRENT review per (table, lead). Versioned
--                                 (is_current) so a re-run supersedes cleanly.
--                                 status is the canonical export gate; the QA cell
--                                 still shows Ready/Needs review for compatibility.
--   enrichment_review_proposals - per-cell suggestions, append-only (kind=initial
--                                 or chat). One may be 'selected' per column; an
--                                 atomic apply RPC (later migration) CAS-writes the
--                                 selected values against each cell's revision.

create table if not exists public.enrichment_review_items (
  id uuid primary key default gen_random_uuid(),
  table_id uuid not null references public.enrichment_tables(id) on delete cascade,
  lead_id uuid not null references public.leads(id) on delete cascade,
  qa_column_id uuid,
  campaign_id text,
  -- The email_review mode this item was created under (a later toggle to auto
  -- must not retroactively change already-pending items).
  mode_at_run text not null default 'manual' check (mode_at_run in ('manual', 'auto')),
  status text not null default 'pending'
    check (status in ('pending', 'accepted', 'declined_export', 'declined_hold', 'stale')),
  -- Exactly one live review per (table, lead); a re-run flips the old one false.
  is_current boolean not null default true,
  -- The reviewer's findings + an immutable snapshot of the emails/variables/context
  -- at flag time, plus the cell revisions then (for staleness + CAS).
  issues jsonb,
  snapshot jsonb,
  source_revisions jsonb,
  -- Staleness guards: if the campaign copy or the source cells changed since the
  -- flag, acceptance/override is disabled until refreshed.
  campaign_copy_hash text,
  -- Optimistic lock for the resolve RPC.
  lock_version integer not null default 0,
  created_by text,
  created_at timestamptz not null default now(),
  resolved_by text,
  resolved_at timestamptz,
  -- Idempotency: a retried resolve with the same key returns the prior result.
  resolution_key text
);
-- One current review per lead per table.
create unique index if not exists enrichment_review_items_current_uq
  on public.enrichment_review_items (table_id, lead_id)
  where is_current;
-- The default queue: current + pending, oldest first, per table.
create index if not exists enrichment_review_items_queue_idx
  on public.enrichment_review_items (table_id, created_at, id)
  where is_current and status = 'pending';
create unique index if not exists enrichment_review_items_resolution_key_uq
  on public.enrichment_review_items (resolution_key)
  where resolution_key is not null;

create table if not exists public.enrichment_review_proposals (
  id uuid primary key default gen_random_uuid(),
  review_item_id uuid not null references public.enrichment_review_items(id) on delete cascade,
  column_id uuid,
  -- Immutable copies so a proposal reads sensibly even if the column is renamed.
  column_key text not null,
  column_label text not null,
  kind text not null default 'initial' check (kind in ('initial', 'chat')),
  parent_id uuid,
  issue text,
  instruction text,
  original_value text,
  proposed_value text,
  -- CAS targets: apply the proposed value only if the cell still matches.
  expected_cell_revision integer,
  expected_generation_version integer,
  validation_status text not null default 'generating'
    check (validation_status in ('generating', 'valid', 'invalid', 'failed')),
  selected boolean not null default false,
  provider text,
  model text,
  input_tokens integer,
  output_tokens integer,
  -- Dedup a double-clicked chat request before it spends on the LLM.
  request_key text,
  created_by text,
  created_at timestamptz not null default now()
);
create index if not exists enrichment_review_proposals_item_idx
  on public.enrichment_review_proposals (review_item_id, created_at);
-- At most one selected proposal per column in a review item.
create unique index if not exists enrichment_review_proposals_selected_uq
  on public.enrichment_review_proposals (review_item_id, column_id)
  where selected;
create unique index if not exists enrichment_review_proposals_request_key_uq
  on public.enrichment_review_proposals (request_key)
  where request_key is not null;

-- service_role bypasses RLS but still needs table grants on newer Supabase.
alter table public.enrichment_review_items enable row level security;
alter table public.enrichment_review_proposals enable row level security;
revoke all on table public.enrichment_review_items, public.enrichment_review_proposals from public, anon, authenticated;
grant select, insert, update, delete on table public.enrichment_review_items, public.enrichment_review_proposals to service_role;

notify pgrst, 'reload schema';
