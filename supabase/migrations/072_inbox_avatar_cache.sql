-- 072: durable cache for Zapmail profile pictures.
--
-- The avatar map (email -> cdn.zapmail.ai URL) and the image bytes themselves
-- previously lived only in per-instance module caches, refetched from Zapmail
-- on demand. Zapmail's API/CDN are unreachable from some operator networks
-- (content filters block *.zapmail.ai) and rate-limited in production, so a
-- failed fetch made every inbox falsely render as "no profile picture". This
-- cache is written whenever a server-side Zapmail fetch succeeds (page loads in
-- production, plus the 10-minute cron) and read as the fallback everywhere
-- else — including local dev, which can reach Supabase but not Zapmail.

create table if not exists public.inbox_avatar_snapshot (
  email text primary key,
  url text not null,
  updated_at timestamptz not null default now()
);

-- One row per distinct CDN URL; base64 keeps PostgREST round-trips simple.
create table if not exists public.inbox_avatar_images (
  url text primary key,
  content_type text not null,
  image_base64 text not null,
  fetched_at timestamptz not null default now()
);

alter table public.inbox_avatar_snapshot enable row level security;
alter table public.inbox_avatar_images enable row level security;
