-- 048: hard-code role_responsibility to a fixed value.
--
-- The Manufacturing Ops Decision Makers list is uniformly operations (the title-fit
-- gate guarantees it), and the AI normalization returned "leading operations" for
-- the vast majority anyway while spending a token-heavy call (it feeds the full
-- LinkedIn profile in). Pin the column to a constant: a column with constant_value
-- set is written directly by the runner with no LLM call, so it drops out of the
-- token/time cost and the contamination risk while still populating for export.
-- Reverting is just clearing constant_value.

alter table public.enrichment_columns add column if not exists constant_value text;

update public.enrichment_columns
set constant_value = 'leading operations', updated_at = now()
where key = 'role_responsibility';

-- Bring existing cells in line so the table and Smartlead read the constant (this
-- also overwrites any earlier AI value, including a leaked location like the
-- "leading operations at cloverdale" case).
update public.enrichment_cell_values c
set value = 'leading operations',
    provider = 'constant',
    input_tokens = null,
    output_tokens = null,
    duration_ms = null,
    revision = c.revision + 1,
    generation_version = col.generation_version,
    updated_at = now()
from public.enrichment_columns col
where c.column_id = col.id
  and col.key = 'role_responsibility'
  -- Normalize value AND spend metadata: a cell already reading "leading operations"
  -- from the old AI path still carries its provider/tokens/duration and would keep
  -- counting as LLM spend, so clear those too. Idempotent: no rows match once done.
  and (
    c.value is distinct from 'leading operations'
    or c.provider is distinct from 'constant'
    or c.input_tokens is not null
    or c.output_tokens is not null
    or c.duration_ms is not null
  );

notify pgrst, 'reload schema';
