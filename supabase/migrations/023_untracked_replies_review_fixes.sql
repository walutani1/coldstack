create or replace function public.claim_untracked_replies(p_limit integer default 25)
returns setof public.untracked_replies
language sql security invoker set search_path = '' as $$
  with candidates as (
    select u.id, u.status = 'processing' as is_stale
    from public.untracked_replies u
    where (
      (u.status='new' and (u.next_attempt_at is null or u.next_attempt_at <= now()))
      or (u.status='processing' and u.process_started_at < now() - interval '10 minutes')
    )
    order by u.first_seen_at, u.id
    for update skip locked
    limit least(greatest(coalesce(p_limit,25),1),100)
  ), exhausted as (
    update public.untracked_replies u
    set status='error', attempt_count=u.attempt_count+1, process_started_at=null,
        next_attempt_at=null, last_error='stale claim limit'
    from candidates c
    where u.id=c.id and c.is_stale and u.attempt_count+1 > 3
    returning u.id
  )
  update public.untracked_replies u
  set status='processing', process_started_at=now(), last_error=null,
      attempt_count=case when c.is_stale then u.attempt_count+1 else u.attempt_count end
  from candidates c
  where u.id=c.id and not exists (select 1 from exhausted e where e.id=c.id)
  returning u.*;
$$;

revoke execute on function public.claim_untracked_replies(integer) from public, anon, authenticated;
grant execute on function public.claim_untracked_replies(integer) to service_role;

create or replace function public.import_untracked_reply(
  p_staging_id uuid,
  p_chosen_lead_id uuid,
  p_chosen_campaign_id text,
  p_new_contact jsonb,
  p_reviewer_email text
)
returns table(event_id uuid, lead_id uuid)
language plpgsql security invoker set search_path = '' as $$
declare
  v_staging public.untracked_replies%rowtype;
  v_lead_id uuid := p_chosen_lead_id;
  v_event_id uuid;
  v_email text;
begin
  select * into v_staging
  from public.untracked_replies
  where id=p_staging_id and status in ('suggested','possible_match','unmatched')
  for update;
  if not found then
    raise exception 'Untracked reply is not eligible for import';
  end if;

  update public.untracked_replies set status='importing' where id=v_staging.id;

  if v_lead_id is not null and not exists(select 1 from public.leads l where l.id=v_lead_id) then
    raise exception 'Chosen lead does not exist';
  end if;

  if v_lead_id is null and p_new_contact is not null then
    v_email := lower(nullif(btrim(coalesce(p_new_contact->>'email',v_staging.from_email)),''));
    if v_email is null then raise exception 'New contact email is required'; end if;

    select l.id into v_lead_id
    from public.leads l
    where lower(l.email)=v_email
    order by l.id
    limit 1;

    if v_lead_id is null then
      insert into public.leads(
        role_level, first_name, last_name, email, company, domain, source, raw
      ) values (
        'manager', nullif(btrim(p_new_contact->>'first_name'),''),
        nullif(btrim(p_new_contact->>'last_name'),''), v_email,
        nullif(btrim(p_new_contact->>'company'),''),
        nullif(btrim(coalesce(p_new_contact->>'domain',split_part(v_email,'@',2))),''),
        'smartlead_untracked_import',
        jsonb_build_object('source','smartlead_untracked_import','staging_id',v_staging.id)
      ) returning id into v_lead_id;
    end if;
  end if;

  insert into public.reply_events(
    smartlead_message_id, smartlead_lead_id, lead_id, campaign_id, campaign_name,
    from_email, to_email, subject, body, smartlead_category, raw, status,
    received_at, source, source_ref, metric_eligible
  ) values (
    'untracked:'||v_staging.provider_reply_id, null, v_lead_id, p_chosen_campaign_id,
    case when v_lead_id is not null and p_chosen_campaign_id is not null then
      (select l.smartlead_campaign_name from public.leads l
       where l.id=v_lead_id and l.smartlead_campaign_id=p_chosen_campaign_id)
    else null end,
    v_staging.from_email, v_staging.to_email, v_staging.subject, v_staging.body_text,
    null, v_staging.raw, 'received',
    coalesce(v_staging.provider_received_at,v_staging.first_seen_at),
    'smartlead_untracked_import', v_staging.id, false
  ) returning id into v_event_id;

  update public.untracked_replies
  set status='imported', imported_reply_event_id=v_event_id, reviewed_by=p_reviewer_email,
      reviewed_at=now(), suggested_lead_id=v_lead_id,
      suggested_campaign_id=p_chosen_campaign_id, last_error=null
  where id=v_staging.id;

  return query select v_event_id,v_lead_id;
end;
$$;

revoke execute on function public.import_untracked_reply(uuid,uuid,text,jsonb,text) from public, anon, authenticated;
grant execute on function public.import_untracked_reply(uuid,uuid,text,jsonb,text) to service_role;

create or replace function public.crm_leads_page(
  p_limit integer, p_offset integer, p_search text, p_campaign_ids text[],
  p_campaigns_exclude text[], p_replied boolean, p_sentiment_types text[],
  p_categories text[], p_referral boolean, p_dnc boolean, p_dnc_reasons text[],
  p_dnc_approved_only boolean, p_proposal_statuses text[],
  p_reply_from timestamptz, p_reply_to timestamptz,
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
        where r.lead_id=m.id and r.metric_eligible
          and (p_reply_from is null or coalesce(r.received_at,r.created_at)>=p_reply_from)
          and (p_reply_to is null or coalesce(r.received_at,r.created_at)<=p_reply_to)
      ) as has_reply,
      exists (
        select 1 from public.reply_events r
        join lateral (
          select q.* from public.reply_proposals q where q.reply_event_id=r.id
          order by q.created_at desc,q.id desc limit 1
        ) q on true
        where r.lead_id=m.id and r.metric_eligible and q.sentiment_type='positive'
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
        or exists (select 1 from public.reply_events rc where rc.lead_id=d.id and rc.metric_eligible and rc.campaign_id=any(p_campaign_ids)))
      and (p_campaigns_exclude is null or cardinality(p_campaigns_exclude)=0 or (
        (coalesce(d.export_campaign_id,d.smartlead_campaign_id) is null
          or not (coalesce(d.export_campaign_id,d.smartlead_campaign_id)=any(p_campaigns_exclude)))
        and not exists (
          select 1 from public.reply_events rc
          where rc.lead_id=d.id and rc.metric_eligible and rc.campaign_id=any(p_campaigns_exclude)
        )
      ))
      and (p_replied is null or d.has_reply=p_replied)
      and ((p_reply_from is null and p_reply_to is null) or d.has_reply)
      and (p_exported_from is null or d.newest_exported_at>=p_exported_from)
      and (p_exported_to is null or d.newest_exported_at<=p_exported_to)
      and (p_sentiment_types is null or cardinality(p_sentiment_types)=0
        or d.newest_sentiment=any(p_sentiment_types))
      and (p_categories is null or cardinality(p_categories)=0
        or lower(btrim(coalesce(d.newest_category,'')))=any(p_categories))
      and (
        (p_referral is null and p_dnc is null
          and (p_dnc_reasons is null or cardinality(p_dnc_reasons)=0)
          and (p_proposal_statuses is null or cardinality(p_proposal_statuses)=0)
          and not coalesce(p_dnc_approved_only,false))
        or exists (
          select 1 from public.reply_events r
          join lateral (
            select q.* from public.reply_proposals q where q.reply_event_id=r.id
            order by q.created_at desc,q.id desc limit 1
          ) q on true
          where r.lead_id=d.id and r.metric_eligible
            and (p_reply_from is null or coalesce(r.received_at,r.created_at)>=p_reply_from)
            and (p_reply_to is null or coalesce(r.received_at,r.created_at)<=p_reply_to)
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

revoke execute on function public.crm_leads_page(integer,integer,text,text[],text[],boolean,text[],text[],boolean,boolean,text[],boolean,text[],timestamptz,timestamptz,timestamptz,timestamptz,text,text,text[]) from public, anon, authenticated;
grant execute on function public.crm_leads_page(integer,integer,text,text[],text[],boolean,text[],text[],boolean,boolean,text[],boolean,text[],timestamptz,timestamptz,timestamptz,timestamptz,text,text,text[]) to service_role;
