-- Custom AI column prompts are now self-contained: the stored prompt is the
-- entire prompt sent to the model, with {{variables}} resolved per lead. Nothing
-- is appended at run time anymore (the old code appended a "--- Lead context ---"
-- block built from source_keys). Bake that context into each existing Decision
-- Makers column's prompt as {{variables}} so behavior is preserved and the whole
-- prompt is visible and editable in the app.
--
-- generation_version is deliberately left untouched: the resolved prompt feeds
-- the model the same data as before, so already-generated cells stay valid (not
-- marked outdated). The `prompt not like '%{{%'` guard makes this idempotent -
-- it only rewrites prompts that have not already been migrated.

update public.enrichment_columns c
set prompt = $prompt$Write the tenure phrase for the cold-email sentence "after {tenure} {role_responsibility}, ...". You are given how long the person has been at their current company. Never state an exact or decimal figure (not "2.4 years"). Say it the way a person would out loud, rounding to a clean estimate: "over two years", "almost three years", or "nearly four years". Spell small numbers as words. Return only the phrase, lowercase, with no trailing punctuation.

--- Context ---
Job title on file: {{title}} at {{company}}.
{{linkedin_experience}}$prompt$
from public.enrichment_tables t
join public.enrichment_workbooks w on w.id = t.workbook_id
where c.table_id = t.id and t.slug = 'decision-makers' and w.slug = 'manufacturing-ops' and c.key = 'tenure' and c.prompt not like '%{{%';

update public.enrichment_columns c
set prompt = $prompt$Write a 2 to 4 word phrase for the cold-email sentence "after {tenure} {role_responsibility}, ...". It describes what the person leads or manages, based on their job title. If a current LinkedIn title is provided and differs from the given title, prefer the LinkedIn one. Use natural phrasing such as "leading operations", "managing operations", or "leading the operations team". Never include the company name. Return only the phrase, lowercase, with no trailing punctuation.

--- Context ---
Job title on file: {{title}} at {{company}}.
{{linkedin_experience}}$prompt$
from public.enrichment_tables t
join public.enrichment_workbooks w on w.id = t.workbook_id
where c.table_id = t.id and t.slug = 'decision-makers' and w.slug = 'manufacturing-ops' and c.key = 'role_responsibility' and c.prompt not like '%{{%';

update public.enrichment_columns c
set prompt = $prompt$Suggest ONE specific operational process this company could automate or build a small internal tool or AI agent for, based on what they make and the markets they serve. Pick the single highest-impact manual process for their operation. Rules: concise (a short noun phrase, under about 12 words); a clear, useful outcome an ops team would actually want; and niche and specific to their business. Avoid anything a big off-the-shelf system (ERP, CRM, MES, accounting, or e-commerce platform) already handles. Return only the task, with no preamble.

--- Company context ---
{{company_summary}}

Role: {{title}} ({{role_level}}).$prompt$
from public.enrichment_tables t
join public.enrichment_workbooks w on w.id = t.workbook_id
where c.table_id = t.id and t.slug = 'decision-makers' and w.slug = 'manufacturing-ops' and c.key = 'ops_task_1' and c.prompt not like '%{{%';

update public.enrichment_columns c
set prompt = $prompt$Suggest ONE specific data-entry, tracking, or reporting bottleneck this company could automate with a small internal tool or AI agent, based on what they make and the markets they serve. It must be DIFFERENT from order intake or scheduling. Rules: concise short noun phrase (under about 12 words); clearly useful to an ops team; niche and specific to their business; and not something a big off-the-shelf system already solves. Return only the task, with no preamble.

--- Company context ---
{{company_summary}}

Role: {{title}} ({{role_level}}).

Already suggested for this company (pick something clearly different, do not overlap):
- {{ops_task_1}}$prompt$
from public.enrichment_tables t
join public.enrichment_workbooks w on w.id = t.workbook_id
where c.table_id = t.id and t.slug = 'decision-makers' and w.slug = 'manufacturing-ops' and c.key = 'ops_task_2' and c.prompt not like '%{{%';

update public.enrichment_columns c
set prompt = $prompt$Suggest ONE specific coordination, status-visibility, or communication bottleneck this company could fix with a small internal tool or AI agent, based on what they make and the markets they serve. It must be in a DIFFERENT category from an order-intake task and from a report or tracker. Rules: concise short noun phrase (under about 12 words); useful to a growing ops team; niche and specific; and not covered by big off-the-shelf software. Return only the task, with no preamble.

--- Company context ---
{{company_summary}}

Role: {{title}} ({{role_level}}).

Already suggested for this company (pick something clearly different, do not overlap):
- {{ops_task_1}}
- {{ops_task_2}}$prompt$
from public.enrichment_tables t
join public.enrichment_workbooks w on w.id = t.workbook_id
where c.table_id = t.id and t.slug = 'decision-makers' and w.slug = 'manufacturing-ops' and c.key = 'ops_task_3' and c.prompt not like '%{{%';
