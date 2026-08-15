-- Allow the email review (QA) column kind. The original constraint only permitted
-- builtin / source / ai.
alter table public.enrichment_columns drop constraint if exists enrichment_columns_kind_check;
alter table public.enrichment_columns
  add constraint enrichment_columns_kind_check
  check (kind in ('builtin', 'source', 'ai', 'email_qa'));
