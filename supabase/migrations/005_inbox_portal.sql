-- Coldstack portal foundation on the shared Supabase project.
-- Adds: per-user access allowlist, reply-send audit trail (idempotent sends),
-- and a reason tag for DNC actions so "hostile" and "dead mailbox" stay distinct.

-- Access allowlist. Auth users exist already (shared with the sales app);
-- a row here with is_active = true is what grants Coldstack access.
create table if not exists inbox_profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text not null unique,
  full_name text,
  is_active boolean not null default false,
  created_at timestamptz not null default now()
);

alter table inbox_profiles enable row level security;

drop policy if exists "inbox_profiles_read_own" on inbox_profiles;
create policy "inbox_profiles_read_own"
  on inbox_profiles for select to authenticated
  using (auth.uid() = id);

-- No company-specific members are seeded. On a fresh installation, the
-- operator must create the first active member with:
--   node scripts/bootstrap-admin.mjs you@example.com "Full Name"
-- Existing deployments retain any profiles created by earlier applications
-- of this idempotent migration.

-- Why the block-list action fired: 'explicit_request' (remove me / hostile)
-- vs 'email_defunct' (mailbox dead / person left — block just that address).
alter table reply_proposals add column if not exists dnc_reason text;
alter table reply_proposals add column if not exists resolved_by text;

-- One row per attempted outbound reply from the inbox. idempotency_key is
-- unique so a double-click or retried request can never send twice.
create table if not exists reply_sends (
  id uuid primary key default gen_random_uuid(),
  reply_event_id uuid,
  proposal_id uuid,
  lead_id uuid,
  campaign_id text,
  smartlead_lead_id text,
  to_email text not null,
  body text not null,
  sent_by text,
  idempotency_key text not null unique,
  status text not null default 'sending' check (status in ('sending', 'sent', 'failed')),
  error text,
  smartlead_response jsonb,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create index if not exists reply_sends_event_idx on reply_sends (reply_event_id, created_at desc);

-- Service-role only (no policies): the deployed app talks to this table
-- exclusively through server-side code.
alter table reply_sends enable row level security;
