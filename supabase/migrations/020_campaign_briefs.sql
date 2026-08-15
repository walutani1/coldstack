create table if not exists public.campaign_briefs (
  campaign_id text primary key,
  digest_hash text not null,
  brief jsonb,
  model text,
  input_tokens integer,
  output_tokens integer,
  generated_at timestamptz,
  dirty boolean not null default true,
  updated_at timestamptz not null default now()
);

alter table public.campaign_briefs enable row level security;

revoke all on table public.campaign_briefs from anon, authenticated;
grant select, insert, update, delete on table public.campaign_briefs to service_role;

create or replace function public.campaign_briefs_set_updated_at()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

revoke execute on function public.campaign_briefs_set_updated_at() from public, anon, authenticated;
grant execute on function public.campaign_briefs_set_updated_at() to service_role;

drop trigger if exists campaign_briefs_updated_at on public.campaign_briefs;
create trigger campaign_briefs_updated_at
before update on public.campaign_briefs
for each row execute function public.campaign_briefs_set_updated_at();
