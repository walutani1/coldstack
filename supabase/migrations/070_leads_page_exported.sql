-- 070: filter the grid by whether a lead has been pushed to this list's campaign.
--
-- The saved-view model stores a filter set, and "not yet in the campaign" - the
-- one question that decides what still needs running - could not be expressed,
-- so a view for the run queue could not be built at all.
--
-- Adds p_exported to enrichment_leads_page. The old signature is dropped rather
-- than left alongside: a defaulted extra parameter makes the two overloads
-- ambiguous for a call that names only the original arguments.

drop function if exists public.enrichment_leads_page(integer,integer,text,text[],text[],text[],boolean,boolean,text,text,uuid,integer,text,boolean,uuid[],uuid,text,integer,uuid,uuid);
drop function if exists public.enrichment_leads_page(integer,integer,text,text[],text[],text[],boolean,boolean,text,text,uuid,integer,text,boolean,uuid[],uuid,text,integer,uuid,uuid,boolean);

CREATE OR REPLACE FUNCTION public.enrichment_leads_page(p_limit integer, p_offset integer, p_search text, p_role_levels text[], p_email_statuses text[], p_countries text[], p_has_email boolean, p_qualified_only boolean, p_sort text, p_sort_dir text, p_table_id uuid DEFAULT NULL::uuid, p_min_contacts integer DEFAULT 2, p_exclude_company_role text DEFAULT NULL::text, p_require_send_wave boolean DEFAULT true, p_lead_ids uuid[] DEFAULT NULL::uuid[], p_cell_column_id uuid DEFAULT NULL::uuid, p_cell_state text DEFAULT NULL::text, p_cell_generation integer DEFAULT NULL::integer, p_errored_job_id uuid DEFAULT NULL::uuid, p_queued_job_id uuid DEFAULT NULL::uuid, p_exported boolean DEFAULT NULL::boolean)
 RETURNS TABLE(id uuid, company_id uuid, role_level text, first_name text, last_name text, title text, email text, email_status text, final_first_name text, final_title text, final_company_name text, operations_task text, ops_candidate text, personalization_updated_at timestamp with time zone, smartlead_campaign_id text, smartlead_campaign_name text, smartlead_export_status text, smartlead_exported_at timestamp with time zone, smartlead_export_error text, smartlead_lead_id text, linkedin_url text, company text, domain text, send_wave smallint, shared_company boolean, lead_city text, lead_state text, lead_country text, suppression_reason text, linkedin_employment_status text, linkedin_current_company text, linkedin_checked_at timestamp with time zone, company_summary jsonb, custom_cells jsonb, custom_cell_gens jsonb, updated_at timestamp with time zone, total_count bigint, table_export_status text, table_exported_at timestamp with time zone, table_export_error text)
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
begin
  if p_sort is not null and p_sort not in ('contact','company','qualification','email','validate_email','email_status','final_first_name','final_title','final_company_name','operations_task','ops_candidate','smartlead_export') then
    raise exception 'Unsupported enrichment lead sort: %', p_sort;
  end if;
  if coalesce(p_sort_dir, 'asc') not in ('asc', 'desc') then raise exception 'Unsupported enrichment lead sort direction: %', p_sort_dir; end if;
  if p_cell_state is not null and p_cell_state not in ('not_run','done','outdated') then raise exception 'Unsupported run-state filter: %', p_cell_state; end if;

  return query
  with filtered as (
    select l.*,
      nullif(btrim(coalesce(l.raw->>'Lead City','')), '') computed_lead_city,
      nullif(btrim(coalesce(l.raw->>'Lead State','')), '') computed_lead_state,
      nullif(btrim(coalesce(l.raw->>'Lead Country','')), '') computed_lead_country,
      (select coalesce(nullif(btrim(s.reason),''), 'Suppressed (' || s.kind || ')') from public.suppressions s
       where (s.kind='email' and nullif(btrim(l.email),'') is not null and lower(s.value)=lower(btrim(l.email)))
          or (s.kind='domain' and nullif(btrim(l.domain),'') is not null and lower(s.value)=lower(btrim(l.domain))) limit 1) computed_suppression_reason,
      case
        when exists (select 1 from public.suppressions s where (s.kind='email' and nullif(btrim(l.email),'') is not null and lower(s.value)=lower(btrim(l.email))) or (s.kind='domain' and nullif(btrim(l.domain),'') is not null and lower(s.value)=lower(btrim(l.domain)))) then 0
        when btrim(coalesce(l.raw->>'Lead Country','')) not in ('United States','United Kingdom','Canada','Australia') then 1
        when l.title ~* '\m(china|chinese|hong kong|apac|asia|asean|emea|europe|european|india|brazil|mexico|japan|korea|taiwan|vietnam|thailand|indonesia|philippines|malaysia|singapore|latam|latin america|middle east|mena|africa|turkey|russia|dach|benelux|nordics|iberia|france|germany|italy|spain|poland|portugal|greece|netherlands|uae|dubai|saudi arabia|israel)\M' then 2
        when l.title is null or l.title !~* '\m(operations?|opperations?|opertations?|operatons?|operational|operating|opérations?|opérationnel(?:le)?|exploitation|logistique|usine|ops|opex|manufacturing|production|plant|supply chain|logistics|warehouse|warehousing|factory|fulfil?lment|coo|chief operating|works manager|process improvement|process optimization|process excellence|continuous improvement|general manager)\M' then 3
        when nullif(btrim(l.email),'') is null then 4 when l.email_status='invalid' then 5 when l.email_status='risky' then 6 when l.email_status is null then 7
        when not (nullif(btrim(coalesce(l.final_first_name,'')),'') is not null and nullif(btrim(coalesce(l.final_title,'')),'') is not null and nullif(btrim(coalesce(l.final_company_name,'')),'') is not null and nullif(btrim(coalesce(l.operations_task,'')),'') is not null and nullif(btrim(coalesce(l.ops_candidate,'')),'') is not null) then 8 else 9 end qualification_rank
    from public.leads l
    where (not coalesce(p_require_send_wave, true) or l.send_wave is not null)
      and (p_lead_ids is null or l.id = any(p_lead_ids))
      -- Pushed into this list's campaign, or not. Read from
      -- enrichment_table_exports rather than leads.smartlead_export_status:
      -- that column is global, so a lead exported from a DIFFERENT list would
      -- read as already sent here. Meaningful only with p_table_id; without
      -- one no row has an export record, so `false` matches everything.
      and (p_exported is null or p_exported = exists (
        select 1 from public.enrichment_table_exports e
        where e.table_id = p_table_id and e.lead_id = l.id and e.status = 'exported'))
      and l.company_id in (select x.company_id from public.leads x where (not coalesce(p_require_send_wave, true) or x.send_wave is not null) group by x.company_id having count(*) >= greatest(1, coalesce(p_min_contacts, 2)))
      and (p_exclude_company_role is null or not exists (select 1 from public.leads y where y.company_id = l.company_id and y.role_level = p_exclude_company_role))
      and (p_search is null or btrim(p_search)='' or lower(coalesce(l.first_name,'')) like '%'||lower(btrim(p_search))||'%' or lower(coalesce(l.last_name,'')) like '%'||lower(btrim(p_search))||'%' or lower(coalesce(l.title,'')) like '%'||lower(btrim(p_search))||'%' or lower(coalesce(l.email,'')) like '%'||lower(btrim(p_search))||'%' or lower(coalesce(l.company,'')) like '%'||lower(btrim(p_search))||'%' or lower(coalesce(l.domain,'')) like '%'||lower(btrim(p_search))||'%')
      and (p_role_levels is null or cardinality(p_role_levels)=0 or coalesce(l.role_level,'unknown')=any(p_role_levels))
      and (p_email_statuses is null or cardinality(p_email_statuses)=0 or coalesce(l.email_status,'unknown')=any(p_email_statuses))
      and (p_countries is null or cardinality(p_countries)=0 or coalesce(nullif(btrim(coalesce(l.raw->>'Lead Country','')),''),'unknown')=any(p_countries))
      and (p_has_email is null or p_has_email=(nullif(btrim(l.email),'') is not null))
      -- Run-state filter for a chosen custom column (evaluated on its cell value +
      -- generation). NULL column or NULL state = no filter.
      and (p_cell_column_id is null or p_cell_state is null or (
        case p_cell_state
          when 'not_run' then not exists (select 1 from public.enrichment_cell_values cv where cv.column_id = p_cell_column_id and cv.lead_id = l.id and nullif(btrim(coalesce(cv.value,'')),'') is not null)
          when 'done' then exists (select 1 from public.enrichment_cell_values cv where cv.column_id = p_cell_column_id and cv.lead_id = l.id and nullif(btrim(coalesce(cv.value,'')),'') is not null and cv.generation_version >= coalesce(p_cell_generation, cv.generation_version))
          when 'outdated' then exists (select 1 from public.enrichment_cell_values cv where cv.column_id = p_cell_column_id and cv.lead_id = l.id and nullif(btrim(coalesce(cv.value,'')),'') is not null and cv.generation_version < coalesce(p_cell_generation, 0))
          else true
        end
      ))
      -- "Errored in this run" filter: the lead failed in the given run job.
      and (p_errored_job_id is null or exists (select 1 from public.enrichment_run_job_items ji where ji.job_id = p_errored_job_id and ji.lead_id = l.id and ji.status = 'failed'))
      -- "Queued in this run" filter: the lead is still waiting or in flight in the given run job.
      and (p_queued_job_id is null or exists (select 1 from public.enrichment_run_job_items jq where jq.job_id = p_queued_job_id and jq.lead_id = l.id and jq.status in ('pending','running')))
      and (not coalesce(p_qualified_only,false) or (
        btrim(coalesce(l.raw->>'Lead Country','')) in ('United States','United Kingdom','Canada','Australia')
        and l.title ~* '\m(operations?|opperations?|opertations?|operatons?|operational|operating|opérations?|opérationnel(?:le)?|exploitation|logistique|usine|ops|opex|manufacturing|production|plant|supply chain|logistics|warehouse|warehousing|factory|fulfil?lment|coo|chief operating|works manager|process improvement|process optimization|process excellence|continuous improvement|general manager)\M'
        and l.title !~* '\m(china|chinese|hong kong|apac|asia|asean|emea|europe|european|india|brazil|mexico|japan|korea|taiwan|vietnam|thailand|indonesia|philippines|malaysia|singapore|latam|latin america|middle east|mena|africa|turkey|russia|dach|benelux|nordics|iberia|france|germany|italy|spain|poland|portugal|greece|netherlands|uae|dubai|saudi arabia|israel)\M'
        and not exists (select 1 from public.suppressions s where (s.kind='email' and nullif(btrim(l.email),'') is not null and lower(s.value)=lower(btrim(l.email))) or (s.kind='domain' and nullif(btrim(l.domain),'') is not null and lower(s.value)=lower(btrim(l.domain))))
      ))
  )
  select f.id,f.company_id,f.role_level,f.first_name,f.last_name,f.title,f.email,f.email_status,f.final_first_name,f.final_title,f.final_company_name,f.operations_task,f.ops_candidate,f.personalization_updated_at,f.smartlead_campaign_id,f.smartlead_campaign_name,f.smartlead_export_status,f.smartlead_exported_at,f.smartlead_export_error,f.smartlead_lead_id,f.linkedin_url,f.company,f.domain,f.send_wave,f.shared_company,f.computed_lead_city,f.computed_lead_state,f.computed_lead_country,f.computed_suppression_reason,f.linkedin_employment_status,f.linkedin_current_company,f.linkedin_checked_at,(select cc.company_summary from public.companies cc where cc.id=f.company_id),(select jsonb_object_agg(col.key, cv.value) from public.enrichment_cell_values cv join public.enrichment_columns col on col.id=cv.column_id where col.table_id=p_table_id and cv.lead_id=f.id),(select jsonb_object_agg(col.key, cv.generation_version) from public.enrichment_cell_values cv join public.enrichment_columns col on col.id=cv.column_id where col.table_id=p_table_id and cv.lead_id=f.id),f.updated_at,count(*) over(),te.status,te.exported_at,te.error
  from filtered f
  left join lateral (select e.status,e.exported_at,e.error from public.enrichment_table_exports e where p_table_id is not null and e.table_id=p_table_id and e.lead_id=f.id order by (e.status='exported') desc,e.exported_at desc,e.id desc limit 1) te on true
  order by
    case when p_sort='contact' and coalesce(p_sort_dir,'asc')='asc' then lower(coalesce(f.last_name,'')) end asc nulls last, case when p_sort='contact' and p_sort_dir='desc' then lower(coalesce(f.last_name,'')) end desc nulls last,
    case when p_sort='contact' and coalesce(p_sort_dir,'asc')='asc' then lower(coalesce(f.first_name,'')) end asc nulls last, case when p_sort='contact' and p_sort_dir='desc' then lower(coalesce(f.first_name,'')) end desc nulls last,
    case when p_sort='company' and coalesce(p_sort_dir,'asc')='asc' then lower(coalesce(f.company,'')) end asc nulls last, case when p_sort='company' and p_sort_dir='desc' then lower(coalesce(f.company,'')) end desc nulls last,
    case when p_sort='qualification' and coalesce(p_sort_dir,'asc')='asc' then f.qualification_rank end asc nulls last, case when p_sort='qualification' and p_sort_dir='desc' then f.qualification_rank end desc nulls last,
    case when p_sort='email' and coalesce(p_sort_dir,'asc')='asc' then lower(coalesce(f.email,'')) end asc nulls last, case when p_sort='email' and p_sort_dir='desc' then lower(coalesce(f.email,'')) end desc nulls last,
    case when p_sort in ('validate_email','email_status') and coalesce(p_sort_dir,'asc')='asc' then f.email_status end asc nulls last, case when p_sort in ('validate_email','email_status') and p_sort_dir='desc' then f.email_status end desc nulls last,
    case when p_sort='final_first_name' and coalesce(p_sort_dir,'asc')='asc' then lower(coalesce(f.final_first_name,'')) end asc nulls last, case when p_sort='final_first_name' and p_sort_dir='desc' then lower(coalesce(f.final_first_name,'')) end desc nulls last,
    case when p_sort='final_title' and coalesce(p_sort_dir,'asc')='asc' then lower(coalesce(f.final_title,'')) end asc nulls last, case when p_sort='final_title' and p_sort_dir='desc' then lower(coalesce(f.final_title,'')) end desc nulls last,
    case when p_sort='final_company_name' and coalesce(p_sort_dir,'asc')='asc' then lower(coalesce(f.final_company_name,'')) end asc nulls last, case when p_sort='final_company_name' and p_sort_dir='desc' then lower(coalesce(f.final_company_name,'')) end desc nulls last,
    case when p_sort='operations_task' and coalesce(p_sort_dir,'asc')='asc' then lower(coalesce(f.operations_task,'')) end asc nulls last, case when p_sort='operations_task' and p_sort_dir='desc' then lower(coalesce(f.operations_task,'')) end desc nulls last,
    case when p_sort='ops_candidate' and coalesce(p_sort_dir,'asc')='asc' then lower(coalesce(f.ops_candidate,'')) end asc nulls last, case when p_sort='ops_candidate' and p_sort_dir='desc' then lower(coalesce(f.ops_candidate,'')) end desc nulls last,
    case when p_sort='smartlead_export' and coalesce(p_sort_dir,'asc')='asc' then f.smartlead_export_status end asc nulls last, case when p_sort='smartlead_export' and p_sort_dir='desc' then f.smartlead_export_status end desc nulls last,
    case when p_sort is null then f.send_wave end, case when p_sort is null and f.email_status is null then 0 when p_sort is null then 1 end, case when p_sort is null then f.company end nulls last, case when p_sort is null then f.role_level end nulls last, case when p_sort is null then f.last_name end nulls last, f.id
  limit greatest(1,least(coalesce(p_limit,100),500)) offset greatest(0,coalesce(p_offset,0));
end;
$function$
;

revoke execute on function public.enrichment_leads_page(integer,integer,text,text[],text[],text[],boolean,boolean,text,text,uuid,integer,text,boolean,uuid[],uuid,text,integer,uuid,uuid,boolean) from public, anon, authenticated;
grant execute on function public.enrichment_leads_page(integer,integer,text,text[],text[],text[],boolean,boolean,text,text,uuid,integer,text,boolean,uuid[],uuid,text,integer,uuid,uuid,boolean) to service_role;
notify pgrst, 'reload schema';
