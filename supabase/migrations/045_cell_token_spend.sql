-- 045: Per-cell token + duration accounting for enrichment spend.
--
-- Records how many tokens an AI cell burned and how long it took to generate, so
-- the worktable can show per-cell cost and an aggregate total split by route
-- (API vs local CLI). Purely additive: the columns are nullable (legacy cells and
-- non-metered writes stay null), and the RPC only sums metered cells.

alter table public.enrichment_cell_values
  add column if not exists input_tokens integer,
  add column if not exists output_tokens integer,
  add column if not exists duration_ms integer;

-- Aggregate spend for a table's cells, grouped by the runner provider and the
-- column that produced the value. The app classifies provider into API vs CLI and
-- resolves column labels. Only cells that recorded usage/timing are counted.
-- The (column_id, lead_id) primary key makes the column_id IN (...) scan cheap.
create or replace function public.enrichment_table_spend(p_table_id uuid)
returns table(
  provider text,
  column_id uuid,
  cells bigint,
  input_tokens bigint,
  output_tokens bigint,
  duration_ms bigint
)
language sql
stable
set search_path to ''
as $$
  select
    coalesce(cv.provider, 'unknown') as provider,
    cv.column_id,
    count(*)::bigint as cells,
    coalesce(sum(cv.input_tokens), 0)::bigint as input_tokens,
    coalesce(sum(cv.output_tokens), 0)::bigint as output_tokens,
    coalesce(sum(cv.duration_ms), 0)::bigint as duration_ms
  from public.enrichment_cell_values cv
  where cv.column_id in (select c.id from public.enrichment_columns c where c.table_id = p_table_id)
    and (cv.input_tokens is not null or cv.output_tokens is not null or cv.duration_ms is not null)
  group by cv.provider, cv.column_id;
$$;

revoke execute on function public.enrichment_table_spend(uuid) from public, anon, authenticated;
grant execute on function public.enrichment_table_spend(uuid) to service_role;

notify pgrst, 'reload schema';
