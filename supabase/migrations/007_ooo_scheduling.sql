-- Out-of-office automation: pure OOO replies are auto-handled (no approval) —
-- the lead is paused in Smartlead and a resume is scheduled for
-- return date + 2 business days (or +10 days when no date is stated).

alter table reply_proposals add column if not exists ooo_return_date date;

create table if not exists scheduled_actions (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('resume_lead')),
  lead_id uuid,
  reply_event_id uuid,
  proposal_id uuid,
  campaign_id text,
  smartlead_lead_id text,
  lead_email text not null,
  due_at timestamptz not null,
  status text not null default 'scheduled' check (status in ('scheduled', 'done', 'canceled', 'failed')),
  note text,
  created_at timestamptz not null default now(),
  executed_at timestamptz
);

create index if not exists scheduled_actions_due_idx on scheduled_actions (status, due_at);
create index if not exists scheduled_actions_email_idx on scheduled_actions (lead_email, status);

-- Service-role only (no client policies).
alter table scheduled_actions enable row level security;
