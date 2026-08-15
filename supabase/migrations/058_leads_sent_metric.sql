-- 058: "Leads sent" analytics count over enrichment_table_exports.
--
-- The global analytics view grows a send-volume section (emails sent per day,
-- unique contacts, leads pushed into campaigns). Emails and unique contacts
-- come from Smartlead; "leads sent" is ours: a row in enrichment_table_exports
-- with status = 'exported' is the local source of truth for "this lead was
-- pushed into that campaign" (crm_leads_page already ranks it above the
-- denormalized leads.smartlead_* columns).
--
-- Semantics, stated so the tile copy can be honest:
--   * exported_at is the LATEST push. Both the export runner and the variable
--     refresh path upsert exported_at = now() (runners.ts), so a lead first
--     pushed in May and refreshed in July counts in July's window, not May's.
--     The count reads "leads whose latest push falls in the window".
--   * status = 'removed' rows are excluded. The remove action overwrites
--     exported_at with the removal time (prospects/actions.ts), so including
--     them would attribute the push to the wrong day; the original push date
--     is not recoverable from this table.
--   * status = 'failed' rows never reached the campaign and are excluded.
--   * lead_id is distinct-counted across campaigns: one person pushed into
--     two campaigns is ONE lead sent (mirrors 052's people-not-messages rule).
--     The per-campaign filter still uses campaign_id, so an include-filtered
--     count is exact for those campaigns.
--
-- p_from / p_to may be null for an all-time count (the tile shows the window,
-- its hint shows all-time). Campaign filter grammar copies
-- crm_analytics_drill_count (052): mode null | 'include' | 'exclude' over
-- text campaign ids; campaign_id here is not null by schema.

create or replace function public.analytics_leads_sent_count(
  p_from timestamptz, p_to timestamptz,
  p_campaign_mode text, p_campaign_ids text[]
)
returns bigint language plpgsql security invoker set search_path = '' as $$
declare v_count bigint;
begin
  if p_campaign_mode is not null and p_campaign_mode not in ('include','exclude') then
    raise exception 'Unsupported campaign filter mode: %',p_campaign_mode;
  end if;
  select count(distinct e.lead_id) into v_count
  from public.enrichment_table_exports e
  where e.status='exported'
    and (p_from is null or e.exported_at>=p_from)
    and (p_to is null or e.exported_at<=p_to)
    and (p_campaign_mode is null
      or (p_campaign_mode='include' and e.campaign_id=any(p_campaign_ids))
      or (p_campaign_mode='exclude' and not (e.campaign_id=any(p_campaign_ids))));
  return v_count;
end;
$$;

revoke execute on function public.analytics_leads_sent_count(timestamptz,timestamptz,text,text[]) from public, anon, authenticated;
grant execute on function public.analytics_leads_sent_count(timestamptz,timestamptz,text,text[]) to service_role;

notify pgrst, 'reload schema';
