-- 050: tenure fallback for unknown durations.
--
-- The tenure value renders inline in the email ("after {tenure} {role} at
-- {company}"), and the seed prompt gave the model no instruction for a lead
-- with no usable duration in context - so it improvised, and one lead shipped
-- a full paragraph explaining that it "won't fabricate a number" into the
-- tenure slot. Teach the prompt the approved fallback ("your time", which
-- claims no length at all); the runner also enforces it deterministically
-- (tenureOrFallback in custom-columns.ts), so this instruction is belt AND
-- braces. No generation bump: existing good cells stay current; the refusal
-- cells are healed by a targeted backfill, not a table-wide outdating.
--
-- Idempotent: guarded on the seed phrasing and on the fallback rule being
-- absent, so a re-apply (or an operator-edited prompt) is never clobbered.

update public.enrichment_columns
set prompt = replace(
      prompt,
      E'Return only the phrase, lowercase, with no trailing punctuation.',
      E'If the context gives no real duration (no start date and no years/months figure anywhere), return exactly "your time" - never explain, never ask for data, never invent a number. Return only the phrase, lowercase, with no trailing punctuation.'
    ),
    updated_at = now()
where key = 'tenure'
  and prompt like '%Write the tenure phrase%'
  and prompt not like '%your time%';

notify pgrst, 'reload schema';
