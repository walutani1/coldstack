-- Per-column few-shot examples. Each example is one short line the operator adds
-- in the editor's Examples section; they are appended to the prompt at run time
-- under an "Examples of the style I want" heading (visible in the preview). Kept
-- as a text[] so the app reads/writes them as a simple list.
alter table public.enrichment_columns
  add column if not exists examples text[] not null default '{}';
