-- 052: Analytics counts PEOPLE, not messages.
--
-- crm_analytics_drill_count backed every KPI tile with count(*) over reply_events,
-- so one lead replying five times read as five replies and — if those reads were
-- positive — five positive leads. That is actively deceptive at a glance: the
-- headline implied five interested people where there was one.
--
-- Count distinct repliers instead. The per-message records are untouched: the
-- drill-down list and the lead detail panel still show every individual reply,
-- which is where repeat replies belong.
--
-- Identity: lead_id when the sender is linked to a CRM row. lead_id is NULLABLE
-- (a replier with no lead row), and a bare count(distinct e.lead_id) would drop
-- those rows entirely — undercounting real people. Fall back to the sender
-- address, then the event id, so every replier counts exactly once. Mirrors
-- personKey() in getAnalyticsData (src/lib/replies/queries.ts); the two must
-- agree or verify-crm's tile==drill assertion fails.
--
-- sent_from_inbox is deliberately NOT converted: it counts replies WE sent, an
-- outbound activity volume, not a claim about how many people are interested.
--
-- metric_eligible is preserved exactly as before — imported/untracked replies
-- stay out of every metric.

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
  select count(distinct coalesce(
           e.lead_id::text,
           case when btrim(coalesce(e.from_email,''))<>'' then 'email:'||lower(btrim(e.from_email)) end,
           'event:'||e.id::text
         )) into v_count
  from public.reply_events e
  left join lateral (
    select q.* from public.reply_proposals q where q.reply_event_id=e.id
    order by q.created_at desc,q.id desc limit 1
  ) q on true
  where e.metric_eligible
    and coalesce(e.received_at,e.created_at)>=p_from and coalesce(e.received_at,e.created_at)<=p_to
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

notify pgrst, 'reload schema';
