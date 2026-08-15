-- Per-column reasoning effort for API models. Null means off — the runner
-- explicitly sends reasoning effort "none", which is what every column did
-- before this knob existed. The gateway normalizes the value across vendors
-- (OpenAI reasoning_effort, Anthropic thinking budgets, ...), so one column
-- serves every model family.
alter table public.enrichment_columns
  add column if not exists reasoning_effort text
  constraint enrichment_columns_reasoning_effort_check
  check (reasoning_effort in ('low', 'medium', 'high'));
