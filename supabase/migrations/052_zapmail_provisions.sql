-- 052: durable Zapmail provisioning pipeline.
--
-- A provision batch records the operator's intent when inboxes are created (or
-- adopted): the profile image to apply, whether to auto-export to Smartlead and
-- with which linked account, and the planned inbox emails. The cron watcher
-- advances each batch server-side (activation can take ~2h and must survive the
-- wizard tab closing): pending -> active -> imaged -> exported -> configured
-- (Smartlead warmup/limit defaults applied) -> review (human approves in the
-- Inboxes tab) -> complete. One Slack message per batch, never per inbox.

create table if not exists public.zapmail_provisions (
  id uuid primary key default gen_random_uuid(),
  provider text not null default 'GOOGLE',
  status text not null default 'watching'
    check (status in ('watching', 'exporting', 'configuring', 'review', 'complete', 'expired', 'error')),
  image_url text,
  -- Zapmail third-party account id to export through; null = do not export.
  export_account_id text,
  export_id integer,
  notify boolean not null default true,
  notified_at timestamptz,
  -- Past the deadline the watcher exports whatever is active and flags the rest.
  deadline_at timestamptz not null default (now() + interval '48 hours'),
  error text,
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.zapmail_provision_items (
  provision_id uuid not null references public.zapmail_provisions(id) on delete cascade,
  email text not null,
  domain_name text not null,
  mailbox_id text,
  state text not null default 'pending'
    check (state in ('pending', 'active', 'imaged', 'exported', 'configured', 'review', 'approved', 'failed')),
  smartlead_account_id bigint,
  error text,
  updated_at timestamptz not null default now(),
  primary key (provision_id, email)
);

create index if not exists zapmail_provisions_open_idx
  on public.zapmail_provisions (status) where status in ('watching', 'exporting', 'configuring');

alter table public.zapmail_provisions enable row level security;
alter table public.zapmail_provision_items enable row level security;

notify pgrst, 'reload schema';
