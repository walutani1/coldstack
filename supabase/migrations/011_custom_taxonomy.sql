create table if not exists reply_categories (
  id uuid primary key default gen_random_uuid(),
  value text not null unique,
  label text not null,
  description text,
  sentiment_type text not null default 'neutral' check (sentiment_type in ('positive','negative','neutral')),
  suppress boolean not null default false,
  dnc boolean not null default false,
  draft_reply boolean not null default false,
  draft_guidance text,
  color text,
  sort_order integer not null default 0,
  active boolean not null default true,
  system_role text unique check (system_role in ('fallback','out_of_office','do_not_contact','wrong_person')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table reply_categories enable row level security;

create unique index if not exists reply_categories_label_lower_key
  on reply_categories (lower(label));

insert into reply_categories (
  value, label, description, sentiment_type, suppress, dnc, draft_reply,
  draft_guidance, sort_order, system_role
)
values
  (
    'interested', 'Interested',
    'The lead expresses interest in the offering or asks to hear more.',
    'positive', false, false, true,
    'They showed interest. Thank them, one line referencing your proof point, then propose one concrete low-effort next step (send a short overview, or a quick call). One question only.',
    0, null
  ),
  (
    'meeting_request', 'Meeting Request',
    'The lead asks to schedule a meeting or call.',
    'positive', false, false, true,
    'They want to talk. Confirm warmly and make scheduling effortless: offer to send times or ask what works this week. No pitching, the meeting is the win.',
    1, null
  ),
  (
    'information_request', 'Information Request',
    'The lead asks a question or requests more information.',
    'positive', false, false, true,
    'They asked for information. Answer their question directly in the first lines, cite your proof point, and end with ONE easy question that qualifies or routes (prefer naming a likely owner from the colleague list).',
    2, null
  ),
  (
    'wrong_person', 'Wrong Person',
    'The recipient says they are not the right person or refers the sender elsewhere.',
    'neutral', false, false, true,
    'They pointed to someone else. Thank them by name, confirm you''ll reach out to the person they named, and optionally ask one small question (e.g. whether a quick intro is easier). Keep it very short.',
    3, 'wrong_person'
  ),
  (
    'out_of_office', 'Out Of Office',
    'The message is an automated temporary-absence or out-of-office reply.',
    'neutral', false, false, false, null, 4, 'out_of_office'
  ),
  (
    'not_interested', 'Not Interested',
    'The lead declines the offering without asking to stop all contact.',
    'negative', true, false, false, null, 5, null
  ),
  (
    'do_not_contact', 'Do Not Contact',
    'The lead explicitly asks to be removed or never contacted again, or is hostile or abusive.',
    'negative', true, true, false, null, 6, 'do_not_contact'
  ),
  (
    'uncategorizable', 'Uncategorizable',
    'The reply does not clearly fit another active category.',
    'neutral', false, false, false, null, 7, 'fallback'
  )
on conflict (value) do nothing;
