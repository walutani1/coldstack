create index if not exists enrichment_table_exports_lead_status_exported_idx
  on public.enrichment_table_exports (lead_id, status, exported_at desc);

create index if not exists reply_events_lead_received_id_idx
  on public.reply_events (lead_id, received_at desc, id desc)
  where lead_id is not null;

create index if not exists reply_proposals_event_created_id_idx
  on public.reply_proposals (reply_event_id, created_at desc, id desc);

create or replace function public.crm_leads_page(
  p_limit integer, p_offset integer, p_search text, p_campaign_ids text[],
  p_replied boolean, p_sentiment_types text[], p_categories text[], p_referral boolean,
  p_dnc boolean, p_dnc_reasons text[], p_dnc_approved_only boolean,
  p_proposal_statuses text[], p_reply_from timestamptz, p_reply_to timestamptz,
  p_exported_from timestamptz, p_exported_to timestamptz,
  p_sort text, p_sort_dir text, p_membership text[]
)
returns table (
  id uuid, first_name text, last_name text, title text, company text, domain text,
  email text, linkedin_url text, lead_country text, membership_source text,
  campaign_id text, campaign_name text, exported_at timestamptz,
  smartlead_lead_id text, last_reply_at timestamptz, last_reply_event_id uuid,
  last_reply_category text, last_reply_sentiment_type text, replied boolean,
  positive_any boolean, total_count bigint
)
language plpgsql security invoker set search_path = '' as $$
begin
  if coalesce(p_sort, 'last_reply_at') not in ('name','company','exported_at','last_reply_at') then
    raise exception 'Unsupported CRM lead sort: %', p_sort;
  end if;
  if coalesce(p_sort_dir, 'desc') not in ('asc','desc') then
    raise exception 'Unsupported CRM lead sort direction: %', p_sort_dir;
  end if;

  return query
  with members as (
    select l.*,
      case
        when exists (select 1 from public.enrichment_table_exports x where x.lead_id=l.id and x.status='exported') then 'exported'
        when l.smartlead_lead_id is not null then 'legacy'
        else 'reply_only'
      end as member_source
    from public.leads l
    where exists (select 1 from public.enrichment_table_exports x where x.lead_id=l.id and x.status='exported')
       or l.smartlead_lead_id is not null
       or exists (select 1 from public.reply_events re where re.lead_id=l.id)
  ), decorated as (
    select m.*,
      nullif(btrim(coalesce(m.raw->>'Lead Country','')), '') as computed_country,
      ex.campaign_id as export_campaign_id, ex.campaign_name as export_campaign_name,
      ex.exported_at as newest_exported_at,
      nr.id as newest_reply_id, coalesce(nr.received_at,nr.created_at) as newest_reply_at,
      np.sentiment as newest_category, np.sentiment_type as newest_sentiment,
      exists (
        select 1 from public.reply_events r
        where r.lead_id=m.id
          and (p_reply_from is null or coalesce(r.received_at,r.created_at)>=p_reply_from)
          and (p_reply_to is null or coalesce(r.received_at,r.created_at)<=p_reply_to)
      ) as has_reply,
      exists (
        select 1 from public.reply_events r
        join lateral (
          select q.* from public.reply_proposals q where q.reply_event_id=r.id
          order by q.created_at desc,q.id desc limit 1
        ) q on true
        where r.lead_id=m.id and q.sentiment_type='positive'
          and (p_reply_from is null or coalesce(r.received_at,r.created_at)>=p_reply_from)
          and (p_reply_to is null or coalesce(r.received_at,r.created_at)<=p_reply_to)
      ) as has_positive
    from members m
    left join lateral (
      select x.campaign_id,x.campaign_name,x.exported_at
      from public.enrichment_table_exports x
      where x.lead_id=m.id and x.status='exported'
      order by x.exported_at desc,x.id desc limit 1
    ) ex on true
    left join lateral (
      select r.id,r.received_at,r.created_at
      from public.reply_events r where r.lead_id=m.id
      order by coalesce(r.received_at,r.created_at) desc,r.id desc limit 1
    ) nr on true
    left join lateral (
      select q.sentiment,q.sentiment_type
      from public.reply_proposals q where q.reply_event_id=nr.id
      order by q.created_at desc,q.id desc limit 1
    ) np on true
  ), filtered as (
    select d.* from decorated d
    where (p_search is null or btrim(p_search)='' or
      lower(coalesce(d.first_name,'')) like '%'||lower(p_search)||'%' escape '\' or
      lower(coalesce(d.last_name,'')) like '%'||lower(p_search)||'%' escape '\' or
      lower(coalesce(d.email,'')) like '%'||lower(p_search)||'%' escape '\' or
      lower(coalesce(d.company,'')) like '%'||lower(p_search)||'%' escape '\' or
      lower(coalesce(d.domain,'')) like '%'||lower(p_search)||'%' escape '\')
      and (p_membership is null or cardinality(p_membership)=0 or d.member_source=any(p_membership))
      and (p_campaign_ids is null or cardinality(p_campaign_ids)=0
        or coalesce(d.export_campaign_id,d.smartlead_campaign_id)=any(p_campaign_ids)
        -- a reply captured in a selected campaign also counts as membership,
        -- so drill deep-links never drop reply-only rows the modal showed
        or exists (select 1 from public.reply_events rc where rc.lead_id=d.id and rc.campaign_id=any(p_campaign_ids)))
      and (p_replied is null or d.has_reply=p_replied)
      -- the reply window is a predicate on its own: without it a bare
      -- "last N days" filter (or a kindless days deep link) was a no-op
      and ((p_reply_from is null and p_reply_to is null) or d.has_reply)
      and (p_exported_from is null or d.newest_exported_at>=p_exported_from)
      and (p_exported_to is null or d.newest_exported_at<=p_exported_to)
      and (
        (p_sentiment_types is null or cardinality(p_sentiment_types)=0) and
        (p_categories is null or cardinality(p_categories)=0) and p_referral is null and p_dnc is null and
        (p_dnc_reasons is null or cardinality(p_dnc_reasons)=0) and
        (p_proposal_statuses is null or cardinality(p_proposal_statuses)=0) and not coalesce(p_dnc_approved_only,false)
        or exists (
          select 1 from public.reply_events r
          join lateral (
            select q.* from public.reply_proposals q where q.reply_event_id=r.id
            order by q.created_at desc,q.id desc limit 1
          ) q on true
          where r.lead_id=d.id
            and (p_reply_from is null or coalesce(r.received_at,r.created_at)>=p_reply_from)
            and (p_reply_to is null or coalesce(r.received_at,r.created_at)<=p_reply_to)
            and (p_sentiment_types is null or cardinality(p_sentiment_types)=0 or q.sentiment_type=any(p_sentiment_types))
            and (p_categories is null or cardinality(p_categories)=0 or lower(btrim(coalesce(q.sentiment,'')))=any(p_categories))
            and (p_referral is null or q.is_referral=p_referral)
            and (p_dnc is null or q.action_dnc=p_dnc)
            and (p_dnc_reasons is null or cardinality(p_dnc_reasons)=0 or q.dnc_reason=any(p_dnc_reasons))
            and (not coalesce(p_dnc_approved_only,false) or q.status='approved')
            and (p_proposal_statuses is null or cardinality(p_proposal_statuses)=0 or q.status=any(p_proposal_statuses))
        )
      )
  )
  select f.id,f.first_name,f.last_name,f.title,f.company,f.domain,f.email,f.linkedin_url,
    f.computed_country,f.member_source,
    coalesce(f.export_campaign_id,f.smartlead_campaign_id),coalesce(f.export_campaign_name,f.smartlead_campaign_name),
    f.newest_exported_at,f.smartlead_lead_id,f.newest_reply_at,f.newest_reply_id,
    f.newest_category,f.newest_sentiment,f.has_reply,f.has_positive,count(*) over()
  from filtered f
  order by
    case when coalesce(p_sort,'last_reply_at')='name' and coalesce(p_sort_dir,'desc')='asc' then lower(coalesce(f.last_name,'')) end asc,
    case when coalesce(p_sort,'last_reply_at')='name' and p_sort_dir='desc' then lower(coalesce(f.last_name,'')) end desc,
    case when p_sort='company' and p_sort_dir='asc' then lower(coalesce(f.company,'')) end asc,
    case when p_sort='company' and p_sort_dir='desc' then lower(coalesce(f.company,'')) end desc,
    case when p_sort='exported_at' and p_sort_dir='asc' then f.newest_exported_at end asc nulls last,
    case when p_sort='exported_at' and p_sort_dir='desc' then f.newest_exported_at end desc nulls last,
    case when coalesce(p_sort,'last_reply_at')='last_reply_at' and p_sort_dir='asc' then f.newest_reply_at end asc nulls last,
    case when coalesce(p_sort,'last_reply_at')='last_reply_at' and coalesce(p_sort_dir,'desc')='desc' then f.newest_reply_at end desc nulls last,
    f.id
  limit least(greatest(coalesce(p_limit,50),1),100) offset greatest(coalesce(p_offset,0),0);
end;
$$;

revoke execute on function public.crm_leads_page(integer,integer,text,text[],boolean,text[],text[],boolean,boolean,text[],boolean,text[],timestamptz,timestamptz,timestamptz,timestamptz,text,text,text[]) from public, anon, authenticated;
grant execute on function public.crm_leads_page(integer,integer,text,text[],boolean,text[],text[],boolean,boolean,text[],boolean,text[],timestamptz,timestamptz,timestamptz,timestamptz,text,text,text[]) to service_role;

create or replace function public.crm_analytics_drill_count(
  p_kind text, p_from timestamptz, p_to timestamptz,
  p_campaign_mode text, p_campaign_ids text[], p_ooo_labels text[]
)
returns bigint language plpgsql security invoker set search_path = '' as $$
declare v_count bigint;
begin
  if p_kind not in ('replies','positive','referrals','awaiting_review','ooo','dnc_asked','dnc_defunct','sent_from_inbox') then
    raise exception 'Unsupported analytics drill kind: %',p_kind;
  end if;
  if p_campaign_mode is not null and p_campaign_mode not in ('include','exclude') then
    raise exception 'Unsupported campaign filter mode: %',p_campaign_mode;
  end if;
  if p_kind='sent_from_inbox' then
    select count(*) into v_count from public.reply_sends s
    where s.status='sent' and s.created_at>=p_from
      and (p_campaign_mode is null
        or (p_campaign_mode='include' and s.campaign_id is not null and s.campaign_id=any(p_campaign_ids))
        or (p_campaign_mode='exclude' and (s.campaign_id is null or not (s.campaign_id=any(p_campaign_ids)))));
    return v_count;
  end if;
  select count(*) into v_count
  from public.reply_events e
  left join lateral (
    select q.* from public.reply_proposals q where q.reply_event_id=e.id
    order by q.created_at desc,q.id desc limit 1
  ) q on true
  where coalesce(e.received_at,e.created_at)>=p_from and coalesce(e.received_at,e.created_at)<=p_to
    and (p_campaign_mode is null
      or (p_campaign_mode='include' and e.campaign_id is not null and e.campaign_id=any(p_campaign_ids))
      or (p_campaign_mode='exclude' and (e.campaign_id is null or not (e.campaign_id=any(p_campaign_ids)))))
    and (p_kind='replies'
      or (p_kind='positive' and q.sentiment_type='positive')
      or (p_kind='referrals' and q.is_referral)
      or (p_kind='awaiting_review' and q.status='pending')
      or (p_kind='ooo' and lower(btrim(coalesce(q.sentiment,'')))=any(p_ooo_labels))
      or (p_kind='dnc_asked' and q.action_dnc and q.status='approved' and q.dnc_reason is distinct from 'email_defunct')
      or (p_kind='dnc_defunct' and q.action_dnc and q.status='approved' and q.dnc_reason='email_defunct'));
  return v_count;
end;
$$;

revoke execute on function public.crm_analytics_drill_count(text,timestamptz,timestamptz,text,text[],text[]) from public, anon, authenticated;
grant execute on function public.crm_analytics_drill_count(text,timestamptz,timestamptz,text,text[],text[]) to service_role;
