-- 047: harden the role_responsibility prompt against location/site leakage.
--
-- The field fills "after {tenure} {role_responsibility} at {company}, ...". A title
-- like "Director of Operations, Cloverdale" produced "leading operations at cloverdale",
-- giving the broken "...at cloverdale at Continuum Powders". The old prompt only forbade
-- the company name and its example sentence omitted the "at {company}" the template adds.
-- Rewrite it to output the FUNCTION only - stripping every location/site/rank qualifier,
-- by preposition or adjectivally - and bump the generation so existing cells read outdated.
-- Guarded so it is idempotent and never clobbers an operator-edited prompt.

update public.enrichment_columns
set prompt = 'Write a short phrase (2 to 4 words) for this exact cold-email sentence: "after {tenure} {role_responsibility} at [their company], ...".

Distill the job title down to the ONE core function the person leads or manages - operations, production, manufacturing, supply chain, logistics, engineering, quality, and so on - and say it as a short, natural phrase. The point is a clean, human-sounding core role, not a copy of the title. Titles are often messy and over-detailed; keep only the core function and drop the rest.

Rules:
- Use a natural verb phrase such as "leading operations", "managing operations", "running production", or "leading the operations team". The verb "leading" is fine.
- Keep ONLY the core function. Drop everything else in the title: seniority and rank words, locations, cities, sites, plants, facilities, regions, divisions, business units, company names, and any extra descriptive qualifiers - whether joined by a preposition or used as an adjective. Example: "Director of Operations, Cloverdale" becomes "leading operations" (drop the rank and "Cloverdale").
- The sentence already ends with "at [their company]", so never add a preposition and place ("at ...", "of ...", "for ...") and never include a company or location name.
- Do not copy rank or title labels such as director, manager, head of, vp, chief, senior, or junior.
- If a current LinkedIn title differs from the given title, prefer the LinkedIn one, applying the same rules.
Return only the lowercase phrase, with no trailing punctuation.

--- Context ---
Job title on file: {{title}} at {{company}}.
{{linkedin_experience}}',
    generation_version = generation_version + 1,
    updated_at = now()
-- Guard on a phrase unique to the OLD seed prompt: matches only the un-edited seed
-- (never an operator edit), and is idempotent - after this runs the prompt no longer
-- contains it, so a re-apply is a no-op and never re-bumps the generation.
where key = 'role_responsibility'
  and prompt like '%Write a 2 to 4 word phrase%';

notify pgrst, 'reload schema';
