create table if not exists campaign_settings (
  campaign_id text primary key,
  overrides jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  updated_by text
);

alter table campaign_settings enable row level security;

alter table notification_channels
  add column if not exists campaign_ids text[];
