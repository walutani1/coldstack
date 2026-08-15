-- 068: every column carries its OWN model, one per runner mode.
--
-- Before this, a column's model was a single optional override and everything
-- else fell back to one workspace-wide "default model" on the runner config.
-- That default was invisible in the table UI yet silently drove the two built-in
-- personalization columns AND the whole email-QA gate (the judge) - the most
-- expensive and most safety-critical calls in the pipeline. Reading the table
-- told you nothing about what actually ran.
--
-- Now: enrichment_columns.model is the API-mode choice (a gateway "vendor/model"
-- id) and cli_model is the CLI-mode choice (a `claude --model` / `codex -m`
-- value). The runner picks the one matching the active provider, so toggling
-- API/CLI never silently substitutes a model the operator did not choose.

alter table public.enrichment_columns
  add column if not exists cli_model text check (cli_model is null or char_length(cli_model) <= 100);

comment on column public.enrichment_columns.model is
  'Model used when the runner is in API mode (a gateway "vendor/model" id).';
comment on column public.enrichment_columns.cli_model is
  'Model used when the runner is in CLI mode (a claude/codex --model value).';

-- Backfill the CLI side from what each column was effectively running: the
-- workspace runner has been pinned to the Claude CLI, so a Claude-flavoured
-- override maps to the same model on the CLI, and everything else (including
-- the columns that had no override and rode the workspace default) takes the
-- CLI's own default, which is what they were already using.
update public.enrichment_columns
set cli_model = case
  when model like 'claude-%' then model
  else null
end
where cli_model is null and kind in ('ai', 'email_qa', 'builtin');

notify pgrst, 'reload schema';
