create table if not exists integration_secrets (
  name text primary key,
  payload jsonb not null,
  updated_at timestamptz not null default now(),
  updated_by text
);
alter table integration_secrets enable row level security;
