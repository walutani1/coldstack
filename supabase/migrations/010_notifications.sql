-- Notification channels: where to announce freshly categorized replies.
-- Routing (targets, category filters) lives here and is managed in-app;
-- transport credentials (SMTP / Resend API key) stay in environment vars.
create table if not exists notification_channels (
  id uuid primary key default gen_random_uuid(),
  channel_type text not null check (channel_type in ('email', 'slack')),
  label text,
  -- Email address or Slack incoming-webhook URL, depending on channel_type.
  target text not null,
  -- Category values (taxonomy) this channel cares about; null = all replies.
  categories text[],
  enabled boolean not null default true,
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table notification_channels enable row level security;

-- Delivery audit: one row per attempted send, surfaced in Settings so a
-- silently broken webhook or mail transport is visible without log access.
create table if not exists notification_deliveries (
  id uuid primary key default gen_random_uuid(),
  channel_id uuid not null references notification_channels(id) on delete cascade,
  proposal_id uuid,
  kind text not null default 'reply' check (kind in ('reply', 'test')),
  status text not null check (status in ('sent', 'failed')),
  error text,
  created_at timestamptz not null default now()
);

alter table notification_deliveries enable row level security;

create index if not exists notification_deliveries_channel_idx
  on notification_deliveries (channel_id, created_at desc);

create index if not exists notification_deliveries_created_idx
  on notification_deliveries (created_at desc);
