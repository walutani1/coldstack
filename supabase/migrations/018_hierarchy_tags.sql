alter table public.enrichment_folders
  add column smartlead_campaign_id text,
  add column smartlead_campaign_name text,
  add constraint enrichment_folders_smartlead_campaign_pair_check
    check ((smartlead_campaign_id is null) = (smartlead_campaign_name is null));

alter table public.enrichment_workbooks
  add column smartlead_campaign_id text,
  add column smartlead_campaign_name text,
  add constraint enrichment_workbooks_smartlead_campaign_pair_check
    check ((smartlead_campaign_id is null) = (smartlead_campaign_name is null));
