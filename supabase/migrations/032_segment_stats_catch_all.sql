-- Count ZeroBounce catch-alls in the 'risky' status bucket so validated
-- catch-alls are not lost from the segment stats (they still never proceed).

CREATE OR REPLACE FUNCTION public.enrichment_segment_stats()
 RETURNS TABLE(total_leads integer, companies integer, managers integer, directors integer, wave_1 integer, wave_2 integer, shared_company integer, known_email integer, missing_email integer, pending_validation integer, deliverable integer, risky integer, invalid integer)
 LANGUAGE sql
 SET search_path TO ''
AS $function$
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
    count(*) filter (where l.email_status in ('risky','catch_all'))::integer as risky,
    count(*) filter (where l.email_status = 'invalid')::integer as invalid
  from public.leads l
  where l.send_wave is not null
    and l.company_id in (
      select segment_leads.company_id
      from public.leads segment_leads
      where segment_leads.send_wave is not null
      group by segment_leads.company_id
      having count(*) >= 2
    );
$function$

