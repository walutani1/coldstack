create table if not exists public.enrichment_views (
  id uuid primary key default gen_random_uuid(),
  table_id text not null,
  name text not null,
  profile_id uuid,
  config jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (table_id, name)
);

alter table public.enrichment_views enable row level security;
alter table public.suppressions enable row level security;
alter table public.lead_runs enable row level security;

revoke all on table public.enrichment_views from anon, authenticated;
revoke all on table public.suppressions from anon, authenticated;
revoke all on table public.lead_runs from anon, authenticated;

grant select, insert, update, delete on table public.enrichment_views to service_role;
grant select, insert, update, delete on table public.suppressions to service_role;
grant select, insert, update on table public.lead_runs to service_role;
grant select, update on table public.leads to service_role;

create index if not exists lead_runs_lead_created_idx
  on public.lead_runs (lead_id, created_at desc);

create index if not exists lead_runs_action_created_idx
  on public.lead_runs (action, created_at desc);

create unique index if not exists suppressions_kind_value_exact_idx
  on public.suppressions (kind, value);

create unique index if not exists lead_runs_run_lead_action_key
  on public.lead_runs (((details->>'run_id')), lead_id, action)
  where details->>'run_id' is not null;

create or replace function public.enrichment_leads_page(
  p_limit integer,
  p_offset integer,
  p_search text,
  p_role_levels text[],
  p_email_statuses text[],
  p_countries text[],
  p_has_email boolean,
  p_qualified_only boolean,
  p_sort text,
  p_sort_dir text
)
returns table (
  id uuid,
  company_id uuid,
  role_level text,
  first_name text,
  last_name text,
  title text,
  email text,
  email_status text,
  final_first_name text,
  final_title text,
  final_company_name text,
  operations_task text,
  ops_candidate text,
  personalization_updated_at timestamptz,
  smartlead_campaign_id text,
  smartlead_campaign_name text,
  smartlead_export_status text,
  smartlead_exported_at timestamptz,
  smartlead_export_error text,
  smartlead_lead_id text,
  linkedin_url text,
  company text,
  domain text,
  send_wave smallint,
  shared_company boolean,
  lead_city text,
  lead_state text,
  lead_country text,
  suppression_reason text,
  updated_at timestamptz,
  total_count bigint
)
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if p_sort is not null and p_sort not in (
    'contact', 'company', 'qualification', 'email', 'validate_email',
    'email_status', 'final_first_name', 'final_title', 'final_company_name',
    'operations_task', 'ops_candidate', 'smartlead_export'
  ) then
    raise exception 'Unsupported enrichment lead sort: %', p_sort;
  end if;

  if coalesce(p_sort_dir, 'asc') not in ('asc', 'desc') then
    raise exception 'Unsupported enrichment lead sort direction: %', p_sort_dir;
  end if;

  return query
  with filtered as (
    select
      l.*,
      nullif(btrim(coalesce(l.raw->>'Lead City', '')), '') as computed_lead_city,
      nullif(btrim(coalesce(l.raw->>'Lead State', '')), '') as computed_lead_state,
      nullif(btrim(coalesce(l.raw->>'Lead Country', '')), '') as computed_lead_country,
      (
        select coalesce(nullif(btrim(s.reason), ''), 'Suppressed (' || s.kind || ')')
        from public.suppressions s
        where (s.kind = 'email' and nullif(btrim(l.email), '') is not null and lower(s.value) = lower(btrim(l.email)))
           or (s.kind = 'domain' and nullif(btrim(l.domain), '') is not null and lower(s.value) = lower(btrim(l.domain)))
        limit 1
      ) as computed_suppression_reason,
      case
        when exists (
          select 1
          from public.suppressions s
          where (s.kind = 'email' and nullif(btrim(l.email), '') is not null and lower(s.value) = lower(btrim(l.email)))
             or (s.kind = 'domain' and nullif(btrim(l.domain), '') is not null and lower(s.value) = lower(btrim(l.domain)))
        ) then 0
        when btrim(coalesce(l.raw->>'Lead Country', '')) not in ('United States', 'United Kingdom', 'Canada', 'Australia') then 1
        when l.title ~* '\m(china|chinese|hong kong|apac|asia|asean|emea|europe|european|india|brazil|mexico|japan|korea|taiwan|vietnam|thailand|indonesia|philippines|malaysia|singapore|latam|latin america|middle east|mena|africa|turkey|russia|dach|benelux|nordics|iberia|france|germany|italy|spain|poland|portugal|greece|netherlands|uae|dubai|saudi arabia|israel)\M' then 2
        when l.title is null or l.title !~* '\m(operations?|opperations?|opertations?|operatons?|operational|operating|opérations?|opérationnel(?:le)?|exploitation|logistique|usine|ops|opex|manufacturing|production|plant|supply chain|logistics|warehouse|warehousing|factory|fulfil?lment|coo|chief operating|works manager|process improvement|process optimization|process excellence|continuous improvement|general manager)\M' then 3
        when nullif(btrim(l.email), '') is null then 4
        when l.email_status = 'invalid' then 5
        when l.email_status = 'risky' then 6
        when l.email_status is null then 7
        when not (
          nullif(btrim(coalesce(l.final_first_name, '')), '') is not null
          and nullif(btrim(coalesce(l.final_title, '')), '') is not null
          and nullif(btrim(coalesce(l.final_company_name, '')), '') is not null
          and nullif(btrim(coalesce(l.operations_task, '')), '') is not null
          and nullif(btrim(coalesce(l.ops_candidate, '')), '') is not null
        ) then 8
        else 9
      end as qualification_rank
    from public.leads l
    where l.send_wave is not null
      and l.company_id in (
        select segment_leads.company_id
        from public.leads segment_leads
        where segment_leads.send_wave is not null
        group by segment_leads.company_id
        having count(*) >= 2
      )
      and (
        p_search is null
        or btrim(p_search) = ''
        or lower(coalesce(l.first_name, '')) like '%' || lower(btrim(p_search)) || '%'
        or lower(coalesce(l.last_name, '')) like '%' || lower(btrim(p_search)) || '%'
        or lower(coalesce(l.title, '')) like '%' || lower(btrim(p_search)) || '%'
        or lower(coalesce(l.email, '')) like '%' || lower(btrim(p_search)) || '%'
        or lower(coalesce(l.company, '')) like '%' || lower(btrim(p_search)) || '%'
        or lower(coalesce(l.domain, '')) like '%' || lower(btrim(p_search)) || '%'
      )
      and (
        p_role_levels is null
        or cardinality(p_role_levels) = 0
        or coalesce(l.role_level, 'unknown') = any(p_role_levels)
      )
      and (
        p_email_statuses is null
        or cardinality(p_email_statuses) = 0
        or coalesce(l.email_status, 'unknown') = any(p_email_statuses)
      )
      and (
        p_countries is null
        or cardinality(p_countries) = 0
        or coalesce(nullif(btrim(coalesce(l.raw->>'Lead Country', '')), ''), 'unknown') = any(p_countries)
      )
      and (
        p_has_email is null
        or p_has_email = (nullif(btrim(l.email), '') is not null)
      )
      and (
        not coalesce(p_qualified_only, false)
        or (
          btrim(coalesce(l.raw->>'Lead Country', '')) in ('United States', 'United Kingdom', 'Canada', 'Australia')
          and l.title ~* '\m(operations?|opperations?|opertations?|operatons?|operational|operating|opérations?|opérationnel(?:le)?|exploitation|logistique|usine|ops|opex|manufacturing|production|plant|supply chain|logistics|warehouse|warehousing|factory|fulfil?lment|coo|chief operating|works manager|process improvement|process optimization|process excellence|continuous improvement|general manager)\M'
          and l.title !~* '\m(china|chinese|hong kong|apac|asia|asean|emea|europe|european|india|brazil|mexico|japan|korea|taiwan|vietnam|thailand|indonesia|philippines|malaysia|singapore|latam|latin america|middle east|mena|africa|turkey|russia|dach|benelux|nordics|iberia|france|germany|italy|spain|poland|portugal|greece|netherlands|uae|dubai|saudi arabia|israel)\M'
          and not exists (
            select 1
            from public.suppressions s
            where (s.kind = 'email' and nullif(btrim(l.email), '') is not null and lower(s.value) = lower(btrim(l.email)))
               or (s.kind = 'domain' and nullif(btrim(l.domain), '') is not null and lower(s.value) = lower(btrim(l.domain)))
          )
        )
      )
  )
  select
    f.id,
    f.company_id,
    f.role_level,
    f.first_name,
    f.last_name,
    f.title,
    f.email,
    f.email_status,
    f.final_first_name,
    f.final_title,
    f.final_company_name,
    f.operations_task,
    f.ops_candidate,
    f.personalization_updated_at,
    f.smartlead_campaign_id,
    f.smartlead_campaign_name,
    f.smartlead_export_status,
    f.smartlead_exported_at,
    f.smartlead_export_error,
    f.smartlead_lead_id,
    f.linkedin_url,
    f.company,
    f.domain,
    f.send_wave,
    f.shared_company,
    f.computed_lead_city,
    f.computed_lead_state,
    f.computed_lead_country,
    f.computed_suppression_reason,
    f.updated_at,
    count(*) over() as total_count
  from filtered f
  order by
    case when p_sort = 'contact' and coalesce(p_sort_dir, 'asc') = 'asc' then lower(coalesce(f.last_name, '')) end asc nulls last,
    case when p_sort = 'contact' and p_sort_dir = 'desc' then lower(coalesce(f.last_name, '')) end desc nulls last,
    case when p_sort = 'contact' and coalesce(p_sort_dir, 'asc') = 'asc' then lower(coalesce(f.first_name, '')) end asc nulls last,
    case when p_sort = 'contact' and p_sort_dir = 'desc' then lower(coalesce(f.first_name, '')) end desc nulls last,
    case when p_sort = 'company' and coalesce(p_sort_dir, 'asc') = 'asc' then lower(coalesce(f.company, '')) end asc nulls last,
    case when p_sort = 'company' and p_sort_dir = 'desc' then lower(coalesce(f.company, '')) end desc nulls last,
    case when p_sort = 'qualification' and coalesce(p_sort_dir, 'asc') = 'asc' then f.qualification_rank end asc nulls last,
    case when p_sort = 'qualification' and p_sort_dir = 'desc' then f.qualification_rank end desc nulls last,
    case when p_sort = 'email' and coalesce(p_sort_dir, 'asc') = 'asc' then lower(coalesce(f.email, '')) end asc nulls last,
    case when p_sort = 'email' and p_sort_dir = 'desc' then lower(coalesce(f.email, '')) end desc nulls last,
    case when p_sort in ('validate_email', 'email_status') and coalesce(p_sort_dir, 'asc') = 'asc' then f.email_status end asc nulls last,
    case when p_sort in ('validate_email', 'email_status') and p_sort_dir = 'desc' then f.email_status end desc nulls last,
    case when p_sort = 'final_first_name' and coalesce(p_sort_dir, 'asc') = 'asc' then lower(coalesce(f.final_first_name, '')) end asc nulls last,
    case when p_sort = 'final_first_name' and p_sort_dir = 'desc' then lower(coalesce(f.final_first_name, '')) end desc nulls last,
    case when p_sort = 'final_title' and coalesce(p_sort_dir, 'asc') = 'asc' then lower(coalesce(f.final_title, '')) end asc nulls last,
    case when p_sort = 'final_title' and p_sort_dir = 'desc' then lower(coalesce(f.final_title, '')) end desc nulls last,
    case when p_sort = 'final_company_name' and coalesce(p_sort_dir, 'asc') = 'asc' then lower(coalesce(f.final_company_name, '')) end asc nulls last,
    case when p_sort = 'final_company_name' and p_sort_dir = 'desc' then lower(coalesce(f.final_company_name, '')) end desc nulls last,
    case when p_sort = 'operations_task' and coalesce(p_sort_dir, 'asc') = 'asc' then lower(coalesce(f.operations_task, '')) end asc nulls last,
    case when p_sort = 'operations_task' and p_sort_dir = 'desc' then lower(coalesce(f.operations_task, '')) end desc nulls last,
    case when p_sort = 'ops_candidate' and coalesce(p_sort_dir, 'asc') = 'asc' then lower(coalesce(f.ops_candidate, '')) end asc nulls last,
    case when p_sort = 'ops_candidate' and p_sort_dir = 'desc' then lower(coalesce(f.ops_candidate, '')) end desc nulls last,
    case when p_sort = 'smartlead_export' and coalesce(p_sort_dir, 'asc') = 'asc' then f.smartlead_export_status end asc nulls last,
    case when p_sort = 'smartlead_export' and p_sort_dir = 'desc' then f.smartlead_export_status end desc nulls last,
    case when p_sort is null then f.send_wave end asc,
    case when p_sort is null and f.email_status is null then 0 when p_sort is null then 1 end asc,
    case when p_sort is null then f.company end asc nulls last,
    case when p_sort is null then f.role_level end asc nulls last,
    case when p_sort is null then f.last_name end asc nulls last,
    case when p_sort is null then f.first_name end asc nulls last,
    f.id asc
  limit greatest(1, least(coalesce(p_limit, 100), 500))
  offset greatest(0, coalesce(p_offset, 0));
end;
$$;

create or replace function public.enrichment_run_candidates(
  p_action text,
  p_mode text,
  p_limit integer,
  p_prompt_updated_at timestamptz default null
)
returns table (
  id uuid,
  company_id uuid,
  role_level text,
  first_name text,
  last_name text,
  title text,
  email text,
  email_status text,
  final_first_name text,
  final_title text,
  final_company_name text,
  operations_task text,
  ops_candidate text,
  personalization_updated_at timestamptz,
  smartlead_campaign_id text,
  smartlead_campaign_name text,
  smartlead_export_status text,
  smartlead_exported_at timestamptz,
  smartlead_export_error text,
  smartlead_lead_id text,
  linkedin_url text,
  company text,
  domain text,
  send_wave smallint,
  shared_company boolean,
  lead_city text,
  lead_state text,
  lead_country text,
  suppression_reason text,
  updated_at timestamptz,
  run_action text
)
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if p_action not in (
    'find_email', 'validate_email', 'final_first_name', 'final_title',
    'final_company_name', 'operations_task', 'ops_candidate', 'smartlead_export'
  ) then
    raise exception 'Unsupported enrichment action: %', p_action;
  end if;

  if p_mode not in ('test10', 'unrun', 'outdated', 'force') then
    raise exception 'Unsupported enrichment run mode: %', p_mode;
  end if;

  return query
  select
    l.id,
    l.company_id,
    l.role_level,
    l.first_name,
    l.last_name,
    l.title,
    l.email,
    l.email_status,
    l.final_first_name,
    l.final_title,
    l.final_company_name,
    l.operations_task,
    l.ops_candidate,
    l.personalization_updated_at,
    l.smartlead_campaign_id,
    l.smartlead_campaign_name,
    l.smartlead_export_status,
    l.smartlead_exported_at,
    l.smartlead_export_error,
    l.smartlead_lead_id,
    l.linkedin_url,
    l.company,
    l.domain,
    l.send_wave,
    l.shared_company,
    nullif(btrim(coalesce(l.raw->>'Lead City', '')), ''),
    nullif(btrim(coalesce(l.raw->>'Lead State', '')), ''),
    nullif(btrim(coalesce(l.raw->>'Lead Country', '')), ''),
    (
      select coalesce(nullif(btrim(s.reason), ''), 'Suppressed (' || s.kind || ')')
      from public.suppressions s
      where (s.kind = 'email' and nullif(btrim(l.email), '') is not null and lower(s.value) = lower(btrim(l.email)))
         or (s.kind = 'domain' and nullif(btrim(l.domain), '') is not null and lower(s.value) = lower(btrim(l.domain)))
      limit 1
    ),
    l.updated_at,
    p_action
  from public.leads l
  where l.send_wave is not null
    and l.company_id in (
      select segment_leads.company_id
      from public.leads segment_leads
      where segment_leads.send_wave is not null
      group by segment_leads.company_id
      having count(*) >= 2
    )
    and (
      case
        when p_mode = 'outdated' then
          -- Outdated = the column's PROMPT changed after the last successful
          -- run (Clay parity). Data-recency comparisons self-invalidate: every
          -- write bumps updated_at, flagging sibling columns forever.
          p_action in ('final_first_name', 'final_title', 'final_company_name', 'ops_candidate')
          and p_prompt_updated_at is not null
          and l.email_status = 'deliverable'
          and nullif(btrim(coalesce(
            case p_action
              when 'final_first_name' then l.final_first_name
              when 'final_title' then l.final_title
              when 'final_company_name' then l.final_company_name
              when 'ops_candidate' then l.ops_candidate
            end,
            ''
          )), '') is not null
          and coalesce(
            (
              select max(r.created_at)
              from public.lead_runs r
              where r.lead_id = l.id
                and r.action = 'personalization:' || p_action
                and r.ok
            ),
            '-infinity'::timestamptz
          ) < p_prompt_updated_at
        when p_action = 'find_email' then
          (nullif(btrim(l.email), '') is null or l.email_status = 'invalid')
          and nullif(btrim(l.first_name), '') is not null
          and nullif(btrim(l.last_name), '') is not null
          and nullif(btrim(l.domain), '') is not null
        when p_action = 'validate_email' then
          nullif(btrim(l.email), '') is not null
          and (p_mode = 'force' or l.email_status is null)
        when p_action = 'smartlead_export' then
          l.email_status = 'deliverable'
          and nullif(btrim(l.email), '') is not null
          and btrim(coalesce(l.raw->>'Lead Country', '')) in ('United States', 'United Kingdom', 'Canada', 'Australia')
          and l.title ~* '\m(operations?|opperations?|opertations?|operatons?|operational|operating|opérations?|opérationnel(?:le)?|exploitation|logistique|usine|ops|opex|manufacturing|production|plant|supply chain|logistics|warehouse|warehousing|factory|fulfil?lment|coo|chief operating|works manager|process improvement|process optimization|process excellence|continuous improvement|general manager)\M'
          and l.title !~* '\m(china|chinese|hong kong|apac|asia|asean|emea|europe|european|india|brazil|mexico|japan|korea|taiwan|vietnam|thailand|indonesia|philippines|malaysia|singapore|latam|latin america|middle east|mena|africa|turkey|russia|dach|benelux|nordics|iberia|france|germany|italy|spain|poland|portugal|greece|netherlands|uae|dubai|saudi arabia|israel)\M'
          and not exists (
            select 1
            from public.suppressions s
            where (s.kind = 'email' and nullif(btrim(l.email), '') is not null and lower(s.value) = lower(btrim(l.email)))
               or (s.kind = 'domain' and nullif(btrim(l.domain), '') is not null and lower(s.value) = lower(btrim(l.domain)))
          )
          and nullif(btrim(coalesce(l.final_first_name, '')), '') is not null
          and nullif(btrim(coalesce(l.final_title, '')), '') is not null
          and nullif(btrim(coalesce(l.final_company_name, '')), '') is not null
          and nullif(btrim(coalesce(l.operations_task, '')), '') is not null
          and nullif(btrim(coalesce(l.ops_candidate, '')), '') is not null
          and (p_mode = 'force' or l.smartlead_export_status is null or l.smartlead_export_status = 'failed')
        else
          l.email_status = 'deliverable'
          and (
            p_mode = 'force'
            or nullif(btrim(coalesce(
              case p_action
                when 'final_first_name' then l.final_first_name
                when 'final_title' then l.final_title
                when 'final_company_name' then l.final_company_name
                when 'operations_task' then l.operations_task
                when 'ops_candidate' then l.ops_candidate
              end,
              ''
            )), '') is null
          )
      end
    )
  order by
    l.send_wave asc,
    case when l.email_status is null then 0 else 1 end asc,
    l.company asc nulls last,
    l.role_level asc nulls last,
    l.last_name asc nulls last,
    l.first_name asc nulls last,
    l.id asc
  limit case
    when p_mode = 'test10' then least(greatest(coalesce(p_limit, 10), 1), 10)
    else least(greatest(coalesce(p_limit, 5000), 1), 5000)
  end;
end;
$$;

create or replace function public.enrichment_segment_stats()
returns table (
  total_leads integer,
  companies integer,
  managers integer,
  directors integer,
  wave_1 integer,
  wave_2 integer,
  shared_company integer,
  known_email integer,
  missing_email integer,
  pending_validation integer,
  deliverable integer,
  risky integer,
  invalid integer
)
language sql
security invoker
set search_path = ''
as $$
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
$$;

create or replace function public.enrichment_filter_options()
returns table (
  role_levels text[],
  email_statuses text[],
  countries text[]
)
language sql
security invoker
set search_path = ''
as $$
  with segment as (
    select l.*
    from public.leads l
    where l.send_wave is not null
      and l.company_id in (
        select segment_leads.company_id
        from public.leads segment_leads
        where segment_leads.send_wave is not null
        group by segment_leads.company_id
        having count(*) >= 2
      )
  )
  select
    array(
      select distinct coalesce(s.role_level, 'unknown')
      from segment s
      order by 1
    )::text[] as role_levels,
    array(
      select distinct coalesce(s.email_status, 'unknown')
      from segment s
      order by 1
    )::text[] as email_statuses,
    array(
      select country_counts.lead_country
      from (
        select nullif(btrim(coalesce(s.raw->>'Lead Country', '')), '') as lead_country, count(*)::integer as country_count
        from segment s
        group by 1
      ) country_counts
      where country_counts.lead_country is not null
      order by country_counts.country_count desc, country_counts.lead_country asc
    )::text[] as countries;
$$;

create or replace function public.enrichment_coworker(p_lead_id uuid)
returns table (
  first_name text,
  role_level text
)
language sql
security invoker
set search_path = ''
as $$
  with target as (
    select target_lead.id, target_lead.company_id, target_lead.role_level
    from public.leads target_lead
    where target_lead.id = p_lead_id
    limit 1
  )
  select coworker.first_name, coworker.role_level
  from public.leads coworker
  join target on target.company_id = coworker.company_id
  where coworker.id <> target.id
    and coworker.send_wave is not null
    and nullif(btrim(coworker.first_name), '') is not null
  order by
    case
      when target.role_level = 'manager' and coworker.role_level = 'director' then 0
      when target.role_level = 'director' and coworker.role_level = 'manager' then 0
      when coworker.role_level <> target.role_level then 1
      else 2
    end,
    coworker.role_level asc nulls last,
    coworker.first_name asc
  limit 1;
$$;

create or replace function public.enrichment_commit_writeback(
  p_lead_id uuid,
  p_column text,
  p_value text,
  p_expected_updated_at timestamptz,
  p_run_id text,
  p_provider text,
  p_message text,
  p_details jsonb
)
returns text
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_action text;
  v_log_id uuid;
  v_updated integer;
begin
  if p_column not in (
    'final_first_name', 'final_title', 'final_company_name',
    'operations_task', 'ops_candidate', 'email', 'email_status'
  ) then
    raise exception 'Unsupported enrichment writeback column: %', p_column;
  end if;

  if nullif(btrim(p_run_id), '') is null then
    raise exception 'Enrichment writeback run_id is required';
  end if;

  if not exists (select 1 from public.leads l where l.id = p_lead_id) then
    return 'not_found';
  end if;

  v_action := case
    when p_column = 'email' then 'find_email'
    when p_column = 'email_status' then 'validate_email'
    else 'personalization:' || p_column
  end;

  insert into public.lead_runs (lead_id, action, provider, ok, message, details)
  values (
    p_lead_id,
    v_action,
    p_provider,
    false,
    p_message,
    coalesce(p_details, '{}'::jsonb) || jsonb_build_object(
      'run_id', p_run_id,
      'column', p_column
    )
  )
  on conflict do nothing
  returning id into v_log_id;

  if v_log_id is null then
    return 'duplicate';
  end if;

  -- personalization_updated_at moves only for personalization columns;
  -- email writes must not mark the AI columns as freshly personalized.
  execute format(
    'update public.leads set %I = $1, updated_at = now()%s where id = $2 and updated_at = $3',
    p_column,
    case
      when p_column in ('final_first_name', 'final_title', 'final_company_name', 'operations_task', 'ops_candidate')
        then ', personalization_updated_at = now()'
      else ''
    end
  )
  using p_value, p_lead_id, p_expected_updated_at;

  get diagnostics v_updated = row_count;

  if v_updated = 0 then
    update public.lead_runs
    set details = coalesce(details, '{}'::jsonb) || jsonb_build_object('outcome', 'stale')
    where id = v_log_id;
    return 'stale';
  end if;

  update public.lead_runs
  set
    ok = true,
    details = coalesce(details, '{}'::jsonb) || jsonb_build_object('outcome', 'written')
  where id = v_log_id;

  return 'written';
end;
$$;

revoke execute on function public.enrichment_leads_page(integer, integer, text, text[], text[], text[], boolean, boolean, text, text) from public, anon, authenticated;
revoke execute on function public.enrichment_run_candidates(text, text, integer, timestamptz) from public, anon, authenticated;
revoke execute on function public.enrichment_segment_stats() from public, anon, authenticated;
revoke execute on function public.enrichment_filter_options() from public, anon, authenticated;
revoke execute on function public.enrichment_coworker(uuid) from public, anon, authenticated;
revoke execute on function public.enrichment_commit_writeback(uuid, text, text, timestamptz, text, text, text, jsonb) from public, anon, authenticated;

grant execute on function public.enrichment_leads_page(integer, integer, text, text[], text[], text[], boolean, boolean, text, text) to service_role;
grant execute on function public.enrichment_run_candidates(text, text, integer, timestamptz) to service_role;
grant execute on function public.enrichment_segment_stats() to service_role;
grant execute on function public.enrichment_filter_options() to service_role;
grant execute on function public.enrichment_coworker(uuid) to service_role;
grant execute on function public.enrichment_commit_writeback(uuid, text, text, timestamptz, text, text, text, jsonb) to service_role;
