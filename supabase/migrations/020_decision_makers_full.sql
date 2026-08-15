-- 020: Decision Makers = the COMPLETE set of directors at companies with no
-- manager, not just the ones already pulled into a send wave. Adds one more
-- config-only, backward-compatible param, p_require_send_wave (default true so
-- Champions and every existing caller are unchanged), and flips it off for the
-- Decision Makers table. Result: that table now surfaces all ~13,422 directors
-- whose company has no manager/senior coworker.

drop function if exists public.enrichment_leads_page(integer,integer,text,text[],text[],text[],boolean,boolean,text,text,uuid,integer,text);

create function public.enrichment_leads_page(
  p_limit integer,
  p_offset integer,
  p_search text,
  p_role_levels text[],
  p_email_statuses text[],
  p_countries text[],
  p_has_email boolean,
  p_qualified_only boolean,
  p_sort text,
  p_sort_dir text,
  p_table_id uuid default null,
  p_min_contacts integer default 2,
  p_exclude_company_role text default null,
  p_require_send_wave boolean default true
)
returns table (
  id uuid, company_id uuid, role_level text, first_name text, last_name text, title text, email text,
  email_status text, final_first_name text, final_title text, final_company_name text, operations_task text,
  ops_candidate text, personalization_updated_at timestamptz, smartlead_campaign_id text,
  smartlead_campaign_name text, smartlead_export_status text, smartlead_exported_at timestamptz,
  smartlead_export_error text, smartlead_lead_id text, linkedin_url text, company text, domain text,
  send_wave smallint, shared_company boolean, lead_city text, lead_state text, lead_country text,
  suppression_reason text, updated_at timestamptz, total_count bigint, table_export_status text,
  table_exported_at timestamptz, table_export_error text
)
language plpgsql security invoker set search_path = '' as $$
begin
  if p_sort is not null and p_sort not in ('contact','company','qualification','email','validate_email','email_status','final_first_name','final_title','final_company_name','operations_task','ops_candidate','smartlead_export') then
    raise exception 'Unsupported enrichment lead sort: %', p_sort;
  end if;
  if coalesce(p_sort_dir, 'asc') not in ('asc', 'desc') then raise exception 'Unsupported enrichment lead sort direction: %', p_sort_dir; end if;

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
      and l.company_id in (select x.company_id from public.leads x where (not coalesce(p_require_send_wave, true) or x.send_wave is not null) group by x.company_id having count(*) >= greatest(1, coalesce(p_min_contacts, 2)))
      and (p_exclude_company_role is null or not exists (select 1 from public.leads y where y.company_id = l.company_id and y.role_level = p_exclude_company_role))
      and (p_search is null or btrim(p_search)='' or lower(coalesce(l.first_name,'')) like '%'||lower(btrim(p_search))||'%' or lower(coalesce(l.last_name,'')) like '%'||lower(btrim(p_search))||'%' or lower(coalesce(l.title,'')) like '%'||lower(btrim(p_search))||'%' or lower(coalesce(l.email,'')) like '%'||lower(btrim(p_search))||'%' or lower(coalesce(l.company,'')) like '%'||lower(btrim(p_search))||'%' or lower(coalesce(l.domain,'')) like '%'||lower(btrim(p_search))||'%')
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
  )
  select f.id,f.company_id,f.role_level,f.first_name,f.last_name,f.title,f.email,f.email_status,f.final_first_name,f.final_title,f.final_company_name,f.operations_task,f.ops_candidate,f.personalization_updated_at,f.smartlead_campaign_id,f.smartlead_campaign_name,f.smartlead_export_status,f.smartlead_exported_at,f.smartlead_export_error,f.smartlead_lead_id,f.linkedin_url,f.company,f.domain,f.send_wave,f.shared_company,f.computed_lead_city,f.computed_lead_state,f.computed_lead_country,f.computed_suppression_reason,f.updated_at,count(*) over(),te.status,te.exported_at,te.error
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
    case when p_sort is null then f.send_wave end, case when p_sort is null and f.email_status is null then 0 when p_sort is null then 1 end, case when p_sort is null then f.company end nulls last, case when p_sort is null then f.role_level end nulls last, case when p_sort is null then f.last_name end nulls last, case when p_sort is null then f.first_name end nulls last, f.id
  limit greatest(1,least(coalesce(p_limit,100),500)) offset greatest(0,coalesce(p_offset,0));
end;
$$;

drop function if exists public.enrichment_run_candidates(text,text,integer,timestamptz,text[],text[],text[],boolean,boolean,uuid,integer,text);

create function public.enrichment_run_candidates(
  p_action text, p_mode text, p_limit integer, p_prompt_updated_at timestamptz default null,
  p_role_levels text[] default null, p_email_statuses text[] default null, p_countries text[] default null,
  p_has_email boolean default null, p_qualified_only boolean default null, p_table_id uuid default null,
  p_min_contacts integer default 2, p_exclude_company_role text default null, p_require_send_wave boolean default true
)
returns table (
  id uuid, company_id uuid, role_level text, first_name text, last_name text, title text, email text,
  email_status text, final_first_name text, final_title text, final_company_name text, operations_task text,
  ops_candidate text, personalization_updated_at timestamptz, smartlead_campaign_id text,
  smartlead_campaign_name text, smartlead_export_status text, smartlead_exported_at timestamptz,
  smartlead_export_error text, smartlead_lead_id text, linkedin_url text, company text, domain text,
  send_wave smallint, shared_company boolean, lead_city text, lead_state text, lead_country text,
  suppression_reason text, updated_at timestamptz, run_action text
)
language plpgsql security invoker set search_path = '' as $$
begin
  if p_action not in ('find_email','validate_email','final_first_name','final_title','final_company_name','operations_task','ops_candidate','smartlead_export') then raise exception 'Unsupported enrichment action: %',p_action; end if;
  if p_mode not in ('test10','unrun','outdated','force') then raise exception 'Unsupported enrichment run mode: %',p_mode; end if;
  return query
  select l.id,l.company_id,l.role_level,l.first_name,l.last_name,l.title,l.email,l.email_status,l.final_first_name,l.final_title,l.final_company_name,l.operations_task,l.ops_candidate,l.personalization_updated_at,l.smartlead_campaign_id,l.smartlead_campaign_name,l.smartlead_export_status,l.smartlead_exported_at,l.smartlead_export_error,l.smartlead_lead_id,l.linkedin_url,l.company,l.domain,l.send_wave,l.shared_company,
    nullif(btrim(coalesce(l.raw->>'Lead City','')),''),nullif(btrim(coalesce(l.raw->>'Lead State','')),''),nullif(btrim(coalesce(l.raw->>'Lead Country','')),''),
    (select coalesce(nullif(btrim(s.reason),''),'Suppressed ('||s.kind||')') from public.suppressions s where (s.kind='email' and nullif(btrim(l.email),'') is not null and lower(s.value)=lower(btrim(l.email))) or (s.kind='domain' and nullif(btrim(l.domain),'') is not null and lower(s.value)=lower(btrim(l.domain))) limit 1),l.updated_at,p_action
  from public.leads l
  where (not coalesce(p_require_send_wave, true) or l.send_wave is not null) and l.company_id in (select x.company_id from public.leads x where (not coalesce(p_require_send_wave, true) or x.send_wave is not null) group by x.company_id having count(*)>=greatest(1, coalesce(p_min_contacts, 2)))
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
    and (case
      when p_mode='outdated' then p_action in ('final_first_name','final_title','final_company_name','ops_candidate') and p_prompt_updated_at is not null and l.email_status='deliverable'
        and nullif(btrim(coalesce(case p_action when 'final_first_name' then l.final_first_name when 'final_title' then l.final_title when 'final_company_name' then l.final_company_name when 'ops_candidate' then l.ops_candidate end,'')),'') is not null
        and coalesce((select max(r.created_at) from public.lead_runs r where r.lead_id=l.id and r.action='personalization:'||p_action and r.ok),'-infinity'::timestamptz) < p_prompt_updated_at
      when p_action='find_email' then (nullif(btrim(l.email),'') is null or l.email_status='invalid') and nullif(btrim(l.first_name),'') is not null and nullif(btrim(l.last_name),'') is not null and nullif(btrim(l.domain),'') is not null
      when p_action='validate_email' then nullif(btrim(l.email),'') is not null and (p_mode='force' or l.email_status is null)
      when p_action='smartlead_export' then l.email_status='deliverable' and nullif(btrim(l.email),'') is not null
        and btrim(coalesce(l.raw->>'Lead Country','')) in ('United States','United Kingdom','Canada','Australia')
        and l.title ~* '\m(operations?|opperations?|opertations?|operatons?|operational|operating|opérations?|opérationnel(?:le)?|exploitation|logistique|usine|ops|opex|manufacturing|production|plant|supply chain|logistics|warehouse|warehousing|factory|fulfil?lment|coo|chief operating|works manager|process improvement|process optimization|process excellence|continuous improvement|general manager)\M'
        and l.title !~* '\m(china|chinese|hong kong|apac|asia|asean|emea|europe|european|india|brazil|mexico|japan|korea|taiwan|vietnam|thailand|indonesia|philippines|malaysia|singapore|latam|latin america|middle east|mena|africa|turkey|russia|dach|benelux|nordics|iberia|france|germany|italy|spain|poland|portugal|greece|netherlands|uae|dubai|saudi arabia|israel)\M'
        and not exists (select 1 from public.suppressions s where (s.kind='email' and nullif(btrim(l.email),'') is not null and lower(s.value)=lower(btrim(l.email))) or (s.kind='domain' and nullif(btrim(l.domain),'') is not null and lower(s.value)=lower(btrim(l.domain))))
        and nullif(btrim(coalesce(l.final_first_name,'')),'') is not null and nullif(btrim(coalesce(l.final_title,'')),'') is not null and nullif(btrim(coalesce(l.final_company_name,'')),'') is not null and nullif(btrim(coalesce(l.operations_task,'')),'') is not null and nullif(btrim(coalesce(l.ops_candidate,'')),'') is not null
        and (p_mode='force' or (p_table_id is null and (l.smartlead_export_status is null or l.smartlead_export_status='failed')) or (p_table_id is not null and not exists (select 1 from public.enrichment_table_exports e where e.table_id=p_table_id and e.lead_id=l.id and e.status='exported')))
      else l.email_status='deliverable' and (p_mode='force' or nullif(btrim(coalesce(case p_action when 'final_first_name' then l.final_first_name when 'final_title' then l.final_title when 'final_company_name' then l.final_company_name when 'operations_task' then l.operations_task when 'ops_candidate' then l.ops_candidate end,'')),'') is null)
    end)
  order by l.send_wave,case when l.email_status is null then 0 else 1 end,l.company nulls last,l.role_level nulls last,l.last_name nulls last,l.first_name nulls last,l.id
  limit case when p_mode='test10' then least(greatest(coalesce(p_limit,10),1),10) else least(greatest(coalesce(p_limit,5000),1),5000) end;
end;
$$;

revoke execute on function public.enrichment_leads_page(integer,integer,text,text[],text[],text[],boolean,boolean,text,text,uuid,integer,text,boolean) from public, anon, authenticated;
revoke execute on function public.enrichment_run_candidates(text,text,integer,timestamptz,text[],text[],text[],boolean,boolean,uuid,integer,text,boolean) from public, anon, authenticated;
grant execute on function public.enrichment_leads_page(integer,integer,text,text[],text[],text[],boolean,boolean,text,text,uuid,integer,text,boolean) to service_role;
grant execute on function public.enrichment_run_candidates(text,text,integer,timestamptz,text[],text[],text[],boolean,boolean,uuid,integer,text,boolean) to service_role;

update public.enrichment_tables t
set config = t.config || '{"requireSendWave":false}'::jsonb
from public.enrichment_workbooks w
where t.workbook_id = w.id and w.slug = 'manufacturing-ops' and t.slug = 'decision-makers';

notify pgrst, 'reload schema';
