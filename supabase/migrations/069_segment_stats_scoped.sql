-- 069: scope the segment stats to one list.
--
-- enrichment_segment_stats() counted every lead in the database, but the table
-- header rendered it beside a single list name. Three lists share one lead
-- pool, so all three showed the same numbers and none of them described the
-- rows on screen.
--
-- Take the same canonical filter enrichment_leads_page takes, so the counts
-- describe exactly the rows that list shows. The qualification predicate below
-- is copied verbatim from 049 for that reason: a retyped regex that drifts by
-- one term would report a total the grid disagrees with.
--
-- Also splits catch-alls out of the 'risky' bucket that 032 merged them into.
-- Merging kept them from being lost when the header had no row of their own;
-- now every bucket is listed and each row filters the grid to itself, so a
-- merged count would be a row that cannot reproduce its own number (risky and
-- catch_all are separate values in the status filter).
--
-- Every parameter defaults to the previous behaviour, so the zero-argument call
-- the Enrichment home page makes still returns workspace-wide numbers and keeps
-- working across the gap between applying this and deploying the code.

-- Both signatures: the original zero-argument one, and this file's own, so
-- re-running the migration replaces its function instead of failing on it.
drop function if exists public.enrichment_segment_stats();
drop function if exists public.enrichment_segment_stats(text[],text[],text[],boolean,boolean,integer,text,boolean);

create function public.enrichment_segment_stats(
  p_role_levels text[] default null,
  p_email_statuses text[] default null,
  p_countries text[] default null,
  p_has_email boolean default null,
  p_qualified_only boolean default null,
  p_min_contacts integer default 2,
  p_exclude_company_role text default null,
  p_require_send_wave boolean default true
)
returns table(
  total_leads integer, companies integer, managers integer, directors integer,
  wave_1 integer, wave_2 integer, shared_company integer, known_email integer,
  missing_email integer, pending_validation integer, deliverable integer,
  risky integer, invalid integer, catch_all integer
)
language sql
stable
set search_path to ''
as $function$
  select
    count(*)::integer as total_leads,
    count(distinct l.company_id)::integer as companies,
    count(*) filter (where l.role_level = 'manager')::integer as managers,
    count(*) filter (where l.role_level = 'director')::integer as directors,
    count(*) filter (where l.send_wave = 1)::integer as wave_1,
    count(*) filter (where l.send_wave = 2)::integer as wave_2,
    count(*) filter (where l.shared_company is true)::integer as shared_company,
    count(*) filter (where nullif(btrim(l.email), '') is not null)::integer as known_email,
    count(*) filter (where nullif(btrim(l.email), '') is null)::integer as missing_email,
    count(*) filter (where nullif(btrim(l.email), '') is not null and l.email_status is null)::integer as pending_validation,
    count(*) filter (where l.email_status = 'deliverable')::integer as deliverable,
    count(*) filter (where l.email_status = 'risky')::integer as risky,
    count(*) filter (where l.email_status = 'invalid')::integer as invalid,
    count(*) filter (where l.email_status = 'catch_all')::integer as catch_all
  from public.leads l
  where (not coalesce(p_require_send_wave, true) or l.send_wave is not null)
    and l.company_id in (
      select x.company_id from public.leads x
      where (not coalesce(p_require_send_wave, true) or x.send_wave is not null)
      group by x.company_id having count(*) >= greatest(1, coalesce(p_min_contacts, 2))
    )
    and (p_exclude_company_role is null or not exists (select 1 from public.leads y where y.company_id = l.company_id and y.role_level = p_exclude_company_role))
    and (p_role_levels is null or cardinality(p_role_levels)=0 or coalesce(l.role_level,'unknown')=any(p_role_levels))
    and (p_email_statuses is null or cardinality(p_email_statuses)=0 or coalesce(l.email_status,'unknown')=any(p_email_statuses))
    and (p_countries is null or cardinality(p_countries)=0 or coalesce(nullif(btrim(coalesce(l.raw->>'Lead Country','')),''),'unknown')=any(p_countries))
    and (p_has_email is null or p_has_email=(nullif(btrim(l.email),'') is not null))
    and (not coalesce(p_qualified_only,false) or (
      btrim(coalesce(l.raw->>'Lead Country','')) in ('United States','United Kingdom','Canada','Australia')
      and l.title ~* '\m(operations?|opperations?|opertations?|operatons?|operational|operating|opérations?|opérationnel(?:le)?|exploitation|logistique|usine|ops|opex|manufacturing|production|plant|supply chain|logistics|warehouse|warehousing|factory|fulfil?lment|coo|chief operating|works manager|process improvement|process optimization|process excellence|continuous improvement|general manager)\M'
      and l.title !~* '\m(china|chinese|hong kong|apac|asia|asean|emea|europe|european|india|brazil|mexico|japan|korea|taiwan|vietnam|thailand|indonesia|philippines|malaysia|singapore|latam|latin america|middle east|mena|africa|turkey|russia|dach|benelux|nordics|iberia|france|germany|italy|spain|poland|portugal|greece|netherlands|uae|dubai|saudi arabia|israel)\M'
      and not exists (select 1 from public.suppressions s where (s.kind='email' and nullif(btrim(l.email),'') is not null and lower(s.value)=lower(btrim(l.email))) or (s.kind='domain' and nullif(btrim(l.domain),'') is not null and lower(s.value)=lower(btrim(l.domain))))
    ))
$function$;

revoke execute on function public.enrichment_segment_stats(text[],text[],text[],boolean,boolean,integer,text,boolean) from public, anon, authenticated;
grant execute on function public.enrichment_segment_stats(text[],text[],text[],boolean,boolean,integer,text,boolean) to service_role;
